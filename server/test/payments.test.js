'use strict';

/**
 * Stage P2 tests for the payments resource -- the payment-RECORD foundation.
 *
 * A payment record says only: the employer on an active contract, for an
 * active employment, asked Kachploy to initiate payment of one milestone's
 * full amount, and the request was stored. It is not evidence that a provider
 * was contacted, that the employer was charged, or that the employee was paid
 * -- this suite proves there is no provider call by asserting the exact stored
 * key set (no reference, no authorization URL, nothing provider-shaped) and by
 * asserting that no transition surface exists.
 *
 * The suite covers what P2 has to get right:
 *   1. successful initiation: the stored document under the milestone id, the
 *      server-copied identities and amounts, the commission computed from the
 *      contract's rate SNAPSHOT, status 'created', and that the milestone,
 *      task and contract documents are untouched
 *   2. approval never charges: approving a task writes no payment record
 *   3. authorization: only the contract's employer may initiate; anyone else
 *      is 403, no token is 401
 *   4. existence: a missing milestone or contract is a 404, before any write
 *   5. eligibility: wrong-employment milestone, pending contract, ended
 *      employment, vanished employment -- each a 400 with nothing written
 *   6. idempotency: same key + same milestone replays the stored record
 *      without rewriting it; same key + different milestone is a 400;
 *      different key + existing record is a 400
 *   7. request shape: every server-owned field is a forbidden field, and the
 *      idempotency key's required shapes are enforced
 *   8. reads: both contract parties, nobody else; no record is a 404
 *   9. the stage boundary: no PUT/PATCH/DELETE/verify/cancel/refund surface
 *      can exist or change a stored record
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, employment, task, contract, milestone, payment } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;
const now = () => '2026-01-01T00:00:00.000Z';

/** The timestamp shape the fake produces for the injected clock. */
const STAMP = { _seconds: 1767225600, _nanoseconds: 0 };

