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
`tasks` is now served exclusively by its repository. The duplicate
POST /applications/tasks endpoint used to issue its own add in
`applicationService.createTaskFromApplication`; Stage 9F deleted that route, its
handler and that service function, so `repositories/taskRepository.js` is the only
thing that writes `tasks`.
`users` is now served exclusively by its repository: the only other mention of
that collection in server code is a commented-out read in
`controllers/userController.js:129`, which is dead code and was left alone in 4D.
Firebase Auth is split between the two: userService's two `updateUser` mutations
go through `repositories/authRepository.js` since 4E, while `verifyIdToken` stays
in `middleware/auth.js` (`protect`, `:35`) because it is token verification whose
only caller also owns the `Bearer` parsing and the two plain-text 401 responses.

Collections: `users`, `jobs`, `applications`, `tasks`, `employments` (Stage 7A),
`interviews` (Stage 7C), `conversations` and `messages` (Stage 8B). No transactions, no
schema validation, no centralized error handling (Stage 6).

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
| `requireInterviewRespondent` | Stage 10A — the application\'s employee only; `PUT /interviews/:interviewId/response` |
| `requireEmploymentParty` | Stage 10H.1 — the employment\'s own `employerId` **or** `employeeId`; `GET /employments/:employmentId` |
| `JOB_INTERVIEWS_FORBIDDEN` | Stage 7C — read-accurate 403 wording for `GET /interviews/job/:jobId` |
| `JOB_EMPLOYMENTS_FORBIDDEN` | Stage 10H.1 — read-accurate 403 wording for `GET /employments/job/:jobId` |

`protect` responds `401 Unauthorized` (no/invalid `Bearer` header) and
`401 Invalid token` (token fails verification), both as plain text. The resource
guards respond `404` when the resource does not exist and `403` when the caller
is not permitted.

**All 42 route registrations require authentication** — every `router.*` call in
`routes/` lists `protect` as its first middleware. The sweep in
`test/security.test.js` probes 32 of them with both a missing and an invalid token
(`ENDPOINTS`, which now includes the two Stage 10H.1 employment reads), and
`test/users.test.js` covers the two `POST /users/register*` routes. Identity is always
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
| POST | `/users/profile-photo/signature` | `protect` only; uid taken from the token, not the request |
| POST | `/users/resume/signature` | `protect` only; upload folder taken from the token, not the request (Stage 12.12) |
| GET | `/users/resume/download` | `protect` only; reads the caller's own stored resume, never a request id (Stage 12.12.1) |
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
| GET | `/applications/:applicationId/resume/download` | `protect` + `requireResumeAccess` — applicant or job owner (Stage 12.12.1) |
| POST | `/tasks` | `requireTaskAssignment` |
| POST | `/tasks/:taskId/upload-signature` | `protect` + `requireTaskParty({ mutation: true, role: 'employee' })` (Stage 10G.1) |
| GET | `/tasks/employee/:uid` | `requireSelfParam('uid')` (Stage 6B) |
| GET | `/tasks/job/:jobId` | `requireJobOwner` (Stage 6B) |
| GET | `/employments/employee/:uid` | `requireSelfParam('uid')` (Stage 7A) |
| GET | `/employments/employer/:uid` | `requireSelfParam('uid')` (Stage 7A) |
| GET | `/employments/job/:jobId` | `requireJobOwner(JOB_EMPLOYMENTS_FORBIDDEN)` (Stage 10H.1) |
| GET | `/employments/:employmentId` | `requireEmploymentParty` (Stage 10H.1) |
| POST | `/interviews` | `requireInterviewAuthor` (Stage 7C) |
| PUT | `/interviews/:interviewId` | `requireInterviewOwner` (Stage 7C) |
| PUT | `/interviews/:interviewId/response` | `requireInterviewRespondent` (Stage 10A) |
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
- `profilePic` is extracted and written to **both** Firebase Auth as `photoURL` and
  the Firestore document (Stage 6N). Before 6N it went to Auth only, so the
  cross-user public projection — which reads Firestore — always rendered a
  placeholder. The two writes are ordered Auth-then-Firestore and are not atomic.
- `500` `{ message: 'Internal Server Error' }` when `profilePic` is supplied but
  the Auth user is missing — the Auth update throws before Firestore is written.
- **Stage 5F** — `isProfileComplete` was removed from `ALLOWED_PROFILE_FIELDS`,
  which now holds 12 entries. The list previously carried both completion names,
  so a caller could write either one and make them disagree. It is no longer
  accepted; the canonical name is `profileComplete`, and this endpoint is the
  path `completeProfile.jsx` uses to set it to `true`.

### `POST /users/profile-photo/signature`
- Any authenticated user (no role restriction). `protect` only; there is no `:uid`
  in the path and no body, because the uid — the only identity the signature needs —
  is taken from the verified token. The signed folder is `profilePics/{uid}`, so a
  caller can only ever sign an upload into their own account.
- `200` `{ cloudName, apiKey, timestamp, signature, folder, publicId, resourceType,
  allowedFormats }`. `resourceType` is `image`, `allowedFormats` is
  `'jpg,jpeg,png,webp'`, and `publicId` is `{timestamp}-{12 hex}` minted per request.
  The signature is a SHA-1 over `allowed_formats`, `folder`, `public_id` and
  `timestamp` using `CLOUDINARY_API_SECRET`, which never appears in the response, a
  log line or the signature itself. The browser posts the file and these fields
  (less `cloudName`/`resourceType`, which select the URL) straight to Cloudinary —
  `https://api.cloudinary.com/v1_1/{cloudName}/{resourceType}/upload` — so the bytes
  never pass through this API. The returned `secure_url` is then persisted as
  `profilePic` through `PUT /users/update/:uid`, unchanged.
- `503` `{ message: 'Photo uploads are not configured on this server' }` when
  `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` or `CLOUDINARY_API_SECRET` is absent
  or blank. Credentials are read lazily per request, exactly as for task-file
  signing.
- Image format is enforced twice: by the client before it requests a signature, and
  by Cloudinary (`image` resource type plus the signed `allowed_formats`). File size
  is enforced by the client and by the Cloudinary account's own upload limit; the
  signature flow has no per-request server-side size parameter.

### `POST /users/resume/signature` (Stage 12.12)
- Any authenticated user. `protect` only; the uid, and therefore the upload folder
  `resumes/{uid}`, comes from the verified token — a caller can only sign an upload
  into their own account.
- `200` `{ cloudName, apiKey, timestamp, signature, folder, publicId, resourceType,
  allowedFormats }`. `resourceType` is `raw` (a resume is an arbitrary document, not
  a renderable image), `allowedFormats` is `'pdf'`, and `publicId` is
  `{timestamp}-{12 hex}` minted per request. The signature never exposes the api
  secret. The browser posts the file straight to Cloudinary, as for profile photos.
- `503` (same wording and lazy-credential contract as the profile-photo signer) when
  Cloudinary is unconfigured.

### `GET /users/resume/download` (Stage 12.12.1)
- Any authenticated user. `protect` only, and that is deliberate: the handler reads
  the caller's **own** stored resume reference, so a `?publicId=` in the query is
  ignored — a caller cannot name another user's asset.
