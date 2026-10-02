# Endpoint Behaviour Reference

Behaviour snapshot of the BookMe backend, maintained alongside the test suite in
`server/test/`. This document describes what the API **does**, including
behaviour that is still wrong. It is a safety net for the staged refactor, not a
specification of desired behaviour.

Every claim below is backed by an executable test. Run them with:

```bash
cd server
npm test
```

Tests that assert known defects are annotated `BUG` or `QUIRK` inline and in the
suites.

> **Stage 1 applied.** Every route now requires a bearer token, identity is taken
> from the verified token, and ownership is enforced on jobs and applications.
> See §2 and the "Stage 1" notes below. Remaining defects are marked for
> Stages 3-7.

---

## 1. Architecture as it stands

All four routers have been split, and all four resources now have a service
layer (Stages 3A/3B/3C/3D). Every route file is definitions and middleware only,
and all four controllers are HTTP-only. Repositories arrived in Stages
4A/4B/4C/4D and cover the `jobs`, `applications`, `tasks` and `users`
collections, and 4E added an Auth gateway for the two Firebase Auth mutations;
`middleware/auth.js` still verifies tokens itself:

| File | Lines | Notes |
|---|---|---|
| `repositories/jobRepository.js` | 103 | **New in Stage 4A** — all `jobs` Firestore I/O reached from jobService; raw snapshots, no business logic, no transactions |
| `services/jobService.js` | 311 | Firestore I/O moved out in 4A: now validation, document shaping and error classes only; 5D left the `negotiable` write path untouched; 5E removed the hardcoded `proposal: 0` counter |
| `controllers/jobController.js` | 232 | HTTP only since 3A: reads req, calls one service function, maps errors to status codes |
| `routes/jobs.js` | 29 | Route definitions + middleware only; still defines `GET /:jobId` twice |
| `repositories/userRepository.js` | 92 | **New in Stage 4D** — `users` Firestore I/O reached from userService; raw snapshots, no business logic, no transactions; Firebase Auth stays in the service for 4E |
| `services/userService.js` | 366 | `users` I/O moved out in 4D: keeps validation, `ALLOWED_PROFILE_FIELDS`, phone formatting, both document shapes, the exists/alreadyExists branches, the error class and the Auth/Firestore ordering; 5C added `PUBLIC_PROFILE_FIELDS` and the cross-user projection; 5F made `profileComplete` the only completion field |
| `repositories/authRepository.js` | 54 | **New in Stage 4E** — gateway for the two live `admin.auth().updateUser` calls (userService only); no `verifyIdToken`, no business logic, no error handling |
| `controllers/userController.js` | 220 | HTTP only since 3D: identity from `req.user`, one service call per handler, existing error bodies; 5C passes the caller uid to `getUser` |
| `routes/users.js` | 27 | Route definitions + middleware only; still defines the dead `GET /` stub; 5C left `/getUser` on `protect` alone and scoped the response instead |
| `repositories/applicationRepository.js` | 120 | **New in Stage 4B**, + `listAllApplications` in 5B — `applications` Firestore I/O reached from applicationService; raw snapshots, no business logic, no transactions; 5E left it a single-collection layer |
| `services/applicationService.js` | 365 | `applications` I/O moved out in 4B: keeps validation, the negotiable price branches, error classes, the per-record job join and the `tasks` add; 5B added `countApplicationsByJob`; 5D added `isNegotiableJob`; 5E removed the `proposals` arithmetic and the withdrawal counter write |
| `controllers/applicationController.js` | 238 | HTTP only since 3B: identity from `req.user`, one service call per handler, existing error bodies; 5B added the count handler |
| `routes/applications.js` | 42 | Route definitions + middleware only; contains a duplicate task endpoint; `/job/:jobId` owner-guarded and `/counts` added in 5B |
| `services/taskService.js` | 79 | `tasks` I/O moved out in 4C: keeps validation, the raw-Date payload, the error class and the `{ taskId }` return value |
| `repositories/taskRepository.js` | 45 | **New in Stage 4C** — the single `tasks` Firestore write reached from taskService; no business logic, no transactions |
| `controllers/taskController.js` | 73 | HTTP only since 3C: passes `req.body` to the service, maps failure to 400/500 |
| `routes/tasks.js` | 9 | Route definitions + middleware only |
| `routes/index.js` | 13 | Generator stub |
| `middleware/auth.js` | 192 | **New in Stage 1** — auth + authorization guards; reads `jobs`/`applications` through the repositories since 4F, still verifying tokens itself |
| `config/firebase.js` | 12 | `admin.initializeApp` at import time |
| `app.js` | 51 | Middleware + router mounting |

