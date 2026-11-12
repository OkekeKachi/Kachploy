'use strict';

// accountingJournal.js
//
// STAGE. Pure construction and validation for balanced double-entry journals.
// No I/O happens here: the repository persists what this module returns, and
// the service decides when an authoritative event justifies posting.
//
// A journal is a set of two or more lines. Every line names an account from the
// chart, a direction and a positive integer kobo amount. The builder rejects a
// journal whose debits and credits do not balance, whose currency is not NGN,
// whose accounts are unknown, or whose amounts are not exact positive minors.
//
// The journal document stores totals and metadata; the lines are separate
// immutable `ledgerEntries` documents carrying the same `journalId`. That keeps
// the existing ledger collection as the single source of truth for entries
// while making the journal the atomic unit of posting.

const clock = require('../config/clock');
const { isPositiveSafeMinorAmount } = require('../config/commission');
const { isValidDocumentId } = require('../config/release');
const {
    ACCOUNTING_CURRENCY,
    LEDGER_ACCOUNT_TYPES,
    LEDGER_DIRECTIONS,
    JOURNAL_TYPES,
    accountingJournalId,
    accountingLineId,
    journalKey,
} = require('../config/accounting');

class AccountingValidationError extends Error {
    constructor(message, code = 'ACCOUNTING_INVALID_JOURNAL') {
        super(message);
        this.name = 'AccountingValidationError';
        this.code = code;
    }
}

const fail = (message, code) => {
    throw new AccountingValidationError(message, code);
};

const nonEmptyString = (value) =>
    typeof value === 'string' && value.trim().length > 0;

const normalizeLine = (line, index, journalCurrency, journalId) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
        fail(`line ${index + 1} must be an object`);
    }

    const lineNumber = line.lineNumber === undefined ? index + 1 : line.lineNumber;
    if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) {
        fail(`line ${index + 1} lineNumber must be a positive safe integer`);
    }
    if (!LEDGER_ACCOUNT_TYPES.includes(line.account)) {
        fail(
            `line ${index + 1} account must be one of: ${LEDGER_ACCOUNT_TYPES.join(', ')}`
        );
    }
    if (!LEDGER_DIRECTIONS.includes(line.direction)) {
        fail(
            `line ${index + 1} direction must be one of: ${LEDGER_DIRECTIONS.join(', ')}`
        );
    }
    if (!isPositiveSafeMinorAmount(line.amountMinor)) {
        fail(
            `line ${index + 1} amountMinor must be a positive safe integer within the supported range`
        );
    }
    if (line.currency !== undefined && line.currency !== journalCurrency) {
        fail(`line ${index + 1} currency must be ${journalCurrency}`);
    }
    if (line.reference !== undefined && !nonEmptyString(line.reference)) {
        fail(`line ${index + 1} reference must be a non-empty string when supplied`);
    }

    return {
        journalId,
        lineNumber,
        account: line.account,
        direction: line.direction,
        amountMinor: line.amountMinor,
        currency: journalCurrency,
        ...(line.reference !== undefined
            ? { reference: line.reference.trim() }
            : {}),
    };
};

/**
 * Validates and normalises a balanced journal.
 *
 * Returns `{ journal, lines, entries }`:
 *   journal  document for `ledgerJournals/{journalId}` (no line array)
 *   lines    normalised line objects (embedded in the response for tests and
 *            for the caller's reporting)
 *   entries  `[{ entryId, data }]` for `ledgerEntries`
 */
