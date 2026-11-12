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

let client;
let releaseService;
let orchestration;
let reconciliation;

const RELEASE_ID = 'rel_ms-1';
const ATTEMPT_1 = `${RELEASE_ID}__attempt_1`;
const ATTEMPT_2 = `${RELEASE_ID}__attempt_2`;
const ADMIN = Object.freeze({ uid: 'admin-1', admin: true });

test.before(async () => {
    client = await startTestServer();
    releaseService = require('../services/releaseService');
    orchestration = require('../services/releaseOrchestrationService');
    reconciliation = require('../services/releaseReconciliationService');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
    client.paystack.reset();
});

function seedFundedMilestone() {
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
        })
    );
}

async function requestMilestoneRelease() {
    return releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
    });
}

async function failFirstAttempt() {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider({
        outcomes: {
            [`${RELEASE_ID}:1`]: {
                outcome: 'failed',
                failureReason: 'simulated_decline',
            },
        },
    });
    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider,
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(provider.calls.length, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'failed');
    return provider;
}

async function authorizeRetry(overrides = {}) {
    return reconciliation.authorizeRetry(
        RELEASE_ID,
        {
            reason: 'provider confirmed the decline; retry is permitted',
            evidence: {
                source: 'provider_reconciliation',
                reference: 'retry-evidence-1',
            },
            ...overrides,
        },
        ADMIN
    );
}

function eventCount(type) {
    return Object.values(client.readAll('releaseEvents')).filter(
        (event) => event.eventType === type
    ).length;
}

function assertNoProviderCall(provider) {
    assert.equal(provider.calls.length, 0);
    assert.equal(client.paystack.calls.length, 0);
}

function assertOnlyFirstAttempt() {
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).attemptCount, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'failed');
}

test('an initial submission does not require a retry authorization', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider,
    });

    assert.equal(result.submitted, true);
    assert.equal(result.attemptNumber, 1);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(provider.calls.length, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
    assert.equal(
        client.readDoc('releaseRequests', RELEASE_ID).retryAuthorizationStatus,
        undefined
    );
});

test('a retry without authorization is refused before any provider call', async () => {
    await failFirstAttempt();
    const retryProvider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'retry-authorization-missing');
    assertNoProviderCall(retryProvider);
    assertOnlyFirstAttempt();
});

test('a retry requires the authorizing actor UID from the trusted caller', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const retryProvider = createSimulatedReleaseProvider();

    const missingActor = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
    });
    assert.equal(missingActor.submitted, false);
    assert.equal(missingActor.reason, 'retry-actor-required');

    const wrongActor = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: 'someone-else',
    });
    assert.equal(wrongActor.submitted, false);
    assert.equal(wrongActor.reason, 'retry-authorization-actor-mismatch');

    const release = client.readDoc('releaseRequests', RELEASE_ID);
    assert.equal(release.retryAuthorizationStatus, 'authorized');
    assert.equal(release.retryAuthorizationConsumedAt, null);
    assertNoProviderCall(retryProvider);
    assertOnlyFirstAttempt();
});

test('a valid retry authorization is validated, consumed, and creates one attempt', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const retryProvider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(result.submitted, true);
    assert.equal(result.attemptNumber, 2);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(retryProvider.calls.length, 1);

    const release = client.readDoc('releaseRequests', RELEASE_ID);
    assert.equal(release.status, 'succeeded');
    assert.equal(release.retryAuthorizationStatus, 'consumed');
    assert.equal(release.retryAuthorizationConsumedBy, ADMIN.uid);
    assert.equal(release.retryAuthorizationConsumedForAttemptNumber, 2);
    assert.equal(release.retryAuthorizationConsumedByAttemptId, ATTEMPT_2);
    assert.equal(release.retryAuthorizationFailedAttemptId, ATTEMPT_1);
    assert.equal(release.retryAuthorizationTargetAttemptNumber, 2);
    assert.equal(
        client.readDoc('releaseAttempts', ATTEMPT_2).status,
        'succeeded'
    );
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 2);
    assert.equal(eventCount('release_retry_authorized'), 1);
    assert.equal(eventCount('release_retry_authorization_validated'), 1);
    assert.equal(eventCount('release_retry_authorization_consumed'), 1);

    const consumed = Object.values(client.readAll('releaseEvents')).find(
        (event) => event.eventType === 'release_retry_authorization_consumed'
    );
    assert.equal(consumed.authorizedBy, ADMIN.uid);
    assert.equal(consumed.failedAttemptId, ATTEMPT_1);
    assert.equal(consumed.targetAttemptNumber, 2);
    assert.equal(consumed.reason, 'provider confirmed the decline; retry is permitted');
    assert.equal(consumed.evidence.reference, 'retry-evidence-1');
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
});