test.before(async () => {
  client = await startTestServer({ clock: now });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  // Fixtures use postedBy: 'employer-1' and employeeId: 'employee-1'.
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

/** Every payment document currently stored, as an array. */
const payments = () => Object.values(client.readAll('payments'));

/**
 * The write-call audit trail for the payments collection.
 *
 * STAGE 1K. Creation is now an atomic `create` (not a blind `set`), so a
 * "one write happened / no write happened" assertion must count BOTH primitives.
 * The intent of every call site is unchanged: how many documents were written.
 */
const paymentSetCalls = () =>
  client.fake.store.calls.filter(
    (c) => (c.op === 'set' || c.op === 'create') && c.path.startsWith('payments/')
  );

/**
 * Seeds the employer-1 job, employee-1's accepted application, and the
 * employment the hire recorded -- the world every payment test starts in, and
 * exactly the helper the contracts suite uses.
 */
function seedHiredWorld({ employmentOverrides = {} } = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', applicationId: 'app-1', status: 'active', ...employmentOverrides })
  );
}

/** Seeds tasks on emp-1 (the employment the default contract pays against). */
function seedTasksOnEmp1(...entries) {
  for (const entry of entries) {
    const [taskId, overrides = {}] = Array.isArray(entry) ? entry : [entry];
    client.seed('tasks', taskId, task({ employmentId: 'emp-1', ...overrides }));
  }
}

/**
 * Creates the two-milestone contract every initiation test uses, through the
 * real API (create, then optionally the employee's accept), and returns the
 * two milestone ids. Total is 1500000 kobo (500000 + 1000000), so the 5%
 * contract commission is 75000.
 */
async function createContractWithTwoMilestones({ accept = true, seedTasks = true, linkTasks = true } = {}) {
  if (seedTasks) {
    seedTasksOnEmp1(['task-1', { status: 'approved' }], ['task-2', { status: 'approved' }]);
  }

  const schedule = [
    { label: 'Phase one', amountMinor: 500000 },
    { label: 'Phase two', amountMinor: 1000000 },
  ];
  if (linkTasks) {
    schedule[0].taskId = 'task-1';
    schedule[1].taskId = 'task-2';
  }

  const res = await employerApi.post('/contracts', {
    body: {
      employmentId: 'emp-1',
      paymentMode: 'milestones',
      milestones: schedule,
    },
  });
  assert.equal(res.status, 200);

  if (accept) {
    const acceptRes = await employeeApi.post('/contracts/emp-1/accept');
    assert.equal(acceptRes.status, 200);
  }

  const ids = res.body.milestones.map((m) => m.id);
  return { ms1: ids[0], ms2: ids[1] };
}

/** The simplest valid initiate body. */
const initiateBody = (milestoneId, idempotencyKey = 'key-1') => ({
  milestoneId,
  idempotencyKey,
});

// ---------------------------------------------------------------------------
// 1. Successful initiation: the stored document and the untouched neighbours
// ---------------------------------------------------------------------------

test('an employer stores a payment record for an approved milestone under the milestone id', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const contractBefore = client.readDoc('contracts', 'emp-1');
  const taskBefore = client.readDoc('tasks', 'task-1');
  const milestoneBefore = client.readDoc('milestones', ms1);

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Payment record created successfully');

  const payment = res.body.payment;
  // The exact stored key set: every field server-derived, nothing provider-shaped.
assert.deepEqual(Object.keys(payment).sort(), [
    'amountMinor',
    'commissionAmountMinor',
    'commissionBps',
    'commissionIncluded',
    'contractId',
    'createdAt',
    'currency',
    'employeeId',
    'employerId',
    'employmentId',
    'id',
    'idempotencyKey',
    'initiatedBy',
    'milestoneId',
    'netPayableMinor',
    'providerEnvironment',
    'status',
    'taskId',
  ]);
  assert.equal(payment.providerEnvironment, 'test');
  assert.equal(payment.id, ms1);
  assert.equal(payment.milestoneId, ms1);
  assert.equal(payment.contractId, 'emp-1');
  assert.equal(payment.employmentId, 'emp-1');
  assert.equal(payment.taskId, 'task-1');
  assert.equal(payment.employerId, 'employer-1');
  assert.equal(payment.employeeId, 'employee-1');
  assert.equal(payment.amountMinor, 500000);
  assert.equal(payment.currency, 'NGN');
  assert.equal(payment.commissionBps, 500);
  assert.equal(payment.commissionAmountMinor, 25000);
  assert.equal(payment.status, 'created');
  assert.equal(payment.idempotencyKey, 'key-1');
  assert.equal(payment.initiatedBy, 'employer-1');
  assert.deepEqual(payment.createdAt, STAMP);

  // The stored document is the response document (readDoc returns raw data;
  // the response adds the document id).
  assert.deepEqual({ id: ms1, ...client.readDoc('payments', ms1) }, payment);

  // Initiating touches nothing else: the contract, the task and the milestone
  // are byte-identical before and after.
  assert.deepEqual(client.readDoc('contracts', 'emp-1'), contractBefore);
  assert.deepEqual(client.readDoc('tasks', 'task-1'), taskBefore);
  assert.deepEqual(client.readDoc('milestones', ms1), milestoneBefore);

  // Exactly one document, written exactly once.
  assert.equal(payments().length, 1);
  assert.equal(paymentSetCalls().length, 1);
});

test('approving a task writes no payment record; the payment request is the separate employer act', async () => {
  seedHiredWorld();
  seedTasksOnEmp1(['task-1', { status: 'submitted' }], ['task-2', { status: 'approved' }]);
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, accept: true });

  const approveRes = await employerApi.post('/tasks/task-1/approve');
  assert.equal(approveRes.status, 200);
  // Approval moved the task and NOTHING else -- no record, no charge.
  assert.equal(client.readDoc('tasks', 'task-1').status, 'approved');
  assert.equal(payments().length, 0);

  // The approved task's milestone is now eligible, once the employer asks.
  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, 'task-1');
  assert.equal(payments().length, 1);
});

test('legacy payment safe response omits netPayableMinor via verify', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.seed(
    'payments',
    ms1,
    payment({
      milestoneId: ms1,
      status: 'paid',
      providerReference: `kp_${ms1}`,
    })
  );

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  assert.equal(Object.keys(res.body.payment).includes('netPayableMinor'), false, 'legacy safe response must not include netPayableMinor');
});

