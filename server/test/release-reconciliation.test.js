'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { createSimulatedReleaseProvider } = require('../testing/simulatedReleaseProvider');
const {
    employment,
    contract,
    milestone,
    payment,
    task,
} = require('../testing/fixtures');

const NOW = '2026-01-01T00:00:00.000Z';
const RELEASE_ID = 'rel_ms-1';
const ATTEMPT_ID = `${RELEASE_ID}__attempt_1`;
const ADMIN = Object.freeze({ uid: 'admin-1', admin: true });
const NON_ADMIN = Object.freeze({ uid: 'employee-1', admin: false });
const STALE_MS = 60 * 1000;

let client;
let releaseService;
let orchestration;
let reconciliation;
let releaseRepository;

const oldIso = (ageMs = 2 * STALE_MS) =>
    new Date(Date.parse(NOW) - ageMs).toISOString();

const expectCode = (code) => (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
};

test.before(async () => {
    client = await startTestServer({ clock: () => NOW });
    releaseService = require('../services/releaseService');
    orchestration = require('../services/releaseOrchestrationService');
    reconciliation = require('../services/releaseReconciliationService');
    releaseRepository = require('../repositories/releaseRepository');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
    client.paystack.reset();
});

function seedFundedMilestone({ taskOverrides = {} } = {}) {
    client.seed('employments', 'emp-1', employment({ status: 'active' }));
    client.seed(
        'contracts',
        'emp-1',
        contract({ paymentMode: 'milestones', status: 'active' })
    );
    client.seed(
        'milestones',
        'ms-1',
        milestone({
            contractId: 'emp-1',
            employmentId: 'emp-1',
            taskId: 'task-1',
            amountMinor: 500000,
        })
    );
    client.seed(
        'payments',
        'ms-1',
        payment({
            milestoneId: 'ms-1',
            contractId: 'emp-1',
            employmentId: 'emp-1',
            employerId: 'employer-1',
            employeeId: 'employee-1',
            amountMinor: 500000,
            currency: 'NGN',
            status: 'paid',
        })
    );
    client.seed(
        'tasks',
        'task-1',
        task({
            employmentId: 'emp-1',
            milestoneId: 'ms-1',
            status: 'approved',
            ...taskOverrides,
        })
    );
}

async function requestMilestoneRelease() {
    return releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
    });
}

function financialSnapshot() {
    return {
        payment: client.readDoc('payments', 'ms-1'),
        contract: client.readDoc('contracts', 'emp-1'),
        employment: client.readDoc('employments', 'emp-1'),
        milestone: client.readDoc('milestones', 'ms-1'),
        task: client.readDoc('tasks', 'task-1'),
    };
}

function assertFinancialSourcesUnchanged(snapshot) {
    assert.deepEqual(client.readDoc('payments', 'ms-1'), snapshot.payment);
    assert.deepEqual(client.readDoc('contracts', 'emp-1'), snapshot.contract);
    assert.deepEqual(client.readDoc('employments', 'emp-1'), snapshot.employment);
    assert.deepEqual(client.readDoc('milestones', 'ms-1'), snapshot.milestone);
    assert.deepEqual(client.readDoc('tasks', 'task-1'), snapshot.task);
}

function assertNoLedgerPosting() {
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
}

function assertNoCollectionOrSubmit(provider) {
    assert.equal(provider.calls.length, 0);
    assert.equal(client.paystack.calls.length, 0);
}

function strandRelease({
    releaseStatus = 'in_flight',
    attemptStatus = 'created',
    ageMs = 2 * STALE_MS,
} = {}) {
    const claimedAt = oldIso(ageMs);
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    client.seed('releaseRequests', RELEASE_ID, {
        ...release,
        status: releaseStatus,
        attemptCount: 1,
        currentAttemptId: ATTEMPT_ID,
        currentAttemptNumber: 1,
        updatedAt: claimedAt,
    });

    const attempt = {
        releaseId: RELEASE_ID,
        attemptNumber: 1,
        status: attemptStatus,
        providerId: 'simulated-release-provider',
        targetType: 'milestone',
        targetId: 'ms-1',
        paymentId: 'ms-1',
        contractId: 'emp-1',
        employmentId: 'emp-1',
        employerId: 'employer-1',
        employeeId: 'employee-1',
        amountMinor: 500000,
        currency: 'NGN',
        submissionClaimedAt: claimedAt,
        createdAt: claimedAt,
        updatedAt: claimedAt,
        ...(attemptStatus === 'unknown'
            ? { completedAt: claimedAt, failureReason: 'provider_outcome_not_interpretable' }
            : {}),
        ...(attemptStatus === 'failed'
            ? { completedAt: claimedAt, failureReason: 'simulated_decline' }
            : {}),
    };
    client.seed('releaseAttempts', ATTEMPT_ID, attempt);
    return { release, attempt, claimedAt };
}

