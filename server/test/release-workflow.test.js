'use strict';

process.env.PAYSTACK_SECRET_KEY =
    process.env.PAYSTACK_SECRET_KEY || 'sk_test_release_workflow';

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

const RELEASE_ID = 'rel_ms-1';
const TRANSFER_REFERENCE = 'rel_ms-1_attempt_1';

let client;
let transferService;

test.before(async () => {
    client = await startTestServer();
    transferService = require('../services/paystackTransferService');
});

test.after(async () => {
    await client.close();
});

test.beforeEach(() => {
    client.fake.resetAll();
    client.paystack.reset();
    client.paystackTransfer.reset();
    delete client.app.locals.releaseProvider;
});

function seedFundedMilestone({ taskStatus = 'approved' } = {}) {
    client.seed('employments', 'emp-1', employment({ status: 'active' }));
    client.seed(
        'contracts',
        'emp-1',
        contract({ paymentMode: 'milestones', status: 'active' })
    );
    client.seed(
        'milestones',
        'ms-1',
        milestone({
            contractId: 'emp-1',
            employmentId: 'emp-1',
            taskId: 'task-1',
            amountMinor: 500000,
        })
    );
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
        })
    );
    client.seed(
        'tasks',
        'task-1',
        task({
            employmentId: 'emp-1',
            milestoneId: 'ms-1',
            status: taskStatus,
        })
    );
}

async function savePayoutAccount(employee) {
    client.paystackTransfer.respondWithBanks([
        { name: 'Access Bank', code: '057', currency: 'NGN' },
    ]);
    client.paystackTransfer.respondWithAccountName('Ada Employee');

    return employee.put('/users/payout-account', {
        body: {
            bankAccountNumber: '0123456789',
            bankCode: '057',
            accountName: 'Spoofed Name',
        },
    });
}

async function createMilestoneRelease(employer) {
    return employer.post('/releases', {
        body: { targetType: 'milestone', targetId: 'ms-1' },
    });
}

test('payout accounts are validated, stored in full, and exposed only as a mask', async () => {
    const employee = await client.authed('employee-1');

    const empty = await employee.get('/users/payout-account');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, { payoutAccount: { configured: false } });

    const invalid = await employee.put('/users/payout-account', {
        body: { bankAccountNumber: '123', bankCode: '057', accountName: 'Ada' },
    });
    assert.equal(invalid.status, 400);

    const saved = await savePayoutAccount(employee);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.payoutAccount.configured, true);
    assert.equal(saved.body.payoutAccount.bankCode, '057');
    assert.equal(saved.body.payoutAccount.bankName, 'Access Bank');
    assert.equal(saved.body.payoutAccount.accountName, 'Ada Employee');
    assert.equal(saved.body.payoutAccount.accountNumberLast4, '6789');
    assert.equal(saved.body.payoutAccount.bankAccountNumber, undefined);

    const stored = client.readDoc('payoutAccounts', 'employee-1');
    assert.equal(stored.bankAccountNumber, '0123456789');
    assert.equal(stored.accountName, 'Ada Employee');

    const read = await employee.get('/users/payout-account');
    assert.deepEqual(read.body, saved.body);
});