- `200` `{ name, url }` where `url` is a short-lived Cloudinary `private_download_url`
  for the stored `publicId`. The name is the stored display name.
- `404` when the profile carries no valid resume.
- `503` when Cloudinary is unconfigured (no URL of any kind is returned).

The profile resume is stored through `PUT /users/update/:uid` as the private
reference `{ publicId, name, resourceType: 'raw' }` (no `url`). **Stage 12.13** adds
the same write-side provenance check the application side uses: the `publicId` must
sit under `resumes/{uid}/` (with a `..` traversal guard) and must exist in
Cloudinary, or the update is a `400` (`'Resume does not belong to you'` /
`'Resume file could not be found'`) and nothing is written. An update with no resume
field makes no admin call.

---

## 4. `/jobs`

### `GET /jobs`
- `200` `{ jobs: [{ id, ...document }] }`, or `{ jobs: [] }` when empty.
- Unfiltered by default: returns every job in the collection.
- **STAGE 12.1A** optional, backward-compatible query filters, all applied in
  memory over the same full-collection read (no Firestore operator, index or
  schema change; no sorting or pagination):
  - `q` — case-insensitive substring match across `title`, `description` and
    `location` (any one field matching is enough).
  - `status` — case-insensitive exact match. Legacy title-cased `Filled` is
    found by a `status=filled` filter.
  - `jobType` — case-insensitive exact match.
  - Supplied filters combine with AND; a missing or whitespace-only parameter is
    ignored (so no parameters returns every job, including documents missing the
    optional fields).

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

**ADDED (Stage 12.11)** — Optional application materials, gated per job by the
employer's `applicationRequirements` map. A job stores
`{ resume, coverLetter, portfolio }`, each one of `not_needed` (default for resume
and portfolio), `optional` (default for cover letter) or `required`; a job with no
map is read as those defaults. The three body fields follow the level:

- `resume` — a **private reference** `{ publicId, name, resourceType: 'raw' }`.
  `required` demands it, `optional` accepts or omits it, `not_needed` forbids it.
  No `url` is accepted or stored; the file is reachable only through the signed
  download endpoint below.
- `coverLetter` — a string; `required` demands a non-empty value.
- `portfolioUrl` — a string; `required` demands it, `not_needed` forbids it.
  Anything that is not a syntactically valid URL is a `400 Invalid portfolio URL`.

Each violation is a `400 { message }` (`'Resume is required'`,
`'Cover letter is required'`, `'Portfolio URL is required'`, and the matching
"... is not required for this job" forms). The stored values are the trimmed
reference, cover-letter string and portfolio URL.

**ADDED (Stage 12.13)** — Write-side provenance check for the resume reference.
The shape above can be forged, so before the application is written the server
confirms the reference names a file the **applicant owns** and that Cloudinary
**actually holds**: the `publicId` must sit under `resumes/{employeeId}/` (with a
`..` traversal guard) and one admin API call (`cloudinary.api.resource`) must find
it. Either failure is a `400` (`'Resume does not belong to you'` /
`'Resume file could not be found'`) and nothing is written. The check runs only
when a reference is present, so an apply with no resume makes no admin call.

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
- **Stage 7A** — writing `accepted` also records the employment this hire creates
  (see §7). It happens *after* the status write has succeeded, so every failure
  path above — the 400s, the guard's 403 and 404 — leaves the `employments`
  collection untouched. The response is unchanged, and no request field was added:
  the record is assembled from the token and the two documents
  `requireApplicationReviewer` has already loaded. An application already holding
  `accepted` does not record a second employment, since the statuses are an
  allow-list rather than a transition matrix. The two writes are not in a
  transaction, so a process death between them can leave an accepted application
  with no employment; a failure of the employment write is logged and does not
  turn a completed hire into a `500`.
- **Stage 10H.2** — writing `rejected` is refused while the application has an
  **active** employment. The response is `400` through the same
  `ApplicationValidationError` path the hire gate uses, with message
  `'Cannot reject an application whose employment is still active. An employed
  applicant cannot be marked as rejected.'`; the write does not run, so the
  application and its employment are both left exactly as they were. Only `active`
  refuses the write: an employment that is `ended` (or holds a status the code
  cannot read as active) does not, and an application with no employment is
  rejected exactly as before. This is the server side of the multi-hire bug — the
  old client rejected every applicant on a hire, so a second hire marked the
  first, already employed, applicant as rejected. It qualifies the Stage 5G "any
  value from any state" note above: `rejected` now carries this one precondition.
  The check reuses `listEmploymentsByApplication`; no new collection, index or
  write is added.

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

### `GET /applications/:applicationId/resume/download` (Stage 12.12.1)
- `protect` + `requireResumeAccess`: only the applicant (`employeeId`) or the owner
  of the job the application is for (`job.postedBy`) may receive a URL. Anyone else
  gets `403`.
- `200` `{ name, url }`, where `url` is a short-lived Cloudinary
  `private_download_url` for the **stored** reference. A `?publicId=` in the query
  is ignored, so no caller can name an asset.
- `404` when the application has no resume, or the application does not exist.
- `503` when Cloudinary is unconfigured (no URL returned).

### `POST /applications/tasks` (removed, Stage 9F)
- **REMOVED** — the route, its `applicationController.createTaskFromApplication`
  handler and `applicationService.createTaskFromApplication` are deleted. This
  duplicate of `POST /tasks` never had a caller: the client has always posted to
  `POST /tasks`.
- Its contract, for the record, was `400` `{ message: 'Missing required fields' }`
  on any missing field, `404` `{ message: 'Job not found' }` or `403` from
  `requireTaskAssignment`, and `200` `{ message: 'Task created successfully' }`
  otherwise — the last being how it differed from `POST /tasks`, which also returns
  `taskId`.
- A request to the path now matches no route and answers `404` from the app's
  catch-all. `test/tasks.test.js` pins this.

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

### The task lifecycle (Stage 9C)

```
assigned ──submit(employee)──> submitted ──approve(employer)──> approved  [terminal]
                                 └──request_revision(employer)──> revision_requested
                                                                 │
                                                     submit(employee)
                                                                 │
                                                         submitted
```

The whole transition table is data — `TASK_TRANSITIONS` in `taskService` — and every
action resolves through one function, so an illegal transition is refused before
anything is written.

| From | Action | To | Also writes |
| --- | --- | --- | --- |
| `assigned` | submit | `submitted` | `submittedAt`, `submittedBody` |
| `revision_requested` | submit | `submitted` | `submittedAt`, `submittedBody` |
| `submitted` | approve | `approved` | `reviewedAt` |
| `submitted` | request revision | `revision_requested` | `revisionNote`, `reviewedAt` |

Refused, each with a `400` naming the action and the current status:

- `assigned` → approved (work cannot be approved before it is delivered)
- `assigned` → revision_requested (nothing has been submitted to send back)
- `revision_requested` → approved (the employee must submit again first)
- `approved` → anything (terminal)
- any action from a status not in `TASK_STATUSES` (reported as an unknown status)

A document written before Stage 9B has no `status` and is treated as `assigned`
everywhere, so it can be submitted and then run through the rest of the lifecycle.

