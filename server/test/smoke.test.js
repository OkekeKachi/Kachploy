'use strict';

/**
 * Smoke test for the harness itself. Confirms that:
 *  - the real app.js boots under the fake Firebase double,
 *  - a seeded document is readable through a real route handler,
 *  - a write through a real route reaches the fake store,
 *  - the auth middleware rejects missing/invalid tokens and accepts a valid one.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');

test('harness: app boots and serves seeded data through real routes', async (t) => {
  const client = await startTestServer();
  t.after(async () => {
    await client.close();
  });

  await client.seed('jobs', 'job-1', {
    title: 'Fix the sink',
    description: 'Leaking tap',
    location: 'Lagos',
    jobType: 'plumbing',
    applicationDeadline: '2026-10-01',
    jobStartDate: '2026-10-05',
    price: 5000,
    negotiable: 'yes',
    status: 'open',
    postedBy: 'employer-2',
    skillsRequired: ['leaks'],
    requirements: ['own tools'],
    responsibilities: ['diagnose'],
  });

  // Every route requires a token since Stage 1.
  const api = await client.authed('employer-2');

  const list = await api.get('/jobs');
  assert.equal(list.status, 200);
  assert.equal(list.body.jobs.length, 1);
  assert.equal(list.body.jobs[0].id, 'job-1');

  const single = await api.get('/jobs/job-1');
  assert.equal(single.status, 200);
  assert.equal(single.body.job.title, 'Fix the sink');

  // Writes must persist to the fake store.
  const created = await api.post('/jobs/create', {
    body: {
      title: 'New job',
      description: 'desc',
      location: 'Abuja',
      jobType: 'cleaning',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 100,
      postedBy: 'someone-else',
    },
  });
  assert.equal(created.status, 201);
  assert.ok(created.body.jobId);
  assert.equal(client.readDoc('jobs', created.body.jobId).title, 'New job');
  // Identity comes from the token, not the body.
  assert.equal(client.readDoc('jobs', created.body.jobId).postedBy, 'employer-2');

  // Auth middleware: no token -> 401; unknown token -> 401; valid token -> 200.
  const body = { fullName: 'Ade', phone: '08012345678', role: 'employer' };

  const noToken = await client.post('/users/register', { body });
  assert.equal(noToken.status, 401);
  assert.equal(noToken.text, 'Unauthorized');

  const badToken = await client.post('/users/register', { body, token: 'not-a-real-token' });
  assert.equal(badToken.status, 401);
  assert.equal(badToken.text, 'Invalid token');

  const goodToken = await client.post('/users/register', { body, token: api.token });
  assert.equal(goodToken.status, 200);
  assert.equal(goodToken.text, 'User registered successfully');
  assert.equal(client.readDoc('users', 'employer-2').role, 'employer');

  // Hard guarantee: the real admin SDK was never initialised.
  assert.equal(
    client.fake.store.calls.some((c) => c.op === 'initializeApp'),
    false
  );
});