test('a task created after hiring can be linked to the milestone, approved and paid', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'interviewed' })
  );
  client.seed('contractProposals', 'prop-1', {
    applicationId: 'app-1',
    jobId: 'job-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    paymentMode: 'milestones',
    currency: 'NGN',
    totalAmountMinor: 500000,
    commissionBps: 500,
    commissionAmountMinor: 25000,
    milestones: [
      { label: 'Deliver the work', amountMinor: 500000, description: 'Complete the agreed work' },
    ],
    status: 'accepted',
    acceptedAt: { _seconds: 1767225600, _nanoseconds: 0 },
    acceptedBy: 'employee-1',
  });

  const hireRes = await employerApi.put('/applications/app-1/status', { body: { status: 'accepted' } });
  assert.equal(hireRes.status, 200);

  const storedMilestones = Object.entries(client.readAll('milestones')).map(([id, data]) => ({ id, ...data }));
  assert.equal(storedMilestones.length, 1);
  const [milestoneRecord] = storedMilestones;
  assert.equal(milestoneRecord.taskId, undefined, 'the hire does not generate a task');
  assert.deepEqual(Object.keys(client.readAll('tasks')), [], 'the hire writes no tasks');

  // The funding gate: a milestone-linked task may only be created once that
  // milestone's payment record is persisted as 'paid'. Seed the paid payment
  // first, then create the task against it.
  client.seed('payments', milestoneRecord.id, payment({ status: 'paid', milestoneId: milestoneRecord.id }));

  const taskRes = await employerApi.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      milestoneId: milestoneRecord.id,
      taskName: 'Deliver the work',
      taskDescription: 'Complete the agreed work',
      dueDate: '2026-10-05',
      submissionType: 'text',
    },
  });
  assert.equal(taskRes.status, 200);
  const taskId = taskRes.body.taskId;
  assert.equal(client.readDoc('tasks', taskId).milestoneId, milestoneRecord.id);

  const submitRes = await employeeApi.post(`/tasks/${taskId}/submit`, {
    body: { submissionText: 'The work is complete' },
  });
  assert.equal(submitRes.status, 200);

  const approveRes = await employerApi.post(`/tasks/${taskId}/approve`, { body: {} });
  assert.equal(approveRes.status, 200);

  // The milestone's payment remains the confirmed, paid record; the lifecycle
  // manufactures no new payment record and downgrades nothing.
  const stored = client.readDoc('payments', milestoneRecord.id);
  assert.equal(stored.status, 'paid');
  assert.equal(client.readDoc('tasks', taskId).status, 'approved');
});

test('a second milestone of the same contract is payable with its own key', async () => {
  seedHiredWorld();
  const { ms1, ms2 } = await createContractWithTwoMilestones();

  const first = await employerApi.post('/payments', { body: initiateBody(ms1, 'key-a') });
  assert.equal(first.status, 200);

  const second = await employerApi.post('/payments', { body: initiateBody(ms2, 'key-b') });
  assert.equal(second.status, 200);
  assert.equal(second.body.payment.amountMinor, 1000000);
  assert.equal(second.body.payment.commissionAmountMinor, 50000);
  assert.equal(second.body.payment.taskId, 'task-2');
  assert.equal(payments().length, 2);
});

// ---------------------------------------------------------------------------
// 3. Authorization: the employer alone
// ---------------------------------------------------------------------------

test('only the employer on the contract may initiate; anyone else is refused before any write', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const asEmployee = await employeeApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(asEmployee.status, 403);

  const strangerApi = await client.authed('stranger-1');
  const asStranger = await strangerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(asStranger.status, 403);

  const noToken = await client.post('/payments', { body: initiateBody(ms1) });
  assert.equal(noToken.status, 401);

  assert.equal(payments().length, 0);
});

// ---------------------------------------------------------------------------
// 4. Existence: missing milestone or contract is a 404, before any write
// ---------------------------------------------------------------------------

test('a missing milestone or a milestone whose contract is missing is a 404', async () => {
  seedHiredWorld();

  const noMilestone = await employerApi.post('/payments', {
    body: initiateBody('no-such-milestone'),
  });
  assert.equal(noMilestone.status, 404);
  assert.equal(noMilestone.body.message, 'Milestone not found');

  client.seed('milestones', 'ms-orphan', milestone({ contractId: 'emp-gone' }));
  const noContract = await employerApi.post('/payments', { body: initiateBody('ms-orphan') });
  assert.equal(noContract.status, 404);
  assert.equal(noContract.body.message, 'Contract not found');

  assert.equal(payments().length, 0);
});

