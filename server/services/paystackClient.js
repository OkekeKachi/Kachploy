'use strict';

/**
 * STAGE 1C. The Paystack provider client: the ONLY place in this server that
 * speaks HTTP to api.paystack.co. Dependency-free -- Node 20's built-in fetch,
 * injectable for tests -- and deliberately small: two provider operations
 * (initialize a transaction, verify a transaction), one hard-coded Test Mode
 * base URL, a bounded timeout, and an error taxonomy precise enough for the
 * service layer that comes later. No endpoints, no business rules, no status
 * vocabulary, no retries, no webhooks.
 *
 * WHAT THIS MODULE MUST NEVER DO
 *   * contact the network at import time or client-construction time (the
 *     default fetch is resolved LAZILY, per request, so a test can replace
 *     globalThis.fetch and prove nothing ran);
 *   * read the secret at import time -- the key comes from config/paystack.js's
 *     getSecretKey() at the moment a request is made, so an unconfigured server
 *     fails with that module's PaystackConfigurationError BEFORE any request is
 *     built, and the configuration error propagates unwrapped so a controller
 *     can still match it with one `instanceof`;
 *   * put the secret, the Authorization header, a response body or provider
 *     error text into a thrown message or an enumerable property. Error
 *     messages are assembled from constants in this file plus the operation
 *     name and numeric values this module itself produced (timeout budget, HTTP
 *     status) -- never from caller strings, URLs, references or provider text.
 *
 * THE TWO OPERATIONS (paths are Paystack's documented transaction endpoints)
 *
 *   POST /transaction/initialize   initializeTransaction(payload)
 *   GET  /transaction/verify/:ref  verifyTransaction(reference)
 *
 * `payload` is passed through to Paystack as JSON essentially untouched (the
 * service layer decides email/amount/reference/metadata -- that is business
 * logic and lives there, not here). The reference is encoded with
 * encodeURIComponent so it is exactly one path segment and can never smuggle
 * `/`, `?` or `#` into the URL.
 *
 * THE RESPONSE CONTRACT. Both endpoints answer a 2xx with a JSON envelope
 * `{ status: boolean, message?: string, data?: ... }`. This client returns a
 * NORMALIZED `{ status, message, data }` (message coerced to null when absent)
 * and throws for everything it cannot trust:
 *
 *   PaystackConfigurationError  from config/paystack.js, unwrapped (503 path)
 *   PaystackTimeoutError        the bounded timeout fired (extends Transport)
 *   PaystackTransportError      fetch itself failed: DNS, refused, reset,
 *                               TLS, or a redirect (see below). `cause` holds
 *                               the original error (non-enumerable, per the
 *                               Error cause option).
 *   PaystackHttpError           a non-2xx response. `statusCode` retained;
 *                               the BODY IS NEVER READ, so it cannot leak.
 *   PaystackResponseError       a 2xx whose body was not parseable JSON, or
 *                               whose envelope was not a plausible success
 *                               envelope (not an object, no boolean `status`,
 *                               `status` not true, or no `data`). `statusCode`
 *                               retained; the offending text is NOT attached
 *                               and NOT echoed -- V8's JSON SyntaxError message
 *                               quotes a fragment of the input, so the
 *                               original parse error is deliberately discarded.
 *
 * A timeout or transport failure is NOT evidence that a transaction failed --
 * it is evidence that this server does not know the outcome. Nothing here maps
 * provider states to payment states; that is a later stage's decision table.
 * Nothing here retries: an ambiguous outcome retried blindly could double-charge.
 *
 * REDIRECTS. `redirect: 'error'` on every request: the only trusted host is
 * the base URL below, and silently following a redirect would both move the
 * Bearer credential toward whatever host answered and hide who actually served
 * the response. Paystack's transaction endpoints do not redirect; if one ever
 * did, the fetch rejection classifies as a transport error, which is the
 * honest answer.
 *
 * TIMEOUTS. An AbortController per request, aborted by a timer cleared in a
 * `finally` on every path (success, HTTP error, parse error, rejection), so a
 * slow response can never leak a pending timer. The timer covers the whole
 * exchange including body read: an abort mid-body surfaces as a timeout too.
 *
 * BASE URL. Hard-coded to https://api.paystack.co over HTTPS. There is no
 * option to change it -- a caller-supplied base URL is the classic way a
 * client starts sending secrets to an attacker, and this one is not extensible
 * for that reason. It is exported only so tests can pin it.
 */