Neither `jobs` nor `applications` is yet served exclusively by its repository.
Two out-of-scope call sites still reach `jobs` directly and are scheduled for
later repository stages: `applicationService.applyToJob`
(`services/applicationService.js:131`), the per-application job read in
`listApplicationsForEmployee` (`:181`). Stage 5E removed the third one — the
counter decrement in `withdrawApplication` — so that handler no longer touches
`jobs` at all. Since 4F the middleware reads go through the repositories
too — `auth.loadJob` uses `jobRepository.getJobById`
(`middleware/auth.js:59`), `auth.loadApplication` uses
`applicationRepository.getApplicationById` (`:91`), and the
applications-by-`jobId` query in `auth.requireTaskAssignment` uses
`applicationRepository.listApplicationsByJob` (`:166`). The `exists` checks, the
`postedBy`/`employeeId` comparisons and every status code and message stay in
the guards.
`tasks` is not yet served exclusively by its repository either: the duplicate
POST /applications/tasks endpoint still issues its own add in
`applicationService.createTaskFromApplication` (`services/applicationService.js:341`),
left in place in 4C because it is another service and is scheduled for Stage 7.
`users` is now served exclusively by its repository: the only other mention of
that collection in server code is a commented-out read in
`controllers/userController.js:129`, which is dead code and was left alone in 4D.
Firebase Auth is split between the two: userService's two `updateUser` mutations
go through `repositories/authRepository.js` since 4E, while `verifyIdToken` stays
in `middleware/auth.js` (`protect`, `:35`) because it is token verification whose
only caller also owns the `Bearer` parsing and the two plain-text 401 responses.

Collections: `users`, `jobs`, `applications`, `tasks`, `interviews` (Stage 7C). No
transactions, no schema validation, no centralized error handling (Stage 6).

---

## 2. Authentication and authorization (Stage 1)

`middleware/auth.js` exports:

| Export | Purpose |
|---|---|
| `protect` | Verifies the bearer token, populates `req.user` |
| `requireSelfParam(param)` | Path parameter must equal `req.user.uid` |
| `requireJobOwner` | `job.postedBy === req.user.uid`; attaches `req.job` |
| `requireApplicationOwner` | `application.employeeId === req.user.uid` |
| `requireApplicationReviewer` | Employer who posted the application\'s job |
| `requireTaskAssignment` | Employer owns the job **and** assignee applied to it |
| `requireInterviewAuthor` | Stage 7C — employer who posted the body's `applicationId`'s job; `POST /interviews` |
| `requireInterviewOwner` | Stage 7C — employer who posted the interview's job; `PUT /interviews/:interviewId` |
| `requireInterviewParty` | Stage 7C — the application's employee **or** the owner of its job; the shared application read |
| `JOB_INTERVIEWS_FORBIDDEN` | Stage 7C — read-accurate 403 wording for `GET /interviews/job/:jobId` |

`protect` responds `401 Unauthorized` (no/invalid `Bearer` header) and
`401 Invalid token` (token fails verification), both as plain text. The resource
guards respond `404` when the resource does not exist and `403` when the caller
is not permitted.

**All 28 route registrations require authentication** — every `router.*` call in
`routes/` lists `protect` as its first middleware. The sweep in
`test/security.test.js` probes 20 of them with both a missing and an invalid token
(`ENDPOINTS`, which now includes the four Stage 7C routes), and `test/users.test.js`
covers the two `POST /users/register*` routes. Identity is always
derived from `req.user.uid`; `postedBy` and `employeeId` supplied in a request
body are ignored.

| Method | Path | Additional guard |
|---|---|---|
| GET | `/` | none (stub) |
| GET | `/users/` | none (stub) |
| POST | `/users/register` | none (self-service) |
| POST | `/users/register-profile` | none (writes only to `req.user.uid`) |
| GET | `/users/getUser/:userId` | none on the route; response scoped by caller in userService (Stage 5C) |
| PUT | `/users/update/:uid` | `requireSelfParam('uid')` + field allow-list |
| GET | `/jobs` | none |
| POST | `/jobs/create` | none — `postedBy` forced to `req.user.uid` |
| GET | `/jobs/employer/:uid` | `requireSelfParam('uid')` |
| GET | `/jobs/:jobId` | none (registered twice; see below) |
| PUT | `/jobs/edit/:jobId` | `requireJobOwner` |
| DELETE | `/jobs/:jobId` | `requireJobOwner` |
| PUT | `/jobs/:jobId/status` | `requireJobOwner` |
| POST | `/applications/apply` | none — `employeeId` forced to `req.user.uid` |
| GET | `/applications/employee/:uid` | `requireSelfParam('uid')` |
| GET | `/applications/job/:jobId` | `requireJobOwner` (Stage 5B) |
| GET | `/applications/counts` | none (Stage 5B) |
| PUT | `/applications/:id/status` | `requireApplicationReviewer` |
| DELETE | `/applications/:applicationId` | `requireApplicationOwner` |
| POST | `/applications/tasks` | `requireTaskAssignment` |
| POST | `/tasks` | `requireTaskAssignment` |
| POST | `/interviews` | `requireInterviewAuthor` (Stage 7C) |
| PUT | `/interviews/:interviewId` | `requireInterviewOwner` (Stage 7C) |
| GET | `/interviews/job/:jobId` | `requireJobOwner` (Stage 7C) |
| GET | `/interviews/application/:applicationId` | `requireInterviewParty` (Stage 7C) |

