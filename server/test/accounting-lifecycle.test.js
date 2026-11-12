'use strict';

/**
 * Lifecycle integration tests for the balanced accounting foundation.
 *
 * They prove that journals are posted only after an authoritative lifecycle
 * event commits, that replay is idempotent, that unknown outcomes stay separate
 * from success/failure, and that a missing predecessor is refused rather than
 * guessed. They do not assert any commission, fee, refund or retry-reversal
 * policy.
 */

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
let accounting;
let accountingService;
let lifecycle;
let paymentService;
let releaseService;
let orchestration;
let reconciliation;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;
const ADMIN = Object.freeze({ uid: 'admin-1', admin: true });

test.before(async () => {
    client = await startTestServer();
    accounting = require('../config/accounting');
    accountingService = require('../services/accountingService');
    lifecycle = require('../services/accountingLifecycleService');
    paymentService = require('../services/paymentService');
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
        PAYMENT_ID,
        milestone({
            contractId: 'emp-1',
            employmentId: 'emp-1',
            taskId: 'task-1',
            amountMinor: AMOUNT,
        })
    );
    client.seed(
        'payments',
        PAYMENT_ID,
        payment({
            milestoneId: PAYMENT_ID,
            contractId: 'emp-1',
            employmentId: 'emp-1',
            employerId: 'employer-1',
            employeeId: 'employee-1',
            amountMinor: AMOUNT,
            currency: 'NGN',
            status: 'paid',
        })
    );
    client.seed(
        'tasks',
        'task-1',
        task({
            employmentId: 'emp-1',
            milestoneId: PAYMENT_ID,
            status: 'approved',
        })
    );
}

async function requestRelease() {
    return releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: PAYMENT_ID,
    });
}

const journals = () => Object.values(client.readAll('ledgerJournals'));
const journalTypes = () => journals().map((journal) => journal.journalType).sort();
const entries = () => Object.values(client.readAll('ledgerEntries'));

const balances = () => {
    const result = Object.fromEntries(
        accounting.LEDGER_ACCOUNT_TYPES.map((account) => [account, 0])
    );
    for (const entry of entries()) {
        const signed =
            entry.direction === 'debit' ? entry.amountMinor : -entry.amountMinor;
        result[entry.account] += signed;
    }
    return result;
};

const assertBalanced = () => {
    for (const journal of journals()) {
        assert.equal(journal.totalDebitMinor, journal.totalCreditMinor);
    }
};

test('a verified collection is posted once and replay is idempotent', async () => {
    seedFundedMilestone();

    const first = await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    const second = await lifecycle.ensureCollectionForPayment(PAYMENT_ID);

    assert.equal(first.posted, true);
    assert.equal(second.posted, false);
    assert.equal(second.duplicate, true);
    assert.deepEqual(journalTypes(), ['collection']);
    assert.equal(entries().length, 2);
    assertBalanced();
});

test('a successful release posts initiation only after a claim and then success', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await requestRelease();

    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'succeeded' });
    const result = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    assert.equal(result.submitted, true);
    assert.equal(result.outcome, 'succeeded');
    assert.equal(result.accounting.initiation.posted, true);
    assert.equal(result.accounting.outcome.outcome.posted, true);
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_initiation',
        'payout_succeeded',
    ]);
    assert.deepEqual(balances(), {
        collected_funds: AMOUNT,
        employee_payable: 0,
        platform_revenue: 0,
        payout_initiation: 0,
        completed_payout: -AMOUNT,
        unresolved_outcome: 0,
    });
    assertBalanced();

    const before = journals().length;
    await lifecycle.reconcileReleaseAccounting(RELEASE_ID);
    assert.equal(journals().length, before, 'replay posts nothing new');
});

test('a refused submission claim creates no initiation journal', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await requestRelease();

    const provider = createSimulatedReleaseProvider();
    const refused = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider,
        attemptNumber: 2,
    });
    assert.equal(refused.submitted, false);
    assert.equal(refused.reason, 'attempt-number-mismatch');
    assert.deepEqual(journalTypes(), ['collection']);
    assert.equal(provider.calls.length, 0);

    const accepted = await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });
    assert.equal(accepted.submitted, true);
    assert.equal(accepted.attemptNumber, 1);
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_initiation',
        'payout_succeeded',
    ]);
});

