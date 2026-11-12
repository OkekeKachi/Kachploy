'use strict';

// accountingReconciliationService.js
//
// STAGE 2G. Read-only invariant checks over the balanced-journal ledger and
// what the authoritative money records justify. It writes nothing and changes
// no state: every finding is a discrepancy report that reconciliation workers
// or trusted operators act on through the existing, explicit tools
// (reconciliation repair, compensating journals, backfill) -- never through a
// write invented here.
//
// CHECKS
//   Ledger integrity: every stored journal balances, matches the totals of the
//   entry lines that reference it, uses the ledger currency and a known type,
//   and no entry references a journal that does not exist. Global debits equal
//   global credits. Every compensating journal references an existing target and
//   is a structural reversal of it; a target reversed more than once is
//   reported and duplicate reversals do not count as effective compensation.
//   Ownership: every collection journal names an existing payment, every payout
//   journal names an existing release and an attempt that release claims, and no
//   journal is a free-standing orphan. A compensating journal is owned through
//   its target.
//   Collections: a PAID payment has exactly one uncompensated collection
//   journal, for its exact amountMinor and currency; a payment that is not
//   paid has none.
//   Releases and attempts (attempt documents are authoritative): every claimed
//   attempt has exactly one uncompensated initiation journal and no journal for
//   an outcome its status does not justify. A terminal attempt carries exactly
//   one journal of its own outcome kind; an unknown suspense journal is clean
//   only while the attempt is unresolved (status unknown) or when the recovered
//   outcome journal for the SAME attempt bookends it -- a dangling suspense
//   entry on a terminal attempt is reported. A succeeded release has exactly
//   one uncompensated success journal across all its attempts; a failed or
//   needs_review release has none. A release's amount matches its funding
//   payment record.
//
// SCOPE. "ok" means the journals are internally consistent with the
// authoritative records. There is no payout provider statement to reconcile
// against yet (no real provider integration exists), so this says nothing
// about whether a provider agrees with the ledger; that remains an explicit,
// deferred integration.
//
// LEGACY SHAPES. Journals posted before attempt scoping carried no
// attemptNumber and are treated as attempt 1. Releases without attempt
// documents (foundation/lab shapes) are audited through a synthetic attempt view
// derived from the release status when the release claims an attempt
// (attemptCount/currentAttemptNumber); a release that claims one but is still
// requested/cancelled is reported as inconsistent. An unclaimed release has no
// attempt-level checks because it has no authoritative attempt record.

const clock = require('../config/clock');
const { paymentCommissionSplit } = require('../config/commission');
const {
    ACCOUNTING_CURRENCY,
    JOURNAL_TYPES,
    LEDGER_ACCOUNT_TYPES,
} = require('../config/accounting');
const paymentRepository = require('../repositories/paymentRepository');
const releaseRepository = require('../repositories/releaseRepository');
const journalRepository = require('../repositories/journalRepository');

const SUCCEEDED_JOURNAL_TYPES = Object.freeze([
    'payout_succeeded',
    'payout_recovered_succeeded',
]);
const FAILED_JOURNAL_TYPES = Object.freeze([
    'payout_failed',
    'payout_recovered_failed',
]);
const TERMINAL_ATTEMPT_OUTCOMES = Object.freeze({
    succeeded: SUCCEEDED_JOURNAL_TYPES,
    failed: FAILED_JOURNAL_TYPES,
    unknown: Object.freeze(['payout_unknown']),
});
const OPEN_ATTEMPT_STATUSES = Object.freeze(['created', 'submitted']);
const PAYOUT_JOURNAL_TYPES = Object.freeze([
    'payout_initiation',
    ...SUCCEEDED_JOURNAL_TYPES,
    ...FAILED_JOURNAL_TYPES,
    'payout_unknown',
]);
const LEGACY_RELEASE_ATTEMPT_STATUS = Object.freeze({
    succeeded: 'succeeded',
    failed: 'failed',
    needs_review: 'unknown',
    in_flight: 'submitted',
});
const LEGACY_RELEASE_INCONSISTENT_STATUSES = Object.freeze([
    'requested',
    'cancelled',
]);

