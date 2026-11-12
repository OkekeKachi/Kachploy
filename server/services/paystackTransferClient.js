'use strict';

/**
 * STAGE 2I. Paystack transfer client – the ONLY place in this server that
 * speaks HTTP to api.paystack.co for transfer operations (recipient creation,
 * transfer initiation, transfer retrieval).  Dependency‑free – Node 20's built‑in
 * fetch, injectable for tests – and deliberately small: three provider operations
 * and a tight error taxonomy for the service layer that follows.  No business
 * rules, no status vocabulary, no retries, no webhooks.
 *
 * WHAT THIS MODULE MUST NEVER DO
 *   * contact the network at import time or client‑construction time (the
 *     default fetch is resolved LAZILY, per request, so a test can replace
 *     globalThis.fetch and prove nothing ran);
 *   * read the secret at import time – the key comes from config/paystack.js's
 *     getSecretKey() at the moment a request is made, so an unconfigured server
 *     fails with that module's PaystackConfigurationError BEFORE any request is
 *     built, and the configuration error propagates unwrapped so a controller
 *     can still match it with one instanceof;
 *   * put the secret, the Authorization header, a response body or provider
 *     error text into a thrown message or an enumerable property.  Error messages
 *     are assembled from constants in this file plus the operation name and
 *     numeric values this module itself produced (timeout budget, HTTP status)
 *     – never from caller strings, URLs, references or provider text.
 *
 * THE OPERATIONS (paths are Paystack's documented transfer endpoints)
 *
 *   POST /transferrecipient           createRecipient(payload)
 *   POST /transfer                    initiateTransfer(payload)
 *   GET  /transfer/verify/:reference  getTransfer(reference)
 *   GET  /bank?currency=NGN           listBanks({ currency })
 *   GET  /bank/resolve?...            resolveAccount(accountNumber, bankCode)
 *
 * `payload` is passed through to Paystack as JSON essentially untouched (the
 * service layer decides bank account details, amount, currency, reference, etc.).
 * The reference is encoded with encodeURIComponent so it is exactly one path
 * segment and can never smuggle /, ? or # into the URL.
 *
 * THE RESPONSE CONTRACT. Both endpoints answer a 2xx with a JSON envelope
 * { status: boolean, message?: string, data?: ... }.  This client returns a
 * NORMALIZED { status, message, data } (message coerced to null when absent)
 * and throws for everything it cannot trust:
 *
 *   PaystackConfigurationError  from config/paystack.js, unwrapped (503 path)
 *   PaystackTimeoutError        the bounded timeout fired (extends Transport)
 *   PaystackTransportError      fetch itself failed: DNS, refused, reset,
 *                               TLS, or a redirect (see below).  `cause` holds
 *                               the original error (non‑enumerable, per the
 *                               Error cause option).
 *   PaystackHttpError           a non‑2xx response.  `statusCode` is retained,
 *                               along with the operation and a SANITIZED
 *                               provider message/type.  The raw body is never
 *                               attached, so credentials and account numbers
 *                               cannot travel outward.
 *   PaystackResponseError       a 2xx whose body was not parseable JSON, or
 *                               whose envelope was not a plausible success
 *                               envelope (not an object, no boolean `status`,
 *                               `status` not true, or no `data`).  `statusCode`
 *                               retained; the offending text is NOT attached
 *                               and NOT echoed – V8's JSON SyntaxError message
 *                               quotes a fragment of the input, so the
 *                               original parse error is deliberately discarded.
 *
 * A timeout or transport failure is NOT evidence that a transfer failed – it is
 * evidence that this server does not know the outcome.  Nothing here maps
 * provider states to payment/release states; that is a later stage's decision
 * table.  Nothing here retries: an ambiguous outcome retried blindly could
 * double‑charge.
 *
 * BASE URL. Hard‑coded to https://api.paystack.co over HTTPS.  There is no
 * option to change it – a caller‑supplied base URL is the classic way a
 * client starts sending secrets to an attacker, and this one is not extensible
 * for that reason.  It is exported only so tests can pin it.
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
    constructor(message, { code, cause, operation } = {}) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'PaystackClientError';
        this.code = code;
        if (operation) this.operation = operation;
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

/**
 * A non‑2xx answer. The status and operation are safe structured fields. The
 * provider message/type are optional, sanitized strings; the raw body is never
 * retained.
 */
class PaystackHttpError extends PaystackClientError {
    constructor(message, { statusCode, cause, operation, providerMessage, providerErrorType } = {}) {
        super(message, { code: 'PAYSTACK_HTTP_ERROR', cause, operation });
        this.name = 'PaystackHttpError';
        this.statusCode = statusCode;
        if (providerMessage) this.providerMessage = providerMessage;
        if (providerErrorType) this.providerErrorType = providerErrorType;
    }
}

