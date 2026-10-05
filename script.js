// =====================================================
// SMART LAUNDRY - university laundry management.
// The order-processing engine is a QUEUE (FIFO). See "THE QUEUE" below and the DSA Concepts page.
// Sections: config - auth - storage - THE QUEUE - order operations - data helpers - views - events
// =====================================================

// ---------- CONFIG (demo credentials live ONLY here; demo access control, not real security) ----------
const CONFIG = { DELAY_MIN: 120, CREDENTIALS: { student: "student123", professor: "professor123", staff: { id: "STAFF-LAUNDRY-01", password: "staff123" } } };
const DEPTS = { SC: ["CSE", "AIE", "CYS"], EN: ["ECE", "MEE", "RAI", "CCE", "AID"] };
const ALL_DEPTS = [...DEPTS.SC, ...DEPTS.EN];
const SERVICES = ["Wash & Fold", "Wash + Iron", "Iron Only", "Express"];
const SERVICE_MIN = { "Wash & Fold": 45, "Wash + Iron": 70, "Iron Only": 30, Express: 25 };
const ITEM_TYPES = ["Shirts", "Pants", "T-Shirts", "Bedsheets", "Other"];
const SLOTS = ["8-10 AM", "10 AM-12 PM", "12-2 PM", "2-4 PM", "4-6 PM", "6-8 PM"];
const SLOT_CAPACITY = 15;
const STATUSES = ["WAITING", "WASHING", "QUALITY", "READY"];
const NEXT = { WAITING: "WASHING", WASHING: "QUALITY", QUALITY: "READY" }; // READY -> COLLECTED only via collectFront()
const LABEL = { WAITING: "Waiting", WASHING: "Washing", QUALITY: "Quality Check", READY: "Ready for Pickup", COLLECTED: "Collected" };
const DIRECTORY = { "CH.SC.U4CSE25025": "Krish B", "CH.SC.U4CSE25026": "Anika R", "CH.SC.U4AIE25027": "Dev M", "CH.SC.U4CYS25028": "Sana K", "CH.EN.U4ECE25029": "Rohan P", "CH.EN.U4MEE25030": "Meera S", "CH.EN.U4RAI25031": "Arjun V", "CH.EN.U4CCE25032": "Nisha T", "CH.EN.U4AID25033": "Vikram L" };

// =====================================================
// FIREBASE FIRESTORE (optional database layer)
// The Queue below is still a plain JavaScript array. Firestore only STORES orders so that
// students and staff on different devices see the same data. Without Firebase the app uses localStorage.
//
// SETUP (do this once):
//  1. Open https://console.firebase.google.com and click "Add project".
//  2. In the project: Build > Firestore Database > Create database (start in test mode for a demo).
//  3. Project settings (gear icon) > General > "Your apps" > Web (</>) > register the app.
//  4. Firebase shows a firebaseConfig object. Copy it.
//  5. Paste the values below, replacing every PASTE_... placeholder.
//  6. Firestore Database > Rules tab > paste the DEMO rules below > Publish:
//       rules_version = '2';
//       service cloud.firestore { match /databases/{database}/documents {
//         match /{document=**} { allow read, write: if true; } } }
//     These rules let anyone read/write. Fine for a college demo, NOT for production.
// ALSO REQUIRED for student sign up / login (Firebase Authentication):
//  7. Firebase console > Build > Authentication > Get started > Sign-in method > Email/Password > Enable > Save.
//  8. Run the app from a local web server (for example VS Code "Live Server", or `python -m http.server`
//     then open http://localhost:8000). Firebase Authentication does not work from a file:// page.
// Collections used: students, laundryOrders, issues, notifications, meta (token counter).
// =====================================================
const firebaseConfig = {            // <-- PASTE YOUR FIREBASE CONFIG HERE
 apiKey: "AIzaSyAKQrUmiVBKkBzEcNwCroYKEzxhpiri4Tk",
  authDomain: "smart-laundry-971ef.firebaseapp.com",
  projectId: "smart-laundry-971ef",
  storageBucket: "smart-laundry-971ef.firebasestorage.app",
  messagingSenderId: "682098119394",
  appId: "1:682098119394:web:a0e9ed80b2926908c284bb",
  measurementId: "G-6WE02DRLKF"
};
const DB = { ready: false, db: null, auth: null, loaded: {}, last: {}, warned: false };

// ---------- STATE ----------
let queue = [];        // ACTIVE orders, in arrival order. THE QUEUE.
let completed = [], tokenNumber = 1, audit = [], sizeLog = [], notifs = [], issues = [], machines = [], inventory = [];
let settings = { notifications: true }, session = null, students = [];

// =====================================================
// THE QUEUE - single source of truth for the order of ACTIVE orders
// queue[0] = FRONT (oldest, next to be served)   queue[queue.length - 1] = REAR (newest)
// =====================================================
const getFront = () => (queue.length ? queue[0] : null);                // FRONT
const getRear = () => (queue.length ? queue[queue.length - 1] : null);  // REAR
const getQueueSize = () => queue.length;                                // SIZE
const isQueueEmpty = () => queue.length === 0;                          // IS EMPTY
const findByToken = t => queue.findIndex(s => s.token === t);           // SEARCH O(n)
const findByStudentId = id => queue.findIndex(s => s.studentId === id);
function enqueueOrder(d) {                // ENQUEUE: a new order goes to the REAR
  const s = normOrder({ ...d, token: d.token || generateToken(), status: "WAITING", submittedAt: d.submittedAt || new Date().toISOString(), history: [] });
  s.history.push({ t: s.submittedAt, status: "WAITING", by: actor().user, text: "Request submitted and accepted" });
  queue.push(s);                          // <-- ENQUEUE
  sizeLog.push(queue.length);
  logAudit("Created laundry request", s, `${s.token} added to the order queue`, "ENQUEUE");
  return s;
}
function dequeueFront() {                 // DEQUEUE: only ever removes the FRONT order
  if (isQueueEmpty()) return null;
  const s = queue.shift();                // <-- DEQUEUE (removes queue[0])
  s.status = "COLLECTED"; s.collectedAt = new Date().toISOString();
  s.history.push({ t: s.collectedAt, status: "COLLECTED", by: actor().user, text: "Collected" });
  completed.push(s); sizeLog.push(queue.length);
  logAudit("Collected order", s, `${s.token} left the order queue`, "DEQUEUE");
  return s;
}
function generateToken() { return "L" + String(tokenNumber++).padStart(3, "0"); }
function calculateQueuePosition(i) { return { position: i + 1, ahead: i }; } // position = index + 1, ahead = index