test('an unknown outcome is posted as unknown and recovered to success', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await requestRelease();

    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'unknown' });
    const submitted = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider,
    });

    assert.equal(submitted.outcome, 'unknown');
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_initiation',
        'payout_unknown',
    ]);
    assert.equal(balances().unresolved_outcome, -AMOUNT);
    assert.equal(balances().payout_initiation, 0);

    const resolved = await orchestration.resolveRelease(RELEASE_ID, {
        outcome: 'succeeded',
        actor: 'admin-1',
        evidence: {
            source: 'provider_reconciliation',
            reference: 'recovered-success-ref',
        },
    });

    assert.equal(resolved.resolved, true);
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_initiation',
        'payout_recovered_succeeded',
        'payout_unknown',
    ]);
    assert.deepEqual(balances(), {
        collected_funds: AMOUNT,
        employee_payable: 0,
        platform_revenue: 0,
        payout_initiation: 0,
        completed_payout: -AMOUNT,
        unresolved_outcome: 0,
    });
    assertBalanced();

    const before = journals().length;
    await lifecycle.reconcileReleaseAccounting(RELEASE_ID);
    assert.equal(journals().length, before, 'recovery is not duplicated');
});

test('an unknown outcome is recovered to failure without counting a success', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await requestRelease();

    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'unknown' });
    await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    await orchestration.resolveRelease(RELEASE_ID, {
        outcome: 'failed',
        actor: 'admin-1',
        evidence: {
            source: 'provider_reconciliation',
            reference: 'recovered-failure-ref',
        },
    });

    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_initiation',
        'payout_recovered_failed',
        'payout_unknown',
    ]);
    assert.deepEqual(balances(), {
        collected_funds: AMOUNT,
        employee_payable: -AMOUNT,
        platform_revenue: 0,
        payout_initiation: 0,
        completed_payout: 0,
        unresolved_outcome: 0,
    });
    assertBalanced();
});

test('without a collection the payout journals are refused and can be repaired later', async () => {
    seedFundedMilestone();
    await requestRelease();

    const provider = createSimulatedReleaseProvider();
    const submitted = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider,
    });

    assert.equal(submitted.outcome, 'succeeded');
    assert.equal(submitted.accounting.initiation.posted, false);
    assert.equal(
        submitted.accounting.initiation.reason,
        'ACCOUNTING_COLLECTION_NOT_POSTED'
    );
    assert.equal(entries().length, 0, 'no payout journal without its collection');

    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    const repaired = await lifecycle.reconcileReleaseAccounting(RELEASE_ID);

    assert.equal(repaired.initiation.posted, true);
    assert.equal(repaired.outcome.posted, true);
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_initiation',
        'payout_succeeded',
    ]);
    assertBalanced();
});

test('payment verification ensures the collection journal after the paid commit', async () => {
    seedFundedMilestone();

    const result = await paymentService.verifyPaymentForMilestone({
        milestone: {
            id: PAYMENT_ID,
            ...client.readDoc('milestones', PAYMENT_ID),
        },
        contract: { id: 'emp-1', ...client.readDoc('contracts', 'emp-1') },
        payload: { milestoneId: PAYMENT_ID },
    });

    assert.equal(result.verified, true);
    assert.equal(result.payment.status, 'paid');
    assert.equal(client.paystack.calls.length, 0, 'already-paid path');
    assert.deepEqual(journalTypes(), ['collection']);

    await paymentService.verifyPaymentForMilestone({
        milestone: {
            id: PAYMENT_ID,
            ...client.readDoc('milestones', PAYMENT_ID),
        },
        contract: { id: 'emp-1', ...client.readDoc('contracts', 'emp-1') },
        payload: { milestoneId: PAYMENT_ID },
    });
    assert.equal(journals().length, 1, 'replayed verification is idempotent');
});