Transitions write only the fields in the table. `taskName`, `taskDescription`,
`dueDate`, `jobId`, `employeeId`, `applicationId` and `employmentId` are not
reachable from them — `updateTaskFields` is a partial update, so a transition
physically cannot write them. `submittedBody` and `revisionNote` are required
non-empty strings, otherwise `400 { message: 'Missing required fields' }`.
Re-submitting after a revision **replaces** `submittedBody` and keeps
`revisionNote`.

### `GET /tasks/:taskId`
- `200` `{ task: { id, ...document } }` — the whole stored document, same terms as
  the two list endpoints. `submittedBody`, `revisionNote` and the timestamps are the
  review, so they are returned rather than projected away.
- `404` `{ message: 'Task not found' }`. Decided by the guard, before any
  authorization question, so a missing task never surfaces as the fake's
  `NOT_FOUND` written to a 500.
- Unauthorized callers get `403` with no task data in the body.

### `POST /tasks/:taskId/submit`
- Employee only. The body is decided by the task's stored `submissionType` (Stage
  10G, defaulting to `text` for a task written before it):
  - `text` → `{ submissionText }` — required, non-empty, stored as supplied.
  - `link` → `{ submissionUrl }` — required, an `http`/`https` URL.
  - `file` → `{ submissionFile }` — required, a Cloudinary reference
    `{ url, publicId, name, resourceType: 'raw' }` (Stage 10G.1). `url` and `publicId`
    must agree and `publicId` must sit under `taskSubmissions/{taskId}/`.
- `200` `{ message: 'Task submitted successfully', taskId, status }`.
- `400` on an illegal transition or a body that does not match the task's type;
  `403` on role or employment.

### `POST /tasks/:taskId/upload-signature` (Stage 10G.1)
- Employee only, on a task they are party to. No body: the folder and object name are
  decided by the server, so any body is ignored. This is the only task route that can
  answer `503`.
- `200` `{ cloudName, apiKey, timestamp, signature, folder, publicId, resourceType }`.
  `folder` is `taskSubmissions/{taskId}` and `publicId` is `{timestamp}-{12 hex}`
  minted per request. The signature is a SHA-1 over `folder`, `public_id` and
  `timestamp` using `CLOUDINARY_API_SECRET`, which never appears in the response, a
  log line or the signature itself. The browser posts the file and these fields (less
  `cloudName`/`resourceType`, which select the URL) straight to Cloudinary —
  `https://api.cloudinary.com/v1_1/{cloudName}/{resourceType}/upload` — so the bytes
  never pass through this API.
- `503` `{ message: 'File uploads are not configured on this server' }` when
  `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY` or `CLOUDINARY_API_SECRET` is absent or
  blank. Credentials are read lazily per request; a server without them still serves
  every text and link submission.
- `403` under the same `requireTaskParty` rules as `submit`: a task with no employment
  linkage, an ended employment, a stranger, or an employer all get the fixed sentence
  and no signature.

### `POST /tasks/:taskId/approve`
- Employer only. No body.
- `200` `{ message: 'Task approved successfully', taskId, status }`.

### `POST /tasks/:taskId/request-revision`
- Employer only. Body: `{ revisionNote }` — required, non-empty.
- `200` `{ message: 'Revision requested successfully', taskId, status }`.
- The route segment is kebab-case; the action is `request_revision` and the stored
  status is `revision_requested`.

### Why there is no `PUT /tasks/:taskId/status`
A generic status endpoint would have to re-derive the table from whatever the client
sent and could only be as strict as its least careful entry. Naming the action makes
an illegal transition unrepresentable from the client and keeps the four
action-specific rules attached to the action that owns them.

### `requireTaskParty` — who may act on a task

Authorization is resolved from the task's stored **`employmentId`**, not from its
job. `job.postedBy` is a posting relationship and `task.employeeId` is an assignment
relationship; neither is who is party to the work. The employment is, because it is
the record of who was hired for it.

| | `assigned`/legacy, no `employmentId` | employment `active` | employment `ended` |
| --- | --- | --- | --- |
| **read** (`GET /tasks/:taskId`) | assignee, or `job.postedBy` | both parties | both parties |
| **submit** | `403` | employee | `403` |
| **approve / request revision** | `403` | employer | `403` |

- A task with **no** employment linkage stays readable through the same relationship
  the two list endpoints already use, and is **frozen**: the job owner is refused
  even though they are authorized to read it and created it. Using `jobId` as a
  substitute would assume nobody can be employed on a job they did not post, which
  is exactly what `employmentId` exists to stop assuming.
- An **ended** employment splits read from write: both parties keep reading forever,
  neither may transition, and the task's status is left exactly as it was. Nothing
  in this API can end an employment yet, so the rule is written ahead of the
  capability.
- Fail-closed: an employment with a missing or unrecognised `status` is treated as
  ended, and an `employmentId` pointing at a document that does not exist is treated
  as unlinked. Neither can grant permission.
- A missing task is `404`; a stranger is `403`. Role refusals and party refusals are
  both a fixed sentence with no task data in the body.

### The stored task document (Stage 9B)

A task is created and read; it is never updated, and there is no transition or
single-task endpoint. Six fields are written unchanged from Stage 3C —
`jobId`, `employeeId`, `taskName`, `taskDescription`, `dueDate` (a client-supplied
ISO string) and `createdDate` — plus three added in Stage 9B:

| Field | Value |
|---|---|
| `status` | always `'assigned'` on create |
| `applicationId` | id of the accepted application the guard identified |
| `employmentId` | that application's employment, or `null` |

`jobId` and `employeeId` stay on the document as denormalized copies:
`listTasksByEmployee`/`listTasksByJob` are single-field equality filters that need
no composite index, so a task keyed only by `employmentId` could not be listed by
either.

- **`applicationId` is resolved by the guard, never taken from the request.**
  `requireTaskAssignment` already located the accepted application in the snapshot
  it was taking, so capturing its document id costs no extra read. A client that
  sends `applicationId`, `employmentId` or `status` has them discarded, not
  validated and rejected. When one employee holds several accepted applications for
  one job, the most recently applied wins, with the document id breaking a tie.
- **`employmentId` may be `null`.** An application can be `accepted` with no
  employment document, and the create still succeeds rather than 403 — the accepted
  application is what authorizes the assignment. It is also `null` when the
  employment found for that application names a different `jobId` or `employeeId`,
  which no document this API writes can do.
