'use strict';

// releaseReconciliationService.js
//
// STAGE 2C. Operational reconciliation for release requests and attempts.
//
// The service never submits a release. It only:
//   * finds stale/stranded local records for investigation;
//   * asks an injected provider for an authoritative outcome when that provider
//     explicitly supports lookup;
//   * applies a validated provider outcome through the release state machine;
//   * leaves missing/conflicting evidence in `needs_review`;
//   * offers a trusted admin boundary for explicit resolution and retry
//     authorization;
//   * after a decision commits, ensures the matching accounting journal through
//     the idempotent accountingLifecycleService.
//
// The unavoidable crash windows remain:
//   * after the Stage 2B claim commits and before the provider call;
//   * after the provider responds and before the outcome commits.
// Reconciliation can discover those records, but it cannot prove that an
// unreachable provider call did not happen. A missing result is therefore never
// converted into failure, and a claimed attempt is never submitted again.

const clock = require('../config/clock');
const {
    isValidDocumentId,
    releaseEventId,
    reconciliationStaleAfterMs,
    reconciliationBatchSize,
} = require('../config/release');
const releaseRepository = require('../repositories/releaseRepository');
const releaseEventRepository = require('../repositories/releaseEventRepository');
const releaseState = require('./releaseState');
const releaseOrchestrationService = require('./releaseOrchestrationService');
const accountingLifecycleService = require('./accountingLifecycleService');
const {
    supportsOutcomeLookup,
    normalizeProviderLookupOutcome,
} = require('./releaseProvider');

class ReleaseReconciliationError extends Error {
    constructor(message, code = 'RELEASE_RECONCILIATION_INVALID') {
        super(message);
        this.name = 'ReleaseReconciliationError';
        this.code = code;
    }
}

const fail = (message, code) => {
    throw new ReleaseReconciliationError(message, code);
};

const safeText = (value) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const RECONCILABLE_RELEASE_STATUSES = Object.freeze([
    'in_flight',
    'needs_review',
    'failed',
    'succeeded',
]);
const ACCOUNTING_ONLY_RELEASE_STATUSES = Object.freeze(['succeeded']);
const STALE_ATTEMPT_STATUSES = Object.freeze(['created', 'submitted']);
const UNCERTAIN_ATTEMPT_STATUSES = Object.freeze(['unknown']);
const RESOLUTION_OUTCOMES = Object.freeze(['succeeded', 'failed']);

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

const toMillis = (value) => {
    if (value === undefined || value === null) return null;
    if (value instanceof Date) {
        const ms = value.getTime();
        return Number.isFinite(ms) ? ms : null;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
    }
    if (typeof value === 'object') {
        if (Number.isFinite(value._seconds)) {
            return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
        }
        if (Number.isFinite(value.seconds)) {
            return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
        }
        if (typeof value.toDate === 'function') {
            return toMillis(value.toDate());
        }
    }
    return null;
};

const byAttemptNumber = (a, b) => (a.attemptNumber || 0) - (b.attemptNumber || 0);
const byUpdatedAt = (a, b) => {
    const left = toMillis(a.updatedAt) || 0;
    const right = toMillis(b.updatedAt) || 0;
    return left - right;
};

const normalizeLimit = (limit) => reconciliationBatchSize(limit);

const assertAdminActor = (actor) => {
    if (!actor || typeof actor !== 'object' || actor.admin !== true) {
        fail(
            'administrative reconciliation requires the admin === true custom claim',
            'RELEASE_RECONCILIATION_FORBIDDEN'
        );
    }
    const uid = safeText(actor.uid);
    if (!uid) {
        fail(
            'administrative reconciliation requires an authenticated actor uid',
            'RELEASE_RECONCILIATION_FORBIDDEN'
        );
    }
    return uid;
};

const normalizeAdminAction = (input = {}) => {
    const reason = safeText(input.reason);
    if (!reason) {
        fail(
            'administrative action requires a reason',
            'RELEASE_RECONCILIATION_INVALID'
        );
    }

    const evidence = input.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        fail(
            'administrative action requires structured evidence',
            'RELEASE_RECONCILIATION_INVALID'
        );
    }

    const source = safeText(evidence.source);
    const reference = safeText(evidence.reference);
    if (!source || !reference) {
        fail(
            'administrative action requires evidence.source and evidence.reference',
            'RELEASE_RECONCILIATION_INVALID'
        );
    }

    const note = safeText(evidence.note);
    return {
        reason,
        evidence: {
            source,
            reference,
            ...(note ? { note } : {}),
        },
    };
};

