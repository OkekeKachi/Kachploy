'use strict';

const { rateLimit } = require('express-rate-limit');
const { getSecurityConfig } = require('../config/security');

const RATE_LIMIT_MESSAGE = 'Too many requests, please try again later.';

const createRateLimiter = ({ windowMs, limit, message = RATE_LIMIT_MESSAGE, skip } = {}) => {
    const config = getSecurityConfig();
    const resolvedLimit = limit === undefined ? config.generalRateLimitMax : limit;

    if (!Number.isSafeInteger(resolvedLimit) || resolvedLimit <= 0) {
        throw new Error('rate limit must be a positive integer');
    }

    const options = {
        windowMs: windowMs === undefined ? config.rateLimitWindowMs : windowMs,
        limit: resolvedLimit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        message: { message },
    };

    if (skip) {
        options.skip = skip;
    }

    return rateLimit(options);
};

const config = getSecurityConfig();

const skipGlobalPaths = (req) => {
    const path = req.path.replace(/\/+$/, '') || '/';

    return (
        path === '/health' ||
        path === '/ready' ||
        path === '/payments/webhook'
    );
};

const generalRateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    limit: config.generalRateLimitMax,
    skip: skipGlobalPaths,
});

const authRateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    limit: config.authRateLimitMax,
});

const paymentRateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    limit: config.paymentRateLimitMax,
});

const releaseRateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    limit: config.releaseRateLimitMax,
});

const uploadRateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    limit: config.uploadRateLimitMax,
});

const webhookRateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    limit: config.webhookRateLimitMax,
});

module.exports = {
    RATE_LIMIT_MESSAGE,
    createRateLimiter,
    generalRateLimiter,
    authRateLimiter,
    paymentRateLimiter,
    releaseRateLimiter,
    uploadRateLimiter,
    webhookRateLimiter,
};