/** A 2xx answer we refuse to interpret. `statusCode` only; no body fragments. */
class PaystackResponseError extends PaystackClientError {
    constructor(message, { statusCode, cause, operation } = {}) {
        super(message, { code: 'PAYSTACK_INVALID_RESPONSE', cause, operation });
        this.name = 'PaystackResponseError';
        this.statusCode = statusCode;
    }
}

/** Operation labels for messages. Constants, so caller data never reaches them. */
const OPERATIONS = {
    createRecipient: 'recipient creation',
    initiateTransfer: 'transfer initiation',
    getTransfer: 'transfer retrieval',
    listBanks: 'bank list retrieval',
    resolveAccount: 'account resolution',
};

const PROVIDER_MESSAGE_MAX_LENGTH = 300;
const PROVIDER_ERROR_TYPE_MAX_LENGTH = 64;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_TOKEN = /\b(?:Bearer\s+[A-Z0-9._~+/=-]+|sk_(?:test|live)_[A-Z0-9]+)\b/gi;
const LONG_DIGIT_SEQUENCE = /\b\d{6,}\b/g;

/**
 * Provider error text is useful diagnostically but is untrusted. Keep it short,
 * strip control characters, and redact tokens, email addresses and long digit
 * sequences (account numbers and bank codes) before it can reach a log or API.
 */
const sanitizeProviderMessage = (value) => {
    if (typeof value !== 'string') return undefined;
    let text = value
        .replace(CONTROL_CHARACTERS, ' ')
        .replace(SECRET_TOKEN, '[redacted]')
        .replace(EMAIL_ADDRESS, '[redacted]')
        .replace(LONG_DIGIT_SEQUENCE, '[redacted]')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) return undefined;
    if (text.length > PROVIDER_MESSAGE_MAX_LENGTH) {
        text = `${text.slice(0, PROVIDER_MESSAGE_MAX_LENGTH - 3)}...`;
    }
    return text;
};

const sanitizeProviderErrorType = (value) => {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (!text || text.length > PROVIDER_ERROR_TYPE_MAX_LENGTH) return undefined;
    return /^[A-Z0-9_.-]+$/i.test(text) ? text : undefined;
};

/**
 * Reads a non-2xx body only to extract safe, normalized error details. Any
 * malformed, non-JSON or unreadable body contributes nothing.
 */
const readProviderErrorDetails = async (response) => {
    if (typeof response.text !== 'function') return {};
    let raw;
    try {
        raw = await response.text();
    } catch (error) {
        return {};
    }
    if (typeof raw !== 'string' || !raw.trim()) return {};

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    return {
        providerMessage: sanitizeProviderMessage(parsed.message),
        providerErrorType:
            sanitizeProviderErrorType(parsed.type)
            || sanitizeProviderErrorType(parsed.code),
    };
};

/**
 * Assert that `payload` is a plain object (not null, not array).
 */
const assertPlainObjectPayload = (payload) => {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        throw new TypeError(`payload must be an object, got type ${typeof payload}`);
    }
};

/**
 * Assert that `reference` is a non‑empty trimmed string.
 */
const assertReference = (reference) => {
    if (typeof reference !== 'string') {
        throw new TypeError(`reference must be a string, got type ${typeof reference}`);
    }
    if (reference.trim() === '') {
        throw new TypeError('reference must be a non-empty string');
    }
    return reference.trim();
};

const assertIdentifier = (value, field) => {
    if (typeof value !== 'string') {
        throw new TypeError(`${field} must be a string, got type ${typeof value}`);
    }
    if (value.trim() === '') {
        throw new TypeError(`${field} must be a non-empty string`);
    }
    return value.trim();
};

/**
 * Builds a client.  Construction performs NO I/O and NO configuration read:
 * `fetchImpl` (a function, or nothing for the lazy global fetch) and a
 * validated `timeoutMs` are all that is captured.
 */
