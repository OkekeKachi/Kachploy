'use strict';

/**
 * STAGE 1C tests for services/paystackClient.js -- the Paystack provider client.
 *
 * Every test runs against an INJECTED fake fetch: no real request, no real
 * credential, no network. The environment carries an obviously fake Test Mode
 * key (set in beforeEach, restored in afterEach with a `delete` when the
 * variable was originally absent -- assigning `undefined` to process.env would
 * coerce it to the string "undefined").
 *
 * The properties this file exists to pin:
 *   1. the two operations hit exactly the right URL/method/header/body;
 *   2. every failure mode lands in its own error class, with the HTTP status
 *      retained where one exists and the original cause kept for transport
 *      failures;
 *   3. no failure surface -- message, enumerable property, JSON serialization
 *      or stack -- ever carries the secret, the Authorization header or a
 *      fragment of a provider body;
 *   4. a missing configuration is discovered BEFORE any request is made;
 *   5. nothing here retries, redirects, or touches global fetch when an
 *      implementation is injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PAYSTACK_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  PaystackClientError,
  PaystackTransportError,
  PaystackTimeoutError,
  PaystackHttpError,
  PaystackResponseError,
  createPaystackClient,
} = require('../services/paystackClient');
const { PaystackConfigurationError, SECRET_KEY_ENV_VAR } = require('../config/paystack');

// Obviously fake material. Never a real credential; leak checks look for it.
const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const SECRET_FRAGMENTS = [FAKE_TEST_KEY, 'FAKEKEYTAIL', 'Bearer'];

const savedEnv = { had: false, value: undefined };

test.beforeEach(() => {
  savedEnv.had = Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV_VAR);
  savedEnv.value = process.env[SECRET_KEY_ENV_VAR];
  process.env[SECRET_KEY_ENV_VAR] = FAKE_TEST_KEY;
});

test.afterEach(() => {
  if (savedEnv.had) {
    process.env[SECRET_KEY_ENV_VAR] = savedEnv.value;
  } else {
    delete process.env[SECRET_KEY_ENV_VAR];
  }
});

/** Runs `fn` with PAYSTACK_SECRET_KEY forced to `value`, restoring exactly. */
const withSecretKey = (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV_VAR);
  const saved = process.env[SECRET_KEY_ENV_VAR];
  try {
    if (value === undefined) {
      delete process.env[SECRET_KEY_ENV_VAR];
    } else {
      process.env[SECRET_KEY_ENV_VAR] = value;
    }
    return fn();
  } finally {
    if (had) {
      process.env[SECRET_KEY_ENV_VAR] = saved;
    } else {
      delete process.env[SECRET_KEY_ENV_VAR];
    }
  }
};

/** A fetch double that records every call and answers from a factory. */
const recordingFetch = (answer) => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(answer(url, init, calls.length));
  };
  return { calls, fetchImpl };
};

/** A Response-shaped double. `textCalls` proves whether a body was read. */
const fakeResponse = (body, { ok = true, status = 200, onText = null } = {}) => {
  const response = {
    ok,
    status,
    textCalls: 0,
    text() {
      response.textCalls += 1;
      if (onText) onText();
      return Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body));
    },
  };
  return response;
};

const okEnvelope = (data = { authorization_url: 'https://checkout.test/pay', access_code: 'code_1', reference: 'kp_1' }, extra = {}) =>
  fakeResponse({ status: true, message: 'Authorization URL created', data, ...extra });

/** Asserts nothing about secret material appears on any outward-facing surface. */
const assertNoSecretLeak = (error) => {
  const surfaces = [error.message, String(error), JSON.stringify(error), error.stack];
  for (const surface of surfaces) {
    for (const fragment of SECRET_FRAGMENTS) {
      assert.equal(surface.includes(fragment), false, `leaked ${fragment} via ${surface}`);
    }
  }
};

test('interface: the module exports the client factory, the taxonomy and pinned constants', () => {
  assert.deepEqual(Object.keys(require('../services/paystackClient')).sort(), [
    'DEFAULT_TIMEOUT_MS',
    'PAYSTACK_BASE_URL',
    'PaystackClientError',
    'PaystackHttpError',
    'PaystackResponseError',
    'PaystackTimeoutError',
    'PaystackTransportError',
    'createPaystackClient',
  ]);
  assert.equal(PAYSTACK_BASE_URL, 'https://api.paystack.co');
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);
});

