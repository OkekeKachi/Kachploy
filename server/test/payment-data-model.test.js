'use strict';

/**
 * Stage 1E tests for the payment DATA MODEL: the canonical status vocabulary
 * and the allowed-field contract. No provider is called, no money moves, no
 * flow is added -- this file pins definitions and refusals only.
 *
 * CLIENT_FORBIDDEN_PAYMENT_FIELDS stays module-private (as
 * CLIENT_FORBIDDEN_CONTRACT_FIELDS does), so its contract is proven
 * behaviourally through the real initiate endpoint, exactly as
 * payments.test.js already proves it for the pre-existing thirteen fields.
 *
 * The repository is required LAZILY, after startTestServer has installed the
 * fake in require.cache -- requiring paymentService at the top of the file
 * would load the real config/firebase.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, employment, task } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;
let paymentService;

test.before(async () => {
  client = await startTestServer();
  paymentService = require('../services/paymentService');
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

/** Every payment document currently stored, as an array. */
const payments = () => Object.values(client.readAll('payments'));

// ---------------------------------------------------------------------------
// Setup helpers, copied from payments.test.js so this suite is self-contained
// and payments.test.js itself stays untouched.
// ---------------------------------------------------------------------------

function seedHiredWorld() {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', applicationId: 'app-1', status: 'active' })
  );
}

function seedTasksOnEmp1(...entries) {
  for (const entry of entries) {
    const [taskId, overrides = {}] = Array.isArray(entry) ? entry : [entry];
    client.seed('tasks', taskId, task({ employmentId: 'emp-1', ...overrides }));
  }
}

async function createContractWithTwoMilestones() {
  seedTasksOnEmp1(['task-1', { status: 'approved' }], ['task-2', { status: 'approved' }]);

  const res = await employerApi.post('/contracts', {
    body: {
      employmentId: 'emp-1',
      paymentMode: 'milestones',
      milestones: [
        { taskId: 'task-1', label: 'Phase one', amountMinor: 500000 },
        { taskId: 'task-2', label: 'Phase two', amountMinor: 1000000 },
      ],
    },
  });
  assert.equal(res.status, 200);

  const acceptRes = await employeeApi.post('/contracts/emp-1/accept');
  assert.equal(acceptRes.status, 200);

  const ids = res.body.milestones.map((m) => m.id);
  return { ms1: ids[0], ms2: ids[1] };
}

const initiateBody = (milestoneId, idempotencyKey = 'key-1') => ({
  milestoneId,
  idempotencyKey,
});

// ---------------------------------------------------------------------------
// The contracts under test
// ---------------------------------------------------------------------------

/** The thirteen fields P2 already refused -- must remain refused. */
const PRE_EXISTING_FORBIDDEN = [
  'id',
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
];

/** The nine server-controlled fields Stage 1E adds to the contract. */
const STAGE_1E_SERVER_FIELDS = [
  'chargeMinor',
  'feeMinor',
  'providerReference',
  'providerEnvironment',
  'providerFeeMinor',
  'statusReason',
  'verifyAttempts',
  'verifiedAt',
  'paidAt',
];

test('the paymentService export surface is exactly the known set -- nothing beyond it', () => {
  // This pinned the P2 six during Stage 1E, which added no export. Stage 1F
  // was separately authorized to add exactly two more -- the initialize
  // service function and its provider-error class. Stage 1G was authorized to
  // add exactly one more -- the verify service function. Stage 1L was
  // authorized to add exactly one more -- the webhook reconciliation function
  // -- so the surface is now the known ten, and nothing else may appear
  // silently. Full-contract payment support adds the four contract functions.
  assert.deepEqual(Object.keys(paymentService).sort(), [
    'CREATED_STATUS',
    'PAYMENT_STATUSES',
    'PaymentNotFoundError',
    'PaymentProviderError',
    'PaymentValidationError',
    'getPaymentForContract',
    'getPaymentForMilestone',
    'initializePaymentForContract',
    'initializePaymentForMilestone',
    'initiateContractPayment',
    'initiatePayment',
    'reconcilePaymentFromWebhook',
    'verifyPaymentForContract',
    'verifyPaymentForMilestone',
  ]);
});

