'use strict';

/**
 * Route-contract tests for disputes and reviews.
 *
 * The client helpers were previously calling flat `/disputes` and `/reviews`
 * endpoints that this server never mounted, so the UI failed with 404s. These
 * tests pin the mounted paths and the exact request bodies the client sends:
 * a dispute is created under its employment and listed per party, evidence uses
 * `evidenceType`, and a review is created under its employment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { employment, job } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;
let strangerApi;

test.before(async () => {
  client = await startTestServer({ clock: () => '2026-01-01T00:00:00.000Z' });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  client.seed('employments', 'emp-1', employment());
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
  strangerApi = await client.authed('stranger-1');
});

test('dispute creation uses the employment route and the client payload fields', async () => {
  const res = await employerApi.post('/employments/emp-1/disputes', {
    body: { category: 'other', reason: 'Work stopped early', description: 'Details here' },
  });

  assert.equal(res.status, 201);
  assert.equal(res.body.dispute.employmentId, 'emp-1');
  assert.equal(res.body.dispute.category, 'other');
  assert.equal(res.body.dispute.reason, 'Work stopped early');
  assert.equal(res.body.dispute.description, 'Details here');
  assert.equal(res.body.dispute.initiatedBy, 'employer-1');
  assert.equal(res.body.dispute.status, 'open');
});

test('disputes are listed per party, not from a flat collection', async () => {
  const created = await employeeApi.post('/employments/emp-1/disputes', {
    body: { category: 'payment', reason: 'Milestone not paid' },
  });
  assert.equal(created.status, 201);

  const forEmployee = await employeeApi.get('/disputes/party/employee-1');
  assert.equal(forEmployee.status, 200);
  assert.equal(forEmployee.body.disputes.length, 1);
  assert.equal(forEmployee.body.disputes[0].id, created.body.dispute.id);

  const forEmployer = await employerApi.get('/disputes/party/employer-1');
  assert.equal(forEmployer.status, 200);
  assert.equal(forEmployer.body.disputes.length, 1);

  assert.equal((await employerApi.get('/disputes')).status, 404);

  const otherParty = await employerApi.get('/disputes/party/employee-1');
  assert.equal(otherParty.status, 403);
});

test('dispute detail and evidence use the client field names', async () => {
  const created = await employerApi.post('/employments/emp-1/disputes', {
    body: { category: 'work_quality', reason: 'Incomplete work' },
  });
  const disputeId = created.body.dispute.id;

  const detail = await employerApi.get(`/disputes/${disputeId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.dispute.id, disputeId);
  assert.deepEqual(detail.body.evidence, []);

  const evidence = await employerApi.post(`/disputes/${disputeId}/evidence`, {
    body: { evidenceType: 'text', content: 'Screenshots attached' },
  });
  assert.equal(evidence.status, 201);
  assert.ok(evidence.body.evidenceId);

  const after = await employerApi.get(`/disputes/${disputeId}`);
  assert.equal(after.body.evidence.length, 1);
  assert.equal(after.body.evidence[0].submittedBy, 'employer-1');
  assert.equal(after.body.evidence[0].evidenceType, 'text');
  assert.equal(after.body.evidence[0].content, 'Screenshots attached');

  const missingType = await employerApi.post(`/disputes/${disputeId}/evidence`, {
    body: { type: 'text', content: 'old client shape' },
  });
  assert.equal(missingType.status, 400);

  assert.equal((await strangerApi.get(`/disputes/${disputeId}`)).status, 403);
});

test('review creation uses the employment route and lists at the matching read route', async () => {
  client.seed('jobs', 'job-1', job({ status: 'closed' }));

  const res = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5, comment: 'Great work' },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.review.employmentId, 'emp-1');
  assert.equal(res.body.review.reviewerId, 'employer-1');
  assert.equal(res.body.review.revieweeId, 'employee-1');

  const employeeReview = await employeeApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employer-1', rating: 4, comment: 'Fair' },
  });
  assert.equal(employeeReview.status, 201);

  const list = await employerApi.get('/employments/emp-1/reviews');
  assert.equal(list.status, 200);
  assert.equal(list.body.reviews.length, 2);

  const duplicate = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 1, comment: 'Duplicate' },
  });
  assert.equal(duplicate.status, 409);

  const wrongReviewee = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'stranger-1', rating: 5 },
  });
  assert.equal(wrongReviewee.status, 400);

  assert.equal((await employerApi.post('/reviews', {
    body: { employmentId: 'emp-1', revieweeId: 'employee-1', rating: 5 },
  })).status, 404);
});

test('the flat dispute endpoints the client used to call are not mounted', async () => {
  assert.equal((await employerApi.post('/disputes', {
    body: { employmentId: 'emp-1', reason: 'legacy shape' },
  })).status, 404);

  const strangerList = await strangerApi.get('/disputes/party/stranger-1');
  assert.equal(strangerList.status, 200);
  assert.deepEqual(strangerList.body.disputes, []);
});