// ---------------------------------------------------------------------------
// 5. Eligibility: wrong employment, contract not active, employment not
//    active / vanished
// ---------------------------------------------------------------------------

test('a milestone whose task belongs to a different employment can still be paid', async () => {
  seedHiredWorld();
  await createContractWithTwoMilestones();

  client.seed('tasks', 'task-x', task({ employmentId: 'emp-2', status: 'approved' }));
  client.seed('milestones', 'ms-bad', milestone({ contractId: 'emp-1', taskId: 'task-x' }));

  const res = await employerApi.post('/payments', { body: initiateBody('ms-bad') });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, 'task-x', 'the legacy task link is preserved as stored');
  assert.equal(payments().length, 1);
});

test('a milestone whose task no longer exists can still be paid', async () => {
  seedHiredWorld();
  await createContractWithTwoMilestones();

  client.seed('milestones', 'ms-bad', milestone({ contractId: 'emp-1', taskId: 'task-gone' }));

  const res = await employerApi.post('/payments', { body: initiateBody('ms-bad') });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, 'task-gone', 'the legacy task link is preserved');
  assert.equal(payments().length, 1);
});

test('a milestone whose task is not approved can still be paid, in every non-approved status', async () => {
  seedHiredWorld();
  seedTasksOnEmp1(['task-1', { status: 'approved' }], ['task-2', { status: 'submitted' }]);
  const { ms2 } = await createContractWithTwoMilestones({ seedTasks: false });

  for (const status of ['assigned', 'submitted', 'revision_requested']) {
    client.seed('tasks', 'task-2', task({ employmentId: 'emp-1', status }));

    const res = await employerApi.post('/payments', { body: initiateBody(ms2, 'key-ms2') });
    assert.equal(res.status, 200, `status ${status} must be accepted`);
  }

  assert.equal(payments().length, 1);
});

test('a milestone with no associated task is payable', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, linkTasks: false });

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, undefined, 'no task link on the record');
  assert.equal(payments().length, 1);
});

test('a milestone is payable when its legacy task link is set', async () => {
  seedHiredWorld();
  seedTasksOnEmp1(['task-1', { status: 'assigned' }], ['task-2', { status: 'assigned' }]);
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, linkTasks: true });

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, 'task-1', 'the legacy task link is stored');
  assert.equal(res.body.payment.taskIds, undefined, 'no reverse taskIds collected');
  assert.equal(payments().length, 1);
});

test('one unapproved associated task does not block the milestone payment', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, linkTasks: false });
  client.seed('tasks', 'task-a', task({
    employmentId: 'emp-1',
    milestoneId: ms1,
    status: 'approved',
  }));
  client.seed('tasks', 'task-b', task({
    employmentId: 'emp-1',
    milestoneId: ms1,
    status: 'submitted',
  }));

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, undefined, 'no task link stored from reverse association');
  assert.equal(payments().length, 1);
});

test('a milestone whose legacy task link points to another employment can still be paid', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, linkTasks: false });
  client.seed('milestones', 'ms-bad', milestone({ contractId: 'emp-1', taskId: 'task-foreign' }));
  client.seed('tasks', 'task-foreign', task({
    employmentId: 'emp-2',
    status: 'approved',
  }));

  const res = await employerApi.post('/payments', { body: initiateBody('ms-bad') });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, 'task-foreign', 'the legacy task link is preserved as stored');
  assert.equal(payments().length, 1);
});

test('a task linked both ways uses the milestone task link for eligibility', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.seed('tasks', 'task-1', task({
    employmentId: 'emp-1',
    milestoneId: ms1,
    status: 'approved',
  }));
  client.seed('tasks', 'task-2', task({
    employmentId: 'emp-1',
    milestoneId: ms1,
    status: 'approved',
  }));

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.taskId, 'task-1', 'the legacy link is preserved');
  assert.equal(res.body.payment.taskIds, undefined, 'reverse taskIds are not collected');
});

