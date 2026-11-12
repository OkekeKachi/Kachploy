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
let releaseRepository;
let releaseLedger;

const RELEASE_ID = 'rel_ms-1';
const CONTRACT_RELEASE_ID = 'rel_contract_emp-1';
const ADMIN = Object.freeze({ uid: 'admin-1', admin: true });

test.before(async () => {
    client = await startTestServer();
    releaseService = require('../services/releaseService');
    orchestration = require('../services/releaseOrchestrationService');
    reconciliation = require('../services/releaseReconciliationService');
    releaseRepository = require('../repositories/releaseRepository');
    releaseLedger = require('../services/releaseLedger');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
    client.paystack.reset();
});

const expectCode = (code) => (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
};

function seedFundedMilestone({ paymentOverrides = {}, taskOverrides = {} } = {}) {
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
            ...paymentOverrides,
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

function seedFundedContract() {
    client.seed('employments', 'emp-1', employment({ status: 'active' }));
    client.seed(
        'contracts',
        'emp-1',
        contract({
            paymentMode: 'full',
            status: 'active',
            totalAmountMinor: 1500000,
        })
    );
    const record = payment({
        paymentTarget: 'contract',
        contractId: 'emp-1',
        employmentId: 'emp-1',
        employerId: 'employer-1',
        employeeId: 'employee-1',
        amountMinor: 1500000,
        currency: 'NGN',
        status: 'paid',
    });
    delete record.milestoneId;
    client.seed('payments', 'contract_emp-1', record);
    client.seed(
        'tasks',
        'task-1',
        task({ employmentId: 'emp-1', status: 'approved' })
    );
}

async function requestMilestoneRelease() {
    return releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
    });
}

function eventTypes() {
    return Object.values(client.readAll('releaseEvents')).map((event) => event.eventType);
}

test('submission requires an injected provider before claiming an attempt', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();

    await assert.rejects(
        () => orchestration.submitReleaseAttempt(RELEASE_ID),
        expectCode('RELEASE_PROVIDER_NOT_CONFIGURED')
    );

    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 0);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'requested');
});

test('a successful simulated release records truthful state, events and no ledger posting', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const paymentBefore = client.readDoc('payments', 'ms-1');
    const taskBefore = client.readDoc('tasks', 'task-1');
    const provider = createSimulatedReleaseProvider({
        outcomes: {
            [RELEASE_ID]: {
                outcome: 'succeeded',
                providerReference: 'sim-release-ref-1',
            },
        },
    });

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    assert.equal(result.submitted, true);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.applied, true);
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].idempotencyKey, `${RELEASE_ID}__attempt_1`);
    assert.equal(provider.calls[0].amountMinor, 500000);

    const release = client.readDoc('releaseRequests', RELEASE_ID);
    const attempt = client.readDoc('releaseAttempts', `${RELEASE_ID}__attempt_1`);
    assert.equal(release.status, 'succeeded');
    assert.equal(release.attemptCount, 1);
    assert.equal(release.currentAttemptId, `${RELEASE_ID}__attempt_1`);
    assert.equal(attempt.status, 'succeeded');
    assert.equal(attempt.providerReference, 'sim-release-ref-1');
    assert.equal(attempt.providerId, 'simulated-release-provider');

    assert.deepEqual(client.readDoc('payments', 'ms-1'), paymentBefore);
    assert.deepEqual(client.readDoc('tasks', 'task-1'), taskBefore);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
    assert.equal(client.paystack.calls.length, 0);

    const types = eventTypes();
    assert.equal(types.filter((type) => type === 'release_requested').length, 1);
    assert.equal(types.filter((type) => type === 'release_attempt_created').length, 1);
    assert.equal(
        types.filter((type) => type === 'release_attempt_submission_claimed').length,
        1
    );
    assert.equal(
        types.filter((type) => type === 'release_attempt_outcome_recorded').length,
        1
    );
    assert.equal(types.filter((type) => type === 'release_state_changed').length, 2);
});

test('a full-contract release uses the contract payment authority', async () => {
    seedFundedContract();
    await releaseService.createReleaseRequest({
        targetType: 'contract',
        targetId: 'emp-1',
    });
    const provider = createSimulatedReleaseProvider();

    const result = await orchestration.submitReleaseAttempt(CONTRACT_RELEASE_ID, {
        provider,
    });

    assert.equal(result.submitted, true);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(provider.calls[0].paymentId, 'contract_emp-1');
    assert.equal(provider.calls[0].targetId, 'emp-1');
    assert.equal(client.readDoc('releaseRequests', CONTRACT_RELEASE_ID).status, 'succeeded');
});

test('duplicate calls after success do not call the provider again', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider();

    const first = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });
    const second = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    assert.equal(first.submitted, true);
    assert.equal(second.submitted, false);
    assert.equal(second.reason, 'not-claimable');
    assert.equal(provider.calls.length, 1);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
});