test('construction: no I/O, and the options are validated consistently', () => {
  // Construction itself makes no request and reads no configuration: a client
  // built while the variable is missing still builds (the error is per-call).
  withSecretKey(undefined, () => {
    const client = createPaystackClient({ fetchImpl: () => {} });
    assert.equal(typeof client.initializeTransaction, 'function');
    assert.equal(typeof client.verifyTransaction, 'function');
  });

  for (const bad of ['nope', 42, {}, []]) {
    assert.throws(() => createPaystackClient({ fetchImpl: bad }), TypeError, `fetchImpl ${String(bad)}`);
  }
  // `undefined` means "use the lazy global fetch" and is not a type error.
  assert.doesNotThrow(() => createPaystackClient({ fetchImpl: undefined }));

  for (const bad of ['25', null, {}, true]) {
    assert.throws(() => createPaystackClient({ timeoutMs: bad }), TypeError, `timeoutMs ${String(bad)}`);
  }
  for (const bad of [0, -1, -25, NaN, Infinity, -Infinity]) {
    assert.throws(() => createPaystackClient({ timeoutMs: bad }), RangeError, `timeoutMs ${String(bad)}`);
  }
  // Valid variants are accepted.
  assert.doesNotThrow(() => createPaystackClient({ timeoutMs: 1 }));
  assert.doesNotThrow(() => createPaystackClient({ timeoutMs: 0.5 }));
});

test('initializeTransaction: exact URL, method, headers and serialized body', async () => {
  const { calls, fetchImpl } = recordingFetch(() => okEnvelope());
  const client = createPaystackClient({ fetchImpl });

  const payload = {
    email: 'employer@example.test',
    amount: 100000,
    reference: 'kp_milestone-1',
    metadata: { milestoneId: 'milestone-1' },
  };
  const result = await client.initializeTransaction(payload);

  assert.equal(calls.length, 1, 'exactly one request: no silent retry');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.paystack.co/transaction/initialize');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_TEST_KEY}`);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Accept, 'application/json');
  assert.deepEqual(JSON.parse(init.body), payload, 'the payload travels untouched');
  assert.equal(init.redirect, 'error', 'redirects are refused, not followed');
  assert.ok(init.signal instanceof AbortSignal, 'every request carries an abort signal');

  assert.deepEqual(result, {
    status: true,
    message: 'Authorization URL created',
    data: { authorization_url: 'https://checkout.test/pay', access_code: 'code_1', reference: 'kp_1' },
  });
});

test('initializeTransaction: a caller-supplied baseUrl is ignored -- the host is not an option', async () => {
  const { calls, fetchImpl } = recordingFetch(() => okEnvelope());
  const client = createPaystackClient({ fetchImpl, baseUrl: 'https://attacker.example.test' });

  await client.initializeTransaction({ email: 'e@example.test', amount: 100000 });

  assert.equal(calls[0].url.startsWith('https://api.paystack.co/'), true, 'the trusted base URL is used');
});

test('initializeTransaction: rejects a payload that is not an object, before any request', () => {
  const { calls, fetchImpl } = recordingFetch(() => okEnvelope());
  const client = createPaystackClient({ fetchImpl });

  // Synchronous throws, not rejections: validation runs before a promise or a
  // request exists, and assert.throws is what pins that ordering.
  for (const bad of [null, [], 'payload', 42, true, undefined]) {
    assert.throws(() => client.initializeTransaction(bad), TypeError);
  }
  assert.equal(calls.length, 0, 'validation happens before fetch');
});

test('verifyTransaction: exact URL, method, and no request body', async () => {
  const verifyData = { reference: 'kp_1', status: 'success', amount: 100000 };
  const { calls, fetchImpl } = recordingFetch(() => fakeResponse({ status: true, message: 'ok', data: verifyData }));
  const client = createPaystackClient({ fetchImpl });

  const result = await client.verifyTransaction('kp_1');

  assert.equal(calls.length, 1, 'exactly one request: no silent retry');
  const { url, init } = calls[0];
  assert.equal(url, 'https://api.paystack.co/transaction/verify/kp_1');
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined, 'a GET carries no body');
  assert.equal(init.headers.Authorization, `Bearer ${FAKE_TEST_KEY}`);
  assert.equal(init.headers['Content-Type'], undefined, 'no content type without a body');
  assert.equal(init.redirect, 'error');
  assert.deepEqual(result.data, verifyData);
});