### Closed — applicant list exposure (Stage 5B)

`GET /applications/job/:jobId` returned every applicant's identity to **any**
authenticated user. It is now owner-scoped by the existing `requireJobOwner`
guard, so only `job.postedBy` may read it, and `ViewJobApplications.jsx` is the
one legitimate consumer. The dashboards no longer depend on it: `GET
/applications/counts` returns `{ counts: { jobId: number } }` for every job from
a single read, so a count is never obtained by downloading an applicant roster.

### Known gap — Firestore reads inside middleware

The authorization guards read Firestore directly. This is deliberate for Stage 1
and is marked for replacement in Stage 4, once repositories exist.

---

## 3. `/users`

### `GET /users`
- Auth: none. Returns `200` with the plain-text body `responds with a resource`.
- **DEAD CODE** — Express generator stub, never called by the client.

### `POST /users/register` — token required
- `401` text `Unauthorized` when the `Authorization` header is missing or does
  not start with `Bearer `.
- `401` text `Invalid token` when `verifyIdToken` throws.
- `200` text `User registered successfully` on first call; creates the Firestore
  document at `users/{uid}` and updates the Auth record (`displayName`,
  `phoneNumber`).
- `200` text `User already registered` if the document already exists.
- `500` text `Error registering user` if the Auth user does not exist —
  `admin.auth().updateUser` throws. Reachable with a valid token for a deleted
  user.
- **Stage 5F** — **`profileComplete` is no longer a body field.** It used to be
  destructured from the request and written verbatim, which made the flag
  client-authoritative: a caller could post `profileComplete: true` and skip
  onboarding permanently. Registration now always writes `profileComplete: false`
  — a new account has by definition not completed a profile. Sending the field is
  harmless and is ignored, not rejected; the response, status codes and the other
  written fields (`role`, `createdAt`) are unchanged. `SignUp.jsx` still sends
  `profileComplete: false` and `VerifyEmail.jsx` still forwards it, which is
  redundant but consistent with the new contract.

**QUIRK** — `fullName` is written only to Firebase Auth, never to Firestore, so
`users/{uid}` has no name field. The client reads `fullName` from
`GET /users/getUser/:uid` and receives `undefined`.

Phone numbers are normalised to Nigerian E.164 by a copy of the client's
`formatPhoneNumber` (`userService.js:83`):

| Input | Output |
|---|---|
| `08012345678` | `+2348012345678` |
| `8012345678` | `+2348012345678` |
| `2348012345678` | `+2348012345678` |
| `+2348012345678` | `+2348012345678` |
| `not-a-number` | `not-a-number` |
| absent | absent (null guard; the client copy lacks this) |

### `POST /users/register-profile` — token required
- `200` text `✅ Profile saved!`. Merge-writes `email`, `uid`, `fullName`,
  `phone`, `location`, `serviceType`, `bio`, `profileComplete: true`,
  `updatedAt`. Existing fields such as `role` are preserved.
- **Stage 5F** — this used to write `isProfileComplete: true`, a name nothing in
  the codebase reads. Every consumer (`EmployeeDashboard.jsx`,
  `EmployerDashboard.jsx`, `yo.jsx`) reads `profileComplete`, so a profile
  completed through this endpoint left the account still `false` and the user
  bounced back to `/complete-profile` with no way out. `profileComplete` is now
  the one field written. `isProfileComplete` is not deleted from documents that
  already carry it — no migration, no cleanup job; the stale key is simply inert.
  Note that no client calls this endpoint: `completeProfile.jsx` completes a
  profile through `PUT /users/update/:uid`, which was already correct.

### `GET /users/getUser/:userId`
- `200` `{ user: {...} }`, `404` text `User not found`.
- **Stage 1** - a token is now required.
- **Stage 5C** - the route is still `protect`-only and still answers 200 for any
  authenticated caller, because `JobSplitView.jsx` needs the job poster's public
  details. What changed is the payload: `userService.getUser(userId, callerUid)`
  returns the whole document when `callerUid === userId`, and otherwise only
  `PUBLIC_PROFILE_FIELDS` — `fullName`, `profilePic`, `location`, `createdAt`,
  `rating`, `reviewCount`, `bio`, which are exactly the fields `JobSplitView.jsx`
  reads. `uid`, `email`, `phone`, `role`, `address`, `companyName`, `skills` and
  any other stored field are withheld cross-user. Fields the document does not
  have are omitted rather than sent as `undefined`.
