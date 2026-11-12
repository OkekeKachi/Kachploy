'use strict';

/**
 * Stage 1F tests for POST /payments/initialize -- the Test Mode Paystack
 * initialization flow. No real credential, no real Paystack request: the
 * paystackClient module was swapped for a queue-driven recording fake by
 * testing/testApp.js BEFORE the app chain loaded paymentService, so every
 * provider interaction is observed at client.paystack.calls.
 *
 * The REAL error classes are captured at module load -- before startTestServer
 * swaps the cache entry -- so the classification the service performs
 * (definitive 4xx vs ambiguous transport/timeout/5xx) is exercised with the
 * production classes where it matters.
 *
 * console.error is silenced around these tests for the same reason the
 * employment retry tests silence it: the 500 paths log by design, and the
 * reporter output stays readable without it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer } = require('../testing/testApp');
// Real classes, captured BEFORE testApp replaces the module in require.cache.
const {
  PaystackHttpError,
  PaystackTransportError,
  PaystackTimeoutError,
} = require('../services/paystackClient');
const { calculateCheckoutChargeMinor, calculateCheckoutFeeMinor } = require('../config/fees');
const { job, application, employment, task, milestone, payment, user } = require('../testing/fixtures');

const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const SECRET_KEY_ENV = 'PAYSTACK_SECRET_KEY';
const FAKE_CHECKOUT_URL = 'https://checkout.paystack.com/pay/test_auth_key';

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
// World setup, copied from payments.test.js so that suite stays untouched.
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
  // The initialize flow reads the employer's email from the users collection.
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

/** The world every initialize test starts in: hired, contracted, record created. */
async function setupPayment(msKey = 'ms1') {
  seedHiredWorld();
  const ids = await createContractWithTwoMilestones();
  const res = await employerApi.post('/payments', {
    body: { milestoneId: ids[msKey], idempotencyKey: `key-${msKey}` },
  });
  assert.equal(res.status, 200);
  return { ...ids, stored: () => client.readDoc('payments', ids[msKey]) };
}

/**
 * Full reset for the multi-case loops: resetAll clears the token map, so the
 * authed clients must be rebuilt or every later request would 401.
 */
async function resetWorld() {
  client.fake.resetAll();
  client.paystack.reset();
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
}

/** A provider responder returning a well-formed success envelope. */
const okResponder = (payload) => ({
  status: true,
  message: 'Authorization URL created',
  data: {
    authorization_url: FAKE_CHECKOUT_URL,
    access_code: 'access_code_1',
    reference: payload.reference,
  },
});

/** Expected server-derived money figures for the 500000-kobo milestone. */
const EXPECTED_CHARGE = calculateCheckoutChargeMinor(500000);
const EXPECTED_FEE = calculateCheckoutFeeMinor(EXPECTED_CHARGE);

// ---------------------------------------------------------------------------
// 1-2. Success: strict response whitelist, server-derived payload
// ---------------------------------------------------------------------------

test('a successful initialization returns only the approved response fields', async () => {
  const { ms1 } = await setupPayment();
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

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
  assert.equal(res.body.message, 'Payment initialization successful');
  assert.equal(res.body.paymentId, ms1);
  assert.equal(res.body.reference, `kp_${ms1}`);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.amountMinor, 500000, 'the original milestone amount');
  assert.equal(res.body.chargeMinor, EXPECTED_CHARGE, 'the gross charge from the fee calculator');
  assert.equal(res.body.feeMinor, EXPECTED_FEE, 'the modeled fee from the fee calculator');
  assert.equal(res.body.currency, 'NGN');
  assert.equal(res.body.checkoutUrl, FAKE_CHECKOUT_URL);

  // Exactly one provider call, and nothing provider-shaped beyond it.
  assert.equal(client.paystack.calls.length, 1);
  // No access code, no authorization object, no raw envelope anywhere.
  assert.equal(JSON.stringify(res.body).includes('access_code'), false);

  const attempt = client.readDoc('paymentAttempts', `${ms1}__attempt_1`);
  assert.equal(attempt.reference, `kp_${ms1}`);
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(attempt.status, 'pending');
  const referenceClaim = client.readDoc(
    'paymentReferences',
    crypto.createHash('sha256').update(`kp_${ms1}`).digest('hex')
  );
  assert.equal(referenceClaim.reference, `kp_${ms1}`);
  assert.equal(referenceClaim.attemptNumber, 1);
});

