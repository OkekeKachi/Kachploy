'use strict';

/**
 * Stage 1G tests for POST /payments/verify -- the Test Mode Paystack
 * verification flow. No real credential, no real Paystack request: the
 * paystackClient module was swapped for the recording fake by
 * testing/testApp.js. Verify responses are queued with respondWithVerify, so
 * they never collide with initialize responses.
 *
 * Real client error classes are captured BEFORE testApp swaps the cache entry,
 * so the service's transient-vs-definitive classification is exercised with
 * production classes.
 *
 * console.error is silenced around these tests (the 500 paths log by design).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const {
  PaystackHttpError,
  PaystackTransportError,
  PaystackTimeoutError,
  PaystackResponseError,
} = require('../services/paystackClient');
const { calculateCheckoutChargeMinor, calculateCheckoutFeeMinor } = require('../config/fees');
const { job, application, employment, task, payment, user } = require('../testing/fixtures');

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
  // No real waiting in retry tests.
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
// World setup, copied from payment-initialize.test.js so that suite stays
// untouched. These tests seed a payment directly in the state under test
// (typically 'pending' with a reference), rather than driving initialize.
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

/**
 * A world with a real milestone/contract and a payment record already in the
 * given state, carrying the deterministic reference (as initialize would have
 * written it). Returns the milestone id and a reader for the stored record.
 */
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

/** A well-formed verify data object for the given reference/milestone. */
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

/**
 * Queues a verify responder that stays available for every call in a retry
 * sequence. The fake consumes one queue entry per call, so a responder that
 * must run up to three times re-queues itself as it runs.
 */
function alwaysVerify(fn) {
  const wrapped = (reference) => {
    client.paystack.respondWithVerify(wrapped);
    return fn(reference);
  };
  client.paystack.respondWithVerify(wrapped);
}

// ---------------------------------------------------------------------------
// 1. Successful verification -> paid
// ---------------------------------------------------------------------------

test('a consistent success response transitions the record to paid and returns a safe whitelist', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Payment verification completed');
  assert.equal(res.body.verified, true);
  assert.deepEqual(Object.keys(res.body.payment).sort(), [
    'amountMinor',
    'chargeMinor',
    'currency',
    'feeMinor',
    'paymentId',
    'reference',
    'status',
  ]);
  assert.equal(res.body.payment.status, 'paid');
  assert.equal(res.body.payment.paymentId, ms1);
  assert.equal(res.body.payment.reference, `kp_${ms1}`);
  assert.equal(res.body.payment.amountMinor, 500000);

  // Exactly one verify call, with the deterministic reference; no initialize.
  assert.equal(client.paystack.calls.length, 1);
  assert.equal(client.paystack.calls[0].op, 'verifyTransaction');
  assert.equal(client.paystack.calls[0].reference, `kp_${ms1}`);

  const doc = stored();
  assert.equal(doc.status, 'paid');
  assert.equal(doc.providerFeeMinor, 1234, 'the provider-reported fee, kept separate from feeMinor');
  assert.equal(doc.feeMinor, EXPECTED_FEE, 'the modeled fee is unchanged');
  assert.notEqual(doc.providerFeeMinor, doc.feeMinor, 'provider fee and modeled fee are distinct');
  assert.ok(doc.paidAt, 'paidAt stamped');
  assert.ok(doc.verifiedAt, 'verifiedAt stamped');

  // No raw provider text or secret anywhere in the response.
  assert.equal(JSON.stringify(res.body).includes('Verification successful'), false);
  assert.equal(JSON.stringify(res.body).includes(FAKE_TEST_KEY), false);
});

// ---------------------------------------------------------------------------
// 2. Reference / amount / currency validation
// ---------------------------------------------------------------------------

test('a mismatched reference, amount or currency becomes needs_review, never paid', async () => {
  const cases = [
    ['wrong reference', { reference: 'kp_A_DIFFERENT_MILESTONE' }],
    ['wrong amount', { amount: EXPECTED_CHARGE + 1 }],
    ['missing currency', { currency: undefined }],
    ['wrong currency', { currency: 'USD' }],
  ];

  for (const [label, dataOverrides] of cases) {
    client.fake.resetAll();
    client.paystack.reset();
    employerApi = await client.authed('employer-1');
    employeeApi = await client.authed('employee-1');
    const { ms1, stored } = await seedInitializedPayment();
    client.paystack.respondWithVerify((reference) =>
      okVerifyResponder(reference, dataOverrides)
    );

    const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

    assert.equal(res.status, 200, label);
    assert.equal(res.body.verified, false, label);
    assert.equal(res.body.payment.status, 'needs_review', label);
    assert.notEqual(stored().status, 'paid', label);
    assert.equal(stored().status, 'needs_review', label);
  }
});

