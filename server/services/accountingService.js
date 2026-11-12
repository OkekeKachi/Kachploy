'use strict';

// accountingService.js
//
// Explicit, trusted posting entry points for balanced double-entry journals.
//
// WHY EXPLICIT. These functions are the trusted posting boundary; they do not
// observe lifecycle state on their own. accountingLifecycleService calls them
// after the authoritative payment/release transaction has committed: after a
// collection is verified paid, after a payout submission claim is acquired, or
// after a provider/admin outcome is recorded. Because a domain write and a
// journal write are separate transactions, this layer is also the replay point:
// the functions are idempotent, so a caller may safely retry or backfill.
//
// POLICY DECISIONS THAT REMAIN OPEN (documented, not silently invented):
//   * Whether a verified collection means Kachploy possesses or controls the
//     funds. `collected_funds` is an asset label for funds attributed to the
//     milestone; no escrow/custody claim is made.
//   * When platform commission is earned. `platform_revenue` is defined in the
//     chart but NO commission journal is posted by default.
//   * How the checkout fee (chargeMinor - amountMinor) and the provider fee are
//     recognised. The collection journal posts only `amountMinor`, the amount
//     the release domain pays out.
//   * Whether a completed payout is an expense or a distribution.
//     `completed_payout` is a contra-asset that offsets collected funds; it is
//     not treated as an expense.
//
// SEQUENCING. Payout journals require the earlier journal they depend on:
//   collection -> payout initiation -> succeeded / failed / unknown
//   unknown -> recovered succeeded / recovered failed
// A missing predecessor is refused rather than posting an unbalanced economic
// story. The collection journal can be backfilled for a historical paid payment.

const clock = require('../config/clock');
const { db } = require('../config/firebase');
const {
    isPositiveSafeMinorAmount,
    paymentCommissionSplit,
} = require('../config/commission');
const { isValidDocumentId, releaseAttemptId } = require('../config/release');
const {
    ACCOUNTING_CURRENCY,
    accountingJournalId,
    journalKey,
    outcomeGuardId,
} = require('../config/accounting');
const releaseRepository = require('../repositories/releaseRepository');
const journalRepository = require('../repositories/journalRepository');
const {
    AccountingValidationError,
    buildCollectionJournal,
    buildPayoutInitiationJournal,
    buildPayoutSucceededJournal,
    buildPayoutFailedJournal,
    buildPayoutUnknownJournal,
    buildCompensatingJournal,
} = require('./accountingJournal');

const fail = (message, code) => {
    throw new AccountingValidationError(message, code);
};

const paymentDoc = (paymentId) => db.collection('payments').doc(paymentId);

const requirePaymentId = (paymentId) => {
    if (!isValidDocumentId(paymentId)) {
        fail('paymentId must be a valid document id', 'ACCOUNTING_INVALID_REQUEST');
    }
};

const requireReleaseId = (releaseId) => {
    if (!isValidDocumentId(releaseId)) {
        fail('releaseId must be a valid document id', 'ACCOUNTING_INVALID_REQUEST');
    }
};

const loadPayment = async (paymentId) => {
    const snapshot = await paymentDoc(paymentId).get();
    if (!snapshot.exists) {
        fail(`payment ${paymentId} was not found`, 'ACCOUNTING_PAYMENT_NOT_FOUND');
    }
    return { id: snapshot.id, ...snapshot.data() };
};

const loadRelease = async (releaseId) => {
    const snapshot = await releaseRepository.getReleaseById(releaseId);
    if (!snapshot || !snapshot.exists) {
        fail(`release ${releaseId} was not found`, 'ACCOUNTING_RELEASE_NOT_FOUND');
    }
    return { id: snapshot.id, ...snapshot.data() };
};

const loadAttempt = async (releaseId, attemptNumber) => {
    const snapshot = await releaseRepository.getAttemptById(
        releaseAttemptId(releaseId, attemptNumber)
    );
    if (!snapshot || !snapshot.exists) {
        return null;
    }
    const stored = { id: snapshot.id, ...snapshot.data() };
    if (
        stored.releaseId !== releaseId ||
        stored.attemptNumber !== attemptNumber
    ) {
        fail(
            `release attempt ${attemptNumber} for ${releaseId} is inconsistent`,
            'ACCOUNTING_ATTEMPT_INCONSISTENT'
        );
    }
    return stored;
};