// ---------- AUTH ----------
const deptOf = id => (String(id).split(".")[2] || "").slice(2, 5);
const validateStudentId = id => { const m = /^CH\.(SC|EN)\.U4([A-Z]{3})(\d{2})0(\d{2})$/.exec(id); return !!m && DEPTS[m[1]].includes(m[2]); };
const validateFacultyId = id => { const m = /^CH\.FA\.U4([A-Z]{3})(\d{2})0(\d{2})$/.exec(id); return !!m && ALL_DEPTS.includes(m[1]); };
function login(role, rawId, pw) {
  const id = rawId.trim().toUpperCase(), C = CONFIG.CREDENTIALS;
  if (role === "professor" && !validateFacultyId(id)) return "Enter a valid Amrita faculty ID.";
  if (role === "staff" && id !== C.staff.id) return "Unknown staff ID.";
  if ((role === "staff" ? C.staff.password : C[role]) !== pw) return "Incorrect password.";
  const hist = [...queue, ...completed].find(s => s.studentId === id);
  session = { role, id, dept: role === "staff" ? "" : deptOf(id), name: role === "staff" ? "Laundry Staff" : role === "professor" ? "Faculty " + id.slice(-3) : DIRECTORY[id] || (hist && hist.student) || "Student" };
  try { sessionStorage.setItem("laundrySession", JSON.stringify(session)); } catch {}
  return "";
}
const yearOf = roll => { const m = /U4[A-Z]{3}(\d{2})/.exec(roll); return m ? new Date().getFullYear() - (2000 + +m[1]) + 1 : 1; };
const studentRecord = (name, roll) => ({ name, rollNumber: roll, department: deptOf(roll), year: yearOf(roll) }); // students/{rollNumber}
const seedStudents = () => Object.entries(DIRECTORY).map(([roll, name]) => studentRecord(name, roll));
async function getStudent(roll) { // Firestore when connected, otherwise the local registry
  if (DB.ready) { try { const d = await DB.db.collection("students").doc(roll).get(); return d.exists ? d.data() : null; } catch (e) { cloudError(e); } }
  return students.find(x => x.rollNumber === roll) || null;
}
const MIN_PASSWORD = 8;
const rollToEmail = roll => roll.toLowerCase() + "@smartlaundry.app"; // generated for Firebase Auth; the student never sees it
function authError(e) {
  const c = (e && e.code) || "";
  if (c === "auth/email-already-in-use") return "This roll number is already registered. Please log in.";
  if (["auth/user-not-found", "auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(c)) return "Incorrect roll number or password.";
  if (c === "auth/weak-password") return "Password is too weak. Use at least " + MIN_PASSWORD + " characters.";
  if (c === "auth/operation-not-allowed" || c === "auth/configuration-not-found") return "Email/Password sign-in is not enabled. In Firebase Console open Authentication > Sign-in method > Email/Password and enable it.";
  if (c === "auth/operation-not-supported-in-this-environment") return "Run the app from a local web server (http://localhost), not by opening the file directly.";
  if (c === "auth/network-request-failed") return "Network error. Check your connection.";
  if (c === "auth/too-many-requests") return "Too many attempts. Please try again later.";
  return "Authentication error" + (c ? " (" + c + ")" : "") + ".";
}
const needAuth = () => (DB.auth ? "" : "Student accounts use Firebase Authentication. Paste your Firebase config into script.js and enable Email/Password sign-in (see the setup comments).");
function startStudentSession(rec) {
  session = { role: "student", id: rec.rollNumber, name: rec.name, dept: rec.department, year: rec.year, uid: rec.uid }; // no password is ever kept
  try { sessionStorage.setItem("laundrySession", JSON.stringify(session)); } catch {}
}
async function signUpStudent(rawName, rawRoll, pw, confirm) {
  const name = rawName.trim(), roll = rawRoll.trim().toUpperCase();
  if (!name) return "Full name is required.";
  if (!roll) return "Roll number is required.";
  if (!validateStudentId(roll)) return "Enter a valid Amrita roll number.";
  if (pw.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (pw !== confirm) return "Passwords do not match.";
  const na = needAuth(); if (na) return na;
  const existing = await getStudent(roll);
  if (existing && existing.uid) return "This roll number is already registered. Please log in."; // roll number must be unique
  let cred;
  try { cred = await DB.auth.createUserWithEmailAndPassword(rollToEmail(roll), pw); } catch (e) { return authError(e); } // Auth also rejects duplicates
  const rec = { ...studentRecord(name, roll), uid: cred.user.uid };
  try { await DB.db.collection("students").doc(roll).set(rec, { merge: true }); } catch (e) { cloudError(e); return "Account created, but your profile could not be saved. Check Firestore rules."; }
  startStudentSession(rec); return "";
}
async function loginStudent(rawRoll, pw) {
  const roll = rawRoll.trim().toUpperCase();
  if (!roll) return "Roll number is required.";
  if (!validateStudentId(roll)) return "Enter a valid Amrita roll number.";
  if (!pw) return "Password is required.";
  const na = needAuth(); if (na) return na;
  let cred;
  try { cred = await DB.auth.signInWithEmailAndPassword(rollToEmail(roll), pw); } catch (e) { return authError(e); }
  const rec = await getStudent(roll);                                   // load the Firestore profile
  if (!rec) { DB.auth.signOut(); return "Student profile not found. Please contact the laundry staff."; }
  if (rec.uid && rec.uid !== cred.user.uid) { DB.auth.signOut(); return "This account does not match the student profile."; }
  if (!rec.uid) { rec.uid = cred.user.uid; DB.db.collection("students").doc(roll).set({ uid: rec.uid }, { merge: true }).catch(cloudError); }
  startStudentSession(rec); return "";
}
async function registerStudent(name, roll) {
  if (!name) return "Full name is required.";
  if (!validateStudentId(roll)) return "Enter a valid Amrita roll number.";
  if (await getStudent(roll)) return "This roll number is already registered.";
  const r = studentRecord(name, roll);
  students.push(r); saveLocal();
  if (DB.ready) DB.db.collection("students").doc(roll).set(r).catch(cloudError);
  return r;
}
const isStaff = () => !!session && session.role === "staff";
const actor = () => (session ? { user: session.name, role: session.role } : { user: "System", role: "system" });
function assertStaff() { if (isStaff()) return true; showToast("Only laundry staff can do this.", "error"); return false; }

// ---------- STORAGE (tolerates missing / corrupted data) ----------
function readKey(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
const arr = (k, d = []) => { const v = readKey(k, d); return Array.isArray(v) ? v : d; };
function normOrder(s) {
  const o = { items: {}, history: [], issueIds: [], notes: "", collect: "Laundry Desk", slot: SLOTS[0], machineId: null, washingAt: null, readyAt: null, collectedAt: null, ...s };
  o.studentId = String(s.studentId || s.rollNo || "").toUpperCase();
  o.student = s.student || s.name || o.studentId; o.dept = s.dept || deptOf(o.studentId);
  o.service = s.service || "Wash & Fold"; o.itemCount = s.itemCount || s.clothes || s.clothesCount || 0;
  o.submittedAt = s.submittedAt || s.createdAt || null;
  if (!Array.isArray(o.history)) o.history = []; if (typeof o.items !== "object" || !o.items) o.items = {};
  return o;
}
const cleanOrders = l => (Array.isArray(l) ? l : []).filter(s => s && typeof s === "object" && s.token && (s.studentId || s.rollNo)).map(normOrder);
const defaultMachines = () => [1, 2, 3, 4].map(i => ({ id: i, name: "Machine 0" + i, status: "AVAILABLE", token: null, endsAt: null }));
const defaultInventory = () => [["Detergent", 40, "kg", 15, 5], ["Fabric Softener", 25, "L", 10, 3], ["Laundry Bags", 120, "pcs", 40, 15], ["Tags", 300, "pcs", 100, 30], ["Gloves", 60, "pairs", 20, 8], ["Packaging", 90, "pcs", 30, 10]].map(([name, stock, unit, low, crit]) => ({ name, stock, unit, low, crit, updated: new Date().toISOString() }));
function loadData() {
  queue = cleanOrders(readKey("laundryQueue", [])).filter(s => STATUSES.includes(s.status));
  completed = cleanOrders(readKey("laundryCompleted", []));
  audit = arr("laundryAudit").map(a => ({ user: a.name || "-", role: "-", action: a.op || "", details: a.desc || "", ...a }));
  sizeLog = arr("laundrySizeLog"); notifs = arr("laundryNotifications"); issues = arr("laundryIssues");
  machines = arr("laundryMachines"); if (!machines.length) machines = defaultMachines();
  inventory = arr("laundryInventory"); if (!inventory.length) inventory = defaultInventory();
  students = arr("laundryStudents"); seedStudents().forEach(r => { if (!students.some(x => x.rollNumber === r.rollNumber)) students.push(r); });
  const st = readKey("laundrySettings", {}); settings = { notifications: true, ...(st && typeof st === "object" ? st : {}) };
  const n = Number(readKey("laundryTokenNumber", 1));
  const used = [...queue, ...completed].map(s => parseInt(String(s.token).slice(1), 10) || 0);
  tokenNumber = Math.max(n > 0 ? Math.floor(n) : 1, Math.max(0, ...used) + 1);
}
function saveLocal() {
  try {
    const w = (k, v) => localStorage.setItem(k, JSON.stringify(v));
    w("laundryQueue", queue); w("laundryCompleted", completed); w("laundryTokenNumber", tokenNumber); w("laundryAudit", audit.slice(0, 400));
    w("laundrySizeLog", sizeLog.slice(-200)); w("laundryNotifications", notifs.slice(0, 200)); w("laundryIssues", issues);
    w("laundryMachines", machines); w("laundryInventory", inventory); w("laundrySettings", settings); w("laundryStudents", students);
  } catch { showToast("Could not save data.", "error"); }
}
function refreshPositions() { queue.forEach((s, i) => (s.queuePosition = i + 1)); completed.forEach(s => (s.queuePosition = null)); }
function saveData() { refreshPositions(); saveLocal(); syncCloud(); } // localStorage always; Firestore too when connected

// ---------- FIRESTORE SYNC (write-through + live listeners) ----------
const seq = s => parseInt(String(s.token).slice(1), 10) || 0;
const toDoc = s => JSON.parse(JSON.stringify({ orderId: s.token, token: s.token, studentName: s.student, studentRoll: s.studentId, department: s.dept, service: s.service, items: s.items, pickupSlot: s.slot, status: s.status, createdAt: s.submittedAt, queuePosition: s.queuePosition ?? null, seq: seq(s), itemCount: s.itemCount, notes: s.notes, collect: s.collect, machineId: s.machineId, washingAt: s.washingAt, readyAt: s.readyAt, collectedAt: s.collectedAt, history: s.history, demo: !!s.demo }));
const fromDoc = d => normOrder({ token: d.token, student: d.studentName, studentId: d.studentRoll, dept: d.department, service: d.service, items: d.items || {}, slot: d.pickupSlot, status: d.status, submittedAt: d.createdAt, queuePosition: d.queuePosition, itemCount: d.itemCount, notes: d.notes || "", collect: d.collect, machineId: d.machineId ?? null, washingAt: d.washingAt ?? null, readyAt: d.readyAt ?? null, collectedAt: d.collectedAt ?? null, history: d.history || [], demo: d.demo });
function syncCol(col, list, key, toD, write) { // writes only documents that changed; deletes documents that no longer exist locally
  const cur = new Map(list.map(x => [key(x), JSON.stringify(toD(x))])), last = DB.last[col] || new Map();
  if (write) {
    cur.forEach((v, k) => { if (last.get(k) !== v) DB.db.collection(col).doc(k).set(JSON.parse(v)).catch(cloudError); });
    last.forEach((v, k) => { if (!cur.has(k)) DB.db.collection(col).doc(k).delete().catch(cloudError); });
  }
  DB.last[col] = cur;
}
function syncCloud() {
  if (!DB.ready) return;
  if (DB.loaded.laundryOrders) syncCol("laundryOrders", [...queue, ...completed], x => x.token, toDoc, true);
  if (DB.loaded.issues) syncCol("issues", issues, x => x.id, x => x, true);
  if (DB.loaded.notifications) syncCol("notifications", notifs, x => x.id, x => x, true);
}
async function reserveToken() { // unique token across devices (Firestore transaction on meta/counter)
  const ref = DB.db.collection("meta").doc("counter");
  const n = await DB.db.runTransaction(async t => { const d = await t.get(ref); const n = Math.max(d.exists ? d.data().next : 1, tokenNumber); t.set(ref, { next: n + 1 }); return n; });
  tokenNumber = Math.max(tokenNumber, n + 1);
  return "L" + String(n).padStart(3, "0");
}
function cloudError(e) { console.error(e); if (!DB.warned) { DB.warned = true; showToast("Cloud database problem (" + ((e && e.code) || "error") + "). Check your Firebase config and Firestore rules. Using local data.", "error"); } }
function initCloud() {
  const c = firebaseConfig;
  if (typeof firebase === "undefined" || !c.projectId || /PASTE/.test(c.apiKey + c.projectId)) return; // not configured: localStorage only
  try { firebase.initializeApp(c); DB.db = firebase.firestore(); DB.ready = true; if (typeof firebase.auth === "function") DB.auth = firebase.auth(); } catch (e) { return cloudError(e); }
  const listen = (col, apply) => DB.db.collection(col).onSnapshot(snap => { apply(snap.docs.map(d => d.data())); DB.loaded[col] = true; saveLocal(); refreshView(); }, cloudError);
  listen("laundryOrders", docs => {
    const all = docs.map(fromDoc).filter(o => o.token).sort((a, b) => seq(a) - seq(b));
    queue = all.filter(o => STATUSES.includes(o.status));   // active orders, oldest first = FIFO order
    completed = all.filter(o => o.status === "COLLECTED").sort((a, b) => new Date(a.collectedAt) - new Date(b.collectedAt));
    tokenNumber = Math.max(tokenNumber, ...all.map(o => seq(o) + 1));
    syncCol("laundryOrders", [...queue, ...completed], x => x.token, toDoc, false);
  });
  listen("issues", docs => { issues = docs.sort((a, b) => new Date(b.time) - new Date(a.time)); syncCol("issues", issues, x => x.id, x => x, false); });
  listen("notifications", docs => { notifs = docs.sort((a, b) => new Date(b.time) - new Date(a.time)); syncCol("notifications", notifs, x => x.id, x => x, false); });
  DB.db.collection("students").limit(1).get().then(r => { if (r.empty) seedStudents().forEach(x => DB.db.collection("students").doc(x.rollNumber).set(x)); }).catch(cloudError);
}
function logAudit(action, s, details, op, extra = {}) { // call AFTER the queue changed
  const f = getFront(), r = getRear(), a = actor();
  audit.unshift({ id: Date.now() + "-" + audit.length, time: new Date().toISOString(), user: a.user, role: a.role, action, token: s ? s.token : "-", details, op: op || null, size: queue.length, front: f ? f.token : null, rear: r ? r.token : null, ...extra });
}
function notify(to, token, type, text, extra = {}) { notifs.unshift({ id: Date.now() + "-" + notifs.length + Math.random().toString(36).slice(2, 5), to, token, type, text, time: new Date().toISOString(), read: false, ...extra }); }

// ---------- ORDER OPERATIONS (FIFO is enforced here, in JavaScript) ----------
async function submitOrder(d) {
  const ok = isStaff() || (session && session.role === "student" && d.studentId === session.id);
  if (!ok) return "You are not allowed to create this request.";
  if (!validateStudentId(d.studentId)) return "Enter a valid Amrita roll number.";
  const rec = await getStudent(d.studentId);                     // 1. validate the student
  if (!rec) return "This roll number is not registered. Register the student in Settings first.";
  d.student = rec.name; d.dept = rec.department || deptOf(d.studentId);
  const count = Object.values(d.items).reduce((a, b) => a + b, 0);
  if (count < 1) return "Add at least one item.";
  if (DB.ready && !DB.loaded.laundryOrders) return "Connecting to the database. Please try again in a moment.";
  if (findByStudentId(d.studentId) !== -1) return "This student already has an active laundry request.";
  let token;
  if (DB.ready) { try { token = await reserveToken(); } catch (e) { cloudError(e); return "Could not reserve a token. Check your connection."; } }
  if (findByStudentId(d.studentId) !== -1) return "This student already has an active laundry request.";
  const s = enqueueOrder({ ...d, token, itemCount: count });     // 2-3. create the order and ENQUEUE it
  notify(s.studentId, s.token, "accepted", `Laundry request ${s.token} accepted.`);
  notify("STAFF", s.token, "new", `New request ${s.token} from ${s.student}.`);
  saveData(); return s;                                          // 4-5. positions recalculated, saved locally and to Firestore
}
function setStatus(s, to, text, action) {
  const from = s.status; s.status = to;
  const now = new Date().toISOString();
  if (to === "WASHING") s.washingAt = now; if (to === "READY") s.readyAt = now;
  s.history.push({ t: now, status: to, by: actor().user, text });
  logAudit(action, s, `${LABEL[from]} \u2192 ${LABEL[to]}`);
}
function advanceFront() { // WAITING -> WASHING -> QUALITY -> READY, for the FRONT order only
  if (!assertStaff()) return false;
  const s = getFront();
  if (!s) { showToast("There are no active orders.", "info"); return false; }
  if (s.status === "READY") { showToast("This order is ready. Collect it to continue.", "info"); return false; }
  if (s.status === "WAITING") {
    const m = machines.find(x => x.status === "AVAILABLE");
    if (!m) { showToast("No washing machine is available right now.", "warning"); return false; }
    m.status = "WASHING"; m.token = s.token; m.endsAt = Date.now() + SERVICE_MIN[s.service] * 60000; s.machineId = m.id;
    setStatus(s, "WASHING", `Washing started on ${m.name}`, "Started washing"); notify(s.studentId, s.token, "processing", `Laundry ${s.token}: processing has started.`);
  } else if (s.status === "WASHING") {
    const m = machines.find(x => x.id === s.machineId); if (m) { m.status = "AVAILABLE"; m.token = null; m.endsAt = null; }
    setStatus(s, "QUALITY", "Moved to quality check", "Sent to quality check");
  } else {
    setStatus(s, "READY", "Ready for pickup", "Marked ready"); notify(s.studentId, s.token, "ready", `Laundry ${s.token} is ready for pickup.`);
  }
  saveData(); return true;
}
function stepOrder(token) { // used by order details; any order other than the front is refused
  const f = getFront();
  if (!f || f.token !== token) { showToast("Earlier orders must be completed first.", "warning"); return false; }
  return advanceFront();
}
function collectFront(token) {
  if (!assertStaff()) return false;
  const f = getFront();
  if (!f || f.token !== token) { showToast(`Cannot collect ${token}.\nEarlier orders must be completed first.`, "error"); return false; }
  if (f.status !== "READY") { showToast(`${token} is not ready yet.`, "warning"); return false; }
  const s = dequeueFront(); notify(s.studentId, s.token, "collected", `Laundry ${s.token} was collected. Thank you.`);
  saveData(); return true;
}

// ---------- DATA HELPERS ----------
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const dt = i => (i ? new Date(i).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "-");
const tm = i => (i ? new Date(i).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "-");
const allOrders = () => [...queue, ...completed];
const mine = () => allOrders().filter(s => s.studentId === session.id);
const sameDay = (i, d = new Date()) => i && new Date(i).toDateString() === d.toDateString();
const isDelayed = s => Date.now() - new Date(s.submittedAt || Date.now()) > CONFIG.DELAY_MIN * 60000;
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const procMin = () => { const v = completed.filter(s => s.washingAt && s.readyAt).map(s => (new Date(s.readyAt) - new Date(s.washingAt)) / 60000); return avg(v); };
const mins = v => (v == null ? "-" : Math.round(v) + " min");
function estimate(s) { // ESTIMATE only: sum of service times for orders ahead + this one
  const i = queue.indexOf(s); if (i < 0) return null;
  let t = 0; for (let j = 0; j <= i; j++) { const el = queue[j].washingAt ? (Date.now() - new Date(queue[j].washingAt)) / 60000 : 0; t += Math.max(5, SERVICE_MIN[queue[j].service] - el); }
  return new Date(Date.now() + t * 60000);
}
function estimateWait(s) { // ESTIMATE only: minutes for the orders AHEAD of this one
  const i = queue.indexOf(s); let t = 0;
  for (let j = 0; j < i; j++) { const el = queue[j].washingAt ? (Date.now() - new Date(queue[j].washingAt)) / 60000 : 0; t += Math.max(5, SERVICE_MIN[queue[j].service] - el); }
  return t;
}
function tally(list, fn) { const m = {}; list.forEach(x => { const k = fn(x); m[k] = (m[k] || 0) + 1; }); return m; }
const top1 = m => Object.entries(m).sort((a, b) => b[1] - a[1])[0];
const myNotifs = () => notifs.filter(n => n.to === (isStaff() ? "STAFF" : session.id));
const unread = () => (session && session.role !== "professor" ? myNotifs().filter(n => !n.read).length : 0);
const ICONS = { dash: "M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z", new: "M12 5v14M5 12h14", orders: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01", notif: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", issues: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z", settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2", analytics: "M4 20V10M10 20V4M16 20v-8M22 20H2", reports: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h8", dsa: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z", machines: "M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM12 18a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", inventory: "M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8", schedule: "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4", audit: "M9 12l2 2 4-4M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z", active: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" };
const icon = n => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICONS[n] || ICONS.dash}"/></svg>`;
const badge = (s, label) => `<span class="badge b-${esc(String(s).split(" ")[0])}">${esc(label || LABEL[s] || s)}</span>`;
const empty = (t, d) => `<div class="empty"><b>${t}</b>${d || ""}</div>`;
const table = (heads, rows, none) => `<div class="scroll"><table><thead><tr>${heads.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${heads.length}" class="muted">${none}</td></tr>`}</tbody></table></div>`;
const kpis = l => `<div class="kpis">${l.map(([n, v]) => `<div class="kpi"><b>${v}</b><span>${n}</span></div>`).join("")}</div>`;
const hbar = (title, obj) => { const e = Object.entries(obj), mx = Math.max(1, ...e.map(x => x[1])); return `<div class="card"><h3>${title}</h3>${e.length ? `<div class="bars">${e.map(([k, v]) => `<div class="bar"><span>${esc(k)}</span><i style="width:${v / mx * 100}%"></i><b>${v}</b></div>`).join("")}</div>` : empty("No data yet")}</div>`; };
const openBtn = t => `<button class="btn sm" data-act="open" data-token="${esc(t)}">View</button>`;
let toastTimer;
function showToast(msg, type = "info") { const t = $("toast"); t.textContent = msg; t.className = "toast show " + type; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200); }
function showModal(title, html, okLabel, onOk, danger) {
  $("m-title").textContent = title; $("m-body").innerHTML = html;
  const ok = $("m-ok"); ok.className = "btn " + (danger ? "danger" : "primary") + (okLabel ? "" : " hidden"); ok.textContent = okLabel || "";
  ok.onclick = () => { $("modal").close(); onOk && onOk(); };
  $("m-cancel").textContent = okLabel ? "Cancel" : "Close"; $("m-cancel").onclick = () => $("modal").close(); $("modal").showModal();
}
const closeModal = () => $("modal").open && $("modal").close();

// ---------- VIEW STATE ----------
let cur = "dash", flt = { status: "ALL", q: "", tab: "active", from: "", hist: "ALL", issue: "ALL", dept: "ALL", rep: { from: "", to: "", dept: "ALL", service: "ALL", status: "ALL" }, aud: { user: "ALL", role: "ALL", action: "ALL", date: "" } };
let draft = { service: SERVICES[0], items: {}, notes: "", collect: "Laundry Desk", slot: SLOTS[1] };
const NAV = {
  student: [["MAIN", ["dash", "new", "orders", "notif", "issues"]], ["SYSTEM", ["dsa", "settings"]]],
  staff: [["MAIN", ["dash", "new", "notif", "issues"]], ["OPERATIONS", ["active", "machines", "inventory", "schedule"]], ["INSIGHTS", ["analytics", "reports"]], ["SYSTEM", ["audit", "dsa", "settings"]]],
  professor: [["MAIN", ["dash"]], ["INSIGHTS", ["analytics", "reports"]], ["SYSTEM", ["dsa", "settings"]]]
};
const TITLES = { dash: "Dashboard", new: "New Request", orders: "My Laundry", notif: "Notifications", issues: "Issues", active: "Orders", machines: "Machines", inventory: "Inventory", schedule: "Schedule", analytics: "Analytics", reports: "Reports", audit: "Audit Log", dsa: "DSA Concepts", settings: "Settings" };

// ---------- VIEWS ----------
function orderCard(s, title) { // student's current order, with the queue position as the main feature
  const e = estimate(s), i = queue.indexOf(s), wait = Math.round(estimateWait(s));
  const pos = i < 0 ? "" : `<div class="poscard"><span class="muted small">YOUR QUEUE POSITION</span><div class="pos">#${i + 1}</div><p>${s.status === "READY" ? "Your laundry is ready for pickup." : i === 0 ? "You are next in line." : `${i} student${i > 1 ? "s" : ""} ahead of you`}</p><p>Estimated waiting time: <b>~${wait} minutes</b> <span class="muted small">(estimate)</span></p></div>`;
  return `<div class="card nowcard"><h3>${title}</h3>${pos}<div class="dl"><div><span>TOKEN</span>${esc(s.token)}</div><div><span>STATUS</span>${badge(s.status)}</div><div><span>SERVICE</span>${esc(s.service)}</div><div><span>ITEMS</span>${s.itemCount}</div><div><span>PICKUP SLOT</span>${esc(s.slot)}</div><div><span>EST. COMPLETION</span>${e ? tm(e) : "-"}</div></div>${timeline(s)}<button class="btn" data-act="open" data-token="${esc(s.token)}">View Order</button></div>`;
}
function timeline(s) {
  const steps = ["Request Submitted", "Accepted", "Washing", "Quality Check", "Ready for Pickup", "Collected"];
  const idx = { WAITING: 1, WASHING: 2, QUALITY: 3, READY: 4, COLLECTED: 5 }[s.status];
  return `<ol class="tl">${steps.map((l, i) => `<li class="${s.status === "COLLECTED" || i < idx ? "done" : i === idx ? "now" : ""}">${i < idx || s.status === "COLLECTED" ? "&#10003; " : i === idx ? "&#9679; " : "&#9675; "}${l}</li>`).join("")}</ol>`;
}
function ordersRows(list, withStudent) {
  return list.map(s => `<tr><td><b>${esc(s.token)}</b></td>${withStudent ? `<td>${esc(s.student)}</td><td>${esc(s.dept)}</td>` : ""}<td>${dt(s.submittedAt)}</td><td>${s.itemCount}</td><td>${esc(s.service)}</td><td>${badge(s.status)}${isDelayed(s) && s.status !== "COLLECTED" ? ' <span class="badge b-danger">Delayed</span>' : ""}</td><td>${openBtn(s.token)}</td></tr>`);
}
function vDash() {
  if (session.role === "student") {
    const hr = new Date().getHours(), g = hr < 12 ? "morning" : hr < 17 ? "afternoon" : "evening", all = mine(), cur_ = queue.find(s => s.studentId === session.id);
    const recent = [...all].sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)).slice(0, 5);
    const nn = myNotifs().slice(0, 4), myIssues = issues.filter(i => i.studentId === session.id).length;
    return `<div class="sec"><div><h2>Welcome, ${esc(session.name)}</h2><span class="muted small">Good ${g} | Roll No: ${esc(session.id)}</span></div></div>
    <div class="qa"><button class="btn primary" data-act="go" data-v="new">+ New Laundry Request</button><button class="btn" data-act="go" data-v="orders">Track Laundry</button><button class="btn" data-act="go" data-v="orders">View History</button><button class="btn" data-act="go" data-v="issues">Report an Issue</button></div>
    ${kpis([["Total orders", all.length], ["Completed", completed.filter(s => s.studentId === session.id).length], ["In progress", queue.filter(s => s.studentId === session.id).length], ["Issues raised", myIssues]])}
    ${cur_ ? orderCard(cur_, "Current order") : `<div class="card"><h3>Current order</h3>${empty("No active laundry order", "Submit a new request to get started.")}</div>`}
    <div class="grid2"><div class="card"><h3>Recent orders</h3>${table(["Token", "Date", "Items", "Service", "Status", ""], recent.map(s => `<tr><td><b>${esc(s.token)}</b></td><td>${dt(s.submittedAt)}</td><td>${s.itemCount}</td><td>${esc(s.service)}</td><td>${badge(s.status)}</td><td>${openBtn(s.token)}</td></tr>`), "No orders yet.")}</div>
    <div class="card"><h3>Notifications</h3>${nn.length ? nn.map(notifRow).join("") : empty("No notifications")}</div></div>`;
  }
  if (isStaff()) {
    const f = getFront(), proc = f && f.status !== "WAITING" ? f : null, next = proc ? queue[1] : f;
    const adv = f && f.status !== "READY" ? { WAITING: "Start Washing", WASHING: "Send to Quality Check", QUALITY: "Mark Ready" }[f.status] : "Mark Ready";
    return `<div class="sec"><h2>Laundry Operations</h2></div>
    ${kpis([["Today's requests", allOrders().filter(s => sameDay(s.submittedAt)).length], ["Currently processing", queue.filter(s => s.status === "WASHING" || s.status === "QUALITY").length], ["Ready for pickup", queue.filter(s => s.status === "READY").length], ["Collected today", completed.filter(s => sameDay(s.collectedAt)).length], ["Delayed orders", queue.filter(isDelayed).length], ["Open issues", issues.filter(i => i.status !== "Resolved").length]])}
    <div class="qa"><button class="btn primary" data-act="go" data-v="new">+ Add Laundry</button><button class="btn" data-act="advance" ${f && f.status === "WAITING" ? "" : "disabled"}>Process Next</button><button class="btn" data-act="advance" ${f && (f.status === "WASHING" || f.status === "QUALITY") ? "" : "disabled"}>${f && f.status === "WASHING" ? "Send to Quality Check" : "Mark Ready"}</button><button class="btn go" data-act="collect" data-token="${f ? esc(f.token) : ""}" ${f && f.status === "READY" ? "" : "disabled"}>Collect Ready Order</button><button class="btn" data-act="go" data-v="active">View Active Orders</button></div>
    <div class="grid2"><div class="card nowcard"><h3>Now processing</h3>${proc ? `<div class="big">${esc(proc.token)}</div><div class="meta"><span>${esc(proc.student)}</span><span>${proc.itemCount} items</span><span>${esc(proc.service)}</span><span>Started ${tm(proc.washingAt)}</span></div>${badge(proc.status)}<div class="qa" style="margin:12px 0 0">${proc.status === "READY" ? `<button class="btn go" data-act="collect" data-token="${esc(proc.token)}">Collect</button>` : `<button class="btn primary" data-act="advance">${adv}</button>`} ${openBtn(proc.token)}</div>` : empty("Nothing is being processed", "Start the next waiting order.")}</div>
    <div class="card"><h3>Next up</h3>${next && next.status === "WAITING" ? `<div class="big">${esc(next.token)}</div><div class="meta"><span>${esc(next.student)}</span><span>${next.itemCount} items</span><span>${esc(next.service)}</span></div>${openBtn(next.token)}` : empty("No waiting orders")}</div></div>
    <div class="card" style="margin-top:16px"><h3>Active orders</h3>${activeTable(true)}</div>`;
  }
  const set = flt.dept === "ALL" ? allOrders() : allOrders().filter(s => s.dept === flt.dept), wk = set.filter(s => Date.now() - new Date(s.submittedAt) < 7 * 864e5);
  const svc = top1(tally(set, s => s.service)), hr = top1(tally(set.filter(s => s.submittedAt), s => new Date(s.submittedAt).getHours())), pr = set.filter(s => s.washingAt && s.readyAt).map(s => (new Date(s.readyAt) - new Date(s.washingAt)) / 60000);
  const deptCards = ALL_DEPTS.map(d => `<div class="kpi"><b>${queue.filter(s => s.dept === d).length}</b><span>${d} active requests</span></div>`).join("");
  return `<div class="sec"><h2>Department Overview</h2><select data-chg="dept" aria-label="Department filter" style="width:auto"><option value="ALL">All departments</option>${ALL_DEPTS.map(d => `<option ${flt.dept === d ? "selected" : ""}>${d}</option>`).join("")}</select></div>
  <div class="kpis">${deptCards}</div>
  ${kpis([["Requests this week", wk.length], ["Active requests", set.filter(s => s.status !== "COLLECTED").length], ["Completed requests", set.filter(s => s.status === "COLLECTED").length], ["Avg processing time", mins(avg(pr))], ["Most used service", svc ? svc[0] : "-"], ["Peak request period", hr ? `${hr[0]}:00-${+hr[0] + 1}:00` : "-"]])}
  <div class="card"><h3>Recent activity</h3>${table(["Time", "Action", "Order", "Details"], audit.slice(0, 8).map(a => `<tr><td>${tm(a.time)}</td><td>${esc(a.action)}</td><td>${esc(a.token)}</td><td>${esc(a.details)}</td></tr>`), "No activity yet.")}</div>`;
}
function activeTable(preview) {
  const q = flt.q.toLowerCase(), f = getFront();
  // DISPLAY ONLY: filters never touch `queue`; each row keeps its real queue position.
  let rows = queue.map((s, i) => ({ s, i })).filter(({ s }) => (flt.status === "ALL" || (flt.status === "DELAYED" ? isDelayed(s) : s.status === flt.status)) && (!q || [s.token, s.student, s.studentId].some(v => v.toLowerCase().includes(q))));
  if (preview) rows = rows.slice(0, 6);
  return table(["Position", "Token", "Student", "Roll No", "Dept", "Service", "Items", "Submitted", "Status", "Action"], rows.map(({ s, i }) => `<tr class="${f === s ? "hl" : ""}"><td><b>#${i + 1}</b></td><td><b>${esc(s.token)}</b></td><td>${esc(s.student)}</td><td>${esc(s.studentId)}</td><td>${esc(s.dept)}</td><td>${esc(s.service)}</td><td>${s.itemCount}</td><td>${tm(s.submittedAt)}</td><td>${badge(s.status)}${isDelayed(s) ? ' <span class="badge b-danger">Delayed</span>' : ""}</td><td>${openBtn(s.token)}</td></tr>`), queue.length ? "No orders match this search or filter." : "No active orders.");
}
function vActive() {
  const chips = ["ALL", "WAITING", "WASHING", "READY", "DELAYED"].map(k => `<button data-act="status" data-f="${k}" class="${flt.status === k ? "on" : ""}">${k === "ALL" ? "All" : k[0] + k.slice(1).toLowerCase()}</button>`).join("");
  return `<div class="tabs" style="margin-bottom:12px"><button data-act="tab" data-t="active" class="${flt.tab === "active" ? "on" : ""}">Active orders</button><button data-act="tab" data-t="done" class="${flt.tab === "done" ? "on" : ""}">Completed history</button></div>
  <div class="card"><div class="toolbar"><input data-inp="q" type="search" value="${esc(flt.q)}" placeholder="Search token, student, ID" aria-label="Search orders">${flt.tab === "active" ? `<span class="chips">${chips}</span>` : ""}</div>
  <p class="muted small">Search and filters only change what you see. Orders are always served in the order they arrived.</p><div id="tbl">${flt.tab === "active" ? activeTable() : doneTable()}</div></div>`;
}
function doneTable() {
  const q = flt.q.toLowerCase();
  return table(["Token", "Student", "ID", "Service", "Collected", "Processing time"], completed.slice().reverse().filter(s => !q || [s.token, s.student, s.studentId].some(v => v.toLowerCase().includes(q))).map(s => `<tr><td><b>${esc(s.token)}</b></td><td>${esc(s.student)}</td><td>${esc(s.studentId)}</td><td>${esc(s.service)}</td><td>${dt(s.collectedAt)}</td><td>${s.washingAt && s.readyAt ? mins((new Date(s.readyAt) - new Date(s.washingAt)) / 60000) : "-"}</td></tr>`), "No completed orders yet.");
}
function vOrders() {
  const all = mine().filter(s => (flt.hist === "ALL" || (flt.hist === "DONE" ? s.status === "COLLECTED" : s.status !== "COLLECTED")) && (!flt.from || new Date(s.submittedAt) >= new Date(flt.from)) && (!flt.q || s.token.toLowerCase().includes(flt.q.toLowerCase()))).sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
  const chip = (k, l) => `<button data-act="hist" data-f="${k}" class="${flt.hist === k ? "on" : ""}">${l}</button>`;
  return `<div class="card"><h3>My orders</h3><div class="toolbar"><input data-inp="q" type="search" value="${esc(flt.q)}" placeholder="Search by token" aria-label="Search by token"><input type="date" data-chg="from" value="${esc(flt.from)}" aria-label="From date"><span class="chips">${chip("ALL", "All")}${chip("ACTIVE", "In progress")}${chip("DONE", "Completed")}</span></div>
  ${table(["Token", "Date", "Items", "Service", "Status", ""], ordersRows(all), "No orders match.")}</div>`;
}
function vNew() {
  const st = isStaff(), d = draft;
  return `<div class="card"><h3>${st ? "Add laundry request" : "New laundry request"}</h3><form id="f-new" novalidate>
  <div class="cols"><div><label for="n-name">Student name</label><input id="n-name" value="${st ? "" : esc(session.name)}" ${st ? "" : "readonly"}></div><div><label for="n-id">Student ID</label><input id="n-id" value="${st ? "" : esc(session.id)}" placeholder="CH.SC.U4CSE25025" ${st ? "" : "readonly"}></div>
  <div><label for="n-service">Service type</label><select id="n-service" data-d="service">${SERVICES.map(s => `<option ${d.service === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
  <div><label for="n-slot">Preferred slot</label><select id="n-slot" data-d="slot">${SLOTS.map(s => `<option ${d.slot === s ? "selected" : ""}>${s}</option>`).join("")}</select></div>
  <div><label for="n-collect">Pickup / collection</label><select id="n-collect" data-d="collect">${["Laundry Desk", "Hostel Pickup"].map(s => `<option ${d.collect === s ? "selected" : ""}>${s}</option>`).join("")}</select></div></div>
  <label>Items</label><div class="items">${ITEM_TYPES.map(k => `<div class="step"><span>${k}</span><div><button type="button" class="btn sm" data-act="step" data-k="${k}" data-d="-1" aria-label="Decrease ${k}">-</button><b id="q-${k.replace(/\W/g, "")}">${d.items[k] || 0}</b><button type="button" class="btn sm" data-act="step" data-k="${k}" data-d="1" aria-label="Increase ${k}">+</button></div></div>`).join("")}</div>
  <label for="n-notes">Special instructions</label><textarea id="n-notes" data-d="notes" placeholder="Delicate fabric, stains, etc.">${esc(d.notes)}</textarea>
  <div id="summary" class="summary">${summaryHtml()}</div><p id="f-err" class="error" role="alert"></p><button class="btn primary" type="submit">Submit Laundry Request</button></form></div>`;
}
function summaryHtml() {
  const n = Object.values(draft.items).reduce((a, b) => a + b, 0), ahead = queue.reduce((t, s) => t + SERVICE_MIN[s.service], 0);
  return `<div><span>Total items</span><b>${n}</b></div><div><span>Service</span><b>${esc(draft.service)}</b></div><div><span>Preferred slot</span><b>${esc(draft.slot)}</b></div><div><span>Estimated processing time</span><b>~${SERVICE_MIN[draft.service]} min</b></div><div><span>Estimated completion (estimate)</span><b>${tm(new Date(Date.now() + (ahead + SERVICE_MIN[draft.service]) * 60000))}</b></div>`;
}
function notifRow(n) { return `<button class="notif ${n.read ? "read" : "unread"}" data-act="notif" data-id="${esc(n.id)}"><span class="u"></span><span>${esc(n.text)}<br><small class="muted">${esc(n.type)} | ${dt(n.time)}</small></span></button>`; }
function vNotif() {
  const l = myNotifs();
  return `<div class="card"><div class="sec"><h3>Notification center</h3><button class="btn sm" data-act="readAll" ${unread() ? "" : "disabled"}>Mark All as Read</button></div>${l.length ? l.map(notifRow).join("") : empty("No notifications", "Updates about your laundry will appear here.")}</div>`;
}
function vIssues() {
  const st = isStaff(), list = (st ? issues : issues.filter(i => i.studentId === session.id)).filter(i => flt.issue === "ALL" || i.status === flt.issue);
  const opts = mine();
  const form = st ? "" : `<div class="card"><h3>Report an issue</h3><form id="f-issue" novalidate><div class="cols"><div><label for="i-order">Order</label><select id="i-order">${opts.map(s => `<option>${esc(s.token)}</option>`).join("")}</select></div><div><label for="i-type">Issue type</label><select id="i-type">${["Missing Item", "Damaged Item", "Wrong Item", "Quality Issue", "Delay", "Other"].map(t => `<option>${t}</option>`).join("")}</select></div></div><label for="i-desc">Description</label><textarea id="i-desc"></textarea><p id="i-err" class="error" role="alert"></p><button class="btn primary" type="submit" ${opts.length ? "" : "disabled"}>Submit Issue</button> ${opts.length ? "" : '<span class="muted small">You need an order to report an issue.</span>'}</form></div>`;
  const chips = ["ALL", "Submitted", "Under Review", "Resolved"].map(k => `<button data-act="issueF" data-f="${k}" class="${flt.issue === k ? "on" : ""}">${k === "ALL" ? "All" : k}</button>`).join("");
  return form + `<div class="card"><h3>${st ? "All issues" : "My issues"}</h3><div class="toolbar chips">${chips}</div>${table(["Issue ID", "Order", ...(st ? ["Student"] : []), "Type", "Description", "Submitted", "Status"], list.map(i => `<tr><td><b>${esc(i.id)}</b></td><td>${esc(i.token)}</td>${st ? `<td>${esc(i.student)}</td>` : ""}<td>${esc(i.type)}</td><td>${esc(i.desc)}</td><td>${dt(i.time)}</td><td>${st ? `<select data-chg="issue" data-id="${esc(i.id)}" aria-label="Issue status" style="width:auto">${["Submitted", "Under Review", "Resolved"].map(s => `<option ${i.status === s ? "selected" : ""}>${s}</option>`).join("")}</select>` : badge(i.status)}</td></tr>`), "No issues.")}</div>`;
}
function vMachines() {
  return `<div class="mach">${machines.map(m => { const left = m.endsAt ? Math.max(0, Math.ceil((m.endsAt - Date.now()) / 60000)) : 0, tot = m.token ? SERVICE_MIN[(queue.find(s => s.token === m.token) || {}).service] || 45 : 1;
    return `<div class="card"><h3>${m.name}</h3>${badge(m.status)}<p>${m.token ? `Order <b>${esc(m.token)}</b><br>${left} min remaining` : m.status === "AVAILABLE" ? "Ready for the next order" : "Under maintenance"}</p>${m.token ? `<div class="prog"><i style="width:${Math.min(100, 100 - left / tot * 100)}%"></i></div>` : `<button class="btn sm" data-act="mach" data-id="${m.id}">${m.status === "AVAILABLE" ? "Set to maintenance" : "Return to service"}</button>`}</div>`; }).join("")}</div>`;
}
const invStatus = i => (i.stock <= i.crit ? "Critical" : i.stock <= i.low ? "Low" : "Good");
function vInventory() {
  return `<div class="card"><h3>Inventory</h3>${table(["Item", "Current stock", "Unit", "Status", "Last updated", "Action"], inventory.map((i, n) => `<tr><td>${esc(i.name)}</td><td>${i.stock}</td><td>${esc(i.unit)}</td><td>${badge(invStatus(i))}</td><td>${dt(i.updated)}</td><td><button class="btn sm" data-act="inv" data-n="${n}" data-m="add">+ Add Stock</button> <button class="btn sm" data-act="inv" data-n="${n}" data-m="set">Adjust Stock</button></td></tr>`), "")}</div>`;
}
function vSchedule() {
  const list = allOrders().filter(s => sameDay(s.submittedAt));
  return `<div class="card"><h3>Today's schedule<span class="sub">capacity ${SLOT_CAPACITY} requests per slot</span></h3>${table(["Time slot", "Today's requests", "Active now", "Available capacity", "Status"], SLOTS.map(sl => { const n = list.filter(s => s.slot === sl).length, a = queue.filter(s => s.slot === sl).length; return `<tr><td>${sl}</td><td>${n}</td><td>${a}</td><td>${Math.max(0, SLOT_CAPACITY - n)}</td><td>${badge(n >= SLOT_CAPACITY ? "Critical" : n >= SLOT_CAPACITY * .7 ? "Low" : "Good", n >= SLOT_CAPACITY ? "Full" : n >= SLOT_CAPACITY * .7 ? "Busy" : "Open")}</td></tr>`; }), "")}</div>
  <div class="card"><h3>Upcoming workload</h3><p>${queue.length} active orders, about ${queue.reduce((t, s) => t + SERVICE_MIN[s.service], 0)} minutes of processing.</p></div>`;
}
function vAnalytics() {
  const all = allOrders(), days = [...Array(7)].map((_, i) => { const d = new Date(Date.now() - (6 - i) * 864e5); return [d.toLocaleDateString([], { weekday: "short" }), all.filter(s => sameDay(s.submittedAt, d)).length]; }), mx = Math.max(1, ...days.map(d => d[1]));
  const hrs = tally(all.filter(s => s.submittedAt), s => { const h = new Date(s.submittedAt).getHours(); return (h % 12 || 12) + (h < 12 ? " AM" : " PM"); });
  const rate = all.length ? Math.round(completed.length / all.length * 100) : 0;
  return kpis([["Total requests", all.length], ["Completion rate", rate + "%"], ["Avg processing time", mins(procMin())], ["Avg daily requests", (all.length / 7).toFixed(1)], ["Ready orders", queue.filter(s => s.status === "READY").length], ["Open issues", issues.filter(i => i.status !== "Resolved").length]]) +
    `<div class="grid2"><div class="card"><h3>Requests over time<span class="sub">last 7 days</span></h3><div class="vcols">${days.map(([l, v]) => `<div><span>${v}</span><i style="height:${v / mx * 100}%"></i><span>${l}</span></div>`).join("")}</div></div>${hbar("Requests by department", tally(all, s => s.dept))}${hbar("Requests by service type", tally(all, s => s.service))}${hbar("Peak request hours", hrs)}${hbar("Completed vs active", { Completed: completed.length, Active: queue.length })}${hbar("Issue categories", tally(issues, i => i.type))}</div>`;
}
function reportSet() {
  const r = flt.rep;
  return allOrders().filter(s => (!r.from || new Date(s.submittedAt) >= new Date(r.from)) && (!r.to || new Date(s.submittedAt) <= new Date(r.to + "T23:59:59")) && (r.dept === "ALL" || s.dept === r.dept) && (r.service === "ALL" || s.service === r.service) && (r.status === "ALL" || s.status === r.status));
}
function vReports() {
  const r = flt.rep, set = reportSet(), done = set.filter(s => s.status === "COLLECTED"), pr = set.filter(s => s.washingAt && s.readyAt).map(s => (new Date(s.readyAt) - new Date(s.washingAt)) / 60000);
  const sel = (k, opts, l) => `<div><label for="r-${k}">${l}</label><select id="r-${k}" data-chg="rep" data-k="${k}"><option value="ALL">All</option>${opts.map(o => `<option value="${o}" ${r[k] === o ? "selected" : ""}>${LABEL[o] || o}</option>`).join("")}</select></div>`;
  const bt = o => table(["Name", "Count"], Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`), "No data.");
  return `<div class="card noprint"><h3>Report filters</h3><div class="cols"><div><label for="r-from">From</label><input type="date" id="r-from" data-chg="rep" data-k="from" value="${r.from}"></div><div><label for="r-to">To</label><input type="date" id="r-to" data-chg="rep" data-k="to" value="${r.to}"></div>${sel("dept", ALL_DEPTS, "Department")}${sel("service", SERVICES, "Service")}${sel("status", [...STATUSES, "COLLECTED"], "Status")}</div>
  <div class="qa" style="margin:14px 0 0"><button class="btn primary" data-act="csv">Export CSV</button><button class="btn" data-act="print">Print Report</button></div></div>
  ${kpis([["Total requests", set.length], ["Completed", done.length], ["Pending", set.length - done.length], ["Avg processing time", mins(avg(pr))]])}
  <div class="grid2"><div class="card"><h3>Department breakdown</h3>${bt(tally(set, s => s.dept))}</div><div class="card"><h3>Service breakdown</h3>${bt(tally(set, s => s.service))}</div><div class="card"><h3>Issue breakdown</h3>${bt(tally(issues.filter(i => set.some(s => s.token === i.token)), i => i.type))}</div></div>`;
}
function exportCsv() {
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const rows = [["Token", "Student", "Student ID", "Department", "Service", "Items", "Submitted", "Status", "Collected"], ...reportSet().map(s => [s.token, s.student, s.studentId, s.dept, s.service, s.itemCount, s.submittedAt, LABEL[s.status], s.collectedAt || ""])];
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([rows.map(r => r.map(q).join(",")).join("\n")], { type: "text/csv" })); a.download = "laundry-report.csv"; a.click();
  showToast(`Exported ${rows.length - 1} rows.`, "success");
}
function vAudit() {
  const a = flt.aud, uniq = k => [...new Set(audit.map(x => x[k]).filter(Boolean))];
  const sel = (k, l) => `<select data-chg="aud" data-k="${k}" aria-label="${l}"><option value="ALL">${l}: all</option>${uniq(k).map(o => `<option ${a[k] === o ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
  const list = audit.filter(x => (a.user === "ALL" || x.user === a.user) && (a.role === "ALL" || x.role === a.role) && (a.action === "ALL" || x.action === a.action) && (!a.date || sameDay(x.time, new Date(a.date + "T12:00:00"))));
  return `<div class="card"><h3>Audit log<span class="sub">read-only</span></h3><div class="toolbar">${sel("user", "User")}${sel("role", "Role")}${sel("action", "Action")}<input type="date" data-chg="aud" data-k="date" value="${a.date}" aria-label="Date"></div>${table(["Timestamp", "User", "Role", "Action", "Order", "Details"], list.slice(0, 150).map(x => `<tr><td>${dt(x.time)}</td><td>${esc(x.user)}</td><td>${esc(x.role)}</td><td>${esc(x.action)}</td><td>${esc(x.token)}</td><td>${esc(x.details)}</td></tr>`), "No matching entries.")}</div>`;
}
function vDsa() {
  const f = getFront(), r = getRear(), op = audit.find(a => a.op), nm = session.role !== "student";
  const chain = isQueueEmpty() ? empty("QUEUE EMPTY", "FRONT: - | REAR: - | SIZE: 0") : `<div class="chain">${queue.map((s, i) => `<div class="node" style="display:flex;align-items:center"><div class="box ${i === 0 ? "f" : ""}"><span class="ptr">${i === 0 && queue.length === 1 ? "FRONT / REAR" : i === 0 ? "FRONT" : i === queue.length - 1 ? "REAR" : ""}</span><b>${esc(s.token)}</b><div class="muted small">${nm ? esc(s.student) : ""}</div>${badge(s.status)}</div>${i < queue.length - 1 ? '<span class="arrow">&rarr;</span>' : ""}</div>`).join("")}</div>`;
  return `<div class="sec"><h2>DSA Concepts</h2><button class="btn primary" data-act="viva">DSA Viva Mode</button></div>
  <div class="card"><h3>The order-processing engine is a Queue</h3><p>A Queue is a linear data structure that follows <b>FIFO: First In, First Out</b>. Active laundry orders are stored in one JavaScript array, <code>let queue = []</code>. Search, filters and reports only read it; none of them reorder it.</p>
  <table><thead><tr><th>Laundry event</th><th>Queue operation</th><th>Code</th></tr></thead><tbody>
  <tr><td>New laundry request</td><td>ENQUEUE (added at REAR)</td><td><code>queue.push(order)</code></td></tr><tr><td>Next order to be processed</td><td>FRONT</td><td><code>queue[0]</code></td></tr><tr><td>Most recent order</td><td>REAR</td><td><code>queue[queue.length-1]</code></td></tr><tr><td>Order collected</td><td>DEQUEUE (removed from FRONT)</td><td><code>queue.shift()</code></td></tr><tr><td>Active orders</td><td>SIZE / IS EMPTY</td><td><code>queue.length</code></td></tr></tbody></table>
  <p class="muted small">Position = index + 1, students ahead = index. Only the FRONT order can be processed or collected, so a later order can never bypass an earlier one (enforced in <code>advanceFront()</code> and <code>collectFront()</code>).</p></div>
  <div class="card"><h3>Live queue</h3>${chain}<div class="dl"><div><span>FRONT</span>${f ? f.token : "-"}</div><div><span>REAR</span>${r ? r.token : "-"}</div><div><span>SIZE</span>${getQueueSize()}</div><div><span>IS EMPTY</span>${isQueueEmpty() ? "TRUE" : "FALSE"}</div></div>
  <div class="lastop">${op ? `LAST QUEUE OPERATION\n${op.op} ${op.token}\n${op.op === "ENQUEUE" ? "Added at REAR" : "Removed from FRONT"}\nQueue size: ${op.size}   FRONT: ${op.front || "-"}   REAR: ${op.rear || "-"}` : "No queue operation yet."}</div></div>
  <div class="grid2"><div class="card"><h3>Why a Queue and not a Stack?</h3><p>A Queue is FIFO: the first student to submit laundry is served first. A Stack is LIFO: the newest request would be served first and early requests could wait forever. Fair service needs FIFO.</p></div>
  <div class="card"><h3>Time complexity</h3><table><tr><th>Operation</th><th>Complexity</th></tr><tr><td>ENQUEUE (push)</td><td>O(1)</td></tr><tr><td>FRONT, REAR, SIZE, IS EMPTY</td><td>O(1)</td></tr><tr><td>Search by token or ID</td><td>O(n)</td></tr><tr><td>DEQUEUE (shift)</td><td>O(n)</td></tr></table><p class="muted small">Array shift() moves the remaining elements, so DEQUEUE is O(n). A front-pointer queue would be O(1).</p></div></div>`;
}
const VIVA = [["Why a Queue?", "Orders must be served in the order they arrive."], ["What is FIFO?", "First In, First Out: the earliest item leaves first."], ["What is ENQUEUE?", "Adding an order at the REAR: queue.push(order)."], ["What is DEQUEUE?", "Removing the order at the FRONT after collection: queue.shift()."], ["What is FRONT?", "queue[0], the longest-waiting active order."], ["What is REAR?", "queue[queue.length-1], the newest order."], ["What is the time complexity?", "ENQUEUE, FRONT, REAR, SIZE are O(1). Search is O(n). DEQUEUE with shift() is O(n)."], ["Why can't a later request bypass the first?", "advanceFront() and collectFront() only act on queue[0] and reject any other token."], ["How is queue order preserved?", "One array is the only source of truth. It is never sorted; filters work on copies and keep real positions. It is saved to localStorage as JSON in order."], ["What happens when the queue is empty?", "getFront() returns null, IS EMPTY is true, and the UI shows empty states. DEQUEUE returns null instead of failing."]];
function vSettings() {
  const dark = document.documentElement.dataset.theme === "dark";
  return `<div class="card"><h3>Appearance</h3><div class="chips"><button data-act="theme" data-t="light" class="${dark ? "" : "on"}">Light mode</button><button data-act="theme" data-t="dark" class="${dark ? "on" : ""}">Dark mode</button></div></div>
  <div class="card"><h3>Notifications</h3><label style="display:flex;gap:8px;align-items:center;margin:0"><input type="checkbox" data-chg="notifSet" ${settings.notifications ? "checked" : ""}> Enable notification pop-ups</label></div>
  <div class="card"><h3>Data storage</h3><p class="muted">${DB.ready ? "Firestore connected. Orders, issues and notifications are shared across devices." : "Local storage only. Paste your Firebase config into script.js to enable Firestore."}</p></div>
  ${isStaff() ? `<div class="card"><h3>Register student</h3><form id="f-reg" novalidate><div class="cols"><div><label for="rs-name">Full name</label><input id="rs-name"></div><div><label for="rs-roll">Roll number</label><input id="rs-roll" placeholder="CH.SC.U4CSE25025"></div></div><p id="rs-err" class="error" role="alert"></p><button class="btn primary" type="submit">Register student</button></form></div><div class="card"><h3>System</h3><p class="muted">Demo mode: sample data is clearly marked and never loaded automatically.</p><div class="qa"><button class="btn" data-act="demoLoad">Load Demo Data</button><button class="btn" data-act="demoClear">Clear Demo Data</button><button class="btn danger" data-act="clearHist">Clear Completed History</button><button class="btn danger" data-act="resetAll">Reset Entire Application</button></div></div>` : ""}`;
}
const VIEWS = { dash: vDash, new: vNew, orders: vOrders, notif: vNotif, issues: vIssues, active: vActive, machines: vMachines, inventory: vInventory, schedule: vSchedule, analytics: vAnalytics, reports: vReports, audit: vAudit, dsa: vDsa, settings: vSettings };

// ---------- ORDER DETAILS ----------
function showOrder(token) {
  const s = allOrders().find(x => x.token === token);
  if (!s) return showToast("Order not found.", "error");
  if (session.role === "student" && s.studentId !== session.id) return showToast("You can only view your own orders.", "error");
  const f = getFront(), live = queue.includes(s), canAct = isStaff() && live;
  let ctl = "";
  if (canAct) ctl = f === s ? (s.status === "READY" ? `<button class="btn go" data-act="collect" data-token="${esc(s.token)}">Collect</button>` : `<button class="btn primary" data-act="ostep" data-token="${esc(s.token)}">${{ WAITING: "Start Washing", WASHING: "Send to Quality Check", QUALITY: "Mark Ready" }[s.status]}</button>`) : `<span class="muted small">This order is waiting for earlier orders to be completed.</span>`;
  const e = live ? estimate(s) : null, items = Object.entries(s.items).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(", ") || s.itemCount + " items";
  showModal("Laundry " + s.token, `<div class="dl"><div><span>STATUS</span>${badge(s.status)}</div><div><span>SERVICE</span>${esc(s.service)}</div><div><span>STUDENT</span>${esc(s.student)}</div><div><span>STUDENT ID</span>${esc(s.studentId)}</div><div><span>DEPARTMENT</span>${esc(s.dept)}</div><div><span>SUBMITTED</span>${dt(s.submittedAt)}</div><div><span>EXPECTED COMPLETION</span>${e ? tm(e) + " (estimate)" : s.collectedAt ? "Done" : "-"}</div><div><span>ITEMS</span>${esc(items)}</div></div>
  <p><b>Instructions:</b> ${esc(s.notes) || "None"}</p>${timeline(s)}<h3>Activity history</h3>${s.history.length ? s.history.map(h => `<div class="hrow"><span>${dt(h.t)}</span><span>${esc(h.text)} (${esc(h.by)})</span></div>`).join("") : '<p class="muted">No activity recorded.</p>'}<div class="qa" style="margin-top:12px">${ctl}</div>`);
  $("m-ok").classList.add("hidden");
}

// ---------- DEMO DATA ----------
function loadDemoData() {
  if (!assertStaff()) return;
  const now = Date.now(), ppl = Object.entries(DIRECTORY), before = queue.length + completed.length;
  for (let i = 0; i < 14; i++) { // completed orders over the last week
    const [id, name] = ppl[i % ppl.length], sub = new Date(now - (1 + i % 6) * 864e5); sub.setHours(8 + (i * 3) % 11, (i * 17) % 60);
    const w = +sub + (10 + i % 20) * 6e4, r = w + (30 + i * 7 % 40) * 6e4, c = r + (20 + i * 11 % 60) * 6e4, svc = SERVICES[i % 4];
    const o = normOrder({ token: generateToken(), student: name, studentId: id, service: svc, items: { Shirts: 2 + i % 3, Pants: 1 + i % 2 }, itemCount: 3 + i % 3 + i % 2, slot: SLOTS[i % 6], status: "COLLECTED", submittedAt: sub.toISOString(), washingAt: new Date(w).toISOString(), readyAt: new Date(r).toISOString(), collectedAt: new Date(c).toISOString(), demo: true });
    o.history = [["WAITING", +sub, "Request submitted and accepted"], ["WASHING", w, "Washing started"], ["READY", r, "Ready for pickup"], ["COLLECTED", c, "Collected"]].map(([status, t, text]) => ({ t: new Date(t).toISOString(), status, by: "Laundry Staff", text }));
    completed.push(o); audit.unshift({ id: "d" + i + now, time: o.collectedAt, user: "Laundry Staff", role: "staff", action: "Collected order", token: o.token, details: o.token + " left the order queue", demo: true });
  }
  ppl.slice(0, 5).forEach(([id, name], i) => { // active orders
    if (findByStudentId(id) !== -1) return;
    enqueueOrder({ student: name, studentId: id, service: SERVICES[(i + 1) % 4], items: { Shirts: 3, "T-Shirts": 2 + i, Bedsheets: i % 2 }, itemCount: 5 + i + i % 2, slot: SLOTS[1 + i % 3], submittedAt: new Date(now - (140 - i * 25) * 6e4).toISOString(), demo: true });
    notify(id, queue[queue.length - 1].token, "accepted", `Laundry request ${queue[queue.length - 1].token} accepted.`, { demo: true });
  });
  if (getFront() && getFront().status === "WAITING") advanceFront();
  const m = machines.find(x => x.status === "AVAILABLE" && !x.token); if (m && m.id === 3) m.status = "MAINTENANCE"; else { const m3 = machines.find(x => x.id === 3 && x.status === "AVAILABLE"); if (m3) m3.status = "MAINTENANCE"; }
  inventory.forEach(i => { if (i.name === "Gloves") i.stock = 12; if (i.name === "Tags") i.stock = 22; });
  const c0 = completed.filter(s => s.demo);
  [[c0[0], "Missing Item", "One sock was missing from my order.", "Resolved"], [c0[1], "Delay", "Order took longer than expected.", "Under Review"], [c0[2], "Quality Issue", "Stain was not removed.", "Submitted"]].forEach(([o, type, desc, status], n) => { if (o) issues.push({ id: "I" + String(issues.length + 1).padStart(3, "0"), token: o.token, studentId: o.studentId, student: o.student, type, desc, status, time: new Date(now - n * 36e5).toISOString(), demo: true }); });
  notify("STAFF", c0[2] ? c0[2].token : "-", "issue", "New issue reported on a completed order.", { demo: true });
  saveData(); showToast(`Demo data loaded (${queue.length + completed.length - before} orders).`, "success"); render();
}
function clearDemoData() {
  const dt_ = new Set(allOrders().filter(s => s.demo).map(s => s.token));
  queue = queue.filter(s => !s.demo); completed = completed.filter(s => !s.demo);
  audit = audit.filter(a => !a.demo && !dt_.has(a.token)); notifs = notifs.filter(n => !n.demo && !dt_.has(n.token)); issues = issues.filter(i => !i.demo);
  machines = defaultMachines(); inventory = defaultInventory();
  queue.forEach(s => { if (s.status === "WASHING") { const m = machines.find(x => x.id === s.machineId); if (m) { m.status = "WASHING"; m.token = s.token; m.endsAt = Date.now() + 30 * 6e4; } } });
  saveData(); showToast("Demo data cleared. Real orders were kept.", "success"); render();
}
function resetAll() { queue = []; completed = []; audit = []; sizeLog = []; notifs = []; issues = []; tokenNumber = 1; if (DB.ready) DB.db.collection("meta").doc("counter").set({ next: 1 }).catch(cloudError); machines = defaultMachines(); inventory = defaultInventory(); saveData(); showToast("Application reset.", "success"); render(); }

// ---------- RENDER / NAVIGATION ----------
function render() {
  if (!session) return;
  $("view").innerHTML = VIEWS[cur]();
  $("view-title").textContent = TITLES[cur];
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.v === cur));
  const u = unread(); $("bell").innerHTML = icon("notif") + (u ? `<span class="dot">${u}</span>` : "");
}
function go(v) { cur = v; $("sidebar").classList.remove("open"); render(); }
function showApp() {
  $("login-screen").classList.add("hidden"); $("app").classList.remove("hidden");
  $("crumb-role").textContent = { staff: "Staff Portal", professor: "Faculty Portal", student: "Student Portal" }[session.role] + (session.role === "student" ? " | " + session.id : "");
  $("profile-btn").textContent = session.name;
  $("nav").innerHTML = NAV[session.role].map(([g, vs]) => `<div class="ngroup">${g}</div>` + vs.map(v => `<button data-act="go" data-v="${v}" data-nav="1">${icon(v)}${TITLES[v]}</button>`).join("")).join("");
  go("dash");
}