- The `404` for an unknown uid is unchanged, so the endpoint still reveals
  whether a uid has a profile. Left as-is for this stage.

### `PUT /users/update/:uid`
- `404` `{ message: 'User not found' }` when the document is missing.
- `403` `{ message: 'Not permitted' }` when `:uid` is not the caller.
- `200` `{ message: 'Profile updated successfully' }` otherwise.
- **Stage 1** — `:uid` must equal the token's uid, and the Firestore write is
  filtered through `ALLOWED_PROFILE_FIELDS` in `users.js`, so `role`, `uid` and
  any other unknown key are ignored. This closes the mass-assignment hole.
  Documented in `test/security.test.js`.
- `profilePic` is extracted and written to Firebase Auth as `photoURL` only; it
  is deliberately excluded from the Firestore update.
- `500` `{ message: 'Internal Server Error' }` when `profilePic` is supplied but
  the Auth user is missing — the Auth update throws before Firestore is written.
- **Stage 5F** — `isProfileComplete` was removed from `ALLOWED_PROFILE_FIELDS`,
  which now holds 12 entries. The list previously carried both completion names,
  so a caller could write either one and make them disagree. It is no longer
  accepted; the canonical name is `profileComplete`, and this endpoint is the
  path `completeProfile.jsx` uses to set it to `true`.

---

## 4. `/jobs`

### `GET /jobs`
- `200` `{ jobs: [{ id, ...document }] }`, or `{ jobs: [] }` when empty.
- Unfiltered: returns every job in the collection.

### `POST /jobs/create`
- `400` `{ message: 'Missing required fields' }` when any of `title`,
  `description`, `location`, `jobType`, `applicationDeadline`, `jobStartDate`,
  `price` is missing. **`postedBy` is no longer a body field.**
- `201` `{ message: 'Job posted successfully', jobId }` otherwise.

Stored document:

| Field | Source | Default |
|---|---|---|
| `title` … `price` | request body | required |
| `negotiable` | request body, verbatim | `undefined` |
| `status` | hardcoded, never read from the body | `'open'` |
| `expectedEndDate` | request body | `null` |
| `skillsRequired` | request body | `[]` |
| `requirements` | request body | `[]` |
| `responsibilities` | request body | `[]` |
| `postedBy` | **`req.user.uid`** (Stage 1) | — |
| `createdAt` | `new Date().toISOString()` | — |

**Stage 5E** — the response no longer contains a `proposal` field. It used to be
written as a hardcoded `0` that nothing incremented and no consumer read. No
replacement field is written: the applicant count is derived from the
`applications` collection and served by `GET /applications/counts`.

**QUIRK** — `price` is stored verbatim with no coercion. The client sends a
string from `<input type="number">`, so jobs created through the UI hold
`price: "15000"` while jobs created through `PUT /jobs/edit/:jobId` hold a
number.

**QUIRK** — `price: 0` is rejected by the truthiness check `!price`, while
`price: "0"` is accepted. `PUT /jobs/edit/:jobId` uses `price === undefined` and
therefore accepts `0`. The two validators disagree.

**QUIRK** — `negotiable` is stored as the raw string `"yes"` / `"no"` and is
never coerced to boolean. See §6.

### `GET /jobs/employer/:uid`
- `200` `{ jobs: [...] }` filtered by `postedBy == uid`; `{ jobs: [] }` when
  none. Logs the result to stdout.
- **Stage 1** — `requireSelfParam('uid')`: `403` unless `:uid` is the caller.

### `GET /jobs/:jobId`
- `200` `{ job: <raw document> }`, `404` `{ message: 'Job not found' }`.
- The response does **not** include `id`, and does **not** default
  `skillsRequired`, `requirements` or `responsibilities` to `[]`.

**BUG** — this path is registered twice, in `routes/jobs.js:14` and
`routes/jobs.js:22`. Express matches in registration order, so
`jobController.getJob` always wins and `jobController.getJobWithDefaults` is
unreachable dead code. The dead handler is the one that adds `id` and the array
defaults. `client/src/pages/JobDetails.jsx:218,235,251` calls `.map()` on those
three fields with no guard, so any job document predating those fields crashes
that page. Both registrations are protected (Stage 1); removal is deferred to
Stage 7.

### `PUT /jobs/edit/:jobId`
- `400` `{ message: 'Required fields are missing.' }` when any of `title`,
  `description`, `location`, `jobType`, `applicationDeadline`, `jobStartDate`
  is missing or `price` is `undefined`.
- `404` `{ message: 'Job not found' }`, `403`
  `{ message: 'Not permitted' }`, `200`
  `{ message: 'Job updated successfully', updatedFields: [...] }`.
- `price` is coerced with `parseFloat`. `updatedAt` is set to
  `new Date().toISOString()`.
