# Smart Laundry - University Laundry Management System

A laundry management platform whose **order-processing engine is a Queue (FIFO)**. This is a DSA mini-project: the Queue is explained on the *DSA Concepts* page and used underneath every workflow.

## Run
Open `index.html`. No server, no dependencies. Data is stored in `localStorage`.

## Demo logins (demo access control only, not real security; defined once in `CONFIG` in `script.js`)
| Role | ID | Password |
|---|---|---|
| Student | Sign Up first with any valid roll number, e.g. `CH.SC.U4CSE25025` | your own password (Firebase Auth) |
| Professor | `CH.FA.U4CSE25001` | `professor123` |
| Staff | `STAFF-LAUNDRY-01` | `staff123` |

Student ID: `CH.SC.U4CSE25025` = campus, school (SC/EN), U4, department, joining year, `0` + 2-digit roll. Faculty ID: `CH.FA.U4CSE25001`.
Staff: *Settings > Load Demo Data* fills the app with sample orders, issues, machines and inventory.

## Roles
- **Student:** dashboard, new request (services, item counts, slot), order tracking with timeline, history, notifications, issues.
- **Staff:** operations dashboard, add laundry, active orders, machines, inventory, schedule, issue management, analytics, reports (CSV and print), audit log, settings.
- **Professor:** read-only department overview, analytics, reports.

## Student sign up and login (Firebase Authentication)
Students **Sign Up** (full name, roll number, password of at least 8 characters, confirm password) and then **Login** (roll number + password). Passwords are handled only by Firebase Authentication; they are never stored in Firestore or localStorage. Behind the scenes the roll number becomes a hidden email such as `ch.sc.u4cse25025@smartlaundry.app`. Sign up creates `students/{rollNumber}` with `name, rollNumber, department, year, uid`. The roll number is unique because Firebase rejects a second account for the same email. Professor and staff login are unchanged and work offline.

**Required Firebase console setting:** Build > Authentication > Get started > Sign-in method > **Email/Password > Enable**. Also run the app from `http://localhost` (Live Server or `python -m http.server`); Firebase Authentication does not work from a `file://` page. Student accounts need Firebase configured; staff can still register students (Settings) so orders can be created for them.

## Firebase Firestore (optional)
Without setup the app runs on `localStorage`. To share data between devices: open `script.js`, find **FIREBASE FIRESTORE** at the top, and follow steps 1-6 in the comment (create project, create Firestore database, register web app, copy config, paste it, publish the demo rules). Collections: `students`, `laundryOrders` (orderId, token, studentName, studentRoll, department, service, items, pickupSlot, status, createdAt, queuePosition), `issues`, `notifications`, `meta` (token counter). The demo rules are open to everyone: demo only.

**The Queue is not replaced by Firebase.** `let queue = []` stays the in-memory FIFO queue (`push` = ENQUEUE, `shift` = DEQUEUE). Firestore only stores orders; on load, active orders are sorted by token number (arrival order) to rebuild the queue. Queue position is `index + 1` and is also saved as `queuePosition` on each order. Audit log, machines and inventory stay in each browser's localStorage.

## The Queue (DSA)
`let queue = []` holds active orders. `queue[0]` = FRONT, last = REAR.
- ENQUEUE: `queue.push(order)` in `enqueueOrder()` (new request).
- DEQUEUE: `queue.shift()` in `dequeueFront()` (collection).
- FRONT / REAR / SIZE / IS EMPTY: `getFront`, `getRear`, `getQueueSize`, `isQueueEmpty`.

**Strict FIFO:** only the FRONT order can start washing, move through quality check, become ready, or be collected. `advanceFront()`, `stepOrder()` and `collectFront()` reject anything else. Search, filters, reports and global search read copies and never reorder the queue.

Status flow: WAITING > WASHING > QUALITY CHECK > READY > COLLECTED (no skipping).

Complexity: ENQUEUE, FRONT, REAR, SIZE O(1); search O(n); DEQUEUE O(n) because `Array.shift()` moves elements.

## localStorage keys
`laundryQueue`, `laundryCompleted`, `laundryTokenNumber`, `laundryAudit`, `laundrySizeLog`, `laundryNotifications`, `laundryIssues`, `laundryMachines`, `laundryInventory`, `laundrySettings`, `theme`. Bad or old data is cleaned and migrated on load.

## Viva questions
See *DSA Concepts > DSA Viva Mode* (10 questions with answers).

## Screenshots
_Add screenshots here._

## Limitations
Firestore rules in this demo are open; names are not authenticated. Audit log, machines and inventory are not shared across devices. No backend (all roles share one browser's storage). Wait and completion times are estimates. No order cancellation (it would remove a non-front order from the queue). No photo upload for issues.