test('concurrent submission resolves to one claim and one provider call', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider();

    const results = await Promise.all([
        orchestration.submitReleaseAttempt(RELEASE_ID, { provider }),
        orchestration.submitReleaseAttempt(RELEASE_ID, { provider }),
        orchestration.submitReleaseAttempt(RELEASE_ID, { provider }),
    ]);

    assert.equal(results.filter((result) => result.submitted).length, 1);
    assert.equal(provider.calls.length, 1);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
});

test('a definitive failure is recorded and an explicit retry uses a new attempt id', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider({
        outcomes: {
            [`${RELEASE_ID}:1`]: {
                outcome: 'failed',
                failureReason: 'simulated_decline',
            },
            [`${RELEASE_ID}:2`]: {
                outcome: 'succeeded',
                providerReference: 'sim-retry-ref',
            },
        },
    });

    const first = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });
    assert.equal(first.outcome, 'failed');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'failed');
    assert.equal(
        client.readDoc('releaseAttempts', `${RELEASE_ID}__attempt_1`).status,
        'failed'
    );

    await reconciliation.authorizeRetry(
        RELEASE_ID,
        {
            reason: 'provider confirmed the decline; a new attempt is permitted',
            evidence: {
                source: 'provider_reconciliation',
                reference: 'recon-ref-1',
            },
        },
        ADMIN
    );

    const second = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider,
        retryActorUid: ADMIN.uid,
    });
    assert.equal(second.outcome, 'succeeded');
    assert.equal(second.attemptNumber, 2);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
    assert.equal(
        client.readDoc('releaseRequests', RELEASE_ID).retryAuthorizationStatus,
        'consumed'
    );
    assert.equal(
        client.readDoc('releaseAttempts', `${RELEASE_ID}__attempt_2`).status,
        'succeeded'
    );
    assert.equal(provider.calls.length, 2);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 2);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
});

test('an unknown outcome is preserved for review and is not retried automatically', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'unknown' });

    const first = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });
    const second = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    assert.equal(first.outcome, 'unknown');
    assert.equal(first.applied, true);
    assert.equal(second.submitted, false);
    assert.equal(second.reason, 'not-claimable');
    assert.equal(provider.calls.length, 1);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
    assert.equal(
        client.readDoc('releaseAttempts', `${RELEASE_ID}__attempt_1`).status,
        'unknown'
    );
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
});

test('provider exceptions and uninterpretable responses are recorded as unknown', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();

    const throwing = createSimulatedReleaseProvider({ defaultOutcome: 'throw' });
    const thrown = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: throwing,
    });
    assert.equal(thrown.outcome, 'unknown');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');

    client.fake.resetAll();
    client.paystack.reset();
    seedFundedMilestone();
    await requestMilestoneRelease();
    const malformed = {
        async submitRelease() {
            return { outcome: 'succeeded' };
        },
    };
    const invalid = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: malformed,
    });
    assert.equal(invalid.outcome, 'unknown');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');
});

test('sanitized provider error details are persisted with an unknown outcome', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = {
        async submitRelease() {
            return {
                outcome: 'unknown',
                failureReason: 'PAYSTACK_PROVIDER_ERROR',
                providerError: {
                    statusCode: 400,
                    message: 'Could not resolve account 0123456789',
                    type: 'validation_error',
                    operation: 'createRecipient',
                },
            };
        },
    };

    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    assert.equal(result.outcome, 'unknown');
    const expected = {
        statusCode: 400,
        message: 'Could not resolve account [redacted]',
        type: 'validation_error',
        operation: 'createRecipient',
    };
    assert.deepEqual(
        client.readDoc('releaseAttempts', `${RELEASE_ID}__attempt_1`).providerError,
        expected
    );
    assert.deepEqual(
        client.readDoc('releaseRequests', RELEASE_ID).lastProviderError,
        expected
    );
    const outcomeEvent = Object.values(client.readAll('releaseEvents')).find(
        (event) => event.eventType === 'release_attempt_outcome_recorded'
    );
    assert.deepEqual(outcomeEvent.providerError, expected);
});

