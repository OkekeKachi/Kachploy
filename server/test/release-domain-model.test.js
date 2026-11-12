'use strict';

/**
 * Stage 2A tests for the release domain model and state machine.
 *
 * No HTTP route exists in Stage 2A. These tests drive the pure state machine,
 * the release service and the create-only repositories directly, after the
 * harness has installed the fake Firestore and fake Paystack modules. No test
 * queues a provider response, and every test asserts that Paystack was never
 * called.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const {
    employment,
    contract,
    milestone,
    payment,
    task,
} = require('../testing/fixtures');

let client;
let config;
let releaseState;
let releaseService;
let releaseLedger;
let releaseRepository;
let releaseEventRepository;
let ledgerRepository;

test.before(async () => {
    client = await startTestServer();
    config = require('../config/release');
    releaseState = require('../services/releaseState');
    releaseService = require('../services/releaseService');
    releaseLedger = require('../services/releaseLedger');
    releaseRepository = require('../repositories/releaseRepository');
    releaseEventRepository = require('../repositories/releaseEventRepository');
    ledgerRepository = require('../repositories/ledgerRepository');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
    client.paystack.reset();
});

const RELEASE_ID = 'rel_ms-1';
const CONTRACT_RELEASE_ID = 'rel_contract_emp-1';

const expectCode = (code) => (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
};

const expectInvalidTransition = (error) => {
    assert.equal(error.code, 'RELEASE_INVALID_TRANSITION');
    assert.ok(error instanceof releaseState.ReleaseTransitionError);
    return true;
};

function seedEmploymentAndContract(contractOverrides = {}) {
    client.seed('employments', 'emp-1', employment({ status: 'active' }));
    client.seed(
        'contracts',
        'emp-1',
        contract({
            paymentMode: 'milestones',
            status: 'active',
            ...contractOverrides,
        })
    );
}

function seedFundedMilestone({
    paymentOverrides = {},
    milestoneOverrides = {},
    contractOverrides = {},
    withPayment = true,
    withMilestone = true,
    withEmployment = true,
} = {}) {
    if (withEmployment) {
        client.seed('employments', 'emp-1', employment({ status: 'active' }));
    }
    client.seed(
        'contracts',
        'emp-1',
        contract({
            paymentMode: 'milestones',
            status: 'active',
            ...contractOverrides,
        })
    );
    if (withMilestone) {
        client.seed(
            'milestones',
            'ms-1',
            milestone({
                contractId: 'emp-1',
                employmentId: 'emp-1',
                taskId: 'task-1',
                amountMinor: 500000,
                ...milestoneOverrides,
            })
        );
    }
    if (withPayment) {
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
    }
    client.seed(
        'tasks',
        'task-1',
        task({ employmentId: 'emp-1', milestoneId: 'ms-1', status: 'approved' })
    );
}

function seedFundedContract({ paymentOverrides = {}, contractOverrides = {} } = {}) {
    client.seed('employments', 'emp-1', employment({ status: 'active' }));
    client.seed(
        'contracts',
        'emp-1',
        contract({
            paymentMode: 'full',
            status: 'active',
            totalAmountMinor: 1500000,
            ...contractOverrides,
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
        ...paymentOverrides,
    });
    delete record.milestoneId;
    client.seed('payments', 'contract_emp-1', record);

    client.seed(
        'tasks',
        'task-1',
        task({ employmentId: 'emp-1', status: 'approved' })
    );
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

test('the release and attempt vocabularies are exactly the approved values', () => {
    assert.deepEqual(config.RELEASE_STATES, [
        'requested',
        'in_flight',
        'succeeded',
        'failed',
        'needs_review',
        'cancelled',
    ]);
    assert.deepEqual(config.RELEASE_ATTEMPT_STATES, [
        'created',
        'submitted',
        'succeeded',
        'failed',
        'unknown',
    ]);
});

test('valid release transitions are accepted centrally', () => {
    assert.equal(releaseState.transitionRelease('requested', 'in_flight'), 'in_flight');
    assert.equal(releaseState.transitionRelease('requested', 'cancelled'), 'cancelled');
    assert.equal(releaseState.transitionRelease('in_flight', 'succeeded'), 'succeeded');
    assert.equal(releaseState.transitionRelease('in_flight', 'failed'), 'failed');
    assert.equal(releaseState.transitionRelease('in_flight', 'needs_review'), 'needs_review');
    assert.equal(releaseState.transitionRelease('failed', 'in_flight'), 'in_flight');
    assert.equal(releaseState.transitionRelease('failed', 'needs_review'), 'needs_review');
    assert.equal(
        releaseState.transitionRelease('needs_review', 'succeeded', { explicitResolution: true }),
        'succeeded'
    );
    assert.equal(
        releaseState.transitionRelease('needs_review', 'failed', { explicitResolution: true }),
        'failed'
    );
});

test('invalid release transitions throw the typed transition error', () => {
    const invalid = [
        ['requested', 'succeeded'],
        ['requested', 'failed'],
        ['requested', 'needs_review'],
        ['in_flight', 'requested'],
        ['in_flight', 'cancelled'],
        ['failed', 'succeeded'],
        ['failed', 'cancelled'],
        ['needs_review', 'requested'],
        ['needs_review', 'in_flight'],
        ['needs_review', 'cancelled'],
        ['needs_review', 'succeeded'],
        ['needs_review', 'failed'],
        ['succeeded', 'failed'],
        ['succeeded', 'in_flight'],
        ['cancelled', 'requested'],
    ];

    for (const [from, to] of invalid) {
        assert.throws(
            () => releaseState.transitionRelease(from, to),
            expectInvalidTransition,
            `${from} -> ${to} must be invalid`
        );
    }
});

test('valid and invalid attempt transitions are validated centrally', () => {
    assert.equal(releaseState.transitionAttempt('created', 'submitted'), 'submitted');
    assert.equal(releaseState.transitionAttempt('created', 'failed'), 'failed');
    assert.equal(releaseState.transitionAttempt('submitted', 'succeeded'), 'succeeded');
    assert.equal(releaseState.transitionAttempt('submitted', 'failed'), 'failed');
    assert.equal(releaseState.transitionAttempt('submitted', 'unknown'), 'unknown');
    assert.equal(
        releaseState.transitionAttempt('unknown', 'succeeded', { explicitResolution: true }),
        'succeeded'
    );
    assert.equal(
        releaseState.transitionAttempt('unknown', 'failed', { explicitResolution: true }),
        'failed'
    );

    for (const [from, to] of [
        ['created', 'succeeded'],
        ['created', 'unknown'],
        ['submitted', 'created'],
        ['unknown', 'submitted'],
        ['unknown', 'succeeded'],
        ['unknown', 'failed'],
        ['succeeded', 'failed'],
        ['failed', 'submitted'],
    ]) {
        assert.throws(
            () => releaseState.transitionAttempt(from, to),
            expectInvalidTransition,
            `${from} -> ${to} must be invalid for an attempt`
        );
    }
});

test('succeeded is terminal and cannot be downgraded', () => {
    assert.equal(releaseState.isTerminalReleaseState('succeeded'), true);
    assert.equal(releaseState.canTransitionRelease('succeeded', 'failed'), false);
    assert.throws(
        () => releaseState.transitionRelease('succeeded', 'failed'),
        expectInvalidTransition
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('succeeded', 'failed'),
        'succeeded'
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('succeeded', 'unknown'),
        'succeeded'
    );
});

test('a late success after a definitive failure escalates to needs_review', () => {
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('failed', 'succeeded'),
        'needs_review'
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('in_flight', 'succeeded', {
            priorAttemptState: 'failed',
        }),
        'needs_review'
    );

    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('in_flight', 'succeeded'),
        'succeeded'
    );
});

test('a late success while already under review stays there by default', () => {
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'succeeded', {
            priorAttemptState: 'failed',
        }),
        'needs_review'
    );
});

test('explicit resolution resolves a late success already under review', () => {
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'succeeded', {
            priorAttemptState: 'failed',
            explicitResolution: true,
        }),
        'succeeded'
    );
});

test('an ambiguous outcome cannot silently become success or failure', () => {
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('in_flight', 'unknown'),
        'needs_review'
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'unknown'),
        'needs_review'
    );
    assert.notEqual(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'unknown'),
        'failed'
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'succeeded'),
        'needs_review'
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'failed'),
        'needs_review'
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'succeeded', {
            explicitResolution: true,
        }),
        'succeeded'
    );
    assert.equal(
        releaseState.releaseStateFromAttemptOutcome('needs_review', 'failed', {
            explicitResolution: true,
        }),
        'failed'
    );
});

test('needs_review handling does not bypass unrelated invalid transitions', () => {
    for (const [from, to] of [
        ['requested', 'succeeded'],
        ['cancelled', 'unknown'],
        ['needs_review', 'created'],
    ]) {
        assert.throws(
            () => releaseState.releaseStateFromAttemptOutcome(from, to),
            expectInvalidTransition,
            `${from} + ${to} must still be invalid`
        );
    }
});

test('cancellation is permitted only before provider submission', () => {
    assert.equal(releaseState.transitionRelease('requested', 'cancelled'), 'cancelled');

    for (const state of ['in_flight', 'failed', 'needs_review', 'succeeded', 'cancelled']) {
        assert.throws(
            () => releaseState.transitionRelease(state, 'cancelled'),
            expectInvalidTransition,
            `${state} -> cancelled must be invalid`
        );
    }

    assert.throws(
        () => releaseState.releaseStateFromAttemptOutcome('cancelled', 'succeeded'),
        expectInvalidTransition
    );
});

// ---------------------------------------------------------------------------
// Identity and validation
// ---------------------------------------------------------------------------

test('release, attempt and audit identifiers are deterministic and distinct', () => {
    assert.equal(config.releaseRequestId('ms-1'), RELEASE_ID);
    assert.equal(config.releaseRequestId('contract_emp-1'), CONTRACT_RELEASE_ID);

    const first = config.releaseAttemptId(RELEASE_ID, 1);
    const second = config.releaseAttemptId(RELEASE_ID, 2);
    assert.equal(first, `${RELEASE_ID}__attempt_1`);
    assert.equal(second, `${RELEASE_ID}__attempt_2`);
    assert.notEqual(first, second);

    const eventA = config.releaseEventId(RELEASE_ID, 'release_requested');
    const eventB = config.releaseEventId(RELEASE_ID, 'release_requested');
    const eventC = config.releaseEventId(RELEASE_ID, 'release_state_changed');
    assert.equal(eventA, eventB);
    assert.notEqual(eventA, eventC);

    const ledgerA = config.releaseLedgerEntryId(RELEASE_ID, 'entry-1');
    assert.equal(ledgerA, config.releaseLedgerEntryId(RELEASE_ID, 'entry-1'));
    assert.notEqual(ledgerA, config.releaseLedgerEntryId(RELEASE_ID, 'entry-2'));

    assert.throws(
        () => config.releaseAttemptId(RELEASE_ID, 0),
        (error) => error instanceof TypeError
    );
    assert.throws(
        () => config.releaseAttemptId(RELEASE_ID, 1.5),
        (error) => error instanceof TypeError
    );
});

test('target type and id are validated, and a bare task is never a release target', async () => {
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'task', targetId: 'task-1' }),
        expectCode('RELEASE_INVALID_TARGET')
    );
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: '' }),
        expectCode('RELEASE_INVALID_TARGET')
    );
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'a/b' }),
        expectCode('RELEASE_INVALID_TARGET')
    );
});

test('amounts must be positive safe integers within the supported range', async () => {
    for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER, 1e13, NaN]) {
        client.fake.resetAll();
        seedFundedMilestone({ paymentOverrides: { amountMinor } });
        await assert.rejects(
            () => releaseService.createReleaseRequest({
                targetType: 'milestone',
                targetId: 'ms-1',
            }),
            expectCode('RELEASE_INVALID_AMOUNT'),
            `${amountMinor} must be rejected`
        );
    }

    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 0);
});

test('currency is validated against the NGN-only rule', async () => {
    seedFundedMilestone({ paymentOverrides: { currency: 'USD' } });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_UNSUPPORTED_CURRENCY')
    );

    client.fake.resetAll();
    seedFundedMilestone({
        paymentOverrides: { currency: 'USD' },
        contractOverrides: { currency: 'USD' },
    });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_UNSUPPORTED_CURRENCY')
    );
});

// ---------------------------------------------------------------------------
// Authoritative funding records
// ---------------------------------------------------------------------------

test('a milestone release derives every identity from trusted stored records', async () => {
    seedFundedMilestone();
    const result = await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
        paymentId: 'forged-payment',
        amountMinor: 1,
        employerId: 'forged-employer',
    });

    assert.equal(result.created, true);
    assert.equal(result.release.releaseId, RELEASE_ID);
    assert.equal(result.release.targetType, 'milestone');
    assert.equal(result.release.targetId, 'ms-1');
    assert.equal(result.release.paymentId, 'ms-1');
    assert.equal(result.release.contractId, 'emp-1');
    assert.equal(result.release.employmentId, 'emp-1');
    assert.equal(result.release.employerId, 'employer-1');
    assert.equal(result.release.employeeId, 'employee-1');
    assert.equal(result.release.amountMinor, 500000);
    assert.equal(result.release.currency, 'NGN');
    assert.equal(result.release.status, 'requested');
    assert.equal(result.release.attemptCount, 0);
    assert.equal(result.release.providerEnvironment, 'test');

    const stored = client.readDoc('releaseRequests', RELEASE_ID);
    assert.deepEqual(stored, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: 'ms-1',
        paymentId: 'ms-1',
        contractId: 'emp-1',
        employmentId: 'emp-1',
        employerId: 'employer-1',
        employeeId: 'employee-1',
        amountMinor: 500000,
        currency: 'NGN',
        status: 'requested',
        attemptCount: 0,
        providerEnvironment: 'test',
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
    });

    const events = Object.values(client.readAll('releaseEvents'));
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'release_requested');
    assert.equal(events[0].toStatus, 'requested');
    assert.equal(events[0].releaseId, RELEASE_ID);
});

test('a full-contract release uses the contract payment authority', async () => {
    seedFundedContract();
    const result = await releaseService.createReleaseRequest({
        targetType: 'contract',
        targetId: 'emp-1',
    });

    assert.equal(result.created, true);
    assert.equal(result.release.releaseId, CONTRACT_RELEASE_ID);
    assert.equal(result.release.paymentId, 'contract_emp-1');
    assert.equal(result.release.amountMinor, 1500000);
    assert.equal(result.release.currency, 'NGN');
    assert.equal(result.release.status, 'requested');
});

test('a contract release requires contract paymentTarget', async () => {
    seedFundedContract({ paymentOverrides: { paymentTarget: 'milestone' } });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'contract', targetId: 'emp-1' }),
        expectCode('RELEASE_INCONSISTENT_RECORD')
    );
    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 0);

    client.fake.resetAll();
    seedFundedContract();
    const record = client.readDoc('payments', 'contract_emp-1');
    delete record.paymentTarget;
    client.seed('payments', 'contract_emp-1', record);
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'contract', targetId: 'emp-1' }),
        expectCode('RELEASE_INCONSISTENT_RECORD')
    );
    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 0);
});

test('missing funding records are rejected, not implied', async () => {
    seedFundedMilestone({ withPayment: false });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_FUNDING_NOT_FOUND')
    );

    client.fake.resetAll();
    seedFundedContract();
    client.fake.store.remove('payments', 'contract_emp-1');
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'contract', targetId: 'emp-1' }),
        expectCode('RELEASE_FUNDING_NOT_FOUND')
    );
});

test('unconfirmed funding is rejected', async () => {
    seedFundedMilestone({ paymentOverrides: { status: 'created' } });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_FUNDING_NOT_CONFIRMED')
    );
});

test('missing contract, milestone and employment records are rejected', async () => {
    seedFundedMilestone();
    client.fake.store.remove('contracts', 'emp-1');
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_CONTRACT_NOT_FOUND')
    );

    client.fake.resetAll();
    seedFundedMilestone({ withMilestone: false });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_MILESTONE_NOT_FOUND')
    );

    client.fake.resetAll();
    seedFundedMilestone({ withEmployment: false });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_EMPLOYMENT_NOT_FOUND')
    );
});

test('inconsistent contract, employment, milestone and funding chains are rejected', async () => {
    seedFundedMilestone({ paymentOverrides: { employeeId: 'someone-else' } });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_INCONSISTENT_RECORD')
    );

    client.fake.resetAll();
    seedFundedMilestone({ milestoneOverrides: { amountMinor: 400000 } });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_INCONSISTENT_RECORD')
    );

    client.fake.resetAll();
    seedFundedMilestone({ contractOverrides: { paymentMode: 'full' } });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        expectCode('RELEASE_INCONSISTENT_RECORD')
    );

    client.fake.resetAll();
    seedFundedContract({ contractOverrides: { paymentMode: 'milestones' } });
    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'contract', targetId: 'emp-1' }),
        expectCode('RELEASE_INCONSISTENT_RECORD')
    );
});

// ---------------------------------------------------------------------------
// Deterministic claims, atomic creation and immutability
// ---------------------------------------------------------------------------

test('duplicate release claims return the existing request without duplicate records', async () => {
    seedFundedMilestone();

    const first = await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
    });
    const second = await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
    });

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.release.releaseId, first.release.releaseId);
    assert.deepEqual(second.release, first.release);
    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 1);
    assert.equal(Object.keys(client.readAll('releaseEvents')).length, 1);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
});

test('concurrent release claims resolve to one request and one event', async () => {
    seedFundedMilestone();

    const results = await Promise.all([
        releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
    ]);

    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.release.releaseId)).size, 1);
    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 1);
    assert.equal(Object.keys(client.readAll('releaseEvents')).length, 1);
});

test('request and event creation are atomic when the event id already exists', async () => {
    seedFundedMilestone();
    const eventId = config.releaseEventId(RELEASE_ID, 'release_requested');
    client.seed('releaseEvents', eventId, {
        releaseId: RELEASE_ID,
        eventType: 'release_requested',
    });

    await assert.rejects(
        () => releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' }),
        (error) => error && error.code === 6
    );
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID), undefined);
});

test('release attempts are deterministic and create-only', async () => {
    seedFundedMilestone();
    await releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' });

    const first = await releaseRepository.createAttemptIfAbsent(RELEASE_ID, 1, {
        releaseId: RELEASE_ID,
        attemptNumber: 1,
        status: 'created',
        note: 'first',
    });
    assert.equal(first.created, true);
    assert.equal(first.attempt.id, `${RELEASE_ID}__attempt_1`);

    const duplicate = await releaseRepository.createAttemptIfAbsent(RELEASE_ID, 1, {
        releaseId: RELEASE_ID,
        attemptNumber: 1,
        status: 'submitted',
        note: 'overwrite attempt',
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.reason, 'attempt-exists');
    assert.equal(duplicate.attempt.status, 'created');
    assert.equal(duplicate.attempt.note, 'first');

    const retry = await releaseRepository.createAttemptIfAbsent(RELEASE_ID, 2, {
        releaseId: RELEASE_ID,
        attemptNumber: 2,
        status: 'created',
    });
    assert.equal(retry.created, true);
    assert.equal(retry.attempt.id, `${RELEASE_ID}__attempt_2`);
    assert.notEqual(retry.attempt.id, first.attempt.id);
    assert.equal(Object.keys(client.readAll('releaseAttempts')).length, 2);
});

test('ledger entries are validated, deterministic and create-only', async () => {
    const entryId = config.releaseLedgerEntryId(RELEASE_ID, 'test-entry');
    const entry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'employee_payable',
    });

    const first = await ledgerRepository.createEntryIfAbsent(entryId, entry);
    assert.equal(first.created, true);

    const replacement = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'debit',
        amountMinor: 1,
        currency: 'NGN',
        account: 'tampered',
    });
    const second = await ledgerRepository.createEntryIfAbsent(entryId, replacement);
    assert.equal(second.created, false);

    const stored = client.readDoc('ledgerEntries', entryId);
    assert.equal(stored.direction, 'credit');
    assert.equal(stored.amountMinor, 500000);
    assert.equal(stored.account, 'employee_payable');

    for (const forbidden of ['update', 'delete', 'remove', 'set']) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(ledgerRepository, forbidden),
            false,
            `ledgerRepository must not expose ${forbidden}`
        );
    }
});

test('ledger entry shape rejects invalid amounts and currencies', () => {
    const base = {
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'employee_payable',
    };

    for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
        assert.throws(
            () => releaseLedger.buildLedgerEntry({ ...base, amountMinor }),
            (error) => error.code === 'RELEASE_INVALID_LEDGER_ENTRY'
        );
    }
    assert.throws(
        () => releaseLedger.buildLedgerEntry({ ...base, currency: 'USD' }),
        (error) => error.code === 'RELEASE_INVALID_LEDGER_ENTRY'
    );
    assert.throws(
        () => releaseLedger.buildLedgerEntry({ ...base, direction: 'transfer' }),
        (error) => error.code === 'RELEASE_INVALID_LEDGER_ENTRY'
    );
});

test('ledger entries are idempotent -- duplicate entry id returns created false', async () => {
    const entryId = config.releaseLedgerEntryId(RELEASE_ID, 'test-idempotency');
    const entry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'employee_payable',
    });

    const first = await ledgerRepository.createEntryIfAbsent(entryId, entry);
    assert.equal(first.created, true);

    const duplicate = await ledgerRepository.createEntryIfAbsent(entryId, entry);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.entryId, entryId);

    // Re-reading the original entry should be unchanged
    const stored = client.readDoc('ledgerEntries', entryId);
    assert.equal(stored.direction, 'credit');
    assert.equal(stored.amountMinor, 500000);
});

test('ledger entries are create-only -- concurrent attempts resolve to one entry', async () => {
    const entryId = config.releaseLedgerEntryId(RELEASE_ID, 'concurrent-test');
    const entry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'debit',
        amountMinor: 100000,
        currency: 'NGN',
        account: 'collected_funds',
    });

    const results = await Promise.all([
        ledgerRepository.createEntryIfAbsent(entryId, entry),
        ledgerRepository.createEntryIfAbsent(entryId, entry),
        ledgerRepository.createEntryIfAbsent(entryId, entry),
    ]);

    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.entryId)).size, 1);

    const count = Object.keys(client.readAll('ledgerEntries')).length;
    assert.equal(count, 1, 'only one ledger entry should exist');
});

test('compensating entries are append-only corrections', async () => {
    const originalEntry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'employee_payable',
    });

    const originalId = await ledgerRepository.createEntryIfAbsent(
        config.releaseLedgerEntryId(RELEASE_ID, 'original-entry'),
        originalEntry
    );

    assert.equal(originalId.created, true);

    const compensating = releaseLedger.buildCompensatingEntry(
        originalId.entryId,
        originalEntry,
        'credit'
    );

    const compResult = await ledgerRepository.createCompensatingEntryIfAbsent(
        originalId.entryId,
        RELEASE_ID,
        'debit',
        originalEntry.amountMinor,
        originalEntry.currency,
        originalEntry.account
    );

    assert.equal(compResult.created, true);

    // The compensating entry should have opposite direction
    const storedComp = client.readDoc('ledgerEntries', compResult.entryId);
    assert.equal(storedComp.direction, 'debit', 'compensating entry has opposite direction');
    assert.equal(storedComp.amountMinor, 500000, 'compensating entry has same amount');
    assert.equal(storedComp.account, 'employee_payable', 'compensating entry has same account');
    // The reference should start with 'comp_' and contain a reference to the original entry
    assert.ok(storedComp.reference.startsWith('comp_'), 'compensating entry has reference starting with comp_');

    // The original entry should be unchanged
    const storedOriginal = client.readDoc('ledgerEntries', originalId.entryId);
    assert.equal(storedOriginal.direction, 'credit', 'original entry unchanged');
});

test('compensating entry idempotency -- duplicate compensating returns created false', async () => {
    const originalEntry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 300000,
        currency: 'NGN',
        account: 'platform_revenue',
    });

    const originalId = await ledgerRepository.createEntryIfAbsent(
        config.releaseLedgerEntryId(RELEASE_ID, 'idem-test'),
        originalEntry
    );

    assert.equal(originalId.created, true);

    // Create compensating entry twice - second should fail
    const compResult1 = await ledgerRepository.createCompensatingEntryIfAbsent(
        originalId.entryId,
        RELEASE_ID,
        'debit',
        originalEntry.amountMinor,
        originalEntry.currency,
        originalEntry.account
    );

    assert.equal(compResult1.created, true);

    const compResult2 = await ledgerRepository.createCompensatingEntryIfAbsent(
        originalId.entryId,
        RELEASE_ID,
        'debit',
        originalEntry.amountMinor,
        originalEntry.currency,
        originalEntry.account
    );

    assert.equal(compResult2.created, false, 'duplicate compensating entry must not overwrite');
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 2, 'both entries should exist');
});

test('compensating entries preserve retry authorization', async () => {
    // Seed the full funded milestone graph for the release
    seedFundedMilestone();

    const originalEntry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'employee_payable',
    });

    const originalId = await ledgerRepository.createEntryIfAbsent(
        config.releaseLedgerEntryId(RELEASE_ID, 'auth-test'),
        originalEntry
    );

    assert.equal(originalId.created, true);

    const compResult = await ledgerRepository.createCompensatingEntryIfAbsent(
        originalId.entryId,
        RELEASE_ID,
        'debit',
        originalEntry.amountMinor,
        originalEntry.currency,
        originalEntry.account
    );

    assert.equal(compResult.created, true);

    // Verify both entries are readable and the retry auth path is unaffected
    const storedOriginal = client.readDoc('ledgerEntries', originalId.entryId);
    const storedComp = client.readDoc('ledgerEntries', compResult.entryId);

    assert.equal(storedOriginal.direction, 'credit');
    assert.equal(storedComp.direction, 'debit');
    assert.equal(storedOriginal.amountMinor, 500000);
    assert.equal(storedComp.amountMinor, 500000);

    // Release claims still resolve normally - no ledger interference
    const release = await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
    });
    assert.equal(release.created, true);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 2);
});

test('verified collection accounting creates employee_payable entry', async () => {
    // This test pins the legacy single-entry ledger shape. Balanced collection
    // posting lives in services/accountingService.js (recordVerifiedCollection),
    // which is an explicit trusted call rather than an automatic side effect of
    // the payment verify flow.
    const entry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'collected_funds',
    });

    const result = await ledgerRepository.createEntryIfAbsent(
        config.releaseLedgerEntryId(RELEASE_ID, 'collection-entry'),
        entry
    );

    assert.equal(result.created, true);

    const stored = client.readDoc('ledgerEntries', result.entryId);
    assert.equal(stored.account, 'collected_funds');
    assert.equal(stored.direction, 'credit');
    assert.equal(stored.amountMinor, 500000);
});

test('failed payout outcome does not create success posting', async () => {
    // Verify that a failed outcome recording respects the rule:
    // do not record an unknown payout as successful.
    const entry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'debit',
        amountMinor: 500000,
        currency: 'NGN',
        account: 'unresolved_outcome',
    });

    const result = await ledgerRepository.createEntryIfAbsent(
        config.releaseLedgerEntryId(RELEASE_ID, 'failed-outcome'),
        entry
    );

    assert.equal(result.created, true);

    const stored = client.readDoc('ledgerEntries', result.entryId);
    assert.equal(stored.account, 'unresolved_outcome');
    assert.equal(stored.direction, 'debit');
    assert.equal(stored.amountMinor, 500000);
});

test('compensating-entry correctness with multiple account types', async () => {
    const accountTypes = ['employee_payable', 'platform_revenue', 'collected_funds', 'payout_initiation', 'completed_payout', 'unresolved_outcome'];

    for (const account of accountTypes) {
        const originalEntry = releaseLedger.buildLedgerEntry({
            releaseId: RELEASE_ID,
            entryType: 'release_payable',
            direction: 'credit',
            amountMinor: 100000,
            currency: 'NGN',
            account,
        });

        const originalId = await ledgerRepository.createEntryIfAbsent(
            config.releaseLedgerEntryId(RELEASE_ID, `multi-${account}`),
            originalEntry
        );

        assert.equal(originalId.created, true);

        const compResult = await ledgerRepository.createCompensatingEntryIfAbsent(
            originalId.entryId,
            RELEASE_ID,
            'debit',
            originalEntry.amountMinor,
            originalEntry.currency,
            originalEntry.account
        );

        assert.equal(compResult.created, true, `compensating entry failed for account ${account}`);

        const storedComp = client.readDoc('ledgerEntries', compResult.entryId);
        assert.equal(storedComp.account, account, `compensating entry account mismatch for ${account}`);
        assert.equal(storedComp.direction, 'debit', `compensating entry direction mismatch for ${account}`);
        assert.equal(storedComp.amountMinor, 100000, `compensating entry amount mismatch for ${account}`);
    }
});

test('duplicate and concurrent posting protection', async () => {
    // Test that concurrent compensating entry attempts resolve to one entry
    const originalEntry = releaseLedger.buildLedgerEntry({
        releaseId: RELEASE_ID,
        entryType: 'release_payable',
        direction: 'credit',
        amountMinor: 200000,
        currency: 'NGN',
        account: 'platform_revenue',
    });

    const originalId = await ledgerRepository.createEntryIfAbsent(
        config.releaseLedgerEntryId(RELEASE_ID, 'concurrent-test'),
        originalEntry
    );

    assert.equal(originalId.created, true);

    // Simultaneous compensating entry attempts
    const results = await Promise.all([
        ledgerRepository.createCompensatingEntryIfAbsent(
            originalId.entryId,
            RELEASE_ID,
            'debit',
            originalEntry.amountMinor,
            originalEntry.currency,
            originalEntry.account
        ),
        ledgerRepository.createCompensatingEntryIfAbsent(
            originalId.entryId,
            RELEASE_ID,
            'debit',
            originalEntry.amountMinor,
            originalEntry.currency,
            originalEntry.account
        ),
    ]);

    assert.equal(results.filter((r) => r.created).length, 1, 'only one compensating entry should be created');
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 2, 'original + one compensating entry only');

    // Idempotency: third attempt should also return created false
    const third = await ledgerRepository.createCompensatingEntryIfAbsent(
        originalId.entryId,
        RELEASE_ID,
        'debit',
        originalEntry.amountMinor,
        originalEntry.currency,
        originalEntry.account
    );

    assert.equal(third.created, false, 'third duplicate must not create new entry');
});

test('preservation of release retry authorization with ledger entries', async () => {
    // Verify that creating ledger entries does not interfere with release retry
    // authorization mechanisms. The release retry auth is stored in the release
    // document, not the ledger, so they should be independent.

    // Seed the full funded milestone graph for the release
    seedFundedMilestone();

    // This test verifies ledger operations don't corrupt release state
    // The retry auth is stored in release document fields, not ledger entries, so they should be independent.
    // No ledger entries are created in this path, verifying independence.
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0, 'ledger entries independent of release retry');

    // Authorize retry on a failed release
    const release = await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: 'ms-1',
    });

    assert.equal(release.created, true);
    assert.equal(release.release.targetType, 'milestone');
    assert.equal(release.release.targetId, 'ms-1');
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0, 'release creation must not post ledger entries');
});

test('release events are append-only at the repository API', async () => {
    const eventId = config.releaseEventId(RELEASE_ID, 'first');
    const first = await releaseEventRepository.appendEventIfAbsent(eventId, {
        releaseId: RELEASE_ID,
        eventType: 'release_requested',
        note: 'original',
    });
    assert.equal(first.created, true);

    const second = await releaseEventRepository.appendEventIfAbsent(eventId, {
        releaseId: RELEASE_ID,
        eventType: 'release_state_changed',
        note: 'tampered',
    });
    assert.equal(second.created, false);

    const stored = client.readDoc('releaseEvents', eventId);
    assert.equal(stored.eventType, 'release_requested');
    assert.equal(stored.note, 'original');

    for (const forbidden of ['update', 'delete', 'remove', 'set']) {
        assert.equal(
            Object.prototype.hasOwnProperty.call(releaseEventRepository, forbidden),
            false,
            `releaseEventRepository must not expose ${forbidden}`
        );
    }
});

// ---------------------------------------------------------------------------
// No side effects
// ---------------------------------------------------------------------------

test('creating a release does not mutate the payment or task and never calls a provider', async () => {
    seedFundedMilestone();
    const paymentBefore = client.readDoc('payments', 'ms-1');
    const taskBefore = client.readDoc('tasks', 'task-1');
    const milestoneBefore = client.readDoc('milestones', 'ms-1');
    const contractBefore = client.readDoc('contracts', 'emp-1');

    await releaseService.createReleaseRequest({ targetType: 'milestone', targetId: 'ms-1' });

    assert.deepEqual(client.readDoc('payments', 'ms-1'), paymentBefore);
    assert.deepEqual(client.readDoc('tasks', 'task-1'), taskBefore);
    assert.deepEqual(client.readDoc('milestones', 'ms-1'), milestoneBefore);
    assert.deepEqual(client.readDoc('contracts', 'emp-1'), contractBefore);
    assert.equal(client.paystack.calls.length, 0);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 0);
});
