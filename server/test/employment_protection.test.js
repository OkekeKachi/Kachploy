'use strict';

/**
 * Protection tests for the employment lifecycle, disputes and reviews.
 *
 * These are not happy-path tests: each one asserts that a mutation the API
 * accepts cannot be used to destroy an obligation, manufacture money, or let a
 * stranger act on someone else's relationship. Nothing here contacts Paystack;
 * the harness installs an in-memory Firestore and a queue-driven Paystack
 * double, so no real payment request can be made.
 *
 * IMPORTANT CLAIM BOUNDARY: Kachploy does not hold funds and this file does not
 * claim it does. A payment record is a request/record, not escrow. Verified
 * provider responses are the only writer of `paid`, and no lifecycle action
 * here can reach a provider.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, employment, contract, milestone, task, payment } = require('../testing/fixtures');

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
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
  strangerApi = await client.authed('stranger-1');
});

const all = (collection) => Object.values(client.readAll(collection));

/**
 * A live employment with the supporting documents a payment would need. The
 * employment fixture is `emp-1`, the contract shares that id, and the milestone
 * and payment fixtures share `ms-1`.
 */
function seedActiveEmployment({ withContract = true, withTask = true, withPayment = false } = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ status: 'accepted' }));
  client.seed('employments', 'emp-1', employment());
  if (withContract) {
    client.seed('contracts', 'emp-1', contract({ status: 'active' }));
    client.seed('milestones', 'ms-1', milestone());
  }
  if (withTask) {
    client.seed('tasks', 'task-1', task({ status: 'approved' }));
  }
  if (withPayment) {
    client.seed('payments', 'ms-1', payment({ status: 'created' }));
  }
}