test('verifyTransaction: the reference is encoded into exactly one path segment', async () => {
  const { calls, fetchImpl } = recordingFetch(() => fakeResponse({ status: true, message: 'ok', data: {} }));
  const client = createPaystackClient({ fetchImpl });

  const hostile = 'kp_1/2 3?x=1&y=2#frag%20+slash';
  await client.verifyTransaction(hostile);

  const expected = `https://api.paystack.co/transaction/verify/${encodeURIComponent(hostile)}`;
  assert.equal(calls[0].url, expected);
  assert.equal(calls[0].url.includes('/transaction/verify/'), true);
  // The raw separators never appear after the prefix.
  const segment = calls[0].url.slice(calls[0].url.indexOf('/transaction/verify/') + '/transaction/verify/'.length);
  assert.equal(/[/?# +]/.test(segment), false, `path segment must be fully encoded, got ${segment}`);
});

test('verifyTransaction: rejects a missing or non-string reference, before any request', () => {
  const { calls, fetchImpl } = recordingFetch(() => fakeResponse({ status: true, message: 'ok', data: {} }));
  const client = createPaystackClient({ fetchImpl });

  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    assert.throws(() => client.verifyTransaction(bad), TypeError);
  }
  assert.equal(calls.length, 0, 'validation happens before fetch');
});

test('responses: a valid envelope is returned normalized', async () => {
  // The first call carries a message; the second omits it entirely.
  const { fetchImpl } = recordingFetch((url, init, callIndex) =>
    okEnvelope({ reference: 'kp_1' }, callIndex === 1 ? {} : { message: undefined })
  );
  const client = createPaystackClient({ fetchImpl });

  const withMessage = await client.initializeTransaction({ email: 'e@example.test', amount: 1 });
  assert.deepEqual(withMessage, {
    status: true,
    message: 'Authorization URL created',
    data: { reference: 'kp_1' },
  });

  // A missing message becomes null rather than undefined, so downstream code
  // sees one shape.
  const noMessage = await client.initializeTransaction({ email: 'e@example.test', amount: 1 });
  assert.equal(noMessage.message, null);
  assert.deepEqual(noMessage.data, { reference: 'kp_1' });
});

test('http errors: the status is retained, the body is never read, nothing leaks', async () => {
  const bodyWithSecret = JSON.stringify({
    status: false,
    message: `Invalid key ${FAKE_TEST_KEY}`,
    secret: FAKE_TEST_KEY,
  });
  const { calls, fetchImpl } = recordingFetch(() => fakeResponse(bodyWithSecret, { ok: false, status: 401 }));
  const client = createPaystackClient({ fetchImpl });

  const error = await client
    .initializeTransaction({ email: 'e@example.test', amount: 100000 })
    .then(
      () => null,
      (caught) => caught
    );

  assert.ok(error instanceof PaystackHttpError);
  assert.equal(error.statusCode, 401);
  assert.equal(error.code, 'PAYSTACK_HTTP_ERROR');
  assert.equal(calls[0].url, 'https://api.paystack.co/transaction/initialize');
  assert.equal(calls.length, 1, 'an HTTP error is not retried');
  assertNoSecretLeak(error);
  assert.equal('body' in error, false, 'no raw body property exists');
  assert.equal(Object.keys(error).sort().join(','), 'code,name,statusCode', 'only safe enumerable fields');
});

test('http errors: non-2xx statuses of every kind classify the same way', async () => {
  for (const status of [400, 401, 404, 429, 500, 503]) {
    const { fetchImpl } = recordingFetch(() => fakeResponse('{"message":"nope"}', { ok: false, status }));
    const client = createPaystackClient({ fetchImpl });
    const error = await client
      .verifyTransaction('kp_1')
      .then(
        () => null,
        (caught) => caught
      );
    assert.ok(error instanceof PaystackHttpError, `HTTP ${status}`);
    assert.equal(error.statusCode, status);
    assertNoSecretLeak(error);
  }
});

test('transport errors: a fetch rejection keeps its cause and never claims a timeout', async () => {
  const boom = new TypeError('fetch failed');
  const { fetchImpl } = recordingFetch(() => Promise.reject(boom));
  const client = createPaystackClient({ fetchImpl });

  const error = await client
    .verifyTransaction('kp_1')
    .then(
      () => null,
      (caught) => caught
    );

  assert.ok(error instanceof PaystackTransportError);
  assert.equal(error instanceof PaystackTimeoutError, false, 'a plain failure is not a timeout');
  assert.equal(error.code, 'PAYSTACK_TRANSPORT_ERROR');
  assert.equal(error.cause, boom, 'the original error survives as the (non-enumerable) cause');
  assert.equal('cause' in Object.keys(error), false, 'cause must not be an enumerable own property');
  assert.equal(JSON.stringify(error).includes('fetch failed'), false, 'cause is not serialized');
  assertNoSecretLeak(error);
});

test('timeouts: a hung request aborts within the budget and classifies as a timeout', async () => {
  let sawAbort = false;
  let capturedInit;
  const hangingFetch = (url, init) => {
    capturedInit = init;
    return new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        sawAbort = true;
        const abortError = new Error('This operation was aborted');
        abortError.name = 'AbortError';
        reject(abortError);
      });
    });
  };
  const client = createPaystackClient({ fetchImpl: hangingFetch, timeoutMs: 25 });

  const startedAt = Date.now();
  const error = await client
    .verifyTransaction('kp_1')
    .then(
      () => null,
      (caught) => caught
    );
  const elapsed = Date.now() - startedAt;

  assert.ok(error instanceof PaystackTimeoutError, `expected a timeout, got ${error && error.name}`);
  assert.ok(error instanceof PaystackTransportError, 'a timeout IS a transport failure');
  assert.equal(error instanceof PaystackHttpError, false);
  assert.equal(error.code, 'PAYSTACK_TIMEOUT');
  assert.equal(sawAbort, true, 'the signal was actually aborted');
  assert.equal(capturedInit.signal.aborted, true);
  assert.ok(elapsed < 3000, `must return near the 25ms budget, took ${elapsed}ms`);
  assertNoSecretLeak(error);
});

