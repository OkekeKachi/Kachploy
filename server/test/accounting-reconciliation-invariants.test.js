'use strict';

/**
 * Stage 2G read-only accounting audit tests.
 *
 * They prove that accountingReconciliationService's auditAccounting accepts a
 * consistent ledger covering the real flows (a clean success and an unknown
 * recovered to success) and reports specific, named discrepancies for
 * corrupted or inconsistent states -- without ever writing anything itself.
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
const clock = require('../config/clock');

let client;
let accounting;
let accountingJournal;
let journalRepository;
let lifecycle;
let orchestration;
let releaseService;
let audit;

const RELEASE_ID = 'rel_ms-1';
const PAYMENT_ID = 'ms-1';
const AMOUNT = 500000;

test.before(async () => {
    client = await startTestServer();
    accounting = require('../config/accounting');
    accountingJournal = require('../services/accountingJournal');
    journalRepository = require('../repositories/journalRepository');
    lifecycle = require('../services/accountingLifecycleService');
    orchestration = require('../services/releaseOrchestrationService');
    releaseService = require('../services/releaseService');
    audit = require('../services/accountingReconciliationService');
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
    client.seed('contracts', 'emp-1', contract({ paymentMode: 'milestones', status: 'active' }));
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

async function runSuccessFlow() {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: PAYMENT_ID,
    });
    const provider = createSimulatedReleaseProvider({ defaultOutcome: 'succeeded' });
    return orchestration.submitReleaseAttempt(RELEASE_ID, { provider });
}

const codes = (result) => result.discrepancies.map((d) => d.code);

test('a clean successful flow audits clean with balanced global totals', async () => {
    const submitted = await runSuccessFlow();
    assert.equal(submitted.outcome, 'succeeded');

    const result = await audit.auditAccounting();
    assert.equal(result.ok, true);
    assert.deepEqual(result.discrepancies, []);
    assert.equal(result.totals.debitMinor, result.totals.creditMinor);
    assert.deepEqual(result.accountBalances, {
        collected_funds: AMOUNT,
        employee_payable: 0,
        platform_revenue: 0,
        payout_initiation: 0,
        completed_payout: -AMOUNT,
        unresolved_outcome: 0,
    });
    assert.deepEqual(result.counts, {
        journals: 3,
        entries: 6,
        payments: 1,
        releases: 1,
        attempts: 1,
    });
});

test('an unknown outcome recovered to success also audits clean', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: PAYMENT_ID,
    });

    await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: createSimulatedReleaseProvider({ defaultOutcome: 'unknown' }),
    });
    await orchestration.resolveRelease(RELEASE_ID, {
        outcome: 'succeeded',
        actor: 'admin-1',
        evidence: {
            source: 'provider_reconciliation',
            reference: 'recovered-success-ref',
        },
    });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, true, JSON.stringify(result.discrepancies));
    assert.equal(result.counts.journals, 4);
});

test('an entry that references a missing journal is reported as an orphan', async () => {
    client.seed('ledgerEntries', 'jrn_missing__line_1', {
        journalId: 'jrn_missing',
        entryType: 'journal_line',
        journalType: 'collection',
        lineNumber: 1,
        account: 'collected_funds',
        direction: 'debit',
        amountMinor: 1,
        currency: 'NGN',
        createdAt: clock.now(),
    });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('ORPHAN_LEDGER_ENTRY'));
});

test('an unbalanced stored journal is reported', async () => {
    client.seed('ledgerJournals', 'jrn_bogus1', {
        journalId: 'jrn_bogus1',
        journalType: 'collection',
        currency: 'NGN',
        totalDebitMinor: 10,
        totalCreditMinor: 9,
        lineCount: 0,
        createdAt: clock.now(),
    });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('JOURNAL_UNBALANCED'));
    assert.ok(codes(result).includes('LEDGER_UNBALANCED_TOTALS'));
});

test('a paid payment with no collection journal is reported', async () => {
    seedFundedMilestone();

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('COLLECTION_MISSING_OR_DUPLICATED'));
});

test('a collection journal for a payment that is not paid is reported', async () => {
    seedFundedMilestone();
    const built = accountingJournal.buildCollectionJournal({
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );
    client.seed(
        'payments',
        PAYMENT_ID,
        payment({
            milestoneId: PAYMENT_ID,
            amountMinor: AMOUNT,
            currency: 'NGN',
            status: 'pending',
        })
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('COLLECTION_WITHOUT_PAID_PAYMENT'));
});

test('a collection journal that does not match the payment amount is reported', async () => {
    seedFundedMilestone();
    const built = accountingJournal.buildCollectionJournal({
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT + 1,
        currency: 'NGN',
    });
    await journalRepository.createJournalWithEntries(
        built.journal.journalId,
        built.journal,
        built.entries
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('COLLECTION_AMOUNT_MISMATCH'));
});

test('a succeeded release with no success journal is reported', async () => {
    await runSuccessFlow();
    client.seed('releaseRequests', RELEASE_ID, {
        releaseId: RELEASE_ID,
        targetType: 'milestone',
        targetId: PAYMENT_ID,
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        status: 'failed',
        attemptCount: 1,
        currentAttemptNumber: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('RELEASE_SUCCESS_WITHOUT_TERMINAL_SUCCESS'));
});

test('an attempt whose stored status disagrees with its outcome journal is reported', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: PAYMENT_ID,
    });
    await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: createSimulatedReleaseProvider({ defaultOutcome: 'failed' }),
    });

    client.seed('releaseAttempts', `${RELEASE_ID}__attempt_1`, {
        releaseId: RELEASE_ID,
        attemptNumber: 1,
        status: 'succeeded',
        paymentId: PAYMENT_ID,
        amountMinor: AMOUNT,
        currency: 'NGN',
        submissionClaimedAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
    });

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('ATTEMPT_OUTCOME_COUNT'));
    assert.ok(codes(result).includes('ATTEMPT_OUTCOME_KIND_MISMATCH'));
});

test('a release whose amount disagrees with its funding payment is reported', async () => {
    seedFundedMilestone();
    await lifecycle.ensureCollectionForPayment(PAYMENT_ID);
    await releaseService.createReleaseRequest({
        targetType: 'milestone',
        targetId: PAYMENT_ID,
    });
    await orchestration.submitReleaseAttempt(RELEASE_ID, {
        provider: createSimulatedReleaseProvider({ defaultOutcome: 'failed' }),
    });

    client.seed(
        'payments',
        PAYMENT_ID,
        payment({
            milestoneId: PAYMENT_ID,
            amountMinor: AMOUNT + 12345,
            currency: 'NGN',
            status: 'paid',
        })
    );

    const result = await audit.auditAccounting();
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes('RELEASE_AMOUNT_MISMATCH'));
    assert.ok(codes(result).includes('COLLECTION_AMOUNT_MISMATCH'));
});