test('a late provider success after a posted failure is not posted twice', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await requestRelease();

    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'failed' });
    await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_failed',
        'payout_initiation',
    ]);

    const late = createSimulatedReleaseProvider({
        lookups: {
            [RELEASE_ID]: {
                outcome: 'succeeded',
                providerReference: 'late-success-ref',
            },
        },
    });
    const reconciled = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider: late,
    });

    assert.equal(reconciled.release.status, 'needs_review');
    assert.equal(reconciled.attempt.status, 'failed');
    assert.equal(journalTypes().includes('payout_succeeded'), false);
    assert.equal(journalTypes().includes('payout_recovered_succeeded'), false);
    assert.equal(balances().employee_payable, -AMOUNT);

    const resolved = await reconciliation.resolveReleaseByAdmin(
        RELEASE_ID,
        {
            outcome: 'succeeded',
            reason: 'provider later proved the transfer completed',
            evidence: {
                source: 'provider_reconciliation',
                reference: 'late-success-ref',
            },
        },
        ADMIN
    );

    assert.equal(resolved.release.status, 'succeeded');
    assert.equal(resolved.accounting.posted, false);
    assert.equal(resolved.accounting.reason, 'CONFLICTING_FAILED_JOURNAL');
    assert.equal(journalTypes().includes('payout_succeeded'), false);
    assert.equal(journalTypes().includes('payout_recovered_succeeded'), false);
    assert.equal(balances().employee_payable, -AMOUNT);
});

test('an explicitly reversed failure may be corrected to success', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await requestRelease();

    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'failed' });
    await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });

    const late = createSimulatedReleaseProvider({
        lookups: {
            [RELEASE_ID]: {
                outcome: 'succeeded',
                providerReference: 'corrected-success-ref',
            },
        },
    });
    await reconciliation.reconcileRelease(RELEASE_ID, { provider: late });

    await accountingService.reverseJournal({
        journalId: accountingService.failedJournalIdFor(RELEASE_ID, false),
        reason: 'provider proved the transfer completed after the reversal review',
    });

    const resolved = await reconciliation.resolveReleaseByAdmin(
        RELEASE_ID,
        {
            outcome: 'succeeded',
            reason: 'provider later proved the transfer completed',
            evidence: {
                source: 'provider_reconciliation',
                reference: 'corrected-success-ref',
            },
        },
        ADMIN
    );

    assert.equal(resolved.release.status, 'succeeded');
    assert.equal(resolved.accounting.outcome.posted, true);
    assert.deepEqual(balances(), {
        collected_funds: AMOUNT,
        employee_payable: 0,
        platform_revenue: 0,
        payout_initiation: 0,
        completed_payout: -AMOUNT,
        unresolved_outcome: 0,
    });
    assertBalanced();
});

test('a retry attempt posts its own attempt-scoped journals without double counting', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await requestRelease();

    const failedProvider = createSimulatedReleaseProvider({
        defaultOutcome: 'failed',
    });
    await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: failedProvider,
    });
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_failed',
        'payout_initiation',
    ]);

    await reconciliation.authorizeRetry(
        RELEASE_ID,
        {
            reason: 'provider confirmed the decline',
            evidence: {
                source: 'provider_reconciliation',
                reference: 'retry-ref-1',
            },
        },
        ADMIN
    );

    const successProvider = createSimulatedReleaseProvider({
        defaultOutcome: 'succeeded',
    });
    const retried = await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: successProvider,
        retryActorUid: ADMIN.uid,
    });

    assert.equal(retried.attemptNumber, 2);
    assert.equal(retried.outcome, 'succeeded');
    assert.equal(retried.accounting.initiation.posted, true);
    assert.equal(retried.accounting.outcome.outcome.posted, true);
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_failed',
        'payout_initiation',
        'payout_initiation',
        'payout_succeeded',
    ]);

    const journalsOfType = (type) =>
        journals().filter((journal) => journal.journalType === type);
    assert.deepEqual(
        journalsOfType('payout_initiation').map(
            (journal) => journal.attemptNumber
        ),
        [1, 2]
    );
    assert.equal(journalsOfType('payout_failed')[0].attemptNumber, 1);
    assert.equal(journalsOfType('payout_succeeded')[0].attemptNumber, 2);

    assert.equal(balances().employee_payable, 0);
    assert.equal(balances().completed_payout, -AMOUNT);
    assert.equal(balances().payout_initiation, 0);
    assert.equal(balances().unresolved_outcome, 0);
    assertBalanced();

    const before = journals().length;
    await lifecycle.reconcileReleaseAccounting(RELEASE_ID);
    assert.equal(journals().length, before, 'retry replay posts nothing new');
});