test('a pre-existing reference claim forces a distinct reference without reusing it', async () => {
  const { ms1, stored } = await setupPayment();
  const baseReference = `kp_${ms1}`;
  client.seed(
    'paymentReferences',
    crypto.createHash('sha256').update(baseReference).digest('hex'),
    {
      reference: baseReference,
      paymentId: 'some-other-payment',
      attemptId: 'some-other-payment__attempt_1',
      attemptNumber: 1,
      legacy: false,
    }
  );
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.reference, `${baseReference}_r1`);
  assert.equal(client.paystack.calls[0].payload.reference, `${baseReference}_r1`);
  assert.equal(stored().providerReference, `${baseReference}_r1`);
  assert.equal(
    client.readDoc(
      'paymentReferences',
      crypto.createHash('sha256').update(`${baseReference}_r1`).digest('hex')
    ).reference,
    `${baseReference}_r1`
  );
});

test('the provider payload is derived entirely from trusted server data', async () => {
  const { ms1 } = await setupPayment();
  client.paystack.respondWith(okResponder);

  await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  const call = client.paystack.calls[0];
  assert.equal(call.op, 'initializeTransaction');
  // Exact payload key set: no callback_url (none is trusted or defined), no
  // secret, nothing client-supplied.
  assert.deepEqual(Object.keys(call.payload).sort(), [
    'amount',
    'currency',
    'email',
    'metadata',
    'reference',
  ]);
  assert.equal(call.payload.email, 'employer@example.test', 'from the employer user document');
  assert.equal(call.payload.amount, EXPECTED_CHARGE, 'gross charge, not the milestone amount');
  assert.equal(call.payload.currency, 'NGN');
  assert.equal(call.payload.reference, `kp_${ms1}`);
  assert.deepEqual(Object.keys(call.payload.metadata).sort(), ['contractId', 'milestoneId']);
  assert.equal(call.payload.metadata.milestoneId, ms1);
  assert.equal(call.payload.metadata.contractId, 'emp-1');
});

// ---------------------------------------------------------------------------
// 3-5. Input and authorization refusals
// ---------------------------------------------------------------------------

test('a client cannot override any financial, status, identity or provider field', async () => {
  const { ms1, stored } = await setupPayment();
  const before = stored();

  const forbidden = [
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
    const res = await employerApi.post('/payments/initialize', {
      body: { milestoneId: ms1, [field]: 'nope' },
    });
    assert.equal(res.status, 400, `${field} must be refused`);
    assert.match(res.body.message, new RegExp(`${field} cannot be supplied`));
  }

  assert.equal(client.paystack.calls.length, 0, 'no provider call behind any refusal');
  assert.deepEqual(stored(), before, 'the record is byte-identical');
});

test('initialize requires authentication and the employer role', async () => {
  const { ms1, stored } = await setupPayment();
  const before = stored();

  const anonymous = await client.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(anonymous.status, 401);

  const asEmployee = await employeeApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(asEmployee.status, 403);

  const strangerApi = await client.authed('stranger-1');
  const asStranger = await strangerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(asStranger.status, 403);

  assert.equal(client.paystack.calls.length, 0);
  assert.deepEqual(stored(), before);
});

test('a milestone without a payment record is a 404 -- initialization creates nothing', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Payment not found');
  assert.equal(client.paystack.calls.length, 0);
  assert.equal(client.readDoc('payments', ms1), undefined, 'no record was created');
});

// ---------------------------------------------------------------------------
// 6. Configuration fails closed
// ---------------------------------------------------------------------------

test('missing Test Mode configuration answers 503 without a provider call or any write', async () => {
  const { ms1, stored } = await setupPayment();
  const before = stored();
  client.paystack.respondWith(okResponder);

  delete process.env[SECRET_KEY_ENV];
  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 503);
  assert.equal(res.body.message, 'Payment processing is not configured on this server');
  assert.equal(client.paystack.calls.length, 0, 'the provider was never contacted');
  assert.deepEqual(stored(), before, 'the record is untouched -- no latch, no fields');
});

