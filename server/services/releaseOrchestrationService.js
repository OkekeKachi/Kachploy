'use strict';

const clock = require('../config/clock');
const {
    isValidDocumentId,
    releaseEventId,
    releaseRequestId,
    releaseTransferReference,
} = require('../config/release');
const releaseRepository = require('../repositories/releaseRepository');
const releaseService = require('./releaseService');
const releaseEligibilityService = require('./releaseEligibilityService');
const releaseState = require('./releaseState');
const {
    assertReleaseProvider,
    normalizeProviderOutcome,
} = require('./releaseProvider');
const accountingLifecycleService = require('./accountingLifecycleService');
const {
    getPaystackMode,
    isLiveMode,
    isLivePayoutsEnabled,
} = require('../config/paystack');
const { ReleaseValidationError } = releaseService;

const RESOLUTION_OUTCOMES = Object.freeze(['succeeded', 'failed']);

const fail = (message, code = 'RELEASE_INVALID_REQUEST') => {
    throw new ReleaseValidationError(message, code);
};

const safeText = (value) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const loadRelease = async (releaseId) => {
    if (!isValidDocumentId(releaseId)) {
        fail('releaseId must be a valid document id', 'RELEASE_INVALID_REQUEST');
    }
    const snapshot = await releaseRepository.getReleaseById(releaseId);
    if (!snapshot || !snapshot.exists) {
        fail(`release ${releaseId} was not found`, 'RELEASE_NOT_FOUND');
    }
    const release = { id: snapshot.id, ...snapshot.data() };
    if (release.releaseId !== releaseId) {
        fail('stored release identity is inconsistent', 'RELEASE_INCONSISTENT_RECORD');
    }
    return release;
};

const requireEligible = async (release) => {
    const eligibility = await releaseEligibilityService.getReleaseEligibility(
        release.employmentId
    );
    if (eligibility.status !== 'eligible') {
        fail(
            `release is not currently eligible (${eligibility.reason})`,
            'RELEASE_NOT_ELIGIBLE'
        );
    }
    return eligibility;
};

const providerIdFor = (provider) =>
    safeText(provider.providerId) || safeText(provider.id) || 'injected-release-provider';

const buildAttemptDocument = (release, attemptNumber, claimedAt, providerId) => ({
    releaseId: release.id,
    attemptNumber,
    status: 'created',
    providerId,
    targetType: release.targetType,
    targetId: release.targetId,
    paymentId: release.paymentId,
    contractId: release.contractId,
    employmentId: release.employmentId,
    employerId: release.employerId,
    employeeId: release.employeeId,
    amountMinor: release.amountMinor,
    currency: release.currency,
    transferReference: releaseTransferReference(release.id, attemptNumber),
    submissionClaimedAt: claimedAt,
    createdAt: claimedAt,
    updatedAt: claimedAt,
});