function events() {
    return Object.values(client.readAll('releaseEvents'));
}

function eventCount(type) {
    return events().filter((event) => event.eventType === type).length;
}

function lookupProvider(spec, options = {}) {
    return createSimulatedReleaseProvider({
        ...options,
        lookups: {
            [`${RELEASE_ID}:1`]: spec,
        },
    });
}

test('stale claimed attempts are detected for investigation, not treated as failed', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });

    const stale = await reconciliation.listStaleAttempts(ADMIN, {
        staleAfterMs: STALE_MS,
    });

    assert.equal(stale.length, 1);
    assert.equal(stale[0].id, ATTEMPT_ID);
    assert.equal(stale[0].status, 'created');
    assert.equal(stale[0].stale, true);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'in_flight');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'created');
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
});

test('stale submitted attempts are detected without inventing a failure', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'submitted' });

    const stale = await reconciliation.listStaleAttempts(ADMIN, {
        staleAfterMs: STALE_MS,
    });

    assert.equal(stale.length, 1);
    assert.equal(stale[0].status, 'submitted');
    assert.equal(stale[0].stale, true);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'in_flight');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'submitted');
});

test('a fresh in-flight claim is not reconciled as stranded', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ ageMs: 1000 });
    const provider = lookupProvider({ outcome: 'succeeded', providerReference: 'too-early' });

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.reconciled, false);
    assert.equal(result.reason, 'not-stale');
    assert.equal(provider.lookupCalls.length, 0);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'in_flight');
});

test('a verified success reconciles an in-flight claimed attempt through the state machine', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });
    const before = financialSnapshot();
    const provider = lookupProvider({
        outcome: 'succeeded',
        providerReference: 'reconciled-success-ref',
    });

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.reconciled, true);
    assert.equal(result.applied, true);
    assert.equal(result.lookup.kind, 'found');
    assert.equal(provider.lookupCalls.length, 1);
    assertNoCollectionOrSubmit(provider);

    const release = client.readDoc('releaseRequests', RELEASE_ID);
    const attempt = client.readDoc('releaseAttempts', ATTEMPT_ID);
    assert.equal(release.status, 'succeeded');
    assert.equal(release.lastProviderReference, 'reconciled-success-ref');
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.providerReference, 'reconciled-success-ref');
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
    assert.equal(eventCount('release_provider_outcome_lookup_attempted'), 1);
    assert.equal(eventCount('release_provider_outcome_found'), 1);
    assert.equal(eventCount('release_reconciliation_completed'), 1);
    assertNoLedgerPosting();
    assertFinancialSourcesUnchanged(before);
});

test('a verified failure reconciles a stale submitted attempt to failed', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'submitted' });
    const provider = lookupProvider({
        outcome: 'failed',
        failureReason: 'simulated_provider_decline',
    });

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'found');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'failed');
    const attempt = client.readDoc('releaseAttempts', ATTEMPT_ID);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.failureReason, 'simulated_provider_decline');
    assertNoCollectionOrSubmit(provider);
    assertNoLedgerPosting();
});

test('unknown attempt reconciliation applies an authoritative provider outcome', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'needs_review', attemptStatus: 'unknown' });
    const provider = lookupProvider({
        outcome: 'succeeded',
        providerReference: 'unknown-resolved-ref',
    });

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'found');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'succeeded');
    assert.equal(eventCount('release_reconciliation_completed'), 1);
    assertNoLedgerPosting();
});

test('a provider lookup exception remains unknown and leaves the attempt untouched', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });
    const provider = lookupProvider('throw');

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'unavailable');
    assert.equal(result.lookup.reason, 'provider_lookup_exception');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'created');
    assert.equal(eventCount('release_provider_outcome_unavailable'), 1);
    assertNoCollectionOrSubmit(provider);
});

test('a missing provider lookup result remains unknown', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'needs_review', attemptStatus: 'unknown' });
    const provider = createSimulatedReleaseProvider();

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'unavailable');
    assert.equal(result.lookup.reason, 'lookup_result_missing');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'unknown');
    assert.equal(provider.lookupCalls.length, 1);
    assertNoCollectionOrSubmit(provider);
});

test('a provider that does not support lookup leaves the release in review', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });
    const submitOnlyProvider = {
        async submitRelease() {
            throw new Error('must not submit during reconciliation');
        },
    };

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider: submitOnlyProvider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'unavailable');
    assert.equal(result.lookup.reason, 'provider_lookup_not_supported');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(eventCount('release_provider_outcome_lookup_attempted'), 0);
    assertNoLedgerPosting();
});

