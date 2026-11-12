'use strict';

// release.js
//
// STAGE 2A. Shared vocabulary and deterministic identity for milestone/full-
// contract release records. This module is deliberately inert: it defines no
// provider reference, calls no payout service, and moves no money. It only
// gives the release domain one spelling for its states, its target types, its
// currency rule and its document ids.
//
// Release requests are keyed by the authoritative FUNDING record, not by a
// caller-supplied amount or identity:
//
//   milestone target -> payments/{milestoneId}       -> rel_{milestoneId}
//   contract target  -> payments/contract_{contractId} -> rel_contract_{contractId}
//
// That makes repeated or concurrent claims for the same target resolve to the
// same release document id. The repositories still use transactions, because a
// deterministic id is not itself a duplicate-creation guarantee -- two blind
// sets would overwrite each other.

const crypto = require('crypto');
const { CONTRACT_CURRENCY } = require('./commission');

/** The only target shapes the existing payment model can authoritatively fund. */
const RELEASE_TARGET_TYPES = Object.freeze(['milestone', 'contract']);

/** Release request states. `succeeded` and `cancelled` are terminal. */
const RELEASE_STATES = Object.freeze([
    'requested',
    'in_flight',
    'succeeded',
    'failed',
    'needs_review',
    'cancelled',
]);

/** Attempt states. Attempts are append-only in Stage 2A; retries use new ids. */
const RELEASE_ATTEMPT_STATES = Object.freeze([
    'created',
    'submitted',
    'succeeded',
    'failed',
    'unknown',
]);

/**
 * Audit event types. A lifecycle event is not a ledger entry: these record what
 * happened to a release record, not a balanced financial posting.
 */
const RELEASE_EVENT_TYPES = Object.freeze([
    'release_requested',
    'release_state_changed',
    'release_attempt_created',
    'release_attempt_state_changed',
    'release_attempt_submission_claimed',
    'release_attempt_outcome_recorded',
    'release_resolved',
    // STAGE 2C. Operational reconciliation is an investigation, never a
    // submission. These events describe what was looked at and what the
    // provider could (or could not) establish.
    'release_reconciliation_started',
    'release_provider_outcome_lookup_attempted',
    'release_provider_outcome_found',
    'release_provider_outcome_unavailable',
    'release_reconciliation_completed',
    'release_reconciliation_conflict',
    'release_admin_resolution_requested',
    'release_retry_authorized',
    // STAGE 2C.1. A retry authorization is proven and consumed in the same
    // transaction that claims the next attempt.
    'release_retry_authorization_validated',
    'release_retry_authorization_consumed',
]);

const RELEASE_CURRENCY = CONTRACT_CURRENCY;

/**
 * STAGE 2C staleness configuration.
 *
 * Staleness is only a reason to investigate a release/attempt. It is NEVER
 * evidence that a provider operation failed: an old `created` attempt may have
 * crashed before the provider was called, while an old `submitted` attempt may
 * have succeeded with the response lost. Reconciliation therefore uses
 * staleness to find work, not to invent an outcome.
 *
 * The default is a conservative operational threshold, not a domain rule. It is
 * overridable per call (tests and trusted internal callers) and from the
 * environment so an operator can tune it without a code change.
 */
const RELEASE_RECONCILIATION_STALE_AFTER_MS = 15 * 60 * 1000;
const RELEASE_RECONCILIATION_STALE_AFTER_ENV = 'RELEASE_RECONCILIATION_STALE_AFTER_MS';
const RELEASE_RECONCILIATION_DEFAULT_BATCH_SIZE = 25;
const RELEASE_RECONCILIATION_MAX_BATCH_SIZE = 100;
const RELEASE_RECONCILIATION_BATCH_SIZE_ENV = 'RELEASE_RECONCILIATION_BATCH_SIZE';

const positiveSafeInteger = (value) =>
    Number.isSafeInteger(value) && value > 0;

const reconciliationStaleAfterMs = (override) => {
    if (override !== undefined) {
        if (!positiveSafeInteger(override)) {
            throw new TypeError('staleAfterMs must be a positive safe integer');
        }
        return override;
    }

    const raw = process.env[RELEASE_RECONCILIATION_STALE_AFTER_ENV];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return RELEASE_RECONCILIATION_STALE_AFTER_MS;
    }

    const parsed = Number(String(raw).trim());
    if (!positiveSafeInteger(parsed)) {
        throw new TypeError(
            `${RELEASE_RECONCILIATION_STALE_AFTER_ENV} must be a positive safe integer of milliseconds`
        );
    }
    return parsed;
};