// ---------- EVENTS (one delegated listener per event type) ----------
const ACT = {
  go: e => go(e.dataset.v), open: e => showOrder(e.dataset.token),
  advance: () => { if (advanceFront()) { render(); showToast("Order updated.", "success"); } },
  ostep: e => { closeModal(); if (stepOrder(e.dataset.token)) { render(); showToast("Order updated.", "success"); } },
  collect: e => { const s = queue.find(x => x.token === e.dataset.token); if (!s) return; closeModal(); showModal("Mark laundry as collected?", `<p><b>${esc(s.token)}</b><br>${esc(s.student)}</p><p class="muted">The order will leave the active queue and move to completed history.</p>`, "Confirm Collection", () => { if (collectFront(s.token)) { render(); showToast(`${s.token} collected.`, "success"); } }); },
  status: e => { flt.status = e.dataset.f; render(); }, tab: e => { flt.tab = e.dataset.t; render(); }, hist: e => { flt.hist = e.dataset.f; render(); }, issueF: e => { flt.issue = e.dataset.f; render(); },
  step: e => { const k = e.dataset.k, v = Math.max(0, Math.min(30, (draft.items[k] || 0) + +e.dataset.d)); draft.items[k] = v; $("q-" + k.replace(/\W/g, "")).textContent = v; $("summary").innerHTML = summaryHtml(); },
  notif: e => { const n = notifs.find(x => x.id === e.dataset.id); if (!n) return; n.read = true; saveData(); render(); if (n.token && n.token !== "-" && allOrders().some(s => s.token === n.token)) showOrder(n.token); },
  readAll: () => { myNotifs().forEach(n => (n.read = true)); saveData(); render(); },
  mach: e => { const m = machines.find(x => x.id === +e.dataset.id); if (!m || m.token || !assertStaff()) return; m.status = m.status === "AVAILABLE" ? "MAINTENANCE" : "AVAILABLE"; logAudit("Machine update", null, `${m.name} set to ${m.status.toLowerCase()}`); saveData(); render(); },
  inv: e => { const i = inventory[+e.dataset.n], add = e.dataset.m === "add"; if (!assertStaff()) return; showModal((add ? "Add stock: " : "Adjust stock: ") + i.name, `<label for="m-val">${add ? "Quantity to add" : "New stock level"} (${esc(i.unit)})</label><input id="m-val" type="number" min="0" step="any">`, "Save", () => { const v = parseFloat($("m-val").value); if (!(v >= 0)) return showToast("Enter a valid number.", "error"); i.stock = add ? i.stock + v : v; i.updated = new Date().toISOString(); logAudit("Inventory update", null, `${i.name}: ${i.stock} ${i.unit}`); saveData(); render(); showToast("Stock updated.", "success"); }); },
  csv: exportCsv, print: () => window.print(),
  viva: () => { showModal("DSA Viva Mode", VIVA.map(([q, a]) => `<details><summary><b>${q}</b></summary><p>${a}</p></details>`).join("") + '<p class="big" style="margin-top:12px">FIFO = First In, First Out</p>'); $("m-ok").classList.add("hidden"); },
  theme: e => setTheme(e.dataset.t), toggleTheme: () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"),
  profile: () => { showModal("Profile", `<div class="dl"><div><span>NAME</span>${esc(session.name)}</div><div><span>${session.role === "student" ? "ROLL NUMBER" : "INSTITUTIONAL ID"}</span>${esc(session.id)}</div><div><span>ROLE</span>${esc(session.role)}</div><div><span>DEPARTMENT</span>${esc(session.dept || "-")}</div>${session.year ? `<div><span>YEAR</span>${session.year}</div>` : ""}</div><button class="btn danger" data-act="logout">Logout</button>`); $("m-ok").classList.add("hidden"); },
  logout: () => { closeModal(); if (DB.auth) DB.auth.signOut().catch(() => {}); session = null; try { sessionStorage.removeItem("laundrySession"); } catch {} $("app").classList.add("hidden"); $("login-screen").classList.remove("hidden"); },
  demoLoad: loadDemoData,
  demoClear: () => showModal("Clear demo data?", "<p>Only demo records are removed. Real orders keep their order.</p>", "Clear Demo Data", clearDemoData, true),
  clearHist: () => showModal("Clear completed history?", "<p>All completed orders will be permanently deleted.</p>", "Clear History", () => { completed = []; saveData(); render(); showToast("Completed history cleared.", "success"); }, true),
  resetAll: () => showModal("Reset entire application?", "<p><b>Warning:</b> this deletes all orders, notifications, issues, audit log and statistics, and resets tokens to L001.</p>", "Reset Everything", resetAll, true)
};
function setTheme(t) { document.documentElement.dataset.theme = t; try { localStorage.setItem("theme", t); } catch {} if (cur === "settings") render(); }
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el || el.disabled) return;
  if (!el.closest("#sres")) $("sres").classList.add("hidden");
  if (el.closest("#sres")) { $("sres").classList.add("hidden"); $("gsearch").value = ""; }
  ACT[el.dataset.act] && ACT[el.dataset.act](el);
});
document.addEventListener("change", e => {
  const el = e.target, k = el.dataset.chg;
  if (el.dataset.d) draft[el.dataset.d] = el.value, $("summary") && ($("summary").innerHTML = summaryHtml());
  if (!k) return;
  if (k === "dept") flt.dept = el.value; else if (k === "from") flt.from = el.value; else if (k === "rep") flt.rep[el.dataset.k] = el.value; else if (k === "aud") flt.aud[el.dataset.k] = el.value;
  else if (k === "notifSet") { settings.notifications = el.checked; saveData(); return; }
  else if (k === "issue") { if (!assertStaff()) return; const i = issues.find(x => x.id === el.dataset.id); i.status = el.value; logAudit("Issue updated", { token: i.token }, `${i.id} set to ${i.status}`); notify(i.studentId, i.token, "issue", `Issue ${i.id} is now: ${i.status}.`); saveData(); showToast("Issue updated.", "success"); }
  render();
});
document.addEventListener("input", e => {
  const el = e.target;
  if (el.dataset.d === "notes") draft.notes = el.value;
  if (el.dataset.inp === "q") { flt.q = el.value; const t = $("tbl"); if (t) t.innerHTML = flt.tab === "done" ? doneTable() : activeTable(); else render(), $("view").querySelector("[data-inp=q]").focus(); }
  if (el.id === "gsearch") globalSearch(el.value);
});
function globalSearch(v) {
  const q = v.trim().toLowerCase(), box = $("sres"); if (!q || !session) return box.classList.add("hidden");
  const pool = session.role === "student" ? mine() : allOrders(), hits = pool.filter(s => [s.token, s.student, s.studentId, s.dept, LABEL[s.status]].some(x => String(x).toLowerCase().includes(q))).slice(0, 8);
  box.innerHTML = hits.length ? hits.map(s => `<button data-act="open" data-token="${esc(s.token)}"><span><b>${esc(s.token)}</b> ${esc(s.student)}</span><span>${esc(s.dept)} | ${LABEL[s.status]}</span></button>`).join("") : "<p>No matching orders.</p>"; box.classList.remove("hidden");
}
document.addEventListener("submit", async e => {
  e.preventDefault();
  if (e.target.id === "login-form") {
    const btn = $("login-submit"); btn.disabled = true;
    let err;
    try {
      err = loginRole !== "student" ? login(loginRole, $("login-id").value, $("login-pw").value)
        : authMode === "signup" ? await signUpStudent($("login-name").value, $("login-id").value, $("login-pw").value, $("login-confirm").value)
        : await loginStudent($("login-id").value, $("login-pw").value);
    } catch (x) { err = "Something went wrong. Please try again."; console.error(x); }
    btn.disabled = false; $("login-error").textContent = err;
    if (err) return showToast(err, "error");
    $("login-id").value = ""; $("login-pw").value = ""; $("login-name").value = ""; $("login-confirm").value = ""; if (!DB.ready) loadData(); showApp();
  } else if (e.target.id === "f-new") {
    const r = await submitOrder({ student: $("n-name").value.trim(), studentId: $("n-id").value.trim().toUpperCase(), service: draft.service, items: { ...draft.items }, notes: draft.notes.trim(), collect: draft.collect, slot: draft.slot });
    if (typeof r === "string") { $("f-err").textContent = r; return showToast(r, "error"); }
    draft = { service: SERVICES[0], items: {}, notes: "", collect: "Laundry Desk", slot: SLOTS[1] };
    if (settings.notifications) showToast(`Request ${r.token} submitted.`, "success");
    isStaff() ? (go("active"), showOrder(r.token)) : (go("dash"), showOrder(r.token));
  } else if (e.target.id === "f-issue") {
    const token = $("i-order").value, desc = $("i-desc").value.trim();
    if (!desc) { $("i-err").textContent = "Please describe the issue."; return showToast("Please describe the issue.", "error"); }
    const o = mine().find(s => s.token === token), id = "I" + String(issues.length + 1).padStart(3, "0");
    issues.unshift({ id, token, studentId: session.id, student: session.name, type: $("i-type").value, desc, status: "Submitted", time: new Date().toISOString() });
    o.issueIds.push(id); logAudit("Issue reported", o, `${id}: ${$("i-type").value}`); notify("STAFF", token, "issue", `New issue ${id} on ${token}.`); saveData(); render(); showToast("Issue submitted.", "success");
  } else if (e.target.id === "f-reg") {
    const r = await registerStudent($("rs-name").value.trim(), $("rs-roll").value.trim().toUpperCase());
    if (typeof r === "string") { $("rs-err").textContent = r; return showToast(r, "error"); }
    showToast(`${r.name} registered.`, "success"); render();
  }
});
document.addEventListener("keydown", e => { if (e.key === "Escape") $("sres").classList.add("hidden"); });