/**
 * Resolves which attempt a posting belongs to. The attempt document is the
 * authoritative record once it exists. A release seeded without attempt
 * documents (legacy/foundation shape) falls back to the release's counters, and
 * an attempt beyond the release's counters is refused rather than invented.
 */
const resolveAttemptContext = async (release, attemptNumber) => {
    const supplied = attemptNumber;
    const fallback = Number.isSafeInteger(release.currentAttemptNumber)
        ? release.currentAttemptNumber
        : Number.isSafeInteger(release.attemptCount) && release.attemptCount > 0
          ? release.attemptCount
          : 1;
    const resolvedNumber = supplied === undefined ? fallback : supplied;

    if (!Number.isSafeInteger(resolvedNumber) || resolvedNumber < 1) {
        fail(
            'attemptNumber must be a positive safe integer',
            'ACCOUNTING_INVALID_REQUEST'
        );
    }

    const attempt = await loadAttempt(release.id, resolvedNumber);
    if (attempt) {
        return { attemptNumber: resolvedNumber, attempt };
    }

    const counter = Number.isSafeInteger(release.attemptCount)
        ? release.attemptCount
        : 0;
    if (resolvedNumber > counter) {
        fail(
            `release ${release.id} has no attempt ${resolvedNumber}`,
            'ACCOUNTING_ATTEMPT_NOT_FOUND'
        );
    }
    return { attemptNumber: resolvedNumber, attempt: null };
};

const requirePostableAmount = (record, label) => {
    if (!isPositiveSafeMinorAmount(record.amountMinor)) {
        fail(
            `${label} amountMinor must be a positive safe integer within the supported range`,
            'ACCOUNTING_INVALID_AMOUNT'
        );
    }
    if (record.currency !== ACCOUNTING_CURRENCY) {
        fail(
            `${label} currency must be ${ACCOUNTING_CURRENCY}`,
            'ACCOUNTING_INVALID_CURRENCY'
        );
    }
};

const post = (built) =>
    journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

const collectionJournalIdFor = (paymentId) =>
    accountingJournalId(paymentId, journalKey('collection', paymentId));

const initiationJournalIdFor = (releaseId, attemptNumber) =>
    accountingJournalId(
        releaseId,
        journalKey('payout_initiation', releaseId, attemptNumber)
    );

const unknownJournalIdFor = (releaseId, attemptNumber) =>
    accountingJournalId(
        releaseId,
        journalKey('payout_unknown', releaseId, attemptNumber)
    );

const succeededJournalIdFor = (releaseId, recovered = false, attemptNumber) =>
    accountingJournalId(
        releaseId,
        journalKey(
            recovered ? 'payout_recovered_succeeded' : 'payout_succeeded',
            releaseId,
            attemptNumber
        )
    );

const failedJournalIdFor = (releaseId, recovered = false, attemptNumber) =>
    accountingJournalId(
        releaseId,
        journalKey(
            recovered ? 'payout_recovered_failed' : 'payout_failed',
            releaseId,
            attemptNumber
        )
    );

const journalExists = async (journalId) => {
    const snapshot = await journalRepository.getJournalById(journalId);
    return Boolean(snapshot && snapshot.exists);
};

const journalAttemptOf = (journal) =>
    Number.isSafeInteger(journal.attemptNumber) ? journal.attemptNumber : 1;

/**
 * The synchronous decision evaluated inside the guarded journal transaction.
 * The outcome guard, not a pre-write read, is authoritative for whether an
 * attempt already has a terminal outcome, so concurrent replays cannot post
 * contradictory journals.
 */