const reconciliationBatchSize = (override) => {
    if (override !== undefined) {
        if (!positiveSafeInteger(override)) {
            throw new TypeError('batchSize must be a positive safe integer');
        }
        return Math.min(override, RELEASE_RECONCILIATION_MAX_BATCH_SIZE);
    }

    const raw = process.env[RELEASE_RECONCILIATION_BATCH_SIZE_ENV];
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return RELEASE_RECONCILIATION_DEFAULT_BATCH_SIZE;
    }

    const parsed = Number(String(raw).trim());
    if (!positiveSafeInteger(parsed)) {
        throw new TypeError(
            `${RELEASE_RECONCILIATION_BATCH_SIZE_ENV} must be a positive safe integer`
        );
    }
    return Math.min(parsed, RELEASE_RECONCILIATION_MAX_BATCH_SIZE);
};

const RELEASE_ID_PREFIX = 'rel_';
const ATTEMPT_ID_SEPARATOR = '__attempt_';
const TRANSFER_REFERENCE_SEPARATOR = '_attempt_';

const releaseTransferReference = (releaseId, attemptNumber) => {
    assertValidDocumentId(releaseId, 'releaseId');
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new TypeError('attemptNumber must be a positive safe integer');
    }
    return `${releaseId}${TRANSFER_REFERENCE_SEPARATOR}${attemptNumber}`;
};

const parseReleaseTransferReference = (reference) => {
    if (typeof reference !== 'string' || !reference.trim()) return null;
    const match = /^(rel_.+)_attempt_(\d+)$/.exec(reference.trim());
    if (!match) return null;
    const attemptNumber = Number(match[2]);
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) return null;
    if (!isValidDocumentId(match[1])) return null;
    return { releaseId: match[1], attemptNumber };
};

/**
 * Firestore document ids are not arbitrary strings: they cannot contain '/',
 * cannot be '.' or '..', and must be non-empty. Validating here keeps a caller
 * from turning a target id into a path or an unusable document id.
 */
const isValidDocumentId = (value) =>
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1500 &&
    value === value.trim() &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/');

const assertValidDocumentId = (value, label) => {
    if (!isValidDocumentId(value)) {
        throw new TypeError(`${label} must be a valid non-empty Firestore document id`);
    }
};

/**
 * The release document id for an authoritative payment record id.
 *
 * Note that a full-contract payment id is already `contract_<contractId>` (see
 * paymentRepository), so this function does not add a second target prefix.
 */
const releaseRequestId = (paymentId) => {
    assertValidDocumentId(paymentId, 'paymentId');
    return `${RELEASE_ID_PREFIX}${paymentId}`;
};

/**
 * Deterministic attempt id. attemptNumber starts at 1 and a retry MUST use a
 * different number -- creating another attempt with the same number resolves
 * to the same document and is rejected as a duplicate by the repository.
 *
 * Stage 2A does not create or execute retries. This helper exists so the id
 * space is fixed before any provider-facing stage is allowed to use it.
 */
const releaseAttemptId = (releaseId, attemptNumber) => {
    assertValidDocumentId(releaseId, 'releaseId');
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new TypeError('attemptNumber must be a positive safe integer');
    }
    return `${releaseId}${ATTEMPT_ID_SEPARATOR}${attemptNumber}`;
};

/**
 * Deterministic, caller-keyed event / ledger ids. Hashing keeps arbitrary
 * event keys out of document ids and makes an idempotent append resolve to the
 * same document. Create-only repositories turn a second append into a no-op
 * (or a reported duplicate), never an overwrite.
 */
const hashedId = (prefix, releaseId, key) => {
    assertValidDocumentId(releaseId, 'releaseId');
    if (typeof key !== 'string' || !key.trim()) {
        throw new TypeError('key must be a non-empty string');
    }
    const digest = crypto
        .createHash('sha256')
        .update(`${releaseId}:${key}`)
        .digest('hex');
    return `${prefix}${digest}`;
};

const releaseEventId = (releaseId, eventKey) =>
    hashedId('evt_', releaseId, eventKey);

const releaseLedgerEntryId = (releaseId, entryKey) =>
    hashedId('led_', releaseId, entryKey);

module.exports = {
    RELEASE_TARGET_TYPES,
    RELEASE_STATES,
    RELEASE_ATTEMPT_STATES,
    RELEASE_EVENT_TYPES,
    RELEASE_CURRENCY,
    RELEASE_RECONCILIATION_STALE_AFTER_MS,
    RELEASE_RECONCILIATION_STALE_AFTER_ENV,
    RELEASE_RECONCILIATION_DEFAULT_BATCH_SIZE,
    RELEASE_RECONCILIATION_MAX_BATCH_SIZE,
    RELEASE_RECONCILIATION_BATCH_SIZE_ENV,
    reconciliationStaleAfterMs,
    reconciliationBatchSize,
    RELEASE_ID_PREFIX,
    ATTEMPT_ID_SEPARATOR,
    TRANSFER_REFERENCE_SEPARATOR,
    isValidDocumentId,
    assertValidDocumentId,
    releaseRequestId,
    releaseAttemptId,
    releaseTransferReference,
    parseReleaseTransferReference,
    releaseEventId,
    releaseLedgerEntryId,
};