test('the canonical status vocabulary is exactly the five approved values', () => {
  assert.deepEqual(paymentService.PAYMENT_STATUSES, [
    'created',
    'pending',
    'paid',
    'failed',
    'needs_review',
  ]);

  // Well-formedness: five distinct non-empty strings, no hole and no alias.
  assert.equal(new Set(paymentService.PAYMENT_STATUSES).size, 5);
  for (const status of paymentService.PAYMENT_STATUSES) {
    assert.equal(typeof status, 'string');
    assert.equal(status.trim().length > 0, true);
    assert.equal(status, status.trim(), 'no accidental whitespace');
  }

  // 'created' is still what a new record is written with, and it is a member
  // of the vocabulary.
  assert.equal(paymentService.CREATED_STATUS, 'created');
  assert.equal(paymentService.PAYMENT_STATUSES.includes(paymentService.CREATED_STATUS), true);

  // No accidental alternatives. 'provider_pending' in particular was the old
  // placeholder name for the in-flight state; the approved vocabulary calls
  // it 'pending'.
  for (const banned of [
    'provider_pending',
    'authorized',
    'ongoing',
    'processing',
    'queued',
    'abandoned',
    'reversed',
    'refunded',
    'cancelled',
    'disputed',
    'suspended',
  ]) {
    assert.equal(
      paymentService.PAYMENT_STATUSES.includes(banned),
      false,
      `${banned} must not be in the vocabulary`
    );
  }
});

test('every server-controlled field is refused from the initiate body, named, before any write', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  for (const field of [...PRE_EXISTING_FORBIDDEN, ...STAGE_1E_SERVER_FIELDS]) {
    const res = await employerApi.post('/payments', {
      body: { ...initiateBody(ms1, `key-${field}`), [field]: 'nope' },
    });
    assert.equal(res.status, 400, `${field} must be refused`);
    assert.match(res.body.message, new RegExp(`${field} cannot be supplied`));
  }

  // Not one of the twenty-two attempts reached a write.
  assert.equal(payments().length, 0);
});

test('the original amount, modeled fee, gross charge and provider fee stay four separate fields', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 200);
  const payment = res.body.payment;

  // amountMinor is the milestone's original amount, copied as before.
  assert.equal(payment.amountMinor, 500000);

  // At creation none of the three fee/gross fields exist: feeMinor is only
  // written when a later stage computes the modeled fee, chargeMinor only when
  // the gross is computed, providerFeeMinor only when the provider reports
  // one. A created record therefore cannot silently conflate them -- and the
  // existing commission pair remains its own, separate concept.
  assert.equal(Object.prototype.hasOwnProperty.call(payment, 'feeMinor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payment, 'chargeMinor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payment, 'providerFeeMinor'), false);
  assert.equal(payment.commissionAmountMinor, 25000, 'commission is untouched by the fee fields');

  // The four names are distinct strings -- no aliasing between the concepts.
  const four = ['amountMinor', 'feeMinor', 'chargeMinor', 'providerFeeMinor'];
  assert.equal(new Set(four).size, 4);
});

test('the created record gains no provider-shaped field: the P2 shape is preserved', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  const res = await employerApi.post('/payments', { body: initiateBody(ms1) });
  assert.equal(res.status, 200);

  // None of the nine Stage 1E fields was written by creation -- they are
  // contract protections for LATER server-side writers, not new creation
  // output. providerEnvironment is the one deliberate exception: creation
  // stamps the environment the record belongs to so it can never cross modes.
  // (The full exact key set remains pinned by payments.test.js.)
  const stored = { id: ms1, ...client.readDoc('payments', ms1) };
  for (const field of STAGE_1E_SERVER_FIELDS) {
    if (field === 'providerEnvironment') continue;
    assert.equal(Object.prototype.hasOwnProperty.call(stored, field), false, field);
  }
  assert.equal(stored.providerEnvironment, 'test');
  assert.equal(stored.status, 'created');
  assert.equal(stored.amountMinor, 500000);
});