- `expectedEndDate`, `skillsRequired`, `requirements` and `responsibilities` are
  only written when truthy (arrays must also pass `Array.isArray`), so a `null`
  `expectedEndDate` cannot clear the field and a non-array value is silently
  ignored while the previous value survives.
- **Stage 1** — `requireJobOwner`: only the employer whose uid is `postedBy`
  may edit the job. Previously any caller could edit any job.

### `DELETE /jobs/:jobId`
- `200` `{ message: 'Job deleted successfully' }`, `404` otherwise, `403` for a
  non-owner.
- **Stage 1** — `requireJobOwner` replaces the previous absent check.

### `PUT /jobs/:jobId/status`
- `200` `{ message: 'Job status updated' }`, `403` for a non-owner.
- **Stage 1 behaviour change** — a missing job now returns `404`
  `{ message: 'Job not found' }` from the `requireJobOwner` guard, instead of the
  `500` `{ message: 'Failed to update job status' }` produced by the handler's
  missing existence check.
- **Stage 5G** — the value is checked against the canonical set
  `open` / `filled` / `closed`. Anything else returns `400`
  `{ message: 'Invalid status. Must be one of: open, filled, closed.' }` via the
  existing `JobValidationError` path, and leaves the stored value untouched.
  This includes `banana`, `paused` (a dashboard filter with no writer), the
  title-cased legacy `Filled`, and an absent or `undefined` value — an absent
  status used to overwrite the field with `undefined`. There is no transition
  matrix: any canonical value may be written from any state, repeatedly.
  Existing documents holding legacy `Filled` are read and displayed as filled;
  they are not migrated or backfilled.

---

## 5. `/applications`

### `POST /applications/apply`
- `400` `{ message: 'Missing required fields' }` without `jobId`.
  **`employeeId` is no longer a body field.**
- `404` `{ message: 'Job not found' }` when the job does not exist.
- `200` `{ message: 'Application submitted successfully' }` otherwise.

Stored document: `jobId`, `fullName`, `message` (default `''`), `employeePrice`
(see below), `dateApplied` (a `serverTimestamp()` Timestamp since Stage 5H), `status`
hardcoded to `'pending'`.

- A `status` supplied by the caller is ignored.
- **Stage 5G** — the client no longer sends `status` at all
  (`JobDetails.jsx`). It was already discarded; the send only implied a write
  that never happened.
- **Stage 1** — `employeeId` is taken from `req.user.uid`, so an application can
  no longer be filed on another user's behalf.

**FIXED (Stage 5D)** — The negotiable logic was dead. `jobs.js` wrote `negotiable`
while this handler read `jobData.isNegotiable`, a field no write path has ever
persisted. `negotiable` is now the single canonical name and the value is still
the string `"yes"`/`"no"`, read through a boolean helper:

- `employeePrice` is persisted when the job is negotiable.
- The `employeePrice <= 0` validation now runs.
- A price sent to a fixed-price job is now **rejected with 400** rather than
  silently discarded. This is a deliberate behaviour change: the rejection was
  written for a boolean field and was unreachable. `JobDetails.jsx` sends
  `employeePrice: null` for non-negotiable jobs, so no client path hits it.
- `"no"` is truthy as a string, so the comparison must be explicit; the helper
  treats anything other than `"yes"`/`true` as not negotiable. A document with no
  `negotiable` field is therefore served at its fixed price. No migration.

**FIXED (Stage 5E)** — The stored `proposals` field is gone. This used to be
`const proposals = proposal - 1` from a client-supplied `proposal`. Because the
client sent `proposal: job.proposals` and no such field exists on a job, the
normal path stored `NaN`; a supplied value stored a client-chosen number. No code
ever read the field, so the arithmetic, the input and the write were all removed
rather than corrected. A `proposal` sent to this endpoint is now ignored. The
parent job is not written at all. Applicant counts are derived from the
`applications` collection via `GET /applications/counts`. Existing documents that
still carry `proposals` are left untouched — no migration.

### `GET /applications/employee/:uid`
- `200` `{ applications: [{ id, ...application, job }] }`.
- `job` is `null` when the referenced job no longer exists.
- **N+1** — issues one sequential Firestore read per application
  (asserted in `test/applications.test.js`).
- **Stage 1** — `requireSelfParam('uid')`: `403` unless `:uid` is the caller.

### `GET /applications/job/:jobId`
- `200` `{ applications: [...] }`, empty array when none.
- **Stage 1** — a token is required.
- **Stage 5B** — the list is now owner-scoped by `requireJobOwner`: `403` unless
  `job.postedBy === req.user.uid`, and `404 { message: 'Job not found' }` for a
  missing job (the guard's own 404, where the endpoint previously returned an
  empty array). The owner response body is unchanged. The `403` text is the
  shared guard's ("...modify this job"), reworded only if that guard's wording
  is ever changed for its other three routes.

