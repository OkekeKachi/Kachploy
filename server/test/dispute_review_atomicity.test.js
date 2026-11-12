'use strict';

/**
 * Concurrency regression tests for the two duplicate guards.
 *
 * Reviews are keyed by a deterministic document id, so `create()` is the
 * arbiter: one concurrent writer wins, the rest see ALREADY_EXISTS.
 *
 * Disputes commit the new row and a per-employment lock in one transaction;
 * competing transactions read the same lock document, so the second retries
 * and observes the first dispute still open.
 *
 * Rows written before these keys existed are covered by the services' read
 * pre-check, which is deliberately not described as atomic here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { employment, job } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;

const all = (collection) => Object.values(client.readAll(collection));
const statusOf = (responses) => responses.map((r) => r.status).sort((a, b) => a - b);

test.before(async () => {
  client = await startTestServer({ clock: () => '2026-01-01T00:00:00.000Z' });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  client.seed('employments', 'emp-1', employment());
  client.seed('jobs', 'job-1', job({ status: 'closed' }));
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

test('parallel reviews by one reviewer produce one review and one conflict', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      employerApi.post('/employments/emp-1/reviews', {
        body: { revieweeId: 'employee-1', rating: 5, comment: `attempt ${i}` },
      })
    )
  );

  assert.deepEqual(statusOf(attempts), [201, 409, 409, 409]);
  assert.equal(all('reviews').length, 1);

  const winner = attempts.find((r) => r.status === 201);
  assert.equal(winner.body.review.reviewerId, 'employer-1');
  assert.equal(winner.body.review.employmentId, 'emp-1');

  const loser = attempts.find((r) => r.status === 409);
  assert.match(loser.body.message, /already submitted a review/i);
});

test('parallel reviews by the two parties are both kept', async () => {
  const [fromEmployer, fromEmployee] = await Promise.all([
    employerApi.post('/employments/emp-1/reviews', {
      body: { revieweeId: 'employee-1', rating: 5 },
    }),
    employeeApi.post('/employments/emp-1/reviews', {
      body: { revieweeId: 'employer-1', rating: 4 },
    }),
  ]);

  assert.equal(fromEmployer.status, 201);
  assert.equal(fromEmployee.status, 201);
  assert.equal(all('reviews').length, 2);
  assert.notEqual(fromEmployer.body.review.id, fromEmployee.body.review.id);
});

test('a legacy auto-id review still blocks a new one for the same reviewer', async () => {
  client.seed('reviews', 'legacy-review', {
    employmentId: 'emp-1',
    reviewerId: 'employer-1',
    revieweeId: 'employee-1',
    rating: 3,
  });

  const res = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /already submitted a review/i);
  assert.equal(all('reviews').length, 1);
  assert.equal(client.readDoc('reviews', 'legacy-review').rating, 3);
});

test('parallel dispute creation leaves one dispute, one lock, and 409s the rest', async () => {
  const attempts = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      employerApi.post('/employments/emp-1/disputes', {
        body: { category: 'other', reason: `reason ${i}` },
      })
    )
  );

  assert.deepEqual(statusOf(attempts), [201, 409, 409, 409]);
  assert.equal(all('disputes').length, 1);
  assert.equal(all('disputeLocks').length, 1);

  const winner = attempts.find((r) => r.status === 201);
  const disputeId = winner.body.dispute.id;
  const lock = client.readDoc('disputeLocks', 'emp-1');
  assert.equal(lock.disputeId, disputeId);
  assert.equal(lock.status, 'open');
  assert.equal(client.readDoc('disputes', disputeId).status, 'open');

  const loser = attempts.find((r) => r.status === 409);
  assert.match(loser.body.message, /open dispute already exists/i);
});

test('a legacy open dispute without a lock is still refused', async () => {
  client.seed('disputes', 'legacy-open', {
    employmentId: 'emp-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    initiatedBy: 'employee-1',
    status: 'under_review',
    category: 'payment',
    reason: 'existing',
  });

  const res = await employeeApi.post('/employments/emp-1/disputes', {
    body: { category: 'scope', reason: 'new one' },
  });

  assert.equal(res.status, 409);
  assert.equal(all('disputes').length, 1);
  assert.equal(all('disputeLocks').length, 0);
});

test('a resolved legacy dispute does not block a new one, and the lock is created', async () => {
  client.seed('disputes', 'legacy-resolved', {
    employmentId: 'emp-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    initiatedBy: 'employee-1',
    status: 'resolved',
    category: 'payment',
    reason: 'settled',
  });

  const res = await employeeApi.post('/employments/emp-1/disputes', {
    body: { category: 'work_quality', reason: 'new concern' },
  });

  assert.equal(res.status, 201);
  assert.equal(all('disputes').length, 2);
  assert.equal(client.readDoc('disputes', 'legacy-resolved').status, 'resolved');

  const lock = client.readDoc('disputeLocks', 'emp-1');
  assert.equal(lock.disputeId, res.body.dispute.id);
});

test('a stale lock pointing at a resolved dispute does not block a new one', async () => {
  client.seed('disputes', 'old-resolved', {
    employmentId: 'emp-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    initiatedBy: 'employer-1',
    status: 'resolved',
    category: 'other',
    reason: 'done',
  });
  client.seed('disputeLocks', 'emp-1', {
    employmentId: 'emp-1',
    disputeId: 'old-resolved',
    status: 'open',
  });

  const res = await employerApi.post('/employments/emp-1/disputes', {
    body: { category: 'other', reason: 'fresh dispute' },
  });

  assert.equal(res.status, 201);
  assert.equal(all('disputes').length, 2);
  assert.equal(client.readDoc('disputeLocks', 'emp-1').disputeId, res.body.dispute.id);
});
