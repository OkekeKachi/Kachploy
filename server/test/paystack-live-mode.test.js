'use strict';

/**
 * Live Mode isolation tests.
 *
 * Test Mode stays the default and its suite is untouched. These tests pin the
 * additional guarantees Live Mode adds:
 *   - the mode is explicit and the key prefix must match it;
 *   - a payment, attempt, release and funding record carry the environment
 *     they were created in, and cannot cross environments;
 *   - a live webhook cannot settle a test-mode payment;
 *   - live payouts stay blocked unless PAYSTACK_LIVE_PAYOUTS_ENABLED is true.
 *
 * No real credential and no real Paystack request: testing/testApp.js swaps the
 * Paystack clients for queue-driven recording fakes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer } = require('../testing/testApp');
const { createSimulatedReleaseProvider } = require('../testing/simulatedReleaseProvider');
const { calculateCheckoutChargeMinor, calculateCheckoutFeeMinor } = require('../config/fees');
const {
  job,
  application,
  employment,
  task,
  milestone,
  payment,
  user,
  contract,
} = require('../testing/fixtures');

const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const FAKE_LIVE_KEY = ['sk', 'live', 'fake_live_key_for_tests'].join('_');
const SECRET_KEY_ENV = 'PAYSTACK_SECRET_KEY';
const MODE_ENV = 'PAYSTACK_MODE';
const LIVE_PAYOUTS_ENV = 'PAYSTACK_LIVE_PAYOUTS_ENABLED';
const SIGNATURE_HEADER = 'x-paystack-signature';
const LIVE_CHECKOUT_URL = 'https://checkout.paystack.com/pay/live_auth_key';
const RELEASE_ID = 'rel_ms-1';

const EXPECTED_CHARGE = calculateCheckoutChargeMinor(500000);
const EXPECTED_FEE = calculateCheckoutFeeMinor(EXPECTED_CHARGE);

let client;
let employerApi;
let employeeApi;
let releaseService;
let orchestration;
let savedEnv;

test.before(async () => {
  client = await startTestServer();
  releaseService = require('../services/releaseService');
  orchestration = require('../services/releaseOrchestrationService');
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  client.paystack.reset();
  client.paystack.sleep = async () => {};
  savedEnv = {
    [SECRET_KEY_ENV]: process.env[SECRET_KEY_ENV],
    [MODE_ENV]: process.env[MODE_ENV],
    [LIVE_PAYOUTS_ENV]: process.env[LIVE_PAYOUTS_ENV],
  };
  process.env[SECRET_KEY_ENV] = FAKE_TEST_KEY;
  delete process.env[MODE_ENV];
  delete process.env[LIVE_PAYOUTS_ENV];
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

test.afterEach(() => {
  for (const key of [SECRET_KEY_ENV, MODE_ENV, LIVE_PAYOUTS_ENV]) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ---------------------------------------------------------------------------
// World setup
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
  client.seed(
    'users',
    'employer-1',
    user({ uid: 'employer-1', email: 'employer@example.test', role: 'employer' })
  );
}

async function createContractWithTwoMilestones() {
  client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
  client.seed('tasks', 'task-2', task({ employmentId: 'emp-1', status: 'approved' }));
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

async function createPaymentRecord(ms1) {
  const res = await employerApi.post('/payments', {
    body: { milestoneId: ms1, idempotencyKey: `key-${ms1}` },
  });
  assert.equal(res.status, 200);
  return client.readDoc('payments', ms1);
}

async function seedInitializedPayment(environment, overrides = {}) {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.seed(
    'payments',
    ms1,
    payment({
      milestoneId: ms1,
      status: 'pending',
      providerReference: `kp_${ms1}`,
      providerEnvironment: environment,
      chargeMinor: EXPECTED_CHARGE,
      feeMinor: EXPECTED_FEE,
      verifyAttempts: 1,
      ...overrides,
    })
  );
  return ms1;
}

function seedFundedMilestone({ paymentOverrides = {} } = {}) {
  client.seed('employments', 'emp-1', employment({ status: 'active' }));
  client.seed(
    'contracts',
    'emp-1',
    contract({ paymentMode: 'milestones', status: 'active' })
  );
  client.seed(
    'milestones',
    'ms-1',
    milestone({
      contractId: 'emp-1',
      employmentId: 'emp-1',
      taskId: 'task-1',
      amountMinor: 500000,
    })
  );
  client.seed(
    'payments',
    'ms-1',
    payment({
      milestoneId: 'ms-1',
      contractId: 'emp-1',
      employmentId: 'emp-1',
      employerId: 'employer-1',
      employeeId: 'employee-1',
      amountMinor: 500000,
      currency: 'NGN',
      status: 'paid',
      ...paymentOverrides,
    })
  );
  client.seed(
    'tasks',
    'task-1',
    task({ employmentId: 'emp-1', milestoneId: 'ms-1', status: 'approved' })
  );
}

const okInitialize = (payload) => ({
  status: true,
  message: 'Authorization URL created',
  data: {
    authorization_url: LIVE_CHECKOUT_URL,
    access_code: 'live_auth_key',
    reference: payload.reference,
  },
});

const okVerify = (reference) => ({
  status: true,
  message: 'Verification successful',
  data: {
    reference,
    currency: 'NGN',
    amount: EXPECTED_CHARGE,
    status: 'success',
    fees: 1234,
  },
});

const rawBody = (event) => JSON.stringify(event);
const sign = (body, secret) =>
  crypto.createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');

const chargeSuccessEvent = (reference) => ({
  event: 'charge.success',
  data: {
    reference,
    currency: 'NGN',
    amount: EXPECTED_CHARGE,
    status: 'success',
  },
});

const postWebhook = (event, secret) => {
  const body = rawBody(event);
  return client.post('/payments/webhook', {
    body,
    headers: { [SIGNATURE_HEADER]: sign(body, secret) },
  });
};

const expectCode = (code) => (error) => {
  assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
  return true;
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('live mode refuses a test key before contacting the provider', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;
  await createPaymentRecord(ms1);

  process.env[SECRET_KEY_ENV] = FAKE_TEST_KEY;
  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 503);
  assert.equal(client.paystack.calls.length, 0);
  assert.equal(client.readDoc('payments', ms1).status, 'created');
});

test('an unknown mode is a 503, never a silent Test Mode fallback', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  await createPaymentRecord(ms1);

  process.env[MODE_ENV] = 'production';
  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 503);
  assert.equal(client.paystack.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Collections: initialize / verify
// ---------------------------------------------------------------------------

test('live mode stamps the environment on the payment and its attempt', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();

  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;
  const created = await createPaymentRecord(ms1);
  assert.equal(created.providerEnvironment, 'live');

  client.paystack.respondWith(okInitialize);
  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.checkoutUrl, LIVE_CHECKOUT_URL);
  assert.equal(client.readDoc('payments', ms1).providerEnvironment, 'live');
  assert.equal(client.readDoc('paymentAttempts', `${ms1}__attempt_1`).providerEnvironment, 'live');
});

test('live mode verifies a live-tagged payment', async () => {
  const ms1 = await seedInitializedPayment('live');
  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;
  client.paystack.respondWithVerify(okVerify);

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  assert.equal(client.readDoc('payments', ms1).status, 'paid');
});

test('a test-mode payment cannot be initialized or verified while the server is live', async () => {
  seedHiredWorld();
  const { ms1, ms2 } = await createContractWithTwoMilestones();
  await createPaymentRecord(ms1);
  client.seed(
    'payments',
    ms2,
    payment({
      milestoneId: ms2,
      status: 'pending',
      providerReference: `kp_${ms2}`,
      providerEnvironment: 'test',
      chargeMinor: EXPECTED_CHARGE,
      feeMinor: EXPECTED_FEE,
      verifyAttempts: 1,
    })
  );

  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;

  const init = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(init.status, 400);
  assert.match(init.body.message, /different Paystack environment/);

  const verify = await employerApi.post('/payments/verify', { body: { milestoneId: ms2 } });
  assert.equal(verify.status, 400);
  assert.match(verify.body.message, /different Paystack environment/);

  assert.equal(client.paystack.calls.length, 0);
  assert.equal(client.readDoc('payments', ms2).status, 'pending');
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

test('a live webhook does not reconcile a test-mode payment', async () => {
  const ms1 = await seedInitializedPayment('test');
  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;

  const res = await postWebhook(chargeSuccessEvent(`kp_${ms1}`), FAKE_LIVE_KEY);

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, false);
  assert.equal(client.readDoc('payments', ms1).status, 'pending');
  assert.equal(client.paystack.calls.length, 0);
});

test('a live webhook reconciles a live-tagged payment', async () => {
  const ms1 = await seedInitializedPayment('live');
  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;
  client.paystack.respondWithVerify(okVerify);

  const res = await postWebhook(chargeSuccessEvent(`kp_${ms1}`), FAKE_LIVE_KEY);

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, true);
  assert.equal(client.readDoc('payments', ms1).status, 'paid');
});

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

test('live payouts stay blocked until explicitly enabled', async () => {
  seedFundedMilestone({ paymentOverrides: { providerEnvironment: 'live' } });
  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;

  const created = await releaseService.createReleaseRequest({
    targetType: 'milestone',
    targetId: 'ms-1',
  });
  assert.equal(created.release.providerEnvironment, 'live');

  await assert.rejects(
    () =>
      orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: createSimulatedReleaseProvider(),
      }),
    expectCode('RELEASE_LIVE_PAYOUTS_DISABLED')
  );
  assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 0);

  process.env[LIVE_PAYOUTS_ENV] = 'true';
  const submitted = await orchestration.submitReleaseAttempt(RELEASE_ID, {
    provider: createSimulatedReleaseProvider(),
  });
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.outcome, 'succeeded');
  assert.equal(client.readDoc('releaseRequests', RELEASE_ID).providerEnvironment, 'live');
});

test('a test-funded release cannot be submitted while the server is live', async () => {
  seedFundedMilestone();
  process.env[MODE_ENV] = 'live';
  process.env[SECRET_KEY_ENV] = FAKE_LIVE_KEY;
  process.env[LIVE_PAYOUTS_ENV] = 'true';

  await releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' });

  await assert.rejects(
    () =>
      orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: createSimulatedReleaseProvider(),
      }),
    expectCode('RELEASE_INCONSISTENT_RECORD')
  );
  assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 0);
});

test('Test Mode payouts are never gated', async () => {
  seedFundedMilestone();
  delete process.env[MODE_ENV];
  delete process.env[LIVE_PAYOUTS_ENV];

  await releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' });
  const submitted = await orchestration.submitReleaseAttempt(RELEASE_ID, {
    provider: createSimulatedReleaseProvider(),
  });

  assert.equal(submitted.submitted, true);
  assert.equal(submitted.outcome, 'succeeded');
  assert.equal(client.readDoc('releaseRequests', RELEASE_ID).providerEnvironment, 'test');
});