const decideOutcomeGuard = (
    { guard, journalExists: exists },
    { kind, recovered, legacyUnknown, releaseId, attemptNumber, journalId }
) => {
    if (exists) {
        return { action: 'duplicate' };
    }

    const next = {
        guardId: outcomeGuardId(releaseId, attemptNumber),
        releaseId,
        attemptNumber,
        terminalKind: guard && guard.terminalKind ? guard.terminalKind : null,
        terminalJournalId:
            guard && guard.terminalJournalId ? guard.terminalJournalId : null,
        terminalCompensated: Boolean(guard && guard.terminalCompensated),
        unknown: Boolean(guard && guard.unknown),
        unknownJournalId:
            guard && guard.unknownJournalId ? guard.unknownJournalId : null,
        unknownCompensated: Boolean(guard && guard.unknownCompensated),
        createdAt: (guard && guard.createdAt) || clock.now(),
        updatedAt: clock.now(),
    };

    const terminalActive = Boolean(next.terminalKind) && !next.terminalCompensated;
    const effectiveUnknown = guard
        ? next.unknown && !next.unknownCompensated
        : Boolean(legacyUnknown);

    if (kind === 'unknown') {
        if (terminalActive) {
            return {
                action: 'refuse',
                reason: 'ACCOUNTING_ATTEMPT_ALREADY_TERMINAL',
                message: `attempt ${attemptNumber} of release ${releaseId} already has a terminal ${next.terminalKind} journal`,
            };
        }
        if (next.terminalKind && next.terminalCompensated) {
            next.terminalKind = null;
            next.terminalJournalId = null;
            next.terminalCompensated = false;
        }
        next.unknown = true;
        next.unknownJournalId = journalId;
        next.unknownCompensated = false;
        return { action: 'create', guard: next };
    }

    if (terminalActive) {
        if (next.terminalKind === kind) {
            // The guard and the deterministic journal are normally written in
            // one transaction. If an older/partial write left the guard behind
            // without its terminal journal, replaying the same justified
            // outcome repairs that journal instead of reporting a duplicate.
            if (!exists && next.terminalJournalId === journalId) {
                return { action: 'create', guard: next };
            }
            return { action: 'duplicate' };
        }
        return {
            action: 'refuse',
            reason:
                next.terminalKind === 'failed'
                    ? 'CONFLICTING_FAILED_JOURNAL'
                    : 'CONFLICTING_SUCCEEDED_JOURNAL',
            message: `attempt ${attemptNumber} of release ${releaseId} already has a terminal ${next.terminalKind} journal`,
        };
    }

    if (
        next.terminalKind === kind
        && next.terminalCompensated
        && !exists
    ) {
        // A compensated outcome must not be resurrected by a replay. An
        // explicit correction has to target a different outcome.
        return { action: 'duplicate' };
    }

    if (recovered !== effectiveUnknown) {
        return { action: 'retry', recovered: effectiveUnknown };
    }

    next.terminalKind = kind;
    next.terminalJournalId = journalId;
    next.terminalCompensated = false;
    next.unknown = false;
    return { action: 'create', guard: next };
};

/**
 * Posts one outcome journal through the per-attempt guard. If the guard
 * disagrees with the recovered form the caller built, the journal is rebuilt
 * once with the guard's authoritative value; a bounded loop avoids trusting a
 * stale pre-write read.
 */
const postOutcome = async ({
    kind,
    releaseId,
    attemptNumber,
    recovered = false,
    legacyUnknown = false,
    build,
}) => {
    let recoveredFlag = recovered;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const built = build(recoveredFlag);
        const result = await journalRepository.createJournalWithEntriesGuarded(
            built.journal.journalId,
            built.journal,
            built.entries,
            {
                guardId: outcomeGuardId(releaseId, attemptNumber),
                decide: (state) =>
                    decideOutcomeGuard(state, {
                        kind,
                        recovered: recoveredFlag,
                        legacyUnknown,
                        releaseId,
                        attemptNumber,
                        journalId: built.journal.journalId,
                    }),
            }
        );
        if (result.retry) {
            recoveredFlag = result.recovered;
            continue;
        }
        if (result.refused) {
            fail(
                result.message || `outcome posting was refused for ${releaseId}`,
                result.reason || 'ACCOUNTING_OUTCOME_REFUSED'
            );
        }
        return result;
    }
    fail(
        `outcome guard for release ${releaseId} attempt ${attemptNumber} did not settle`,
        'ACCOUNTING_OUTCOME_GUARD_UNSETTLED'
    );
};

/**
 * Posts the balanced collection journal for a payment the provider has verified
 * as paid. Refuses any other payment status.
 */
const recordVerifiedCollection = async ({ paymentId } = {}) => {
    requirePaymentId(paymentId);
    const payment = await loadPayment(paymentId);
    if (payment.status !== 'paid') {
        fail(
            `payment ${paymentId} is not paid and cannot be posted as a collection`,
            'ACCOUNTING_PAYMENT_NOT_PAID'
        );
    }
    requirePostableAmount(payment, `payment ${paymentId}`);

    const split = paymentCommissionSplit(payment);
    const built = buildCollectionJournal({
        paymentId,
        amountMinor: split.grossAmountMinor,
        netPayableMinor: split.netPayableMinor,
        commissionAmountMinor: split.commissionAmountMinor,
        currency: payment.currency,
    });
    return post(built);
};

/**
 * Posts the payout-initiation journal for the named submission attempt of a
 * release (the current attempt when none is supplied). The corresponding
 * collection journal must already exist.
 */