// ---------------------------------------------------------------------------
// 3. Malformed / absent envelopes
// ---------------------------------------------------------------------------

test('a malformed or absent provider data object becomes needs_review', async () => {
  const malformedCases = [
    ['no data', { status: true, message: 'ok' }],
    ['null data', { status: true, message: 'ok', data: null }],
    ['status not a string', { status: true, message: 'ok', data: { reference: 'x', currency: 'NGN', amount: 1, status: 42 } }],
    ['reference not a string', { status: true, message: 'ok', data: { reference: 1, currency: 'NGN', amount: 1, status: 'success' } }],
    ['amount not a number', { status: true, message: 'ok', data: { reference: 'x', currency: 'NGN', amount: 'lots', status: 'success' } }],
  ];

  for (const [label, envelope] of malformedCases) {
    client.fake.resetAll();
    client.paystack.reset();
    employerApi = await client.authed('employer-1');
    employeeApi = await client.authed('employee-1');
    const { ms1, stored } = await seedInitializedPayment();
    client.paystack.respondWithVerify(() => envelope);

    const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

    assert.equal(res.status, 200, label);
    assert.equal(res.body.verified, false, label);
    assert.equal(stored().status, 'needs_review', label);
  }
});

// ---------------------------------------------------------------------------
// 4. The full status vocabulary mapping
// ---------------------------------------------------------------------------

test('the provider status maps to the approved local status', async () => {
  const cases = [
    ['success', 'paid', true],
    ['failed', 'failed', true],
    ['pending', 'pending', true],
    ['ongoing', 'pending', true],
    ['processing', 'pending', true],
    ['queued', 'pending', true],
    ['reversed', 'needs_review', false],
    ['abandoned', 'needs_review', false],
    ['some-new-status', 'needs_review', false],
  ];

  for (const [providerStatus, expected, verified] of cases) {
    client.fake.resetAll();
    client.paystack.reset();
    employerApi = await client.authed('employer-1');
    employeeApi = await client.authed('employee-1');
    const { ms1, stored } = await seedInitializedPayment();
    client.paystack.respondWithVerify((reference) =>
      okVerifyResponder(reference, { status: providerStatus })
    );

    const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

    assert.equal(res.status, 200, providerStatus);
    assert.equal(res.body.payment.status, expected, providerStatus);
    assert.equal(res.body.verified, verified, providerStatus);
    assert.equal(stored().status, expected, providerStatus);
  }
});

// ---------------------------------------------------------------------------
// 5. Terminal-state safety
// ---------------------------------------------------------------------------

test('an already-paid payment is returned without a provider call', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.seed(
    'payments',
    ms1,
    payment({ milestoneId: ms1, status: 'paid', providerReference: `kp_${ms1}`, providerFeeMinor: 999 })
  );
  const before = client.readDoc('payments', ms1);
  // No verify responder queued: a provider call would throw and fail the test.

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.payment.status, 'paid');
  assert.equal(client.paystack.calls.length, 0, 'no provider call for an already-paid record');
  assert.deepEqual(client.readDoc('payments', ms1), before, 'the record is untouched');
});

test('a failed payment is not promoted to paid even when the provider now reports success', async () => {
  const { ms1, stored } = await seedInitializedPayment({ status: 'failed' });
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference, { status: 'success' }));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.payment.status, 'needs_review', 'failed -> paid is forbidden');
  assert.equal(stored().status, 'needs_review');
  assert.notEqual(stored().status, 'paid');
});

test('a failed payment reports failed again idempotently without a new transition write', async () => {
  const { ms1, stored } = await seedInitializedPayment({ status: 'failed' });
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference, { status: 'failed' }));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.payment.status, 'failed');
  assert.equal(stored().status, 'failed');
});

// ---------------------------------------------------------------------------
// 6. Missing / malformed / inconsistent records
// ---------------------------------------------------------------------------