// ---------------------------------------------------------------------------
// 7. Ambiguous provider outcomes never mark the payment failed
// ---------------------------------------------------------------------------

test('transport errors, timeouts and provider 5xx leave the record pending, never failed', async () => {
  const ambiguousCases = [
    ['transport failure', () => new PaystackTransportError('fetch failed', { cause: new TypeError('fetch failed') })],
    ['timeout', () => new PaystackTimeoutError('operation timed out')],
    // STAGE 1H.1 (F1). Constructed with the REAL PaystackHttpError signature
    // -- (message, { statusCode }) -- so this case produces an actual numeric
    // 500 and genuinely exercises the non-rollback branch. The previous form
    // passed the status as the message, leaving `statusCode` a string, so the
    // numeric-5xx path was never really tested here.
    ['provider 500', () => new PaystackHttpError('paystack unavailable', { statusCode: 500 })],
  ];

  for (const [label, makeError] of ambiguousCases) {
    await resetWorld();
    const { ms1, stored } = await setupPayment();
    client.paystack.respondWith(() => {
      throw makeError();
    });

    const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

    assert.equal(res.status, 500, label);
    assert.equal(res.body.message, 'Failed to initialize payment', label);
    assert.equal(JSON.stringify(res.body).includes('boom'), false, `${label}: no provider text`);

    const doc = stored();
    assert.equal(doc.status, 'pending', `${label}: latched, NOT failed`);
    assert.equal(doc.statusReason, 'initialization outcome unknown; verify before retrying', label);
    assert.equal(doc.verifyAttempts, 1, label);
    // The success-only fields were never written.
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'providerReference'), false, label);
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'chargeMinor'), false, label);
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'feeMinor'), false, label);

    // The ambiguous attempt is not blindly reinitialized: the NEXT request is
    // refused and makes no second provider call.
    const retry = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
    assert.equal(retry.status, 400, `${label}: ambiguous attempt must not reinitialize`);
    assert.match(
      retry.body.message,
      /awaiting verification and cannot be initialized again/,
      label
    );
    assert.equal(client.paystack.calls.length, 1, `${label}: exactly one provider call`);
    assert.equal(stored().status, 'pending', label);
  }
});

test('a provider 4xx is a definitive refusal: the record returns to created and a corrected retry succeeds', async () => {
  const { ms1, stored } = await setupPayment();
  client.paystack.respondWith(() => {
    const error = new Error('Paystack said no');
    error.statusCode = 400;
    throw error;
  });

  const refused = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(refused.status, 500);
  assert.equal(refused.body.message, 'Failed to initialize payment');

  const rolledBack = stored();
  assert.equal(rolledBack.status, 'created', 'a 4xx means no transaction exists -- retryable');
  assert.equal(rolledBack.statusReason, 'provider rejected the initialization request');
  assert.equal(rolledBack.verifyAttempts, 1, 'the attempt is still counted');

  // The corrected retry mints a new reference and proceeds.
  client.paystack.respondWith(okResponder);
  const retry = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.reference, `kp_${ms1}_a2`, 'a new single-use reference');
  assert.equal(stored().verifyAttempts, 2);
  assert.equal(client.paystack.calls.length, 2);
  assert.equal(client.paystack.calls[0].payload.reference, `kp_${ms1}`);
  assert.equal(client.paystack.calls[1].payload.reference, `kp_${ms1}_a2`);
});

