'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { startTestServer } = require('../testing/testApp');
const {
    DEFAULT_REQUEST_BODY_LIMIT,
    DEFAULT_URLENCODED_BODY_LIMIT,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_HEADERS_TIMEOUT_MS,
    DEFAULT_KEEP_ALIVE_TIMEOUT_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    DEFAULT_PRODUCTION_RATE_LIMIT_MAX,
    DEFAULT_NON_PRODUCTION_RATE_LIMIT_MAX,
    parseTrustProxy,
    buildSecurityConfig,
    applyHttpTimeouts,
} = require('../config/security');
const { createRateLimiter, RATE_LIMIT_MESSAGE } = require('../middleware/rateLimit');

let client;
let app;

test.before(async () => {
    client = await startTestServer();
    app = require('../app.js');
});

test.after(async () => {
    await client.close();
});

const startProbe = async (probeApp, run) => {
    const server = http.createServer(probeApp);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        return await run(`http://127.0.0.1:${port}`);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
};

test('security headers are present on API responses', async () => {
    const res = await client.get('/health');

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-powered-by'], undefined);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.match(res.headers['strict-transport-security'], /max-age=/);
});

test('health and readiness probes are not counted by the global limiter', async () => {
    const res = await client.get('/health');

    assert.equal(res.headers.ratelimit, undefined);
    assert.equal(res.headers['ratelimit-policy'], undefined);
});

test('API routes receive rate-limit headers', async () => {
    const res = await client.get('/jobs');

    assert.equal(res.status, 401);
    assert.match(res.headers.ratelimit, /limit=\d+/);
    assert.match(res.headers['ratelimit-policy'], /;w=\d+/);
});

test('oversized JSON bodies are refused before the route runs', async () => {
    const previousEnv = app.get('env');
    app.set('env', 'production');

    try {
        const res = await client.post('/users/register', {
            body: JSON.stringify({ value: 'x'.repeat(1024 * 1024 + 1024) }),
        });

        assert.equal(res.status, 413);
        assert.match(res.contentType, /application\/json/);
        assert.equal(typeof res.body.message, 'string');
    } finally {
        app.set('env', previousEnv);
    }
});

test('the app trust-proxy setting comes from the environment configuration', () => {
    assert.deepEqual(app.get('trust proxy'), parseTrustProxy(process.env.TRUST_PROXY));
});

test('parseTrustProxy accepts only false, zero, or a positive hop count', () => {
    assert.equal(parseTrustProxy(undefined), false);
    assert.equal(parseTrustProxy(null), false);
    assert.equal(parseTrustProxy(''), false);
    assert.equal(parseTrustProxy('false'), false);
    assert.equal(parseTrustProxy('0'), false);
    assert.equal(parseTrustProxy('1'), 1);
    assert.equal(parseTrustProxy(' 2 '), 2);

    for (const value of ['true', '-1', '1.5', 'loopback', 'abc', '1,2']) {
        assert.throws(() => parseTrustProxy(value), /TRUST_PROXY/);
    }
});

