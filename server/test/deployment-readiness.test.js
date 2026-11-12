'use strict';

/**
 * STAGE 1M. Deployment-readiness surfaces.
 *
 * Three things this file pins, all of which are deployment concerns rather than
 * feature behaviour:
 *
 *   1. GET /health and GET /ready exist, are reachable WITHOUT a token, and
 *      return only fixed status strings and booleans -- never a secret, never an
 *      operational detail.
 *   2. The CORS policy is configurable: unset CORS_ORIGINS preserves the old
 *      reflect-any-origin behaviour; a set CORS_ORIGINS narrows the browser
 *      origins that may read responses, while never blocking a request that
 *      carries no Origin header.
 *   3. In production the error handler returns JSON with no stack trace and no
 *      internal message; in development the original Jade error page is kept.
 *
 * The harness already loaded app.js with the Firebase double installed, so
 * `require('../app.js')` here returns that same instance rather than loading a
 * second copy or reaching real Firebase.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { startTestServer } = require('../testing/testApp');
const { parseCorsOrigins, buildCorsOptions, getCorsOptions, CORS_ORIGINS_ENV_VAR } = require('../config/cors');
const {
  getPaystackMode,
  isLiveMode,
  isLivePayoutsEnabled,
  isPaystackConfigured,
} = require('../config/paystack');

let client;
let app;

test.before(async () => {
  client = await startTestServer();
  app = require('../app.js');
});
test.after(async () => { await client.close(); });
test.beforeEach(() => { client.fake.resetAll(); });

const withEnv = async (name, value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
};

const evaluateOrigin = (options, origin) => {
  let result;
  options.origin(origin, (err, allowed) => {
    assert.ifError(err);
    result = allowed;
  });
  return result;
};

// ------------------------------------------------------------------ /health

test('GET /health is reachable without a token and reports ok', async () => {
  const res = await client.get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok' });
  assert.match(res.contentType, /application\/json/);
});

test('GET /health returns no operational detail', async () => {
  const res = await client.get('/health');
  const keys = Object.keys(res.body);
  assert.deepEqual(keys, ['status']);
});

// ------------------------------------------------------------------- /ready

test('GET /ready is reachable without a token and reports per-dependency booleans', async () => {
  const res = await client.get('/ready');
  assert.match(res.contentType, /application\/json/);
  assert.ok([200, 503].includes(res.status), `unexpected status ${res.status}`);
  assert.ok(['ready', 'not_ready'].includes(res.body.status));
  assert.deepEqual(Object.keys(res.body.checks).sort(), ['cloudinary', 'database', 'paystack']);
  for (const value of Object.values(res.body.checks)) {
    assert.equal(typeof value, 'boolean');
  }
});

test('GET /ready is 200 when every dependency is configured and 503 when one is not', async () => {
  // Fully configured: a Test Mode Paystack key plus the three Cloudinary vars.
  await withEnv('PAYSTACK_SECRET_KEY', 'sk_test_abc', async () => {
    await withEnv('CLOUDINARY_CLOUD_NAME', 'cloud', async () => {
      await withEnv('CLOUDINARY_API_KEY', 'key', async () => {
        await withEnv('CLOUDINARY_API_SECRET', 'secret', async () => {
          const ready = await client.get('/ready');
          assert.equal(ready.status, 200);
          assert.equal(ready.body.status, 'ready');
          assert.deepEqual(ready.body.checks, { database: true, cloudinary: true, paystack: true });
        });
      });
    });
  });

  // Paystack unconfigured: the whole readiness flips to 503.
  await withEnv('PAYSTACK_SECRET_KEY', undefined, async () => {
    const notReady = await client.get('/ready');
    assert.equal(notReady.status, 503);
    assert.equal(notReady.body.status, 'not_ready');
    assert.equal(notReady.body.checks.paystack, false);
  });
});

test('GET /ready never echoes the secret it checks for', async () => {
  await withEnv('PAYSTACK_SECRET_KEY', 'sk_test_supersecretvalue', async () => {
    const res = await client.get('/ready');
    assert.doesNotMatch(res.text, /supersecretvalue/);
  });
});

test('staging Paystack settings select Test Mode and keep live payouts disabled', async () => {
  await withEnv('PAYSTACK_MODE', 'test', async () => {
    await withEnv('PAYSTACK_SECRET_KEY', 'sk_test_staging_placeholder', async () => {
      await withEnv('PAYSTACK_LIVE_PAYOUTS_ENABLED', 'false', () => {
        assert.equal(getPaystackMode(), 'test');
        assert.equal(isLiveMode(), false);
        assert.equal(isPaystackConfigured(), true);
        assert.equal(isLivePayoutsEnabled(), false);
      });
    });
  });
});

// -------------------------------------------------------------- CORS parsing

test('parseCorsOrigins splits, trims, drops blanks and de-duplicates', () => {
  assert.deepEqual(parseCorsOrigins('https://a.test, https://b.test ,'), ['https://a.test', 'https://b.test']);
  assert.deepEqual(parseCorsOrigins(''), []);
  assert.deepEqual(parseCorsOrigins(undefined), []);
  assert.deepEqual(parseCorsOrigins(null), []);
  assert.deepEqual(parseCorsOrigins('https://a.test,https://a.test'), ['https://a.test']);
});

test('parseCorsOrigins strips one trailing slash so the two spellings match', () => {
  assert.deepEqual(parseCorsOrigins('https://a.test/'), ['https://a.test']);
});

test('buildCorsOptions reflects any origin when the allowlist is empty', () => {
  assert.deepEqual(buildCorsOptions([]), { origin: true });
  assert.deepEqual(buildCorsOptions(undefined), { origin: true });
});

test('buildCorsOptions allows an allowlisted origin and a request with no origin', () => {
  const options = buildCorsOptions(['https://a.test']);
  assert.equal(typeof options.origin, 'function');

  const calls = [];
  const cb = (err, allowed) => calls.push({ err, allowed });

  options.origin('https://a.test', cb);
  options.origin(undefined, cb);

  assert.deepEqual(calls, [
    { err: null, allowed: true },
    { err: null, allowed: true },
  ]);
});

test('buildCorsOptions refuses an origin that is not on the allowlist', () => {
  const options = buildCorsOptions(['https://a.test']);
  let result;
  options.origin('https://evil.test', (err, allowed) => { result = allowed; });
  assert.equal(result, false);
});

test('getCorsOptions reads CORS_ORIGINS lazily', async () => {
  await withEnv(CORS_ORIGINS_ENV_VAR, undefined, () => {
    assert.deepEqual(getCorsOptions(), { origin: true });
  });
  await withEnv(CORS_ORIGINS_ENV_VAR, 'https://a.test', () => {
    const options = getCorsOptions();
    assert.equal(typeof options.origin, 'function');
  });
});

test('in production CORS allows exactly the configured staging origin and refuses others', async () => {
  await withEnv('NODE_ENV', 'production', async () => {
    await withEnv(CORS_ORIGINS_ENV_VAR, 'https://staging-frontend.test', () => {
      const options = getCorsOptions();
      assert.equal(evaluateOrigin(options, 'https://staging-frontend.test'), true);
      assert.equal(evaluateOrigin(options, 'https://evil.test'), false);
      assert.equal(evaluateOrigin(options, 'https://staging-frontend.test.evil.test'), false);
      // No Origin header: non-browser traffic is never blocked by CORS.
      assert.equal(evaluateOrigin(options, undefined), true);
    });
  });
});

test('in production CORS fails safe when the allowlist is missing, blank or unusable', async () => {
  await withEnv('NODE_ENV', 'production', async () => {
    for (const value of [undefined, '', '   ', ',', 'not-a-valid-origin']) {
      await withEnv(CORS_ORIGINS_ENV_VAR, value, () => {
        const options = getCorsOptions();
        assert.equal(
          evaluateOrigin(options, 'https://staging-frontend.test'),
          false,
          `browser origin was allowed for CORS_ORIGINS=${JSON.stringify(value)}`
        );
        assert.equal(evaluateOrigin(options, undefined), true);
      });
    }
  });
});

test('in production a wildcard entry never reflects an arbitrary origin', async () => {
  await withEnv('NODE_ENV', 'production', async () => {
    await withEnv(CORS_ORIGINS_ENV_VAR, '*', () => {
      const options = getCorsOptions();
      assert.equal(evaluateOrigin(options, 'https://evil.test'), false);
    });
  });
});

// ---------------------------------------------------------- CORS integration

test('with no CORS_ORIGINS a browser origin is reflected (development is unchanged)', async () => {
  await withEnv(CORS_ORIGINS_ENV_VAR, undefined, async () => {
    // The middleware is built once at app load, so the live server reflects what
    // was configured when it started. Here that is the permissive default.
    const res = await client.get('/health', { headers: { Origin: 'https://anything.test' } });
    assert.equal(res.headers['access-control-allow-origin'], 'https://anything.test');
  });
});

test('an allowlist reflects a listed origin and omits the header for an unlisted one', async () => {
  const cors = require('cors');
  const express = require('express');
  const http = require('http');

  const probe = express();
  probe.use(cors(buildCorsOptions(['https://allowed.test'])));
  probe.get('/ping', (req, res) => res.json({ ok: true }));

  const server = http.createServer(probe);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const hit = async (origin) => {
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { headers: { Origin: origin } });
    return res.headers.get('access-control-allow-origin');
  };

  try {
    assert.equal(await hit('https://allowed.test'), 'https://allowed.test');
    assert.equal(await hit('https://evil.test'), null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ------------------------------------------------------- production errors

test('in production a 404 is JSON with no view and no stack', async () => {
  const previous = app.get('env');
  app.set('env', 'production');
  try {
    const res = await client.get('/this-route-does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.contentType, /application\/json/);
    assert.equal(res.body.message, 'Not Found');
    assert.doesNotMatch(res.text, /\n\s*at /); // no stack frames
  } finally {
    app.set('env', previous);
  }
});

test('in production an unexpected 500 is answered with a generic message, not the error text', async () => {
  const previous = app.get('env');
  app.set('env', 'production');

  // Drive the error handler directly with a synthetic internal error, so the
  // test does not depend on a feature route happening to throw.
  const fakeRes = createMockResponse();
  const error = new Error('secret internal detail: db host db-123.internal');
  error.status = 500;

  const { errorHandler } = getErrorHandler();
  const originalError = console.error;
  console.error = () => {};
  try {
    errorHandler(error, { app }, fakeRes, () => {});
  } finally {
    console.error = originalError;
    app.set('env', previous);
  }

  assert.equal(fakeRes.statusCode, 500);
  assert.deepEqual(fakeRes.jsonBody, { message: 'Internal Server Error' });
  assert.doesNotMatch(JSON.stringify(fakeRes.jsonBody), /db-123|secret internal/);
});

test('in development the original Jade error page is preserved', async () => {
  const previous = app.get('env');
  app.set('env', 'development');
  try {
    const res = await client.get('/this-route-does-not-exist');
    assert.equal(res.status, 404);
    assert.match(res.contentType, /text\/html/);
  } finally {
    app.set('env', previous);
  }
});

/**
 * Minimal Express response double for calling the error handler directly. Only
 * the members the handler touches are implemented: status(), json() and render().
 */
function createMockResponse() {
  return {
    statusCode: undefined,
    jsonBody: undefined,
    rendered: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.jsonBody = payload; return this; },
    render(view) { this.rendered = view; return this; },
  };
}

/**
 * The error handler is not exported by app.js, so it is recovered from the
 * Express stack. It is the last Layer whose handler has four parameters.
 */
function getErrorHandler() {
  const stack = app._router.stack;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const handle = stack[i].handle;
    if (typeof handle === 'function' && handle.length === 4) {
      return { errorHandler: handle };
    }
  }
  throw new Error('error handler not found in the app stack');
}