const { getSecretKey } = require('../config/paystack');

/** The one trusted provider host. Not configurable, by design. */
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

/** Production timeout budget. Generous enough for a cold TLS handshake. */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * Base class for everything this client throws (except the configuration
 * error, which belongs to config/paystack.js and must stay catchable there).
 * Lets a caller ask "did the provider call fail at all?" without enumerating
 * the subclasses.
 */
class PaystackClientError extends Error {
    constructor(message, { code, cause } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'PaystackClientError';
        this.code = code;
    }
}

/** The request never produced an answer we can interpret. `cause` is original. */
class PaystackTransportError extends PaystackClientError {
    constructor(message, options = {}) {
        super(message, { ...options, code: 'PAYSTACK_TRANSPORT_ERROR' });
        this.name = 'PaystackTransportError';
    }
}

/** The bounded timeout fired. Still a transport failure: outcome unknown. */
class PaystackTimeoutError extends PaystackTransportError {
    constructor(message, options = {}) {
        super(message, options);
        this.name = 'PaystackTimeoutError';
        this.code = 'PAYSTACK_TIMEOUT';
    }
}

/** A non-2xx answer. `statusCode` only -- the body was never read. */
class PaystackHttpError extends PaystackClientError {
    constructor(message, { statusCode, cause } = {}) {
        super(message, { code: 'PAYSTACK_HTTP_ERROR', cause });
        this.name = 'PaystackHttpError';
        this.statusCode = statusCode;
    }
}

/** A 2xx answer we refuse to interpret. `statusCode` only; no body fragments. */
class PaystackResponseError extends PaystackClientError {
    constructor(message, { statusCode, cause } = {}) {
        super(message, { code: 'PAYSTACK_INVALID_RESPONSE', cause });
        this.name = 'PaystackResponseError';
        this.statusCode = statusCode;
    }
}

/** Operation labels for messages. Constants, so caller data never reaches them. */
const OPERATIONS = {
    initialize: 'transaction initialization',
    verify: 'transaction verification',
};

const assertPlainObjectPayload = (payload) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new TypeError(`payload must be an object, got type ${typeof payload}`);
    }
};

const assertReference = (reference) => {
    if (typeof reference !== 'string') {
        throw new TypeError(`reference must be a string, got type ${typeof reference}`);
    }
    if (reference.trim() === '') {
        throw new TypeError('reference must be a non-empty string');
    }
    return reference.trim();
};

/**
 * Builds a client. Construction performs NO I/O and NO configuration read:
 * `fetchImpl` (a function, or nothing for the lazy global fetch) and a
 * validated `timeoutMs` are all that is captured.
 */