const loadRelease = async (releaseId) => {
    if (!isValidDocumentId(releaseId)) {
        fail('releaseId must be a valid document id', 'RELEASE_RECONCILIATION_INVALID');
    }
    const snapshot = await releaseRepository.getReleaseById(releaseId);
    if (!snapshot || !snapshot.exists) {
        fail(`release ${releaseId} was not found`, 'RELEASE_RECONCILIATION_NOT_FOUND');
    }
    const release = { id: snapshot.id, ...snapshot.data() };
    if (release.releaseId !== releaseId) {
        fail(
            'stored release identity is inconsistent',
            'RELEASE_RECONCILIATION_INVALID'
        );
    }
    return release;
};

const listAttempts = async (releaseId) =>
    toPlain(await releaseRepository.listAttemptsByReleaseId(releaseId)).sort(
        byAttemptNumber
    );

const currentAttemptFor = (release, attempts) => {
    if (release.currentAttemptId) {
        const byId = attempts.find((attempt) => attempt.id === release.currentAttemptId);
        if (byId) return byId;
    }

    const currentNumber = Number.isSafeInteger(release.currentAttemptNumber)
        ? release.currentAttemptNumber
        : release.attemptCount;
    if (Number.isSafeInteger(currentNumber) && currentNumber > 0) {
        const byNumber = attempts.find(
            (attempt) => attempt.attemptNumber === currentNumber
        );
        if (byNumber) return byNumber;
    }

    return attempts.length > 0 ? attempts[attempts.length - 1] : null;
};

const attemptActivityTimestamp = (attempt) => {
    if (attempt.status === 'created') {
        return (
            attempt.submissionClaimedAt
            || attempt.createdAt
            || attempt.updatedAt
        );
    }
    if (attempt.status === 'submitted') {
        return (
            attempt.updatedAt
            || attempt.submittedAt
            || attempt.submissionClaimedAt
            || attempt.createdAt
        );
    }
    return (
        attempt.updatedAt
        || attempt.completedAt
        || attempt.submissionClaimedAt
        || attempt.createdAt
    );
};

const releaseActivityTimestamp = (release, attempt) =>
    (attempt ? attemptActivityTimestamp(attempt) : null)
    || release.updatedAt
    || release.createdAt;

const staleInfo = (timestamp, staleAfterMs, nowMs) => {
    const timestampMs = toMillis(timestamp);
    const ageMs = timestampMs === null ? null : Math.max(0, nowMs - timestampMs);
    return {
        timestampMs,
        ageMs,
        staleAfterMs,
        stale: ageMs !== null && ageMs >= staleAfterMs,
    };
};

const withStaleness = (attempt, staleAfterMs, nowMs) => {
    const info = staleInfo(
        attemptActivityTimestamp(attempt),
        staleAfterMs,
        nowMs
    );
    return { ...attempt, ...info };
};

const listStrandedReleases = async (options = {}) => {
    const staleAfterMs = reconciliationStaleAfterMs(options.staleAfterMs);
    const nowMs = clock.nowMs();
    const releases = toPlain(
        await releaseRepository.listReleasesByStatus('in_flight')
    ).sort(byUpdatedAt);

    const stranded = [];
    for (const release of releases) {
        const attempts = await listAttempts(release.id);
        const attempt = currentAttemptFor(release, attempts);
        const info = staleInfo(
            releaseActivityTimestamp(release, attempt),
            staleAfterMs,
            nowMs
        );
        if (info.stale) {
            stranded.push({
                ...release,
                currentAttempt: attempt,
                ...info,
            });
        }
    }
    return stranded;
};

const listReviewReleases = async (limit) => {
    const releases = toPlain(
        await releaseRepository.listReleasesByStatus('needs_review')
    ).sort(byUpdatedAt);
    return releases.slice(0, normalizeLimit(limit));
};

/**
 * STAGE 2H.2. A succeeded release needs no provider investigation: its terminal
 * state is already authoritative. It only needs its idempotent accounting post
 * repaired when a crash left the success journal missing. This bounded list is
 * kept separate from the provider-reconciliation discovery lists so a terminal
 * release can never be re-submitted or have its outcome inferred from a lookup.
 */
const listSucceededReleasesForAccounting = async (limit) => {
    const releases = toPlain(
        await releaseRepository.listReleasesByStatus('succeeded')
    ).sort(byUpdatedAt);
    return releases.slice(0, normalizeLimit(limit));
};