test('employer terminates after approved work; unpaid obligation remains and payment not marked paid', async () => {
  seedActiveEmployment({ withPayment: true });
  const taskBefore = client.readDoc('tasks', 'task-1');
  const paymentBefore = client.readDoc('payments', 'ms-1');
  const milestoneBefore = client.readDoc('milestones', 'ms-1');

  const res = await employerApi.post('/employments/emp-1/terminate', {
    body: { reason: 'employer_initiated', note: 'stopping work' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.employment.status, 'terminated');
  assert.equal(res.body.employment.terminationReason, 'employer_initiated');
  assert.equal(res.body.employment.terminatedBy, 'employer-1');
  assert.ok(res.body.employment.terminatedAt);

  const stored = client.readDoc('employments', 'emp-1');
  assert.equal(stored.status, 'terminated');
  assert.equal(stored.jobId, 'job-1');

  // Approved work and the unpaid payment record survive the termination.
  assert.deepEqual(client.readDoc('tasks', 'task-1'), taskBefore);
  assert.deepEqual(client.readDoc('milestones', 'ms-1'), milestoneBefore);
  assert.deepEqual(client.readDoc('payments', 'ms-1'), paymentBefore);
  assert.equal(client.readDoc('payments', 'ms-1').status, 'created');
  assert.equal(client.readDoc('payments', 'ms-1').paidAt, undefined);
  assert.equal(all('payments').length, 1);
});

test('termination with submitted but unreviewed work does not silently discard it', async () => {
  seedActiveEmployment();
  const submittedTask = task({
    status: 'submitted',
    submissionType: 'text',
    submissionText: 'work completed, awaiting review',
  });
  client.seed('tasks', 'task-1', submittedTask);
  const taskBefore = client.readDoc('tasks', 'task-1');

  const res = await employeeApi.post('/employments/emp-1/terminate', {
    body: { reason: 'employee_initiated' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.employment.status, 'terminated');
  assert.deepEqual(client.readDoc('tasks', 'task-1'), taskBefore);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted');
  assert.equal(client.readDoc('tasks', 'task-1').submissionText, 'work completed, awaiting review');
});

test('unauthorized cannot terminate/settle/access disputes/submit reviews', async () => {
  seedActiveEmployment();
  const employmentBefore = client.readDoc('employments', 'emp-1');

  const terminate = await strangerApi.post('/employments/emp-1/terminate', {
    body: { reason: 'mutual' },
  });
  assert.equal(terminate.status, 403);

  const settle = await strangerApi.post('/employments/emp-1/settlement', {
    body: { settlement: { note: 'unilateral' } },
  });
  assert.equal(settle.status, 403);

  const dispute = await strangerApi.post('/employments/emp-1/disputes', {
    body: { category: 'payment', reason: 'unilateral dispute' },
  });
  assert.equal(dispute.status, 403);

  const review = await strangerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 1, comment: 'unilateral review' },
  });
  assert.equal(review.status, 403);

  const readEmployment = await strangerApi.get('/employments/emp-1');
  assert.equal(readEmployment.status, 403);

  const listDisputes = await strangerApi.get('/disputes/party/employer-1');
  assert.equal(listDisputes.status, 403);

  const unauthenticated = await client.get('/employments/emp-1');
  assert.equal(unauthenticated.status, 401);

  // No unauthorized mutation of any kind.
  assert.deepEqual(client.readDoc('employments', 'emp-1'), employmentBefore);
  assert.equal(all('disputes').length, 0);
  assert.equal(all('reviews').length, 0);
  assert.equal(client.readDoc('employments', 'emp-1').settlement, undefined);
  assert.equal(client.readDoc('employments', 'emp-1').settlementUpdatedBy, undefined);
});

test('duplicate/concurrent-like requests do not create inconsistent records (termination/review/dispute)', async () => {
  seedActiveEmployment();

  // Termination: a second sequential request is refused, and a parallel pair
  // still leaves exactly one employment document in a consistent end state.
  // Termination is read-then-write, not transactional; this asserts record
  // consistency, not atomic exclusion.
  const firstTerminate = await employerApi.post('/employments/emp-1/terminate', {
    body: { reason: 'mutual' },
  });
  assert.equal(firstTerminate.status, 200);

  const secondTerminate = await employerApi.post('/employments/emp-1/terminate', {
    body: { reason: 'mutual' },
  });
  assert.equal(secondTerminate.status, 409);

  client.seed('employments', 'emp-1', employment());
  const [parallelA, parallelB] = await Promise.all([
    employerApi.post('/employments/emp-1/terminate', { body: { reason: 'mutual' } }),
    employeeApi.post('/employments/emp-1/terminate', { body: { reason: 'mutual' } }),
  ]);
  assert.ok([200, 409].includes(parallelA.status));
  assert.ok([200, 409].includes(parallelB.status));
  assert.ok(parallelA.status === 200 || parallelB.status === 200);
  assert.equal(all('employments').length, 1);
  assert.equal(client.readDoc('employments', 'emp-1').status, 'terminated');
  assert.ok(client.readDoc('employments', 'emp-1').terminatedBy);

  // Reviews: one review per reviewer per employment.
  const firstReview = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 4, comment: 'good work' },
  });
  assert.equal(firstReview.status, 201);
  assert.ok(firstReview.body.review.id);

  const secondReview = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5, comment: 'duplicate' },
  });
  assert.equal(secondReview.status, 409);
  assert.equal(all('reviews').length, 1);

  // Disputes: a second dispute while one is open is refused.
  const firstDispute = await employeeApi.post('/employments/emp-1/disputes', {
    body: { category: 'payment', reason: 'milestone not paid' },
  });
  assert.equal(firstDispute.status, 201);
  assert.ok(firstDispute.body.dispute.id);
  assert.equal(firstDispute.body.dispute.status, 'open');

  const secondDispute = await employeeApi.post('/employments/emp-1/disputes', {
    body: { category: 'scope', reason: 'another dispute' },
  });
  assert.equal(secondDispute.status, 409);
  assert.equal(all('disputes').length, 1);
});