test('a provider 409 or 429 stays latched pending -- neither is proof that no transaction exists', async () => {
  // STAGE 1H.1 (G3). 409 (conflict / duplicate reference) and 429 (throttle)
  // are deliberately NOT rollback statuses: both can occur AFTER a transaction
  // exists, so neither may reset the record to 'created' nor mark it 'failed'.
  // This asserts only that intended defensive behavior -- it does NOT assert
  // any Paystack duplicate-reference or idempotency semantics.
  for (const statusCode of [409, 429]) {
    await resetWorld();
    const { ms1, stored } = await setupPayment();
    client.paystack.respondWith(() => {
      throw new PaystackHttpError('paystack rejected the request', { statusCode });
    });

    const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

    assert.equal(res.status, 500, `${statusCode}: unconfirmed outcome is a 500`);
    assert.equal(res.body.message, 'Failed to initialize payment', statusCode);

    const doc = stored();
    assert.equal(doc.status, 'pending', `${statusCode}: latched, NOT created and NOT failed`);
    assert.equal(
      doc.statusReason,
      'initialization outcome unknown; verify before retrying',
      statusCode
    );
    assert.equal(doc.verifyAttempts, 1, statusCode);
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'providerReference'), false, statusCode);

    // The ambiguous attempt is not blindly reinitialized: the next request is
    // refused and makes no second provider call.
    const retry = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
    assert.equal(retry.status, 400, `${statusCode}: ambiguous attempt must not reinitialize`);
    assert.match(
      retry.body.message,
      /awaiting verification and cannot be initialized again/,
      statusCode
    );
    assert.equal(client.paystack.calls.length, 1, `${statusCode}: exactly one provider call`);
    assert.equal(stored().status, 'pending', statusCode);
  }
});

// ---------------------------------------------------------------------------
// 8. Malformed responses and unsafe checkout URLs
// ---------------------------------------------------------------------------

test('malformed envelopes and untrusted checkout URLs are rejected safely, leaving the record pending', async () => {
  const untrustedCases = [
    ['envelope without data', () => ({ status: true, message: 'Authorization URL created' })],
    ['null data', () => ({ status: true, message: 'ok', data: null })],
    ['http checkout URL', () => ({
      status: true,
      message: 'ok',
      data: { authorization_url: 'http://checkout.paystack.com/pay/x', reference: 'kp_ref' },
    })],
    ['suffix-spoofed host', () => ({
      status: true,
      message: 'ok',
      data: { authorization_url: 'https://checkout.paystack.com.evil.example/pay/x', reference: 'kp_ref' },
    })],
    ['unrelated https host', () => ({
      status: true,
      message: 'ok',
      data: { authorization_url: 'https://attacker.example/checkout', reference: 'kp_ref' },
    })],
    ['mismatched echoed reference', (payload) => ({
      status: true,
      message: 'ok',
      data: { authorization_url: FAKE_CHECKOUT_URL, reference: 'kp_SOMETHING_ELSE' },
    })],
  ];

  for (const [label, buildEnvelope] of untrustedCases) {
    await resetWorld();
    const { ms1, stored } = await setupPayment();
    client.paystack.respondWith((payload) => buildEnvelope(payload));

    const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

    assert.equal(res.status, 500, label);
    assert.equal(res.body.message, 'Failed to initialize payment', label);
    const body = JSON.stringify(res.body);
    assert.equal(body.includes('attacker'), false, label);
    assert.equal(body.includes('evil'), false, label);

    const doc = stored();
    assert.equal(doc.status, 'pending', `${label}: the transaction may exist -- not failed`);
    assert.equal(doc.statusReason, 'unusable provider response; verify before retrying', label);
    assert.equal(Object.prototype.hasOwnProperty.call(doc, 'providerReference'), false, label);
  }
});

// ---------------------------------------------------------------------------
// 9-10. Existing-record gates: paid, and any ambiguous prior attempt
// ---------------------------------------------------------------------------

test('an already-paid payment is never re-initialized', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.seed('payments', ms1, payment({ milestoneId: ms1, status: 'paid' }));
  const before = client.readDoc('payments', ms1);
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'this milestone payment has already been completed');
  assert.equal(client.paystack.calls.length, 0, 'no provider call for a completed payment');
  assert.deepEqual(client.readDoc('payments', ms1), before);
});