const buildClaimEvents = (
    release,
    attemptNumber,
    claimedAt,
    context = {}
) => {
    const attemptId = `${release.id}__attempt_${attemptNumber}`;
    const identity = {
        releaseId: release.id,
        attemptId,
        attemptNumber,
        targetType: release.targetType,
        targetId: release.targetId,
        amountMinor: release.amountMinor,
        currency: release.currency,
    };
    const events = [];

    if (context.retry && context.retryAuthorization) {
        const authorization = context.retryAuthorization;
        const authorizationIdentity = {
            releaseId: release.id,
            attemptId,
            attemptNumber,
            authorizationId: authorization.authorizationId,
            failedAttemptId: authorization.failedAttemptId,
            failedAttemptNumber: authorization.failedAttemptNumber,
            targetAttemptNumber: authorization.targetAttemptNumber,
            authorizedBy: authorization.authorizedBy,
            authorizedAt: authorization.authorizedAt,
            reason: authorization.reason,
            evidence: authorization.evidence,
        };

        events.push({
            id: releaseEventId(
                release.id,
                `retry_authorization_validated:${authorization.failedAttemptNumber}:${attemptNumber}`
            ),
            data: {
                ...authorizationIdentity,
                eventType: 'release_retry_authorization_validated',
                submittedBy: authorization.submittedBy,
                createdAt: claimedAt,
            },
        });
        events.push({
            id: releaseEventId(
                release.id,
                `retry_authorization_consumed:${authorization.failedAttemptNumber}:${attemptNumber}`
            ),
            data: {
                ...authorizationIdentity,
                eventType: 'release_retry_authorization_consumed',
                consumedBy: authorization.submittedBy,
                createdAt: claimedAt,
            },
        });
    }

    events.push(
        {
            id: releaseEventId(release.id, `attempt_created:${attemptNumber}`),
            data: {
                ...identity,
                eventType: 'release_attempt_created',
                fromStatus: null,
                toStatus: 'created',
                ...(context.retry
                    ? { retry: true, authorizationId: context.retryAuthorization.authorizationId }
                    : {}),
                createdAt: claimedAt,
            },
        },
        {
            id: releaseEventId(
                release.id,
                `attempt_submission_claimed:${attemptNumber}`
            ),
            data: {
                ...identity,
                eventType: 'release_attempt_submission_claimed',
                fromStatus: 'created',
                toStatus: 'created',
                ...(context.retry
                    ? { retry: true, authorizationId: context.retryAuthorization.authorizationId }
                    : {}),
                createdAt: claimedAt,
            },
        },
        {
            id: releaseEventId(release.id, `release_in_flight:${attemptNumber}`),
            data: {
                ...identity,
                eventType: 'release_state_changed',
                fromStatus: release.status,
                toStatus: 'in_flight',
                createdAt: claimedAt,
            },
        }
    );

    return events;
};

const nextAttemptState = (currentAttemptState, outcome) => {
    if (currentAttemptState === 'created' && outcome !== 'failed') {
        return releaseState.transitionAttempt(
            releaseState.transitionAttempt('created', 'submitted'),
            outcome
        );
    }
    return releaseState.transitionAttempt(currentAttemptState, outcome);
};

const buildOutcomeEvents = (
    release,
    attempt,
    nextRelease,
    nextAttempt,
    providerResult,
    occurredAt
) => {
    const identity = {
        releaseId: release.id,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
    };
    const events = [
        {
            id: releaseEventId(
                release.id,
                `attempt_outcome:${attempt.attemptNumber}`
            ),
            data: {
                ...identity,
                eventType: 'release_attempt_outcome_recorded',
                fromStatus: attempt.status,
                toStatus: nextAttempt,
                outcome: providerResult.outcome,
                ...(providerResult.providerReference
                    ? { providerReference: providerResult.providerReference }
                    : {}),
                ...(providerResult.failureReason
                    ? { failureReason: providerResult.failureReason }
                    : {}),
                ...(providerResult.providerError
                    ? { providerError: providerResult.providerError }
                    : {}),
                createdAt: occurredAt,
            },
        },
    ];

    if (nextRelease !== release.status) {
        events.push({
            id: releaseEventId(
                release.id,
                `release_outcome:${attempt.attemptNumber}:${nextRelease}`
            ),
            data: {
                ...identity,
                eventType: 'release_state_changed',
                fromStatus: release.status,
                toStatus: nextRelease,
                outcome: providerResult.outcome,
                ...(providerResult.providerReference
                    ? { providerReference: providerResult.providerReference }
                    : {}),
                ...(providerResult.failureReason
                    ? { failureReason: providerResult.failureReason }
                    : {}),
                ...(providerResult.providerError
                    ? { providerError: providerResult.providerError }
                    : {}),
                createdAt: occurredAt,
            },
        });
    }

    return events;
};

