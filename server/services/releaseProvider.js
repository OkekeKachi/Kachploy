'use strict';

const PROVIDER_OUTCOMES = Object.freeze(['succeeded', 'failed', 'unknown']);

/**
 * The fields an authoritative lookup result must echo back before Stage 2C
 * accepts it. A result that omits one is not a confirmed outcome; a result that
 * disagrees with local state is a conflict. Money is never inferred from a bare
 * `succeeded` string.
 */
const LOOKUP_IDENTITY_FIELDS = Object.freeze([
    'releaseId',
    'attemptId',
    'attemptNumber',
    'currency',
    'amountMinor',
]);

class ReleaseProviderConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReleaseProviderConfigurationError';
        this.code = 'RELEASE_PROVIDER_NOT_CONFIGURED';
    }
}

const safeText = (value) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const PROVIDER_ERROR_OPERATIONS = Object.freeze([
    'createRecipient',
    'initiateTransfer',
    'getTransfer',
    'listBanks',
    'resolveAccount',
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const SECRET_TOKEN = /\b(?:Bearer\s+[A-Z0-9._~+/=-]+|sk_(?:test|live)_[A-Z0-9]+)\b/gi;
const LONG_DIGIT_SEQUENCE = /\b\d{6,}\b/g;

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
    if (text.length > 300) text = `${text.slice(0, 297)}...`;
    return text;
};

const normalizeProviderError = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;

    const statusCode =
        Number.isInteger(raw.statusCode)
        && raw.statusCode >= 100
        && raw.statusCode <= 599
            ? raw.statusCode
            : undefined;
    const message = sanitizeProviderMessage(raw.message);
    const type =
        typeof raw.type === 'string'
        && /^[A-Z0-9_.-]{1,64}$/i.test(raw.type.trim())
            ? raw.type.trim()
            : undefined;
    const operation = PROVIDER_ERROR_OPERATIONS.includes(raw.operation)
        ? raw.operation
        : undefined;

    if (statusCode === undefined && !message && !type && !operation) {
        return undefined;
    }

    return {
        ...(statusCode === undefined ? {} : { statusCode }),
        ...(message ? { message } : {}),
        ...(type ? { type } : {}),
        ...(operation ? { operation } : {}),
    };
};

const assertReleaseProvider = (provider) => {
    if (!provider || typeof provider.submitRelease !== 'function') {
        throw new ReleaseProviderConfigurationError(
            'an injected release provider with submitRelease() is required'
        );
    }
    return provider;
};

/**
 * Lookup is an OPTIONAL provider capability. Reconciliation must not assume a
 * provider can answer; a missing method means the authoritative outcome remains
 * unavailable and the release stays in review.
 */
const supportsOutcomeLookup = (provider) =>
    Boolean(provider && typeof provider.lookupReleaseOutcome === 'function');

const normalizeProviderOutcome = (raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!PROVIDER_OUTCOMES.includes(raw.outcome)) return null;

    const providerReference = safeText(raw.providerReference);
    const failureReason = safeText(raw.failureReason);
    const providerError = normalizeProviderError(raw.providerError);

    if (raw.outcome === 'succeeded' && !providerReference) return null;
    if (raw.outcome === 'failed' && !failureReason) return null;

    return {
        outcome: raw.outcome,
        ...(providerReference ? { providerReference } : {}),
        ...(failureReason ? { failureReason } : {}),
        ...(providerError ? { providerError } : {}),
    };
};

/**
 * Validates a provider lookup result against the exact release/attempt identity
 * that was queried.
 *
 * Returns:
 *   { ok: true, result }                       authoritative outcome
 *   { ok: false, reason, conflict: false }      missing/malformed -> unknown
 *   { ok: false, reason, conflict: true }       identity disagreement -> conflict
 *
 * Missing identity fields are deliberately NOT treated as success. The lookup
 * contract requires them so a provider response for another attempt cannot be
 * applied to this one.
 */
const normalizeProviderLookupOutcome = (raw, expected = {}) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, reason: 'lookup_result_missing', conflict: false };
    }

    const result = normalizeProviderOutcome(raw);
    if (!result) {
        return { ok: false, reason: 'lookup_result_malformed', conflict: false };
    }

    for (const field of LOOKUP_IDENTITY_FIELDS) {
        if (expected[field] === undefined) {
            return { ok: false, reason: `lookup_expected_${field}_missing`, conflict: false };
        }
        if (raw[field] === undefined || raw[field] === null) {
            return { ok: false, reason: `lookup_${field}_missing`, conflict: false };
        }
        if (raw[field] !== expected[field]) {
            return { ok: false, reason: `lookup_${field}_mismatch`, conflict: true };
        }
    }

    return { ok: true, result };
};

module.exports = {
    PROVIDER_OUTCOMES,
    LOOKUP_IDENTITY_FIELDS,
    ReleaseProviderConfigurationError,
    assertReleaseProvider,
    supportsOutcomeLookup,
    normalizeProviderOutcome,
    normalizeProviderLookupOutcome,
};