const discrepancy = (code, entityType, entityId, message, extra) => ({
    code,
    entityType,
    entityId,
    message,
    ...(extra === undefined ? {} : extra),
});

const toRows = (snapshot) => {
    const rows = [];
    if (!snapshot || Array.isArray(snapshot)) {
        (snapshot || []).forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
        return rows;
    }
    if (Array.isArray(snapshot.docs)) {
        snapshot.docs.forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
    }
    return rows;
};

const journalAttemptOf = (journal) =>
    Number.isSafeInteger(journal.attemptNumber) ? journal.attemptNumber : 1;

const safeId = (value) => (typeof value === 'string' && value.trim() ? value : null);

/**
 * Audits the whole ledger and what the authoritative payment/release records
 * justify. Returns `{ ok, checkedAt, counts, totals, accountBalances,
 * discrepancies }`; `discrepancies` entries are `{ code, entityType,
 * entityId, message, ... }`.
 */
const auditAccounting = async () => {
    const journals = toRows(await journalRepository.listAllJournals());
    const entries = toRows(await journalRepository.listAllEntries());
    const payments = toRows(await paymentRepository.listAllPayments());
    const releases = toRows(await releaseRepository.listAllReleases());

    const discrepancies = [];
    const journalById = new Map(
        journals.map((journal) => [journal.journalId, journal])
    );
    const journalIds = new Set(journalById.keys());
    const paymentIds = new Set(payments.map((payment) => payment.id));
    const releaseById = new Map(releases.map((release) => [release.id, release]));

    // --- Ledger integrity ---------------------------------------------------
    const entriesByJournal = new Map();
    for (const entry of entries) {
        if (!entriesByJournal.has(entry.journalId)) {
            entriesByJournal.set(entry.journalId, []);
        }
        entriesByJournal.get(entry.journalId).push(entry);
    }

    let attemptCount = 0;
    const attemptsByRelease = new Map();
    for (const release of releases) {
        const attempts = toRows(
            await releaseRepository.listAttemptsByReleaseId(release.id)
        ).sort((a, b) => (a.attemptNumber || 0) - (b.attemptNumber || 0));
        attemptsByRelease.set(release.id, attempts);
        attemptCount += attempts.length;
    }

    let totalDebitMinor = 0;
    let totalCreditMinor = 0;
    const accountBalances = Object.fromEntries(
        LEDGER_ACCOUNT_TYPES.map((account) => [account, 0])
    );

    for (const journal of journals) {
        const lines = entriesByJournal.get(journal.journalId) || [];
        if (lines.length !== journal.lineCount) {
            discrepancies.push(
                discrepancy(
                    'JOURNAL_LINE_COUNT_MISMATCH',
                    'journal',
                    journal.journalId,
                    `journal declares ${journal.lineCount} lines but ${lines.length} entries reference it`
                )
            );
        }
        if (journal.totalDebitMinor !== journal.totalCreditMinor) {
            discrepancies.push(
                discrepancy(
                    'JOURNAL_UNBALANCED',
                    'journal',
                    journal.journalId,
                    `debits ${journal.totalDebitMinor} != credits ${journal.totalCreditMinor}`
                )
            );
        }
        const declaredDebit = lines
            .filter((line) => line.direction === 'debit')
            .reduce((sum, line) => sum + line.amountMinor, 0);
        const declaredCredit = lines
            .filter((line) => line.direction === 'credit')
            .reduce((sum, line) => sum + line.amountMinor, 0);
        if (
            journal.totalDebitMinor !== declaredDebit
            || journal.totalCreditMinor !== declaredCredit
        ) {
            discrepancies.push(
                discrepancy(
                    'JOURNAL_TOTAL_MISMATCH',
                    'journal',
                    journal.journalId,
                    `stored totals (${journal.totalDebitMinor}/${journal.totalCreditMinor}) do not match its lines (${declaredDebit}/${declaredCredit})`
                )
            );
        }
        if (journal.currency !== ACCOUNTING_CURRENCY) {
            discrepancies.push(
                discrepancy(
                    'JOURNAL_CURRENCY_INVALID',
                    'journal',
                    journal.journalId,
                    `journal currency ${journal.currency} is not ${ACCOUNTING_CURRENCY}`
                )
            );
        }
        if (!JOURNAL_TYPES.includes(journal.journalType)) {
            discrepancies.push(
                discrepancy(
                    'JOURNAL_TYPE_UNKNOWN',
                    'journal',
                    journal.journalId,
                    `unknown journal type ${journal.journalType}`
                )
            );
        }
        totalDebitMinor += journal.totalDebitMinor;
        totalCreditMinor += journal.totalCreditMinor;

        for (const line of lines) {
            if (!LEDGER_ACCOUNT_TYPES.includes(line.account)) {
                discrepancies.push(
                    discrepancy(
                        'LINE_ACCOUNT_UNKNOWN',
                        'ledgerEntry',
                        line.entryId,
                        `unknown account ${line.account}`
                    )
                );
                continue;
            }
            accountBalances[line.account] += line.direction === 'debit'
                ? line.amountMinor
                : -line.amountMinor;
        }
    }

    for (const entry of entries) {
        if (!journalIds.has(entry.journalId)) {
            discrepancies.push(
                discrepancy(
                    'ORPHAN_LEDGER_ENTRY',
                    'ledgerEntry',
                    entry.entryId,
                    `references journal ${entry.journalId} which does not exist`
                )
            );
        }
    }

    if (totalDebitMinor !== totalCreditMinor) {
        discrepancies.push(
            discrepancy(
                'LEDGER_UNBALANCED_TOTALS',
                'ledger',
                'global',
                `total debits ${totalDebitMinor} != total credits ${totalCreditMinor}`
            )
        );
    }

    // --- Compensating journals ---------------------------------------------
    const compensationMismatch = (compensation, target) => {
        if (compensation.sourceId !== target.journalId) {
            return `sourceId ${compensation.sourceId} does not name its target`;
        }
        if (compensation.currency !== target.currency) {
            return `currency ${compensation.currency} != ${target.currency}`;
        }
        if (journalAttemptOf(compensation) !== journalAttemptOf(target)) {
            return `attempt ${journalAttemptOf(compensation)} != ${journalAttemptOf(target)}`;
        }
        if (compensation.releaseId !== target.releaseId) {
            return 'releaseId does not match its target';
        }
        if (compensation.paymentId !== target.paymentId) {
            return 'paymentId does not match its target';
        }
        if (compensation.lineCount !== target.lineCount) {
            return `lineCount ${compensation.lineCount} != ${target.lineCount}`;
        }
        if (
            compensation.totalDebitMinor !== target.totalCreditMinor
            || compensation.totalCreditMinor !== target.totalDebitMinor
        ) {
            return 'totals are not the reverse of its target';
        }

        const targetLines = entriesByJournal.get(target.journalId) || [];
        const compensationLines =
            entriesByJournal.get(compensation.journalId) || [];
        if (compensationLines.length !== targetLines.length) {
            return 'stored lines are not the reverse of its target';
        }
        const byLineNumber = new Map(
            targetLines.map((line) => [line.lineNumber, line])
        );
        for (const line of compensationLines) {
            const original = byLineNumber.get(line.lineNumber);
            if (!original) {
                return `line ${line.lineNumber} has no counterpart in its target`;
            }
            if (line.account !== original.account) {
                return `line ${line.lineNumber} account is not the target account`;
            }
            if (line.amountMinor !== original.amountMinor) {
                return `line ${line.lineNumber} amount is not the target amount`;
            }
            if (line.direction === original.direction) {
                return `line ${line.lineNumber} direction is not reversed`;
            }
            if (line.currency !== original.currency) {
                return `line ${line.lineNumber} currency is not the target currency`;
            }
        }
        return null;
    };

    const compensations = journals.filter(
        (journal) => journal.journalType === 'compensating'
    );
    const validCompensations = [];
    for (const compensation of compensations) {
        const targetId = safeId(compensation.compensatesJournalId);
        const target = targetId ? journalById.get(targetId) : null;
        if (!target) {
            discrepancies.push(
                discrepancy(
                    'COMPENSATION_TARGET_MISSING',
                    'journal',
                    compensation.journalId,
                    `compensates journal ${compensation.compensatesJournalId} which does not exist`
                )
            );
            continue;
        }
        const mismatch = compensationMismatch(compensation, target);
        if (mismatch) {
            discrepancies.push(
                discrepancy(
                    'COMPENSATION_MISMATCH',
                    'journal',
                    compensation.journalId,
                    `is not a structural reversal of ${target.journalId}: ${mismatch}`,
                    { targetJournalId: target.journalId }
                )
            );
            continue;
        }
        validCompensations.push(compensation);
    }

    const reversedJournalIds = new Set(
        validCompensations.map((compensation) =>
            compensation.compensatesJournalId
        )
    );
    const effectiveByTarget = new Map();
    for (const compensation of validCompensations) {
        if (reversedJournalIds.has(compensation.journalId)) {
            continue;
        }
        const targetId = compensation.compensatesJournalId;
        if (!effectiveByTarget.has(targetId)) {
            effectiveByTarget.set(targetId, []);
        }
        effectiveByTarget.get(targetId).push(compensation);
    }
    const compensatedIds = new Set();
    for (const [targetId, comps] of effectiveByTarget) {
        if (comps.length > 1) {
            for (const duplicate of comps.slice(1)) {
                discrepancies.push(
                    discrepancy(
                        'COMPENSATION_DUPLICATED',
                        'journal',
                        duplicate.journalId,
                        `journal ${targetId} is already reversed by ${comps[0].journalId}; duplicate reversals are not counted as compensation`
                    )
                );
            }
            continue;
        }
        compensatedIds.add(targetId);
    }

    // --- Ownership ----------------------------------------------------------
    for (const journal of journals) {
        if (journal.journalType === 'collection') {
            const paymentId = safeId(journal.paymentId);
            if (
                !paymentId
                || !paymentIds.has(paymentId)
                || journal.sourceId !== paymentId
            ) {
                discrepancies.push(
                    discrepancy(
                        'ORPHAN_JOURNAL',
                        'journal',
                        journal.journalId,
                        `collection journal does not name an existing payment (paymentId ${journal.paymentId}, sourceId ${journal.sourceId})`,
                        { journalType: journal.journalType }
                    )
                );
            }
            continue;
        }

        if (PAYOUT_JOURNAL_TYPES.includes(journal.journalType)) {
            const releaseId = safeId(journal.releaseId);
            const release = releaseId ? releaseById.get(releaseId) : null;
            if (!release || journal.sourceId !== releaseId) {
                discrepancies.push(
                    discrepancy(
                        'ORPHAN_JOURNAL',
                        'journal',
                        journal.journalId,
                        `payout journal does not name an existing release (releaseId ${journal.releaseId}, sourceId ${journal.sourceId})`,
                        { journalType: journal.journalType }
                    )
                );
                continue;
            }

            const attemptNumber = journalAttemptOf(journal);
            const attempts = attemptsByRelease.get(release.id) || [];
            let attemptKnown;
            if (attempts.length > 0) {
                attemptKnown = attempts.some(
                    (attempt) =>
                        (Number.isSafeInteger(attempt.attemptNumber)
                            ? attempt.attemptNumber
                            : 1) === attemptNumber
                );
            } else {
                const claimedNumbers = [
                    release.attemptCount,
                    release.currentAttemptNumber,
                ].filter(
                    (value) => Number.isSafeInteger(value) && value > 0
                );
                attemptKnown =
                    claimedNumbers.length > 0
                    && attemptNumber <= Math.max(...claimedNumbers);
            }
            if (!attemptKnown) {
                discrepancies.push(
                    discrepancy(
                        'JOURNAL_ATTEMPT_REFERENCE_MISSING',
                        'journal',
                        journal.journalId,
                        `journal references attempt ${attemptNumber} of release ${release.id}, which that release does not claim`,
                        {
                            journalType: journal.journalType,
                            attemptNumber,
                        }
                    )
                );
            }
        }
    }

    // --- Collections --------------------------------------------------------
    for (const payment of payments) {
        const collectionJournals = journals.filter(
            (journal) =>
                journal.paymentId === payment.id
                && journal.journalType === 'collection'
        );
        const uncompensated = collectionJournals.filter(
            (journal) => !compensatedIds.has(journal.journalId)
        );

        if (payment.status === 'paid') {
            if (uncompensated.length !== 1) {
                discrepancies.push(
                    discrepancy(
                        'COLLECTION_MISSING_OR_DUPLICATED',
                        'payment',
                        payment.id,
                        `expected exactly one uncompensated collection journal, found ${uncompensated.length}`,
                        { status: payment.status }
                    )
                );
            } else {
                const posted = uncompensated[0];
                if (posted.totalDebitMinor !== payment.amountMinor) {
                    discrepancies.push(
                        discrepancy(
                            'COLLECTION_AMOUNT_MISMATCH',
                            'payment',
                            payment.id,
                            `collection total ${posted.totalDebitMinor} != payment amountMinor ${payment.amountMinor}`
                        )
                    );
                }
                if (posted.currency !== payment.currency) {
                    discrepancies.push(
                        discrepancy(
                            'COLLECTION_CURRENCY_MISMATCH',
                            'payment',
                            payment.id,
                            `collection currency ${posted.currency} != payment currency ${payment.currency}`
                        )
                    );
                }
            }
        } else if (uncompensated.length > 0) {
            discrepancies.push(
                discrepancy(
                    'COLLECTION_WITHOUT_PAID_PAYMENT',
                    'payment',
                    payment.id,
                    `found ${uncompensated.length} uncompensated collection journals for a payment whose status is ${payment.status}`,
                    { status: payment.status }
                )
            );
        }
    }

    // --- Releases and attempts ---------------------------------------------
    const paymentById = new Map(payments.map((p) => [p.id, p]));

    const claimedAttemptNumbers = (release) =>
        [release.attemptCount, release.currentAttemptNumber].filter(
            (value) => Number.isSafeInteger(value) && value > 0
        );

    for (const release of releases) {
        const attempts = attemptsByRelease.get(release.id) || [];
        const attemptViews = attempts.map((attempt) => ({
            ...attempt,
            legacy: false,
        }));

        if (attempts.length === 0) {
            const claimedNumbers = claimedAttemptNumbers(release);
            if (claimedNumbers.length > 0) {
                if (
                    LEGACY_RELEASE_INCONSISTENT_STATUSES.includes(
                        release.status
                    )
                ) {
                    discrepancies.push(
                        discrepancy(
                            'LEGACY_RELEASE_STATE_INCONSISTENT',
                            'release',
                            release.id,
                            `release claims ${Math.max(...claimedNumbers)} attempt(s) but is still ${release.status}`,
                            { status: release.status }
                        )
                    );
                } else {
                    const legacyNumber =
                        Number.isSafeInteger(release.currentAttemptNumber)
                        && release.currentAttemptNumber > 0
                            ? release.currentAttemptNumber
                            : Math.max(...claimedNumbers);
                    const status =
                        LEGACY_RELEASE_ATTEMPT_STATUS[release.status];
                    if (status) {
                        attemptViews.push({
                            id: `${release.id}__legacy_attempt_${legacyNumber}`,
                            releaseId: release.id,
                            attemptNumber: legacyNumber,
                            status,
                            amountMinor: release.amountMinor,
                            currency: release.currency,
                            legacy: true,
                        });
                    } else {
                        discrepancies.push(
                            discrepancy(
                                'LEGACY_RELEASE_STATE_INCONSISTENT',
                                'release',
                                release.id,
                                `release claims ${Math.max(...claimedNumbers)} attempt(s) but has status ${release.status}`,
                                { status: release.status }
                            )
                        );
                    }
                }
            }
        }

        const releaseJournals = journals.filter(
            (journal) =>
                journal.releaseId === release.id
                && !compensatedIds.has(journal.journalId)
        );
        const acrossRelease = (journalTypes) =>
            releaseJournals.filter((journal) =>
                journalTypes.includes(journal.journalType)
            ).length;

        const payment = paymentById.get(release.paymentId);
        if (payment) {
            const expectedReleaseMinor =
                payment.netPayableMinor !== undefined
                    ? paymentCommissionSplit(payment).netPayableMinor
                    : payment.amountMinor;
            if (expectedReleaseMinor !== release.amountMinor) {
                discrepancies.push(
                    discrepancy(
                        'RELEASE_AMOUNT_MISMATCH',
                        'release',
                        release.id,
                        `release amountMinor ${release.amountMinor} != payment payable amount ${expectedReleaseMinor}`
                    )
                );
            }
        }

        for (const attempt of attemptViews) {
            const attemptNumber = Number.isSafeInteger(attempt.attemptNumber)
                ? attempt.attemptNumber
                : 1;
            const attemptExtra = (extra) => ({
                attemptNumber,
                ...(attempt.legacy ? { legacy: true } : {}),
                ...(extra || {}),
            });
            const forAttempt = releaseJournals.filter(
                (journal) => journalAttemptOf(journal) === attemptNumber
            );

            const initiations = forAttempt.filter(
                (journal) => journal.journalType === 'payout_initiation'
            );
            if (initiations.length !== 1) {
                discrepancies.push(
                    discrepancy(
                        'ATTEMPT_INITIATION_COUNT',
                        'releaseAttempt',
                        attempt.id,
                        `expected exactly one uncompensated initiation journal, found ${initiations.length}`,
                        attemptExtra()
                    )
                );
            }

            const count = (types) =>
                forAttempt.filter((journal) =>
                    types.includes(journal.journalType)
                ).length;
            const unknownCount = count(TERMINAL_ATTEMPT_OUTCOMES.unknown);
            const successPlain = count(['payout_succeeded']);
            const successRecovered = count(['payout_recovered_succeeded']);
            const failedPlain = count(['payout_failed']);
            const failedRecovered = count(['payout_recovered_failed']);
            const successTotal = successPlain + successRecovered;
            const failedTotal = failedPlain + failedRecovered;

            const reportKindMismatch = (message, extra) =>
                discrepancies.push(
                    discrepancy(
                        'ATTEMPT_OUTCOME_KIND_MISMATCH',
                        'releaseAttempt',
                        attempt.id,
                        message,
                        attemptExtra(extra)
                    )
                );

            const outcomeForStatus = TERMINAL_ATTEMPT_OUTCOMES[attempt.status];
            if (attempt.status === 'succeeded') {
                if (successTotal !== 1) {
                    discrepancies.push(
                        discrepancy(
                            'ATTEMPT_OUTCOME_COUNT',
                            'releaseAttempt',
                            attempt.id,
                            `attempt is succeeded and expects exactly one uncompensated success journal, found ${successTotal}`,
                            attemptExtra()
                        )
                    );
                }
                if (failedTotal > 0) {
                    reportKindMismatch(
                        `attempt is succeeded but carries ${failedTotal} uncompensated failure journals`
                    );
                }
                // A posted unknown suspense journal is only clean when the
                // recovered success bookends it; a dangling suspense entry on
                // a terminal attempt means unresolved funds were never moved.
                if (unknownCount === 1 && successRecovered !== 1) {
                    reportKindMismatch(
                        'a succeeded attempt still carries an unrecovered unknown suspense journal'
                    );
                }
                if (unknownCount > 1) {
                    reportKindMismatch(
                        `attempt carries ${unknownCount} unknown suspense journals`
                    );
                }
            } else if (attempt.status === 'failed') {
                if (failedTotal !== 1) {
                    discrepancies.push(
                        discrepancy(
                            'ATTEMPT_OUTCOME_COUNT',
                            'releaseAttempt',
                            attempt.id,
                            `attempt is failed and expects exactly one uncompensated failure journal, found ${failedTotal}`,
                            attemptExtra()
                        )
                    );
                }
                if (successTotal > 0) {
                    reportKindMismatch(
                        `attempt is failed but carries ${successTotal} uncompensated success journals`
                    );
                }
                if (unknownCount === 1 && failedRecovered !== 1) {
                    reportKindMismatch(
                        'a failed attempt still carries an unrecovered unknown suspense journal'
                    );
                }
                if (unknownCount > 1) {
                    reportKindMismatch(
                        `attempt carries ${unknownCount} unknown suspense journals`
                    );
                }
            } else if (attempt.status === 'unknown') {
                if (unknownCount !== 1) {
                    discrepancies.push(
                        discrepancy(
                            'ATTEMPT_OUTCOME_COUNT',
                            'releaseAttempt',
                            attempt.id,
                            `attempt is unknown and expects exactly one uncompensated unknown journal, found ${unknownCount}`,
                            attemptExtra()
                        )
                    );
                }
                if (successTotal > 0 || failedTotal > 0) {
                    reportKindMismatch(
                        'an unresolved attempt carries a terminal outcome journal'
                    );
                }
            } else if (OPEN_ATTEMPT_STATUSES.includes(attempt.status)) {
                const outcomes = unknownCount + successTotal + failedTotal;
                if (outcomes > 0) {
                    discrepancies.push(
                        discrepancy(
                            'ATTEMPT_UNEXPECTED_OUTCOME',
                            'releaseAttempt',
                            attempt.id,
                            `attempt is still ${attempt.status} but carries ${outcomes} uncompensated outcome journals`,
                            attemptExtra()
                        )
                    );
                }
            }
        }

        const successCount = acrossRelease(SUCCEEDED_JOURNAL_TYPES);
        if (release.status === 'succeeded' && successCount !== 1) {
            discrepancies.push(
                discrepancy(
                    'RELEASE_SUCCESS_COUNT',
                    'release',
                    release.id,
                    `release is succeeded and expects exactly one uncompensated success journal across its attempts, found ${successCount}`
                )
            );
        }
        if (
            (release.status === 'failed' || release.status === 'needs_review')
            && successCount > 0
        ) {
            discrepancies.push(
                discrepancy(
                    'RELEASE_SUCCESS_WITHOUT_TERMINAL_SUCCESS',
                    'release',
                    release.id,
                    `release is ${release.status} but carries ${successCount} uncompensated success journals`
                )
            );
        }
    }

    return {
        ok: discrepancies.length === 0,
        checkedAt: clock.now(),
        counts: {
            journals: journals.length,
            entries: entries.length,
            payments: payments.length,
            releases: releases.length,
            attempts: attemptCount,
        },
        totals: {
            debitMinor: totalDebitMinor,
            creditMinor: totalCreditMinor,
        },
        accountBalances,
        discrepancies,
    };
};

module.exports = {
    auditAccounting,
    SUCCEEDED_JOURNAL_TYPES,
    FAILED_JOURNAL_TYPES,
};
