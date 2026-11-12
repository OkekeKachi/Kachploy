'use strict';

/**
 * Stage 2G bounded backfill tests.
 *
 * They prove the paid-payment page query is deterministic and cursor-paged,
 * that the backfill replays the live ensure path (idempotent, no duplicates,
 * nothing for non-paid records), that dryRun posts nothing, that ineligible
 * records are reported rather than guessed, and that invalid input is refused.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { payment } = require('../testing/fixtures');

let client;
let backfill;
let paymentRepository;
let lifecycle;

const PAID_IDS = ['ms-b1', 'ms-b2', 'ms-b3'];
const AMOUNT = 500000;

test.before(async () => {
    client = await startTestServer();
    backfill = require('../services/accountingBackfillService');
    paymentRepository = require('../repositories/paymentRepository');
    lifecycle = require('../services/accountingLifecycleService');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
});

const seedPaidPayment = (id, overrides = {}) =>
    client.seed(
        'payments',
        id,
        payment({
            milestoneId: id,
            contractId: 'emp-1',
            employmentId: 'emp-1',
            employerId: 'employer-1',
            employeeId: 'employee-1',
            amountMinor: AMOUNT,
            currency: 'NGN',
            status: 'paid',
            ...overrides,
        })
    );

const seedStandardHistory = () => {
    for (const id of PAID_IDS) seedPaidPayment(id);
    client.seed(
        'payments',
        'ms-b4',
        payment({
            milestoneId: 'ms-b4',
            amountMinor: AMOUNT,
            currency: 'NGN',
            status: 'pending',
        })
    );
    client.seed(
        'payments',
        'ms-b5',
        payment({
            milestoneId: 'ms-b5',
            amountMinor: AMOUNT,
            currency: 'NGN',
            status: 'failed',
        })
    );
};

const journals = () => Object.values(client.readAll('ledgerJournals'));

test('dryRun reports every paid payment without posting anything', async () => {
    seedStandardHistory();

    const result = await backfill.backfillPaidCollections({
        pageSize: 10,
        dryRun: true,
    });

    assert.equal(result.scanned, 3);
    assert.equal(result.posted, 0);
    assert.equal(result.duplicates, 0);
    assert.equal(result.skipped, 0);
    assert.equal(result.done, true);
    assert.equal(result.nextAfterId, null);
    assert.ok(
        result.results.every(
            (entry) => entry.dryRun === true && entry.wouldPost === true
        )
    );
    assert.equal(journals().length, 0);
});

test('one call posts a bounded page and continues from the cursor', async () => {
    seedStandardHistory();

    const first = await backfill.backfillPaidCollections({ pageSize: 2 });
    assert.equal(first.scanned, 2);
    assert.equal(first.posted, 2);
    assert.equal(first.done, false);
    assert.equal(first.nextAfterId, 'ms-b2');
    assert.equal(journals().length, 2);

    const second = await backfill.backfillPaidCollections({
        pageSize: 2,
        afterId: first.nextAfterId,
    });
    assert.equal(second.scanned, 1);
    assert.equal(second.posted, 1);
    assert.equal(second.done, true);
    assert.equal(second.nextAfterId, null);
    assert.equal(journals().length, 3);
    assert.deepEqual(
        journals().map((j) => j.paymentId).sort(),
        PAID_IDS
    );
});

test('replaying a page is a reported no-op, never a duplicate posting', async () => {
    seedStandardHistory();
    await backfill.backfillPaidCollections({ pageSize: 10 });

    const replay = await backfill.backfillPaidCollections({ pageSize: 10 });
    assert.equal(replay.posted, 0);
    assert.equal(replay.duplicates, 3);
    assert.equal(replay.failed, 0);
    assert.equal(journals().length, 3);
});

test('only paid payments are scanned and eligible ones are posted', async () => {
    seedStandardHistory();

    const result = await backfill.backfillPaidCollections({ pageSize: 10 });
    assert.deepEqual(result.results.map((entry) => entry.paymentId), PAID_IDS);
    assert.equal(result.scanned, 3);
});

test('a paid payment with an unusable amount is reported and skipped', async () => {
    seedPaidPayment('ms-b1');
    seedPaidPayment('ms-b2', { amountMinor: 0 });
    seedPaidPayment('ms-b3', { currency: 'USD' });

    const result = await backfill.backfillPaidCollections({ pageSize: 10 });
    assert.equal(result.scanned, 3);
    assert.equal(result.posted, 1);
    assert.equal(result.skipped, 2);
    assert.ok(
        result.results
            .filter((entry) => entry.skipped)
            .every((entry) => entry.reason === 'ACCOUNTING_INVALID_AMOUNT')
    );
    assert.equal(journals().length, 1);
});

test('an empty history yields a completed empty page', async () => {
    const result = await backfill.backfillPaidCollections({ pageSize: 10 });
    assert.equal(result.scanned, 0);
    assert.equal(result.done, true);
    assert.equal(result.nextAfterId, null);
});

test('invalid pagination input is refused before any query', async () => {
    await assert.rejects(
        () => backfill.backfillPaidCollections({ pageSize: 0 }),
        TypeError
    );
    await assert.rejects(
        () =>
            backfill.backfillPaidCollections({
                pageSize: backfill.MAX_PAGE_SIZE + 1,
            }),
        TypeError
    );
    await assert.rejects(
        () => backfill.backfillPaidCollections({ afterId: '  ' }),
        TypeError
    );
});

test('the page query itself is bounded and cursor-resumable', async () => {
    seedStandardHistory();

    const first = await paymentRepository.listPaidPaymentsPage({
        limit: 2,
    });
    assert.equal(first.size, 2);
    assert.deepEqual(first.docs.map((d) => d.id), ['ms-b1', 'ms-b2']);

    const second = await paymentRepository.listPaidPaymentsPage({
        limit: 2,
        afterId: first.docs[first.docs.length - 1].id,
    });
    assert.equal(second.size, 1);
    assert.deepEqual(second.docs.map((d) => d.id), ['ms-b3']);
});

const withPostingFailure = async (failingIds, run) => {
    const original = lifecycle.ensureCollectionForPayment;
    lifecycle.ensureCollectionForPayment = async (paymentId) => {
        if (failingIds.includes(paymentId)) {
            return { posted: false, reason: 'SIMULATED_POSTING_FAILURE' };
        }
        return original(paymentId);
    };
    try {
        return await run();
    } finally {
        lifecycle.ensureCollectionForPayment = original;
    }
};

test('a failed item stops the cursor before it so a retry cannot skip it', async () => {
    seedStandardHistory();

    const first = await withPostingFailure(['ms-b2'], () =>
        backfill.backfillPaidCollections({ pageSize: 10 })
    );

    assert.equal(first.scanned, 3);
    assert.equal(first.posted, 2);
    assert.equal(first.failed, 1);
    assert.equal(first.done, false);
    assert.equal(first.nextAfterId, 'ms-b1');
    assert.equal(
        first.results.find((entry) => entry.paymentId === 'ms-b2').failed,
        true
    );
    assert.deepEqual(
        journals().map((journal) => journal.paymentId).sort(),
        ['ms-b1', 'ms-b3']
    );

    const resumed = await backfill.backfillPaidCollections({
        pageSize: 10,
        afterId: first.nextAfterId,
    });
    assert.equal(resumed.scanned, 2);
    assert.equal(resumed.posted, 1);
    assert.equal(resumed.duplicates, 1);
    assert.equal(resumed.failed, 0);
    assert.equal(resumed.done, true);
    assert.deepEqual(
        journals().map((journal) => journal.paymentId).sort(),
        PAID_IDS
    );
});

test('a failure on the first item keeps the same cursor and stops the page', async () => {
    seedStandardHistory();

    const first = await withPostingFailure(['ms-b1'], () =>
        backfill.backfillPaidCollections({ pageSize: 10 })
    );
    assert.equal(first.failed, 1);
    assert.equal(first.done, false);
    assert.equal(first.nextAfterId, null);

    const resumed = await backfill.backfillPaidCollections({ pageSize: 10 });
    assert.equal(resumed.posted, 1);
    assert.equal(resumed.duplicates, 2);
    assert.equal(resumed.failed, 0);
    assert.equal(resumed.done, true);
    assert.equal(journals().length, 3);
});

test('a failure on the last item stops the cursor at the preceding item', async () => {
    seedStandardHistory();

    const first = await withPostingFailure(['ms-b3'], () =>
        backfill.backfillPaidCollections({ pageSize: 10 })
    );
    assert.equal(first.posted, 2);
    assert.equal(first.failed, 1);
    assert.equal(first.done, false);
    assert.equal(first.nextAfterId, 'ms-b2');

    const resumed = await backfill.backfillPaidCollections({
        pageSize: 10,
        afterId: first.nextAfterId,
    });
    assert.equal(resumed.scanned, 1);
    assert.equal(resumed.posted, 1);
    assert.equal(resumed.done, true);
    assert.equal(journals().length, 3);
});

test('a successful page still completes the cursor normally', async () => {
    seedStandardHistory();

    const first = await backfill.backfillPaidCollections({ pageSize: 2 });
    assert.equal(first.failed, 0);
    assert.equal(first.done, false);
    assert.equal(first.nextAfterId, 'ms-b2');
});

test('the fake harness keeps refusing anything beyond the supported pagination', async () => {
    const payments = client.fake.db.collection('payments');

    await assert.rejects(
        () =>
            payments
                .where('status', '==', 'paid')
                .orderBy('status')
                .limit(2)
                .get(),
        /only FieldPath.documentId\(\) ordering/
    );
    await assert.rejects(
        () =>
            payments
                .where('status', '==', 'paid')
                .orderBy('status')
                .orderBy('createdAt')
                .get(),
        /single orderBy/
    );
    await assert.rejects(
        () =>
            payments
                .where('status', '==', 'paid')
                .startAfter('ms-b1')
                .get(),
        /startAfter\(\) requires a prior orderBy/
    );
});