- **`status` is only ever `'assigned'.** No endpoint can write another value yet.
  `submitted`, `approved` and `revision_requested` arrive with Stage 9C.
- **No migration.** Documents written before Stage 9B have no `status`,
  `applicationId` or `employmentId`, and stay that way on disk.

### `GET /tasks/employee/:uid` and `GET /tasks/job/:jobId`
- `200` `{ tasks: [ { id, ...document } ] }` — the stored document with the
  document id added and no field renamed, dropped or reshaped.
- `403` `{ message: 'Forbidden' }` when `:uid` is not the caller
  (`requireSelfParam`), or `403` when the caller does not own the job
  (`requireJobOwner`).
- Empty list rather than `404`.
- **Stage 9B** — a document with no `status` reads back with `status: 'assigned'`.
  This is the one derived value in the response, it is added only to documents
  written before Stage 9B, and it is **not** written back: reading a task does not
  modify it. `applicationId` and `employmentId` are absent on those documents
  rather than reported as `null`. A document that *has* a `status` is forwarded
  untouched, including a value this stage does not recognise.
- Order is the query's own. Neither the service nor the repository sorts, and the
  fake Firestore throws on `orderBy()`.

### `POST /applications/tasks` (removed, Stage 9F)
- The duplicate of `POST /tasks`, sharing `requireTaskAssignment`, which returned
  no `taskId`. **Deleted** in Stage 9F, along with its handler and its service
  function; the entry above records its old contract. `POST /tasks` is the only
  task-creation endpoint, so nothing in this section applies to a second path any
  more.

### `POST /tasks` with a malformed body
- `400` with `Content-Type: text/html`. `express.json()` throws before the
  handler runs, and the global error handler renders a Jade page — so an HTML
  body is returned to clients expecting JSON.

---

## 7. `/employments` (Stage 7A, reads extended in Stage 10H.1)

An employment is the record created when an employer hires an applicant. The
resource has **no create endpoint**: an employment exists only as a consequence of
a hire, which is `PUT /applications/:id/status` with `accepted` (see §5). A client
cannot post one, choose `employerId`/`employeeId`, or set `endDate`. Four reads are
served: two self-scoped (Stage 7A) and, since Stage 10H.1, one job-scoped and one
single-document read. Every one of them is a read — this stage adds no write.

### `GET /employments/employee/:uid`
- `200` `{ employments: [ { id, ...document } ] }`, each entry the stored document
  with the document id added and no field renamed, dropped or reshaped.
- `403` `{ message: 'Forbidden' }` when `:uid` is not the caller — `requireSelfParam`.
- `401` plain text without a token.
- Empty list rather than `404` when the caller holds no employments.

### `GET /employments/employer/:uid`
- `200` `{ employments: [ ... ] }`, same shape and same `403`/`401`/empty-list rules.

### `GET /employments/job/:jobId` (Stage 10H.1)
- `200` `{ employments: [ { id, ...document } ] }`, every employment recorded on the
  job across all hires — one job may have hired several applicants, so this is the
  list a per-application read cannot give. Same unreshaped shape as the self-scoped
  reads; empty list rather than `404` when the job has no hires.
- `403` `{ message: 'You do not have permission to view employments for this job' }`,
  `404` `{ message: 'Job not found' }` for a missing job — both from `requireJobOwner`.
  No employment data is present in a `403` body.
- The query is a single-field equality filter on `jobId`, so it needs no composite
  Firestore index.

### `GET /employments/:employmentId` (Stage 10H.1)
- `200` `{ employment: { id, ...document } }` — the stored document with the document
  id added and no field renamed, dropped or reshaped, the same contract the four list
  reads use (so a single-employment read and its row in a list agree field for field).
- `403` for an authenticated caller who is neither the employment's employer nor its
  employee, with no employment data in the body.
- `404` `{ message: 'Employment not found' }` for an id that matches no document. A
  missing document (`404`) and a real one the caller is not party to (`403`) are
  distinguishable.
- `401` plain text without a token.
- A job with no hires is not reachable here: this path names an employment, and its
  absence is the `404` above.

### Authorization on the self-scoped reads
- `requireSelfParam('uid')` compares the path parameter against the verified
  token, so neither an employee nor an employer can read the other's employments.
  The service performs no ownership check of its own — the same arrangement as the
  applications and tasks reads.
- The guard tests identity, not role: a caller may read either path for their own
  uid and simply gets an empty list if they are not party to any employment.

### Authorization on the Stage 10H.1 reads
- `GET /employments/job/:jobId` reuses `requireJobOwner`, the guard that already
  protects `GET /applications/job/:jobId`, `GET /tasks/job/:jobId` and
  `GET /interviews/job/:jobId`. It loads the job named in the path and answers `403`
  unless `job.postedBy === req.user.uid`, so being the job's poster is the one
  condition and a client-supplied employer id is never trusted. It deliberately does
  not admit the employee named on an employment: the job list is the employer's
  management view, and a party to one employment is not entitled to the job's roster.
- `GET /employments/:employmentId` is guarded by the new `requireEmploymentParty`,
  which admits the employment's own `employerId` or `employeeId` and nobody else. Its
  authority comes from the **stored document**, following `requireConversationParty`
  rather than the interview guards: an employment is the record of a relationship
  between two people, both uids are written by `createEmploymentFromHire` from the
  verified token and the loaded application, and the record outlives the job it was
  raised under — so the parties are resolved from the employment itself rather than
  from a parent chain that may have been deleted or re-posted.
- Both are reads; the write model is unchanged, so this stage adds no create, no
  status change and no `endDate` write to the resource.

---

## 8. `/interviews` (Stage 7C)

An interview belongs to an application: it records that the employer who posted the
job has arranged to speak to the applicant. It is **not** a new application state —
Stage 7C adds no application status and does not touch `APPLICATION_STATUSES`, so
scheduling an interview leaves the application exactly as it was.

```
interviews/{autoId}
  applicationId, jobId, employerId, employeeId,
  scheduledAt, duration?, type, meetingLink?, location?,
  status, response?, createdAt (Timestamp), updatedAt (Timestamp)