const recordPayoutInitiation = async ({ releaseId, attemptNumber } = {}) => {
    requireReleaseId(releaseId);
    const release = await loadRelease(releaseId);

    const attemptCount = Number.isSafeInteger(release.attemptCount)
        ? release.attemptCount
        : 0;
    if (attemptCount < 1) {
        fail(
            `release ${releaseId} has no submitted attempt`,
            'ACCOUNTING_RELEASE_NOT_INITIATED'
        );
    }

    const context = await resolveAttemptContext(release, attemptNumber);
    const n = context.attemptNumber;
    const source = context.attempt || release;
    requirePostableAmount(source, `release ${releaseId} attempt ${n}`);

    const collectionId = collectionJournalIdFor(release.paymentId);
    if (!(await journalExists(collectionId))) {
        fail(
            `collection journal ${collectionId} has not been posted for release ${releaseId}`,
            'ACCOUNTING_COLLECTION_NOT_POSTED'
        );
    }

    return post(
        buildPayoutInitiationJournal({
            releaseId,
            attemptNumber: n,
            amountMinor: source.amountMinor,
            currency: source.currency,
        })
    );
};

const requireInitiationPosted = async (releaseId, attemptNumber) => {
    const initiationId = initiationJournalIdFor(releaseId, attemptNumber);
    if (!(await journalExists(initiationId))) {
        fail(
            `payout initiation journal ${initiationId} has not been posted for release ${releaseId}`,
            'ACCOUNTING_PAYOUT_NOT_INITIATED'
        );
    }
};

const unknownPosted = (releaseId, attemptNumber) =>
    journalExists(unknownJournalIdFor(releaseId, attemptNumber));

/**
 * Common attempt-scoped validation for the confirmed-outcome journals. The
 * attempt document is authoritative; the release status is also accepted so an
 * explicitly resolved correction (for example a late provider success after a
 * posted failure was reversed) can still be posted. A terminal attempt that
 * matches neither its own status nor the release status is refused.
 */
const requireOutcomeAllowed = (release, context, expected, expectedCode) => {
    if (context.attempt) {
        if (
            context.attempt.status !== expected &&
            release.status !== expected
        ) {
            fail(
                `attempt ${context.attemptNumber} of release ${release.id} must be ${expected} to post this journal, got attempt ${context.attempt.status} / release ${release.status}`,
                expectedCode
            );
        }
        return;
    }
    if (release.status !== expected) {
        fail(
            `release ${release.id} must be ${expected} to post this journal, got ${release.status}`,
            expectedCode
        );
    }
};

/**
 * Posts the confirmed-success journal for one submission attempt. If an
 * unknown-outcome journal exists for the SAME attempt, the recovered form
 * (unresolved_outcome -> completed_payout) is used instead of assuming the
 * payout initiation is still outstanding.
 */
const recordPayoutSucceeded = async ({ releaseId, attemptNumber } = {}) => {
    requireReleaseId(releaseId);
    const release = await loadRelease(releaseId);
    requirePostableAmount(release, `release ${releaseId}`);

    const context = await resolveAttemptContext(release, attemptNumber);
    const n = context.attemptNumber;
    const source = context.attempt || release;
    requirePostableAmount(source, `release ${releaseId} attempt ${n}`);
    requireOutcomeAllowed(release, context, 'succeeded', 'ACCOUNTING_RELEASE_NOT_SUCCEEDED');

    const recovered = await unknownPosted(releaseId, n);
    if (!recovered) {
        await requireInitiationPosted(releaseId, n);
    }

    return postOutcome({
        kind: 'succeeded',
        releaseId,
        attemptNumber: n,
        recovered,
        legacyUnknown: recovered,
        build: (recoveredForm) =>
            buildPayoutSucceededJournal({
                releaseId,
                attemptNumber: n,
                amountMinor: source.amountMinor,
                currency: source.currency,
                recovered: recoveredForm,
            }),
    });
};

/**
 * Posts the confirmed-failure journal for one submission attempt. If an
 * unknown-outcome journal exists for the SAME attempt, the recovered form
 * (unresolved_outcome -> employee_payable) is used.
 */