const createPaystackClient = ({ fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
    if (fetchImpl !== undefined && typeof fetchImpl !== 'function') {
        throw new TypeError(`fetchImpl must be a function, got type ${typeof fetchImpl}`);
    }
    if (typeof timeoutMs !== 'number') {
        throw new TypeError(`timeoutMs must be a number, got type ${typeof timeoutMs}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new RangeError(`timeoutMs must be a positive finite number of milliseconds, got ${timeoutMs}`);
    }

    // Resolved per request, never captured: constructing a client with no
    // fetchImpl must not touch the network, and a test that swaps
    // globalThis.fetch around a single call sees the swap.
    const fetcher = typeof fetchImpl === 'function'
        ? fetchImpl
        : (...args) => globalThis.fetch(...args);

    /**
     * The one request path. Both public operations funnel through here so the
     * credential, timeout, redirect and classification rules exist exactly once.
     */
    const request = async ({ method, url, body, operation }) => {
        // Read the key LAST possible moment, before anything leaves this
        // process. Unconfigured servers throw here, with no request attempted.
        const secretKey = getSecretKey();

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const headers = {
            Authorization: `Bearer ${secretKey}`,
            Accept: 'application/json',
        };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
        }

        try {
            let response;
            try {
                response = await fetcher(url, {
                    method,
                    headers,
                    body,
                    redirect: 'error',
                    signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted) {
                    throw new PaystackTimeoutError(
                        `Paystack ${operation} timed out after ${timeoutMs} ms`
                    );
                }
                throw new PaystackTransportError(
                    `Paystack ${operation} request failed before a response was received`,
                    { cause: error }
                );
            }

            const statusCode = Number(response.status);

            // A non-2xx body is NEVER read: Paystack error payloads echo
            // request details, and reading it would put provider text (and
            // possibly credential fragments) where it could leak into a log.
            if (!response.ok) {
                throw new PaystackHttpError(
                    `Paystack ${operation} was rejected with HTTP ${statusCode}`,
                    { statusCode }
                );
            }

            let raw;
            try {
                raw = await response.text();
            } catch (error) {
                if (controller.signal.aborted) {
                    throw new PaystackTimeoutError(
                        `Paystack ${operation} timed out after ${timeoutMs} ms`
                    );
                }
                throw new PaystackTransportError(
                    `Paystack ${operation} response could not be read`,
                    { cause: error }
                );
            }

            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch (error) {
                // The SyntaxError message quotes the input, so it is dropped
                // rather than attached: a provider body must never travel
                // outward inside an error, not even as a cause.
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response that was not valid JSON`,
                    { statusCode }
                );
            }

            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose JSON was not an object envelope`,
                    { statusCode }
                );
            }
            if (typeof parsed.status !== 'boolean') {
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose envelope had no boolean status field`,
                    { statusCode }
                );
            }
            if (parsed.status !== true) {
                // Documented Paystack failures arrive as 4xx, so a 2xx that
                // reports failure is an envelope this client refuses to
                // interpret. The provider's own `message` is discarded rather
                // than surfaced: it is arbitrary provider text.
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose envelope did not report success`,
                    { statusCode }
                );
            }
            if (parsed.data === undefined || parsed.data === null) {
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose envelope was missing data`,
                    { statusCode }
                );
            }

            return {
                status: parsed.status,
                message: typeof parsed.message === 'string' ? parsed.message : null,
                data: parsed.data,
            };
        } finally {
            // Cleared on every path, including the throw paths above: a
            // completed request must not leave a timer that fires into a
            // finished exchange.
            clearTimeout(timer);
        }
    };

    return {
        /**
         * POST /transaction/initialize. `payload` (email, amount in kobo,
         * reference, callback_url, metadata, ...) is serialized as JSON with no
         * field-level inspection here -- which fields are required is the
         * service layer's rule, not the transport's.
         */
        initializeTransaction: (payload) => {
            assertPlainObjectPayload(payload);
            return request({
                method: 'POST',
                url: `${PAYSTACK_BASE_URL}/transaction/initialize`,
                body: JSON.stringify(payload),
                operation: OPERATIONS.initialize,
            });
        },

        /**
         * GET /transaction/verify/:reference. The reference is trimmed and
         * percent-encoded into exactly one path segment.
         */
        verifyTransaction: (reference) => {
            const encoded = encodeURIComponent(assertReference(reference));
            return request({
                method: 'GET',
                url: `${PAYSTACK_BASE_URL}/transaction/verify/${encoded}`,
                operation: OPERATIONS.verify,
            });
        },
    };
};

module.exports = {
    PAYSTACK_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    PaystackClientError,
    PaystackTransportError,
    PaystackTimeoutError,
    PaystackHttpError,
    PaystackResponseError,
    createPaystackClient,
};