test('a payment cannot be created against a contract that is still pending acceptance', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones({ accept: false });

  const pending = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(pending.status, 400);
  assert.match(pending.body.message, /contract must be active/);
  assert.equal(payments().length, 0);

  // Once the employee accepts, the same milestone becomes payable.
  const acceptRes = await employeeApi.post('/contracts/emp-1/accept');
  assert.equal(acceptRes.status, 200);

  const afterAccept = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(afterAccept.status, 200);
  assert.equal(payments().length, 1);
});

test('a payment cannot be created once the employment has ended', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  // The employment ends AFTER the contract was accepted -- re-read at
  // initiation time, so this is a domain 400, not a guard 403.
  client.seed('employments', 'emp-1', employment({ jobId: 'job-1', applicationId: 'app-1', status: 'ended' }));

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /employment has ended/);
  assert.equal(payments().length, 0);
});

test('a payment cannot be created when the contract employment record has vanished', async () => {
  seedHiredWorld();

  // A contract whose employment no longer reads as existing.
  client.seed('contracts', 'emp-ghost', contract({ status: 'active', employmentId: 'emp-ghost' }));
  client.seed('tasks', 'task-ghost', task({ employmentId: 'emp-ghost', status: 'approved' }));
  client.seed('milestones', 'ms-ghost', milestone({ contractId: 'emp-ghost', taskId: 'task-ghost' }));

  const res = await employerApi.post('/payments', { body: initiateBody('ms-ghost') });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /employment for this contract no longer exists/);
  assert.equal(payments().length, 0);
});

test('an invalid stored milestone amount is refused without writing a payment record', async () => {
  seedHiredWorld();
  client.seed('contracts', 'emp-1', contract({ status: 'active' }));
  client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));

  // Contract creation would never persist these, but a payment is the point
  // where stored data becomes a money-bearing record, so the guard is here.
  const amounts = [0, -1, 1.5, 1000000000001];
  for (const amountMinor of amounts) {
    client.seed(
      'milestones',
      'ms-bad-amount',
      milestone({ contractId: 'emp-1', taskId: 'task-1', amountMinor })
    );

    const res = await employerApi.post('/payments', {
      body: initiateBody('ms-bad-amount', `key-amount-${amountMinor}`),
    });
    assert.equal(res.status, 400, `amount ${amountMinor} must be refused`);
    assert.match(res.body.message, /milestone amount is not a valid positive kobo amount/);
  }

  assert.equal(payments().length, 0);
  assert.equal(paymentSetCalls().length, 0);
});

test('a contract with an unsupported stored currency is refused without writing a payment record', async () => {
  seedHiredWorld();
  client.seed('contracts', 'emp-1', contract({ status: 'active', currency: 'USD' }));
  client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
  client.seed('milestones', 'ms-1', milestone({ contractId: 'emp-1', taskId: 'task-1' }));

  const res = await employerApi.post('/payments', { body: initiateBody('ms-1') });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /contract currency must be NGN/);
  assert.equal(payments().length, 0);
  assert.equal(paymentSetCalls().length, 0);
});

// ---------------------------------------------------------------------------
// 6. Idempotency: replay, cross-milestone key conflict, second-key refusal
// ---------------------------------------------------------------------------

test('re-sending the same idempotency key returns the stored record and rewrites nothing', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const first = await employerApi.post('/payments', { body: initiateBody(ms1, 'key-1') });
  assert.equal(first.status, 200);
  assert.equal(first.body.message, 'Payment record created successfully');
  assert.equal(paymentSetCalls().length, 1);

  const second = await employerApi.post('/payments', { body: initiateBody(ms1, 'key-1') });
  assert.equal(second.status, 200);
  assert.equal(second.body.message, 'Payment already recorded');
  assert.deepEqual(second.body.payment, first.body.payment);
  assert.deepEqual({ id: ms1, ...client.readDoc('payments', ms1) }, first.body.payment);

  // One record, one write: the replay performed no set() at all.
  assert.equal(payments().length, 1);
  assert.equal(paymentSetCalls().length, 1);
});