// login role tabs
let loginRole = "student", authMode = "login";
function applyLoginUI() { // Login / Sign Up switch for students; professor and staff always see plain login
  const stu = loginRole === "student", su = stu && authMode === "signup";
  $("login-id-label").textContent = { student: "Roll Number", professor: "Faculty ID", staff: "Staff ID" }[loginRole];
  $("name-row").classList.toggle("hidden", !su); $("confirm-row").classList.toggle("hidden", !su);
  $("login-submit").textContent = su ? "Create Account" : "Login";
  $("login-pw").autocomplete = su ? "new-password" : "current-password";
  $("auth-switch").classList.toggle("hidden", !stu);
  $("auth-switch").innerHTML = su ? 'Already have an account? <button type="button" class="linkbtn" data-auth="login">Login</button>' : 'Don\'t have an account? <button type="button" class="linkbtn" data-auth="signup">Sign Up</button>';
  $("login-error").textContent = "";
}
document.addEventListener("click", e => { const b = e.target.closest("[data-auth]"); if (b) { authMode = b.dataset.auth; applyLoginUI(); } });
const HELP = { student: "CH = Campus, SC/EN = School, U4 = Undergraduate, CSE = Department, 25 = Joining year, 025 = Roll number", professor: "CH = Campus, FA = Faculty, U4 = University, CSE = Department, 25 = Joining year, 001 = Faculty number", staff: "Use the laundry staff ID." };
const PH = { student: "CH.SC.U4CSE25025", professor: "CH.FA.U4CSE25001", staff: "STAFF-LAUNDRY-01" };
document.querySelectorAll(".roles button").forEach(b => b.addEventListener("click", () => {
  loginRole = b.dataset.role;
  document.querySelectorAll(".roles button").forEach(x => { x.classList.toggle("active", x === b); x.setAttribute("aria-selected", x === b); });
  applyLoginUI(); $("login-id").placeholder = PH[loginRole]; $("id-help").textContent = HELP[loginRole]; $("login-error").textContent = "";
}));
$("id-help").textContent = HELP.student; applyLoginUI();
$("menu-btn").onclick = () => $("sidebar").classList.toggle("open");

// live updates: other tabs (storage event) and a light refresh while the user is not typing
function refreshView() { // re-render unless the user is typing or a dialog is open
  if (!session || $("modal").open) return;
  const a = document.activeElement; if (a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) return;
  render();
}
function refresh() { if (!DB.ready) loadData(); refreshView(); } // with Firestore, live listeners keep the data current
window.addEventListener("storage", refresh); setInterval(refresh, 4000);
function tick() { const d = new Date(); $("clock").textContent = d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) + "\n" + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
setInterval(tick, 20000);

// ---------- STARTUP ----------
loadData(); initCloud(); document.documentElement.dataset.theme = readKey("theme", "dark"); tick();
try { const s = JSON.parse(sessionStorage.getItem("laundrySession")); if (s && NAV[s.role]) { session = s; showApp(); } } catch {}