test('trusted evidence explicitly resolves review and never comes from a bare boolean', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'unknown' });
    await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    await assert.rejects(
        () =>
            orchestration.resolveRelease(RELEASE_ID, {
                outcome: 'succeeded',
                explicitResolution: true,
            }),
        expectCode('RELEASE_INVALID_RESOLUTION')
    );
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');

    const result = await orchestration.resolveRelease(RELEASE_ID, {
        outcome: 'succeeded',
        actor: 'admin-1',
        evidence: {
            source: 'provider_reconciliation',
            reference: 'simulated-reconciliation-ref',
        },
    });

    assert.equal(result.resolved, true);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).resolvedBy, 'admin-1');
    assert.equal(
        client.readDoc('releaseAttempts', `${RELEASE_ID}__attempt_1`).status,
        'succeeded'
    );
    assert.equal(provider.calls.length, 1);

    const resolved = Object.values(client.readAll('releaseEvents')).find(
        (event) => event.eventType === 'release_resolved'
    );
    assert.equal(resolved.actor, 'admin-1');
    assert.equal(resolved.evidence.reference, 'simulated-reconciliation-ref');
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
});

test('resolution is refused outside review and cannot be applied twice', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();

    await assert.rejects(
        () =>
            orchestration.resolveRelease(RELEASE_ID, {
                outcome: 'failed',
                actor: 'admin-1',
                evidence: { source: 'provider', reference: 'ref-1' },
            }),
        expectCode('RELEASE_NOT_IN_REVIEW')
    );

    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'unknown' });
    await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    await orchestration.resolveRelease(RELEASE_ID, {
        outcome: 'failed',
        actor: 'admin-1',
        evidence: { source: 'provider', reference: 'ref-1' },
    });

    await assert.rejects(
        () =>
            orchestration.resolveRelease(RELEASE_ID, {
                outcome: 'succeeded',
                actor: 'admin-2',
                evidence: { source: 'provider', reference: 'ref-2' },
            }),
        expectCode('RELEASE_NOT_IN_REVIEW')
    );
});

test('submission revalidates authoritative funding before claiming', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const payment = client.readDoc('payments', 'ms-1');
    payment.status = 'created';
    client.seed('payments', 'ms-1', payment);

    const provider = createSimulatedReleaseProvider();
    await assert.rejects(
        () => orchestration.submitReleaseAttempt(RELEASE_ID, { provider }),
        expectCode('RELEASE_FUNDING_NOT_CONFIRMED')
    );

    assert.equal(provider.calls.length, 0);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 0);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'requested');
});

test('submission revalidates eligibility before claiming', async () => {
    seedFundedMilestone({ taskOverrides: { status: 'assigned' } });
    await requestMilestoneRelease();
    const provider = createSimulatedReleaseProvider();

    await assert.rejects(
        () => orchestration.submitReleaseAttempt(RELEASE_ID, { provider }),
        expectCode('RELEASE_NOT_ELIGIBLE')
    );

    assert.equal(provider.calls.length, 0);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 0);
});

test('submission rejects a release whose identity no longer matches funding', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();
    const release = client.readDoc('releaseRequests', RELEASE_ID);
    release.amountMinor = 1;
    client.seed('releaseRequests', RELEASE_ID, release);

    const provider = createSimulatedReleaseProvider();
    await assert.rejects(
        () => orchestration.submitReleaseAttempt(RELEASE_ID, { provider }),
        expectCode('RELEASE_INCONSISTENT_RECORD')
    );
    assert.equal(provider.calls.length, 0);
});

test('attempt creation validates release id, attempt number and initial status', async () => {
    seedFundedMilestone();
    await requestMilestoneRelease();

    await assert.rejects(
        () =>
            releaseRepository.createAttemptIfAbsent(RELEASE_ID, 1, {
                releaseId: 'rel_someone_else',
                attemptNumber: 1,
                status: 'created',
            }),
        (error) => error instanceof TypeError
    );
    await assert.rejects(
        () =>
            releaseRepository.createAttemptIfAbsent(RELEASE_ID, 1, {
                releaseId: RELEASE_ID,
                attemptNumber: 2,
                status: 'created',
            }),
        (error) => error instanceof TypeError
    );
    await assert.rejects(
        () =>
            releaseRepository.createAttemptIfAbsent(RELEASE_ID, 1, {
                releaseId: RELEASE_ID,
                attemptNumber: 1,
                status: 'submitted',
            }),
        (error) => error instanceof TypeError
    );

    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 0);
});

test('the ledger entry type allowlist rejects payout claims from simulated stages', () => {
    const base = {
        releaseId: RELEASE_ID,
        direction: 'credit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'employee_payable',
    };

    assert.throws(
        () =>
            releaseLedger.buildLedgerEntry({
                ...base,
                entryType: 'release_paid_out',
            }),
        (error) => error.code === 'RELEASE_INVALID_LEDGER_ENTRY'
    );
    assert.throws(
        () =>
            releaseLedger.buildLedgerEntry({
                ...base,
                entryType: 'provider_payout',
            }),
        (error) => error.code === 'RELEASE_INVALID_LEDGER_ENTRY'
    );

    assert.doesNotThrow(() =>
        releaseLedger.buildLedgerEntry({
            ...base,
            entryType: 'release_payable',
        })
    );
});