test('the idempotency key is trimmed, so a padded first send and a plain retry are the same request', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const first = await employerApi.post('/payments', { body: initiateBody(ms1, '  key-1  ') });
  assert.equal(first.status, 200);
  assert.equal(first.body.payment.idempotencyKey, 'key-1');
  assert.equal(paymentSetCalls().length, 1);

  const retry = await employerApi.post('/payments', { body: initiateBody(ms1, 'key-1') });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.message, 'Payment already recorded');
  assert.deepEqual(retry.body.payment, first.body.payment);

  // Still one record and no second write: normalization happened before both
  // the uniqueness query and the stored field.
  assert.equal(payments().length, 1);
  assert.equal(paymentSetCalls().length, 1);
});

test('the same idempotency key on a different milestone is refused', async () => {
  seedHiredWorld();
  const { ms1, ms2 } = await createContractWithTwoMilestones();

  const first = await employerApi.post('/payments', { body: initiateBody(ms1, 'key-1') });
  assert.equal(first.status, 200);

  const conflict = await employerApi.post('/payments', { body: initiateBody(ms2, 'key-1') });
  assert.equal(conflict.status, 400);
  assert.match(conflict.body.message, /already been used for a different milestone/);

  // Only the first record exists; the refused request wrote nothing.
  assert.equal(payments().length, 1);
  assert.equal(client.readDoc('payments', ms2), undefined);
});

test('a different idempotency key on a milestone that already has a record is refused', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const first = await employerApi.post('/payments', { body: initiateBody(ms1, 'key-1') });
  assert.equal(first.status, 200);

  const second = await employerApi.post('/payments', { body: initiateBody(ms1, 'key-2') });
  assert.equal(second.status, 400);
  assert.match(second.body.message, /a payment already exists for this milestone/);

  // The stored record still carries the ORIGINAL key -- nothing was rewritten.
  assert.equal(client.readDoc('payments', ms1).idempotencyKey, 'key-1');
  assert.equal(payments().length, 1);
  assert.equal(paymentSetCalls().length, 1);
});

// ---------------------------------------------------------------------------
// 6b. STAGE 1K: concurrent creation cannot overwrite or duplicate
// ---------------------------------------------------------------------------

test('two concurrent creations with the SAME key produce exactly one record and no overwrite', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  // Fired without awaiting between them, so both reach the check-then-write
  // window. Exactly one creates; the other is resolved as an idempotent replay.
  const [a, b] = await Promise.all([
    employerApi.post('/payments', { body: initiateBody(ms1, 'race-key') }),
    employerApi.post('/payments', { body: initiateBody(ms1, 'race-key') }),
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  // One created, one replayed -- never two creations.
  const messages = [a.body.message, b.body.message].sort();
  assert.deepEqual(messages, ['Payment already recorded', 'Payment record created successfully']);

  // Exactly one stored document, exactly one write, and the two responses
  // describe the SAME record (no last-writer-wins divergence).
  assert.equal(payments().length, 1);
  assert.equal(paymentSetCalls().length, 1);
  assert.deepEqual(a.body.payment, b.body.payment);
  assert.equal(client.readDoc('payments', ms1).idempotencyKey, 'race-key');
  assert.equal(client.readDoc('payments', ms1).status, 'created');
});

test('two concurrent creations with DIFFERENT keys produce one record and one refusal', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const [a, b] = await Promise.all([
    employerApi.post('/payments', { body: initiateBody(ms1, 'race-key-a') }),
    employerApi.post('/payments', { body: initiateBody(ms1, 'race-key-b') }),
  ]);

  // Exactly one wins; the other is refused as a second attempt on the milestone.
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  const refused = a.status === 400 ? a : b;
  assert.match(refused.body.message, /a payment already exists for this milestone/);

  // One document only. The stored key is whichever request actually won the
  // create -- never a blend, never the loser's key overwriting the winner's.
  assert.equal(payments().length, 1);
  assert.equal(paymentSetCalls().length, 1);
  const storedKey = client.readDoc('payments', ms1).idempotencyKey;
  assert.equal(storedKey === 'race-key-a' || storedKey === 'race-key-b', true);
});

// ---------------------------------------------------------------------------
// 7. Request shape: forbidden fields and idempotency-key requirements
// ---------------------------------------------------------------------------

