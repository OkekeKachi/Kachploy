'use strict';

/**
 * Stage 1L tests for POST /payments/webhook -- the signature-verified Paystack
 * webhook that reconciles a successful charge even when the employer never
 * returns from checkout.
 *
 * No real credential, no real Paystack request: testing/testApp.js swaps
 * paystackClient for the recording fake AND swaps config/firebase for the
 * in-memory store. The webhook re-verifies with the provider through the same
 * fake verify queue the /payments/verify tests use, so the webhook's authority
 * is always a queued provider envelope, never the raw event body.
 *
 * Real client error classes are captured BEFORE testApp swaps the cache entry.
 *
 * console.error is silenced around these tests (the 500 paths log by design).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer } = require('../testing/testApp');
const {
  PaystackHttpError,
  PaystackTransportError,
  PaystackTimeoutError,
} = require('../services/paystackClient');
const { calculateCheckoutChargeMinor, calculateCheckoutFeeMinor } = require('../config/fees');
const { job, application, employment, task, payment, user } = require('../testing/fixtures');

const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const SECRET_KEY_ENV = 'PAYSTACK_SECRET_KEY';
const SIGNATURE_HEADER = 'x-paystack-signature';

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

// ---------------------------------------------------------------------------
// World setup, copied from payment-verify.test.js so that suite stays untouched.
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

const EXPECTED_CHARGE = calculateCheckoutChargeMinor(500000);
const EXPECTED_FEE = calculateCheckoutFeeMinor(EXPECTED_CHARGE);

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

/** A well-formed verify data object for the given reference. */
const verifyData = (overrides = {}) => ({
  reference: 'kp_ms-placeholder',
  currency: 'NGN',
  amount: EXPECTED_CHARGE,
  status: 'success',
  fees: 1234,
  ...overrides,
});

const okVerifyResponder = (reference, dataOverrides = {}) => ({
  status: true,
  message: 'Verification successful',
  data: verifyData({ reference, ...dataOverrides }),
});

/** Queues a verify responder that re-queues itself so a retry sequence can run. */
function alwaysVerify(fn) {
  const wrapped = (reference) => {
    client.paystack.respondWithVerify(wrapped);
    return fn(reference);
  };
  client.paystack.respondWithVerify(wrapped);
}

// ---------------------------------------------------------------------------
// Webhook helpers
// ---------------------------------------------------------------------------

/** The exact bytes a webhook body serialises to. */
const rawBody = (event) => JSON.stringify(event);

/** Paystack's HMAC-SHA512 hex digest of `body` under `secret`. */
const sign = (body, secret = FAKE_TEST_KEY) =>
  crypto.createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');

/** A charge.success event whose reference is the deterministic kp_<milestoneId>. */
const chargeSuccessEvent = (milestoneId, dataOverrides = {}) => ({
  event: 'charge.success',
  data: {
    reference: `kp_${milestoneId}`,
    currency: 'NGN',
    amount: EXPECTED_CHARGE,
    status: 'success',
    ...dataOverrides,
  },
});

/**
 * Posts a webhook body with a correct signature (unless overridden), returning
 * the harness response. The body is sent as the exact string that was signed.
 */
const postWebhook = (event, { signature, secret = FAKE_TEST_KEY, headers = {}, raw } = {}) => {
  const body = raw !== undefined ? raw : rawBody(event);
  const sig = signature !== undefined ? signature : sign(body, secret);
  const finalHeaders = { ...headers };
  if (sig !== null) {
    finalHeaders[SIGNATURE_HEADER] = sig;
  }
  return client.post('/payments/webhook', { body, headers: finalHeaders });
};

// ===========================================================================
// 1. Valid signature and matching successful payment
// ===========================================================================

test('a valid signature and a matching success event reconcile the payment to paid', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await postWebhook(chargeSuccessEvent(ms1));

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, true);
  assert.equal(res.body.message, 'Webhook processed');

  // The transition still came from a provider re-verification, not the event.
  assert.equal(client.paystack.calls.length, 1);
  assert.equal(client.paystack.calls[0].op, 'verifyTransaction');
  assert.equal(client.paystack.calls[0].reference, `kp_${ms1}`);

  const doc = stored();
  assert.equal(doc.status, 'paid');
  assert.ok(doc.paidAt, 'paidAt stamped');
  assert.ok(doc.verifiedAt, 'verifiedAt stamped');

  // No secret or payload text echoed back.
  assert.equal(JSON.stringify(res.body).includes(FAKE_TEST_KEY), false);
});