test('a failed payment without a provider reference retries with a new attempt reference', async () => {
  const { ms1, stored } = await setupPayment();
  const failedRecord = payment({
    milestoneId: ms1,
    status: 'failed',
    verifyAttempts: 1,
  });
  client.seed('payments', ms1, failedRecord);
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.reference, `kp_${ms1}_a2`);
  assert.equal(client.paystack.calls.length, 1);
  assert.equal(client.paystack.calls[0].payload.reference, `kp_${ms1}_a2`);

  const after = stored();
  assert.equal(after.status, 'pending', 'the confirmed failure is replaced only by a new attempt');
  assert.equal(after.verifyAttempts, 2, 'the failed attempt is counted');
  assert.equal(after.providerReference, `kp_${ms1}_a2`, 'the new reference is stored on success');
  assert.equal(after.idempotencyKey, failedRecord.idempotencyKey, 'the same record is reused');
  assert.equal(after.createdAt._seconds, failedRecord.createdAt._seconds);
  assert.equal(client.readDoc('paymentAttempts', `${ms1}__attempt_2`).status, 'pending');
  assert.equal(
    client.readDoc('paymentAttempts', `${ms1}__attempt_2`).reference,
    `kp_${ms1}_a2`
  );
});

test('a failed payment with a provider reference retries with a new reference', async () => {
  const { ms1, stored } = await setupPayment();
  const originalReference = `kp_${ms1}`;
  client.seed('payments', ms1, payment({
    milestoneId: ms1,
    status: 'failed',
    verifyAttempts: 1,
    providerReference: originalReference,
    providerEnvironment: 'test',
    chargeMinor: EXPECTED_CHARGE,
    feeMinor: EXPECTED_FEE,
  }));
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.reference, `kp_${ms1}_a2`);
  assert.equal(client.paystack.calls.length, 1, 'the new reference reaches the provider');
  assert.equal(client.paystack.calls[0].payload.reference, `kp_${ms1}_a2`);

  const after = stored();
  assert.equal(after.status, 'pending');
  assert.equal(after.verifyAttempts, 2, 'the retry consumes a new attempt');
  assert.equal(after.providerReference, `kp_${ms1}_a2`, 'the latest reference is stored');

  const legacyAttempt = client.readDoc('paymentAttempts', `${ms1}__attempt_1`);
  assert.equal(legacyAttempt.reference, originalReference);
  assert.equal(legacyAttempt.status, 'failed');
  assert.equal(legacyAttempt.legacy, true);
  assert.equal(
    client.readDoc('paymentAttempts', `${ms1}__attempt_2`).reference,
    `kp_${ms1}_a2`
  );
});

test('a legacy failed record with three attempts backfills its reference and continues safely', async () => {
  const { ms1, stored } = await setupPayment();
  const originalReference = `kp_${ms1}`;
  client.seed('payments', ms1, payment({
    milestoneId: ms1,
    status: 'failed',
    verifyAttempts: 3,
    providerReference: originalReference,
    providerEnvironment: 'test',
    chargeMinor: EXPECTED_CHARGE,
    feeMinor: EXPECTED_FEE,
    statusReason: 'provider rejected the initialization request',
  }));
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.reference, `kp_${ms1}_a4`, 'the legacy counter resumes at the next attempt');
  assert.equal(client.paystack.calls[0].payload.reference, `kp_${ms1}_a4`);
  assert.notEqual(client.paystack.calls[0].payload.reference, originalReference);

  const after = stored();
  assert.equal(after.status, 'pending');
  assert.equal(after.verifyAttempts, 4);
  assert.equal(after.providerReference, `kp_${ms1}_a4`);

  const legacyAttempt = client.readDoc('paymentAttempts', `${ms1}__attempt_3`);
  assert.equal(legacyAttempt.reference, originalReference);
  assert.equal(legacyAttempt.status, 'failed');
  assert.equal(legacyAttempt.legacy, true);
  assert.equal(
    client.readDoc('paymentAttempts', `${ms1}__attempt_4`).reference,
    `kp_${ms1}_a4`
  );
  assert.equal(
    client.readDoc('paymentReferences', crypto.createHash('sha256').update(originalReference).digest('hex')).reference,
    originalReference
  );
});

