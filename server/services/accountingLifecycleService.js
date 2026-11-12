'use strict';

// accountingLifecycleService.js
//
// Connects the balanced-journal foundation (accountingService.js) to the
// authoritative payment and release lifecycle without changing either domain.
//
// The integration is deliberately POST-COMMIT. A payment or release transition
// is committed by its own transaction first; only then does this service post
// the corresponding journal. That keeps the financial record downstream of the
// authoritative event and avoids pretending that a Firestore domain transaction
// and a journal transaction are one atomic write.
//
// Every posting is idempotent (deterministic journal ids + create-only
// persistence), so the recovery strategy is simply to replay the ensure/post
// call for the same id. The service returns a structured result instead of
// throwing: a lifecycle transition that already committed must never be
// reported as failed because a later accounting write was unavailable. Callers
// can surface the result, and reconciliation/repair can retry it later.
//
// SEQUENCING IS ENFORCED BY accountingService:
//   collection -> initiation -> succeeded / failed / unknown
// If a predecessor is missing, the post is refused and reported here. It is not
// forced into an unbalanced or negative-balance story.
//
// RETRY ACCOUNTING (Stage 2G). Journal identity is attempt-scoped
// (config/accounting.js journalKey): the first attempt keeps the legacy
// release-scoped ids, and a later attempt appends `:attempt_<n>`. Posting the
// initiation for attempt n first repairs every prior attempt -- an idempotent
// ensure of that attempt's initiation and terminal outcome journals -- and
// refuses when a prior attempt is unresolved, claims success, or has no attempt
// document. A prior attempt's failed journal is deliberately left
// uncompensated: it is the audit trail of the declined transfer, and the new
// attempt's own initiation simply moves the same payable liability again.
//
// BACKFILL. This service never enumerates history on its own. Recovery is on
// demand: replaying verification repairs a missing collection, and
// reconcileReleaseAccounting repairs a release's journals, both by
// deterministic id. Bulk enumeration lives only in accountingBackfillService,
// which pages through a document-id-ordered status query in bounded steps.

const releaseRepository = require('../repositories/releaseRepository');
const journalRepository = require('../repositories/journalRepository');
const { releaseAttemptId } = require('../config/release');
const accountingService = require('./accountingService');

const POSTING_FAILED = 'ACCOUNTING_LIFECYCLE_POSTING_FAILED';
const SUCCEEDED_JOURNAL_TYPES = Object.freeze([
    'payout_succeeded',
    'payout_recovered_succeeded',
]);

const toPlain = (snapshot) => {
    const rows = [];
    if (!snapshot) return rows;
    if (Array.isArray(snapshot)) {
        snapshot.forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
        return rows;
    }
    if (Array.isArray(snapshot.docs)) return toPlain(snapshot.docs);
    if (typeof snapshot.forEach === 'function') {
        snapshot.forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
    }
    return rows;
};

const resultOf = (result) => ({
    posted: Boolean(result && result.created),
    journalId: result && result.journalId,
    duplicate: Boolean(result && result.created === false),
});

const failureOf = (error) => ({
    posted: false,
    reason:
        (error && (error.code || error.name)) || POSTING_FAILED,
});

const attempt = async (operation) => {
    try {
        return resultOf(await operation());
    } catch (error) {
        return failureOf(error);
    }
};

/**
 * True when a journal from `journalIds` exists and has not been explicitly
 * reversed by an append-only compensating journal. An operator who reverses a
 * conflicting outcome may then post the corrected one; an unreversed conflict
 * is never flattened automatically.
 */
const hasUncompensatedJournal = async (releaseId, journalIds) => {
    const targets = new Set(journalIds);
    const journals = toPlain(
        await journalRepository.listJournalsByReleaseId(releaseId)
    );
    const compensated = new Set(
        journals
            .filter(
                (journal) =>
                    journal.journalType === 'compensating'
                    && typeof journal.compensatesJournalId === 'string'
            )
            .map((journal) => journal.compensatesJournalId)
    );
    return journals.some(
        (journal) =>
            targets.has(journal.journalId)
            && !compensated.has(journal.journalId)
    );
};

const compensatedIdsFrom = (journals) =>
    new Set(
        journals
            .filter(
                (journal) =>
                    journal.journalType === 'compensating'
                    && typeof journal.compensatesJournalId === 'string'
            )
            .map((journal) => journal.compensatesJournalId)
    );

/**
 * The attempt number a journal was posted for. Journals carry attemptNumber
 * since attempt scoping; older journals have none and are attempt 1, which is
 * also why first-attempt journal ids are unchanged (config/accounting.js).
 */
const journalAttemptOf = (journal) =>
    Number.isSafeInteger(journal.attemptNumber) ? journal.attemptNumber : 1;

/**
 * Same as hasUncompensatedJournal but matched by journal TYPE and attempt
 * number instead of a fixed id list. This is what detects a success already
 * posted for a DIFFERENT attempt of the same release.
 */
