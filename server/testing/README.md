# Test Harness

Stage 0 safety net for the BookMe backend. Runs the **real** Express app and the
**real** route handlers against an in-memory Firebase double.

```bash
cd server
npm test
```

## Design constraints

**No new dependencies.** The suite uses Node's built-in `node:test` runner and
the global `fetch`, available in Node 20. There is nothing to install, so there
is no install step that can fail and no new supply-chain surface.

**Tests cannot reach production Firestore.** `server/config/firebase.js` is
replaced in `require.cache` *before* `server/app.js` is loaded, so the module
body never executes, `admin.initializeApp()` is never called, and the service
account JSON is never read. `startTestServer()` asserts the injection took effect
and refuses to continue if it did not.

**No application files are modified.** The harness reaches into the module cache
from outside; `app.js`, `bin/www`, `config/` and `routes/` are untouched. The only
change to the application is the addition of a `test` script in `package.json`.

## Why the helpers are not in `test/`

Node's test runner treats *every* `.js` file under a directory named `test` as a
test file, so helpers placed in `test/helpers/` are executed as test files and
inflate the reported test count. The harness therefore lives in `testing/`, a
sibling of `test/`.

## Files

| File | Purpose |
|---|---|
| `testing/fakeFirestore.js` | In-memory Firestore + Firebase Auth double |
| `testing/testApp.js` | Loads the real app with Firebase swapped out; starts an ephemeral HTTP server; silences morgan |
| `testing/fixtures.js` | Job / user / application builders |
| `test/*.test.js` | The characterization suites |
| `test/docs/ENDPOINTS.md` | Behaviour reference these tests produce |

## Fidelity notes

`fakeFirestore.js` mirrors the Admin SDK semantics the routes actually depend on,
because route behaviour depends on them:

- `doc.get()` on a missing document resolves with `exists === false` and
  `data() === undefined`.
- `doc.update()` on a missing document **throws** (real SDK: `NOT_FOUND`).
  Several routes rely on this to produce a 500 instead of a 404.
- `FieldValue.increment(n)` applies against the existing value, treating a
  missing field as `0`.
- `FieldValue.serverTimestamp()` resolves at write time.
- `data()` and snapshots return defensive copies.
- **`Date` and `serverTimestamp()` both store a Timestamp** (Stage 5H). The real
  admin SDK's Timestamp has no `toJSON()`, so `res.json()` emits
  `{"_seconds":N,"_nanoseconds":M}`; the fake reproduces that shape exactly,
  which is what the client's `._seconds` decoders read. `timestampFrom` is
  exported so tests can build the same value, and `client.seed` goes through the
  same conversion as a write — Firestore has no `Date` type, so a seeded document
  cannot hold one either.

Anything not implemented throws with an explicit message, so a future route
change that starts using an unstubbed API fails loudly rather than silently
passing against a fake.

## Writing a new test

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job } = require('../testing/fixtures');

let client;

test.before(async () => { client = await startTestServer(); });
test.after(async () => { await client.close(); });
test.beforeEach(() => { client.fake.resetAll(); });

test('does the thing', async () => {
  client.seed('jobs', 'job-1', job());
  const res = await client.get('/jobs/job-1');
  assert.equal(res.status, 200);
});
```

### Client API

| Member | Description |
|---|---|
| `client.get/post/put/delete(path, opts)` | Issue a request; resolves to `{ status, headers, body, text, contentType }` |
| `client.request(method, path, opts)` | Same, explicit method |
| `opts.token` | Sent as `Authorization: Bearer <token>` |
| `opts.body` | Object, JSON-encoded; strings passed through verbatim |
| `client.seed(collection, id, doc)` | Write a Firestore document directly, bypassing the API |
| `client.readDoc(collection, id)` | Read a document (defensive copy) |
| `client.readAll(collection)` | Read a whole collection as `{ id: ...doc }` |
| `client.fake.store.calls` | Log of every Firestore operation — used to assert query counts |
| `client.fake.resetAll()` | Clear all collections, tokens and auth users |

### Authentication

`client.signUp(uid, props)` models the real signup flow — the browser creates the
Firebase Auth user first, then calls `POST /users/register` with that ID token —
and returns a valid bearer token.

`client.token(uid)` issues a valid token for a UID with **no** Auth user record,
which reproduces the 500 that `POST /users/register` currently returns in that
situation.

## Characterization contract

These tests pin down present behaviour, including behaviour that is wrong.
Tests asserting known defects are annotated `BUG` or `QUIRK`.

A failure is only actionable if it is not an expected change. Read the failure
message before assuming the refactor broke something.

**When a test fails because something was deliberately corrected, rewrite it to
assert the new correct behaviour rather than deleting it, and remove the
`BUG`/`QUIRK` annotation.**

### Stage 1 (complete)

Stage 1 closed the authentication and authorization holes, so most of the
original `test/security.test.js` assertions were inverted. The suite now asserts
the secure contract: **every route registration rejects a missing or invalid
token**, and `test/{users,jobs,applications,tasks}.test.js` exercise the
ownership rules with distinct employer and employee identities.

`client.authed(uid)` is the normal entry point for these tests. It issues a
valid token and returns a request client bound to that identity:

```js
const employer = await client.authed('employer-1');
const employee = await client.authed('employee-1');

await employer.get('/jobs/employer/employer-1');   // 200
await employee.get('/jobs/employer/employer-1');  // 403
```

### Remaining stages

Stages 2-7 will still change behaviour — chiefly the duplicated routes and the
Jade HTML error handler. The same rule applies: rewrite the assertion, keep the
coverage, drop the annotation. The `proposal`/`proposals` counters are gone
(Stage 5E): the fixtures in `testing/fixtures.js` still seed them on purpose, to
model pre-Stage-5E documents and prove the legacy keys are left untouched, and
the tests that assert them now assert that they are *not* read or written.