test('every server-owned field is refused from the body, named, before any write', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const forbidden = [
    'contractId',
    'employmentId',
    'taskId',
    'employerId',
    'employeeId',
    'amountMinor',
    'currency',
    'commissionBps',
    'commissionAmountMinor',
    'status',
    'initiatedBy',
    'createdAt',
    'id',
  ];

  for (const field of forbidden) {
    const res = await employerApi.post('/payments', {
      body: { ...initiateBody(ms1, `key-${field}`), [field]: 'nope' },
    });
    assert.equal(res.status, 400, `${field} must be refused`);
    assert.match(res.body.message, new RegExp(`${field} cannot be supplied`));
  }

  assert.equal(payments().length, 0);
});

test('the idempotency key and milestoneId are required and shape-checked', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const cases = [
    [{ milestoneId: ms1 }, /idempotencyKey is required/],
    [{ milestoneId: ms1, idempotencyKey: 42 }, /idempotencyKey is required/],
    [{ milestoneId: ms1, idempotencyKey: '' }, /must not be empty/],
    [{ milestoneId: ms1, idempotencyKey: '   ' }, /must not be empty/],
    [{ milestoneId: ms1, idempotencyKey: 'x'.repeat(129) }, /at most 128 characters/],
    [{ idempotencyKey: 'key-1' }, /Missing required fields/],
    // The guard now type-checks the id before any repository call, so a
    // number, null, or blank string is the same 400 as a missing id -- never a
    // harness-specific 404 (and never a real-Firestore 500).
    [{ milestoneId: 42, idempotencyKey: 'key-1' }, /Missing required fields/],
    [{ milestoneId: null, idempotencyKey: 'key-1' }, /Missing required fields/],
    [{ milestoneId: '', idempotencyKey: 'key-1' }, /Missing required fields/],
    [{ milestoneId: '   ', idempotencyKey: 'key-1' }, /Missing required fields/],
  ];

  for (const [body, pattern] of cases) {
    const res = await employerApi.post('/payments', { body });
    assert.equal(res.status, 400, `body ${JSON.stringify(body).slice(0, 60)} must be refused`);
    assert.match(res.body.message, pattern);
  }

  // A 128-character key is accepted (the bound is inclusive).
  const ok = await employerApi.post('/payments', {
    body: { milestoneId: ms1, idempotencyKey: 'x'.repeat(128) },
  });
  assert.equal(ok.status, 200);
  assert.equal(payments().length, 1);
});

// ---------------------------------------------------------------------------
// Commission: the contract's rate SNAPSHOT, not the live constant
// ---------------------------------------------------------------------------

test('the payment commission is computed from the contract stored commissionBps snapshot', async () => {
  seedHiredWorld();

  // A contract created under a different rate: 750 bps (7.5%).
  client.seed('contracts', 'emp-1', contract({ status: 'active', commissionBps: 750 }));
  client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
  client.seed('milestones', 'ms-1', milestone({ contractId: 'emp-1', taskId: 'task-1', amountMinor: 500000 }));

  const res = await employerApi.post('/payments', { body: initiateBody('ms-1') });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.commissionBps, 750);
  // floor(500000 * 750 / 10000) = 37500, the snapshot's rate -- not
  // floor(500000 * 500 / 10000) = 25000, the live constant's.
  assert.equal(res.body.payment.commissionAmountMinor, 37500);
});

test('a milestone at MAX_AMOUNT_MINOR is payable with the exact 5% commission', async () => {
  seedHiredWorld();
  client.seed('contracts', 'emp-1', contract({ status: 'active' }));
  client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
  client.seed(
    'milestones',
    'ms-max',
    milestone({ contractId: 'emp-1', taskId: 'task-1', amountMinor: 1000000000000 })
  );

  const res = await employerApi.post('/payments', { body: initiateBody('ms-max', 'max-key') });
  assert.equal(res.status, 200);
  assert.equal(res.body.payment.amountMinor, 1000000000000);
  assert.equal(res.body.payment.commissionBps, 500);
  // floor(10^12 * 500 / 10000) = 5 * 10^10, well inside safe-integer range.
  assert.equal(res.body.payment.commissionAmountMinor, 50000000000);
});