const listSucceededReleasesAfterId = async (limit, afterId) => {
    const releases = toPlain(
        await releaseRepository.listReleasesByStatus('succeeded')
    )
        .filter(
            (release) =>
                typeof afterId !== 'string' || release.id > afterId
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return releases.slice(0, normalizeLimit(limit));
};

const listReleasesNeedingReview = async (actor, options = {}) => {
    assertAdminActor(actor);
    return listReviewReleases(options.limit);
};

const listStaleAttempts = async (actor, options = {}) => {
    assertAdminActor(actor);
    const statuses = options.statuses || STALE_ATTEMPT_STATUSES;
    const staleAfterMs = reconciliationStaleAfterMs(options.staleAfterMs);
    const nowMs = clock.nowMs();

    const snapshots = await Promise.all(
        statuses.map((status) => releaseRepository.listAttemptsByStatus(status))
    );
    const attempts = snapshots.flatMap(toPlain).map((attempt) =>
        withStaleness(attempt, staleAfterMs, nowMs)
    );

    return attempts
        .filter((attempt) => attempt.stale)
        .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0))
        .slice(0, normalizeLimit(options.limit));
};

const listUncertainAttempts = async (actor, options = {}) => {
    assertAdminActor(actor);
    const staleAfterMs = reconciliationStaleAfterMs(options.staleAfterMs);
    const nowMs = clock.nowMs();
    const snapshots = await Promise.all(
        UNCERTAIN_ATTEMPT_STATUSES.map((status) =>
            releaseRepository.listAttemptsByStatus(status)
        )
    );
    return snapshots
        .flatMap(toPlain)
        .map((attempt) => withStaleness(attempt, staleAfterMs, nowMs))
        .sort((a, b) => (b.ageMs || 0) - (a.ageMs || 0))
        .slice(0, normalizeLimit(options.limit));
};

const inspectRelease = async (actor, releaseId, options = {}) => {
    assertAdminActor(actor);
    const staleAfterMs = reconciliationStaleAfterMs(options.staleAfterMs);
    const nowMs = clock.nowMs();
    const release = await loadRelease(releaseId);
    const attempts = await listAttempts(releaseId);
    const currentAttempt = currentAttemptFor(release, attempts);
    const attemptsWithStaleness = attempts.map((attempt) =>
        withStaleness(attempt, staleAfterMs, nowMs)
    );
    const releaseStaleness = staleInfo(
        releaseActivityTimestamp(release, currentAttempt),
        staleAfterMs,
        nowMs
    );

    return {
        release,
        currentAttempt,
        attempts: attemptsWithStaleness,
        staleAttempts: attemptsWithStaleness.filter((attempt) => attempt.stale),
        releaseStaleness,
        stranded: release.status === 'in_flight' && releaseStaleness.stale,
        needsReview: release.status === 'needs_review',
    };
};

const providerIdentityFor = (release, attempt) => ({
    releaseId: release.id,
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    currency: release.currency,
    amountMinor: release.amountMinor,
});

const providerLookupInput = (release, attempt) => ({
    ...providerIdentityFor(release, attempt),
    idempotencyKey: attempt.id,
    providerReference: attempt.providerReference,
    transferReference: attempt.transferReference,
    targetType: release.targetType,
    targetId: release.targetId,
    paymentId: release.paymentId,
    contractId: release.contractId,
    employmentId: release.employmentId,
    employerId: release.employerId,
    employeeId: release.employeeId,
});

const classifyLookup = (raw, expected) => {
    if (raw === undefined || raw === null) {
        return { kind: 'unavailable', reason: 'lookup_result_missing' };
    }
    const normalized = normalizeProviderLookupOutcome(raw, expected);
    if (!normalized.ok) {
        return {
            kind: normalized.conflict ? 'conflict' : 'unavailable',
            reason: normalized.reason,
        };
    }
    return { kind: 'found', result: normalized.result };
};

const appendEvent = (eventId, data) =>
    releaseEventRepository.appendEventIfAbsent(eventId, data);

const nextAttemptForOutcome = (from, outcome) => {
    if (from === 'created' && outcome !== 'failed') {
        return releaseState.transitionAttempt(
            releaseState.transitionAttempt('created', 'submitted'),
            outcome
        );
    }
    return releaseState.transitionAttempt(from, outcome, {
        explicitResolution: from === 'unknown',
    });
};