test('a legacy failed milestone retry succeeds when charge/fee are missing from the stored record', async () => {
  const { ms1, stored } = await setupPayment();
  const originalReference = `kp_${ms1}`;
  client.seed('payments', ms1, payment({
    milestoneId: ms1,
    status: 'failed',
    verifyAttempts: 3,
    providerReference: originalReference,
    providerEnvironment: 'test',
  }));
  delete client.readDoc('payments', ms1).chargeMinor;
  delete client.readDoc('payments', ms1).feeMinor;
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.reference, `kp_${ms1}_a4`);
  assert.equal(client.paystack.calls.length, 1);
  assert.equal(client.paystack.calls[0].payload.reference, `kp_${ms1}_a4`);

  const after = stored();
  assert.equal(after.status, 'pending');
  assert.equal(after.verifyAttempts, 4);

  const legacyAttempt = client.readDoc('paymentAttempts', `${ms1}__attempt_3`);
  assert.equal(legacyAttempt.reference, originalReference);
  assert.equal(legacyAttempt.status, 'failed');
  assert.equal(legacyAttempt.legacy, true);
});

test('a failed retry with an ambiguous provider outcome stays pending and is not reinitialized', async () => {
  const { ms1, stored } = await setupPayment();
  client.seed('payments', ms1, payment({
    milestoneId: ms1,
    status: 'failed',
    verifyAttempts: 1,
  }));
  client.paystack.respondWith(() => new PaystackTransportError('fetch failed'));

  const first = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(first.status, 500);
  assert.equal(stored().status, 'pending');
  assert.equal(stored().verifyAttempts, 2);

  const second = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(second.status, 400);
  assert.match(second.body.message, /awaiting verification and cannot be initialized again/);
  assert.equal(client.paystack.calls.length, 1);
});

test('a definitive provider rejection during retry preserves failed and still counts the attempt', async () => {
  const { ms1, stored } = await setupPayment();
  client.seed('payments', ms1, payment({
    milestoneId: ms1,
    status: 'failed',
    verifyAttempts: 1,
  }));
  client.paystack.respondWith(() => {
    const error = new Error('Paystack said no');
    error.statusCode = 422;
    throw error;
  });

  const refused = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(refused.status, 500);

  const afterRejection = stored();
  assert.equal(afterRejection.status, 'failed', 'a retry failure stays a confirmed failure');
  assert.equal(afterRejection.verifyAttempts, 2);
  assert.equal(
    afterRejection.providerReference,
    undefined,
    'a rejected request never stores a provider reference'
  );
  assert.equal(client.readDoc('paymentAttempts', `${ms1}__attempt_2`).status, 'failed');

  client.paystack.respondWith(okResponder);
  const retry = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.reference, `kp_${ms1}_a3`);
  assert.equal(stored().status, 'pending');
  assert.equal(stored().verifyAttempts, 3);
  assert.equal(stored().providerReference, `kp_${ms1}_a3`);
});

test('recent initialization attempts are throttled without permanently consuming the payment', async () => {
  const { ms1, stored } = await setupPayment();
  const before = stored();
  const now = new Date();
  for (let attemptNumber = 10; attemptNumber <= 14; attemptNumber += 1) {
    client.seed('paymentAttempts', `${ms1}__attempt_${attemptNumber}`, {
      paymentId: ms1,
      attemptNumber,
      createdAt: now,
    });
  }
  client.paystack.respondWith(okResponder);

  const throttled = await employerApi.post('/payments/initialize', {
    body: { milestoneId: ms1 },
  });

  assert.equal(throttled.status, 400);
  assert.match(throttled.body.message, /too many payment attempts/);
  assert.equal(client.paystack.calls.length, 0, 'no provider call while throttled');
  assert.deepEqual(stored(), before, 'the record is untouched while throttled');

  for (let attemptNumber = 10; attemptNumber <= 14; attemptNumber += 1) {
    client.seed('paymentAttempts', `${ms1}__attempt_${attemptNumber}`, {
      paymentId: ms1,
      attemptNumber,
      createdAt: new Date(now.getTime() - 2 * 60 * 1000),
    });
  }

  const afterWindow = await employerApi.post('/payments/initialize', {
    body: { milestoneId: ms1 },
  });
  assert.equal(afterWindow.status, 200, 'old attempts no longer count against the window');
  assert.equal(afterWindow.body.reference, `kp_${ms1}`);
});