const decideAttemptOutcome = (
    release,
    attempt,
    providerResult,
    occurredAt
) => {
    if (release.status !== 'in_flight' && release.status !== 'needs_review') {
        return { apply: false, reason: 'release-not-in-flight' };
    }
    if (attempt.status !== 'created' && attempt.status !== 'submitted') {
        return { apply: false, reason: 'attempt-not-open' };
    }
    if (!attempt.submissionClaimedAt) {
        return { apply: false, reason: 'attempt-not-claimed' };
    }

    let nextAttempt;
    let nextRelease;
    try {
        nextAttempt = nextAttemptState(attempt.status, providerResult.outcome);
        nextRelease = releaseState.releaseStateFromAttemptOutcome(
            release.status,
            providerResult.outcome,
            { priorAttemptState: attempt.status }
        );
    } catch (error) {
        if (error && error.code === 'RELEASE_INVALID_TRANSITION') {
            return { apply: false, reason: 'state-transition-refused' };
        }
        throw error;
    }

    const attemptFields = {
        status: nextAttempt,
        updatedAt: occurredAt,
        ...(releaseState.isTerminalAttemptState(nextAttempt)
            ? { completedAt: occurredAt }
            : {}),
        ...(providerResult.providerReference
            ? { providerReference: providerResult.providerReference }
            : {}),
        ...(providerResult.failureReason
            ? { failureReason: providerResult.failureReason }
            : {}),
        ...(providerResult.providerError
            ? { providerError: providerResult.providerError }
            : {}),
    };

    const releaseFields = {
        updatedAt: occurredAt,
        ...(nextRelease !== release.status
            ? {
                  status: nextRelease,
                  ...(nextRelease === 'succeeded' ? { completedAt: occurredAt } : {}),
              }
            : {}),
        ...(providerResult.providerReference
            ? { lastProviderReference: providerResult.providerReference }
            : {}),
        ...(providerResult.failureReason
            ? { lastFailureReason: providerResult.failureReason }
            : {}),
        ...(providerResult.providerError
            ? { lastProviderError: providerResult.providerError }
            : {}),
    };

    return {
        releaseFields,
        attemptFields,
        events: buildOutcomeEvents(
            release,
            attempt,
            nextRelease,
            nextAttempt,
            providerResult,
            occurredAt
        ),
    };
};