test('disputes and termination cannot downgrade paid milestone or manufacture payment', async () => {
  seedActiveEmployment({ withPayment: false });
  client.seed(
    'payments',
    'ms-1',
    payment({
      status: 'paid',
      providerReference: 'ref-paid-1',
      providerTransactionId: 'txn-1',
      paidAt: { _seconds: 1767225600, _nanoseconds: 0 },
    })
  );
  const paidBefore = client.readDoc('payments', 'ms-1');

  const dispute = await employeeApi.post('/employments/emp-1/disputes', {
    body: { category: 'work_quality', reason: 'quality concern' },
  });
  assert.equal(dispute.status, 201);

  const terminate = await employerApi.post('/employments/emp-1/terminate', {
    body: { reason: 'mutual' },
  });
  assert.equal(terminate.status, 200);

  // The paid record is untouched: same amount, same provider identity, still paid.
  assert.deepEqual(client.readDoc('payments', 'ms-1'), paidBefore);
  assert.equal(client.readDoc('payments', 'ms-1').status, 'paid');
  assert.equal(client.readDoc('payments', 'ms-1').amountMinor, paidBefore.amountMinor);
  assert.equal(all('payments').length, 1);

  // No escrow/funds-holding field is fabricated by the lifecycle.
  const stored = client.readDoc('employments', 'emp-1');
  assert.equal(stored.escrow, undefined);
  assert.equal(stored.funded, undefined);
});

test('reviews cannot be submitted for unrelated or ineligible employments', async () => {
  seedActiveEmployment();

  const unrelated = await strangerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });
  assert.equal(unrelated.status, 403);

  const wrongReviewee = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'someone-else', rating: 5 },
  });
  assert.equal(wrongReviewee.status, 400);

  const badRating = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 9 },
  });
  assert.equal(badRating.status, 400);

  const missingEmployment = await employerApi.post('/employments/does-not-exist/reviews', {
    body: { revieweeId: 'employee-1', rating: 5 },
  });
  assert.equal(missingEmployment.status, 404);

  assert.equal(all('reviews').length, 0);

  // A genuine party with a valid payload still works, so the refusals above are
  // about eligibility rather than a broken endpoint.
  client.seed('jobs', 'job-1', job({ status: 'closed' }));
  const valid = await employerApi.post('/employments/emp-1/reviews', {
    body: { revieweeId: 'employee-1', rating: 5, comment: 'reliable' },
  });
  assert.equal(valid.status, 201);
  assert.equal(all('reviews').length, 1);
});

test('funding gates cannot be bypassed by calling API directly (no escrow claim)', async () => {
  seedActiveEmployment({ withContract: true, withTask: true, withPayment: false });

  const terminate = await employerApi.post('/employments/emp-1/terminate', {
    body: { reason: 'mutual' },
  });
  assert.equal(terminate.status, 200);

  const initiate = await employerApi.post('/payments', {
    body: { milestoneId: 'ms-1', idempotencyKey: 'key-1' },
  });
  assert.equal(initiate.status, 400);
  assert.equal(all('payments').length, 0);

  const strangerInitiate = await strangerApi.post('/payments', {
    body: { milestoneId: 'ms-1', idempotencyKey: 'key-2' },
  });
  assert.equal(strangerInitiate.status, 403);
  assert.equal(all('payments').length, 0);

  // Nothing was marked paid, and no funds-holding field was created.
  assert.ok(all('payments').every((p) => p.status !== 'paid'));
  assert.equal(client.readDoc('employments', 'emp-1').escrow, undefined);
});

test('legacy employments without contracts retain safe behavior', async () => {
  seedActiveEmployment({ withContract: false, withTask: false, withPayment: false });

  const res = await employeeApi.post('/employments/emp-1/terminate', {
    body: { reason: 'mutual' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.employment.status, 'terminated');

  const read = await employerApi.get('/employments/emp-1');
  assert.equal(read.status, 200);
  assert.equal(read.body.employment.status, 'terminated');

  // A contract-less lifecycle touches no payment or contract state at all.
  assert.equal(all('payments').length, 0);
  assert.equal(all('contracts').length, 0);
  assert.equal(client.readDoc('employments', 'emp-1').jobId, 'job-1');
});