test('a milestone with no payment record is a 404 -- verification creates nothing', async () => {
  seedHiredWorld();
  const { ms1 } = await createContractWithTwoMilestones();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 404);
  assert.equal(client.paystack.calls.length, 0);
  assert.equal(client.readDoc('payments', ms1), undefined);
});

test('a created (never-initialized) record cannot be verified', async () => {
  const { ms1, stored } = await seedInitializedPayment({
    status: 'created',
    providerReference: undefined,
    chargeMinor: undefined,
    feeMinor: undefined,
  });
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /has not been initialized/);
  assert.equal(client.paystack.calls.length, 0);
  assert.equal(stored().status, 'created');
});

test('a stored reference that does not match the milestone is refused', async () => {
  const { ms1 } = await seedInitializedPayment({ providerReference: 'kp_SOMETHING_ELSE' });
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /stored payment reference does not match/);
  assert.equal(client.paystack.calls.length, 0);
});

// ---------------------------------------------------------------------------
// 7. Authorization and forbidden fields
// ---------------------------------------------------------------------------

test('verify requires authentication and the employer role', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  const before = stored();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  const anonymous = await client.post('/payments/verify', { body: { milestoneId: ms1 } });
  assert.equal(anonymous.status, 401);

  const asEmployee = await employeeApi.post('/payments/verify', { body: { milestoneId: ms1 } });
  assert.equal(asEmployee.status, 403);

  const strangerApi = await client.authed('stranger-1');
  const asStranger = await strangerApi.post('/payments/verify', { body: { milestoneId: ms1 } });
  assert.equal(asStranger.status, 403);

  assert.equal(client.paystack.calls.length, 0);
  assert.deepEqual(stored(), before);
});

test('the verify endpoint refuses every client-supplied server-controlled field', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  const before = stored();

  const forbidden = [
    'id', 'contractId', 'employmentId', 'taskId', 'employerId', 'employeeId',
    'amountMinor', 'currency', 'commissionBps', 'commissionAmountMinor',
    'status', 'initiatedBy', 'createdAt', 'chargeMinor', 'feeMinor',
    'providerReference', 'providerEnvironment', 'providerFeeMinor',
    'statusReason', 'verifyAttempts', 'verifiedAt', 'paidAt',
  ];

  for (const field of forbidden) {
    const res = await employerApi.post('/payments/verify', {
      body: { milestoneId: ms1, [field]: 'nope' },
    });
    assert.equal(res.status, 400, `${field} must be refused`);
    assert.match(res.body.message, new RegExp(`${field} cannot be supplied`));
  }

  assert.equal(client.paystack.calls.length, 0);
  assert.deepEqual(stored(), before);
});

// ---------------------------------------------------------------------------
// 8. Configuration fails closed
// ---------------------------------------------------------------------------

test('missing Test Mode configuration makes no provider call and leaves the record untouched', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  const before = stored();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  delete process.env[SECRET_KEY_ENV];
  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 503);
  assert.equal(client.paystack.calls.length, 0);
  assert.deepEqual(stored(), before);
});

// ---------------------------------------------------------------------------
// 9. Transient retry behavior
// ---------------------------------------------------------------------------

test('a transient 5xx is retried and a later success is applied, within the attempt cap', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  let attempts = 0;
  alwaysVerify((reference) => {
    attempts += 1;
    if (attempts < 3) throw new PaystackHttpError('unavailable', { statusCode: 503 });
    return okVerifyResponder(reference);
  });

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(res.body.payment.status, 'paid');
  assert.equal(attempts, 3, 'the third attempt succeeded');
  assert.equal(client.paystack.calls.length, 3);
  assert.equal(stored().status, 'paid');
});

test('a persistent 5xx gives up at exactly three attempts and throws an ambiguous error, leaving the record unchanged', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  const before = stored();
  let attempts = 0;
  alwaysVerify(() => {
    attempts += 1;
    throw new PaystackHttpError('boom', { statusCode: 500 });
  });

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 500);
  assert.equal(res.body.message, 'Failed to verify payment');
  assert.equal(attempts, 3, 'at most three total attempts');
  assert.deepEqual(stored(), before, 'the record is untouched -- never marked failed');
  assert.equal(JSON.stringify(res.body).includes('boom'), false, 'no provider text leaked');
});