const buildJournal = (input = {}) => {
    const {
        journalId,
        journalType,
        currency = ACCOUNTING_CURRENCY,
        sourceId,
        releaseId,
        paymentId,
        attemptNumber,
        reference,
        compensatesJournalId,
        createdAt = clock.now(),
        lines = [],
    } = input;

    if (!isValidDocumentId(journalId)) {
        fail('journalId must be a valid document id');
    }
    if (!JOURNAL_TYPES.includes(journalType)) {
        fail(`journalType must be one of: ${JOURNAL_TYPES.join(', ')}`);
    }
    if (currency !== ACCOUNTING_CURRENCY) {
        fail(`currency must be ${ACCOUNTING_CURRENCY}`);
    }
    if (sourceId !== undefined && !isValidDocumentId(sourceId)) {
        fail('sourceId must be a valid document id when supplied');
    }
    if (releaseId !== undefined && !isValidDocumentId(releaseId)) {
        fail('releaseId must be a valid document id when supplied');
    }
    if (paymentId !== undefined && !isValidDocumentId(paymentId)) {
        fail('paymentId must be a valid document id when supplied');
    }
    if (
        attemptNumber !== undefined &&
        (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1)
    ) {
        fail('attemptNumber must be a positive safe integer when supplied');
    }
    if (reference !== undefined && !nonEmptyString(reference)) {
        fail('reference must be a non-empty string when supplied');
    }
    if (
        compensatesJournalId !== undefined &&
        !isValidDocumentId(compensatesJournalId)
    ) {
        fail('compensatesJournalId must be a valid document id when supplied');
    }
    if (!Array.isArray(lines) || lines.length < 2) {
        fail('a journal must have at least two lines');
    }

    const normalized = lines.map((line, index) =>
        normalizeLine(line, index, currency, journalId)
    );

    const seen = new Set();
    for (const line of normalized) {
        if (seen.has(line.lineNumber)) {
            fail(`duplicate lineNumber ${line.lineNumber}`);
        }
        seen.add(line.lineNumber);
    }

    let totalDebitMinor = 0;
    let totalCreditMinor = 0;
    for (const line of normalized) {
        if (line.direction === 'debit') {
            totalDebitMinor += line.amountMinor;
        } else {
            totalCreditMinor += line.amountMinor;
        }
    }

    if (totalDebitMinor !== totalCreditMinor) {
        fail(
            `journal is unbalanced: debits ${totalDebitMinor} != credits ${totalCreditMinor}`,
            'ACCOUNTING_UNBALANCED_JOURNAL'
        );
    }
    if (totalDebitMinor === 0) {
        fail('journal total must be greater than zero');
    }
    if (
        !Number.isSafeInteger(totalDebitMinor) ||
        !Number.isSafeInteger(totalCreditMinor)
    ) {
        fail('journal totals must be safe integers');
    }

    const journal = {
        journalId,
        journalType,
        currency,
        totalDebitMinor,
        totalCreditMinor,
        lineCount: normalized.length,
        ...(sourceId !== undefined ? { sourceId } : {}),
        ...(releaseId !== undefined ? { releaseId } : {}),
        ...(paymentId !== undefined ? { paymentId } : {}),
        ...(attemptNumber !== undefined ? { attemptNumber } : {}),
        ...(reference !== undefined ? { reference: reference.trim() } : {}),
        ...(compensatesJournalId !== undefined
            ? { compensatesJournalId }
            : {}),
        createdAt,
    };

    const entries = normalized
        .slice()
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map((line) => ({
            entryId: accountingLineId(journalId, line.lineNumber),
            data: {
                ...line,
                entryType: 'journal_line',
                journalType,
                ...(attemptNumber !== undefined ? { attemptNumber } : {}),
                createdAt,
            },
        }));

    return { journal, lines: normalized, entries };
};

const pair = (debitAccount, creditAccount, amountMinor, currency) => [
    {
        lineNumber: 1,
        account: debitAccount,
        direction: 'debit',
        amountMinor,
        currency,
    },
    {
        lineNumber: 2,
        account: creditAccount,
        direction: 'credit',
        amountMinor,
        currency,
    },
];

/**
 * A verified collection: the employer's payment has been confirmed as paid and
 * the amount attributable to the freelancer becomes a liability.
 *
 * `amountMinor` is always the GROSS amount collected. For a commission-aware
 * payment the caller also supplies `netPayableMinor` and
 * `commissionAmountMinor`, producing three lines:
 *
 *   debit  collected_funds  gross
 *   credit employee_payable net
 *   credit platform_revenue commission
 *
 * Commission is recognised only when it is actually part of the stored payment
 * split. Legacy payments and zero-commission payments keep the original
 * two-line journal, so historical books and their tests are unchanged. The
 * checkout/provider fees remain outside this journal by design.
 */
const buildCollectionJournal = ({
    paymentId,
    amountMinor,
    netPayableMinor = amountMinor,
    commissionAmountMinor = 0,
    currency = ACCOUNTING_CURRENCY,
    createdAt = clock.now(),
}) => {
    if (!isPositiveSafeMinorAmount(netPayableMinor)) {
        fail('netPayableMinor must be a positive safe integer within the supported range');
    }
    if (
        !Number.isSafeInteger(commissionAmountMinor) ||
        commissionAmountMinor < 0
    ) {
        fail('commissionAmountMinor must be a non-negative safe integer');
    }
    if (netPayableMinor + commissionAmountMinor !== amountMinor) {
        fail('netPayableMinor + commissionAmountMinor must equal amountMinor');
    }

    const key = journalKey('collection', paymentId);
    const lines = [
        {
            lineNumber: 1,
            account: 'collected_funds',
            direction: 'debit',
            amountMinor,
            currency,
        },
        {
            lineNumber: 2,
            account: 'employee_payable',
            direction: 'credit',
            amountMinor: netPayableMinor,
            currency,
        },
    ];
    if (commissionAmountMinor > 0) {
        lines.push({
            lineNumber: 3,
            account: 'platform_revenue',
            direction: 'credit',
            amountMinor: commissionAmountMinor,
            currency,
        });
    }

    return buildJournal({
        journalId: accountingJournalId(paymentId, key),
        journalType: 'collection',
        sourceId: paymentId,
        paymentId,
        currency,
        reference: key,
        createdAt,
        lines,
    });
};

