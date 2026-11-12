'use strict';

/**
 * Stage 2H.1 audit-hardening tests.
 *
 * They prove the read-only audit now covers three gaps found in the Stage 2G
 * review: legacy releases without attempt documents are still audited through a
 * synthetic attempt view, journals that do not own a payment/release/attempt
 * are reported as orphans, and compensating journals must be structural
 * reversals that count once.
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
let accountingJournal;
let accountingService;
let journalRepository;
let lifecycle;
let audit;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;

test.before(async () => {
    client = await startTestServer();
    accountingJournal = require('../services/accountingJournal');
    accountingService = require('../services/accountingService');
    journalRepository = require('../repositories/journalRepository');
    lifecycle = require('../services/accountingLifecycleService');
    audit = require('../services/accountingReconciliationService');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
});

const codes = (result) => result.discrepancies.map((entry) => entry.code);
const journals = () => Object.values(client.readAll('ledgerJournals'));

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

function seedLegacyRelease(overrides = {}) {
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
        ...overrides,
    });
}

async function postLegacyJournals({ status }) {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    seedLegacyRelease({ status });
    const initiation = await accountingService.recordPayoutInitiation({
        releaseId: RELEASE_ID,
    });
    assert.equal(initiation.created, true);
    if (status === 'succeeded') {
        await accountingService.recordPayoutSucceeded({ releaseId: RELEASE_ID });
    } else if (status === 'failed') {
        await accountingService.recordPayoutFailed({ releaseId: RELEASE_ID });
    } else if (status === 'needs_review') {
        await accountingService.recordPayoutUnknown({ releaseId: RELEASE_ID });
    }
}

test('a legacy succeeded release with all journals audits clean', async () => {
    await postLegacyJournals({ status: 'succeeded' });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, true, JSON.stringify(result.discrepancies));
});

test('a legacy succeeded release missing its success journal is reported', async () => {
    await postLegacyJournals({ status: 'succeeded' });
    const success = journals().find(
        (journal) => journal.journalType === 'payout_succeeded'
    );
    client.fake.db.collection('ledgerJournals').doc(success.journalId).delete();

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    const finding = result.discrepancies.find(
        (entry) => entry.code === 'ATTEMPT_OUTCOME_COUNT'
    );
    assert.ok(finding, JSON.stringify(result.discrepancies));
    assert.equal(finding.legacy, true);
});

test('a legacy failed release with all journals audits clean', async () => {
    await postLegacyJournals({ status: 'failed' });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, true, JSON.stringify(result.discrepancies));
});

test('a legacy needs_review release with an unknown journal audits clean', async () => {
    await postLegacyJournals({ status: 'needs_review' });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, true, JSON.stringify(result.discrepancies));
});

test('a legacy in_flight release with only an initiation audits clean', async () => {
    await postLegacyJournals({ status: 'in_flight' });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, true, JSON.stringify(result.discrepancies));
});

test('a legacy open release carrying an outcome journal is reported', async () => {
    await postLegacyJournals({ status: 'in_flight' });

    const built = accountingJournal.buildPayoutFailedJournal({
        releaseId: RELEASE_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    const finding = result.discrepancies.find(
        (entry) => entry.code === 'ATTEMPT_UNEXPECTED_OUTCOME'
    );
    assert.ok(finding, JSON.stringify(result.discrepancies));
    assert.equal(finding.legacy, true);
});

test('a legacy release that claims an attempt while still requested is reported', async () => {
    seedLegacyRelease({ status: 'requested', attemptCount: 1 });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('LEGACY_RELEASE_STATE_INCONSISTENT'));
});

test('an unclaimed legacy release has no attempt-level checks', async () => {
    seedLegacyRelease({ status: 'requested', attemptCount: 0 });
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: PAYMENT_ID,
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: 'requested',
        attemptCount: 0,
        currentAttemptNumber: 0,
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, true, JSON.stringify(result.discrepancies));
});

test('a collection journal whose payment does not exist is an orphan', async () => {
    const built = accountingJournal.buildCollectionJournal({
        paymentId: 'ghost-payment',
        amountMinor: AMOUNT,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    const finding = result.discrepancies.find(
        (entry) =>
            entry.code === 'ORPHAN_JOURNAL'
            && entry.entityId === built.journal.journalId
    );
    assert.ok(finding, JSON.stringify(result.discrepancies));
});

test('a payout journal whose release does not exist is an orphan', async () => {
    const built = accountingJournal.buildPayoutInitiationJournal({
        releaseId: 'ghost-release',
        amountMinor: AMOUNT,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('ORPHAN_JOURNAL'));
});

test('a collection journal whose sourceId names another payment is an orphan', async () => {
    seedFundedMilestone();
    const built = accountingJournal.buildCollectionJournal({
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        { ...built.journal, sourceId: 'other-payment' },
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('ORPHAN_JOURNAL'));
});

test('a payout journal for an attempt the release does not store is reported', async () => {
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: PAYMENT_ID,
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: 'in_flight',
        attemptCount: 1,
        currentAttemptNumber: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });
    client.seed('releaseAttempts', `${RELEASE_ID}__attempt_1`, {
        releaseId: RELEASE_ID,
        attemptNumber: 1,
        status: 'submitted',
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });

    const built = accountingJournal.buildPayoutInitiationJournal({
        releaseId: RELEASE_ID,
        attemptNumber: 2,
        amountMinor: AMOUNT,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('JOURNAL_ATTEMPT_REFERENCE_MISSING'));
});

test('a legacy payout journal beyond the claimed attempt count is reported', async () => {
    seedLegacyRelease({ status: 'failed', attemptCount: 1 });
    const built = accountingJournal.buildPayoutInitiationJournal({
        releaseId: RELEASE_ID,
        attemptNumber: 2,
        amountMinor: AMOUNT,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('JOURNAL_ATTEMPT_REFERENCE_MISSING'));
});

test('a compensating journal that is not a structural reversal is reported', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    const target = journals()[0];
    const targetLines = (
        await journalRepository.listEntriesByJournalId(target.journalId)
    ).docs.map((doc) => ({ entryId: doc.id, ...doc.data() }));

    const built = accountingJournal.buildCompensatingJournal({
        originalJournal: target,
        originalLines: targetLines,
        reason: 'tampered',
    });
    built.entries[0].data.amountMinor += 1;
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('COMPENSATION_MISMATCH'));
});

test('duplicate reversals are reported and do not count as compensation', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    const target = journals()[0];
    const targetLines = (
        await journalRepository.listEntriesByJournalId(target.journalId)
    ).docs.map((doc) => ({ entryId: doc.id, ...doc.data() }));

    const first = accountingJournal.buildCompensatingJournal({
        originalJournal: target,
        originalLines: targetLines,
        reason: 'first',
    });
    await journalRepository.createJournalWithEntries(
        first.journal.journalId,
        first.journal,
        first.entries
    );

    const duplicateId = 'jrn_manual_duplicate';
    const second = accountingJournal.buildCompensatingJournal({
        originalJournal: target,
        originalLines: targetLines,
        reason: 'duplicate',
    });
    const secondJournal = { ...second.journal, journalId: duplicateId };
    const secondEntries = second.entries.map((entry, index) => ({
        entryId: `${duplicateId}__line_${index + 1}`,
        data: { ...entry.data, journalId: duplicateId },
    }));
    await journalRepository.createJournalWithEntries(
        duplicateId,
        secondJournal,
        secondEntries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('COMPENSATION_DUPLICATED'));
    assert.ok(!codes(result).includes('COLLECTION_MISSING_OR_DUPLICATED'));
});

test('a valid reversal emits no compensation findings', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    const target = journals()[0];
    const reversed = await accountingService.reverseJournal({
        journalId: target.journalId,
        reason: 'test reversal',
    });
    assert.equal(reversed.created, true);

    const result = await audit.auditAccounting();
    assert.deepEqual(
        codes(result).filter((code) => code.startsWith('COMPENSATION_')),
        []
    );
    assert.ok(!codes(result).includes('ORPHAN_JOURNAL'));
});