test('payout banks come from Paystack and resolving an account never trusts a submitted name', async () => {
    const employee = await client.authed('employee-1');

    client.paystackTransfer.respondWithBanks([
        { name: 'Zenith Bank', code: '057', currency: 'NGN' },
        { name: 'Access Bank', code: '044', currency: 'NGN' },
        { name: 'Not a bank', code: 'oops', currency: 'NGN' },
    ]);

    const banks = await employee.get('/users/payout-account/banks');
    assert.equal(banks.status, 200);
    assert.deepEqual(
        banks.body.banks.map((bank) => bank.code),
        ['044', '057']
    );
    assert.equal(banks.body.banks[0].name, 'Access Bank');
    assert.equal(
        client.paystackTransfer.calls[0].args[0].currency,
        'NGN'
    );

    client.paystackTransfer.respondWithBanks([
        { name: 'Access Bank', code: '044', currency: 'NGN' },
    ]);
    client.paystackTransfer.respondWithAccountName('Ada Employee');

    const resolved = await employee.post('/users/payout-account/resolve', {
        body: {
            bankAccountNumber: '0123456789',
            bankCode: '044',
            accountName: 'Spoofed Name',
        },
    });

    assert.equal(resolved.status, 200);
    assert.deepEqual(resolved.body.payoutAccount, {
        bankAccountNumber: '0123456789',
        bankCode: '044',
        bankName: 'Access Bank',
        accountName: 'Ada Employee',
    });
    assert.deepEqual(
        client.paystackTransfer.calls
            .find((call) => call.operation === 'resolveAccount')
            .args.slice(0, 2),
        ['0123456789', '044']
    );
});

test('payout account verification rejects a bank Paystack does not list', async () => {
    const employee = await client.authed('employee-1');

    client.paystackTransfer.respondWithBanks([
        { name: 'Access Bank', code: '044', currency: 'NGN' },
    ]);

    const response = await employee.post('/users/payout-account/resolve', {
        body: { bankAccountNumber: '0123456789', bankCode: '999' },
    });

    assert.equal(response.status, 400);
    assert.match(response.body.message, /not a supported Paystack bank/);
    assert.equal(
        client.paystackTransfer.calls.some((call) => call.operation === 'resolveAccount'),
        false
    );
});

test('a Paystack account-resolution rejection is a safe 400, not a 500', async () => {
    const employee = await client.authed('employee-1');

    client.paystackTransfer.respondWithBanks([
        { name: 'Access Bank', code: '044', currency: 'NGN' },
    ]);
    client.paystackTransfer.queue('resolveAccount', () => {
        const error = new Error('provider rejected');
        error.statusCode = 400;
        error.providerMessage = 'Could not resolve account name. Check parameters';
        throw error;
    });

    const response = await employee.post('/users/payout-account/resolve', {
        body: { bankAccountNumber: '0123456789', bankCode: '044' },
    });

    assert.equal(response.status, 400);
    assert.equal(
        response.body.message,
        'Could not resolve account name. Check parameters'
    );
});

test('the release workspace is party-only and hides an employee bank number from the employer', async () => {
    seedFundedMilestone();
    const employer = await client.authed('employer-1');
    const employee = await client.authed('employee-1');
    const stranger = await client.authed('stranger-1');
    await savePayoutAccount(employee);

    const employerView = await employer.get('/releases/employment/emp-1');
    assert.equal(employerView.status, 200);
    assert.equal(employerView.body.eligibility.status, 'eligible');
    assert.equal(employerView.body.targets.length, 1);
    assert.equal(employerView.body.targets[0].targetId, 'ms-1');
    assert.deepEqual(employerView.body.payoutAccount, { configured: true });

    const employeeView = await employee.get('/releases/employment/emp-1');
    assert.equal(employeeView.status, 200);
    assert.equal(employeeView.body.payoutAccount.accountNumberLast4, '6789');
    assert.equal(employeeView.body.payoutAccount.accountName, 'Ada Employee');

    const strangerView = await stranger.get('/releases/employment/emp-1');
    assert.equal(strangerView.status, 403);
});

test('release creation is employer-only and refuses ineligible work', async () => {
    seedFundedMilestone({ taskStatus: 'assigned' });
    const employer = await client.authed('employer-1');
    const employee = await client.authed('employee-1');

    const employeeAttempt = await createMilestoneRelease(employee);
    assert.equal(employeeAttempt.status, 403);
    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 0);

    const ineligible = await createMilestoneRelease(employer);
    assert.equal(ineligible.status, 409);
    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 0);
});

