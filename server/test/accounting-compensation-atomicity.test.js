'use strict';

/**
 * Stage 2H.2 compensation atomicity tests.
 *
 * A compensation journal must commit together with the outcome-guard update
 * that deactivates the journal it reverses. These tests cover the atomic write,
 * concurrent reversals, replay repair and guard isolation.
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
let journalRepository;
let lifecycle;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;

test.before(async () => {
    client = await startTestServer();
    accounting = require('../config/accounting');
    accountingService = require('../services/accountingService');
    journalRepository = require('../repositories/journalRepository');
    lifecycle = require('../services/accountingLifecycleService');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
});

const journals = () => Object.values(client.readAll('ledgerJournals'));
const guard = () =>
    client.readDoc(
        accounting.OUTCOME_GUARD_COLLECTION,
        accounting.outcomeGuardId(RELEASE_ID, 1)
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

function seedSucceededRelease() {
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: PAYMENT_ID,
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: 'succeeded',
        attemptCount: 1,
        currentAttemptNumber: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });
}

async function postSucceededJournals() {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    seedSucceededRelease();
    await accountingService.recordPayoutInitiation({ releaseId: RELEASE_ID });
    await accountingService.recordPayoutSucceeded({ releaseId: RELEASE_ID });
    return accountingService.succeededJournalIdFor(RELEASE_ID, false);
}

test('reversal and guard deactivation commit in one transaction', async () => {
    const successId = await postSucceededJournals();
    assert.equal(guard().terminalCompensated, false);

    const result = await accountingService.reverseJournal({
        journalId: successId,
        reason: 'atomic compensation',
    });

    assert.equal(result.created, true);
    assert.equal(result.guardUpdated, true);
    assert.equal(guard().terminalCompensated, true);
    assert.equal(
        journals().filter((journal) => journal.journalType === 'compensating')
            .length,
        1
    );
});

test('concurrent reversals create one compensation and mark the guard once', async () => {
    const successId = await postSucceededJournals();

    const results = await Promise.all([
        accountingService.reverseJournal({ journalId: successId, reason: 'a' }),
        accountingService.reverseJournal({ journalId: successId, reason: 'b' }),
    ]);

    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(
        journals().filter((journal) => journal.journalType === 'compensating')
            .length,
        1
    );
    assert.equal(guard().terminalCompensated, true);
});

test('a replay repairs an unmarked guard without duplicating the compensation', async () => {
    const successId = await postSucceededJournals();
    const first = await accountingService.reverseJournal({
        journalId: successId,
        reason: 'first reversal',
    });
    assert.equal(first.guardUpdated, true);

    client.seed(accounting.OUTCOME_GUARD_COLLECTION, guard().guardId, {
        ...guard(),
        terminalCompensated: false,
    });

    const replay = await accountingService.reverseJournal({
        journalId: successId,
        reason: 'replay after an older non-atomic write',
    });

    assert.equal(replay.created, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.guardUpdated, true);
    assert.equal(guard().terminalCompensated, true);
    assert.equal(
        journals().filter((journal) => journal.journalType === 'compensating')
            .length,
        1
    );
});

test('a malformed existing compensation never deactivates the guard', async () => {
    const successId = await postSucceededJournals();
    const reversed = await accountingService.reverseJournal({
        journalId: successId,
        reason: 'first reversal',
    });
    assert.equal(reversed.guardUpdated, true);

    client.seed(accounting.OUTCOME_GUARD_COLLECTION, guard().guardId, {
        ...guard(),
        terminalCompensated: false,
    });
    const stored = client.readDoc('ledgerJournals', reversed.journalId);
    client.seed('ledgerJournals', reversed.journalId, {
        ...stored,
        totalDebitMinor: stored.totalDebitMinor + 1,
    });

    const replay = await accountingService.reverseJournal({
        journalId: successId,
        reason: 'replay against a corrupted compensation',
    });

    assert.equal(replay.created, false);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.invalidCompensation, true);
    assert.equal(replay.guardUpdated, false);
    assert.equal(guard().terminalCompensated, false);
});

test('compensating an initiation does not deactivate the terminal guard', async () => {
    const successId = await postSucceededJournals();
    const initiationId = accountingService.initiationJournalIdFor(RELEASE_ID, 1);

    const result = await accountingService.reverseJournal({
        journalId: initiationId,
        reason: 'reverse the initiation only',
    });

    assert.equal(result.created, true);
    assert.equal(result.guardUpdated, false);
    assert.equal(guard().terminalJournalId, successId);
    assert.equal(guard().terminalCompensated, false);
});

test('a compensation targeting a different journal is rejected before writing', async () => {
    await postSucceededJournals();
    const initiationId = accountingService.initiationJournalIdFor(RELEASE_ID, 1);
    const built = {
        journal: {
            journalId: 'jnl_test_mismatch',
            compensatesJournalId: initiationId,
        },
        entries: [
            { entryId: 'entry_test_mismatch_1', data: {} },
            { entryId: 'entry_test_mismatch_2', data: {} },
        ],
    };

    await assert.rejects(
        () =>
            journalRepository.createCompensatingJournalWithGuardUpdate(
                built.journal.journalId,
                built.journal,
                built.entries,
                {
                    guardId: accounting.outcomeGuardId(RELEASE_ID, 1),
                    targetJournalId: accountingService.succeededJournalIdFor(
                        RELEASE_ID,
                        false
                    ),
                }
            ),
        /compensating journal must target the named journal/
    );
    assert.equal(
        client.readDoc('ledgerJournals', built.journal.journalId),
        undefined
    );
});