const buildReconciliationEvents = (
    release,
    attempt,
    nextRelease,
    nextAttempt,
    lookup,
    conflictReason,
    occurredAt
) => {
    const identity = {
        releaseId: release.id,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
    };
    const events = [];

    if (lookup.kind === 'found') {
        events.push({
            id: releaseEventId(
                release.id,
                `reconciliation:${attempt.attemptNumber}:outcome_found:${lookup.result.outcome}`
            ),
            data: {
                ...identity,
                eventType: 'release_provider_outcome_found',
                outcome: lookup.result.outcome,
                ...(lookup.result.providerReference
                    ? { providerReference: lookup.result.providerReference }
                    : {}),
                ...(lookup.result.failureReason
                    ? { failureReason: lookup.result.failureReason }
                    : {}),
                ...(lookup.result.providerError
                    ? { providerError: lookup.result.providerError }
                    : {}),
                createdAt: occurredAt,
            },
        });
    } else if (lookup.kind === 'conflict') {
        events.push({
            id: releaseEventId(
                release.id,
                `reconciliation:${attempt.attemptNumber}:conflict:${lookup.reason}`
            ),
            data: {
                ...identity,
                eventType: 'release_reconciliation_conflict',
                reason: lookup.reason,
                createdAt: occurredAt,
            },
        });
    } else {
        events.push({
            id: releaseEventId(
                release.id,
                `reconciliation:${attempt.attemptNumber}:outcome_unavailable:${lookup.reason}`
            ),
            data: {
                ...identity,
                eventType: 'release_provider_outcome_unavailable',
                reason: lookup.reason,
                createdAt: occurredAt,
            },
        });
    }

    if (conflictReason && conflictReason !== lookup.reason) {
        events.push({
            id: releaseEventId(
                release.id,
                `reconciliation:${attempt.attemptNumber}:conflict:${conflictReason}`
            ),
            data: {
                ...identity,
                eventType: 'release_reconciliation_conflict',
                reason: conflictReason,
                createdAt: occurredAt,
            },
        });
    }

    if (nextAttempt !== attempt.status) {
        events.push({
            id: releaseEventId(
                release.id,
                `reconciliation:${attempt.attemptNumber}:attempt_state:${nextAttempt}`
            ),
            data: {
                ...identity,
                eventType: 'release_attempt_state_changed',
                fromStatus: attempt.status,
                toStatus: nextAttempt,
                ...(lookup.kind === 'found' ? { outcome: lookup.result.outcome } : {}),
                createdAt: occurredAt,
            },
        });
    }

    if (nextRelease !== release.status) {
        events.push({
            id: releaseEventId(
                release.id,
                `reconciliation:${attempt.attemptNumber}:release_state:${nextRelease}`
            ),
            data: {
                ...identity,
                eventType: 'release_state_changed',
                fromStatus: release.status,
                toStatus: nextRelease,
                ...(lookup.kind === 'found' ? { outcome: lookup.result.outcome } : {}),
                createdAt: occurredAt,
            },
        });
    }

    events.push({
        id: releaseEventId(
            release.id,
            `reconciliation:${attempt.attemptNumber}:completed:${nextRelease}:${lookup.kind}:${
                lookup.kind === 'found' ? lookup.result.outcome : lookup.reason
            }`
        ),
        data: {
            ...identity,
            eventType: 'release_reconciliation_completed',
            result: lookup.kind,
            ...(lookup.kind === 'found' ? { outcome: lookup.result.outcome } : {}),
            ...(lookup.kind !== 'found' ? { reason: lookup.reason } : {}),
            toStatus: nextRelease,
            createdAt: occurredAt,
        },
    });

    return events;
};