const submitReleaseAttempt = async (releaseId, options = {}) => {
    const provider = assertReleaseProvider(options.provider);
    const release = await loadRelease(releaseId);

    if (release.status !== 'requested' && release.status !== 'failed') {
        return {
            submitted: false,
            reason: 'not-claimable',
            status: release.status,
            release,
        };
    }

    const currentAttemptCount = Number.isSafeInteger(release.attemptCount)
        ? release.attemptCount
        : 0;
    const attemptNumber = options.attemptNumber === undefined
        ? currentAttemptCount + 1
        : options.attemptNumber;
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        fail('attemptNumber must be a positive safe integer', 'RELEASE_INVALID_REQUEST');
    }

    const funding = await releaseService.revalidateReleaseFunding(release);
    if (release.id !== releaseRequestId(funding.paymentId)) {
        fail('release identity does not match its funding authority', 'RELEASE_INCONSISTENT_RECORD');
    }

    // The release and its funding payment must belong to the environment this
    // process is configured for. Legacy records predate the tag and are Test
    // Mode. A Test Mode collection must never become a Live transfer, and a
    // Live collection must never be settled by a Test Mode transfer.
    const currentEnvironment = getPaystackMode();
    if (
        (release.providerEnvironment || 'test') !== currentEnvironment ||
        (funding.providerEnvironment || 'test') !== currentEnvironment
    ) {
        fail(
            'release belongs to a different Paystack environment',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    // Live Mode still requires an explicit, separate opt-in before this server
    // will move real money out. Test Mode is never gated.
    if (isLiveMode() && !isLivePayoutsEnabled()) {
        fail(
            'live payouts are disabled on this server',
            'RELEASE_LIVE_PAYOUTS_DISABLED'
        );
    }

    await requireEligible(release);

    const providerId = providerIdFor(provider);
    const claimedAt = clock.now();

    // STAGE 2C.1. This UID must come from trusted server code that has already
    // authenticated the administrative actor. There is deliberately no public
    // release-submission route, and this value must never be copied from an
    // HTTP body or query string. The repository verifies it against the
    // persisted Stage 2C authorization before any write.
    const retryActorUid = safeText(options.retryActorUid);

    const claim = await releaseRepository.claimAttemptForSubmission({
        releaseId,
        attemptNumber,
        claimedAt,
        retryActorUid,
        buildAttempt: (currentRelease, number, at) =>
            buildAttemptDocument(currentRelease, number, at, providerId),
        buildEvents: buildClaimEvents,
    });

    if (!claim.claimed) {
        return {
            submitted: false,
            reason: claim.reason,
            ...(claim.status ? { status: claim.status } : {}),
            ...(claim.expectedAttemptNumber
                ? { expectedAttemptNumber: claim.expectedAttemptNumber }
                : {}),
            release: claim.release || release,
        };
    }

    // The claim has committed. Only now may a payout initiation be posted; a
    // refused/mismatched claim returns above and never creates one. The post is
    // not part of the claim transaction, so it is idempotent and replayable.
    const accountingInitiation =
        await accountingLifecycleService.ensurePayoutInitiation({
            releaseId,
            attemptNumber,
        });

const providerInput = {
        releaseId,
        attemptId: claim.attemptId,
        attemptNumber,
        idempotencyKey: claim.attemptId,
        targetType: release.targetType,
        targetId: release.targetId,
        paymentId: release.paymentId,
        contractId: release.contractId,
        employmentId: release.employmentId,
        employerId: release.employerId,
        employeeId: release.employeeId,
        amountMinor: release.amountMinor,
        currency: release.currency,
        providerEnvironment: release.providerEnvironment || 'test',
        transferReference: releaseTransferReference(releaseId,
attemptNumber),
        ...(options.payoutAccount
            ? {
                  bankAccountNumber: options.payoutAccount.bankAccountNumber,
                  bankCode: options.payoutAccount.bankCode,
                  accountName: options.payoutAccount.accountName,
              }
            : {}),
    };

    let providerResult;
    try {
        providerResult = normalizeProviderOutcome(
            await provider.submitRelease(providerInput)
        );
    } catch (error) {
        providerResult = null;
    }
    if (!providerResult) {
        providerResult = {
            outcome: 'unknown',
            failureReason: 'provider_outcome_not_interpretable',
        };
    }

    const applied = await releaseRepository.applyReleaseDecision({
        releaseId,
        attemptNumber,
        decide: (currentRelease, currentAttempt) =>
            decideAttemptOutcome(
                currentRelease,
                currentAttempt,
                providerResult,
                claimedAt
            ),
    });

    const accountingOutcome = applied.applied
        ? await accountingLifecycleService.recordReleaseOutcome({
              releaseId,
              release: applied.release,
              attempt: applied.attempt,
          })
        : null;

    return {
        submitted: true,
        attemptId: claim.attemptId,
        attemptNumber,
        outcome: providerResult.outcome,
        applied: applied.applied,
        ...(applied.reason ? { reason: applied.reason } : {}),
        ...(applied.release ? { release: applied.release } : {}),
        ...(applied.attempt ? { attempt: applied.attempt } : {}),
        accounting: {
            initiation: accountingInitiation,
            ...(accountingOutcome ? { outcome: accountingOutcome } : {}),
        },
    };
};

const normalizeResolution = (input = {}) => {
    const outcome = input.outcome;
    if (!RESOLUTION_OUTCOMES.includes(outcome)) {
        fail(
            `resolution outcome must be one of: ${RESOLUTION_OUTCOMES.join(', ')}`,
            'RELEASE_INVALID_RESOLUTION'
        );
    }

    const actor = safeText(input.actor);
    if (!actor) {
        fail('resolution actor is required', 'RELEASE_INVALID_RESOLUTION');
    }

    const evidence = input.evidence;
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        fail('structured resolution evidence is required', 'RELEASE_INVALID_RESOLUTION');
    }

    const source = safeText(evidence.source);
    const reference = safeText(evidence.reference);
    if (!source || !reference) {
        fail(
            'resolution evidence.source and evidence.reference are required',
            'RELEASE_INVALID_RESOLUTION'
        );
    }

    const note = safeText(evidence.note);
    return {
        outcome,
        actor,
        evidence: {
            source,
            reference,
            ...(note ? { note } : {}),
        },
    };
};