test('two concurrent failed retries make exactly one provider call and one latch', async () => {
  const { ms1, stored } = await setupPayment();
  client.seed('payments', ms1, payment({
    milestoneId: ms1,
    status: 'failed',
    verifyAttempts: 2,
  }));
  client.paystack.respondWith(okResponder);

  const [a, b] = await Promise.all([
    employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } }),
    employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } }),
  ]);

  assert.deepEqual([a.status, b.status].sort(), [200, 400]);
  assert.equal(
    client.paystack.calls.filter((call) => call.op === 'initializeTransaction').length,
    1,
    'only the winning retry reaches the provider'
  );
  assert.equal(stored().status, 'pending');
  assert.equal(stored().verifyAttempts, 3);
  assert.equal(stored().providerReference, `kp_${ms1}_a3`);

  client.paystack.respondWithVerify((reference) => ({
    status: true,
    message: 'Verification successful',
    data: {
      reference,
      currency: 'NGN',
      amount: EXPECTED_CHARGE,
      status: 'failed',
    },
  }));
  const verified = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.payment.status, 'failed');
  assert.equal(stored().verifyAttempts, 3);

  client.paystack.respondWith(okResponder);
  const afterFailure = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(afterFailure.status, 200);
  assert.equal(afterFailure.body.reference, `kp_${ms1}_a4`);
  assert.equal(
    client.paystack.calls.filter((call) => call.op === 'initializeTransaction').length,
    2,
    'a confirmed failure can start a new attempt with a new reference'
  );
  assert.equal(stored().status, 'pending');
  assert.equal(stored().verifyAttempts, 4);
  assert.equal(stored().providerReference, `kp_${ms1}_a4`);
});