```

- `type` is `online` or `in_person`; `status` is `scheduled` (the only value a
  create writes) / `completed` / `cancelled` / `no_show`; `response` is Stage 10A's
  applicant answer, `accepted` or `declined`.
- `employerId` comes from the verified token and `employeeId` from the application
  document. Neither is ever read from the request body.
- `duration` is minutes, as a positive number. `duration`, `meetingLink` and
  `location` are absent from the document when not supplied, and accept an explicit
  JSON `null` on update to clear.
- `response` is **absent until the applicant answers** — an unanswered interview is
  the absence of the key, not a stored `pending`, and `pending` is refused as an input.
  It is writable only by `PUT /interviews/:interviewId/response`, and only while the
  interview is `scheduled`.
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
  updatable and are dropped from the body; `status` is. `response` is dropped too —
  see the next endpoint for why it is writable at all.

### `PUT /interviews/:interviewId/response` (Stage 10A)
- Body: `response`, which must be `accepted` or `declined`. It is the only field this
  route writes; every other key in the body is dropped.
- `200` `{ message: 'Interview response recorded successfully' }`. Like every other
  write here, the updated document is not returned — the client re-reads.
- `400` `{ message: 'Invalid response. Must be one of: accepted, declined.' }` for any
  other value, including `pending`, a missing field and a wrong-case string.
- `400` `{ message: 'This interview can no longer be answered. Its status is: <status>.' }`
  when the interview is not `scheduled`. The guard has already established the caller
  is the applicant, so this is a data answer, not an authorization one.
- `404` `{ message: 'Interview not found' }` / `{ message: 'Application not found' }`,
  `403` `{ message: 'You do not have permission to respond to this interview' }`.
- **May be repeated while the interview is `scheduled`**, so an applicant who changes
  their mind is not stranded on an answer. It stops being writable the moment the
  employer completes, cancels or marks the interview a no-show.
- **Writes no application status and no employment.** Accepting an interview is not
  being hired and declining one is not being rejected; the hire remains the only thing
  that writes `accepted` to an application.

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
- `requireInterviewAuthor` (create), `requireInterviewOwner` (update),
  `requireInterviewRespondent` (Stage 10A answer) and `requireInterviewParty`
  (application read) are new exports of `middleware/auth.js`;
  `GET /interviews/job/:jobId` reuses the existing `requireJobOwner` with the new
  `JOB_INTERVIEWS_FORBIDDEN` wording.
- **Employer writes stay employer-only.** The applicant may read the interviews on
  their own application but is refused every attempt to create or change one, with a
  403 from `requireInterviewOwner` and no interview data in the body — including an
  attempt to write the applicant's own `response` through that route.
- **The response route is applicant-only.** `requireInterviewRespondent` admits the
  employee the application's document names and nobody else, not even the employer who
  scheduled the interview. It resolves `interview` → `application` →
  `application.employeeId` and never the interview's own stored `employeeId`, for the
  same reason `requireInterviewOwner` refuses a stored `employerId`: a stored value is
  not an authority.
- **Reads are party-scoped.** Authorization resolves `interview` → `application` →
  `job` → `job.postedBy`, never the interview's own stored `employerId`: a stored
  value is not an authority.
- Reads are deliberately unreshaped — `{ id, ...document }`, no field renamed,
  dropped or normalised. An unanswered interview therefore reads back without a
  `response` key rather than with a synthesised one.

### Known gaps, deliberately not closed in Stage 10A
- `RESPONDABLE_INTERVIEW_STATUSES` is a status rule, not a time rule: a `scheduled`
  interview is still answerable after its `scheduledAt` has passed. Nothing holds an
  invitation to a client clock, the same reasoning that lets `scheduledAt` be set in
  the past.
- There is no record of *when* an applicant answered, only of the answer. `updatedAt`
  moves, but a later employer edit to the same interview overwrites that signal.
- No notification: declining is silent, and the employer learns the answer by
  re-reading the interview.

### Known gaps, deliberately not closed in Stage 7C
- An `in_person` interview may be created with no `location` and an `online` one
  with no `meetingLink`; both are optional in this stage's schema.
- `INTERVIEW_STATUSES` is an allow-list, not a transition matrix (the Stage 5G
  choice), so a completed interview may be marked cancelled and vice versa.
- No `DELETE`: cancelling is a status, which is how an interview leaves the
  schedule without losing the record of it.

---

## 9. `/conversations` (Stage 8B, extended in Stage 10B)

The chat resource: a message thread between the employer who posted a job and the
applicant who applied to it. Two collections, `conversations` and `messages`, served
exclusively by `repositories/conversationRepository.js`.

A conversation is stored **under its application id**, so the id space is
`applications/{autoId}` and the document cannot be duplicated: `POST /conversations` is
idempotent by construction and `created: false` on the second call. Both participant
uids are copied from the application and the job at create time and are **never** read
from a request — they are the authorization anchor for every other route here. A
conversation deliberately outlives its application and its job (§ "RETENTION" below).

### `POST /conversations`
- Body: `applicationId`. Responds `200` `{ message, conversationId, conversation,
  created }`, never `201`, matching every other create here. `message` is
  `'Conversation created successfully'` or `'Conversation already exists'`.
- Guarded by `requireConversationParticipant`, which resolves `application` → `job` and
  admits either the applicant or the job's poster. `400 'Missing required fields'`,
  `403 'You do not have permission to access conversations for this application'`,
  `404 'Application not found'` / `'Job not found'`.
- An existing conversation is returned **as it stands**, never rewritten, so a second
  open cannot reset `createdAt` or reorder a thread.
- **RETENTION**: `withdrawApplication` deletes the application and rejecting one only
  changes its status, and neither is an ending of the conversation. Because the two uids
  are copied onto the conversation, a thread is still readable by exactly its two
  participants after the application document is gone — and `requireConversationParticipant`
  falls back to the conversation's own uids for the same reason.

### `GET /conversations`
- `200` `{ conversations: [...], totalUnread }`. Empty inbox is
  `{ conversations: [], totalUnread: 0 }`, not a `404`.
- The caller's own inbox only: two single-field equality queries (`employerId`, then
  `employeeId`) merged on id, because Firestore has no OR operator. No id in the path,
  so this needs no guard beyond `protect` and cannot be pointed at somebody else's inbox.
- Unordered, like every list here. `lastMessageAt` is denormalised onto each document so
  the client can order without a second round trip.
- **Stage 10B**: each row also carries `unreadCount` (a number) and `lastMessage`
  (`{ id, senderId, body, createdAt }`, or `null`), and `totalUnread` is the sum.

### `GET /conversations/:conversationId` (Stage 10B)
- `200` `{ conversation }` for either participant. `403 'You do not have permission to
  access this conversation'`, `404 'Conversation not found'`.
- Exists because the dedicated thread screen has to name the other participant and
  caption the job, and both facts live only on the conversation document. Reading one
  row through `GET /conversations` would cost the whole inbox — two queries plus one
  message query per conversation.
- Carries **no** `unreadCount`: this screen marks the conversation read rather than
  counting what is left.

### `GET /conversations/:conversationId/messages`
- `200` `{ messages }`, **oldest first**. A thread nobody has written in is an empty
  list, not a `404`.
- The sort is the service's, not an `orderBy`, because the fake Firestore throws on
  `orderBy()` and because a thread that can render out of order is a broken thread rather
  than a rough edge. See the known gap on in-memory sorting below.

### `POST /conversations/:conversationId/messages`
- Body: `body`, a non-empty string of at most `MESSAGE_MAX_LENGTH` (**2000**) characters.
  The length is measured **before** trimming, so 2000 spaces cannot smuggle a longer
  payload past the cap. Responds `200` `{ message, messageId }`.
- `senderId` is `req.user.uid` and never read from the body, which is what stops a
  participant posting as the other one.
- Two writes, no transaction: the message add **first**, then the `lastMessageAt`
  stamp. A message can therefore be stored while the ordering field lags, and never the
  reverse — the cheaper failure to debug. The same window exists for the Stage 10B read
  markers' inverse case below.

### `PUT /conversations/:conversationId/read` (Stage 10B)
- **No body.** Responds `200` `{ message: 'Conversation marked as read',
  conversationId }`.
- Writes exactly one field: `employerLastReadAt` or `employeeLastReadAt`, whichever side
  of the conversation the caller is on. Nothing else on the document moves —
  `lastMessageAt` in particular does not, because opening a thread is not activity in it.
- `403 'You do not have permission to access this conversation'`, `404 'Conversation not
  found'`. Idempotent; repeating it is harmless.
- **Both participants may mark it read, and neither may mark the other's.** There is no
  route on which one participant can set the other's marker: the uid comes from the
  verified token and the field is chosen from it.

### The read model (Stage 10B)
- Two scalar fields on the conversation document, one per participant, **absent until
  that participant first marks the thread read**. An absent marker means "never opened",
  which counts everything the *other* person has sent as unread.
- `unreadCount` is **derived, not stored**: messages from the other participant whose
  `createdAt` is strictly newer than the caller's own marker. Two rules, each with a
  named failure mode — the caller's own messages never count (a sender would otherwise be
  permanently one behind themselves), and "strictly newer" means a message that arrives
  between the client loading the thread and the mark-read landing counts as read.
- **Reads never mark read.** Neither `GET /conversations` nor the messages route writes
  anything, which is what allows the navbar badge to poll the inbox continuously without
  an unread message ever being cleared by somebody looking at their navbar.
