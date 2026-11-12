'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, contract, milestone, payment } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;
let strangerApi;

const stamp = (iso) => ({
    _seconds: Math.floor(Date.parse(iso) / 1000),
    _nanoseconds: 0,
});

const storedPayment = (overrides = {}) => {
    const data = payment(overrides);
    if (overrides.milestoneId === null) delete data.milestoneId;
    return data;
};

const seedPayment = (id, overrides = {}) =>
    client.seed('payments', id, storedPayment(overrides));

function seedWorld() {
    client.seed('jobs', 'job-1', job({ title: 'Fix the leaking tap', postedBy: 'employer-1' }));
    client.seed('jobs', 'job-2', job({ title: 'Install kitchen cabinets', postedBy: 'employer-1' }));
    client.seed(
        'contracts',
        'emp-1',
        contract({ status: 'active', jobId: 'job-1', employerId: 'employer-1', employeeId: 'employee-1' })
    );
    client.seed(
        'contracts',
        'emp-2',
        contract({
            status: 'active',
            jobId: 'job-2',
            employmentId: 'emp-2',
            employerId: 'employer-1',
            employeeId: 'employee-1',
        })
    );
    client.seed('milestones', 'ms-1', milestone({ contractId: 'emp-1', label: 'Phase one' }));
    client.seed('milestones', 'ms-2', milestone({ contractId: 'emp-1', label: 'Phase two' }));
}

test.before(async () => {
    client = await startTestServer({ clock: () => '2026-01-10T00:00:00.000Z' });
});

test.after(async () => {
    await client.close();
});

test.beforeEach(async () => {
    client.fake.resetAll();
    employerApi = await client.authed('employer-1');
    employeeApi = await client.authed('employee-1');
    strangerApi = await client.authed('stranger-1');
});

test('history requires authentication and only returns the caller own records', async () => {
    seedWorld();
    seedPayment('ms-1', { employerId: 'employer-1', employeeId: 'employee-1' });
    seedPayment('foreign-1', {
        employerId: 'employer-2',
        employeeId: 'employee-2',
        contractId: 'emp-foreign',
    });

    const unauthenticated = await client.get('/payments/history');
    assert.equal(unauthenticated.status, 401);

    const employer = await employerApi.get('/payments/history');
    assert.equal(employer.status, 200);
    assert.equal(employer.headers['cache-control'], 'no-store');
    assert.deepEqual(employer.body.payments.map((entry) => entry.id), ['ms-1']);
    assert.equal(employer.body.summary.paid.count + employer.body.summary.pending.count, 1);

    const employee = await employeeApi.get('/payments/history');
    assert.equal(employee.status, 200);
    assert.deepEqual(employee.body.payments.map((entry) => entry.id), ['ms-1']);

    const stranger = await strangerApi.get('/payments/history');
    assert.equal(stranger.status, 200);
    assert.deepEqual(stranger.body.payments, []);
    assert.equal(stranger.body.pagination.total, 0);
    assert.equal(stranger.body.summary.paid.count, 0);
});

test('history distinguishes contract and legacy milestone records and joins job context', async () => {
    seedWorld();
    seedPayment('ms-1', {
        status: 'paid',
        amountMinor: 500000,
        paidAt: stamp('2026-01-03T10:00:00.000Z'),
        createdAt: stamp('2026-01-01T10:00:00.000Z'),
    });
    seedPayment('contract_emp-2', {
        paymentTarget: 'contract',
        milestoneId: null,
        contractId: 'emp-2',
        employmentId: 'emp-2',
        status: 'paid',
        amountMinor: 1500000,
        createdAt: stamp('2026-01-02T10:00:00.000Z'),
    });
    seedPayment('legacy-record', {
        paymentTarget: undefined,
        milestoneId: null,
        contractId: 'emp-1',
        employmentId: 'emp-1',
        status: 'created',
        amountMinor: 125000,
        createdAt: stamp('2026-01-04T10:00:00.000Z'),
    });

    const res = await employerApi.get('/payments/history?pageSize=10');
    assert.equal(res.status, 200);

    const byId = Object.fromEntries(res.body.payments.map((entry) => [entry.id, entry]));
    assert.equal(byId['ms-1'].type, 'milestone');
    assert.equal(byId['ms-1'].milestoneId, 'ms-1');
    assert.equal(byId['ms-1'].milestoneLabel, 'Phase one');
    assert.equal(byId['ms-1'].jobId, 'job-1');
    assert.equal(byId['ms-1'].jobTitle, 'Fix the leaking tap');
    assert.equal(byId['ms-1'].reference, 'kp_ms-1');
    assert.equal(byId['ms-1'].viewerRole, 'employer');

    assert.equal(byId['contract_emp-2'].type, 'full_contract');
    assert.equal(byId['contract_emp-2'].reference, 'kp_contract_emp-2');
    assert.equal(byId['contract_emp-2'].milestoneId, null);
    assert.equal(byId['contract_emp-2'].jobId, 'job-2');
    assert.equal(byId['contract_emp-2'].jobTitle, 'Install kitchen cabinets');

    assert.equal(byId['legacy-record'].type, 'milestone');
    assert.equal(byId['legacy-record'].milestoneId, 'legacy-record');

    assert.deepEqual(Object.keys(byId['ms-1']).sort(), [
        'amountMinor',
        'commissionAmountMinor',
        'contractId',
        'createdAt',
        'currency',
        'employmentId',
        'id',
        'jobId',
        'jobTitle',
        'milestoneId',
        'milestoneLabel',
        'paidAt',
        'reference',
        'status',
        'type',
        'viewerRole',
    ]);
    assert.doesNotMatch(JSON.stringify(res.body), /idempotencyKey|providerEnvironment|statusReason/);
});