const decideReconciliation = (currentRelease, currentAttempt, lookup, context) => {
    if (!RECONCILABLE_RELEASE_STATUSES.includes(currentRelease.status)) {
        return { apply: false, reason: 'release-not-reconcilable' };
    }
    if (currentRelease.status !== context.release.status) {
        return { apply: false, reason: 'release-changed' };
    }
    if (currentAttempt.status !== context.attempt.status) {
        return { apply: false, reason: 'attempt-changed' };
    }

    const currentNumber = Number.isSafeInteger(currentRelease.currentAttemptNumber)
        ? currentRelease.currentAttemptNumber
        : currentRelease.attemptCount;
    if (currentNumber !== currentAttempt.attemptNumber) {
        return { apply: false, reason: 'attempt-superseded' };
    }

    let nextRelease = currentRelease.status;
    let nextAttempt = currentAttempt.status;
    let conflictReason = null;

    try {
        if (lookup.kind === 'found') {
            const outcome = lookup.result.outcome;

            if (currentAttempt.status === 'failed') {
                if (outcome === 'succeeded') {
                    conflictReason = 'late_success_after_failed_attempt';
                    nextRelease = currentRelease.status === 'needs_review'
                        ? 'needs_review'
                        : releaseState.transitionRelease(
                            currentRelease.status,
                            'needs_review'
                        );
                } else if (
                    outcome === 'failed'
                    && currentRelease.status === 'in_flight'
                ) {
                    nextRelease = 'failed';
                }
            } else if (currentAttempt.status === 'succeeded') {
                if (outcome === 'failed') {
                    conflictReason = 'late_failure_after_succeeded_attempt';
                }
            } else {
                nextAttempt = nextAttemptForOutcome(
                    currentAttempt.status,
                    outcome
                );

                if (
                    currentRelease.status === 'failed'
                    && outcome === 'succeeded'
                ) {
                    conflictReason = 'late_success_after_failed_release';
                    nextRelease = 'needs_review';
                } else if (
                    currentRelease.status === 'failed'
                    && outcome === 'failed'
                ) {
                    nextRelease = 'failed';
                } else {
                    nextRelease = releaseState.releaseStateFromAttemptOutcome(
                        currentRelease.status,
                        outcome,
                        {
                            priorAttemptState: currentAttempt.status,
                            explicitResolution:
                                currentRelease.status === 'needs_review',
                        }
                    );
                }
            }
        } else {
            if (currentRelease.status === 'in_flight') {
                nextRelease = 'needs_review';
            }
            if (lookup.kind === 'conflict') {
                conflictReason = lookup.reason;
            }
        }
    } catch (error) {
        if (error && error.code === 'RELEASE_INVALID_TRANSITION') {
            return { apply: false, reason: 'state-transition-refused' };
        }
        throw error;
    }

    const occurredAt = context.occurredAt;
    const releaseFields = {
        updatedAt: occurredAt,
        lastReconciledAt: occurredAt,
        lastReconciliationResult: lookup.kind,
        ...(lookup.kind === 'found'
            ? {}
            : { lastReconciliationReason: lookup.reason }),
        ...(conflictReason ? { lastReconciliationConflict: conflictReason } : {}),
        ...(nextRelease !== currentRelease.status
            ? {
                  status: nextRelease,
                  ...(nextRelease === 'succeeded'
                      ? { completedAt: occurredAt }
                      : {}),
              }
            : {}),
        ...(lookup.kind === 'found' && lookup.result.providerReference
            ? { lastProviderReference: lookup.result.providerReference }
            : {}),
        ...(lookup.kind === 'found' && lookup.result.failureReason
            ? { lastFailureReason: lookup.result.failureReason }
            : {}),
        ...(lookup.kind === 'found' && lookup.result.providerError
            ? { lastProviderError: lookup.result.providerError }
            : {}),
    };

    const attemptFields = nextAttempt !== currentAttempt.status
        ? {
              status: nextAttempt,
              updatedAt: occurredAt,
              ...(releaseState.isTerminalAttemptState(nextAttempt)
                  ? { completedAt: occurredAt }
                  : {}),
              ...(lookup.kind === 'found' && lookup.result.providerReference
                  ? { providerReference: lookup.result.providerReference }
                  : {}),
              ...(lookup.kind === 'found' && lookup.result.failureReason
                  ? { failureReason: lookup.result.failureReason }
                  : {}),
              ...(lookup.kind === 'found' && lookup.result.providerError
                  ? { providerError: lookup.result.providerError }
                  : {}),
          }
        : {};

    return {
        releaseFields,
        attemptFields,
        events: buildReconciliationEvents(
            currentRelease,
            currentAttempt,
            nextRelease,
            nextAttempt,
            lookup,
            conflictReason,
            occurredAt
        ),
        nextRelease,
        nextAttempt,
        conflictReason,
    };
};

