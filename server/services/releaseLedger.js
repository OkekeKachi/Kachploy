'use strict';

// releaseLedger.js
//
// STAGE 2A. Mechanical shape and validation for an immutable ledger entry.
// This module deliberately defines NO accounting policy: it does not know what
// a balanced double entry means, how commission is recognised, whether funds
// are custodial, or which accounts exist. Those decisions are unresolved and
// are explicitly deferred.
//
// A release lifecycle event (releaseEventRepository) is not a ledger entry.
// Stage 2A never posts `release_paid_out` -- requesting a release, passing a
// read-only eligibility check, creating an attempt or approving a task does not
// establish that money moved. Only a later stage with a provider receipt may
// construct a balancing posting.
//
// BALANCED POSTING lives in services/accountingJournal.js (construction and
// validation) and services/accountingService.js (explicit, trusted posting).
// This module remains the single-entry shape validator used by the legacy
// create-only ledger repository; it does not decide when money moved.

const clock = require('../config/clock');
const { isPositiveSafeMinorAmount } = require('../config/commission');
const {
    RELEASE_CURRENCY,
    isValidDocumentId,
} = require('../config/release');
const {
    LEDGER_DIRECTIONS,
    LEDGER_ACCOUNT_TYPES,
} = require('../config/accounting');

const RELEASE_LEDGER_ENTRY_TYPES = Object.freeze(['release_payable']);

const COMPENSATING_ENTRY_TYPE = Object.freeze(['compensating']);

class ReleaseLedgerValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReleaseLedgerValidationError';
        this.code = 'RELEASE_INVALID_LEDGER_ENTRY';
    }
}

const nonEmptyString = (value) =>
    typeof value === 'string' && value.trim().length > 0;

/**
 * Validates and returns a ledger-entry document. `entryType` is restricted to
 * the explicit allowlist above: Stage 2B does not grant a simulated release the
 * authority to invent payout postings. `account` is a logical label, not a
 * bank-account or payout-recipient record.
 *
 * Corrections must be new entries with new ids; this builder never mutates an
 * existing entry and the repository exposes no update/delete operation.
 */
const buildLedgerEntry = (input = {}) => {
    const {
        releaseId,
        entryType,
        direction,
        amountMinor,
        currency = RELEASE_CURRENCY,
        account,
        reference,
        createdAt = clock.now(),
    } = input;

    if (!isValidDocumentId(releaseId)) {
        throw new ReleaseLedgerValidationError('releaseId must be a valid document id');
    }
    if (!nonEmptyString(entryType)) {
        throw new ReleaseLedgerValidationError('entryType must be a non-empty string');
    }
    if (!RELEASE_LEDGER_ENTRY_TYPES.includes(entryType.trim())) {
        throw new ReleaseLedgerValidationError(
            `entryType must be one of: ${RELEASE_LEDGER_ENTRY_TYPES.join(', ')}`
        );
    }
    if (!LEDGER_DIRECTIONS.includes(direction)) {
        throw new ReleaseLedgerValidationError(
            `direction must be one of: ${LEDGER_DIRECTIONS.join(', ')}`
        );
    }
    if (!isPositiveSafeMinorAmount(amountMinor)) {
        throw new ReleaseLedgerValidationError(
            'amountMinor must be a positive safe integer within the supported range'
        );
    }
    if (currency !== RELEASE_CURRENCY) {
        throw new ReleaseLedgerValidationError(
            `currency must be ${RELEASE_CURRENCY}`
        );
    }
    if (!nonEmptyString(account)) {
        throw new ReleaseLedgerValidationError('account must be a non-empty string');
    }
    if (reference !== undefined && !nonEmptyString(reference)) {
        throw new ReleaseLedgerValidationError('reference must be a non-empty string when supplied');
    }
    return {
        releaseId,
        entryType: entryType.trim(),
        direction,
        amountMinor,
        currency,
        account: account.trim(),
        ...(reference !== undefined ? { reference: reference.trim() } : {}),
        createdAt,
    };
};

/**
 * Builds a compensating entry for an existing ledger entry.
 * The compensating entry has the opposite direction and a reference
 * to the original entry id, enabling append-only corrections.
 * A correction is a NEW entry with a new deterministic id; this
 * builder never mutates an existing entry.
 */
const buildCompensatingEntry = (originalEntryId, originalEntry, direction) => {
    const compensatingDirection =
        direction === 'debit' ? 'credit' : direction === 'credit' ? 'debit' : direction;

    return {
        releaseId: originalEntry.releaseId,
        entryType: originalEntry.entryType,
        direction: compensatingDirection,
        amountMinor: originalEntry.amountMinor,
        currency: originalEntry.currency,
        account: originalEntry.account,
        reference: `comp_${originalEntryId}`,
        createdAt: originalEntry.createdAt,
    };
};

module.exports = {
    LEDGER_DIRECTIONS,
    RELEASE_LEDGER_ENTRY_TYPES,
    LEDGER_ACCOUNT_TYPES,
    ReleaseLedgerValidationError,
    buildLedgerEntry,
    buildCompensatingEntry,
};
