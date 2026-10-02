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

test('PUT /users/update/:uid writes profilePic to Firebase Auth and Firestore', async () => {
  // STAGE 6N. This test used to be called "...routes profilePic to Firebase Auth
  // only" and asserted `readDoc(...).profilePic === undefined`, which was pinning
  // the defect: profilePic was advertised by PUBLIC_PROFILE_FIELDS and read by
  // JobSplitView.jsx, but never persisted to the collection every read path reads.
  // The Auth assertion is kept verbatim; the Firestore assertion is inverted.
  const token = await client.signUp('user-1');
  client.seed('users', 'user-1', user());

  await client.put('/users/update/user-1', {
    body: { profilePic: 'https://example.test/p.png', fullName: 'A' },
    token,
  });

  assert.equal(client.fake.auth.users.get('user-1').photoURL, 'https://example.test/p.png');
  assert.equal(client.readDoc('users', 'user-1').profilePic, 'https://example.test/p.png');
});

test('a profilePic update is readable by another user through the public projection', async () => {
  // End-to-end proof of the Stage 5C contract: a real PUT, not a hand-seeded
  // document, ends with the value visible cross-user.
  const owner = await client.authed('employee-1');
  const viewer = await client.authed('employer-1');
  client.seed('users', 'employee-1', user({ uid: 'employee-1' }));

  const put = await owner.put('/users/update/employee-1', {
    body: { profilePic: 'https://example.test/avatar.png' },
  });
  assert.equal(put.status, 200);

  const res = await viewer.get('/users/getUser/employee-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.user.profilePic, 'https://example.test/avatar.png');
});

test('a profile update without profilePic leaves the stored profilePic untouched', async () => {
  // Preserving pre-6N behaviour: a request that does not mention profilePic must
  // not create, clear or overwrite it.
  const api = await client.authed('user-1');
  client.seed('users', 'user-1', user({ uid: 'user-1' }));

  await api.put('/users/update/user-1', { body: { profilePic: 'https://example.test/keep.png' } });

  const res = await api.put('/users/update/user-1', { body: { fullName: 'Renamed' } });

  assert.equal(res.status, 200);
  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.fullName, 'Renamed');
  assert.equal(stored.profilePic, 'https://example.test/keep.png');
});

test('a user cannot set another user\'s profilePic', async () => {
  // The self-authorization guard on the route is unchanged: profilePic remains
  // writable only through the caller's own profile update.
  client.seed('users', 'attacker', user({ uid: 'attacker' }));
  client.seed('users', 'victim', user({ uid: 'victim' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/users/update/victim', {
    body: { profilePic: 'https://example.test/owned.png' },
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
    body: { profilePic: 'https://example.test/p.png' },
    token,
  });

  // QUIRK: the Firestore document exists but the Auth user does not, so
  // updateUser throws and the whole request 500s before Firestore is written.
  assert.equal(res.status, 500);
  assert.equal(res.body.message, 'Internal Server Error');
});
