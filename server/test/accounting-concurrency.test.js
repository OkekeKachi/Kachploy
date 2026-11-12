'use strict';

/**
 * Stage 2H.1 outcome-concurrency tests.
 *
 * The Stage 2G audit found that outcome guards were checked outside the journal
 * write transaction, so two concurrent replays of different outcome kinds could
 * both post. These tests seed deliberately inconsistent release/attempt states
 * (which the service accepts as an explicit correction pathway) and fire the
 * postings together: exactly one terminal journal may exist afterwards.
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
const clock = require('../config/clock');

let client;
let accounting;
let accountingService;
let lifecycle;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;
const TERMINAL_TYPES = [
    'payout_succeeded',
    'payout_recovered_succeeded',
    'payout_failed',
    'payout_recovered_failed',
];

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
const guards = () =>
    Object.values(client.readAll(accounting.OUTCOME_GUARD_COLLECTION));
const terminalJournals = () =>
    journals().filter((journal) =>
        TERMINAL_TYPES.includes(journal.journalType)
    );

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

async function seedClaimedAttempt({ releaseStatus, attemptStatus }) {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: PAYMENT_ID,
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: releaseStatus,
        attemptCount: 1,
        currentAttemptId: `${RELEASE_ID}__attempt_1`,
        currentAttemptNumber: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });
    client.seed('releaseAttempts', `${RELEASE_ID}__attempt_1`, {
        releaseId: RELEASE_ID,
        attemptNumber: 1,
        status: attemptStatus,
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        submissionClaimedAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });
    const initiation = await accountingService.recordPayoutInitiation({
        releaseId: RELEASE_ID,
        attemptNumber: 1,
    });
    assert.equal(initiation.created, true);
}

test('concurrent success and failure claims post exactly one terminal journal', async () => {
    await seedClaimedAttempt({
        releaseStatus: 'failed',
        attemptStatus: 'succeeded',
    });

    const results = await Promise.allSettled([
        accountingService.recordPayoutSucceeded({
            releaseId: RELEASE_ID,
            attemptNumber: 1,
        }),
        accountingService.recordPayoutFailed({
            releaseId: RELEASE_ID,
            attemptNumber: 1,
        }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(fulfilled[0].value.created, true);
    assert.equal(rejected.length, 1);
    assert.match(
        rejected[0].reason.code,
        /^(CONFLICTING_SUCCEEDED_JOURNAL|CONFLICTING_FAILED_JOURNAL|ACCOUNTING_ATTEMPT_ALREADY_TERMINAL)$/
    );

    assert.equal(terminalJournals().length, 1);
    assert.equal(guards().length, 1);
    assert.equal(guards()[0].terminalCompensated, false);
});

test('concurrent replays of the same success post exactly one journal', async () => {
    await seedClaimedAttempt({
        releaseStatus: 'succeeded',
        attemptStatus: 'succeeded',
    });

    const results = await Promise.all(
        Array.from({ length: 5 }, () =>
            accountingService.recordPayoutSucceeded({
                releaseId: RELEASE_ID,
                attemptNumber: 1,
            })
        )
    );

    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(terminalJournals().length, 1);
    assert.equal(guards().length, 1);
});

test('concurrent success and unknown never leave a plain success beside suspense', async () => {
    await seedClaimedAttempt({
        releaseStatus: 'succeeded',
        attemptStatus: 'unknown',
    });

    const results = await Promise.allSettled([
        accountingService.recordPayoutSucceeded({
            releaseId: RELEASE_ID,
            attemptNumber: 1,
        }),
        accountingService.recordPayoutUnknown({
            releaseId: RELEASE_ID,
            attemptNumber: 1,
        }),
    ]);
    assert.ok(results.some((result) => result.status === 'fulfilled'));

    const unknown = journals().filter(
        (journal) => journal.journalType === 'payout_unknown'
    );
    const plainSuccess = journals().filter(
        (journal) => journal.journalType === 'payout_succeeded'
    );
    const recoveredSuccess = journals().filter(
        (journal) => journal.journalType === 'payout_recovered_succeeded'
    );

    assert.equal(plainSuccess.length + recoveredSuccess.length, 1);
    assert.ok(
        !(unknown.length > 0 && plainSuccess.length > 0),
        'an unknown suspense journal must not coexist with a plain success'
    );
    if (unknown.length > 0) {
        assert.equal(recoveredSuccess.length, 1);
    }
    assert.equal(guards().length, 1);
    assert.equal(guards()[0].terminalKind, 'succeeded');
});