const reconcileRelease = async (releaseId, options = {}) => {
    const release = await loadRelease(releaseId);
    if (!RECONCILABLE_RELEASE_STATUSES.includes(release.status)) {
        return {
            reconciled: false,
            reason: 'not-reconcilable',
            status: release.status,
            release,
        };
    }

    if (ACCOUNTING_ONLY_RELEASE_STATUSES.includes(release.status)) {
        const accounting =
            await accountingLifecycleService.reconcileReleaseAccounting(
                releaseId
            );
        return {
            reconciled: true,
            applied: false,
            reason: 'succeeded-accounting-only',
            accountingOnly: true,
            accounting,
            status: release.status,
            release,
        };
    }

    const attempts = await listAttempts(releaseId);
    const attempt = currentAttemptFor(release, attempts);
    if (!attempt) {
        return {
            reconciled: false,
            reason: 'no-current-attempt',
            status: release.status,
            release,
        };
    }

    const staleAfterMs = reconciliationStaleAfterMs(options.staleAfterMs);
    const now = clock.now();
    const nowMs = now.getTime();
    const releaseStaleness = staleInfo(
        releaseActivityTimestamp(release, attempt),
        staleAfterMs,
        nowMs
    );

    if (
        release.status === 'in_flight'
        && !releaseStaleness.stale
        && options.force !== true
    ) {
        return {
            reconciled: false,
            reason: 'not-stale',
            release,
            attempt,
            ...releaseStaleness,
        };
    }

    const actorId =
        safeText(options.actor && options.actor.uid)
        || safeText(options.actor)
        || 'reconciliation-service';
    const source = safeText(options.source) || 'internal';
    const reason = safeText(options.reason)
        || (release.status === 'needs_review'
            ? 'release_in_review'
            : releaseStaleness.stale
                ? 'stale_attempt_investigation'
                : 'explicit_reconciliation');

    await appendEvent(
        releaseEventId(
            release.id,
            `reconciliation:${attempt.attemptNumber}:started`
        ),
        {
            releaseId: release.id,
            attemptId: attempt.id,
            attemptNumber: attempt.attemptNumber,
            eventType: 'release_reconciliation_started',
            actorId,
            source,
            reason,
            stale: releaseStaleness.stale,
            ageMs: releaseStaleness.ageMs,
            staleAfterMs,
            createdAt: now,
        }
    );

    let lookup;

    if (!supportsOutcomeLookup(options.provider)) {
        lookup = {
            kind: 'unavailable',
            reason: 'provider_lookup_not_supported',
        };
    } else if (
        attempt.releaseId !== release.id
        || attempt.amountMinor !== release.amountMinor
        || attempt.currency !== release.currency
    ) {
        lookup = {
            kind: 'conflict',
            reason: 'local_attempt_identity_mismatch',
        };
    } else {
        await appendEvent(
            releaseEventId(
                release.id,
                `reconciliation:${attempt.attemptNumber}:lookup_attempted`
            ),
            {
                releaseId: release.id,
                attemptId: attempt.id,
                attemptNumber: attempt.attemptNumber,
                eventType: 'release_provider_outcome_lookup_attempted',
                actorId,
                source,
                providerId:
                    safeText(options.provider.providerId)
                    || safeText(options.provider.id)
                    || 'injected-release-provider',
                createdAt: now,
            }
        );

        try {
            const raw = await options.provider.lookupReleaseOutcome(
                providerLookupInput(release, attempt)
            );
            lookup = classifyLookup(
                raw,
                providerIdentityFor(release, attempt)
            );
        } catch (error) {
            lookup = {
                kind: 'unavailable',
                reason: 'provider_lookup_exception',
            };
        }
    }

    const applied = await releaseRepository.applyReleaseDecision({
        releaseId,
        attemptNumber: attempt.attemptNumber,
        decide: (currentRelease, currentAttempt) =>
            decideReconciliation(currentRelease, currentAttempt, lookup, {
                release,
                attempt,
                occurredAt: now,
            }),
    });

    // Accounting follows the committed release state, not just this call's
    // transition. Reloading by id means a replay that finds the state already
    // settled (applied: false) still repairs a missing idempotent post. A
    // terminal release that is no longer reconcilable is repaired through
    // reconcileReleaseAccounting(releaseId) instead.
    const accounting = await accountingLifecycleService.recordReleaseOutcome({
        releaseId,
    });

    return {
        reconciled: true,
        applied: applied.applied,
        ...(applied.reason ? { reason: applied.reason } : {}),
        accounting,
        lookup,
        stale: releaseStaleness.stale,
        ageMs: releaseStaleness.ageMs,
        release: applied.release || release,
        attempt: applied.attempt || attempt,
        eventIds: applied.eventIds || [],
    };
};

