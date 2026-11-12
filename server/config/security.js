'use strict';

const DEFAULT_REQUEST_BODY_LIMIT = '1mb';
const DEFAULT_URLENCODED_BODY_LIMIT = '100kb';
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_HEADERS_TIMEOUT_MS = 15000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_PRODUCTION_RATE_LIMIT_MAX = 300;
const DEFAULT_NON_PRODUCTION_RATE_LIMIT_MAX = 100000;
const DEFAULT_PRODUCTION_AUTH_RATE_LIMIT_MAX = 20;
const DEFAULT_PRODUCTION_PAYMENT_RATE_LIMIT_MAX = 30;
const DEFAULT_PRODUCTION_RELEASE_RATE_LIMIT_MAX = 20;
const DEFAULT_PRODUCTION_UPLOAD_RATE_LIMIT_MAX = 30;
const DEFAULT_PRODUCTION_WEBHOOK_RATE_LIMIT_MAX = 120;

const readString = (env, name, fallback) => {
    const value = env[name];

    if (typeof value !== 'string' || value.trim() === '') {
        return fallback;
    }

    return value.trim();
};

const readPositiveInteger = (env, name, fallback) => {
    const value = env[name];

    if (value === undefined || value === null || String(value).trim() === '') {
        return fallback;
    }

    const text = String(value).trim();

    if (!/^\d+$/.test(text)) {
        throw new Error(`${name} must be a positive integer`);
    }

    const parsed = Number(text);

    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
};

const parseTrustProxy = (value) => {
    if (value === undefined || value === null) {
        return false;
    }

    if (typeof value !== 'string') {
        throw new TypeError('TRUST_PROXY must be false, 0, or a positive integer hop count');
    }

    const text = value.trim().toLowerCase();

    if (text === '' || text === 'false' || text === '0') {
        return false;
    }

    if (!/^[1-9]\d*$/.test(text)) {
        throw new Error('TRUST_PROXY must be false, 0, or a positive integer hop count');
    }

    const hops = Number(text);

    if (!Number.isSafeInteger(hops)) {
        throw new Error('TRUST_PROXY must be false, 0, or a positive integer hop count');
    }

    return hops;
};

const buildSecurityConfig = (env = process.env) => {
    const isProduction = env.NODE_ENV === 'production';
    const nonProductionRateLimitMax = DEFAULT_NON_PRODUCTION_RATE_LIMIT_MAX;
    const requestTimeoutMs = readPositiveInteger(
        env,
        'REQUEST_TIMEOUT_MS',
        DEFAULT_REQUEST_TIMEOUT_MS
    );
    const defaultHeadersTimeoutMs = Math.max(
        1,
        Math.min(DEFAULT_HEADERS_TIMEOUT_MS, requestTimeoutMs - 1)
    );
    const headersTimeoutMs = readPositiveInteger(
        env,
        'HEADERS_TIMEOUT_MS',
        defaultHeadersTimeoutMs
    );
    const defaultKeepAliveTimeoutMs = Math.max(
        1,
        Math.min(DEFAULT_KEEP_ALIVE_TIMEOUT_MS, headersTimeoutMs - 1)
    );
    const keepAliveTimeoutMs = readPositiveInteger(
        env,
        'KEEP_ALIVE_TIMEOUT_MS',
        defaultKeepAliveTimeoutMs
    );

    if (headersTimeoutMs >= requestTimeoutMs) {
        throw new Error('HEADERS_TIMEOUT_MS must be less than REQUEST_TIMEOUT_MS');
    }

    if (keepAliveTimeoutMs >= headersTimeoutMs) {
        throw new Error('KEEP_ALIVE_TIMEOUT_MS must be less than HEADERS_TIMEOUT_MS');
    }

    return Object.freeze({
        trustProxy: parseTrustProxy(env.TRUST_PROXY),
        requestBodyLimit: readString(env, 'REQUEST_BODY_LIMIT', DEFAULT_REQUEST_BODY_LIMIT),
        urlencodedBodyLimit: readString(
            env,
            'URLENCODED_BODY_LIMIT',
            DEFAULT_URLENCODED_BODY_LIMIT
        ),
        requestTimeoutMs,
        headersTimeoutMs,
        keepAliveTimeoutMs,
        rateLimitWindowMs: readPositiveInteger(
            env,
            'RATE_LIMIT_WINDOW_MS',
            DEFAULT_RATE_LIMIT_WINDOW_MS
        ),
        generalRateLimitMax: readPositiveInteger(
            env,
            'RATE_LIMIT_MAX',
            isProduction ? DEFAULT_PRODUCTION_RATE_LIMIT_MAX : nonProductionRateLimitMax
        ),
        authRateLimitMax: readPositiveInteger(
            env,
            'AUTH_RATE_LIMIT_MAX',
            isProduction ? DEFAULT_PRODUCTION_AUTH_RATE_LIMIT_MAX : nonProductionRateLimitMax
        ),
        paymentRateLimitMax: readPositiveInteger(
            env,
            'PAYMENT_RATE_LIMIT_MAX',
            isProduction ? DEFAULT_PRODUCTION_PAYMENT_RATE_LIMIT_MAX : nonProductionRateLimitMax
        ),
        releaseRateLimitMax: readPositiveInteger(
            env,
            'RELEASE_RATE_LIMIT_MAX',
            isProduction ? DEFAULT_PRODUCTION_RELEASE_RATE_LIMIT_MAX : nonProductionRateLimitMax
        ),
        uploadRateLimitMax: readPositiveInteger(
            env,
            'UPLOAD_RATE_LIMIT_MAX',
            isProduction ? DEFAULT_PRODUCTION_UPLOAD_RATE_LIMIT_MAX : nonProductionRateLimitMax
        ),
        webhookRateLimitMax: readPositiveInteger(
            env,
            'WEBHOOK_RATE_LIMIT_MAX',
            isProduction ? DEFAULT_PRODUCTION_WEBHOOK_RATE_LIMIT_MAX : nonProductionRateLimitMax
        ),
    });
};

const getSecurityConfig = () => buildSecurityConfig(process.env);

const applyHttpTimeouts = (server, config = getSecurityConfig()) => {
    server.requestTimeout = config.requestTimeoutMs;
    server.headersTimeout = config.headersTimeoutMs;
    server.keepAliveTimeout = config.keepAliveTimeoutMs;
    return server;
};

module.exports = {
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
    getSecurityConfig,
    applyHttpTimeouts,
};