test('history paginates newest first with stable id tie-breaks and metadata', async () => {
    seedWorld();
    seedPayment('ms-1', { createdAt: stamp('2026-01-01T00:00:00.000Z') });
    seedPayment('ms-2', { createdAt: stamp('2026-01-02T00:00:00.000Z') });
    seedPayment('ms-3', { createdAt: stamp('2026-01-03T00:00:00.000Z') });
    seedPayment('ms-tie-b', { createdAt: stamp('2026-01-04T00:00:00.000Z') });
    seedPayment('ms-tie-a', { createdAt: stamp('2026-01-04T00:00:00.000Z') });

    const first = await employerApi.get('/payments/history?page=1&pageSize=2');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.payments.map((entry) => entry.id), ['ms-tie-a', 'ms-tie-b']);
    assert.deepEqual(first.body.pagination, {
        page: 1,
        pageSize: 2,
        total: 5,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: false,
    });

    const second = await employerApi.get('/payments/history?page=2&pageSize=2');
    assert.deepEqual(second.body.payments.map((entry) => entry.id), ['ms-3', 'ms-2']);
    assert.equal(second.body.pagination.hasPreviousPage, true);

    const third = await employerApi.get('/payments/history?page=3&pageSize=2');
    assert.deepEqual(third.body.payments.map((entry) => entry.id), ['ms-1']);
    assert.equal(third.body.pagination.hasNextPage, false);

    const beyond = await employerApi.get('/payments/history?page=9&pageSize=2');
    assert.deepEqual(beyond.body.payments, []);
    assert.equal(beyond.body.pagination.hasNextPage, false);
});

test('history filters by status, payment type and inclusive date range', async () => {
    seedWorld();
    seedPayment('ms-1', {
        status: 'paid',
        createdAt: stamp('2026-01-01T00:00:00.000Z'),
    });
    seedPayment('ms-2', {
        status: 'failed',
        createdAt: stamp('2026-01-02T23:59:59.000Z'),
    });
    seedPayment('contract_emp-2', {
        paymentTarget: 'contract',
        milestoneId: null,
        contractId: 'emp-2',
        employmentId: 'emp-2',
        status: 'paid',
        createdAt: stamp('2026-01-03T00:00:00.000Z'),
    });

    const paid = await employerApi.get('/payments/history?status=paid');
    assert.deepEqual(paid.body.payments.map((entry) => entry.id), ['contract_emp-2', 'ms-1']);

    const contracts = await employerApi.get('/payments/history?type=full_contract');
    assert.deepEqual(contracts.body.payments.map((entry) => entry.id), ['contract_emp-2']);

    const dates = await employerApi.get('/payments/history?from=2026-01-01&to=2026-01-02');
    assert.deepEqual(dates.body.payments.map((entry) => entry.id), ['ms-2', 'ms-1']);

    const combined = await employerApi.get(
        '/payments/history?status=paid&type=milestone&from=2026-01-01&to=2026-01-01'
    );
    assert.deepEqual(combined.body.payments.map((entry) => entry.id), ['ms-1']);
});

test('history searches references and related job, employment and milestone text', async () => {
    seedWorld();
    seedPayment('ms-1', { status: 'paid' });
    seedPayment('ms-2', { milestoneId: 'ms-2', status: 'failed' });
    seedPayment('contract_emp-2', {
        paymentTarget: 'contract',
        milestoneId: null,
        contractId: 'emp-2',
        employmentId: 'emp-2',
    });

    const reference = await employeeApi.get('/payments/history?q=kp_contract');
    assert.deepEqual(reference.body.payments.map((entry) => entry.id), ['contract_emp-2']);

    const jobTitle = await employeeApi.get('/payments/history?q=kitchen%20cabinets');
    assert.deepEqual(jobTitle.body.payments.map((entry) => entry.id), ['contract_emp-2']);

    const employment = await employeeApi.get('/payments/history?q=emp-1');
    assert.deepEqual(employment.body.payments.map((entry) => entry.id).sort(), ['ms-1', 'ms-2']);

    const milestoneLabel = await employeeApi.get('/payments/history?q=phase%20two');
    assert.deepEqual(milestoneLabel.body.payments.map((entry) => entry.id), ['ms-2']);
});