const decideResolution = (release, attempt, resolution, resolvedAt) => {
    if (release.status !== 'needs_review') {
        return { apply: false, reason: 'release-not-under-review' };
    }

    let nextRelease;
    try {
        nextRelease = releaseState.transitionRelease(
            release.status,
            resolution.outcome,
            { explicitResolution: true }
        );
    } catch (error) {
        if (error && error.code === 'RELEASE_INVALID_TRANSITION') {
            return { apply: false, reason: 'state-transition-refused' };
        }
        throw error;
    }

    let nextAttempt;
    try {
        if (attempt.status === 'unknown') {
            nextAttempt = releaseState.transitionAttempt(
                attempt.status,
                resolution.outcome,
                { explicitResolution: true }
            );
        } else if (attempt.status === 'submitted') {
            nextAttempt = releaseState.transitionAttempt(
                attempt.status,
                resolution.outcome
            );
        } else if (attempt.status === 'created') {
            nextAttempt = nextAttemptState(attempt.status, resolution.outcome);
        }
    } catch (error) {
        if (error && error.code === 'RELEASE_INVALID_TRANSITION') {
            return { apply: false, reason: 'attempt-transition-refused' };
        }
        throw error;
    }

    const releaseFields = {
        status: nextRelease,
        resolvedAt,
        resolutionOutcome: resolution.outcome,
        resolvedBy: resolution.actor,
        resolutionSource: resolution.evidence.source,
        resolutionReference: resolution.evidence.reference,
        updatedAt: resolvedAt,
        ...(nextRelease === 'succeeded' ? { completedAt: resolvedAt } : {}),
    };

    const attemptFields = nextAttempt
        ? {
              status: nextAttempt,
              updatedAt: resolvedAt,
              ...(releaseState.isTerminalAttemptState(nextAttempt)
                  ? { completedAt: resolvedAt }
                  : {}),
          }
        : {};

    const identity = {
        releaseId: release.id,
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
    };
    const events = [
        {
            id: releaseEventId(
                release.id,
                `resolution:${attempt.attemptNumber}:${resolution.outcome}`
            ),
            data: {
                ...identity,
                eventType: 'release_resolved',
                fromStatus: release.status,
                toStatus: nextRelease,
                outcome: resolution.outcome,
                actor: resolution.actor,
                evidence: resolution.evidence,
                createdAt: resolvedAt,
            },
        },
        {
            id: releaseEventId(
                release.id,
                `release_resolution_state:${attempt.attemptNumber}:${nextRelease}`
            ),
            data: {
                ...identity,
                eventType: 'release_state_changed',
                fromStatus: release.status,
                toStatus: nextRelease,
                createdAt: resolvedAt,
            },
        },
    ];

    if (nextAttempt && nextAttempt !== attempt.status) {
        events.push({
            id: releaseEventId(
                release.id,
                `attempt_resolution:${attempt.attemptNumber}:${nextAttempt}`
            ),
            data: {
                ...identity,
                eventType: 'release_attempt_state_changed',
                fromStatus: attempt.status,
                toStatus: nextAttempt,
                outcome: resolution.outcome,
                createdAt: resolvedAt,
            },
        });
    }

    return { releaseFields, attemptFields, events };
};

const resolveRelease = async (releaseId, input = {}) => {
    const resolution = normalizeResolution(input);
    const release = await loadRelease(releaseId);

    if (release.status !== 'needs_review') {
        fail('only a release under review can be explicitly resolved', 'RELEASE_NOT_IN_REVIEW');
    }

    const attemptNumber = Number.isSafeInteger(release.currentAttemptNumber)
        ? release.currentAttemptNumber
        : release.attemptCount;
    if (!Number.isSafeInteger(attemptNumber) || attemptNumber < 1) {
        fail('release has no attempt to resolve', 'RELEASE_RESOLUTION_REFUSED');
    }

    const resolvedAt = clock.now();
    const applied = await releaseRepository.applyReleaseDecision({
        releaseId,
        attemptNumber,
        decide: (currentRelease, currentAttempt) =>
            decideResolution(currentRelease, currentAttempt, resolution, resolvedAt),
    });

    if (!applied.applied) {
        fail(
            `release resolution was not applied (${applied.reason})`,
            'RELEASE_RESOLUTION_REFUSED'
        );
    }

    const accounting = await accountingLifecycleService.recordReleaseOutcome({
        releaseId,
        release: applied.release,
        attempt: applied.attempt,
    });

    return {
        resolved: true,
        resolution,
        release: applied.release,
        attempt: applied.attempt,
        accounting,
    };
};

module.exports = {
    submitReleaseAttempt,
    resolveRelease,
    RESOLUTION_OUTCOMES,
};