test('the webhook does NOT mark paid from the event alone when re-verification says otherwise', async () => {
  // The event claims success, but the authoritative provider verify reports a
  // mismatch (wrong amount). The webhook must NOT become paid.
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) =>
    okVerifyResponder(reference, { amount: EXPECTED_CHARGE + 1 })
  );

  const res = await postWebhook(chargeSuccessEvent(ms1));

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, false);
  assert.equal(stored().status, 'needs_review');
  assert.notEqual(stored().status, 'paid');
});

// ===========================================================================
// 2. Missing, malformed and invalid signatures
// ===========================================================================

test('missing, malformed and invalid signatures are rejected with 401 and change nothing', async () => {
  const cases = [
    ['missing header', { signature: null }],
    ['empty header', { signature: '' }],
    ['malformed header', { signature: 'not-a-hex-digest' }],
    ['wrong length', { signature: 'abcd' }],
    ['valid length, wrong value', { signature: 'a'.repeat(128) }],
    ['signed with the wrong secret', { signature: sign('{}', 'sk_test_wrong_wrong_wrong') }],
  ];

  for (const [label, opts] of cases) {
    client.fake.resetAll();
    client.paystack.reset();
    employerApi = await client.authed('employer-1');
    employeeApi = await client.authed('employee-1');
    const { ms1, stored } = await seedInitializedPayment();
    client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

    const res = await postWebhook(chargeSuccessEvent(ms1), opts);

    assert.equal(res.status, 401, label);
    assert.equal(stored().status, 'pending', `${label}: record untouched`);
    assert.equal(client.paystack.calls.length, 0, `${label}: no provider call`);
  }
});

test('a correct signature over a DIFFERENT body than was sent is rejected', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const sent = rawBody(chargeSuccessEvent(ms1));
  const signed = rawBody(chargeSuccessEvent(ms1, { amount: 1 }));

  const res = await client.post('/payments/webhook', {
    body: sent,
    headers: { [SIGNATURE_HEADER]: sign(signed) },
  });

  assert.equal(res.status, 401);
  assert.equal(stored().status, 'pending');
  assert.equal(client.paystack.calls.length, 0);
});

// ===========================================================================
// 3. Incorrect reference / amount / currency / event
// ===========================================================================

test('an event reference with the wrong prefix or an unknown milestone is refused and reconciles nothing', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const wrongPrefix = chargeSuccessEvent(ms1, { reference: 'paystack_ref_123' });
  const res1 = await postWebhook(wrongPrefix);
  assert.equal(res1.status, 200);
  assert.equal(res1.body.reconciled, false);
  assert.equal(stored().status, 'pending');

  const unknown = chargeSuccessEvent('ms-does-not-exist');
  const res2 = await postWebhook(unknown);
  assert.equal(res2.status, 200);
  assert.equal(res2.body.reconciled, false);
  assert.equal(res2.body.message, 'Webhook processed');

  // A reference we did not mint is never resolved into a payment, and nothing
  // was created by the webhook for the unknown milestone.
  assert.equal(client.readDoc('payments', 'ms-does-not-exist'), undefined);
  assert.equal(client.paystack.calls.length, 0);
});

test('an event whose currency or amount contradicts the stored record becomes needs_review, never paid', async () => {
  const cases = [
    ['wrong currency', { currency: 'USD' }],
    ['wrong amount', { amount: EXPECTED_CHARGE + 500 }],
    ['non-numeric amount', { amount: '500000' }],
  ];

  for (const [label, dataOverrides] of cases) {
    client.fake.resetAll();
    client.paystack.reset();
    employerApi = await client.authed('employer-1');
    employeeApi = await client.authed('employee-1');
    const { ms1, stored } = await seedInitializedPayment();
    client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

    const res = await postWebhook(chargeSuccessEvent(ms1, dataOverrides));

    assert.equal(res.status, 200, label);
    assert.equal(res.body.reconciled, false, label);
    assert.equal(stored().status, 'needs_review', label);
    assert.notEqual(stored().status, 'paid', label);
    // The contradiction is caught BEFORE any provider call.
    assert.equal(client.paystack.calls.length, 0, `${label}: no provider call`);
  }
});

test('a non-actionable or failed-charge event is acknowledged but changes nothing', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const failedCharge = {
    event: 'charge.failed',
    data: { reference: `kp_${ms1}`, currency: 'NGN', amount: EXPECTED_CHARGE, status: 'failed' },
  };
  const res = await postWebhook(failedCharge);

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, true, 'acknowledged');
  assert.equal(res.body.message, 'Webhook acknowledged');
  assert.equal(stored().status, 'pending', 'a failed event never marks the record failed');
  assert.equal(client.paystack.calls.length, 0);
});