const resolveReleaseByAdmin = async (releaseId, input = {}, actor) => {
    const adminUid = assertAdminActor(actor);
    const action = normalizeAdminAction(input);
    const outcome = input.outcome;
    if (!RESOLUTION_OUTCOMES.includes(outcome)) {
        fail(
            `resolution outcome must be one of: ${RESOLUTION_OUTCOMES.join(', ')}`,
            'RELEASE_RECONCILIATION_INVALID'
        );
    }

    const release = await loadRelease(releaseId);
    if (release.status !== 'needs_review') {
        fail(
            'only a release under review can be explicitly resolved',
            'RELEASE_RECONCILIATION_STATE'
        );
    }

    const attempts = await listAttempts(releaseId);
    const attempt = currentAttemptFor(release, attempts);
    if (!attempt) {
        fail(
            'release has no attempt to resolve',
            'RELEASE_RECONCILIATION_STATE'
        );
    }

    const requestedAt = clock.now();
    await appendEvent(
        releaseEventId(
            release.id,
            `admin_resolution_requested:${attempt.attemptNumber}:${outcome}`
        ),
        {
            releaseId: release.id,
            attemptId: attempt.id,
            attemptNumber: attempt.attemptNumber,
            eventType: 'release_admin_resolution_requested',
            actorId: adminUid,
            action: 'resolve',
            outcome,
            reason: action.reason,
            evidence: {
                source: action.evidence.source,
                reference: action.evidence.reference,
            },
            createdAt: requestedAt,
        }
    );

    // The existing Stage 2B resolver writes the state change and the
    // `release_resolved` audit event atomically. That event is the completed
    // half of the administrative request; it carries the actor and evidence.
    const result = await releaseOrchestrationService.resolveRelease(releaseId, {
        outcome,
        actor: adminUid,
        evidence: {
            ...action.evidence,
            note: action.evidence.note || action.reason,
        },
    });

    return {
        resolved: true,
        requestedEventType: 'release_admin_resolution_requested',
        completedEventType: 'release_resolved',
        ...result,
    };
};

const authorizeRetry = async (releaseId, input = {}, actor) => {
    const adminUid = assertAdminActor(actor);
    const action = normalizeAdminAction(input);
    const release = await loadRelease(releaseId);

    if (release.status !== 'failed') {
        fail(
            'retry can only be authorized after a definitive release failure',
            'RELEASE_RECONCILIATION_STATE'
        );
    }

    const attempts = await listAttempts(releaseId);
    const attempt = currentAttemptFor(release, attempts);
    if (!attempt || attempt.status !== 'failed') {
        fail(
            'retry authorization requires a definitively failed attempt',
            'RELEASE_RECONCILIATION_STATE'
        );
    }

    const now = clock.now();
    const applied = await releaseRepository.applyReleaseDecision({
        releaseId,
        attemptNumber: attempt.attemptNumber,
        decide: (currentRelease, currentAttempt) => {
            if (currentRelease.status !== 'failed') {
                return { apply: false, reason: 'release-not-failed' };
            }
            if (currentAttempt.status !== 'failed') {
                return { apply: false, reason: 'attempt-not-failed' };
            }

            const nextAttemptNumber = currentAttempt.attemptNumber + 1;
            const authorizationId = releaseEventId(
                currentRelease.id,
                `retry_authorized:${currentAttempt.attemptNumber}`
            );

            return {
                releaseFields: {
                    retryAuthorizationId: authorizationId,
                    retryAuthorizationStatus: 'authorized',
                    retryAuthorizationReleaseId: currentRelease.id,
                    retryAuthorizationFailedAttemptId: currentAttempt.id,
                    retryAuthorizationFailedAttemptNumber:
                        currentAttempt.attemptNumber,
                    retryAuthorizationTargetAttemptNumber:
                        nextAttemptNumber,
                    retryAuthorizedAt: now,
                    retryAuthorizedBy: adminUid,
                    retryAuthorizationReason: action.reason,
                    retryAuthorizationSource: action.evidence.source,
                    retryAuthorizationReference: action.evidence.reference,
                    retryAuthorizedForAttemptNumber: nextAttemptNumber,
                    retryAuthorizationConsumedAt: null,
                    retryAuthorizationConsumedBy: null,
                    retryAuthorizationConsumedForAttemptNumber: null,
                    retryAuthorizationConsumedByAttemptId: null,
                    updatedAt: now,
                },
                attemptFields: {},
                events: [
                    {
                        id: authorizationId,
                        data: {
                            releaseId: currentRelease.id,
                            attemptId: currentAttempt.id,
                            attemptNumber: currentAttempt.attemptNumber,
                            failedAttemptId: currentAttempt.id,
                            failedAttemptNumber:
                                currentAttempt.attemptNumber,
                            nextAttemptNumber,
                            targetAttemptNumber: nextAttemptNumber,
                            authorizationId,
                            authorizationStatus: 'authorized',
                            eventType: 'release_retry_authorized',
                            actorId: adminUid,
                            reason: action.reason,
                            evidence: {
                                source: action.evidence.source,
                                reference: action.evidence.reference,
                            },
                            createdAt: now,
                        },
                    },
                ],
            };
        },
    });

    if (!applied.applied) {
        fail(
            `retry authorization was not applied (${applied.reason})`,
            'RELEASE_RECONCILIATION_STATE'
        );
    }

    return {
        authorized: true,
        attemptNumber: attempt.attemptNumber,
        nextAttemptNumber: attempt.attemptNumber + 1,
        release: applied.release,
    };
};