test('production security defaults are conservative and non-production defaults do not break tests', () => {
    const production = buildSecurityConfig({ NODE_ENV: 'production' });
    const development = buildSecurityConfig({ NODE_ENV: 'development' });

    assert.equal(production.trustProxy, false);
    assert.equal(production.requestBodyLimit, DEFAULT_REQUEST_BODY_LIMIT);
    assert.equal(production.urlencodedBodyLimit, DEFAULT_URLENCODED_BODY_LIMIT);
    assert.equal(production.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    assert.equal(production.headersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS);
    assert.equal(production.keepAliveTimeoutMs, DEFAULT_KEEP_ALIVE_TIMEOUT_MS);
    assert.equal(production.rateLimitWindowMs, DEFAULT_RATE_LIMIT_WINDOW_MS);
    assert.equal(production.generalRateLimitMax, DEFAULT_PRODUCTION_RATE_LIMIT_MAX);
    assert.equal(production.authRateLimitMax, 20);
    assert.equal(production.paymentRateLimitMax, 30);
    assert.equal(production.releaseRateLimitMax, 20);
    assert.equal(production.uploadRateLimitMax, 30);
    assert.equal(production.webhookRateLimitMax, 120);

    assert.equal(development.generalRateLimitMax, DEFAULT_NON_PRODUCTION_RATE_LIMIT_MAX);
    assert.equal(development.authRateLimitMax, DEFAULT_NON_PRODUCTION_RATE_LIMIT_MAX);
});

test('security configuration accepts explicit environment overrides', () => {
    const config = buildSecurityConfig({
        NODE_ENV: 'production',
        TRUST_PROXY: '2',
        REQUEST_BODY_LIMIT: '512kb',
        URLENCODED_BODY_LIMIT: '64kb',
        REQUEST_TIMEOUT_MS: '12000',
        HEADERS_TIMEOUT_MS: '9000',
        KEEP_ALIVE_TIMEOUT_MS: '4000',
        RATE_LIMIT_WINDOW_MS: '60000',
        RATE_LIMIT_MAX: '10',
        AUTH_RATE_LIMIT_MAX: '11',
        PAYMENT_RATE_LIMIT_MAX: '12',
        RELEASE_RATE_LIMIT_MAX: '13',
        UPLOAD_RATE_LIMIT_MAX: '14',
        WEBHOOK_RATE_LIMIT_MAX: '15',
    });

    assert.deepEqual(config, {
        trustProxy: 2,
        requestBodyLimit: '512kb',
        urlencodedBodyLimit: '64kb',
        requestTimeoutMs: 12000,
        headersTimeoutMs: 9000,
        keepAliveTimeoutMs: 4000,
        rateLimitWindowMs: 60000,
        generalRateLimitMax: 10,
        authRateLimitMax: 11,
        paymentRateLimitMax: 12,
        releaseRateLimitMax: 13,
        uploadRateLimitMax: 14,
        webhookRateLimitMax: 15,
    });
});

test('security configuration rejects invalid numeric values and unsafe timeout ordering', () => {
    for (const value of ['0', '-1', '1.5', 'abc']) {
        assert.throws(
            () => buildSecurityConfig({ REQUEST_TIMEOUT_MS: value }),
            /REQUEST_TIMEOUT_MS/
        );
    }

    assert.throws(
        () =>
            buildSecurityConfig({
                REQUEST_TIMEOUT_MS: '10000',
                HEADERS_TIMEOUT_MS: '10000',
            }),
        /HEADERS_TIMEOUT_MS/
    );

    assert.throws(
        () =>
            buildSecurityConfig({
                REQUEST_TIMEOUT_MS: '10000',
                HEADERS_TIMEOUT_MS: '5000',
                KEEP_ALIVE_TIMEOUT_MS: '5000',
            }),
        /KEEP_ALIVE_TIMEOUT_MS/
    );

    assert.throws(() => buildSecurityConfig({ TRUST_PROXY: 'true' }), /TRUST_PROXY/);
});

test('HTTP timeouts are applied to the server object', () => {
    const config = buildSecurityConfig({
        REQUEST_TIMEOUT_MS: '20000',
        HEADERS_TIMEOUT_MS: '10000',
        KEEP_ALIVE_TIMEOUT_MS: '3000',
    });
    const server = {};

    const returned = applyHttpTimeouts(server, config);

    assert.equal(returned, server);
    assert.equal(server.requestTimeout, 20000);
    assert.equal(server.headersTimeout, 10000);
    assert.equal(server.keepAliveTimeout, 3000);
});

test('the rate limiter returns a JSON 429 after the configured limit', async () => {
    const probe = express();
    probe.use(createRateLimiter({ windowMs: 60000, limit: 2 }));
    probe.get('/ping', (req, res) => res.json({ ok: true }));

    await startProbe(probe, async (baseUrl) => {
        assert.equal((await fetch(`${baseUrl}/ping`)).status, 200);
        assert.equal((await fetch(`${baseUrl}/ping`)).status, 200);

        const limited = await fetch(`${baseUrl}/ping`);

        assert.equal(limited.status, 429);
        assert.match(limited.headers.get('content-type'), /application\/json/);
        assert.match(limited.headers.get('ratelimit'), /limit=2/);
        assert.equal(limited.headers.get('retry-after'), '60');
        assert.deepEqual(await limited.json(), { message: RATE_LIMIT_MESSAGE });
    });
});

test('trusted proxy configuration keys rate limits by the forwarded client address', async () => {
    const probe = express();
    probe.set('trust proxy', 1);
    probe.use(createRateLimiter({ windowMs: 60000, limit: 1 }));
    probe.get('/ping', (req, res) => res.json({ ip: req.ip }));

    await startProbe(probe, async (baseUrl) => {
        const hit = (address) =>
            fetch(`${baseUrl}/ping`, { headers: { 'X-Forwarded-For': address } });

        const first = await hit('203.0.113.10');
        assert.equal(first.status, 200);
        assert.equal((await first.json()).ip, '203.0.113.10');

        const repeated = await hit('203.0.113.10');
        assert.equal(repeated.status, 429);

        const otherClient = await hit('203.0.113.11');
        assert.equal(otherClient.status, 200);
        assert.equal((await otherClient.json()).ip, '203.0.113.11');
    });
});

test('rate limiter construction rejects a non-positive limit', () => {
    assert.throws(() => createRateLimiter({ limit: 0 }), /positive integer/);
    assert.throws(() => createRateLimiter({ limit: -1 }), /positive integer/);
    assert.throws(() => createRateLimiter({ limit: 1.5 }), /positive integer/);
});