// ===========================================================================
// 4. Duplicate delivery
// ===========================================================================

test('a duplicate delivery of the same event is idempotent and makes no second provider call', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const first = await postWebhook(chargeSuccessEvent(ms1));
  assert.equal(first.status, 200);
  assert.equal(first.body.reconciled, true);
  assert.equal(stored().status, 'paid');
  assert.equal(client.paystack.calls.length, 1);

  // Second identical delivery: the record is already paid, so the shared
  // verify path short-circuits with NO provider call (decision D4).
  const second = await postWebhook(chargeSuccessEvent(ms1));
  assert.equal(second.status, 200);
  assert.equal(second.body.reconciled, true);
  assert.equal(stored().status, 'paid');
  assert.equal(client.paystack.calls.length, 1, 'no second provider call');
});

// ===========================================================================
// 5. Unknown payment reference
// ===========================================================================

test('a delayed event for an older attempt cannot settle the current attempt', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.seed('payments', ms1, {
    ...stored(),
    verifyAttempts: 2,
    providerReference: `kp_${ms1}_a2`,
  });
  client.seed('paymentAttempts', `${ms1}__attempt_2`, {
    paymentId: ms1,
    attemptNumber: 2,
    reference: `kp_${ms1}_a2`,
    status: 'pending',
  });
  const before = stored();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await postWebhook(chargeSuccessEvent(ms1));

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, false);
  assert.equal(client.paystack.calls.length, 0, 'stale evidence is not re-verified');
  assert.deepEqual(stored(), before, 'the current attempt is untouched');
});

test('an unknown reference is acknowledged without creating a record or contacting the provider', async () => {
  seedHiredWorld();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await postWebhook(chargeSuccessEvent('ms-never-initialized'));

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, false);
  assert.equal(client.readDoc('payments', 'ms-never-initialized'), undefined);
  assert.equal(client.paystack.calls.length, 0);
});

// ===========================================================================
// 6. Already-paid payment receiving another event
// ===========================================================================

test('an already-paid record receiving another success event stays paid and never downgrades', async () => {
  const { ms1, stored } = await seedInitializedPayment({ status: 'paid' });
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await postWebhook(chargeSuccessEvent(ms1));

  assert.equal(res.status, 200);
  assert.equal(res.body.reconciled, true);
  assert.equal(stored().status, 'paid');
  // Already paid short-circuits before any provider call.
  assert.equal(client.paystack.calls.length, 0);
});

// ===========================================================================
// 7. Failure during processing and safe retry
// ===========================================================================

test('an ambiguous provider outcome answers 500 and leaves the record pending for a safe retry', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  alwaysVerify(() => {
    throw new PaystackTransportError('network down');
  });

  const res = await postWebhook(chargeSuccessEvent(ms1));

  assert.equal(res.status, 500);
  assert.equal(res.body.reconciled, undefined);
  assert.equal(stored().status, 'pending', 'a transport failure proves nothing');

  // A retry of the SAME event, now with a healthy provider, settles it.
  client.paystack.reset();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));
  const retry = await postWebhook(chargeSuccessEvent(ms1));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.reconciled, true);
  assert.equal(stored().status, 'paid');
});

test('a definitive provider 4xx during webhook reconciliation answers 500 and does not falsely settle', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  alwaysVerify(() => {
    throw new PaystackHttpError('rejected', { statusCode: 400 });
  });

  const res = await postWebhook(chargeSuccessEvent(ms1));

  assert.equal(res.status, 500);
  assert.notEqual(stored().status, 'paid');
});

test('an unconfigured server refuses every webhook with 503 and changes nothing', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  delete process.env[SECRET_KEY_ENV];
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await postWebhook(chargeSuccessEvent(ms1));

  assert.equal(res.status, 503);
  assert.equal(stored().status, 'pending');
  assert.equal(client.paystack.calls.length, 0);
});

// ===========================================================================
// 8. Existing initialize / verify behavior unchanged alongside the webhook
// ===========================================================================

test('the client verify route still works unchanged after the webhook was added', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  assert.equal(stored().status, 'paid');
  assert.equal(client.paystack.calls.length, 1);
});

test('the webhook route requires no bearer token but every other payment route still does', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  // No token: the webhook with a valid signature is accepted.
  const hook = await postWebhook(chargeSuccessEvent(ms1));
  assert.equal(hook.status, 200);
  assert.equal(stored().status, 'paid');

  // No token: the ordinary verify route is still rejected by protect.
  const noAuth = await client.post('/payments/verify', { body: { milestoneId: ms1 } });
  assert.equal(noAuth.status, 401);
});
