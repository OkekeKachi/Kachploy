'use strict';

/**
 * Full-contract payment tests.
 *
 * A full-mode contract is paid as ONE amount with no milestone or task behind
 * it. These tests cover the contract-level create/read/initialize/verify and
 * webhook paths, plus the security and mode-separation boundaries that keep
 * them distinct from the existing milestone payment flow.
 *
 * No real credential and no real Paystack request: testing/testApp.js swaps
 * both Firestore and the Paystack client for recording fakes before the app
 * chain loads.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer } = require('../testing/testApp');
const { calculateCheckoutChargeMinor, calculateCheckoutFeeMinor } = require('../config/fees');
const { job, application, employment, user, task, contract, payment } = require('../testing/fixtures');

const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const SECRET_KEY_ENV = 'PAYSTACK_SECRET_KEY';
const SIGNATURE_HEADER = 'x-paystack-signature';
const FAKE_CHECKOUT_URL = 'https://checkout.paystack.com/pay/test_auth_key';
const CONTRACT_ID = 'emp-1';
const PAYMENT_ID = 'contract_emp-1';
const TOTAL = 1500000;
const EXPECTED_COMMISSION = 75000;
const EXPECTED_CHARGE = calculateCheckoutChargeMinor(TOTAL);
const EXPECTED_FEE = calculateCheckoutFeeMinor(EXPECTED_CHARGE);
const STAMP = { _seconds: 1767225600, _nanoseconds: 0 };

let client;
let employerApi;
let employeeApi;
const savedEnv = { had: false, value: undefined };
let originalConsoleError;

test.before(async () => {
  client = await startTestServer({ clock: () => '2026-01-01T00:00:00.000Z' });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  client.paystack.reset();
  client.paystack.sleep = async () => {};
  savedEnv.had = Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV);
  savedEnv.value = process.env[SECRET_KEY_ENV];
  process.env[SECRET_KEY_ENV] = FAKE_TEST_KEY;
  originalConsoleError = console.error;
  console.error = () => {};
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

test.afterEach(() => {
  if (savedEnv.had) {
    process.env[SECRET_KEY_ENV] = savedEnv.value;
  } else {
    delete process.env[SECRET_KEY_ENV];
  }
  console.error = originalConsoleError;
});

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
  client.seed(
    'users',
    'employer-1',
    user({ uid: 'employer-1', email: 'employer@example.test', role: 'employer' })
  );
}

async function createFullContract({ accept = true, totalAmountMinor = TOTAL } = {}) {
  const res = await employerApi.post('/contracts', {
    body: {
      employmentId: CONTRACT_ID,
      paymentMode: 'full',
      totalAmountMinor,
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.milestones, []);

  if (accept) {
    const accepted = await employeeApi.post(`/contracts/${CONTRACT_ID}/accept`);
    assert.equal(accepted.status, 200);
  }

  return res.body.contract;
}

async function createMilestoneContract() {
  client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
  const res = await employerApi.post('/contracts', {
    body: {
      employmentId: CONTRACT_ID,
      paymentMode: 'milestones',
      milestones: [{ taskId: 'task-1', label: 'Phase one', amountMinor: 500000 }],
    },
  });
  assert.equal(res.status, 200);
  const accepted = await employeeApi.post(`/contracts/${CONTRACT_ID}/accept`);
  assert.equal(accepted.status, 200);
  return res.body;
}

const createRecord = (idempotencyKey = 'contract-key-1') =>
  employerApi.post('/payments/contract', {
    body: { contractId: CONTRACT_ID, idempotencyKey },
  });

async function setupRecordedContract() {
  seedHiredWorld();
  await createFullContract();
  const created = await createRecord();
  assert.equal(created.status, 200);
  return created.body.payment;
}

const paymentWrites = () =>
  client.fake.store.calls.filter(
    (call) => (call.op === 'set' || call.op === 'create') && call.path.startsWith('payments/')
  );

const okInitialize = (payload) => ({
  status: true,
  message: 'Authorization URL created',
  data: {
    authorization_url: FAKE_CHECKOUT_URL,
    access_code: 'access_code_1',
    reference: payload.reference,
  },
});

const verifyResponse = (reference, overrides = {}) => ({
  status: true,
  message: 'Verification successful',
  data: {
    reference,
    currency: 'NGN',
    amount: EXPECTED_CHARGE,
    status: 'success',
    fees: 1234,
    ...overrides,
  },
});

const sign = (body, secret = FAKE_TEST_KEY) =>
  crypto.createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');

function postWebhook(event) {
  const body = JSON.stringify(event);
  return client.post('/payments/webhook', {
    body,
    headers: { [SIGNATURE_HEADER]: sign(body) },
  });
}

// ---------------------------------------------------------------------------
// Create: one deterministic record, copied from the contract
// ---------------------------------------------------------------------------

test('the employer creates one contract payment record with only server-derived fields', async () => {
  seedHiredWorld();
  await createFullContract();
  const contractBefore = client.readDoc('contracts', CONTRACT_ID);

  const res = await createRecord();

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Payment record created successfully');

  const payment = res.body.payment;
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
    'netPayableMinor',
    'paymentTarget',
    'providerEnvironment',
    'status',
  ]);
  assert.equal(payment.providerEnvironment, 'test');
  assert.equal(payment.id, PAYMENT_ID);
  assert.equal(payment.paymentTarget, 'contract');
  assert.equal(payment.contractId, CONTRACT_ID);
  assert.equal(payment.employmentId, 'emp-1');
  assert.equal(payment.employerId, 'employer-1');
  assert.equal(payment.employeeId, 'employee-1');
  assert.equal(payment.amountMinor, TOTAL);
  assert.equal(payment.currency, 'NGN');
  assert.equal(payment.commissionBps, 500);
  assert.equal(payment.commissionAmountMinor, EXPECTED_COMMISSION);
  assert.equal(payment.status, 'created');
  assert.equal(payment.idempotencyKey, 'contract-key-1');
  assert.equal(payment.initiatedBy, 'employer-1');
  assert.deepEqual(payment.createdAt, STAMP);
  assert.equal('milestoneId' in payment, false);
  assert.equal('taskId' in payment, false);

  assert.deepEqual({ id: PAYMENT_ID, ...client.readDoc('payments', PAYMENT_ID) }, payment);
  assert.deepEqual(client.readDoc('contracts', CONTRACT_ID), contractBefore);
  assert.equal(paymentWrites().length, 1);
  assert.equal(Object.keys(client.readAll('paymentIdempotencyKeys')).length, 1);
});

test('replaying the same key returns the stored record without writing again', async () => {
  const first = await setupRecordedContract();

  const second = await createRecord('contract-key-1');

  assert.equal(second.status, 200);
  assert.equal(second.body.message, 'Payment already recorded');
  assert.deepEqual(second.body.payment, first);
  assert.equal(paymentWrites().length, 1);
  assert.equal(Object.keys(client.readAll('paymentIdempotencyKeys')).length, 1);
});

test('a different key for a contract that already has a record is refused', async () => {
  await setupRecordedContract();

  const res = await createRecord('another-key');

  assert.equal(res.status, 400);
  assert.match(res.body.message, /a payment already exists for this contract/);
  assert.equal(paymentWrites().length, 1);
  assert.equal(client.readDoc('payments', PAYMENT_ID).idempotencyKey, 'contract-key-1');
});

test('an idempotency key used by another contract is refused globally', async () => {
  await setupRecordedContract();

  client.seed(
    'jobs',
    'job-2',
    job({ postedBy: 'employer-1', title: 'Second job' })
  );
  client.seed(
    'applications',
    'app-2',
    application({ jobId: 'job-2', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-2',
    employment({ jobId: 'job-2', applicationId: 'app-2', status: 'active' })
  );

  const secondContract = await employerApi.post('/contracts', {
    body: { employmentId: 'emp-2', paymentMode: 'full', totalAmountMinor: 900000 },
  });
  assert.equal(secondContract.status, 200);
  const accepted = await employeeApi.post('/contracts/emp-2/accept');
  assert.equal(accepted.status, 200);

  const res = await employerApi.post('/payments/contract', {
    body: { contractId: 'emp-2', idempotencyKey: 'contract-key-1' },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /already been used for a different payment/);
  assert.equal(client.readDoc('payments', 'contract_emp-2'), undefined);
  assert.equal(paymentWrites().length, 1);
});

test('two concurrent creates with the same key store exactly one payment and one key claim', async () => {
  seedHiredWorld();
  await createFullContract();

  const [a, b] = await Promise.all([createRecord('race-key'), createRecord('race-key')]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body.payment, b.body.payment);
  assert.equal(a.body.payment.idempotencyKey, 'race-key');
  assert.equal(paymentWrites().length, 1);
  assert.equal(Object.keys(client.readAll('paymentIdempotencyKeys')).length, 1);
});

// ---------------------------------------------------------------------------
// Validation, eligibility and mode separation
// ---------------------------------------------------------------------------

test('every server-owned contract payment field is refused from the client', async () => {
  seedHiredWorld();
  await createFullContract();

  const forbidden = [
    'milestoneId',
    'paymentMode',
    'totalAmountMinor',
    'jobId',
    'applicationId',
    'paymentTarget',
    'employmentId',
    'employerId',
    'employeeId',
    'amountMinor',
    'currency',
    'commissionBps',
    'commissionAmountMinor',
    'status',
    'initiatedBy',
    'createdAt',
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

  for (const field of forbidden) {
    const res = await employerApi.post('/payments/contract', {
      body: { contractId: CONTRACT_ID, idempotencyKey: 'contract-key-1', [field]: 'supplied' },
    });
    assert.equal(res.status, 400, `${field} must be refused`);
    assert.match(res.body.message, new RegExp(`${field} cannot be supplied`));
  }

  assert.equal(client.readDoc('payments', PAYMENT_ID), undefined);
  assert.equal(paymentWrites().length, 0);
});

test('missing, blank and oversized idempotency keys are refused', async () => {
  seedHiredWorld();
  await createFullContract();

  const cases = [
    [{ contractId: CONTRACT_ID }, /idempotencyKey is required/],
    [{ contractId: CONTRACT_ID, idempotencyKey: 42 }, /idempotencyKey is required/],
    [{ contractId: CONTRACT_ID, idempotencyKey: '' }, /must not be empty/],
    [{ contractId: CONTRACT_ID, idempotencyKey: '   ' }, /must not be empty/],
    [{ contractId: CONTRACT_ID, idempotencyKey: 'x'.repeat(129) }, /at most 128 characters/],
  ];

  for (const [body, pattern] of cases) {
    const res = await employerApi.post('/payments/contract', { body });
    assert.equal(res.status, 400);
    assert.match(res.body.message, pattern);
  }

  assert.equal(client.readDoc('payments', PAYMENT_ID), undefined);
});

test('only the contract employer may create, initialize, verify or read', async () => {
  seedHiredWorld();
  await createFullContract();
  const strangerApi = await client.authed('stranger-1');

  assert.equal((await employerApi.post('/payments/contract', {
    body: { contractId: CONTRACT_ID, idempotencyKey: 'employer-key' },
  })).status, 200);

  assert.equal((await employeeApi.post('/payments/contract', {
    body: { contractId: CONTRACT_ID, idempotencyKey: 'employee-key' },
  })).status, 403);
  assert.equal((await strangerApi.post('/payments/contract', {
    body: { contractId: CONTRACT_ID, idempotencyKey: 'stranger-key' },
  })).status, 403);
  assert.equal((await client.post('/payments/contract', {
    body: { contractId: CONTRACT_ID, idempotencyKey: 'anonymous-key' },
  })).status, 401);

  assert.equal((await employeeApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  })).status, 403);
  assert.equal((await employeeApi.post('/payments/contract/verify', {
    body: { contractId: CONTRACT_ID },
  })).status, 403);

  assert.equal((await employeeApi.get(`/payments/contract/${CONTRACT_ID}`)).status, 200);
  assert.equal((await strangerApi.get(`/payments/contract/${CONTRACT_ID}`)).status, 403);
  assert.equal((await client.get(`/payments/contract/${CONTRACT_ID}`)).status, 401);
});

test('the guard refuses a missing contract id and a missing contract', async () => {
  seedHiredWorld();

  assert.equal((await employerApi.post('/payments/contract', {
    body: { idempotencyKey: 'key-1' },
  })).status, 400);

  assert.equal((await employerApi.post('/payments/contract', {
    body: { contractId: 'missing-contract', idempotencyKey: 'key-1' },
  })).status, 404);
});

test('a pending full contract cannot create a payment record', async () => {
  seedHiredWorld();
  await createFullContract({ accept: false });

  const res = await createRecord();

  assert.equal(res.status, 400);
  assert.match(res.body.message, /contract must be active/);
  assert.equal(client.readDoc('payments', PAYMENT_ID), undefined);
});

test('an ended employment blocks a contract payment even after acceptance', async () => {
  seedHiredWorld();
  await createFullContract();
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', applicationId: 'app-1', status: 'ended' })
  );

  const res = await createRecord();

  assert.equal(res.status, 400);
  assert.match(res.body.message, /employment has ended/);
  assert.equal(client.readDoc('payments', PAYMENT_ID), undefined);
});

test('a contract whose employment is missing cannot create a payment record', async () => {
  client.seed('contracts', 'emp-ghost', contract({
    employmentId: 'emp-ghost',
    status: 'active',
    paymentMode: 'full',
  }));

  const res = await employerApi.post('/payments/contract', {
    body: { contractId: 'emp-ghost', idempotencyKey: 'key-1' },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /employment for this contract no longer exists/);
});

test('a full contract cannot use the milestone payment endpoints', async () => {
  seedHiredWorld();
  await createFullContract();

  const initiate = await employerApi.post('/payments', {
    body: { milestoneId: 'anything', idempotencyKey: 'key-1' },
  });
  assert.equal(initiate.status, 404);

  const initialize = await employerApi.post('/payments/initialize', {
    body: { milestoneId: 'anything' },
  });
  assert.equal(initialize.status, 404);
});

test('a milestone contract cannot use the contract payment endpoints', async () => {
  seedHiredWorld();
  await createMilestoneContract();

  const create = await employerApi.post('/payments/contract', {
    body: { contractId: CONTRACT_ID, idempotencyKey: 'key-1' },
  });
  assert.equal(create.status, 400);
  assert.match(create.body.message, /paid by milestones/);

  const initialize = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });
  assert.equal(initialize.status, 404);
});

test('stored amount and currency are re-validated before a record is written', async () => {
  seedHiredWorld();
  await createFullContract();

  client.seed('contracts', CONTRACT_ID, contract({
    employmentId: 'emp-1',
    status: 'active',
    paymentMode: 'full',
    totalAmountMinor: 0,
  }));
  const zero = await createRecord('zero-key');
  assert.equal(zero.status, 400);
  assert.match(zero.body.message, /not a valid positive kobo amount/);

  client.seed('contracts', CONTRACT_ID, contract({
    employmentId: 'emp-1',
    status: 'active',
    paymentMode: 'full',
    currency: 'USD',
  }));
  const currency = await createRecord('currency-key');
  assert.equal(currency.status, 400);
  assert.match(currency.body.message, /currency must be NGN/);

  assert.equal(client.readDoc('payments', PAYMENT_ID), undefined);
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

test('a contract with no payment is a 404, and the record is readable afterward', async () => {
  seedHiredWorld();
  await createFullContract();

  const missing = await employerApi.get(`/payments/contract/${CONTRACT_ID}`);
  assert.equal(missing.status, 404);

  const created = await createRecord();
  assert.equal(created.status, 200);

  const read = await employerApi.get(`/payments/contract/${CONTRACT_ID}`);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body.payment, created.body.payment);
});

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

test('initialization uses the contract total and contract-level reference', async () => {
  const payment = await setupRecordedContract();
  client.paystack.respondWith(okInitialize);

  const res = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body).sort(), [
    'amountMinor',
    'chargeMinor',
    'checkoutUrl',
    'currency',
    'feeMinor',
    'message',
    'paymentId',
    'reference',
    'status',
  ]);
  assert.equal(res.body.paymentId, PAYMENT_ID);
  assert.equal(res.body.reference, `kp_${PAYMENT_ID}`);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.amountMinor, TOTAL);
  assert.equal(res.body.chargeMinor, EXPECTED_CHARGE);
  assert.equal(res.body.feeMinor, EXPECTED_FEE);
  assert.equal(res.body.currency, 'NGN');
  assert.equal(res.body.checkoutUrl, FAKE_CHECKOUT_URL);

  const call = client.paystack.calls.at(-1);
  assert.equal(call.op, 'initializeTransaction');
  assert.equal(call.payload.email, 'employer@example.test');
  assert.equal(call.payload.amount, EXPECTED_CHARGE);
  assert.equal(call.payload.currency, 'NGN');
  assert.equal(call.payload.reference, `kp_${PAYMENT_ID}`);
  assert.deepEqual(call.payload.metadata, { contractId: CONTRACT_ID });
  assert.equal('milestoneId' in call.payload.metadata, false);
  assert.equal('taskId' in call.payload.metadata, false);

  const stored = client.readDoc('payments', PAYMENT_ID);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.verifyAttempts, 1);
  assert.equal(stored.providerReference, `kp_${PAYMENT_ID}`);
  assert.equal(stored.providerEnvironment, 'test');
  assert.equal(stored.chargeMinor, EXPECTED_CHARGE);
  assert.equal(stored.feeMinor, EXPECTED_FEE);
  assert.equal(stored.amountMinor, payment.amountMinor);
});

test('a second initialization while pending is refused without another provider call', async () => {
  await setupRecordedContract();
  client.paystack.respondWith(okInitialize);

  const first = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });
  assert.equal(first.status, 200);
  assert.equal(client.paystack.calls.length, 1);

  const second = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });
  assert.equal(second.status, 400);
  assert.match(second.body.message, /awaiting verification/);
  assert.equal(client.paystack.calls.length, 1);
});

test('a failed contract payment without a provider reference retries with a new attempt reference', async () => {
  await setupRecordedContract();
  const failed = client.readDoc('payments', PAYMENT_ID);
  client.seed('payments', PAYMENT_ID, {
    ...failed,
    status: 'failed',
    verifyAttempts: 1,
    statusReason: 'declined',
  });
  client.paystack.respondWith(okInitialize);

  const res = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.reference, `kp_${PAYMENT_ID}_a2`);
  assert.equal(client.paystack.calls.length, 1);
  assert.equal(client.paystack.calls[0].payload.reference, `kp_${PAYMENT_ID}_a2`);

  const stored = client.readDoc('payments', PAYMENT_ID);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.verifyAttempts, 2);
  assert.equal(stored.providerReference, `kp_${PAYMENT_ID}_a2`);
  assert.deepEqual(stored.createdAt, failed.createdAt);
  assert.equal(
    client.readDoc('paymentAttempts', `${PAYMENT_ID}__attempt_2`).reference,
    `kp_${PAYMENT_ID}_a2`
  );
});

test('a failed contract payment with a provider reference retries with a new reference', async () => {
  await setupRecordedContract();
  const failed = client.readDoc('payments', PAYMENT_ID);
  const originalReference = `kp_${PAYMENT_ID}`;
  client.seed('payments', PAYMENT_ID, {
    ...failed,
    status: 'failed',
    verifyAttempts: 1,
    providerReference: originalReference,
    statusReason: 'declined',
  });
  client.paystack.respondWith(okInitialize);

  const res = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.reference, `kp_${PAYMENT_ID}_a2`);
  assert.equal(client.paystack.calls.length, 1);
  assert.equal(client.paystack.calls[0].payload.reference, `kp_${PAYMENT_ID}_a2`);
  const stored = client.readDoc('payments', PAYMENT_ID);
  assert.equal(stored.status, 'pending');
  assert.equal(stored.verifyAttempts, 2);
  assert.equal(stored.providerReference, `kp_${PAYMENT_ID}_a2`);

  const legacyAttempt = client.readDoc('paymentAttempts', `${PAYMENT_ID}__attempt_1`);
  assert.equal(legacyAttempt.reference, originalReference);
  assert.equal(legacyAttempt.status, 'failed');
  assert.equal(legacyAttempt.legacy, true);
});

test('recent contract attempts are throttled without a provider call', async () => {
  await setupRecordedContract();
  const failed = client.readDoc('payments', PAYMENT_ID);
  client.seed('payments', PAYMENT_ID, {
    ...failed,
    status: 'failed',
    verifyAttempts: 3,
  });
  const now = new Date();
  for (let attemptNumber = 1; attemptNumber <= 5; attemptNumber += 1) {
    client.seed('paymentAttempts', `${PAYMENT_ID}__attempt_${attemptNumber}`, {
      paymentId: PAYMENT_ID,
      attemptNumber,
      createdAt: now,
    });
  }
  client.paystack.respondWith(okInitialize);

  const res = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /too many payment attempts/);
  assert.equal(client.paystack.calls.length, 0);
  const stored = client.readDoc('payments', PAYMENT_ID);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.verifyAttempts, 3);
});

test('initialization before a payment record exists is a 404', async () => {
  seedHiredWorld();
  await createFullContract();

  const res = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(res.status, 404);
  assert.equal(client.paystack.calls.length, 0);
});

test('initialization refuses client-supplied money fields without calling the provider', async () => {
  await setupRecordedContract();

  const res = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID, amountMinor: 1, totalAmountMinor: 1 },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /cannot be supplied/);
  assert.equal(client.paystack.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Verify
// ---------------------------------------------------------------------------

test('verification applies the provider success to the contract payment', async () => {
  await setupRecordedContract();
  client.paystack.respondWith(okInitialize);
  const initialized = await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });
  assert.equal(initialized.status, 200);

  client.paystack.respondWithVerify((reference) => verifyResponse(reference));
  const res = await employerApi.post('/payments/contract/verify', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.payment.status, 'paid');
  assert.equal(client.readDoc('payments', PAYMENT_ID).status, 'paid');
  assert.ok(client.readDoc('payments', PAYMENT_ID).paidAt);
  assert.equal(client.paystack.calls.at(-1).op, 'verifyTransaction');
  assert.equal(client.paystack.calls.at(-1).reference, `kp_${PAYMENT_ID}`);
});

test('verifying an already-paid contract payment does not call the provider again', async () => {
  await setupRecordedContract();
  client.paystack.respondWith(okInitialize);
  await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });
  client.paystack.respondWithVerify((reference) => verifyResponse(reference));
  const first = await employerApi.post('/payments/contract/verify', {
    body: { contractId: CONTRACT_ID },
  });
  assert.equal(first.status, 200);
  const callsAfterPaid = client.paystack.calls.length;

  const second = await employerApi.post('/payments/contract/verify', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(second.status, 200);
  assert.equal(second.body.verified, true);
  assert.equal(second.body.payment.status, 'paid');
  assert.equal(client.paystack.calls.length, callsAfterPaid);
});

test('verification before initialization is refused', async () => {
  await setupRecordedContract();

  const res = await employerApi.post('/payments/contract/verify', {
    body: { contractId: CONTRACT_ID },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /has not been initialized/);
  assert.equal(client.paystack.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

test('a signed charge.success webhook reconciles a contract payment', async () => {
  await setupRecordedContract();
  client.paystack.respondWith(okInitialize);
  await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });

  client.paystack.respondWithVerify((reference) => verifyResponse(reference));
  const res = await postWebhook({
    event: 'charge.success',
    data: {
      reference: `kp_${PAYMENT_ID}`,
      currency: 'NGN',
      amount: EXPECTED_CHARGE,
      status: 'success',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('payments', PAYMENT_ID).status, 'paid');
  assert.ok(client.readDoc('payments', PAYMENT_ID).paidAt);
});

test('a webhook reconciles after the employment ends, while client verify still refuses', async () => {
  await setupRecordedContract();
  client.paystack.respondWith(okInitialize);
  await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });

  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', applicationId: 'app-1', status: 'ended' })
  );

  const providerCallsBeforeVerify = client.paystack.calls.length;
  const clientVerify = await employerApi.post('/payments/contract/verify', {
    body: { contractId: CONTRACT_ID },
  });
  assert.equal(clientVerify.status, 400);
  assert.match(clientVerify.body.message, /employment has ended/);
  assert.equal(client.paystack.calls.length, providerCallsBeforeVerify);
  assert.equal(client.readDoc('payments', PAYMENT_ID).status, 'pending');

  client.paystack.respondWithVerify((reference) => verifyResponse(reference));
  const res = await postWebhook({
    event: 'charge.success',
    data: {
      reference: `kp_${PAYMENT_ID}`,
      currency: 'NGN',
      amount: EXPECTED_CHARGE,
      status: 'success',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('payments', PAYMENT_ID).status, 'paid');
  assert.ok(client.readDoc('payments', PAYMENT_ID).paidAt);
  assert.equal(Object.keys(client.readAll('payments')).length, 1);
  assert.equal(client.readDoc('payments', PAYMENT_ID).id, undefined);
  assert.equal(client.readDoc('payments', PAYMENT_ID).paymentTarget, 'contract');
  assert.equal(client.readDoc('payments', PAYMENT_ID).contractId, CONTRACT_ID);
});

test('a webhook amount mismatch moves the contract payment to needs_review', async () => {
  await setupRecordedContract();
  client.paystack.respondWith(okInitialize);
  await employerApi.post('/payments/contract/initialize', {
    body: { contractId: CONTRACT_ID },
  });
  const providerCalls = client.paystack.calls.length;

  const res = await postWebhook({
    event: 'charge.success',
    data: {
      reference: `kp_${PAYMENT_ID}`,
      currency: 'NGN',
      amount: EXPECTED_CHARGE + 1,
      status: 'success',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('payments', PAYMENT_ID).status, 'needs_review');
  assert.equal(client.paystack.calls.length, providerCalls);
});

test('a webhook for an unknown contract payment creates nothing', async () => {
  seedHiredWorld();

  const res = await postWebhook({
    event: 'charge.success',
    data: {
      reference: 'kp_contract_missing',
      currency: 'NGN',
      amount: 100,
      status: 'success',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('payments', 'contract_missing'), undefined);
});