test('timeouts: the timer is cleared after a successful exchange', async () => {
  let capturedInit;
  const { fetchImpl } = recordingFetch(() => {
    return okEnvelope();
  });
  const wrappedFetch = async (url, init) => {
    capturedInit = init;
    return fetchImpl(url, init);
  };
  const client = createPaystackClient({ fetchImpl: wrappedFetch, timeoutMs: 25 });

  const result = await client.initializeTransaction({ email: 'e@example.test', amount: 100000 });
  assert.equal(result.status, true);

  // If the timer were left armed it would fire ~25ms in; waiting past the
  // budget and finding the signal untouched proves clearTimeout ran.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(capturedInit.signal.aborted, false, 'no stray timer aborted a finished exchange');
});

test('malformed JSON: a 2xx body that will not parse is a response error, and never echoes the body', async () => {
  const junk = `<html>oops ${FAKE_TEST_KEY} not json at all</html>`;
  const { fetchImpl } = recordingFetch(() => fakeResponse(junk));
  const client = createPaystackClient({ fetchImpl });

  const error = await client
    .verifyTransaction('kp_1')
    .then(
      () => null,
      (caught) => caught
    );

  assert.ok(error instanceof PaystackResponseError);
  assert.equal(error.statusCode, 200, 'the status is retained for diagnosis');
  assert.equal(error.code, 'PAYSTACK_INVALID_RESPONSE');
  assert.equal(error.message.includes('oops'), false, "V8's parse-error snippet must not survive");
  assertNoSecretLeak(error);
});

test('invalid envelopes: anything that is not a plausible success envelope is a response error', async () => {
  const invalidBodies = [
    ['not an object', fakeResponse('"just a string"')],
    ['an array', fakeResponse([1, 2, 3])],
    ['null', fakeResponse('null')],
    ['no status field', fakeResponse({ message: 'ok', data: {} })],
    ['a non-boolean status', fakeResponse({ status: 'true', message: 'ok', data: {} })],
    ['a false status', fakeResponse({ status: false, message: 'Reference not found', data: {} })],
    ['missing data', fakeResponse({ status: true, message: 'ok' })],
    ['null data', fakeResponse({ status: true, message: 'ok', data: null })],
  ];
  for (const [label, response] of invalidBodies) {
    const { fetchImpl } = recordingFetch(() => response);
    const client = createPaystackClient({ fetchImpl });
    const error = await client
      .verifyTransaction('kp_1')
      .then(
        () => null,
        (caught) => caught
      );
    assert.ok(error instanceof PaystackResponseError, `must reject: ${label}`);
    assert.equal(error.statusCode, 200, label);
    assert.equal(error.message.includes('Reference not found'), false, 'provider text is never echoed');
    assertNoSecretLeak(error);
  }
});