test('calculateCommissionMinor accepts boundary rates and refuses rates or products it cannot compute exactly', () => {
  const commission = require('../config/commission');

  // Default behavior is unchanged: the platform rate is 500 bps.
  assert.equal(commission.calculateCommissionMinor(1500000), 75000);
  assert.equal(
    commission.calculateCommissionMinor(1500000, commission.PLATFORM_COMMISSION_BPS),
    75000
  );

  // Valid rate boundaries: 0 bps yields no commission; 10000 bps is accepted
  // when the product is still exact; the largest permitted amount at the
  // platform rate is exact.
  assert.equal(commission.calculateCommissionMinor(1500000, 0), 0);
  assert.equal(commission.calculateCommissionMinor(900719925474, 10000), 900719925474);
  assert.equal(commission.calculateCommissionMinor(1000000000000, 500), 50000000000);

  // Out-of-range or non-integer rates are refused by the existing guard.
  for (const bad of [-1, 10001, 500.5, NaN]) {
    assert.throws(
      () => commission.calculateCommissionMinor(1000, bad),
      /commissionBps must be an integer in 0\.\.10000/
    );
  }

  // A valid rate can still make the product unsafe; refuse rather than round.
  assert.throws(
    () => commission.calculateCommissionMinor(1000000000000, 10000),
    /exceeds Number\.MAX_SAFE_INTEGER/
  );
});

// ---------------------------------------------------------------------------
// 8. Reads: both contract parties, nobody else
// ---------------------------------------------------------------------------

test('both contract parties may read the record; a stranger and a missing record are refused', async () => {
  seedHiredWorld();
  const { ms1, ms2 } = await createContractWithTwoMilestones();

  const created = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(created.status, 200);

  const byEmployer = await employerApi.get(`/payments/milestone/${ms1}`);
  assert.equal(byEmployer.status, 200);
  assert.deepEqual(byEmployer.body.payment, created.body.payment);

  const byEmployee = await employeeApi.get(`/payments/milestone/${ms1}`);
  assert.equal(byEmployee.status, 200);
  assert.deepEqual(byEmployee.body.payment, created.body.payment);

  const strangerApi = await client.authed('stranger-1');
  const byStranger = await strangerApi.get(`/payments/milestone/${ms1}`);
  assert.equal(byStranger.status, 403);

  // A valid milestone with no payment record yet: the normal pre-initiation state.
  const noRecord = await employerApi.get(`/payments/milestone/${ms2}`);
  assert.equal(noRecord.status, 404);
  assert.equal(noRecord.body.message, 'Payment not found');

  const noMilestone = await employerApi.get('/payments/milestone/no-such-milestone');
  assert.equal(noMilestone.status, 404);
  assert.equal(noMilestone.body.message, 'Milestone not found');
});

test('reading a payment record requires authentication', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const created = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(created.status, 200);

  // Same route, no bearer token: the auth guard runs before the party check.
  const res = await client.get(`/payments/milestone/${ms1}`);
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// 9. The stage boundary: no transition surface exists
// ---------------------------------------------------------------------------

test('no PUT/PATCH/DELETE/verify/cancel/refund route exists, and no request can change a stored record', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const created = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(created.status, 200);
  const storedBefore = client.readDoc('payments', ms1);

  const attempts = [
    ['PUT', `/payments/${ms1}`],
    ['PATCH', `/payments/${ms1}`],
    ['DELETE', `/payments/${ms1}`],
    ['POST', `/payments/${ms1}/verify`],
    ['POST', `/payments/${ms1}/cancel`],
    ['POST', `/payments/${ms1}/refund`],
    ['POST', `/payments/${ms1}/initiate`],
    ['GET', `/payments/${ms1}`],
  ];

  for (const [method, path] of attempts) {
    const res = await employerApi.request(method, path, {
      body: method === 'GET' ? undefined : {},
    });
    assert.equal(res.status, 404, `${method} ${path} must not exist`);
  }

  // The record is byte-identical: status 'created', one write, nothing transitioned.
  assert.deepEqual(client.readDoc('payments', ms1), storedBefore);
  assert.equal(client.readDoc('payments', ms1).status, 'created');
  assert.equal(paymentSetCalls().length, 1);
  assert.equal(payments().length, 1);
});