const recordPayoutFailed = async ({ releaseId, attemptNumber } = {}) => {
    requireReleaseId(releaseId);
    const release = await loadRelease(releaseId);
    requirePostableAmount(release, `release ${releaseId}`);

    const context = await resolveAttemptContext(release, attemptNumber);
    const n = context.attemptNumber;
    const source = context.attempt || release;
    requirePostableAmount(source, `release ${releaseId} attempt ${n}`);
    requireOutcomeAllowed(release, context, 'failed', 'ACCOUNTING_RELEASE_NOT_FAILED');

    const recovered = await unknownPosted(releaseId, n);
    if (!recovered) {
        await requireInitiationPosted(releaseId, n);
    }

    return postOutcome({
        kind: 'failed',
        releaseId,
        attemptNumber: n,
        recovered,
        legacyUnknown: recovered,
        build: (recoveredForm) =>
            buildPayoutFailedJournal({
                releaseId,
                attemptNumber: n,
                amountMinor: source.amountMinor,
                currency: source.currency,
                recovered: recoveredForm,
            }),
    });
};

/**
 * Posts the unknown-outcome journal for a release under review. This moves the
 * in-flight obligation to the unresolved-outcome account; it never claims the
 * payout succeeded or failed. A posting is only justified while the attempt is
 * not yet terminal.
 */
const recordPayoutUnknown = async ({ releaseId, attemptNumber } = {}) => {
    requireReleaseId(releaseId);
    const release = await loadRelease(releaseId);
    requirePostableAmount(release, `release ${releaseId}`);

    const context = await resolveAttemptContext(release, attemptNumber);
    const n = context.attemptNumber;
    const source = context.attempt || release;
    requirePostableAmount(source, `release ${releaseId} attempt ${n}`);

    if (context.attempt) {
        const status = context.attempt.status;
        if (status === 'succeeded' || status === 'failed') {
            fail(
                `attempt ${n} of release ${releaseId} is terminal (${status}) and cannot be posted as unknown`,
                'ACCOUNTING_RELEASE_NOT_UNDER_REVIEW'
            );
        }
    } else if (release.status !== 'needs_review') {
        fail(
            `release ${release.id} must be needs_review to post this journal, got ${release.status}`,
            'ACCOUNTING_RELEASE_NOT_UNDER_REVIEW'
        );
    }

    await requireInitiationPosted(releaseId, n);

    return postOutcome({
        kind: 'unknown',
        releaseId,
        attemptNumber: n,
        build: () =>
            buildPayoutUnknownJournal({
                releaseId,
                attemptNumber: n,
                amountMinor: source.amountMinor,
                currency: source.currency,
            }),
    });
};

const lineFromSnapshot = (snapshot) => ({
    entryId: snapshot.id,
    ...snapshot.data(),
});

/**
 * Appends a compensating journal that exactly reverses an existing journal.
 * The original journal and its entries are never mutated.
 */
const reverseJournal = async ({ journalId, reason } = {}) => {
    if (!isValidDocumentId(journalId)) {
        fail('journalId must be a valid document id', 'ACCOUNTING_INVALID_REQUEST');
    }

    const journalSnapshot = await journalRepository.getJournalById(journalId);
    if (!journalSnapshot || !journalSnapshot.exists) {
        fail(`journal ${journalId} was not found`, 'ACCOUNTING_JOURNAL_NOT_FOUND');
    }

    const entriesSnapshot = await journalRepository.listEntriesByJournalId(journalId);
    const originalLines = entriesSnapshot.docs.map(lineFromSnapshot);
    if (originalLines.length < 2) {
        fail(
            `journal ${journalId} does not have the lines required to reverse it`,
            'ACCOUNTING_JOURNAL_INCOMPLETE'
        );
    }

    const originalJournal = { journalId, ...journalSnapshot.data() };
    const built = buildCompensatingJournal({
        originalJournal,
        originalLines,
        reason,
    });

    if (!isValidDocumentId(originalJournal.releaseId)) {
        return post(built);
    }

    return journalRepository.createCompensatingJournalWithGuardUpdate(
        built.journal.journalId,
        built.journal,
        built.entries,
        {
            guardId: outcomeGuardId(
                originalJournal.releaseId,
                journalAttemptOf(originalJournal)
            ),
            targetJournalId: journalId,
        }
    );
};

module.exports = {
    AccountingValidationError,
    recordVerifiedCollection,
    recordPayoutInitiation,
    recordPayoutSucceeded,
    recordPayoutFailed,
    recordPayoutUnknown,
    reverseJournal,
    journalExists,
    collectionJournalIdFor,
    initiationJournalIdFor,
    unknownJournalIdFor,
    succeededJournalIdFor,
    failedJournalIdFor,
};