- The marker is stamped with the **server's** current instant rather than the timestamp of
  the last message the reader was shown. That closes the alternative's hole (a client
  could send a future instant and hide its own unread messages permanently) at the cost of
  the race above, and the thread re-reads every five seconds either way.

### Authorization
- `requireConversationParticipant` (create) and `requireConversationParty` (all five
  conversation-scoped routes) are the Stage 8B guards; Stage 10B reuses the latter
  unchanged for the read and the mark-read rather than adding a stricter sibling, because
  marking read is something each participant does only for themselves and that is
  membership, which is what the existing guard already answers.
- The marker fields are **not** an authority. They are stored on the conversation, like
  `employerId` on an interview, and the guards authorize on the participant uids; a
  stored value a request could reach is not a permission.
- Reads are unreshaped — `{ id, ...document }` plus the two derived unread fields — with
  no stored field renamed, dropped or normalised.

### Known gaps, deliberately not closed in Stage 10B
- **No read receipts and no per-message "seen".** The marker says a participant opened the
  thread; it cannot say they saw message 14, and nothing anywhere records when the other
  party last looked.
- **The inbox pays one message query per conversation** — a genuine N+1 that grows with
  the number of rows, paid to keep `unreadCount` exact rather than a stored counter that
  could drift from the messages it counts. A stored counter would be `O(1)` to read but
  needs a second untransacted write per send, and a stale counter is the wrong number
  shown to a person. Firestore cannot express the query that would avoid it (one
  inequality field per query, and no `!=` at all).
- **Messages are still sorted in memory** after the query returns, so a thread is fully
  materialised before the first byte reaches the client (Stage 8B gap, unchanged).
- **No notification of any kind.** A reader learns of a new message by re-reading their
  inbox; nothing sends email or pushes, and no collection other than `conversations` and
  `messages` is written.
- **The inbox page does not poll, though the navbar badge does** (every 15s) and an open
  thread does (every 5s). Refreshing the list is a re-read of every conversation *and* of
  every job and counterpart profile behind it, so it was left to the reader; the badge on
  the same screen still rises, which is the signal that something arrived. A reader who
  wants the rows themselves live pays for the joins.
- **No unread-only view.** `GET /:conversationId/messages` returns the whole thread; the
  client cannot ask for just the new messages.
- **No `DELETE`, no message edit, and no way to change a conversation's participants**
  after it exists.

---

## 10. Cross-cutting defects

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
| Dead code | ~~`POST /applications/tasks`~~ | ~~`routes/applications.js:39`~~ | **9F - done** |
| Dead code | Commented-out `/profile` route | `userController.js:122` | 7 |
| Dead code | Jade views + `express.static` | `app.js:19,20,27` | 7 |
| Debug | `console.log` in controllers/services | `jobService.js:134,142`, `applicationService.js:199,284`, `applicationController.js:181` | 2 |
| Debug | Full user document logged | `userService.js:172` | 2 |
| Types | `price` stored as string on create, number on edit | `jobService.js:110` vs `jobService.js:248` | 3 |
| ~~Timestamps~~ | ~~`new Date()` in jobs/tasks, `serverTimestamp()` in users~~ | `jobService.js:117` vs `userService.js:145` | **5H - partial: tasks/applications moved, jobs left on ISO strings** |
| Duplication | `formatPhoneNumber` copied client → server | `userService.js:83` | 5 |
| Duplication | Required-field lists in 4 places | `jobService.js:78,213`, two client forms | 5 |

---

## 11. Firestore schema as actually stored

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

employments/{autoId}
  employerId (= token uid), employeeId, jobId, applicationId,
  startDate, endDate (null), status ('active')
  # Stage 7A: written only by a successful hire, never by a request body.
  # startDate is the job's own jobStartDate stored verbatim — required by
  # jobService, so every API-written job has one — or, for a job document that
  # lacks it, a serverTimestamp() Timestamp, so the field has two possible
  # stored types. endDate is null and status is 'active'; nothing writes
  # 'ended' yet, and there is no update path for this collection.

interviews/{autoId}
  applicationId, jobId, employerId (= token uid),
  employeeId (from the application, never from the body),
  scheduledAt, type ('online' | 'in_person'), status ('scheduled'),
  response ('accepted' | 'declined', absent until the applicant answers),
  createdAt (Timestamp), updatedAt (Timestamp)
  # Stage 7C: duration, meetingLink and location are absent unless supplied, and
  # may be cleared with an explicit null on update. status is written as
  # 'scheduled' by a create and changed only through PUT /interviews/:interviewId,
  # which also reschedules and corrects details. applicationId, jobId, employerId,
  # employeeId and createdAt are not updatable. No interview write touches the
  # application, and none creates an employment.
  # Stage 10A: response is written only by PUT /interviews/:interviewId/response,
  # for the applicant, and only while status is 'scheduled'. It is deliberately NOT
  # in UPDATABLE_INTERVIEW_FIELDS, so the employer update route cannot write it.

conversations/{applicationId}          # NOT autoId: the id IS the application id
  applicationId, jobId,
  employerId (= job.postedBy), employeeId (= application.employeeId),
  createdAt (Timestamp), lastMessageAt (Timestamp)
  # Stage 8B: both uids are copied from authoritative documents at create time and are
  # never writable from a request -- they are what authorizes every message read and
  # write. lastMessageAt is denormalised for inbox ordering and is stamped only by a
  # successful send.
  # Stage 10B: employerLastReadAt and employeeLastReadAt (Timestamp) are the per-
  # participant read markers. Both are ABSENT until that participant first marks the
  # thread read, and each is written only by PUT /conversations/:id/read for its own
  # side. They are plain top-level fields rather than a map keyed by uid, so the two
  # participants writing concurrently cannot overwrite one another. An unread count is
  # derived from them and never stored.

messages/{autoId}
  conversationId, senderId (= token uid), body (<= 2000 chars, trimmed),
  createdAt (Timestamp)
  # Stage 8B: a TOP-LEVEL collection carrying conversationId as a field, not a
  # subcollection -- see the note in conversationRepository.js. senderId is never
  # read from the request body, and nothing deletes a message or edits one.

contracts/{employmentId}               # NOT autoId: the id IS the employment id
  employmentId, employerId, employeeId, jobId, applicationId,   # copied from the employment, never the body
  currency ('NGN'), paymentMode ('full' | 'milestones'),
  totalAmountMinor (kobo), commissionBps (500), commissionAmountMinor,  # server-computed
  status ('pending_acceptance' | 'active'),
  createdAt (Timestamp),
  acceptedAt (Timestamp), acceptedBy    # ABSENT until the employee accepts
  # Stage P1: one contract per employment, enforced by the deterministic id
  # (contracts/{employmentId}) rather than by a query-then-write. The amount is
  # explicitly agreed in the create request -- never taken from jobs.price or
  # applications.employeePrice. Commission is floor(totalAmountMinor * 500 /
  # 10000) kobo, computed in config/commission.js; commissionBps is stored
  # beside it so a reader can re-derive the arithmetic from the document and so
  # an old contract still describes the rate it was created under.
  # In 'full' mode totalAmountMinor comes from the request; in 'milestones' mode
  # it is DERIVED from the schedule and a client-supplied total is rejected.
  # acceptedAt/acceptedBy are written only by POST /contracts/:contractId/accept
  # (status, acceptedAt, acceptedBy and nothing else), and acceptance does not
  # initiate a payment, touch any other collection, or read any provider field.
  # There is no rejected/cancelled status in P1, no edit path, no delete path,
  # and no payment endpoint under /contracts.