test('mismatched provider evidence is a conflict and is never accepted', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });
    const provider = {
        async lookupReleaseOutcome(input) {
            return {
                releaseId: input.releaseId,
                attemptId: input.attemptId,
                attemptNumber: input.attemptNumber,
                currency: input.currency,
                amountMinor: 1,
                outcome: 'succeeded',
                providerReference: 'wrong-amount-ref',
            };
        },
    };

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'conflict');
    assert.equal(result.lookup.reason, 'lookup_amountMinor_mismatch');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'created');
    assert.equal(eventCount('release_reconciliation_conflict'), 1);
    assertNoLedgerPosting();
});

test('malformed provider evidence remains unknown', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'needs_review', attemptStatus: 'unknown' });
    const provider = lookupProvider({ nonsense: true });

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'unavailable');
    assert.equal(result.lookup.reason, 'lookup_result_malformed');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'unknown');
});

test('a late success after an earlier failure escalates to review without overwriting history', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'failed', attemptStatus: 'failed' });
    const provider = lookupProvider({
        outcome: 'succeeded',
        providerReference: 'late-success-ref',
    });

    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(result.lookup.kind, 'found');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    const attempt = client.readDoc('releaseAttempts', ATTEMPT_ID);
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.failureReason, 'simulated_decline');
    assert.equal(eventCount('release_reconciliation_conflict'), 1);
    assertNoCollectionOrSubmit(provider);
    assertNoLedgerPosting();
});

test('reconciliation never resubmits a claimed attempt after the crash window', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });
    const provider = createSimulatedReleaseProvider();

    const first = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });
    const second = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(first.lookup.kind, 'unavailable');
    assert.equal(second.reconciled, true);
    assert.equal(provider.calls.length, 0);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).attemptCount, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
});

test('reconciliation never automatically retries an unknown outcome', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'needs_review', attemptStatus: 'unknown' });
    const provider = createSimulatedReleaseProvider();

    await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'unknown');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).attemptCount, 1);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
    assert.equal(provider.calls.length, 0);
});

test('concurrent reconciliation workers apply one decision without duplicate events', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });
    const provider = lookupProvider({
        outcome: 'succeeded',
        providerReference: 'concurrent-success-ref',
    });

    const results = await Promise.all([
        reconciliation.reconcileRelease(RELEASE_ID, { provider, staleAfterMs: STALE_MS }),
        reconciliation.reconcileRelease(RELEASE_ID, { provider, staleAfterMs: STALE_MS }),
        reconciliation.reconcileRelease(RELEASE_ID, { provider, staleAfterMs: STALE_MS }),
    ]);

    assert.equal(results.filter((result) => result.applied).length, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'succeeded');
    assert.equal(eventCount('release_reconciliation_started'), 1);
    assert.equal(eventCount('release_provider_outcome_lookup_attempted'), 1);
    assert.equal(eventCount('release_provider_outcome_found'), 1);
    assert.equal(eventCount('release_reconciliation_completed'), 1);
    assert.equal(eventCount('release_state_changed'), 1);
    assert.equal(eventCount('release_attempt_state_changed'), 1);
    assertNoLedgerPosting();
});

test('duplicate reconciliation calls are idempotent when evidence remains unavailable', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'needs_review', attemptStatus: 'unknown' });
    const provider = createSimulatedReleaseProvider();

    await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });
    await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
        staleAfterMs: STALE_MS,
    });

    assert.equal(eventCount('release_reconciliation_started'), 1);
    assert.equal(eventCount('release_provider_outcome_unavailable'), 1);
    assert.equal(eventCount('release_reconciliation_completed'), 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'unknown');
});

test('trusted admin resolution rejects non-admin actors and records evidence', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'needs_review', attemptStatus: 'unknown' });

    const resolution = {
        outcome: 'failed',
        reason: 'provider reconciliation found a definitive decline',
        evidence: {
            source: 'provider_reconciliation',
            reference: 'recon-ref-1',
        },
    };

    await assert.rejects(
        () => reconciliation.resolveReleaseByAdmin(RELEASE_ID, resolution, NON_ADMIN),
        expectCode('RELEASE_RECONCILIATION_FORBIDDEN')
    );
    await assert.rejects(
        () =>
            reconciliation.resolveReleaseByAdmin(
                RELEASE_ID,
                { ...resolution, explicitResolution: true },
                { uid: 'employee-1', admin: false }
            ),
        expectCode('RELEASE_RECONCILIATION_FORBIDDEN')
    );

    const result = await reconciliation.resolveReleaseByAdmin(
        RELEASE_ID,
        resolution,
        ADMIN
    );

    assert.equal(result.resolved, true);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'failed');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).resolvedBy, 'admin-1');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'failed');

    const requested = events().find(
        (event) => event.eventType === 'release_admin_resolution_requested'
    );
    assert.equal(requested.actorId, 'admin-1');
    assert.equal(requested.reason, resolution.reason);
    assert.equal(requested.evidence.reference, 'recon-ref-1');

    const resolved = events().find((event) => event.eventType === 'release_resolved');
    assert.equal(resolved.actor, 'admin-1');
    assert.equal(resolved.evidence.reference, 'recon-ref-1');
    assert.equal(resolved.evidence.note, resolution.reason);
    assertNoLedgerPosting();
});