test('history summary classifies every record once and never double-counts overlap', async () => {
    seedWorld();
    seedPayment('paid-1', { status: 'paid', amountMinor: 100000 });
    seedPayment('paid-2', { status: 'paid', amountMinor: 250000 });
    seedPayment('created-1', { status: 'created', amountMinor: 300000 });
    seedPayment('pending-1', { status: 'pending', amountMinor: 400000 });
    seedPayment('failed-1', { status: 'failed', amountMinor: 500000 });
    seedPayment('review-1', { status: 'needs_review', amountMinor: 600000 });
    seedPayment('other-1', { status: 'unknown', amountMinor: 700000 });
    seedPayment('overlap-1', {
        employerId: 'employer-1',
        employeeId: 'employer-1',
        status: 'paid',
        amountMinor: 800000,
    });

    const res = await employerApi.get('/payments/history?status=failed');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.payments.map((entry) => entry.id), ['failed-1']);

    assert.deepEqual(res.body.summary.paid, { count: 3, amountMinor: 1150000 });
    assert.deepEqual(res.body.summary.pending, { count: 2, amountMinor: 700000 });
    assert.deepEqual(res.body.summary.failed, { count: 1, amountMinor: 500000 });
    assert.deepEqual(res.body.summary.needsReview, { count: 1, amountMinor: 600000 });
    assert.deepEqual(res.body.summary.other, { count: 1, amountMinor: 700000 });
    assert.equal(res.body.summary.scope, 'all');
    assert.equal(res.body.summary.currency, 'NGN');
});

test('history rejects unsafe or malformed query values with safe messages', async () => {
    seedWorld();

    const cases = [
        ['status=unknown', 'status is not a recognised payment status'],
        ['type=refund', 'type must be milestone or full_contract'],
        ['page=0', 'page must be a positive integer'],
        ['pageSize=51', 'pageSize cannot exceed 50'],
        ['from=01-01-2026', 'from must use YYYY-MM-DD'],
        ['to=2026-02-30', 'to must be a valid date'],
        ['from=2026-02-02&to=2026-02-01', 'from cannot be after to'],
        ['q=' + 'x'.repeat(121), 'q cannot exceed 120 characters'],
    ];

    for (const [query, message] of cases) {
        const res = await employerApi.get(`/payments/history?${query}`);
        assert.equal(res.status, 400, query);
        assert.deepEqual(res.body, { message }, query);
    }
});

test('history returns no provider secrets or internal error details', async () => {
    seedWorld();
    seedPayment('ms-1', {
        status: 'needs_review',
        statusReason: 'provider response did not match the expected transaction',
        providerReference: 'kp_ms-1',
        providerEnvironment: 'test',
        providerFeeMinor: 123,
        idempotencyKey: 'private-client-key',
        verifyAttempts: 4,
    });

    const res = await employeeApi.get('/payments/history');
    assert.equal(res.status, 200);
    const serialised = JSON.stringify(res.body);

    assert.doesNotMatch(serialised, /private-client-key/);
    assert.doesNotMatch(serialised, /provider response did not match/);
    assert.doesNotMatch(serialised, /providerEnvironment|providerFeeMinor|verifyAttempts/);
    assert.deepEqual(Object.keys(res.body.payments[0]).sort(), [
        'amountMinor',
        'commissionAmountMinor',
        'contractId',
        'createdAt',
        'currency',
        'employmentId',
        'id',
        'jobId',
        'jobTitle',
        'milestoneId',
        'milestoneLabel',
        'paidAt',
        'reference',
        'status',
        'type',
        'viewerRole',
    ]);
});

test('a legacy milestone record with no paymentTarget stays a milestone even with a contract-like id', async () => {
    seedWorld();
    seedPayment('contract_not-a-contract-payment', {
        paymentTarget: undefined,
        milestoneId: null,
        contractId: 'emp-1',
        status: 'created',
    });

    const res = await employerApi.get('/payments/history');
    assert.equal(res.status, 200);
    assert.equal(res.body.payments[0].type, 'milestone');
    assert.equal(res.body.payments[0].milestoneId, 'contract_not-a-contract-payment');
    assert.equal(res.body.payments[0].milestoneLabel, null);
});

test('history has no mutation surface', async () => {
    seedWorld();
    seedPayment('ms-1');

    for (const method of ['post', 'put', 'delete']) {
        const res = await employerApi[method]('/payments/history');
        assert.equal(res.status, 404, method);
    }

    assert.deepEqual(client.readDoc('payments', 'ms-1'), storedPayment());
});

test('history does not read a whole unrelated employment graph for an empty account', async () => {
    seedWorld();
    seedPayment('ms-1');

    const res = await strangerApi.get('/payments/history');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.payments, []);
    assert.equal(res.body.pagination.total, 0);
    assert.equal(res.body.summary.paid.count, 0);
    assert.equal(res.body.summary.pending.count, 0);
    assert.equal(res.body.summary.failed.count, 0);
    assert.equal(res.body.summary.needsReview.count, 0);
    assert.equal(res.body.summary.other.count, 0);
});
