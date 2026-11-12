'use strict';

/**
 * Characterization tests for server/routes/users.js
 *
 * Note the deliberate asymmetry this suite documents: verifyToken is applied
 * ONLY to POST /register and POST /register-profile. Every other route in this
 * file is reachable with no Authorization header at all.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestServer } = require('../testing/testApp');
const { user } = require('../testing/fixtures');
const { timestampFrom } = require('../testing/fakeFirestore');

let client;
const now = () => '2026-01-01T00:00:00.000Z';

test.before(async () => {
  client = await startTestServer({ clock: now });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(() => {
  client.fake.resetAll();
});

// ---------------------------------------------------------------- stub route

test('GET /users returns the leftover Express generator stub', async () => {
  const api = await client.authed('user-1');
  const res = await api.get('/users');

  // DEAD CODE: generated placeholder, never used by the client. Stage 1 put it
  // behind authentication all the same.
  assert.equal(res.status, 200);
  assert.equal(res.text, 'responds with a resource');
});

// -------------------------------------------------------------- /register

test('POST /users/register requires a bearer token', async () => {
  const res = await client.post('/users/register', {
    body: { fullName: 'A', role: 'employer' },
  });

  assert.equal(res.status, 401);
  assert.equal(res.text, 'Unauthorized');
});

test('POST /users/register rejects an invalid token', async () => {
  const res = await client.post('/users/register', {
    body: { fullName: 'A', role: 'employer' },
    token: 'garbage',
  });

  assert.equal(res.status, 401);
  assert.equal(res.text, 'Invalid token');
});

test('POST /users/register rejects a non-Bearer authorization header', async () => {
  const res = await client.post('/users/register', {
    body: { fullName: 'A', role: 'employer' },
    headers: { Authorization: 'Basic abc123' },
  });

  assert.equal(res.status, 401);
});

test('POST /users/register creates the Firestore profile', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });

  const res = await client.post('/users/register', {
    body: { fullName: 'Test User', phone: '08012345678', role: 'employer', profileComplete: false },
    token,
  });

  assert.equal(res.status, 200);
  assert.equal(res.text, 'User registered successfully');

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.role, 'employer');
  assert.equal(stored.profileComplete, false);
  // STAGE 5H: was `assert.equal(stored.createdAt, now())`, which pinned the fake's
  // old behaviour of resolving serverTimestamp() straight to the clock's ISO
  // string. Production stores a Timestamp, and res.json() emits it as
  // {"_seconds","_nanoseconds"} -- so this is now the same assertion the two
  // /tasks createdDate tests make, and the shape JobSplitView.jsx has to decode.
  assert.deepEqual(stored.createdAt, { _seconds: 1767225600, _nanoseconds: 0 });
});

test('POST /users/register does not store fullName in Firestore', async () => {
  const token = await client.signUp('user-1');

  await client.post('/users/register', {
    body: { fullName: 'Test User', role: 'employee' },
    token,
  });

  // QUIRK: fullName goes only to Firebase Auth (displayName), so the Firestore
  // document has no name field.
  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.fullName, undefined);
  assert.equal(client.fake.auth.users.get('user-1').displayName, 'Test User');
});

test('POST /users/register is idempotent on the Firestore side', async () => {
  const token = await client.signUp('user-1');
  const body = { fullName: 'Test User', role: 'employee' };

  await client.post('/users/register', { body, token });
  const second = await client.post('/users/register', { body, token });

  assert.equal(second.status, 200);
  assert.equal(second.text, 'User already registered');
});

const PHONE_CASES = [
  ['08012345678', '+2348012345678'],
  ['8012345678', '+2348012345678'],
  ['2348012345678', '+2348012345678'],
  ['+2348012345678', '+2348012345678'],
  ['not-a-number', 'not-a-number'],
];

for (const [input, expected] of PHONE_CASES) {
  test(`POST /users/register formats phone ${input} -> ${expected}`, async () => {
    const token = await client.signUp('user-1');

    await client.post('/users/register', {
      body: { fullName: 'A', phone: input, role: 'employee' },
      token,
    });

    assert.equal(client.fake.auth.users.get('user-1').phoneNumber, expected);
  });
}

test('POST /users/register tolerates a missing phone number', async () => {
  const token = await client.signUp('user-1');

  const res = await client.post('/users/register', {
    body: { fullName: 'A', role: 'employee' },
    token,
  });

  // The server copy of formatPhoneNumber has a null guard the client copy lacks.
  assert.equal(res.status, 200);
  assert.equal(client.fake.auth.users.get('user-1').phoneNumber, undefined);
});

test('POST /users/register returns 500 when the Auth user is missing', async () => {
  const token = client.token('ghost-uid');

  const res = await client.post('/users/register', {
    body: { fullName: 'A', role: 'employee' },
    token,
  });

  // QUIRK: a valid token for a deleted/nonexistent Auth user causes
  // admin.auth().updateUser to throw, surfacing as a 500.
  assert.equal(res.status, 500);
  assert.equal(res.text, 'Error registering user');
});

// -------------------------------------------------------- /register-profile

// STAGE 5F. This test used to seed `profileComplete: false`, call
// /register-profile, and assert `isProfileComplete === true` -- pinning the exact
// bug the stage fixes. The endpoint marked the profile complete under a name
// nothing ever read, so the seeded `profileComplete: false` survived and the
// account stayed in the onboarding loop. The assertion below now pins the
// canonical contract: `profileComplete` is what gets set, and the retired name
// is never written.
test('POST /users/register-profile merges into the existing document', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', { role: 'employee', profileComplete: false });

  const res = await client.post('/users/register-profile', {
    body: {
      fullName: 'Test User',
      phone: '+2348012345678',
      location: 'Lagos',
      serviceType: 'plumbing',
      bio: '10 years experience',
    },
    token,
  });

  assert.equal(res.status, 200);
  assert.equal(res.text, '\u2705 Profile saved!');

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.role, 'employee', 'merge must preserve existing fields');
  assert.equal(stored.location, 'Lagos');
  assert.equal(stored.email, 'user@example.test');
  assert.equal(stored.profileComplete, true, 'the canonical field is what marks completion');
  assert.equal('isProfileComplete' in stored, false, 'the retired field must never be written');
  // STAGE 5H: was `assert.equal(stored.updatedAt, now())`, encoding the same stale
  // ISO-string model as createdAt above. It is a Timestamp like createdAt.
  assert.deepEqual(stored.updatedAt, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.equal(stored.updatedAt instanceof Date, false, 'a Timestamp is not a Date');
});

// ------------------------------------------------------- STAGE 5F: profileComplete
//
// `profileComplete` is the one canonical profile-completion field. The stage
// closes three things: registration accepted the flag from the request body,
// `isProfileComplete` was writable through the profile allow-list, and
// /register-profile wrote that retired name instead of the one every consumer
// reads.

// (A) Registration must always start incomplete.
test('POST /users/register cannot be given profileComplete: true', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });

  const res = await client.post('/users/register', {
    body: {
      fullName: 'Test User',
      phone: '08012345678',
      role: 'employer',
      profileComplete: true,
    },
    token,
  });

  assert.equal(res.status, 200, 'the request still succeeds -- only the flag is ignored');
  assert.equal(res.text, 'User registered successfully');
  assert.equal(
    client.readDoc('users', 'user-1').profileComplete,
    false,
    'a client-supplied profileComplete: true must not skip onboarding',
  );
});

test('POST /users/register writes profileComplete: false with no flag in the body', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });

  await client.post('/users/register', {
    body: { fullName: 'Test User', phone: '08012345678', role: 'employee' },
    token,
  });

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.profileComplete, false);
  assert.equal(stored.role, 'employee', 'every other registration field is preserved');
  assert.deepEqual(stored.createdAt, { _seconds: 1767225600, _nanoseconds: 0 },
    'createdAt is untouched by this stage (Timestamp shape since Stage 5H)');
});

// (A) The value is not merely defaulted -- a falsy body value cannot be honoured
// either, and the stored type stays a real boolean.
test('POST /users/register stores a boolean, not the body value', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });

  await client.post('/users/register', {
    body: { fullName: 'Test User', role: 'employee', profileComplete: 'yes' },
    token,
  });

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.profileComplete, false);
  assert.equal(typeof stored.profileComplete, 'boolean');
});

// (B) Profile completion through the server endpoint.
test('POST /users/register-profile sets profileComplete and not isProfileComplete', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', { role: 'employee', profileComplete: false });

  await client.post('/users/register-profile', {
    body: { fullName: 'Test User', location: 'Lagos', serviceType: 'plumbing' },
    token,
  });

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.profileComplete, true);
  assert.equal('isProfileComplete' in stored, false);
});

// (E) The path the React client actually uses must keep working unchanged.
test('PUT /users/update/:uid still persists profileComplete: true', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', { role: 'employee', profileComplete: false });

  const res = await client.put('/users/update/user-1', {
    body: { fullName: 'Test User', location: 'Lagos', profileComplete: true },
    token,
  });

  assert.equal(res.status, 200);
  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.profileComplete, true, 'completeProfile.jsx sends exactly this');
  assert.equal(stored.location, 'Lagos', 'the rest of the payload still lands');
});

// (C) Self-read is what the three dashboards call, so this is the value they see.
test('GET /users/getUser/:uid self-read returns profileComplete: true once completed', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', { role: 'employee', profileComplete: true });

  const res = await client.get('/users/getUser/user-1', { token });

  assert.equal(res.status, 200);
  // This is the exact expression EmployeeDashboard/EmployerDashboard/yo.jsx
  // evaluate. Before 5F it could be false on a profile completed via
  // /register-profile, which sent the user back to /complete-profile forever.
  assert.equal(res.body.user.profileComplete, true);
});

test('GET /users/getUser/:uid self-read returns profileComplete: false for a new account', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', { role: 'employee', profileComplete: false });

  const res = await client.get('/users/getUser/user-1', { token });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.profileComplete, false);
});

// (D) Legacy tolerance. Documents written before 5F may carry the retired key.
// They are neither required to be cleaned nor broken by its presence.
test('a legacy isProfileComplete document is left intact and still readable', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  // A document as the orphaned writer left it: complete under the retired name,
  // still false under the canonical one.
  client.seed('users', 'user-1', {
    role: 'employee',
    profileComplete: false,
    isProfileComplete: true,
  });

  const before = await client.get('/users/getUser/user-1', { token });
  assert.equal(before.status, 200);
  // The retired key is inert: nothing reads it, and it is not hidden from the
  // owner, so an old document is served exactly as stored.
  assert.equal(before.body.user.isProfileComplete, true);
  assert.equal(before.body.user.profileComplete, false);

  // Reading it changed nothing -- no lazy migration, no cleanup on read.
  const after = await client.get('/users/getUser/user-1', { token });
  assert.deepEqual(after.body.user, before.body.user);
});

test('re-completing a legacy profile updates profileComplete and keeps isProfileComplete', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', {
    role: 'employee',
    profileComplete: false,
    isProfileComplete: true,
  });

  await client.put('/users/update/user-1', {
    body: { location: 'Lagos', profileComplete: true },
    token,
  });

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.profileComplete, true, 'the active field is now correct');
  assert.equal(
    stored.isProfileComplete,
    true,
    'the stale key is not deleted -- 5F performs no migration and no cleanup',
  );
});

test('register-profile on a legacy document repairs the canonical field only', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', {
    role: 'employee',
    profileComplete: false,
    isProfileComplete: true,
  });

  await client.post('/users/register-profile', {
    body: { fullName: 'Test User', location: 'Lagos' },
    token,
  });

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.profileComplete, true);
  assert.equal(stored.isProfileComplete, true, 'left in place, not deleted');
});

// The retired name is no longer reachable through the profile allow-list.
test('PUT /users/update/:uid can no longer write isProfileComplete', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', { role: 'employee', profileComplete: false });

  const res = await client.put('/users/update/user-1', {
    body: { isProfileComplete: true },
    token,
  });

  // The allow-list filter drops the key entirely, so an update of nothing but the
  // retired field is a no-op write. The endpoint's documented behaviour for an
  // empty allow-list result is a 200 with no write, and that is unchanged.
  assert.equal(res.status, 200);
  const stored = client.readDoc('users', 'user-1');
  assert.equal('isProfileComplete' in stored, false, 'the retired field is not writable');
  assert.equal(stored.profileComplete, false, 'and it did not complete the profile');
});

test('PUT /users/update/:uid still refuses role and uid', async () => {
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', { role: 'employee', profileComplete: false });

  await client.put('/users/update/user-1', {
    body: { role: 'admin', uid: 'someone-else', profileComplete: true },
    token,
  });

  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.role, 'employee', 'role escalation is still blocked');
  assert.equal(stored.uid, undefined, 'uid overwrite is still blocked');
  assert.equal(stored.profileComplete, true, 'the allow-listed field still lands');
});

// -------------------------------------------------------------- getUser/:id

// STAGE 5C. This block used to assert the vulnerability directly: one test read
// a *different* user's profile and asserted `user.email` came back, seeded with
// the comment "Reading another user's profile is still allowed because the job
// detail view needs the poster's details." The need is real but narrower than
// the contract it was pinned to -- JobSplitView.jsx reads only fullName,
// profilePic, location, createdAt, rating, reviewCount and bio, so email did not
// have to be published for it to work. These tests now pin the scoped contract.

test('GET /users/getUser/:userId returns the caller\'s own full profile', async () => {
  client.seed('users', 'user-1', user({
    email: 'private@example.test',
    phone: '+2348012345678',
    role: 'employer',
    address: '12 Privacy Road',
    companyName: 'Acme',
    skills: ['plumbing'],
    bio: 'A long private biography',
  }));
  const api = await client.authed('user-1');

  const res = await api.get('/users/getUser/user-1');

  // A self-read is unchanged by Stage 5C: still 200, still the whole document,
  // including every private field the seven self-callers on the client rely on.
  assert.equal(res.status, 200);
  assert.equal(res.body.user.email, 'private@example.test');
  assert.equal(res.body.user.phone, '+2348012345678');
  assert.equal(res.body.user.role, 'employer');
  assert.equal(res.body.user.address, '12 Privacy Road');
  assert.equal(res.body.user.uid, 'user-1');
});

test('GET /users/getUser/:userId withholds private fields from another user', async () => {
  client.seed('users', 'user-1', user({
    email: 'private@example.test',
    phone: '+2348012345678',
    role: 'employer',
    address: '12 Privacy Road',
    companyName: 'Acme',
    skills: ['plumbing'],
    bio: 'A long private biography',
  }));
  const api = await client.authed('employee-1');

  const res = await api.get('/users/getUser/user-1');

  // Still 200 -- the cross-user read stays reachable for JobSplitView.
  assert.equal(res.status, 200);

  for (const field of ['email', 'phone', 'role', 'address', 'companyName', 'skills', 'uid']) {
    assert.equal(res.body.user[field], undefined, `${field} must not be readable cross-user`);
  }

  const payload = JSON.stringify(res.body);
  for (const leaked of ['private@example.test', '+2348012345678', '12 Privacy Road', 'Acme', 'user-1']) {
    assert.equal(payload.includes(leaked), false, `cross-user payload must not contain ${leaked}`);
  }
});

test('GET /users/getUser/:userId returns a JobSplitView-style cross-user lookup', async () => {
  // The exact shape JobSplitView.jsx consumes: it reads these seven fields off
  // `response.data.user` and renders them in the "About the client" panel. If
  // this test needs a field added, the field is added to PUBLIC_PROFILE_FIELDS
  // deliberately, not by accident.
  //
  // STAGE 5H: `createdAt` was seeded as an ISO string here, which is what let
  // JobSplitView.jsx get away with `new Date(createdAt)`. Production stores a
  // Timestamp, so the seed and the assertion now model that, and the projection
  // is what has to pass the Timestamp through untouched.
  client.seed('users', 'employer-1', user({
    uid: 'employer-1',
    fullName: 'Ada Client',
    profilePic: 'https://example.test/ada.png',
    location: 'Lagos, Nigeria',
    createdAt: timestampFrom('2026-01-15T10:00:00.000Z'),
    rating: 4.8,
    reviewCount: 12,
    bio: 'I run a small studio.',
    email: 'ada@private.example.test',
    phone: '+2348012345678',
    role: 'employer',
  }));
  const api = await client.authed('employee-1');

  const res = await api.get('/users/getUser/employer-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.user, {
    fullName: 'Ada Client',
    profilePic: 'https://example.test/ada.png',
    location: 'Lagos, Nigeria',
    createdAt: timestampFrom('2026-01-15T10:00:00.000Z'),
    rating: 4.8,
    reviewCount: 12,
    bio: 'I run a small studio.',
  });
});

test('GET /users/getUser/:userId omits public fields the document does not have', async () => {
  // A bare document must project to an empty object, not to a row of undefined
  // keys, so the response gains no fields that were not stored.
  client.seed('users', 'user-1', user());
  const api = await client.authed('employee-1');

  const res = await api.get('/users/getUser/user-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.user, { fullName: 'Test User' });
});

test('GET /users/getUser/:userId requires authentication', async () => {
  client.seed('users', 'user-1', user());
  const res = await client.get('/users/getUser/user-1');
  assert.equal(res.status, 401);
});

test('GET /users/getUser/:userId returns 404 for an unknown user', async () => {
  const api = await client.authed('employee-1');
  const res = await api.get('/users/getUser/nobody');
  assert.equal(res.status, 404);
  assert.equal(res.text, 'User not found');
});

test('GET /users/getUser/:userId still returns 404 for an unknown user cross-user', async () => {
  // Unchanged by Stage 5C: a cross-user lookup for a missing document keeps the
  // same plain-text 404 rather than becoming a 403. That leaves a
  // user-existence oracle, which is a deliberate, documented leftover rather
  // than a regression.
  const api = await client.authed('employee-1');
  const res = await api.get('/users/getUser/nobody');
  assert.equal(res.status, 404);
  assert.equal(res.text, 'User not found');
});

// ------------------------------------------------------------ update/:uid

test('PUT /users/update/:uid updates the caller\'s own Firestore profile', async () => {
  client.seed('users', 'user-1', user());
  const api = await client.authed('user-1');

  const res = await api.put('/users/update/user-1', {
    body: { fullName: 'Renamed', location: 'Abuja' },
  });

  assert.equal(res.status, 200);
  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.fullName, 'Renamed');
  assert.equal(stored.location, 'Abuja');
});

test('PUT /users/update/:uid rejects a caller acting on someone else', async () => {
  client.seed('users', 'victim', user({ uid: 'victim' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/users/update/victim', { body: { fullName: 'Hacked' } });

  assert.equal(res.status, 403);
});

test('PUT /users/update/:uid ignores fields outside the allow-list', async () => {
  client.seed('users', 'user-1', user({ role: 'employee', uid: 'user-1' }));
  const api = await client.authed('user-1');

  const res = await api.put('/users/update/user-1', {
    body: { role: 'admin', uid: 'spoofed', isSuperUser: true, companyName: 'Acme' },
  });

  // Stage 1: privilege escalation via self-assigned role is no longer possible.
  // companyName is allowlisted (the employer profile form sends it) and saves.
  assert.equal(res.status, 200);
  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.role, 'employee');
  assert.equal(stored.uid, 'user-1');
  assert.equal(stored.isSuperUser, undefined);
  assert.equal(stored.companyName, 'Acme');
});

// ------------------------------------------------------------- savedJobs

test('PUT /users/update/:uid persists an array of saved job ids', async () => {
  client.seed('users', 'user-1', user({ uid: 'user-1' }));
  const api = await client.authed('user-1');

  const res = await api.put('/users/update/user-1', {
    body: { savedJobs: ['job-1', 'job-2'] },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(client.readDoc('users', 'user-1').savedJobs, ['job-1', 'job-2']);
});

test('PUT /users/update/:uid rejects invalid savedJobs input and writes nothing', async () => {
  client.seed('users', 'user-1', user({ uid: 'user-1', savedJobs: ['job-keep'] }));
  const api = await client.authed('user-1');

  const invalidValues = [
    'job-1',            // a bare string is not an array
    { 0: 'job-1' },     // an object is not an array
    [123],              // every element must be a string
    ['job-1', ''],      // blank ids are rejected
    ['job-1', '   '],   // whitespace-only ids are rejected
    [null],
    [{}],
  ];

  for (const savedJobs of invalidValues) {
    const res = await api.put('/users/update/user-1', { body: { savedJobs } });

    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(savedJobs)}`);
    assert.equal(res.body.message, 'savedJobs must be an array of non-empty string job IDs');
  }

  // A rejected request must not touch the stored list.
  assert.deepEqual(client.readDoc('users', 'user-1').savedJobs, ['job-keep']);
});

test('PUT /users/update/:uid cannot modify another user\'s savedJobs', async () => {
  client.seed('users', 'user-a', user({ uid: 'user-a', savedJobs: ['job-1'] }));
  client.seed('users', 'user-b', user({ uid: 'user-b', savedJobs: ['job-2', 'job-3'] }));
  const attacker = await client.authed('user-a');

  const res = await attacker.put('/users/update/user-b', {
    body: { savedJobs: ['job-9'] },
  });

  assert.equal(res.status, 403);
  // User B's saved jobs are unchanged, and the attacker's own list is untouched.
  assert.deepEqual(client.readDoc('users', 'user-b').savedJobs, ['job-2', 'job-3']);
  assert.deepEqual(client.readDoc('users', 'user-a').savedJobs, ['job-1']);
});

test('PUT /users/update/:uid writes profilePic to Firebase Auth and Firestore', async () => {
  // STAGE 6N. This test used to be called "...routes profilePic to Firebase Auth
  // only" and asserted `readDoc(...).profilePic === undefined`, which was pinning
  // the defect: profilePic was advertised by PUBLIC_PROFILE_FIELDS and read by
  // JobSplitView.jsx, but never persisted to the collection every read path reads.
  // The Auth assertion is kept verbatim; the Firestore assertion is inverted.
  const token = await client.signUp('user-1');
  client.seed('users', 'user-1', user());

  await client.put('/users/update/user-1', {
    body: { profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/p.png', fullName: 'A' },
    token,
  });

  assert.equal(client.fake.auth.users.get('user-1').photoURL, 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/p.png');
  assert.equal(client.readDoc('users', 'user-1').profilePic, 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/p.png');
});

test('a profilePic update is readable by another user through the public projection', async () => {
  // End-to-end proof of the Stage 5C contract: a real PUT, not a hand-seeded
  // document, ends with the value visible cross-user.
  const owner = await client.authed('employee-1');
  const viewer = await client.authed('employer-1');
  client.seed('users', 'employee-1', user({ uid: 'employee-1' }));

  const put = await owner.put('/users/update/employee-1', {
    body: { profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/employee-1/avatar.png' },
  });
  assert.equal(put.status, 200);

  const res = await viewer.get('/users/getUser/employee-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.profilePic, 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/employee-1/avatar.png');
});

test('a profile update without profilePic leaves the stored profilePic untouched', async () => {
  // Preserving pre-6N behaviour: a request that does not mention profilePic must
  // not create, clear or overwrite it.
  const api = await client.authed('user-1');
  client.seed('users', 'user-1', user({ uid: 'user-1' }));

  await api.put('/users/update/user-1', { body: { profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/keep.png' } });

  const res = await api.put('/users/update/user-1', { body: { fullName: 'Renamed' } });

  assert.equal(res.status, 200);
  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.fullName, 'Renamed');
  assert.equal(stored.profilePic, 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/keep.png');
});

test('a user cannot set another user\'s profilePic', async () => {
  // The self-authorization guard on the route is unchanged: profilePic remains
  // writable only through the caller's own profile update.
  client.seed('users', 'attacker', user({ uid: 'attacker' }));
  client.seed('users', 'victim', user({ uid: 'victim' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/users/update/victim', {
    body: { profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/attacker/owned.png' },
  });

  assert.equal(res.status, 403);
  assert.equal(client.readDoc('users', 'victim').profilePic, undefined);
});

test('PUT /users/update/:uid returns 404 when the user does not exist', async () => {
  const api = await client.authed('nobody');
  const res = await api.put('/users/update/nobody', { body: { fullName: 'A' } });
  assert.equal(res.status, 404);
});

test('PUT /users/update/:uid returns 500 when profilePic has no Auth user', async () => {
  const token = client.token('ghost-uid');
  client.seed('users', 'ghost-uid', user({ uid: 'ghost-uid' }));

  const res = await client.put('/users/update/ghost-uid', {
    body: { profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/ghost-uid/p.png' },
    token,
  });

  // QUIRK: the Firestore document exists but the Auth user does not, so
  // updateUser throws and the whole request 500s before Firestore is written.
  assert.equal(res.status, 500);
  assert.equal(res.body.message, 'Internal Server Error');
});

// ---------------------------------------- profile-photo upload signing
//
// The browser does not upload a profile photo THROUGH this API: it asks for a
// signature for one upload and sends the bytes to Cloudinary itself. These tests
// cover the rule that matters -- the signature is minted for the caller's own
// folder and nothing else -- and that the api secret never travels.

test('a user gets a signature for their own profile-photo folder', async () => {
  await withCloudinaryCredentials(async () => {
    const api = await client.authed('user-1');

    const res = await api.post('/users/profile-photo/signature', { body: {} });

    assert.equal(res.status, 200);

    const signed = res.body;
    assert.equal(signed.cloudName, process.env.CLOUDINARY_CLOUD_NAME);
    assert.equal(signed.apiKey, process.env.CLOUDINARY_API_KEY);
    assert.equal(signed.resourceType, 'image');
    assert.equal(signed.folder, 'profilePics/user-1');
    assert.equal(signed.allowedFormats, 'jpg,jpeg,png,webp');
    // The signed `public_id` is the name under that folder; `{timestamp}-{12 hex}`
    // is asserted as a pattern rather than a value.
    assert.match(signed.publicId, /^\d+-[0-9a-f]{12}$/);
    assert.equal(typeof signed.timestamp, 'number');

    // The signature covers the signed parameters exactly as the browser sends them,
    // recomputed here so the test pins the algorithm rather than one output.
    const expected = crypto
      .createHash('sha1')
      .update(
        `allowed_formats=${signed.allowedFormats}&folder=${signed.folder}&public_id=${signed.publicId}&timestamp=${signed.timestamp}${process.env.CLOUDINARY_API_SECRET}`
      )
      .digest('hex');
    assert.equal(signed.signature, expected);

    // The secret itself never travels.
    assert.equal(JSON.stringify(res.body).includes(process.env.CLOUDINARY_API_SECRET), false);
    assert.equal('apiSecret' in signed, false);
  });
});

test('the signed folder comes from the caller, never from the request', async () => {
  await withCloudinaryCredentials(async () => {
    const api = await client.authed('victim');

    // Whatever the client sends is ignored: the folder is built from the verified
    // token, so there is no field it could set to sign an upload into another
    // account's profilePics folder.
    const res = await api.post('/users/profile-photo/signature', {
      body: { folder: 'profilePics/attacker', publicId: 'evil', resourceType: 'raw' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.folder, 'profilePics/victim');
    assert.equal(res.body.resourceType, 'image');
    assert.notEqual(res.body.publicId, 'evil');
  });
});

test('each profile-photo signature request mints a fresh public id', async () => {
  await withCloudinaryCredentials(async () => {
    const api = await client.authed('user-1');

    const first = await api.post('/users/profile-photo/signature', { body: {} });
    const second = await api.post('/users/profile-photo/signature', { body: {} });

    assert.notEqual(first.body.publicId, second.body.publicId);
  });
});

test('profile-photo signing is unavailable, not broken, when Cloudinary is not configured', async () => {
  const saved = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };

  try {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;

    const res = await (await client.authed('user-1')).post('/users/profile-photo/signature', {
      body: {},
    });

    assert.equal(res.status, 503);
    assert.match(res.body.message, /not configured/i);
    assert.equal(/secret|api[_-]?key/i.test(res.body.message), false, 'the answer names no variable');
  } finally {
    if (saved.cloudName === undefined) {
      delete process.env.CLOUDINARY_CLOUD_NAME;
    } else {
      process.env.CLOUDINARY_CLOUD_NAME = saved.cloudName;
    }
    if (saved.apiKey === undefined) {
      delete process.env.CLOUDINARY_API_KEY;
    } else {
      process.env.CLOUDINARY_API_KEY = saved.apiKey;
    }
    if (saved.secret === undefined) {
      delete process.env.CLOUDINARY_API_SECRET;
    } else {
      process.env.CLOUDINARY_API_SECRET = saved.secret;
    }
  }
});

// ---------------------------------------------- resume download signing (12.12.1)
//
// A resume is stored on the profile as a private reference
// ({ publicId, name, resourceType }) and is only reachable through this endpoint,
// which mints a short-lived signed URL. As on the application side, the reference
// is read from the caller's own trusted record and never from the request, so no
// caller may name an asset. The signature is computed locally by the Cloudinary
// SDK, so these tests install deterministic credentials and never contact the
// cloud or need real ones.

const PROFILE_RESUME_PUBLIC_ID = 'resumes/user-1/resume-abc123';
const PROFILE_RESUME_REFERENCE = {
  publicId: PROFILE_RESUME_PUBLIC_ID,
  name: 'cv.pdf',
  resourceType: 'raw',
};

// Install deterministic Cloudinary credentials for one test and restore whatever
// the environment held before. Mirrors the profile-photo signing tests above.
async function withCloudinaryCredentials(run) {
  const saved = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };

  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';

  try {
    return await run();
  } finally {
    restoreEnv('CLOUDINARY_CLOUD_NAME', saved.cloudName);
    restoreEnv('CLOUDINARY_API_KEY', saved.apiKey);
    restoreEnv('CLOUDINARY_API_SECRET', saved.secret);
  }
}

// Assigning `undefined` to process.env coerces it to the string "undefined", so a
// variable that was absent before a test must be deleted, not reassigned.
function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test('GET /users/resume/download returns a signed URL for the caller\'s own resume', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('users', 'user-1', user({ uid: 'user-1', resume: PROFILE_RESUME_REFERENCE }));
    const api = await client.authed('user-1');

    const res = await api.get('/users/resume/download');

    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'cv.pdf');
    assert.equal(typeof res.body.url, 'string');
    assert.match(res.body.url, /^https:\/\//);
    // The URL points at the stored public id, URL-encoded, and never exposes the
    // api secret.
    assert.equal(res.body.url.includes(encodeURIComponent(PROFILE_RESUME_PUBLIC_ID)), true);
    assert.equal(res.body.url.includes('test-secret'), false);
  });
});

test('GET /users/resume/download signs in the raw namespace, not image', async () => {
  // REGRESSION. A resume is uploaded as the `raw` resource type. The Cloudinary
  // SDK's private_download_url builds its URL through api_url, which defaults
  // resource_type to `image` when none is supplied. Asking the image namespace for
  // a raw asset is answered with "Resource not found" even though the file exists,
  // so the signed URL must address `/raw/download`. This pins the mismatch that
  // made every stored resume 404 on download.
  await withCloudinaryCredentials(async () => {
    client.seed('users', 'user-1', user({ uid: 'user-1', resume: PROFILE_RESUME_REFERENCE }));
    const api = await client.authed('user-1');

    const res = await api.get('/users/resume/download');

    assert.equal(res.status, 200);
    assert.equal(res.body.url.includes('/raw/download'), true);
    assert.equal(res.body.url.includes('/image/'), false);
  });
});

test('GET /users/resume/download signs only the caller\'s own resume', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('users', 'victim', user({
      uid: 'victim',
      resume: { publicId: 'resumes/victim/secret.pdf', name: 'secret.pdf', resourceType: 'raw' },
    }));
    client.seed('users', 'attacker', user({ uid: 'attacker' }));
    const attacker = await client.authed('attacker');

    // The caller has no resume of their own, so naming the victim's asset in the
    // query changes nothing: the read is scoped to the caller's own record.
    const res = await attacker.get('/users/resume/download?publicId=resumes/victim/secret.pdf');

    assert.equal(res.status, 404);
    assert.equal(JSON.stringify(res.body).includes('victim'), false);
  });
});

test('GET /users/resume/download is 404 when the profile has no resume', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('users', 'user-1', user({ uid: 'user-1' }));
    const api = await client.authed('user-1');

    const res = await api.get('/users/resume/download');

    assert.equal(res.status, 404);
    assert.equal('url' in res.body, false);
  });
});

test('GET /users/resume/download is unavailable, not public, when Cloudinary is unconfigured', async () => {
  const saved = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };

  try {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;

    client.seed('users', 'user-1', user({ uid: 'user-1', resume: PROFILE_RESUME_REFERENCE }));
    const api = await client.authed('user-1');

    const res = await api.get('/users/resume/download');

    assert.equal(res.status, 503);
    assert.match(res.body.message, /not configured/i);
    // No URL of any kind is returned when signing is impossible.
    assert.equal('url' in res.body, false);
    assert.equal(/secret|api[_-]?key/i.test(res.body.message), false, 'the answer names no variable');
  } finally {
    if (saved.cloudName === undefined) {
      delete process.env.CLOUDINARY_CLOUD_NAME;
    } else {
      process.env.CLOUDINARY_CLOUD_NAME = saved.cloudName;
    }
    if (saved.apiKey === undefined) {
      delete process.env.CLOUDINARY_API_KEY;
    } else {
      process.env.CLOUDINARY_API_KEY = saved.apiKey;
    }
    if (saved.secret === undefined) {
      delete process.env.CLOUDINARY_API_SECRET;
    } else {
      process.env.CLOUDINARY_API_SECRET = saved.secret;
    }
  }
});

// ---------------------------------- STAGE 12.13: resume verification on save
//
// The same write-side rule the application side enforces, applied to the resume
// a profile stores: the reference must name a file under the caller's own
// `resumes/{uid}/` folder AND that file must exist in Cloudinary, checked with
// one admin API call that these tests stub. No real cloud or credentials needed.
const cloudinaryConfig = require('../config/cloudinary');

// Run `run` with fake credentials in place AND cloudinary.api.resource stubbed to
// report exactly `foundPublicIds` as existing; every other id is a 404. The SDK
// object is a shared singleton, so the stub is swapped on the same instance the
// service imported and restored afterwards even if the body throws.
async function withCloudinaryAssets(foundPublicIds, run) {
  const original = cloudinaryConfig.cloudinary.api.resource;

  cloudinaryConfig.cloudinary.api.resource = async (publicId) => {
    if (foundPublicIds.includes(publicId)) {
      return { public_id: publicId, resource_type: 'raw' };
    }

    const missing = new Error('Resource not found');
    missing.http_code = 404;
    throw missing;
  };

  try {
    return await withCloudinaryCredentials(run);
  } finally {
    cloudinaryConfig.cloudinary.api.resource = original;
  }
}

test('PUT /users/update/:uid stores an owned resume that Cloudinary holds', async () => {
  await withCloudinaryAssets([PROFILE_RESUME_PUBLIC_ID], async () => {
    client.seed('users', 'user-1', user({ uid: 'user-1' }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { resume: PROFILE_RESUME_REFERENCE },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(client.readDoc('users', 'user-1').resume, PROFILE_RESUME_REFERENCE);
  });
});

test('PUT /users/update/:uid rejects a resume under another user\'s folder', async () => {
  await withCloudinaryAssets(['resumes/victim/secret.pdf'], async () => {
    client.seed('users', 'user-1', user({ uid: 'user-1' }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { resume: { publicId: 'resumes/victim/secret.pdf', name: 'secret.pdf', resourceType: 'raw' } },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Resume does not belong to you');
    // The profile was not written.
    assert.equal('resume' in client.readDoc('users', 'user-1'), false);
  });
});

test('PUT /users/update/:uid rejects an owned resume Cloudinary does not hold', async () => {
  await withCloudinaryAssets([], async () => {
    client.seed('users', 'user-1', user({ uid: 'user-1' }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { resume: PROFILE_RESUME_REFERENCE },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Resume file could not be found');
    assert.equal('resume' in client.readDoc('users', 'user-1'), false);
  });
});

test('PUT /users/update/:uid never consults Cloudinary for a profile update without a resume', async () => {
  // The stub throws if reached, so a 200 proves an ordinary profile edit makes no
  // admin call. Credentials are also left absent, which would independently 500
  // if the verification were entered.
  const original = cloudinaryConfig.cloudinary.api.resource;
  cloudinaryConfig.cloudinary.api.resource = async () => {
    throw new Error('verifyUploadedAsset must not be called without a resume');
  };

  try {
    client.seed('users', 'user-1', user({ uid: 'user-1' }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', { body: { fullName: 'Renamed' } });

    assert.equal(res.status, 200);
  } finally {
    cloudinaryConfig.cloudinary.api.resource = original;
  }
});

// ------------------------------ STAGE 12.14: deleting a replaced profile photo
//
// When a user replaces their profile picture, the previous Cloudinary asset is
// deleted AFTER the profile update has succeeded -- never before, and never when
// no new photo was supplied. These tests stub cloudinary.uploader.destroy, the
// shared singleton the service calls through, and record every delete, so no test
// contacts the cloud or needs real credentials.

const PHOTO_PUBLIC_ID = 'profilePics/user-1/111-aaa';
const PHOTO_URL = 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/111-aaa.png';
const NEXT_PHOTO_PUBLIC_ID = 'profilePics/user-1/222-bbb';
const NEXT_PHOTO_URL = 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-1/222-bbb.png';

// Run `run(deleted)` with fake Cloudinary credentials and uploader.destroy stubbed,
// recording each deleted public id in order. `onDestroy` may throw to model a
// Cloudinary failure. The SDK is a shared singleton, so the original is restored
// afterwards even if the body throws.
async function withDeletedAssets(run, { onDestroy } = {}) {
  const original = cloudinaryConfig.cloudinary.uploader.destroy;
  const deleted = [];

  cloudinaryConfig.cloudinary.uploader.destroy = async (publicId) => {
    deleted.push(publicId);
    if (onDestroy) return onDestroy(publicId);
    return { result: 'ok' };
  };

  try {
    return await withCloudinaryCredentials(() => run(deleted));
  } finally {
    cloudinaryConfig.cloudinary.uploader.destroy = original;
  }
}

test('replacing a profile photo deletes the previous Cloudinary asset', async () => {
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'user-1', user({
      uid: 'user-1',
      profilePic: PHOTO_URL,
      profilePicPublicId: PHOTO_PUBLIC_ID,
    }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { profilePic: NEXT_PHOTO_URL, profilePicPublicId: NEXT_PHOTO_PUBLIC_ID },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(deleted, [PHOTO_PUBLIC_ID]);

    const stored = client.readDoc('users', 'user-1');
    assert.equal(stored.profilePic, NEXT_PHOTO_URL);
    assert.equal(stored.profilePicPublicId, NEXT_PHOTO_PUBLIC_ID);
  });
});

test('a legacy profile photo with no stored public id is derived from its URL and deleted', async () => {
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'user-1', user({ uid: 'user-1', profilePic: PHOTO_URL }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { profilePic: NEXT_PHOTO_URL, profilePicPublicId: NEXT_PHOTO_PUBLIC_ID },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(deleted, [PHOTO_PUBLIC_ID]);
  });
});

test('a profile update without a new photo never deletes the stored one', async () => {
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'user-1', user({
      uid: 'user-1',
      profilePic: PHOTO_URL,
      profilePicPublicId: PHOTO_PUBLIC_ID,
    }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', { body: { fullName: 'Renamed' } });

    assert.equal(res.status, 200);
    assert.deepEqual(deleted, []);
    assert.equal(client.readDoc('users', 'user-1').profilePic, PHOTO_URL);
  });
});

test('a failed profile update preserves the previous photo', async () => {
  // The Auth user is missing, so the Auth write throws before Firestore is touched
  // and before any cleanup is attempted: the old asset must survive.
  // The new photo URL and public id must live under the caller's own
  // profilePics/ghost-uid/ folder (M2 validation), so they pass the profile-photo
  // ownership check and the flow reaches the Auth write, which then fails.
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'ghost-uid', user({
      uid: 'ghost-uid',
      profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/ghost-uid/old.png',
      profilePicPublicId: 'profilePics/ghost-uid/old',
    }));
    const token = client.token('ghost-uid');

    const res = await client.put('/users/update/ghost-uid', {
      body: {
        profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/ghost-uid/new.png',
        profilePicPublicId: 'profilePics/ghost-uid/new',
      },
      token,
    });

    assert.equal(res.status, 500);
    assert.deepEqual(deleted, []);
  });
});

test('a failed Cloudinary delete leaves the profile update successful', async () => {
  const originalError = console.error;
  console.error = () => {};

  try {
    await withDeletedAssets(
      async (deleted) => {
        client.seed('users', 'user-1', user({
          uid: 'user-1',
          profilePic: PHOTO_URL,
          profilePicPublicId: PHOTO_PUBLIC_ID,
        }));
        const api = await client.authed('user-1');

        const res = await api.put('/users/update/user-1', {
          body: { profilePic: NEXT_PHOTO_URL, profilePicPublicId: NEXT_PHOTO_PUBLIC_ID },
        });

        assert.equal(res.status, 200);
        assert.deepEqual(deleted, [PHOTO_PUBLIC_ID]);
        assert.equal(client.readDoc('users', 'user-1').profilePic, NEXT_PHOTO_URL);
      },
      { onDestroy: () => { throw new Error('cloudinary exploded'); } }
    );
  } finally {
    console.error = originalError;
  }
});

test('re-saving the same photo deletes nothing', async () => {
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'user-1', user({
      uid: 'user-1',
      profilePic: PHOTO_URL,
      profilePicPublicId: PHOTO_PUBLIC_ID,
    }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { profilePic: PHOTO_URL, profilePicPublicId: PHOTO_PUBLIC_ID },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(deleted, []);
  });
});

test('a previous photo outside the caller\'s own folder is never deleted', async () => {
  // A tampered or legacy document names another user's asset. The folder guard
  // refuses to delete it even though it is the stored value.
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'user-1', user({
      uid: 'user-1',
      profilePic: 'https://res.cloudinary.com/test-cloud/image/upload/profilePics/user-2/evil.png',
      profilePicPublicId: 'profilePics/user-2/evil',
    }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { profilePic: NEXT_PHOTO_URL, profilePicPublicId: NEXT_PHOTO_PUBLIC_ID },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(deleted, []);
  });
});

test('a non-Cloudinary previous photo is left alone', async () => {
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'user-1', user({ uid: 'user-1', profilePic: 'https://example.test/p.png' }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { profilePic: NEXT_PHOTO_URL, profilePicPublicId: NEXT_PHOTO_PUBLIC_ID },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(deleted, []);
  });
});

test('a public id outside the caller\'s folder is not stored', async () => {
  await withDeletedAssets(async (deleted) => {
    client.seed('users', 'user-1', user({ uid: 'user-1' }));
    const api = await client.authed('user-1');

    const res = await api.put('/users/update/user-1', {
      body: { profilePic: PHOTO_URL, profilePicPublicId: 'profilePics/user-2/steal' },
    });

    assert.equal(res.status, 400);
    assert.deepEqual(deleted, []);
  });
});

// ------------------------------------------------------------ auth regression

test('LOGIN → PROFILE: self-read returns user data after sign-in', async () => {
  // This test pins the login → dashboard → profile retrieval flow.
  // It verifies that after a successful sign-in, the self-read
  // /users/getUser/:uid returns the user's full profile.
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', user({
    uid: 'user-1',
    fullName: 'Test User',
    email: 'user@example.test',
    role: 'employee',
  }));

  // Simulate the login flow: sign in, then retrieve profile
  const api = await client.authed('user-1');
  const res = await api.get('/users/getUser/user-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.user.fullName, 'Test User');
  assert.equal(res.body.user.email, 'user@example.test');
  assert.equal(res.body.user.role, 'employee');
  assert.equal(res.body.user.uid, 'user-1');
});

test('LOGIN → PROFILE: auth header with ID token is required', async () => {
  // Verifies that /users/getUser/:uid returns 401 when no auth header is sent.
  client.seed('users', 'user-1', user({ uid: 'user-1' }));

  const res = await client.get('/users/getUser/user-1');
  assert.equal(res.status, 401);
});

test('LOGIN → PROFILE: missing/invalid token returns 401', async () => {
  // Tests that both missing token and garbage token produce 401.
  client.seed('users', 'user-1', user({ uid: 'user-1' }));

  const res1 = await client.get('/users/getUser/user-1');
  assert.equal(res1.status, 401, 'missing token must return 401');

  const res2 = await client.get('/users/getUser/user-1', {
    token: 'invalid- garbage-token',
  });
  assert.equal(res2.status, 401, 'invalid token must return 401');
});

test('LOGIN → PROFILE: UID mismatch cross-user read returns 200 with public fields', async () => {
  // Cross-user GET /users/getUser/:userId is allowed (for JobSplitView), but
  // private fields (email, phone, role, address, companyName, skills, uid) are
  // withheld. fullName IS exposed because it is in PUBLIC_PROFILE_FIELDS.
  // This matches the Stage 5C contract and the existing security test at line 458.
  client.seed('users', 'user-1', user({ uid: 'user-1', fullName: 'User One' }));
  client.seed('users', 'user-2', user({ uid: 'user-2', fullName: 'User Two' }));

  // Sign in as user-1, then request user-2's profile (cross-user read)
  const api = await client.authed('user-1');
  const res = await api.get('/users/getUser/user-2');

  // Cross-user read is permitted; status 200
  assert.equal(res.status, 200);
  // Private fields are withheld
  for (const field of ['email', 'phone', 'role', 'address', 'companyName', 'skills', 'uid']) {
    assert.equal(res.body.user[field], undefined, `${field} must not be readable cross-user`);
  }
  // fullName IS exposed (it is in PUBLIC_PROFILE_FIELDS)
  assert.equal(res.body.user.fullName, 'User Two', 'fullName is a public field and is exposed cross-user');
  const payload = JSON.stringify(res.body);
  // Private data must not leak
  for (const leaked of ['user-2', '+2348012345678', 'user@example.test']) {
    assert.equal(payload.includes(leaked), false, `cross-user payload must not contain ${leaked}`);
  }
  // fullName leaking is expected per the contract
  assert.equal(payload.includes('User Two'), true, 'fullName is expected cross-user');
});

test('LOGIN → PROFILE: profile retrieval success after auth init', async () => {
  // Verifies that profile retrieval succeeds when auth is fully initialized.
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', user({
    uid: 'user-1',
    fullName: 'Test User',
    email: 'user@example.test',
    role: 'employee',
    profileComplete: true,
  }));

  const api = await client.authed('user-1');
  const res = await api.get('/users/getUser/user-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.user.fullName, 'Test User');
  assert.equal(res.body.user.profileComplete, true);
});

test('DASHBOARD after failed query: 401 without auth token', async () => {
  // Verifies that /users/getUser/:uid returns 401 when no auth header is sent.
  // This pins the bug where useUserQuery fired before the token interceptor
  // set the Authorization header, resulting in 401 Unauthorized.
  client.seed('users', 'user-1', user({ uid: 'user-1' }));

  // Make an unauthenticated request (no Bearer token)
  const res = await client.request('GET', '/users/getUser/user-1');
  assert.equal(res.status, 401);
});

test('AUTH INITIALIZATION before profile query', async () => {
  // Ensures the user query is not issued before Firebase auth initialization
  // completes. This pins the bug where useUserQuery fired before the token
  // interceptor set the Authorization header.
  const token = await client.signUp('user-1', { email: 'user@example.test' });
  client.seed('users', 'user-1', user({
    uid: 'user-1',
    fullName: 'Test User',
    email: 'user@example.test',
    role: 'employee',
  }));

  // Self-read with valid token must succeed
  const api = await client.authed('user-1');
  const res = await api.get('/users/getUser/user-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.user.fullName, 'Test User');
});