test('retry can be authorized only after a definitive failure', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'needs_review', attemptStatus: 'unknown' });

    await assert.rejects(
        () =>
            reconciliation.authorizeRetry(
                RELEASE_ID,
                {
                    reason: 'not yet definitive',
                    evidence: { source: 'admin_review', reference: 'ref-1' },
                },
                ADMIN
            ),
        expectCode('RELEASE_RECONCILIATION_STATE')
    );

    client.fake.resetAll();
    client.paystack.reset();
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ releaseStatus: 'failed', attemptStatus: 'failed' });

    const result = await reconciliation.authorizeRetry(
        RELEASE_ID,
        {
            reason: 'provider confirmed the decline; a new attempt is permitted',
            evidence: { source: 'provider_reconciliation', reference: 'recon-ref-2' },
        },
        ADMIN
    );

    assert.equal(result.authorized, true);
    assert.equal(result.nextAttemptNumber, 2);
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    assert.equal(release.status, 'failed');
    assert.equal(release.retryAuthorizationStatus, 'authorized');
    assert.equal(typeof release.retryAuthorizationId, 'string');
    assert.equal(release.retryAuthorizationReleaseId, RELEASE_ID);
    assert.equal(release.retryAuthorizationFailedAttemptId, ATTEMPT_ID);
    assert.equal(release.retryAuthorizationFailedAttemptNumber, 1);
    assert.equal(release.retryAuthorizationTargetAttemptNumber, 2);
    assert.equal(release.retryAuthorizedBy, 'admin-1');
    assert.equal(release.retryAuthorizedForAttemptNumber, 2);
    assert.equal(release.retryAuthorizationConsumedAt, null);
    assert.equal(release.retryAuthorizationSource, 'provider_reconciliation');
    assert.equal(release.retryAuthorizationReference, 'recon-ref-2');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'failed');
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
    assert.equal(eventCount('release_retry_authorized'), 1);
    assertNoLedgerPosting();
});

test('the reconciliation worker is bounded and never submits a new attempt', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    strandRelease({ attemptStatus: 'created' });
    const provider = createSimulatedReleaseProvider();

    const result = await reconciliation.runReconciliationWorker({
        provider,
        staleAfterMs: STALE_MS,
        batchSize: 1,
    });

    assert.equal(result.examined, 1);
    assert.equal(result.batchSize, 1);
    assert.equal(provider.calls.length, 0);
    assert.equal(client.paystack.calls.length, 0);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
    assertNoLedgerPosting();
});

test('administrative listing and inspection expose history without mutating it', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const stranded = strandRelease({ attemptStatus: 'created' });
    const before = financialSnapshot();

    const reviewRows = await reconciliation.listReleasesNeedingReview(ADMIN);
    assert.equal(reviewRows.length, 0);

    const staleRows = await reconciliation.listStaleAttempts(ADMIN, {
        staleAfterMs: STALE_MS,
    });
    assert.equal(staleRows.length, 1);

    const inspection = await reconciliation.inspectRelease(ADMIN, RELEASE_ID, {
        staleAfterMs: STALE_MS,
    });
    assert.equal(inspection.release.status, 'in_flight');
    assert.equal(inspection.stranded, true);
    assert.equal(inspection.currentAttempt.id, ATTEMPT_ID);
    assert.equal(inspection.attempts.length, 1);
    assert.equal(inspection.staleAttempts.length, 1);
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).status, 'created');
    assert.equal(client.readDoc('releaseAttempts', ATTEMPT_ID).createdAt, stranded.claimedAt);
    assertFinancialSourcesUnchanged(before);
    assertNoLedgerPosting();
});

test('the release event repository remains append-only for Stage 2C', () => {
    const releaseEventRepository = require('../repositories/releaseEventRepository');
    for (const forbidden of ['update', 'delete', 'replace', 'set', 'remove']) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(releaseEventRepository, forbidden),
            false,
            `releaseEventRepository must not expose ${forbidden}`
        );
    }
    assert.equal(typeof releaseEventRepository.appendEventIfAbsent, 'function');
    assert.equal(typeof releaseRepository.applyReleaseDecision, 'function');
});