milestones/{autoId}
  contractId (= employmentId), employmentId, taskId, label (trimmed),
  amountMinor (kobo, positive safe integer),
  status ('pending_acceptance'), createdAt (Timestamp)
  # Stage P1: a TOP-LEVEL collection carrying contractId as a field, not a
  # subcollection, matching messages. Written only alongside a successful
  # contract create, in a 1..50 entry schedule; each milestone's task must
  # EXIST and carry employmentId === the contract's employment, so a schedule
  # can only ever pay for this employment's own tasks (a pre-Stage-9B task with
  # no employmentId field is rejected, same as a wrong-employment one). All
  # schedule validation runs BEFORE the first write, so an invalid schedule
  # leaves no contract and no milestones behind. Nothing in P1 transitions a
  # milestone's status.

payments/{milestoneId}                   # milestone payment: id IS the milestone id
payments/contract_{contractId}           # full-contract payment: deterministic id
  paymentTarget ('contract' only on full-contract records; absent means milestone),
  milestoneId (milestone only), taskId (milestone only),
  contractId (= employmentId), employmentId,
  employerId, employeeId,                 # copied from the contract, never the body
  amountMinor (kobo), currency ('NGN'),
  commissionBps (contract create-time SNAPSHOT), commissionAmountMinor,
  status ('created' | 'pending' | 'paid' | 'failed' | 'needs_review'),
  idempotencyKey (client-supplied, trimmed, non-empty, <= 128 chars),
  initiatedBy (token uid), createdAt (Timestamp),
  verifyAttempts,                          # number of the latest initialization attempt
  providerReference, providerEnvironment ('test'),
  chargeMinor, feeMinor, providerFeeMinor, # provider-derived display figures
  statusReason, verifiedAt, paidAt         # static safe reason / Timestamps
  # One parent record per milestone or full contract, enforced by the
  # deterministic id. 'created' means only that Kachploy stored the request;
  # 'pending' means an attempt is latched in flight; only verified provider
  # evidence can set 'paid'. Every retry gets a NEW reference. The parent is
  # the current aggregate state; per-attempt history lives below.

paymentAttempts/{paymentId}__attempt_{n}
  paymentId, paymentTarget, contractId, milestoneId,
  attemptNumber, reference,               # write-once, never reused
  amountMinor, currency, commissionAmountMinor,
  expectedChargeMinor, expectedFeeMinor,
  status ('pending' | 'paid' | 'failed' | 'needs_review'),
  providerTransactionId, providerReference, providerEnvironment,
  providerFeeMinor, statusReason, legacy,
  createdAt, initializedAt, lastCheckedAt, verifiedAt, completedAt, paidAt, updatedAt
  # One immutable-identity document per provider initialization attempt.
  # A legacy failed record with a stored reference is backfilled into its
  # historical attempt number on the next retry.

paymentReferences/{sha256(reference)}
  reference, paymentId, attemptId, attemptNumber, createdAt, legacy
  # Write-once registry. The hash keeps arbitrary text out of document ids.
  # The attempt claim, this reference claim and the parent 'pending' latch are
  # committed in ONE Firestore transaction.
```

---

## 12. `/contracts` (Stage P1)

The contract and milestone foundation. A contract is the record of the price an
employer and an employee agreed on for an employment that already exists. It is
created by the employer AFTER the hire, carries an explicitly agreed amount in
kobo (never inferred from `jobs.price` or `applications.employeePrice`), and
becomes active only when the employee accepts it. **P1 charges nobody, holds
nothing, computes no provider fees and talks to no payment provider** -- the
only writes this resource has are create and accept.

Commission is **5% (500 bps)**, computed server-side in
`config/commission.js` as `floor(totalAmountMinor * 500 / 10000)` kobo, stored
on the document as `commissionBps` + `commissionAmountMinor`. Money is integer
kobo throughout; currency is NGN only, and an absent `currency` defaults to
`'NGN'` while any other value (`'ngn'`, `'USD'`, ...) is a `400`.

### `POST /contracts` -- token required

`requireContractEmployer` first: `body.employmentId` is required (`400 'Missing
required fields'`), the employment must exist (`404 'Employment not found'`), the
caller must be its `employerId` (`403`), and it must be `active` (`403 'This
employment has ended...'`). Then `contractService.createContract`.

Body: `employmentId` (required, names the employment), `paymentMode`
(`'full'` | `'milestones'`), and one of:

- `full` -- `totalAmountMinor` required, positive safe integer kobo; a supplied
  `milestones` array is a `400`.
- `milestones` -- `milestones` required, 1-50 entries of
  `{ taskId, label, amountMinor }`; a supplied `totalAmountMinor` is a `400`
  (`400 ... the total is derived from the schedule`), the total is the sum of
  the schedule.

Optional `currency`, absent or exactly `'NGN'`.