/**
 * STAGE 2H.2. Repairs the idempotent accounting post for a bounded batch of
 * succeeded releases. It never looks at a provider and never changes release
 * state; the accounting lifecycle re-reads the committed terminal state and
 * replays only the journal that state justifies.
 */
const repairSucceededReleaseAccounting = async (options = {}) => {
    const batchSize = reconciliationBatchSize(options.batchSize || options.limit);
    const afterId =
        typeof options.afterId === 'string' ? options.afterId : undefined;
    const releases = await listSucceededReleasesAfterId(
        batchSize,
        afterId
    );
    const results = [];

    for (const release of releases) {
        try {
            results.push({
                releaseId: release.id,
                accounting:
                    await accountingLifecycleService.reconcileReleaseAccounting(
                        release.id
                    ),
            });
        } catch (error) {
            results.push({
                releaseId: release.id,
                error:
                    error && error.code
                        ? error.code
                        : 'RELEASE_ACCOUNTING_REPAIR_FAILED',
            });
        }
    }

    return {
        examined: results.length,
        batchSize,
        nextAfterId:
            results.length === batchSize ? releases[releases.length - 1].id : null,
        results,
    };
};

/**
 * Safe reconciliation worker. It has no submission path. It examines one
 * bounded batch, performs provider lookups only when the injected provider
 * supports them, applies local state through the same transactional decisions
 * as a manual call, and then ensures the idempotent accounting post for the
 * committed state. Succeeded releases are processed by a separate bounded
 * accounting-only pass (no provider lookup, no state transition).
 */
const runReconciliationWorker = async (options = {}) => {
    const staleAfterMs = reconciliationStaleAfterMs(options.staleAfterMs);
    const batchSize = reconciliationBatchSize(options.batchSize);
    const [stranded, review] = await Promise.all([
        listStrandedReleases({ staleAfterMs }),
        listReviewReleases(batchSize),
    ]);

    const releaseIds = [];
    const seen = new Set();
    for (const row of [...stranded, ...review]) {
        if (!seen.has(row.id)) {
            seen.add(row.id);
            releaseIds.push(row.id);
        }
    }

    const results = [];
    for (const releaseId of releaseIds.slice(0, batchSize)) {
        try {
            results.push(
                await reconcileRelease(releaseId, {
                    provider: options.provider,
                    staleAfterMs,
                    actor: options.actor,
                    source: options.source || 'reconciliation-worker',
                    reason: options.reason,
                })
            );
        } catch (error) {
            results.push({
                reconciled: false,
                releaseId,
                error: error && error.code ? error.code : 'RELEASE_RECONCILIATION_FAILED',
            });
        }
    }

    const accountingRepairs =
        options.repairSucceededAccounting === false
            ? { examined: 0, batchSize, results: [] }
            : await repairSucceededReleaseAccounting({
                  batchSize,
                  afterId: options.accountingAfterId,
              });

    return {
        examined: results.length,
        accountingExamined: accountingRepairs.examined,
        accountingRepairs: accountingRepairs.results,
        accountingNextAfterId: accountingRepairs.nextAfterId,
        staleAfterMs,
        batchSize,
        results,
    };
};

module.exports = {
    ReleaseReconciliationError,
    RECONCILABLE_RELEASE_STATUSES,
    ACCOUNTING_ONLY_RELEASE_STATUSES,
    STALE_ATTEMPT_STATUSES,
    UNCERTAIN_ATTEMPT_STATUSES,
    listReleasesNeedingReview,
    listSucceededReleasesForAccounting,
    listStaleAttempts,
    listUncertainAttempts,
    inspectRelease,
    reconcileRelease,
    repairSucceededReleaseAccounting,
    resolveReleaseByAdmin,
    authorizeRetry,
    runReconciliationWorker,
};