test('transport errors and timeouts are retried and then reported as ambiguous', async () => {
  for (const [label, makeError] of [
    ['transport', () => new PaystackTransportError('fetch failed')],
    ['timeout', () => new PaystackTimeoutError('timed out')],
  ]) {
    client.fake.resetAll();
    client.paystack.reset();
    employerApi = await client.authed('employer-1');
    employeeApi = await client.authed('employee-1');
    const { ms1, stored } = await seedInitializedPayment();
    const before = stored();
    let attempts = 0;
    alwaysVerify(() => {
      attempts += 1;
      throw makeError();
    });

    const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

    assert.equal(res.status, 500, label);
    assert.equal(attempts, 3, label);
    assert.deepEqual(stored(), before, `${label}: record untouched, not failed`);
  }
});

test('HTTP 429 is retried; a later success is applied', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  let attempts = 0;
  alwaysVerify((reference) => {
    attempts += 1;
    if (attempts === 1) throw new PaystackHttpError('slow down', { statusCode: 429 });
    return okVerifyResponder(reference);
  });

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 200);
  assert.equal(attempts, 2);
  assert.equal(stored().status, 'paid');
});

test('a non-transient 4xx is not retried', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  const before = stored();
  let attempts = 0;
  client.paystack.respondWithVerify(() => {
    attempts += 1;
    throw new PaystackHttpError('Reference not found', { statusCode: 404 });
  });

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 500);
  assert.equal(attempts, 1, 'a 4xx is definitive and not retried');
  assert.deepEqual(stored(), before);
});

test('a malformed 2xx body is not retried', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  const before = stored();
  let attempts = 0;
  client.paystack.respondWithVerify(() => {
    attempts += 1;
    throw new PaystackResponseError('not valid JSON');
  });

  const res = await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(res.status, 500);
  assert.equal(attempts, 1, 'an answered-but-unparseable response is not retried');
  assert.deepEqual(stored(), before);
});

// ---------------------------------------------------------------------------
// 10. No accidental re-initialization
// ---------------------------------------------------------------------------

test('verification never initializes a transaction, even across retries', async () => {
  const { ms1 } = await seedInitializedPayment();
  let attempts = 0;
  alwaysVerify(() => {
    attempts += 1;
    throw new PaystackHttpError('unavailable', { statusCode: 503 });
  });

  await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  assert.equal(attempts, 3);
  assert.equal(
    client.paystack.calls.filter((c) => c.op === 'initializeTransaction').length,
    0,
    'no initialize call was made'
  );
  assert.equal(client.paystack.calls.length, 3);
  assert.equal(client.paystack.calls.every((c) => c.op === 'verifyTransaction'), true);
});

// ---------------------------------------------------------------------------
// 11. Partial update preserves unrelated fields
// ---------------------------------------------------------------------------

test('verification updates only status/verified fields and preserves the rest', async () => {
  const { ms1, stored } = await seedInitializedPayment();
  const before = stored();
  client.paystack.respondWithVerify((reference) => okVerifyResponder(reference));

  await employerApi.post('/payments/verify', { body: { milestoneId: ms1 } });

  const after = stored();
  for (const key of Object.keys(before)) {
    if (['status', 'providerFeeMinor', 'paidAt', 'verifiedAt'].includes(key)) continue;
    assert.deepEqual(after[key], before[key], `field ${key} must be untouched`);
  }
  assert.equal(after.status, 'paid');
});

// ---------------------------------------------------------------------------
// 12. Endpoint boundary: verify now exists, nothing else was added
// ---------------------------------------------------------------------------

test('the verify route exists while PUT/PATCH/DELETE and other subpaths still do not', async () => {
  const { ms1 } = await seedInitializedPayment();

  const stillAbsent = [
    ['PUT', `/payments/${ms1}`],
    ['PATCH', `/payments/${ms1}`],
    ['DELETE', `/payments/${ms1}`],
    ['POST', `/payments/${ms1}/refund`],
    ['POST', `/payments/${ms1}/cancel`],
    ['GET', `/payments/${ms1}`],
  ];
  for (const [method, path] of stillAbsent) {
    const res = await employerApi.request(method, path, {
      body: method === 'GET' ? undefined : {},
    });
    assert.equal(res.status, 404, `${method} ${path} must not exist`);
  }
});
