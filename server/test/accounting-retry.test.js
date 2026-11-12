'use strict';

/**
 * Stage 2G retry accounting tests at the service boundary.
 *
 * They prove that a later attempt repairs any missing prior-attempt accounting
 * before its own initiation, that a repair never guesses in the face of an
 * unresolved or contradicting prior attempt, and that attempt scoping keeps a
 * declined attempt on the ledger as its own history. Orchestration-level
 * behaviour (claim, authorization, replay) is covered in
 * accounting-lifecycle.test.js.
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
let accounting;
let accountingService;
let lifecycle;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;

test.before(async () => {
    client = await startTestServer();
    accounting = require('../config/accounting');
    accountingService = require('../services/accountingService');
    lifecycle = require('../services/accountingLifecycleService');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
});

const journals = () => Object.values(client.readAll('ledgerJournals'));
const journalTypes = () => journals().map((j) => j.journalType).sort();
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

const attemptIdFor = (n) => `${RELEASE_ID}__attempt_${n}`;

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

function seedRetryRelease(priorStatus) {
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: PAYMENT_ID,
        paymentId: PAYMENT_ID,
        contractId: 'emp-1',
        employmentId: 'emp-1',
        employerId: 'employer-1',
        employeeId: 'employee-1',
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: 'in_flight',
        attemptCount: 2,
        currentAttemptId: attemptIdFor(2),
        currentAttemptNumber: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    for (let n = 1; n <= 2; n += 1) {
        const status = n === 1 ? priorStatus : 'created';
        client.seed('releaseAttempts', attemptIdFor(n), {
            releaseId: RELEASE_ID,
            attemptNumber: n,
            status,
            providerId: 'injected-release-provider',
            targetType: 'milestone',
            targetId: PAYMENT_ID,
            paymentId: PAYMENT_ID,
            amountMinor: AMOUNT,
            currency: 'NGN',
            submissionClaimedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
    }
}

test('posting a retry initiation repairs a prior failed attempt with missing journals', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    seedRetryRelease('failed');

    const initiation = await lifecycle.ensurePayoutInitiation({
        releaseId: RELEASE_ID,
        attemptNumber: 2,
    });

    assert.equal(initiation.posted, true);
    assert.deepEqual(journalTypes(), [
        'collection',
        'payout_failed',
        'payout_initiation',
        'payout_initiation',
    ]);

    const byType = (type) => journals().filter((j) => j.journalType === type);
    assert.deepEqual(
        byType('payout_initiation').map((j) => j.attemptNumber),
        [1, 2]
    );
    assert.equal(byType('payout_failed')[0].attemptNumber, 1);

    assert.equal(balances().employee_payable, 0);
    assert.equal(balances().payout_initiation, -AMOUNT);
    assert.equal(balances().unresolved_outcome, 0);
});

test('a retry initiation is refused while a prior attempt is unresolved', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    seedRetryRelease('submitted');

    const initiation = await lifecycle.ensurePayoutInitiation({
        releaseId: RELEASE_ID,
        attemptNumber: 2,
    });

    assert.equal(initiation.posted, false);
    assert.equal(initiation.reason, 'ACCOUNTING_PRIOR_ATTEMPT_UNRESOLVED');
    assert.equal(initiation.attemptNumber, 1);
    assert.deepEqual(journalTypes(), ['collection']);
});

test('a retry initiation is refused when a prior attempt claims success', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    seedRetryRelease('succeeded');

    const initiation = await lifecycle.ensurePayoutInitiation({
        releaseId: RELEASE_ID,
        attemptNumber: 2,
    });

    assert.equal(initiation.posted, false);
    assert.equal(initiation.reason, 'ACCOUNTING_PRIOR_ATTEMPT_SUCCEEDED');
    assert.deepEqual(journalTypes(), ['collection']);
});

test('a retry initiation is refused when a prior attempt document is missing', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    // A release that claims attemptCount 2 but stores only the attempt-2
    // document: attempt 1 has no authoritative record to repair from.
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: PAYMENT_ID,
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: 'in_flight',
        attemptCount: 2,
        currentAttemptNumber: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });
    client.seed('releaseAttempts', attemptIdFor(2), {
        releaseId: RELEASE_ID,
        attemptNumber: 2,
        status: 'created',
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        submissionClaimedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    });

    const initiation = await lifecycle.ensurePayoutInitiation({
        releaseId: RELEASE_ID,
        attemptNumber: 2,
    });

    assert.equal(initiation.posted, false);
    assert.equal(initiation.reason, 'ACCOUNTING_PRIOR_ATTEMPT_MISSING');
    assert.deepEqual(journalTypes(), ['collection']);
});

test('a retry initiation is refused while a prior attempt outcome is unresolved', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    seedRetryRelease('unknown');

    const initiation = await lifecycle.ensurePayoutInitiation({
        releaseId: RELEASE_ID,
        attemptNumber: 2,
    });

    assert.equal(initiation.posted, false);
    assert.equal(initiation.reason, 'ACCOUNTING_PRIOR_ATTEMPT_UNRESOLVED');
    assert.equal(initiation.attemptNumber, 1);
    assert.deepEqual(journalTypes(), ['collection']);
    assert.equal(balances().unresolved_outcome, 0);
});

test('an outcome that no committed state justifies is refused for a retry attempt', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    seedRetryRelease('failed');

    await assert.rejects(
        () =>
            accountingService.recordPayoutSucceeded({
                releaseId: RELEASE_ID,
                attemptNumber: 2,
            }),
        (error) => error.code === 'ACCOUNTING_RELEASE_NOT_SUCCEEDED'
    );
    assert.deepEqual(journalTypes(), ['collection']);
});
