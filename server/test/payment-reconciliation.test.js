'use strict';

/**
 * Stage 1 reconciliation/recovery tests.
 *
 * These pin the properties the earlier stages only enforced at READ time:
 *
 *   * the outcome transaction re-checks the CURRENT document, so a slower
 *     verification cannot downgrade a payment that a concurrent one just paid;
 *   * a success that lands on a concurrently failed record is escalated to
 *     needs_review instead of being promoted to paid;
 *   * a record left pending because its outcome write failed is recoverable by
 *     a later verification, and re-verification of a settled record is
 *     idempotent.
 *
 * The Paystack client and Firestore are the same recording/in-memory doubles
 * used by the rest of the payment suite; nothing here can reach a provider or a
 * real database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { calculateCheckoutChargeMinor, calculateCheckoutFeeMinor } = require('../config/fees');
const { job, application, employment, task, payment, user } = require('../testing/fixtures');

const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const SECRET_KEY_ENV = 'PAYSTACK_SECRET_KEY';

let client;
let employerApi;
let employeeApi;
const savedEnv = { had: false, value: undefined };
let originalConsoleError;

test.before(async () => {
  client = await startTestServer();
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

const EXPECTED_CHARGE = calculateCheckoutChargeMinor(500000);
const EXPECTED_FEE = calculateCheckoutFeeMinor(EXPECTED_CHARGE);

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
  return { ms1: res.body.milestones[0].id };
}

async function seedInitializedPayment(overrides = {}) {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.seed(
    'payments',
    ms1,
    payment({
      milestoneId: ms1,
      status: 'pending',
      providerReference: `kp_${ms1}`,
      providerEnvironment: 'test',
      chargeMinor: EXPECTED_CHARGE,
      feeMinor: EXPECTED_FEE,
      verifyAttempts: 1,
      ...overrides,
    })
  );
  return { ms1, stored: () => client.readDoc('payments', ms1) };
}

const okVerifyResponder = (reference, dataOverrides = {}) => ({
  status: true,
  message: 'Verification successful',
  data: {
    reference,
    currency: 'NGN',
    amount: EXPECTED_CHARGE,
    status: 'success',
    fees: 1234,
    ...dataOverrides,
  },
});

async function waitFor(predicate, label) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 2000) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// 1. Recovery after the outcome write itself fails
// ---------------------------------------------------------------------------

test('a pending record whose outcome write failed is recovered by a later verification', async () => {
  const { ms1, stored } = await seedInitializedPayment();

  // The provider call succeeds; the commit fails. In production this is the
  // "Paystack collected the money but Firestore did not record it" window.
  const repository = require('../repositories/paymentAttemptRepository');
  const original = repository.applyPaymentAndAttemptOutcome;
  let failOnce = true;
  repository.applyPaymentAndAttemptOutcome = async (args) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('simulated Firestore commit failure');
    }
    return original(args);
  };

  try {
    client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

    const failedAttempt = await employerApi.post('/payments/verify', {
      body: { milestoneId: ms1 },
    });
    assert.equal(failedAttempt.status, 500, 'an unrecorded outcome is ambiguous');
    assert.equal(stored().status, 'pending', 'the record is left untouched for recovery');
  } finally {
    repository.applyPaymentAndAttemptOutcome = original;
  }

  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const recovered = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(recovered.status, 200);
  assert.equal(recovered.body.verified, true);
  assert.equal(recovered.body.payment.status, 'paid');
  assert.equal(stored().status, 'paid');
  assert.ok(stored().paidAt, 'the recovery stamps paidAt');
  assert.equal(client.paystack.calls.length, 2, 'one provider call per verification');
});

// ---------------------------------------------------------------------------
// 2. Recovery from a needs_review divergence
// ---------------------------------------------------------------------------

test('a needs_review record is promoted to paid by a later authoritative success', async () => {
  const { ms1, stored } = await seedInitializedPayment({
    status: 'needs_review',
    statusReason: 'provider response did not match the expected transaction',
  });

  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.payment.status, 'paid');
  assert.equal(stored().status, 'paid');
  assert.equal(stored().statusReason, null, 'the review reason is cleared on a paid outcome');
});

// ---------------------------------------------------------------------------
// 3. A late failure cannot downgrade a concurrently paid record
// ---------------------------------------------------------------------------

test('a late failed outcome cannot downgrade a concurrently paid payment', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.seed('paymentAttempts', `${ms1}__attempt_1`, {
    paymentId: ms1,
    attemptNumber: 1,
    reference: `kp_${ms1}`,
    status: 'pending',
  });

  let releaseSuccess;
  let releaseFailure;
  const successGate = new Promise((resolve) => {
    releaseSuccess = resolve;
  });
  const failureGate = new Promise((resolve) => {
    releaseFailure = resolve;
  });

  client.paystack.respondWithVerify(async (reference) => {
    await successGate;
    return okVerifyResponder(reference);
  });
  client.paystack.respondWithVerify(async (reference) => {
    await failureGate;
    return okVerifyResponder(reference, { status: 'failed' });
  });

  const first = employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });
  await waitFor(() => client.paystack.calls.length === 1, 'the first provider call');

  const second = employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });
  await waitFor(() => client.paystack.calls.length === 2, 'the second provider call');

  // Both verifications have read 'pending' and are now waiting on the provider.
  releaseSuccess();
  const firstRes = await first;
  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.payment.status, 'paid');
  const paidSnapshot = stored();
  assert.equal(paidSnapshot.status, 'paid');

  releaseFailure();
  const secondRes = await second;

  assert.equal(secondRes.status, 200);
  assert.equal(secondRes.body.verified, true);
  assert.equal(secondRes.body.payment.status, 'paid', 'the late failure is refused');
  assert.deepEqual(stored(), paidSnapshot, 'no stored field is downgraded');
  assert.equal(
    client.readDoc('paymentAttempts', `${ms1}__attempt_1`).status,
    'paid',
    'the attempt is not downgraded either'
  );
});

// ---------------------------------------------------------------------------
// 4. A success cannot promote a concurrently failed record
// ---------------------------------------------------------------------------

test('a success landing on a concurrently failed record is escalated, never promoted', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.seed('paymentAttempts', `${ms1}__attempt_1`, {
    paymentId: ms1,
    attemptNumber: 1,
    reference: `kp_${ms1}`,
    status: 'pending',
  });

  let releaseFailure;
  let releaseSuccess;
  const failureGate = new Promise((resolve) => {
    releaseFailure = resolve;
  });
  const successGate = new Promise((resolve) => {
    releaseSuccess = resolve;
  });

  client.paystack.respondWithVerify(async (reference) => {
    await failureGate;
    return okVerifyResponder(reference, { status: 'failed' });
  });
  client.paystack.respondWithVerify(async (reference) => {
    await successGate;
    return okVerifyResponder(reference);
  });

  const first = employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });
  await waitFor(() => client.paystack.calls.length === 1, 'the first provider call');

  const second = employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });
  await waitFor(() => client.paystack.calls.length === 2, 'the second provider call');

  releaseFailure();
  const firstRes = await first;
  assert.equal(firstRes.status, 200);
  assert.equal(firstRes.body.payment.status, 'failed');
  assert.equal(stored().status, 'failed');

  releaseSuccess();
  const secondRes = await second;

  assert.equal(secondRes.status, 200);
  assert.equal(secondRes.body.verified, false);
  assert.equal(secondRes.body.payment.status, 'needs_review', 'failed -> paid stays forbidden');
  assert.equal(stored().status, 'needs_review');
  assert.notEqual(stored().status, 'paid');
});