const createPaystackTransferClient = function(fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
     * The one request path. All three public operations funnel through here so
     * the credential, timeout, redirect and classification rules exist exactly once.
     */
    const request = async function({ method, url, body, operation, operationKey }) {
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
                    body: body !== undefined ? JSON.stringify(body) : undefined,
                    redirect: 'error',
                    signal: controller.signal,
                });
            } catch (error) {
                if (controller.signal.aborted) {
                    throw new PaystackTimeoutError(
                        `Paystack ${operation} timed out after ${timeoutMs} ms`,
                        { operation: operationKey }
                    );
                }
                throw new PaystackTransportError(
                    `Paystack ${operation} request failed before a response was received`,
                    { cause: error, operation: operationKey }
                );
            }

            const statusCode = Number(response.status);

            // Read only enough of a non-2xx body to extract sanitized error
            // details. The raw body is discarded immediately.
            if (!response.ok) {
                const details = await readProviderErrorDetails(response);
                throw new PaystackHttpError(
                    `Paystack ${operation} was rejected with HTTP ${statusCode}`,
                    { statusCode, operation: operationKey, ...details }
                );
            }

            let raw;
            try {
                raw = await response.text();
            } catch (error) {
                if (controller.signal.aborted) {
                    throw new PaystackTimeoutError(
                        `Paystack ${operation} timed out after ${timeoutMs} ms`,
                        { operation: operationKey }
                    );
                }
                throw new PaystackTransportError(
                    `Paystack ${operation} response could not be read`,
                    { cause: error, operation: operationKey }
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
                    { statusCode, operation: operationKey }
                );
            }

            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose JSON was not an object envelope`,
                    { statusCode, operation: operationKey }
                );
            }
            if (typeof parsed.status !== 'boolean') {
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose envelope had no boolean status field`,
                    { statusCode, operation: operationKey }
                );
            }
            if (parsed.status !== true) {
                // Documented Paystack failures arrive as 4xx, so a 2xx that
                // reports failure is an envelope this client refuses to
                // interpret. The provider's own `message` is discarded rather
                // than surfaced: it is arbitrary provider text.
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose envelope did not report success`,
                    { statusCode, operation: operationKey }
                );
            }
            if (parsed.data === undefined || parsed.data === null) {
                throw new PaystackResponseError(
                    `Paystack ${operation} returned a 2xx response whose envelope was missing data`,
                    { statusCode, operation: operationKey }
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

    /**
     * POST /transfer/recipient/create.  `payload` carries bank‑account details
     * (account number, bank code, etc.) and any optional metadata.  The returned
     * recipient code is used in subsequent transfer initiation.
     */
    this.createRecipient = function(payload) {
        assertPlainObjectPayload(payload);
        return request({
            method: 'POST',
            url: `${PAYSTACK_BASE_URL}/transferrecipient`,
            body: payload,
            operation: OPERATIONS.createRecipient,
            operationKey: 'createRecipient',
        });
    };

    /**
     * POST /transfer.  `payload` carries at minimum: amount (in kobo), currency,
     * recipient (the recipient code from createRecipient), and a reference that
     * ties the transfer to the internal attempt/release identity.  The service
     * layer may add metadata, callback_url, etc.
     */
    this.initiateTransfer = function(payload) {
        assertPlainObjectPayload(payload);
        return request({
            method: 'POST',
            url: `${PAYSTACK_BASE_URL}/transfer`,
            body: payload,
            operation: OPERATIONS.initiateTransfer,
            operationKey: 'initiateTransfer',
        });
    };

    /**
     * GET /transfer/verify/:reference.  The reference is trimmed and
     * percent-encoded into exactly one path segment. Paystack's `reference` is
     * the transfer reference, NOT the provider's `transfer_code`.
     */
    this.getTransfer = function(reference) {
        const encoded = encodeURIComponent(assertReference(reference));
        return request({
            method: 'GET',
            url: `${PAYSTACK_BASE_URL}/transfer/verify/${encoded}`,
            operation: OPERATIONS.getTransfer,
            operationKey: 'getTransfer',
        });
    };

    /**
     * GET /bank?currency=NGN. Returns Paystack's supported bank list for the
     * currency. The service layer decides how to narrow it.
     */
    this.listBanks = function(options = {}) {
        assertPlainObjectPayload(options);
        const currency =
            typeof options.currency === 'string' && options.currency.trim()
                ? options.currency.trim().toUpperCase()
                : 'NGN';
        const query = new URLSearchParams({ currency }).toString();
        return request({
            method: 'GET',
            url: `${PAYSTACK_BASE_URL}/bank?${query}`,
            operation: OPERATIONS.listBanks,
            operationKey: 'listBanks',
        });
    };

    /**
     * GET /bank/resolve?account_number=...&bank_code=...
     * Both values are query-encoded, so neither can alter the URL structure.
     */
    this.resolveAccount = function(accountNumber, bankCode) {
        const account = assertIdentifier(accountNumber, 'accountNumber');
        const bank = assertIdentifier(bankCode, 'bankCode');
        const query = new URLSearchParams({
            account_number: account,
            bank_code: bank,
        }).toString();
        return request({
            method: 'GET',
            url: `${PAYSTACK_BASE_URL}/bank/resolve?${query}`,
            operation: OPERATIONS.resolveAccount,
            operationKey: 'resolveAccount',
        });
    };
};

/**
 * Returns a client instance.  Construction performs NO I/O; the caller may
 * pass a custom `fetchImpl` (for example a test double) or nothing, in which
 * case the lazy global fetch is used.
 */
function createTransferClient(fetchImpl) {
    return new createPaystackTransferClient(fetchImpl);
}

module.exports = {
    PAYSTACK_BASE_URL,
    DEFAULT_TIMEOUT_MS,
    PaystackClientError,
    PaystackTransportError,
    PaystackTimeoutError,
    PaystackHttpError,
    PaystackResponseError,
    createTransferClient,
    createPaystackTransferClient: createTransferClient,
};