### `GET /applications/counts`
- `200` `{ counts: { <jobId>: <number> } }`. Jobs with no applications are absent
  rather than `0`; callers default to `0`.
- **Stage 5B** — count-only read. Carries no application document and no
  applicant field. Replaces the dashboards' per-job calls to the endpoint above,
  which existed solely to read `.length`.
- Failure body is `{ error }`, matching `GET /applications/job/:jobId`.

### `PUT /applications/:id/status`
- `400` `{ message: 'Status is required' }` without `status`.
- `200` `{ message: 'Status updated successfully' }`.
- **Stage 1 behaviour change** — `requireApplicationReviewer` loads the
  application and its job first, so a missing application returns `404`
  `{ message: 'Application not found' }` with no `error` field. Previously this
  returned `500` `{ message: 'Failed to update status', error: '<raw error text>' }`,
  leaking internal error text. Only the employer who posted the job may review.
- **Stage 5G** — the value is checked against the canonical set `pending` /
  `accepted` / `rejected`. Any other value returns `400`
  `{ message: 'Invalid status. Must be one of: pending, accepted, rejected.' }`
  through the existing `ApplicationValidationError` path and leaves the stored
  value untouched. A missing status keeps its original
  `{ message: 'Status is required' }` message. There is no transition matrix:
  any canonical value may be written from any state, repeatedly. The title-cased
  legacy values `Employed` and `Not Hired` — which the client used to write and
  which remain in existing documents — are read and displayed as `accepted` and
  `rejected` but are no longer accepted on write. Nothing is migrated or
  backfilled.

### `DELETE /applications/:applicationId`
- `404` `{ message: 'Application not found' }`, `403` for a non-applicant, `200`
  `{ message: 'Application withdrawn successfully' }`.
- **Stage 1** — `requireApplicationOwner`: only the applicant may withdraw their
  own application.
- **FIXED (Stage 5E)** — the parent-job counter write is gone. It decremented
  `proposals` (plural) while `/jobs/create` initialised `proposal` (singular),
  so a job ended up holding `proposal: 3` next to a fresh `proposals: -1` and
  went further negative with every withdrawal. Nothing read either field.
- **FIXED (Stage 5E)** — the non-atomic pair of writes is gone. The handler now
  performs exactly one write, the delete, so the "decrement succeeded, delete
  failed" and "decrement failed, application orphaned" cases no longer exist.
  Status codes, error shapes and the ordering of the authorisation read before
  the delete are unchanged; no transaction was introduced.

### `POST /applications/tasks`
- `400` `{ message: 'Missing required fields' }` when any of `jobId`,
  `employeeId`, `taskName`, `taskDescription`, `dueDate` is missing.
- `404` `{ message: 'Job not found' }`, `403` when the caller does not own the
  job or the assignee never applied to it.
- `200` `{ message: 'Task created successfully' }` otherwise.
- **Stage 1 behaviour change** — this duplicate previously accepted an empty body
  and created an empty task document. It now shares `requireTaskAssignment` with
  `POST /tasks` and rejects the same way.
- **DEAD CODE** — an exact duplicate of `POST /tasks`, never called by the
  client. Removal is deferred to Stage 7.

---

## 6. `/tasks`

### `POST /tasks`
- `400` `{ message: 'Missing required fields' }` when any of `jobId`,
  `employeeId`, `taskName`, `taskDescription`, `dueDate` is missing.
- `404` `{ message: 'Job not found' }` when the job does not exist.
- `403` `{ message: 'Not permitted' }` when the caller does not own the job, or
  the assignee has no application for it.
- `200` `{ message: 'Task created successfully', taskId }` otherwise.
- **Stage 5H** — `createdDate` is now a `serverTimestamp()` Timestamp. It was a
  raw `Date`, which took its value from the Node process clock; Firestore turned
  it into a Timestamp either way, so the stored type, the field name and the API
  shape are unchanged — only the clock that decides the value.
- **Stage 1** — `requireTaskAssignment` replaces the previous absence of any
  check. Note the guard queries applications by `jobId` alone and compares
  `employeeId` in memory, to avoid requiring a composite Firestore index.

### `POST /tasks` with a malformed body
- `400` with `Content-Type: text/html`. `express.json()` throws before the
  handler runs, and the global error handler renders a Jade page — so an HTML
  body is returned to clients expecting JSON.

---

## 7. `/interviews` (Stage 7C)

An interview belongs to an application: it records that the employer who posted the
job has arranged to speak to the applicant. It is **not** a new application state —
Stage 7C adds no application status and does not touch `APPLICATION_STATUSES`, so
scheduling an interview leaves the application exactly as it was.

```
interviews/{autoId}
  applicationId, jobId, employerId, employeeId,
  scheduledAt, duration?, type, meetingLink?, location?,
  status, createdAt (Timestamp), updatedAt (Timestamp)
```