const buildPayoutInitiationJournal = ({
    releaseId,
    attemptNumber,
    amountMinor,
    currency = ACCOUNTING_CURRENCY,
    createdAt = clock.now(),
}) => {
    const key = journalKey('payout_initiation', releaseId, attemptNumber);
    return buildJournal({
        journalId: accountingJournalId(releaseId, key),
        journalType: 'payout_initiation',
        sourceId: releaseId,
        releaseId,
        attemptNumber,
        currency,
        reference: key,
        createdAt,
        lines: pair(
            'employee_payable',
            'payout_initiation',
            amountMinor,
            currency
        ),
    });
};

const buildPayoutSucceededJournal = ({
    releaseId,
    attemptNumber,
    amountMinor,
    currency = ACCOUNTING_CURRENCY,
    recovered = false,
    createdAt = clock.now(),
}) => {
    const eventType = recovered
        ? 'payout_recovered_succeeded'
        : 'payout_succeeded';
    const key = journalKey(eventType, releaseId, attemptNumber);
    return buildJournal({
        journalId: accountingJournalId(releaseId, key),
        journalType: eventType,
        sourceId: releaseId,
        releaseId,
        attemptNumber,
        currency,
        reference: key,
        createdAt,
        lines: pair(
            recovered ? 'unresolved_outcome' : 'payout_initiation',
            'completed_payout',
            amountMinor,
            currency
        ),
    });
};

const buildPayoutFailedJournal = ({
    releaseId,
    attemptNumber,
    amountMinor,
    currency = ACCOUNTING_CURRENCY,
    recovered = false,
    createdAt = clock.now(),
}) => {
    const eventType = recovered
        ? 'payout_recovered_failed'
        : 'payout_failed';
    const key = journalKey(eventType, releaseId, attemptNumber);
    return buildJournal({
        journalId: accountingJournalId(releaseId, key),
        journalType: eventType,
        sourceId: releaseId,
        releaseId,
        attemptNumber,
        currency,
        reference: key,
        createdAt,
        lines: pair(
            recovered ? 'unresolved_outcome' : 'payout_initiation',
            'employee_payable',
            amountMinor,
            currency
        ),
    });
};

const buildPayoutUnknownJournal = ({
    releaseId,
    attemptNumber,
    amountMinor,
    currency = ACCOUNTING_CURRENCY,
    createdAt = clock.now(),
}) => {
    const key = journalKey('payout_unknown', releaseId, attemptNumber);
    return buildJournal({
        journalId: accountingJournalId(releaseId, key),
        journalType: 'payout_unknown',
        sourceId: releaseId,
        releaseId,
        attemptNumber,
        currency,
        reference: key,
        createdAt,
        lines: pair(
            'payout_initiation',
            'unresolved_outcome',
            amountMinor,
            currency
        ),
    });
};

/**
 * Reverses every line of an existing journal, producing a new balanced journal
 * that references the original. Append-only corrections: the original journal
 * and its entries are never mutated.
 */
const buildCompensatingJournal = ({
    originalJournal,
    originalLines,
    reason,
    createdAt = clock.now(),
}) => {
    if (!originalJournal || !isValidDocumentId(originalJournal.journalId)) {
        fail('originalJournal must be a stored journal with a valid journalId');
    }
    if (!Array.isArray(originalLines) || originalLines.length < 2) {
        fail('originalLines must contain the stored journal lines');
    }

    const key = journalKey('compensating', originalJournal.journalId);
    const lines = originalLines
        .slice()
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map((line) => ({
            lineNumber: line.lineNumber,
            account: line.account,
            direction: line.direction === 'debit' ? 'credit' : 'debit',
            amountMinor: line.amountMinor,
            currency: line.currency,
            reference: `comp:${originalJournal.journalId}`,
        }));

    return buildJournal({
        journalId: accountingJournalId(originalJournal.journalId, key),
        journalType: 'compensating',
        sourceId: originalJournal.journalId,
        releaseId: originalJournal.releaseId,
        paymentId: originalJournal.paymentId,
        ...(originalJournal.attemptNumber !== undefined
            ? { attemptNumber: originalJournal.attemptNumber }
            : {}),
        currency: originalJournal.currency,
        reference: reason
            ? `compensating:${originalJournal.journalId}:${reason}`
            : key,
        compensatesJournalId: originalJournal.journalId,
        createdAt,
        lines,
    });
};

module.exports = {
    AccountingValidationError,
    buildJournal,
    buildCollectionJournal,
    buildPayoutInitiationJournal,
    buildPayoutSucceededJournal,
    buildPayoutFailedJournal,
    buildPayoutUnknownJournal,
    buildCompensatingJournal,
};
