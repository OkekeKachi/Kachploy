'use strict';

// accounting.js
//
// Minimal chart of accounts and deterministic identity for balanced accounting
// journals.
//
// SCOPE. This module defines SHAPE, ACCOUNT NAMES, NORMAL BALANCES and
// IDENTITY. It does not decide unresolved business policy: whether collected
// funds are custodial, when commission is earned, how the checkout fee or the
// provider fee is recognised, or whether a payout is an expense or a
// distribution. Those decisions are recorded in the accounting service and the
// journal builders are deliberately conservative; see services/accountingService.js.
//
// DOUBLE ENTRY. Every journal has at least two lines and total debits must
// equal total credits. Money is an integer number of minor units (kobo) and is
// never a float. A normal balance is the side on which an account is expected
// to accumulate; it is used for reporting and reconciliation, not to decide
// whether an individual journal is valid.
//
// IDENTITY. Journal and line ids are deterministic hashes of a caller-supplied
// key, so replaying the same authoritative event resolves to the same documents
// and create-only persistence turns a repeat into a no-op rather than a
// duplicate posting.

const crypto = require('crypto');
const { RELEASE_CURRENCY, isValidDocumentId } = require('./release');

const ACCOUNTING_CURRENCY = RELEASE_CURRENCY;

const LEDGER_DIRECTIONS = Object.freeze(['debit', 'credit']);

/**
 * The chart of accounts.
 *
 * `collected_funds`      asset          debit   funds collected through the
 *                                                payment provider and
 *                                                attributable to a milestone
 * `employee_payable`     liability      credit  amount owed to the freelancer
 * `platform_revenue`     revenue        credit  platform commission (reserved:
 *                                                recognition policy deferred)
 * `payout_initiation`    liability      credit  payouts initiated but not yet
 *                                                confirmed
 * `completed_payout`     contra-asset   credit  confirmed payouts completed
 *                                                (reduces net collected funds)
 * `unresolved_outcome`   liability      credit  payouts whose outcome is unknown
 */
const LEDGER_ACCOUNT_TYPES = Object.freeze([
    'collected_funds',
    'employee_payable',
    'platform_revenue',
    'payout_initiation',
    'completed_payout',
    'unresolved_outcome',
]);

const ACCOUNT_NORMAL_BALANCE = Object.freeze({
    collected_funds: 'debit',
    employee_payable: 'credit',
    platform_revenue: 'credit',
    payout_initiation: 'credit',
    completed_payout: 'credit',
    unresolved_outcome: 'credit',
});

/**
 * The journal types the foundation knows how to name. `platform_revenue` and
 * `completed_payout` are represented by accounts; the journal type describes
 * the authoritative event that produced the balanced lines.
 */
const JOURNAL_TYPES = Object.freeze([
    'collection',
    'payout_initiation',
    'payout_succeeded',
    'payout_failed',
    'payout_unknown',
    'payout_recovered_succeeded',
    'payout_recovered_failed',
    'compensating',
]);

const hashedId = (prefix, sourceId, key) => {
    if (!isValidDocumentId(sourceId)) {
        throw new TypeError('sourceId must be a valid document id');
    }
    if (typeof key !== 'string' || !key.trim()) {
        throw new TypeError('journalKey must be a non-empty string');
    }
    const digest = crypto
        .createHash('sha256')
        .update(`${sourceId}:${key}`)
        .digest('hex');
    return `${prefix}${digest}`;
};

/**
 * Deterministic journal id for one authoritative event on a source record.
 * The source is the payment id for collections and the release id for payout
 * events, so the same event key can never produce two journals.
 */
const accountingJournalId = (sourceId, journalKey) =>
    hashedId('jrn_', sourceId, journalKey);

/**
 * Deterministic ledger-line id inside a journal. The line number is part of
 * the key, so the set of entry documents is fixed the moment the journal id
 * and the number of lines are known.
 */
const accountingLineId = (journalId, lineNumber) => {
    if (!isValidDocumentId(journalId)) {
        throw new TypeError('journalId must be a valid document id');
    }
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
        throw new TypeError('lineNumber must be a positive safe integer');
    }
    return `${journalId}__line_${lineNumber}`;
};

const JOURNAL_ATTEMPT_SEPARATOR = ':attempt_';

// STAGE 2H.1. Per-release-attempt outcome guard. The guard document records
// which terminal outcome (if any) has been committed for one attempt, so the
// decision to create an outcome journal and the journal write itself are one
// transaction. Without it, two concurrent replays of different outcome types
// could each pass the pre-write checks and post contradictory journals.
const OUTCOME_GUARD_COLLECTION = 'accountingOutcomeGuards';

const outcomeGuardId = (releaseId, attemptNumber) => {
    if (!isValidDocumentId(releaseId)) {
        throw new TypeError('releaseId must be a valid document id');
    }
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new TypeError('attemptNumber must be a positive safe integer');
    }
    return `${releaseId}__outcome_${attemptNumber}`;
};

/**
 * Attempt-scoped journal key.
 *
 * Payout retries are separate submission attempts on the same release, so each
 * attempt needs its own initiation and outcome journals. The first attempt keeps
 * the original release-scoped key so journals posted before attempt scoping
 * existed still resolve to the same deterministic id; a later attempt appends
 * its number. Collection keys are payment-scoped and pass no attempt number.
 */
const journalKey = (eventType, sourceId, attemptNumber) => {
    if (typeof eventType !== 'string' || !eventType.trim()) {
        throw new TypeError('eventType must be a non-empty string');
    }
    if (typeof sourceId !== 'string' || !sourceId.trim()) {
        throw new TypeError('sourceId must be a non-empty string');
    }

    const base = `${eventType}:${sourceId}`;
    if (attemptNumber === undefined || attemptNumber === null) {
        return base;
    }
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        throw new TypeError('attemptNumber must be a positive safe integer');
    }
    if (attemptNumber === 1) {
        return base;
    }
    return `${base}${JOURNAL_ATTEMPT_SEPARATOR}${attemptNumber}`;
};

module.exports = {
    JOURNAL_ATTEMPT_SEPARATOR,
    OUTCOME_GUARD_COLLECTION,
    ACCOUNTING_CURRENCY,
    LEDGER_DIRECTIONS,
    LEDGER_ACCOUNT_TYPES,
    ACCOUNT_NORMAL_BALANCE,
    JOURNAL_TYPES,
    accountingJournalId,
    accountingLineId,
    journalKey,
    outcomeGuardId,
};
