'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');

let client;

test.before(async () => {
  client = await startTestServer({ clock: () => '2026-01-01T00:00:00.000Z' });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(() => {
  client.fake.resetAll();
});

const adminToken = () => client.token('admin-1', { admin: true });
const nonAdminToken = () => client.token('not-an-admin', { admin: false });

test('every admin route refuses a missing token', async () => {
  const calls = [
    ['GET', '/admin/disputes'],
    ['GET', '/admin/reviews'],
    ['GET', '/admin/reviews/task-1'],
    ['POST', '/admin/reviews/task-1/decision'],
  ];

  for (const [method, url] of calls) {
    // A GET/HEAD request cannot carry a body -- undici rejects it before the
    // request is sent. Only the decision route is a POST, so only it gets a body.
    const options = method === 'POST' ? { body: { action: 'approve', rationale: 'x' } } : {};
    const res = await client.request(method, url, options);
    assert.equal(res.status, 401, `${method} ${url} must require a token`);
  }
});

test('a verified caller without the admin claim is refused everywhere', async () => {
  const res = await client.get('/admin/reviews', { token: nonAdminToken() });
  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'Admin access required');
});

test('a stored users.role of admin is not an authority', async () => {
  client.seed('users', 'role-admin', { uid: 'role-admin', role: 'admin' });

  const res = await client.get('/admin/disputes', {
    token: client.token('role-admin', { admin: false }),
  });

  assert.equal(res.status, 403);
});

test('the admin claim opens the read queues', async () => {
  const disputes = await client.get('/admin/disputes', { token: adminToken() });
  assert.equal(disputes.status, 200);
  assert.deepEqual(disputes.body, { disputes: [] });

  const reviews = await client.get('/admin/reviews', { token: adminToken() });
  assert.equal(reviews.status, 200);
  assert.deepEqual(reviews.body, { reviews: [] });
});

test('an admin gets a 404 for a task that does not exist, not a 403', async () => {
  const res = await client.get('/admin/reviews/missing-task', { token: adminToken() });

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Task not found');
});

test('a non-admin cannot record a decision', async () => {
  const res = await client.post('/admin/reviews/task-1/decision', {
    token: nonAdminToken(),
    body: { action: 'approve', rationale: 'I am not an admin' },
  });

  assert.equal(res.status, 403);
});

test('an admin decision still validates its body before touching the task', async () => {
  const invalidAction = await client.post('/admin/reviews/task-1/decision', {
    token: adminToken(),
    body: { action: 'refund', rationale: 'Not a supported action' },
  });
  assert.equal(invalidAction.status, 400);

  const missingRationale = await client.post('/admin/reviews/task-1/decision', {
    token: adminToken(),
    body: { action: 'approve' },
  });
  assert.equal(missingRationale.status, 400);
});

test('an employee cannot self-assign the admin role at registration', async () => {
  const authToken = await client.signUp('new-user');

  for (const role of ['admin', 'ADMIN', '  Admin  ']) {
    const res = await client.post('/users/register', {
      token: authToken,
      body: { uid: 'new-user', name: 'New User', role, email: 'new-user@example.test' },
    });

    assert.equal(res.status, 400, `${JSON.stringify(role)} must be refused`);
    assert.match(res.body.message, /cannot be self-assigned/i);
  }
});