- `type` is `online` or `in_person`; `status` is `scheduled` (the only value a
  create writes) / `completed` / `cancelled` / `no_show`.
- `employerId` comes from the verified token and `employeeId` from the application
  document. Neither is ever read from the request body.
- `duration` is minutes, as a positive number. `duration`, `meetingLink` and
  `location` are absent from the document when not supplied, and accept an explicit
  JSON `null` on update to clear.
- `createdAt` / `updatedAt` are `serverTimestamp()` Timestamps (Stage 5H direction).
  Every update rewrites `updatedAt`; `createdAt` is never touched.
- A blank required field returns `400` `'Missing required fields'`; an unparseable
  `scheduledAt`, a non-positive `duration` or an out-of-list `type` returns `400`
  naming the field.

### `POST /interviews`
- Body: `applicationId`, `jobId`, `scheduledAt`, `type` required; `duration`,
  `meetingLink`, `location` optional.
- `200` `{ message: 'Interview created successfully', interviewId }`.
- `400` `{ message: 'Missing required fields' }`, or
  `400` `{ message: "Interview jobId does not match the application's jobId" }`.
- `404` `{ message: 'Application not found' }` / `{ message: 'Job not found' }`.
- `403` `{ message: 'You do not have permission to create interviews for this job' }`.
- **Never creates an employment.** Employment remains created only by the hire
  (`PUT /applications/:id/status` with `accepted`), so no number of interviews can
  produce one.

### `PUT /interviews/:interviewId`
- Partial update: only the fields present in the body change. Updatable:
  `scheduledAt`, `duration`, `type`, `meetingLink`, `location`, `status`.
- `200` `{ message: 'Interview updated successfully' }`. No endpoint in this API
  returns the updated document.
- `400` `{ message: 'Missing fields to update' }` when the body names no updatable
  field; `400` naming the field for an invalid value.
- `404` `{ message: 'Interview not found' }`,
  `403` `{ message: 'You do not have permission to modify this interview' }`.
- `employeeId`, `jobId`, `applicationId`, `employerId` and `createdAt` are NOT
  updatable and are dropped from the body; `status` is.

### `GET /interviews/job/:jobId`
- `200` `{ interviews: [...] }`, every interview on the job across all applicants.
- `403` `{ message: 'You do not have permission to view interviews for this job' }`,
  `404` for a missing job, empty list rather than `404` when none exist.

### `GET /interviews/application/:applicationId`
- `200` `{ interviews: [...] }`. The shared read: the applicant whose recruitment it
  is **and** the employer who owns the job both reach this route.
- `403` `{ message: 'You do not have permission to view interviews for this application' }`,
  `404` for a missing application, empty list rather than `404` when none exist.

### Authorization
- `requireInterviewAuthor` (create), `requireInterviewOwner` (update) and
  `requireInterviewParty` (application read) are new exports of
  `middleware/auth.js`; `GET /interviews/job/:jobId` reuses the existing
  `requireJobOwner` with the new `JOB_INTERVIEWS_FORBIDDEN` wording.
- **Writes are employer-only.** The applicant may read the interviews on their own
  application but is refused every attempt to create or change one, with a 403 from
  the guard and no interview data in the body.
- **Reads are party-scoped.** Authorization resolves `interview` → `application` →
  `job` → `job.postedBy`, never the interview's own stored `employerId`: a stored
  value is not an authority.
- Reads are deliberately unreshaped — `{ id, ...document }`, no field renamed,
  dropped or normalised.

### Known gaps, deliberately not closed in Stage 7C
- An `in_person` interview may be created with no `location` and an `online` one
  with no `meetingLink`; both are optional in this stage's schema.
- `INTERVIEW_STATUSES` is an allow-list, not a transition matrix (the Stage 5G
  choice), so a completed interview may be marked cancelled and vice versa.
- No `DELETE`: cancelling is a status, which is how an interview leaves the
  schedule without losing the record of it.

---

## 8. Cross-cutting defects

Resolved by Stage 1 are struck through; the remainder are scheduled for
Stages 2-7.