const hasUncompensatedJournalOfTypesForOtherAttempt = async (
    releaseId,
    journalTypes,
    attemptNumber
) => {
    const journals = toPlain(
        await journalRepository.listJournalsByReleaseId(releaseId)
    );
    const compensated = compensatedIdsFrom(journals);
    return journals.some(
        (journal) =>
            journalTypes.includes(journal.journalType)
            && !compensated.has(journal.journalId)
            && journalAttemptOf(journal) !== attemptNumber
    );
};

const loadRelease = async (releaseId) => {
    const snapshot = await releaseRepository.getReleaseById(releaseId);
    if (!snapshot || !snapshot.exists) {
        return null;
    }
    return { id: snapshot.id, ...snapshot.data() };
};

const currentAttemptFor = async (release) => {
    if (release.currentAttemptId) {
        const direct = await releaseRepository.getAttemptById(
            release.currentAttemptId
        );
        if (direct && direct.exists) {
            return { id: direct.id, ...direct.data() };
        }
    }

    const attempts = toPlain(
        await releaseRepository.listAttemptsByReleaseId(release.id)
    ).sort((a, b) => (a.attemptNumber || 0) - (b.attemptNumber || 0));
    if (attempts.length === 0) {
        return null;
    }

    const expectedNumber = Number.isSafeInteger(release.currentAttemptNumber)
        ? release.currentAttemptNumber
        : release.attemptCount;
    if (Number.isSafeInteger(expectedNumber)) {
        const byNumber = attempts.find(
            (attempt) => attempt.attemptNumber === expectedNumber
        );
        if (byNumber) return byNumber;
    }

    return attempts[attempts.length - 1];
};

/**
 * Posts the collection journal for a payment that an authoritative verification
 * has already committed as paid. Safe to call for any payment: a non-paid record
 * is reported, not posted.
 */
const ensureCollectionForPayment = async (paymentId) =>
    attempt(() => accountingService.recordVerifiedCollection({ paymentId }));

/**
 * Makes every prior attempt's accounting complete before a later attempt may
 * post its initiation. A prior attempt that is not DEFINITIVELY failed (still
 * created/submitted, claiming success, sitting unknown, or without an attempt
 * document) is a refusal, not a guess: an unknown outcome means the funds may
 * still be with the provider, so the same amount must not be moved again until
 * the unresolved attempt has been explicitly resolved and its failure posted.
 * For a definitively failed prior attempt the initiation and failed journals
 * are ensured idempotently. That failed journal is deliberately left
 * uncompensated -- it is the audit trail of the declined transfer, and the new
 * attempt's initiation moves the same liability again.
 */
const ensurePriorAttemptAccounting = async (releaseId, currentAttemptNumber) => {
    for (let n = 1; n < currentAttemptNumber; n += 1) {
        const snapshot = await releaseRepository.getAttemptById(
            releaseAttemptId(releaseId, n)
        );
        if (!snapshot || !snapshot.exists) {
            return {
                ok: false,
                reason: 'ACCOUNTING_PRIOR_ATTEMPT_MISSING',
                attemptNumber: n,
            };
        }
        const prior = { id: snapshot.id, ...snapshot.data() };

        if (
            prior.status === 'created'
            || prior.status === 'submitted'
            || prior.status === 'unknown'
        ) {
            return {
                ok: false,
                reason: 'ACCOUNTING_PRIOR_ATTEMPT_UNRESOLVED',
                attemptNumber: n,
            };
        }
        if (prior.status === 'succeeded') {
            return {
                ok: false,
                reason: 'ACCOUNTING_PRIOR_ATTEMPT_SUCCEEDED',
                attemptNumber: n,
            };
        }

        const initiation = await attempt(() =>
            accountingService.recordPayoutInitiation({
                releaseId,
                attemptNumber: n,
            })
        );
        if (!initiation.posted && !initiation.duplicate) {
            return { ok: false, reason: initiation.reason, attemptNumber: n };
        }

        const outcome = await attempt(() =>
            accountingService.recordPayoutFailed({
                releaseId,
                attemptNumber: n,
            })
        );
        if (!outcome.posted && !outcome.duplicate) {
            return { ok: false, reason: outcome.reason, attemptNumber: n };
        }
    }
    return { ok: true };
};

/**
 * Posts the payout-initiation journal after a submission claim has been
 * committed. `attemptNumber` is the claim that was actually acquired; for a
 * retry attempt every prior attempt is repaired first, so the retries neither
 * double count the obligation nor post onto a state a prior attempt still
 * holds open.
 */
const ensurePayoutInitiation = async ({ releaseId, attemptNumber } = {}) => {
    if (Number.isSafeInteger(attemptNumber) && attemptNumber > 1) {
        const prior = await ensurePriorAttemptAccounting(
            releaseId,
            attemptNumber
        );
        if (!prior.ok) {
            return {
                posted: false,
                reason: prior.reason,
                ...(prior.attemptNumber !== undefined
                    ? { attemptNumber: prior.attemptNumber }
                    : {}),
            };
        }
    }

    return attempt(() =>
        accountingService.recordPayoutInitiation({ releaseId, attemptNumber })
    );
};

