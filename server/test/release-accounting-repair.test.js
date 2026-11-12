'use strict';

/**
 * Stage 2H.2 succeeded-release accounting repair tests.
 *
 * Succeeded releases are already terminal, so the automatic reconciliation
 * flow must repair only their idempotent accounting post: no provider lookup,
 * no state transition, no duplicate success journal and no resurrection of an
 * explicitly compensated outcome.
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
let releaseService;
let orchestration;
let reconciliation;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;

test.before(async () => {
    client = await startTestServer();
    accounting = require('../config/accounting');
    accountingService = require('../services/accountingService');
    lifecycle = require('../services/accountingLifecycleService');
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

const journals = () => Object.values(client.readAll('ledgerJournals'));
const journalsOfType = (type) =>
    journals().filter((journal) => journal.journalType === type);

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

async function submitSuccessfulRelease() {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: PAYMENT_ID,
    });
    const provider = createSimulatedReleaseProvider({
        defaultOutcome: 'succeeded',
    });
    await orchestration.submitReleaseAttempt(RELEASE_ID, { provider });
    return provider;
}

async function deleteJournalAndEntries(journalId) {
    const entries = Object.entries(client.readAll('ledgerEntries')).filter(
        ([, entry]) => entry.journalId === journalId
    );
    for (const [entryId] of entries) {
        await client.fake.db.collection('ledgerEntries').doc(entryId).delete();
    }
    await client.fake.db.collection('ledgerJournals').doc(journalId).delete();
}

const successJournalId = () =>
    accountingService.succeededJournalIdFor(RELEASE_ID, false);

test('the worker repairs a missing success journal without a provider lookup', async () => {
    await submitSuccessfulRelease();
    await deleteJournalAndEntries(successJournalId());
    assert.equal(journalsOfType('payout_succeeded').length, 0);

    const provider = createSimulatedReleaseProvider();
    const result = await reconciliation.runReconciliationWorker({ provider });

    assert.equal(result.examined, 0);
    assert.equal(result.accountingExamined, 1);
    assert.equal(result.accountingRepairs[0].accounting.outcome.posted, true);
    assert.equal(provider.calls.length, 0);
    assert.equal(client.paystack.calls.length, 0);
    assert.equal(journalsOfType('payout_succeeded').length, 1);
    assert.equal(
        client.readDoc('releaseRequests', RELEASE_ID).status,
        'succeeded'
    );
});

test('manual reconciliation of a succeeded release is accounting-only', async () => {
    await submitSuccessfulRelease();
    await deleteJournalAndEntries(successJournalId());

    const provider = createSimulatedReleaseProvider();
    const result = await reconciliation.reconcileRelease(RELEASE_ID, {
        provider,
    });

    assert.equal(result.reconciled, true);
    assert.equal(result.applied, false);
    assert.equal(result.accountingOnly, true);
    assert.equal(result.accounting.outcome.posted, true);
    assert.equal(provider.calls.length, 0);
    assert.equal(journalsOfType('payout_succeeded').length, 1);
});

test('replaying the repair does not duplicate an existing success journal', async () => {
    await submitSuccessfulRelease();

    const result = await reconciliation.runReconciliationWorker({
        provider: createSimulatedReleaseProvider(),
    });

    assert.equal(result.accountingExamined, 1);
    assert.equal(result.accountingRepairs[0].accounting.outcome.posted, false);
    assert.equal(result.accountingRepairs[0].accounting.outcome.duplicate, true);
    assert.equal(journalsOfType('payout_succeeded').length, 1);
});

test('a compensated success is not resurrected by the repair flow', async () => {
    await submitSuccessfulRelease();
    await accountingService.reverseJournal({
        journalId: successJournalId(),
        reason: 'explicit accounting correction',
    });
    await deleteJournalAndEntries(successJournalId());

    const result = await reconciliation.runReconciliationWorker({
        provider: createSimulatedReleaseProvider(),
    });

    assert.equal(result.accountingExamined, 1);
    assert.equal(result.accountingRepairs[0].accounting.outcome.posted, false);
    assert.equal(journalsOfType('payout_succeeded').length, 0);
    assert.equal(journalsOfType('compensating').length, 1);
    const guard = client.readDoc(
        accounting.OUTCOME_GUARD_COLLECTION,
        accounting.outcomeGuardId(RELEASE_ID, 1)
    );
    assert.equal(guard.terminalCompensated, true);
});

test('the succeeded repair pass is bounded', async () => {
    await submitSuccessfulRelease();
    await deleteJournalAndEntries(successJournalId());

    const result = await reconciliation.repairSucceededReleaseAccounting({
        batchSize: 1,
    });

    assert.equal(result.examined, 1);
    assert.equal(result.batchSize, 1);
    assert.equal(result.results[0].accounting.outcome.posted, true);
});