test('configuration: a missing key throws the config error, and no request is made', async () => {
  const { calls, fetchImpl } = recordingFetch(() => okEnvelope());
  const client = createPaystackClient({ fetchImpl });

  const initializeRejection = withSecretKey(undefined, () =>
    client.initializeTransaction({ email: 'e@example.test', amount: 100000 })
  );
  const initError = await initializeRejection.then(
    () => null,
    (caught) => caught
  );
  assert.ok(initError instanceof PaystackConfigurationError, 'the 503 path survives, unwrapped');
  assert.equal(initError instanceof PaystackClientError, false, 'config errors are NOT client errors');
  assert.equal(initError.code, 'PAYSTACK_NOT_CONFIGURED');

  const verifyRejection = withSecretKey(undefined, () => client.verifyTransaction('kp_1'));
  const verifyError = await verifyRejection.then(
    () => null,
    (caught) => caught
  );
  assert.ok(verifyError instanceof PaystackConfigurationError);

  const invalidRejection = withSecretKey('sk_live_0000FAKELIVE', () =>
    client.initializeTransaction({ email: 'e@example.test', amount: 100000 })
  );
  const invalidError = await invalidRejection.then(
    () => null,
    (caught) => caught
  );
  assert.ok(invalidError instanceof PaystackConfigurationError, 'a Live key fails closed, before any request');

  assert.equal(calls.length, 0, 'configuration is settled before fetch is ever touched');
});

test('taxonomy: the error classes stay distinguishable and individually catchable', async () => {
  // Transport vs HTTP vs response vs configuration are four separate families.
  const { fetchImpl: transportFetch } = recordingFetch(() => Promise.reject(new TypeError('fetch failed')));
  const transport = await createPaystackClient({ fetchImpl: transportFetch })
    .verifyTransaction('kp_1')
    .then(
      () => null,
      (caught) => caught
    );

  const { fetchImpl: httpFetch } = recordingFetch(() => fakeResponse('{}', { ok: false, status: 500 }));
  const http = await createPaystackClient({ fetchImpl: httpFetch })
    .verifyTransaction('kp_1')
    .then(
      () => null,
      (caught) => caught
    );

  const { fetchImpl: responseFetch } = recordingFetch(() => fakeResponse('nope'));
  const protocol = await createPaystackClient({ fetchImpl: responseFetch })
    .verifyTransaction('kp_1')
    .then(
      () => null,
      (caught) => caught
    );

  for (const error of [transport, http, protocol]) {
    assert.ok(error instanceof PaystackClientError, `${error.name} shares the base class`);
    assert.ok(error instanceof Error);
    assert.notEqual(error.code, undefined);
  }
  assert.equal(transport instanceof PaystackHttpError, false);
  assert.equal(http instanceof PaystackTransportError, false);
  assert.equal(protocol instanceof PaystackTransportError, false, 'a bad body is not a network failure');
  assert.equal(transport.statusCode, undefined, 'transport failures carry no status');
  assert.equal(http.cause, undefined, 'HTTP failures have no cause: the response arrived');

  // One distinct code per family, matching what a controller/service matches on.
  assert.deepEqual(
    [transport.code, http.code, protocol.code].sort(),
    ['PAYSTACK_HTTP_ERROR', 'PAYSTACK_INVALID_RESPONSE', 'PAYSTACK_TRANSPORT_ERROR']
  );
});

test('global fetch: construction and import never use it, and injection spares it entirely', async () => {
  const original = globalThis.fetch;
  let globalCalls = 0;
  const sentinel = (...args) => {
    globalCalls += 1;
    throw new Error(`global fetch must never be used, got ${args[0]}`);
  };

  try {
    globalThis.fetch = sentinel;

    // A fresh import under the sentinel proves module load is I/O-free.
    delete require.cache[require.resolve('../services/paystackClient')];
    const fresh = require('../services/paystackClient');
    assert.equal(typeof fresh.createPaystackClient, 'function');
    const constructed = fresh.createPaystackClient();
    assert.equal(typeof constructed.verifyTransaction, 'function');
    assert.equal(globalCalls, 0, 'import and construction touch no network');

    // With an injected implementation, even real calls never reach the global.
    const { calls, fetchImpl } = recordingFetch(() => fakeResponse({ status: true, message: 'ok', data: {} }));
    const client = fresh.createPaystackClient({ fetchImpl });
    const result = await client.verifyTransaction('kp_1');
    assert.equal(result.status, true);
    assert.equal(calls.length, 1, 'the injected fetch served the request');
    assert.equal(globalCalls, 0, 'the global fetch was never consulted');
  } finally {
    globalThis.fetch = original;
    delete require.cache[require.resolve('../services/paystackClient')];
  }
});