| Area | Defect | Location | Stage |
|---|---|---|---|
| ~~Auth~~ | ~~17 of 19 routes unauthenticated~~ | `middleware/auth.js` | **1 — done** |
| ~~Auth~~ | ~~Identity trusted from body/URL, not token~~ | `routes/jobs.js:8`, `routes/applications.js:13`, `routes/users.js:16` | **1 — done** |
| ~~Auth~~ | ~~Mass assignment on user update~~ | `userService.js:207` | **1 — done** |
| Auth | Applicant identities readable by any authenticated user | `routes/applications.js:20` | 5 |
| Auth | Firestore reads inside middleware (no repository) | `middleware/auth.js` | 4 || Auth | Client sends a token on only 2 of 31 call sites | `client/src` | 8 |
| Routing | `GET /:jobId` registered twice; second copy dead | `routes/jobs.js:14`, `routes/jobs.js:22` | 7 |
| Domain | ~~`negotiable` written, `isNegotiable` read~~ | `jobService.js:111` vs `applicationService.js:101` | **5D - done** |
| Domain | ~~`proposal` vs `proposals` vs client-side `applicantCount`~~ | `jobService.js` vs `applicationService.js` | **5E - done** |
| Domain | ~~Count never incremented~~ | `applicationService.js` | **5E - done** |
| Domain | ~~`NaN` persisted on every application~~ | `applicationService.js` | **5E - done** |
| Domain | ~~Two profile-completion fields; `isProfileComplete` written, never read~~ | `userService.js` | **5F - done** |
| Domain | ~~`profileComplete` client-supplied at registration~~ | `userService.js` | **5F - done** |
| Domain | ~~Unvalidated `status` values on jobs and applications~~ | `jobService.js`, `applicationService.js` | **5G - done** |
| Domain | ~~`paused` job status offered in UI with no writer~~ | `EmployerDashboard.jsx` | **5G - done** |
| Domain | ~~Body `status` overrode the created job's status~~ | `jobService.js` | **5G - done** |
| Consistency | ~~Delete decrement not transactional~~ | `applicationService.js` | **5E - done** |
| Performance | N+1 job reads per application | `applicationService.js:201` | 4 |
| Errors | Four response shapes; Jade HTML error handler | `app.js:41` | 6 |
| Errors | Raw internal error text leaked | `applicationController.js:182` | **1 — done** |
| Dead code | `GET /users`, `GET /` stubs | `routes/users.js:8`, `index.js:6` | 7 |
| Dead code | `POST /applications/tasks` | `routes/applications.js:39` | 7 |
| Dead code | Commented-out `/profile` route | `userController.js:122` | 7 |
| Dead code | Jade views + `express.static` | `app.js:19,20,27` | 7 |
| Debug | `console.log` in controllers/services | `jobService.js:134,142`, `applicationService.js:199,284`, `applicationController.js:181` | 2 |
| Debug | Full user document logged | `userService.js:172` | 2 |
| Types | `price` stored as string on create, number on edit | `jobService.js:110` vs `jobService.js:248` | 3 |
| ~~Timestamps~~ | ~~`new Date()` in jobs/tasks, `serverTimestamp()` in users~~ | `jobService.js:117` vs `userService.js:145` | **5H - partial: tasks/applications moved, jobs left on ISO strings** |
| Duplication | `formatPhoneNumber` copied client → server | `userService.js:83` | 5 |
| Duplication | Required-field lists in 4 places | `jobService.js:78,213`, two client forms | 5 |

---

## 9. Firestore schema as actually stored

```
users/{uid}
  role, profileComplete (always false), createdAt   # /register
  email, uid, fullName, phone, location,
  serviceType, bio, profileComplete (true),
  updatedAt                                 # /register-profile (merged)
  <ALLOWED_PROFILE_FIELDS only>             # /update/:uid (Stage 1 allow-list)
  # Stage 5F: profileComplete is the only completion field. A document written
  # before it may still carry isProfileComplete; it is never read, never
  # written and never deleted.

jobs/{autoId}
  title, description, location, jobType,
  applicationDeadline, jobStartDate,
  expectedEndDate, price, negotiable,
  status, postedBy (= token uid),
  skillsRequired[], requirements[], responsibilities[],
  createdAt, updatedAt
  # Stage 5E: no proposal / proposals / applicantCount. The applicant
  # count is derived from `applications`, not stored.

applications/{autoId}
  jobId, employeeId (= token uid), fullName, message,
  employeePrice (null unless the job is negotiable),
  dateApplied (Timestamp), status ('pending')
  # Stage 5E: no proposals field. Legacy documents may still carry one.
  # Stage 5H: dateApplied is a serverTimestamp() Timestamp, not a process-clock
  # Date. Serialized as {"_seconds","_nanoseconds"}.

tasks/{autoId}
  jobId, employeeId, taskName, taskDescription,
  dueDate, createdDate (Timestamp since Stage 5H)

interviews/{autoId}
  applicationId, jobId, employerId (= token uid),
  employeeId (from the application, never from the body),
  scheduledAt, type ('online' | 'in_person'), status ('scheduled'),
  createdAt (Timestamp), updatedAt (Timestamp)
  # Stage 7C: duration, meetingLink and location are absent unless supplied, and
  # may be cleared with an explicit null on update. status is written as
  # 'scheduled' by a create and changed only through PUT /interviews/:interviewId,
  # which also reschedules and corrects details. applicationId, jobId, employerId,
  # employeeId and createdAt are not updatable. No interview write touches the
  # application, and none creates an employment.
```