/**
 * Posts the journal justified by the release's committed terminal (or
 * unresolved) state. The predecessor initiation journal is ensured first, so a
 * crash between the claim and the initiation post is repaired by replaying this
 * call.
 *
 * Conflicting histories are never flattened automatically. Guards are
 * attempt-scoped: an uncompensated failure for the SAME attempt blocks a
 * success (and vice versa), and an uncompensated success posted for ANY
 * attempt blocks a later outcome. A prior attempt's failure journal does not
 * block a retry -- it is that attempt's own history.
 */
const recordReleaseOutcome = async ({ releaseId, release, attempt: suppliedAttempt } = {}) => {
    const currentRelease = release || (await loadRelease(releaseId));
    if (!currentRelease) {
        return { posted: false, reason: 'ACCOUNTING_RELEASE_NOT_FOUND' };
    }

    const currentAttempt =
        suppliedAttempt || (await currentAttemptFor(currentRelease));
    if (!currentAttempt) {
        return { posted: false, reason: 'ACCOUNTING_RELEASE_NOT_INITIATED' };
    }

    const attemptNumber = Number.isSafeInteger(currentAttempt.attemptNumber)
        ? currentAttempt.attemptNumber
        : 1;

    const initiation = await ensurePayoutInitiation({
        releaseId: currentRelease.id,
        attemptNumber,
    });

    let target = null;
    if (currentRelease.status === 'succeeded') {
        target = 'succeeded';
    } else if (currentRelease.status === 'failed') {
        target = 'failed';
    } else if (currentRelease.status === 'needs_review') {
        // A needs_review release whose attempt is already terminal is a
        // conflicting history (for example late success after a failure). It
        // needs an explicit correction, not a second automatic posting.
        if (
            currentAttempt.status !== 'succeeded'
            && currentAttempt.status !== 'failed'
        ) {
            target = 'unknown';
        }
    }

    if (!target) {
        return {
            posted: false,
            reason: 'NO_ACCOUNTING_TRANSITION',
            initiation,
        };
    }

    const sameAttemptFailedPosted = () =>
        hasUncompensatedJournal(currentRelease.id, [
            accountingService.failedJournalIdFor(
                currentRelease.id,
                false,
                attemptNumber
            ),
            accountingService.failedJournalIdFor(
                currentRelease.id,
                true,
                attemptNumber
            ),
        ]);
    const sameAttemptSucceededPosted = () =>
        hasUncompensatedJournal(currentRelease.id, [
            accountingService.succeededJournalIdFor(
                currentRelease.id,
                false,
                attemptNumber
            ),
            accountingService.succeededJournalIdFor(
                currentRelease.id,
                true,
                attemptNumber
            ),
        ]);
    const otherAttemptSucceeded = () =>
        hasUncompensatedJournalOfTypesForOtherAttempt(
            currentRelease.id,
            SUCCEEDED_JOURNAL_TYPES,
            attemptNumber
        );

    if (target === 'succeeded') {
        if (
            (await sameAttemptFailedPosted())
            || (await otherAttemptSucceeded())
        ) {
            return {
                posted: false,
                reason: 'CONFLICTING_FAILED_JOURNAL',
                initiation,
            };
        }
        return {
            initiation,
            outcome: await attempt(() =>
                accountingService.recordPayoutSucceeded({
                    releaseId: currentRelease.id,
                    attemptNumber,
                })
            ),
        };
    }

    if (target === 'failed') {
        if (
            (await sameAttemptSucceededPosted())
            || (await otherAttemptSucceeded())
        ) {
            return {
                posted: false,
                reason: 'CONFLICTING_SUCCEEDED_JOURNAL',
                initiation,
            };
        }
        return {
            initiation,
            outcome: await attempt(() =>
                accountingService.recordPayoutFailed({
                    releaseId: currentRelease.id,
                    attemptNumber,
                })
            ),
        };
    }

    if (
        (await sameAttemptSucceededPosted())
        || (await sameAttemptFailedPosted())
        || (await otherAttemptSucceeded())
    ) {
        return {
            posted: false,
            reason: 'CONFLICTING_OUTCOME_JOURNAL',
            initiation,
        };
    }

    return {
        initiation,
        outcome: await attempt(() =>
            accountingService.recordPayoutUnknown({
                releaseId: currentRelease.id,
                attemptNumber,
            })
        ),
    };
};

/**
 * Durable repair entry point. Replays every post the committed release state
 * justifies. It is safe to call repeatedly and is intended for reconciliation
 * workers or a trusted internal repair command.
 */
const reconcileReleaseAccounting = async (releaseId) => {
    const release = await loadRelease(releaseId);
    if (!release) {
        return { releaseId, posted: false, reason: 'ACCOUNTING_RELEASE_NOT_FOUND' };
    }
    return {
        releaseId,
        ...(await recordReleaseOutcome({ releaseId, release })),
    };
};

module.exports = {
    ensureCollectionForPayment,
    ensurePayoutInitiation,
    recordReleaseOutcome,
    reconcileReleaseAccounting,
};
