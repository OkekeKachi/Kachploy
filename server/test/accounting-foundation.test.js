'use strict';

/**
 * Accounting foundation tests.
 *
 * These tests pin the smallest coherent double-entry layer: a chart of
 * accounts, a journal representation that refuses unbalanced postings,
 * deterministic and idempotent persistence, atomic journal-plus-lines writes,
 * conservative collection and payout journals, and append-only compensating
 * journals. They deliberately do not assert an unresolved commission or fee
 * policy.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { payment } = require('../testing/fixtures');

let client;
let accounting;
let accountingJournal;
let accountingService;
let journalRepository;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;

test.before(async () => {
    client = await startTestServer();
    accounting = require('../config/accounting');
    accountingJournal = require('../services/accountingJournal');
    accountingService = require('../services/accountingService');
    journalRepository = require('../repositories/journalRepository');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
    client.paystack.reset();
});

const seedPaidPayment = (overrides = {}) =>
    client.seed(
        'payments',
        PAYMENT_ID,
        payment({
            milestoneId: PAYMENT_ID,
            amountMinor: AMOUNT,
            currency: 'NGN',
            status: 'paid',
            ...overrides,
        })
    );

const seedRelease = (overrides = {}) =>
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: 'ms-1',
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: 'in_flight',
        attemptCount: 1,
        ...overrides,
    });

const accountBalances = () => {
    const balances = Object.fromEntries(
        accounting.LEDGER_ACCOUNT_TYPES.map((account) => [account, 0])
    );
    for (const entry of Object.values(client.readAll('ledgerEntries'))) {
        const signed = entry.direction === 'debit' ? entry.amountMinor : -entry.amountMinor;
        balances[entry.account] += signed;
    }
    return balances;
};

const assertEveryJournalBalances = () => {
    for (const journal of Object.values(client.readAll('ledgerJournals'))) {
        assert.equal(
            journal.totalDebitMinor,
            journal.totalCreditMinor,
            `journal ${journal.journalId} must balance`
        );
        assert.ok(journal.totalDebitMinor > 0);
    }
};

test('chart of accounts distinguishes the required categories', () => {
    assert.deepEqual(accounting.LEDGER_ACCOUNT_TYPES, [
        'collected_funds',
        'employee_payable',
        'platform_revenue',
        'payout_initiation',
        'completed_payout',
        'unresolved_outcome',
    ]);
    assert.equal(accounting.ACCOUNTING_CURRENCY, 'NGN');
    assert.equal(accounting.ACCOUNT_NORMAL_BALANCE.collected_funds, 'debit');
    assert.equal(accounting.ACCOUNT_NORMAL_BALANCE.employee_payable, 'credit');
    assert.equal(accounting.ACCOUNT_NORMAL_BALANCE.platform_revenue, 'credit');
    assert.equal(accounting.ACCOUNT_NORMAL_BALANCE.payout_initiation, 'credit');
    assert.equal(accounting.ACCOUNT_NORMAL_BALANCE.completed_payout, 'credit');
    assert.equal(accounting.ACCOUNT_NORMAL_BALANCE.unresolved_outcome, 'credit');
});

test('a balanced journal is accepted and totals are computed', () => {
    const journalId = accounting.accountingJournalId('ms-1', 'test:balanced');
    const built = accountingJournal.buildJournal({
        journalId,
        journalType: 'collection',
        sourceId: 'ms-1',
        paymentId: 'ms-1',
        currency: 'NGN',
        lines: [
            { account: 'collected_funds', direction: 'debit', amountMinor: 10 },
            { account: 'employee_payable', direction: 'credit', amountMinor: 10 },
        ],
    });

    assert.equal(built.journal.totalDebitMinor, 10);
    assert.equal(built.journal.totalCreditMinor, 10);
    assert.equal(built.journal.lineCount, 2);
    assert.equal(built.entries.length, 2);
    assert.equal(new Set(built.entries.map((entry) => entry.entryId)).size, 2);
});

test('an unbalanced journal is rejected', () => {
    const journalId = accounting.accountingJournalId('ms-1', 'test:unbalanced');
    assert.throws(
        () =>
            accountingJournal.buildJournal({
                journalId,
                journalType: 'collection',
                currency: 'NGN',
                lines: [
                    { account: 'collected_funds', direction: 'debit', amountMinor: 10 },
                    { account: 'employee_payable', direction: 'credit', amountMinor: 9 },
                ],
            }),
        (error) => error.code === 'ACCOUNTING_UNBALANCED_JOURNAL'
    );
});

test('journal lines reject invalid money, currency, account, direction and numbering', () => {
    const base = {
        journalId: accounting.accountingJournalId('ms-1', 'test:invalid'),
        journalType: 'collection',
        currency: 'NGN',
    };
    const line = (overrides = {}) => ({
        account: 'collected_funds',
        direction: 'debit',
        amountMinor: 10,
        ...overrides,
    });

    for (const amountMinor of [0, -1, 1.5, '10', Number.MAX_SAFE_INTEGER + 2]) {
        assert.throws(
            () =>
                accountingJournal.buildJournal({
                    ...base,
                    lines: [
                        line({ amountMinor }),
                        line({ account: 'employee_payable', direction: 'credit', amountMinor }),
                    ],
                }),
            `amountMinor ${amountMinor} must be rejected`
        );
    }

    assert.throws(
        () =>
            accountingJournal.buildJournal({
                ...base,
                currency: 'USD',
                lines: [line(), line({ account: 'employee_payable', direction: 'credit' })],
            })
    );
    assert.throws(
        () =>
            accountingJournal.buildJournal({
                ...base,
                lines: [line({ account: 'cash' }), line({ account: 'employee_payable', direction: 'credit' })],
            })
    );
    assert.throws(
        () =>
            accountingJournal.buildJournal({
                ...base,
                lines: [line({ direction: 'transfer' }), line({ account: 'employee_payable', direction: 'credit' })],
            })
    );
    assert.throws(
        () =>
            accountingJournal.buildJournal({
                ...base,
                lines: [
                    line({ lineNumber: 1 }),
                    line({ lineNumber: 1, account: 'employee_payable', direction: 'credit' }),
                ],
            })
    );
    assert.throws(() => accountingJournal.buildJournal({ ...base, lines: [line()] }));
});

test('verified collection posts one balanced journal and is idempotent', async () => {
    seedPaidPayment({ chargeMinor: 550000 });

    const first = await accountingService.recordVerifiedCollection({
        paymentId: PAYMENT_ID,
    });
    assert.equal(first.created, true);

    const journals = client.readAll('ledgerJournals');
    const entries = client.readAll('ledgerEntries');
    assert.equal(Object.keys(journals).length, 1);
    assert.equal(Object.keys(entries).length, 2);
    assertEveryJournalBalances();

    const stored = journals[first.journalId];
    assert.equal(stored.journalType, 'collection');
    assert.equal(stored.paymentId, PAYMENT_ID);
    assert.equal(stored.totalDebitMinor, AMOUNT);
    assert.equal(stored.totalCreditMinor, AMOUNT);

    const byAccount = Object.fromEntries(
        Object.values(entries).map((entry) => [entry.account, entry])
    );
    assert.equal(byAccount.collected_funds.direction, 'debit');
    assert.equal(byAccount.collected_funds.amountMinor, AMOUNT);
    assert.equal(byAccount.employee_payable.direction, 'credit');
    assert.equal(byAccount.employee_payable.amountMinor, AMOUNT);

    const second = await accountingService.recordVerifiedCollection({
        paymentId: PAYMENT_ID,
    });
    assert.equal(second.created, false);
    assert.equal(Object.keys(client.readAll('ledgerJournals')).length, 1);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 2);
});

test('concurrent collection posting creates exactly one journal', async () => {
    seedPaidPayment();

    const results = await Promise.all(
        Array.from({ length: 5 }, () =>
            accountingService.recordVerifiedCollection({ paymentId: PAYMENT_ID })
        )
    );

    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(Object.keys(client.readAll('ledgerJournals')).length, 1);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 2);
});

test('collection posting refuses a payment that is not paid', async () => {
    client.seed('payments', PAYMENT_ID, payment({ milestoneId: PAYMENT_ID, status: 'created' }));
    await assert.rejects(
        () => accountingService.recordVerifiedCollection({ paymentId: PAYMENT_ID }),
        (error) => error.code === 'ACCOUNTING_PAYMENT_NOT_PAID'
    );

    await assert.rejects(
        () => accountingService.recordVerifiedCollection({ paymentId: 'missing' }),
        (error) => error.code === 'ACCOUNTING_PAYMENT_NOT_FOUND'
    );
});

test('payout initiation requires the collection journal', async () => {
    seedPaidPayment();
    seedRelease();

    await assert.rejects(
        () => accountingService.recordPayoutInitiation({ releaseId: RELEASE_ID }),
        (error) => error.code === 'ACCOUNTING_COLLECTION_NOT_POSTED'
    );

    await accountingService.recordVerifiedCollection({ paymentId: PAYMENT_ID });
    const result = await accountingService.recordPayoutInitiation({
        releaseId: RELEASE_ID,
    });
    assert.equal(result.created, true);
    assertEveryJournalBalances();
});

test('succeeded payout clears the payable and offsets collected funds', async () => {
    seedPaidPayment();
    await accountingService.recordVerifiedCollection({ paymentId: PAYMENT_ID });
    seedRelease();
    await accountingService.recordPayoutInitiation({ releaseId: RELEASE_ID });

    seedRelease({ status: 'succeeded' });
    const result = await accountingService.recordPayoutSucceeded({
        releaseId: RELEASE_ID,
    });
    assert.equal(result.created, true);
    assertEveryJournalBalances();

    const balances = accountBalances();
    assert.equal(balances.collected_funds, AMOUNT);
    assert.equal(balances.employee_payable, 0);
    assert.equal(balances.payout_initiation, 0);
    assert.equal(balances.completed_payout, -AMOUNT);
    assert.equal(balances.platform_revenue, 0);
    assert.equal(balances.unresolved_outcome, 0);
});

test('failed payout restores the freelancer payable', async () => {
    seedPaidPayment();
    await accountingService.recordVerifiedCollection({ paymentId: PAYMENT_ID });
    seedRelease();
    await accountingService.recordPayoutInitiation({ releaseId: RELEASE_ID });

    seedRelease({ status: 'failed' });
    await accountingService.recordPayoutFailed({ releaseId: RELEASE_ID });
    assertEveryJournalBalances();

    const balances = accountBalances();
    assert.equal(balances.collected_funds, AMOUNT);
    assert.equal(balances.employee_payable, -AMOUNT);
    assert.equal(balances.payout_initiation, 0);
    assert.equal(balances.completed_payout, 0);
});

test('unknown outcome uses the suspense account and can be recovered', async () => {
    seedPaidPayment();
    await accountingService.recordVerifiedCollection({ paymentId: PAYMENT_ID });
    seedRelease();
    await accountingService.recordPayoutInitiation({ releaseId: RELEASE_ID });

    seedRelease({ status: 'needs_review' });
    await accountingService.recordPayoutUnknown({ releaseId: RELEASE_ID });
    assertEveryJournalBalances();

    let balances = accountBalances();
    assert.equal(balances.collected_funds, AMOUNT);
    assert.equal(balances.payout_initiation, 0);
    assert.equal(balances.unresolved_outcome, -AMOUNT);
    assert.equal(balances.completed_payout, 0);

    seedRelease({ status: 'succeeded' });
    const recovered = await accountingService.recordPayoutSucceeded({
        releaseId: RELEASE_ID,
    });
    assert.equal(recovered.created, true);
    assert.equal(
        client.readAll('ledgerJournals')[recovered.journalId].journalType,
        'payout_recovered_succeeded'
    );
    assertEveryJournalBalances();

    balances = accountBalances();
    assert.equal(balances.unresolved_outcome, 0);
    assert.equal(balances.completed_payout, -AMOUNT);
});

test('payout success requires the initiation journal', async () => {
    seedPaidPayment();
    await accountingService.recordVerifiedCollection({ paymentId: PAYMENT_ID });
    seedRelease({ status: 'succeeded' });

    await assert.rejects(
        () => accountingService.recordPayoutSucceeded({ releaseId: RELEASE_ID }),
        (error) => error.code === 'ACCOUNTING_PAYOUT_NOT_INITIATED'
    );
});

test('compensating journal reverses a collection and is idempotent', async () => {
    seedPaidPayment();
    const posted = await accountingService.recordVerifiedCollection({
        paymentId: PAYMENT_ID,
    });

    const reversed = await accountingService.reverseJournal({
        journalId: posted.journalId,
        reason: 'test',
    });
    assert.equal(reversed.created, true);

    const compensating = client.readAll('ledgerJournals')[reversed.journalId];
    assert.equal(compensating.journalType, 'compensating');
    assert.equal(compensating.compensatesJournalId, posted.journalId);
    assert.equal(compensating.totalDebitMinor, AMOUNT);
    assert.equal(compensating.totalCreditMinor, AMOUNT);
    assertEveryJournalBalances();

    const balances = accountBalances();
    for (const account of accounting.LEDGER_ACCOUNT_TYPES) {
        assert.equal(balances[account], 0, `${account} must net to zero`);
    }

    const again = await accountingService.reverseJournal({
        journalId: posted.journalId,
        reason: 'test',
    });
    assert.equal(again.created, false);
});

test('a conflicting line prevents a partial journal from being written', async () => {
    const built = accountingJournal.buildCollectionJournal({
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
    });

    const conflicting = built.entries[0];
    client.seed('ledgerEntries', conflicting.entryId, conflicting.data);

    const result = await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    assert.equal(result.created, false);
    assert.equal(client.readDoc('ledgerJournals', built.journal.journalId), undefined);
    assert.equal(Object.keys(client.readAll('ledgerEntries')).length, 1);
});