test('two concurrent retries consume one authorization and make one provider call', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const retryProvider = createSimulatedReleaseProvider();

    const results = await Promise.all([
        orchestration.submitReleaseAttempt(RELEASE_ID, {
            provider: retryProvider,
            retryActorUid: ADMIN.uid,
        }),
        orchestration.submitReleaseAttempt(RELEASE_ID, {
            provider: retryProvider,
            retryActorUid: ADMIN.uid,
        }),
        orchestration.submitReleaseAttempt(RELEASE_ID, {
            provider: retryProvider,
            retryActorUid: ADMIN.uid,
        }),
    ]);

    assert.equal(results.filter((result) => result.submitted).length, 1);
    assert.equal(retryProvider.calls.length, 1);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 2);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
    assert.equal(
        client.readDoc('releaseRequests', RELEASE_ID).retryAuthorizationStatus,
        'consumed'
    );
    assert.equal(eventCount('release_retry_authorization_validated'), 1);
    assert.equal(eventCount('release_retry_authorization_consumed'), 1);
});

test('replaying a consumed authorization cannot create another attempt', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const retryProvider = createSimulatedReleaseProvider({
        outcomes: {
            [`${RELEASE_ID}:2`]: {
                outcome: 'failed',
                failureReason: 'retry_declined',
            },
        },
    });

    const first = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });
    assert.equal(first.submitted, true);
    assert.equal(first.outcome, 'failed');
    assert.equal(retryProvider.calls.length, 1);

    const replay = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(replay.submitted, false);
    assert.equal(replay.reason, 'retry-authorization-consumed');
    assert.equal(retryProvider.calls.length, 1);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 2);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'failed');
    assert.equal(
        client.readDoc('releaseRequests', RELEASE_ID).retryAuthorizationStatus,
        'consumed'
    );
});

test('authorization bound to a different release is rejected', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    client.seed('releaseRequests', RELEASE_ID, {
        ...release,
        retryAuthorizationReleaseId: 'rel_another_release',
    });
    const retryProvider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'retry-authorization-release-mismatch');
    assertNoProviderCall(retryProvider);
    assertOnlyFirstAttempt();
});

test('authorization bound to the wrong failed attempt is rejected', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    client.seed('releaseRequests', RELEASE_ID, {
        ...release,
        retryAuthorizationFailedAttemptId: `${RELEASE_ID}__attempt_9`,
    });
    const retryProvider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'retry-authorization-attempt-mismatch');
    assertNoProviderCall(retryProvider);
    assertOnlyFirstAttempt();
});

test('authorization for the wrong target attempt number is rejected', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    client.seed('releaseRequests', RELEASE_ID, {
        ...release,
        retryAuthorizationTargetAttemptNumber: 3,
    });
    const retryProvider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'retry-authorization-attempt-number-mismatch');
    assertNoProviderCall(retryProvider);
    assertOnlyFirstAttempt();
});

test('authorization missing definitive-failure evidence is rejected', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    client.seed('releaseRequests', RELEASE_ID, {
        ...release,
        retryAuthorizationReference: '',
    });
    const retryProvider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'retry-authorization-evidence-missing');
    assertNoProviderCall(retryProvider);
    assertOnlyFirstAttempt();
});

test('a stale authorization is rejected after the release leaves definitive failure', async () => {
    await failFirstAttempt();
    await authorizeRetry();
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    client.seed('releaseRequests', RELEASE_ID, {
        ...release,
        status: 'needs_review',
    });
    const retryProvider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'not-claimable');
    assertNoProviderCall(retryProvider);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
});

test('an unknown outcome cannot be authorized or submitted as a retry', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const unknownProvider = createSimulatedReleaseProvider({
        defaultOutcome: 'unknown',
    });
    const first = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: unknownProvider,
    });
    assert.equal(first.outcome, 'unknown');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');

    await assert.rejects(
        () =>
            authorizeRetry({
                reason: 'must not be allowed after an unknown outcome',
            }),
        (error) => error.code === 'RELEASE_RECONCILIATION_STATE'
    );

    const retryProvider = createSimulatedReleaseProvider();
    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: retryProvider,
        retryActorUid: ADMIN.uid,
    });
    assert.equal(result.submitted, false);
    assert.equal(result.reason, 'not-claimable');
    assertNoProviderCall(retryProvider);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
});
