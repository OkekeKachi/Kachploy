'use strict';

/**
 * STAGE 13 (H2). Server-side email-verification enforcement.
 *
 * Before this stage the only thing standing between an unverified account and the
 * API was the client's /verify-email route. Firebase issues a valid ID token the
 * moment an account is created -- before any verification link is clicked -- so a
 * caller who skipped the client could present a genuine token and be treated as a
 * full user. `protect` now also requires the signed `email_verified` claim. These
 * tests pin that behaviour and its boundaries:
 *
 *   - a verified caller is admitted, on both a `protect`-only route and a guarded one;
 *   - an unverified caller is refused with the same JSON 403 shape the other
 *     authorization guards already use;
 *   - the refusal is decided by the claim, not by any role the caller names;
 *   - missing and invalid bearer tokens keep their existing 401s (unchanged);
 *   - and POST /users/register -- the one route needed to complete the flow --
 *     stays reachable while unverified, so enforcement cannot strand a verified
 *     account with no profile document.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');

let client;

test.before(async () => {
  client = await startTestServer();
});

test.after(async () => {
  await client.close();
});

test.beforeEach(() => {
  client.fake.resetAll();
});

const EMAIL_VERIFICATION_REQUIRED = 'Email verification required';

// ------------------------------------------------------------- verified callers

test('a verified user can use a protect-only endpoint', async () => {
  const api = await client.authed('user-1');

  const res = await api.get('/jobs');

  assert.equal(res.status, 200);
});

test('a verified user can use a guarded endpoint', async () => {
  const api = await client.authed('employee-1');

  const res = await api.get('/applications/counts');

  assert.equal(res.status, 200);
});

// ----------------------------------------------------------- unverified callers

test('an unverified user is refused on a protect-only endpoint', async () => {
  const token = client.token('user-1', { email_verified: false });

  const res = await client.request('GET', '/jobs', { token });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, EMAIL_VERIFICATION_REQUIRED);
});

test('an unverified user is refused on a guarded endpoint too', async () => {
  const token = client.token('employee-1', { email_verified: false });

  const res = await client.request('GET', '/applications/counts', { token });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, EMAIL_VERIFICATION_REQUIRED);
});

test('the refusal is independent of any role the caller names', async () => {
  // `role` here stands in for anything a caller could try to claim about
  // themselves: enforcement reads the signed `email_verified` claim only, so an
  // unverified caller naming the most privileged role available is still refused.
  const token = client.token('attacker', { email_verified: false, role: 'admin' });

  const res = await client.request('GET', '/jobs', { token });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, EMAIL_VERIFICATION_REQUIRED);
});

// ------------------------------------------------------------ token edge cases

test('a missing bearer token is still a 401', async () => {
  const res = await client.request('GET', '/jobs');

  assert.equal(res.status, 401);
});

test('an invalid bearer token is still a 401', async () => {
  const res = await client.request('GET', '/jobs', { token: 'not-a-real-token' });

  assert.equal(res.status, 401);
});

// ----------------------------------------------- verification-flow compatibility

test('an unverified user can still complete registration', async () => {
  // The client calls POST /users/register immediately after the email is
  // confirmed; the freshly forced token can lag that moment, so the route must
  // remain reachable while the claim is still false for the account to finish
  // onboarding. The Auth user exists (created at signup); only the claim differs.
  await client.fake.auth.createUser({ uid: 'user-1', email: 'user-1@example.test' });
  const token = client.token('user-1', { email_verified: false });

  const res = await client.request('POST', '/users/register', {
    token,
    body: { fullName: 'A', role: 'employee' },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('users', 'user-1').role, 'employee');
});

test('a verified user can also complete registration', async () => {
  const token = await client.signUp('user-1', { email: 'user-1@example.test' });

  const res = await client.request('POST', '/users/register', {
    token,
    body: { fullName: 'A', role: 'employee' },
  });

  assert.equal(res.status, 200);
});

test('the registration-completion route still requires a token', async () => {
  const res = await client.request('POST', '/users/register', {
    body: { fullName: 'A', role: 'employee' },
  });

  assert.equal(res.status, 401);
});