Every one of `id`, `employerId`, `employeeId`, `jobId`, `applicationId`,
`commissionBps`, `commissionAmountMinor`, `status`, `createdAt`, `acceptedAt`,
`acceptedBy` in the body is a `400` naming the field (`cannot be supplied`) --
the identities are copied from the employment, the commission from the
configuration, and the lifecycle fields belong to other endpoints. Invalid
amounts, unknown `paymentMode`, and duplicate creation are all `400`; a
duplicate answers `'a contract already exists for this employment'` (409 is not
in this API's error vocabulary).

Milestone tasks are validated before any write: a missing task, a task whose
`employmentId` differs, a task with no `employmentId` at all, a blank `label` or
`taskId`, or an invalid `amountMinor` are each `400`, and **no contract and no
milestones are written**. The duplicate read and every other check run before
the transaction. The success path is one transaction that reads the
deterministic id `contracts/{employmentId}`, creates the contract there, and
creates every initial milestone in the same commit. A duplicate returns `400`
without writing; any write failure aborts the whole commit, so there is no
contract with a partial schedule. At most 50 milestones means at most 51
writes, below Firestore's 500-write transaction limit.

Responds `200 { message: 'Contract created successfully', contractId, contract,
milestones }` -- `contractId` is the employment id, `contract` is the stored
document re-read (so `createdAt` is a real Timestamp, `acceptedAt`/`acceptedBy`
absent), `milestones` is the stored schedule (`[]` in `full` mode). 200 rather
than 201 matches every create except jobs.

### `POST /contracts/:contractId/accept` -- token required

`requireContractEmployee` first: `404 'Contract not found'` for a missing id,
`403` for anyone who is not the contract's `employeeId` -- the employer included.
Then `contractService.acceptContract`, whose status check is a domain rule: only
`pending_acceptance` can be accepted, so a repeat is `400 'only a contract
pending acceptance can be accepted'` and alters nothing.

Acceptance writes exactly three fields on the one contract document --
`status: 'active'`, `acceptedAt` (serverTimestamp), `acceptedBy` (token uid) --
and touches no other collection. **It does not initiate a payment**: there is no
provider reference, no payment state, and no endpoint under `/contracts` that
could (`/pay`, `/initiate`, `/refund`, `PUT`, `DELETE` all answer `404`).

Responds `200 { message: 'Contract accepted successfully', contract }`.

### `GET /contracts/employment/:employmentId` -- token required

`requireEmploymentParty` (the existing employment guard) admits either party to
the employment; a stranger is `403`. Responds `200 { contract, milestones }`, or
`404 'Contract not found'` for an employment that exists but has no contract
yet -- "no contract yet" is the normal pre-create state and has no partial body
to represent.

### `GET /contracts/:contractId` -- token required

`requireContractParty` loads the contract and admits only its two uids; `404`
before any authorization decision for a missing contract, `403` with no contract
data in the body for a stranger. Responds the same `{ contract, milestones }`
shape as the employment-scoped route, so the two are interchangeable for a
client.

### Stage boundary

No payment-provider credentials are read anywhere in this flow (the only
configuration is `config/commission.js`, which cannot be absent), and the
contract document has no rejected/cancelled status, no edit path and no delete
path -- those belong with the payment lifecycle stage, not here. No provider
field exists on the stored documents and no payment endpoint exists under
`/contracts`; the payment lifecycle lives under `/payments` (see section 13).

---

## 13. `/payments` (payment lifecycle, current)

The payment resource now covers local payment requests, Test Mode Paystack
initialization, server-side verification, the signed webhook, and read-only
history. It still does **not** implement escrow, split settlement, employee
payout, refunds or transfers, and no 200 here is by itself proof that money
moved. Only a provider-consistent verification result can set `paid`.

Money is integer kobo throughout and the currency is NGN only (copied from the
contract). Commission is computed from the contract's create-time
`commissionBps` snapshot with `floor(amountMinor * commissionBps / 10000)`.

### Payment records and attempts

- A milestone payment is stored at `payments/{milestoneId}`.
- The one full-contract payment is stored at `payments/contract_{contractId}`
  with `paymentTarget: 'contract'`.
- `created` means only that the employer's request was stored. `pending` means
  an attempt is latched in flight. `paid`, `failed` and `needs_review` are
  provider-verified outcomes.
- `verifyAttempts` is the latest attempt number, not a permanent retry cap.
- Every initialization writes a `paymentAttempts/{paymentId}__attempt_{n}`
  document and claims a write-once `paymentReferences/{sha256(reference)}`.
  Attempt 1 uses `kp_<paymentId>`; later attempts append `_a<n>`. A reference
  is never reused.
- The attempt claim, reference claim and parent `pending` latch commit in one
  Firestore transaction. A definitive provider rejection may be retried with a
  NEW reference; `pending` and `needs_review` must be resolved first; `paid` is
  never reinitialized.
- A legacy failed record that already has a `providerReference` is backfilled
  into its historical attempt document on the next retry. Its old reference is
  never sent again.

Initialization is throttled to 5 attempts per rolling 60 seconds per payment.
The provider calls are Test Mode only; a missing or Live key answers `503`
before any write.

### `POST /payments` -- milestone payment request

`requireMilestoneEmployer` requires `body.milestoneId`, an existing milestone
and contract, and the caller as contract employer. Body: `milestoneId` and a
trimmed non-empty `idempotencyKey` of at most 128 characters.

Forbidden client fields include all copied identities, amounts, commission,
status and provider fields. Eligibility: active contract, existing active
employment, existing approved task on that employment. Same-key replay returns
`200 'Payment already recorded'`; a key reused for another milestone or a new
key for an existing milestone is `400`.

Responds `200 { message, payment }` with the stored record.

### `POST /payments/initialize` -- milestone checkout

`requireMilestoneEmployer`; body requires only `milestoneId` (plus no forbidden
fields). A record must exist; `paid` is refused, `pending`/`needs_review` are
refused, and `created` or definitive `failed` is initialized.

Server-derived inputs are the stored milestone amount, the fee calculator, the
contract currency, active contract/employment, and the employer's stored email.
The response is a strict whitelist:
`{ message, paymentId, reference, status, amountMinor, feeMinor, chargeMinor,
currency, checkoutUrl }`.

Provider request-level rejections `400/401/403/404/422` roll the parent back to
its prior `created` or `failed` state and mark the attempt failed. Transport
errors, timeouts, 5xx, 409/429, malformed 2xx bodies, reference mismatches and
untrusted checkout URLs leave the record `pending` and answer `500`: the
outcome is unconfirmed and must be verified, never blindly retried.

### `POST /payments/verify` -- milestone verification

`requireMilestoneEmployer`; body requires only `milestoneId`. An already-paid
record returns `200` with no provider call. A `created` record cannot be
verified. The service resolves the current attempt's reference and asks Paystack
to verify it, retrying only transport failures, timeouts, 429 and 5xx (three
total attempts with bounded backoff).

The response must match the exact reference, NGN currency and expected gross
kobo amount. `success` becomes `paid` unless the record was already `failed`, in
which case contradictory evidence becomes `needs_review`; explicit `failed`
becomes `failed`; in-flight statuses stay `pending`; reversed/abandoned/unknown
become `needs_review`. A transport outcome that survives retries answers `500`
and leaves the record untouched.

Responds `200 { message, verified, payment }` with the safe payment projection.

### `GET /payments/milestone/:milestoneId`

Either contract party may read. Missing milestone/contract is `404` before
authorization; a stranger is `403`. A valid milestone with no record is
`404 'Payment not found'`; otherwise `200 { payment }`.

### Full-contract payments

- `POST /payments/contract` creates the one payment for a `paymentMode: 'full'`
  contract. Body: `contractId` plus `idempotencyKey`. The contract must be
  active and the employment active.
- `POST /payments/contract/initialize` and `POST /payments/contract/verify`
  mirror the milestone flows and use `contract.totalAmountMinor`.
  Initialization requires an active contract/employment; client verification
  also does. Webhook reconciliation may verify after the employment ends.
- `GET /payments/contract/:contractId` is readable by either contract party.

### `GET /payments/history`

Protected by the verified token only. Ownership is the caller's uid; no client
uid is accepted. Query parameters: `status`, `type`
(`milestone` | `full_contract`), `q`, `from`, `to`, `page`, `pageSize`
(default 10, max 50). Invalid filters are `400`.

Responds `200 { payments, pagination, summary, filters }`, sorted newest first.
`summary` is the all-time caller-owned breakdown (`paid`, `pending`, `failed`,
`needsReview`, `other`). `Cache-Control: no-store` is set.

### `POST /payments/webhook`

Authenticated by `x-paystack-signature` HMAC-SHA512 over the exact raw body, not
a bearer token. Missing/bad signature is `401`; unconfigured server is `503`.
Only `charge.success` is actionable. The event locates an existing payment by
its write-once reference and never creates one; the provider is then re-verified
through the same state machine as `/verify`. A stale event for an older attempt
is acknowledged without touching the current attempt. An ambiguous verification
answers `500` so Paystack retries.

### Stage boundary

No cancellation, refund, transfer, payout, escrow or provider-hosted callback
url is implemented. `PUT`/`PATCH`/`DELETE` under `/payments` remain absent. The
signed webhook and client verification are the only paths that apply a provider
outcome.