test('an unresolved or needs-review attempt is refused, not retried', async () => {
  // First attempt goes ambiguous...
  const { ms1, stored } = await setupPayment();
  client.paystack.respondWith(() => new PaystackTransportError('fetch failed'));
  const first = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(first.status, 500);

  // ...and the second request is refused with the provider called EXACTLY once.
  const second = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(second.status, 400);
  assert.match(second.body.message, /awaiting verification and cannot be initialized again/);
  assert.equal(client.paystack.calls.length, 1, 'the ambiguous attempt is not blindly repeated');
  assert.equal(stored().status, 'pending');

  // A needs-review outcome is unresolved, not retryable.
  await resetWorld();
  const seeded = await setupPayment();
  client.seed('payments', seeded.ms1, payment({ milestoneId: seeded.ms1, status: 'needs_review' }));
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: seeded.ms1 } });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /awaiting verification and cannot be initialized again/);
  assert.equal(client.paystack.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 11. Persistence: partial updates preserve every existing field
// ---------------------------------------------------------------------------

test('a successful initialization preserves every existing field and adds only the approved ones', async () => {
  const { ms1, stored } = await setupPayment();
  const before = stored();
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });
  assert.equal(res.status, 200);

  const after = stored();
  // Every pre-existing field is byte-identical except the latched status.
  for (const key of Object.keys(before)) {
    if (key === 'status') continue;
    assert.deepEqual(after[key], before[key], `existing field ${key} must be untouched`);
  }
  // Exactly the four approved additions, no more. `providerEnvironment` is
  // stamped when the record is created, so it is not an initialization key.
  const newKeys = Object.keys(after).filter((key) => !Object.prototype.hasOwnProperty.call(before, key));
  assert.deepEqual(newKeys.sort(), [
    'chargeMinor',
    'feeMinor',
    'providerReference',
    'verifyAttempts',
  ]);
  assert.equal(after.status, 'pending');
  assert.equal(after.providerReference, `kp_${ms1}`);
  assert.equal(after.providerEnvironment, 'test');
  assert.equal(after.chargeMinor, EXPECTED_CHARGE);
  assert.equal(after.feeMinor, EXPECTED_FEE);
  assert.equal(after.verifyAttempts, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(after, 'statusReason'), false, 'no reason on success');

  // The party-scoped read still serves the updated record.
  const read = await employerApi.get(`/payments/milestone/${ms1}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.payment.status, 'pending');
  assert.equal(read.body.payment.providerReference, `kp_${ms1}`);
});

// ---------------------------------------------------------------------------
// Reference suitability
// ---------------------------------------------------------------------------

test('a milestone id that cannot form a safe reference is refused before any write or call', async () => {
  seedHiredWorld();
  await createContractWithTwoMilestones();
  // A milestone seeded out of band under an id with unsafe characters.
  client.seed(
    'milestones',
    'ms$evil/id',
    milestone({ contractId: 'emp-1', taskId: 'task-1', amountMinor: 500000 })
  );
  client.seed('payments', 'ms$evil/id', payment({ milestoneId: 'ms$evil/id' }));
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', {
    body: { milestoneId: 'ms$evil/id' },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'milestoneId cannot be used to build a payment reference');
  assert.equal(client.paystack.calls.length, 0);
  assert.equal(client.readDoc('payments', 'ms$evil/id').status, 'created', 'no latch');
});

// ---------------------------------------------------------------------------
// 12. Pre-task eligibility: payment initialization does not require an
//     approved (or any) task linked to the milestone
// ---------------------------------------------------------------------------

test('payment initialization succeeds for a milestone with no linked task', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, linkTasks: false });
  await employerApi.post('/payments', { body: { milestoneId: ms1, idempotencyKey: 'key-1' } });
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.reference, `kp_${ms1}`);
  assert.equal(client.paystack.calls.length, 1);

  const attempt = client.readDoc('paymentAttempts', `${ms1}__attempt_1`);
  assert.equal(attempt.status, 'pending');
  assert.equal(attempt.reference, `kp_${ms1}`);
});

test('payment initialization succeeds when a task exists but is not approved', async () => {
  seedHiredWorld();
  seedTasksOnEmp1(['task-1', { status: 'assigned' }], ['task-2', { status: 'submitted' }]);
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, linkTasks: true });
  await employerApi.post('/payments', { body: { milestoneId: ms1, idempotencyKey: 'key-1' } });
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.reference, `kp_${ms1}`);
  assert.equal(client.paystack.calls.length, 1);
});

test('payment initialization succeeds when a task exists but is not linked to the milestone', async () => {
  seedHiredWorld();
  seedTasksOnEmp1(['task-1', { status: 'approved' }]);
  const { ms1 } = await createContractWithTwoMilestones({ seedTasks: false, linkTasks: false });
  await employerApi.post('/payments', { body: { milestoneId: ms1, idempotencyKey: 'key-1' } });
  client.paystack.respondWith(okResponder);

  const res = await employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'pending');
  assert.equal(res.body.reference, `kp_${ms1}`);
  assert.equal(client.paystack.calls.length, 1);
});

// ---------------------------------------------------------------------------
// STAGE 1K: concurrent initialization latches at most once
// ---------------------------------------------------------------------------

test('two concurrent initializations make EXACTLY ONE provider call and one latch', async () => {
  const { ms1, stored } = await setupPayment();

  // Exactly ONE responder is queued: if a second provider call were made, the
  // fake paystack would throw for a missing responder and that request would
  // fail -- which is precisely the bug this test exists to catch.
  client.paystack.respondWith(okResponder);

  const [a, b] = await Promise.all([
    employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } }),
    employerApi.post('/payments/initialize', { body: { milestoneId: ms1 } }),
  ]);

  // One request claims the latch and reaches the provider (200); the other is
  // refused without a provider call (400).
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400]);
  const refused = a.status === 400 ? a : b;
  assert.match(refused.body.message, /awaiting verification and cannot be initialized again/);

  // The invariant the stage exists to guarantee: at most one provider call.
  assert.equal(
    client.paystack.calls.filter((c) => c.op === 'initializeTransaction').length,
    1,
    'a concurrent initialization must not make a second provider call'
  );
  assert.equal(client.paystack.calls.length, 1);

  // The record was latched exactly once, and the attempt count is 1 (not 2).
  assert.equal(stored().status, 'pending');
  assert.equal(stored().verifyAttempts, 1);
});