test('release creation is idempotent for an eligible milestone', async () => {
    seedFundedMilestone();
    const employer = await client.authed('employer-1');

    const first = await createMilestoneRelease(employer);
    assert.equal(first.status, 201);
    assert.equal(first.body.created, true);
    assert.equal(first.body.release.id, RELEASE_ID);
    assert.equal(first.body.release.status, 'requested');

    const second = await createMilestoneRelease(employer);
    assert.equal(second.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.release.id, RELEASE_ID);
    assert.equal(Object.keys(client.readAll('releaseRequests')).length, 1);
});

test('approval requires a payout account and makes no provider call without one', async () => {
    seedFundedMilestone();
    const employer = await client.authed('employer-1');
    const created = await createMilestoneRelease(employer);
    assert.equal(created.status, 201);

    const provider = createSimulatedReleaseProvider();
    client.app.locals.releaseProvider = provider;

    const approved = await employer.post(`/releases/${RELEASE_ID}/approve`);
    assert.equal(approved.status, 409);
    assert.match(approved.body.message, /payout account/i);
    assert.equal(provider.calls.length, 0);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'requested');
});

test('approval sends the stored payout details and is idempotent', async () => {
    seedFundedMilestone();
    const employer = await client.authed('employer-1');
    const employee = await client.authed('employee-1');
    await savePayoutAccount(employee);
    const created = await createMilestoneRelease(employer);
    assert.equal(created.status, 201);

    const provider = createSimulatedReleaseProvider({
        outcomes: { [RELEASE_ID]: { outcome: 'succeeded' } },
    });
    client.app.locals.releaseProvider = provider;

    const approved = await employer.post(`/releases/${RELEASE_ID}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.submitted, true);
    assert.equal(approved.body.outcome, 'succeeded');
    assert.equal(approved.body.release.status, 'succeeded');
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].amountMinor, 500000);
    assert.equal(provider.calls[0].transferReference, TRANSFER_REFERENCE);
    assert.equal(provider.calls[0].bankAccountNumber, '0123456789');
    assert.equal(provider.calls[0].bankCode, '057');
    assert.equal(provider.calls[0].accountName, 'Ada Employee');

    const duplicate = await employer.post(`/releases/${RELEASE_ID}/approve`);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.submitted, false);
    assert.equal(duplicate.body.outcome, 'succeeded');
    assert.equal(provider.calls.length, 1);

    const employeeAttempt = await employee.post(`/releases/${RELEASE_ID}/approve`);
    assert.equal(employeeAttempt.status, 403);
    assert.equal(provider.calls.length, 1);
});

test('a transfer webhook reconciles the release and ignores unrelated references', async () => {
    seedFundedMilestone();
    const employer = await client.authed('employer-1');
    const employee = await client.authed('employee-1');
    await savePayoutAccount(employee);
    const created = await createMilestoneRelease(employer);
    assert.equal(created.status, 201);

    const provider = createSimulatedReleaseProvider({
        defaultOutcome: 'unknown',
        lookups: { [RELEASE_ID]: { outcome: 'succeeded' } },
    });
    client.app.locals.releaseProvider = provider;

    const approved = await employer.post(`/releases/${RELEASE_ID}/approve`);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.outcome, 'unknown');
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');

    const ignored = await transferService.handlePaystackTransferWebhook(
        {
            event: 'transfer.success',
            data: { reference: 'not_a_release_transfer', status: 'success' },
        },
        { provider }
    );
    assert.equal(ignored.handled, false);
    assert.equal(provider.lookupCalls.length, 0);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'needs_review');

    const reconciled = await transferService.handlePaystackTransferWebhook(
        {
            event: 'transfer.success',
            data: { reference: TRANSFER_REFERENCE, status: 'success' },
        },
        { provider }
    );
    assert.equal(reconciled.handled, true);
    assert.equal(reconciled.reconciled, true);
    assert.equal(reconciled.releaseId, RELEASE_ID);
    assert.equal(provider.lookupCalls.length, 1);
    assert.equal(provider.lookupCalls[0].transferReference, TRANSFER_REFERENCE);
    assert.equal(client.readDoc('releaseRequests', RELEASE_ID).status, 'succeeded');
});
