'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { calculateCheckoutChargeMinor } = require('../config/fees');
const { job, application, employment, task, user } = require('../testing/fixtures');

const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const SECRET_KEY_ENV = 'PAYSTACK_SECRET_KEY';
const FAKE_CHECKOUT_URL = 'https://checkout.paystack.com/pay/test_auth_key';

let client;
let employerApi;
let employeeApi;
const savedEnv = { had: false, value: undefined };

test.before(async () => {
    client = await startTestServer();
});

test.after(async () => {
    await client.close();
});

test.beforeEach(async () => {
    client.fake.resetAll();
    client.paystack.reset();
    client.paystack.sleep = async () => {};
    savedEnv.had = Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV);
    savedEnv.value = process.env[SECRET_KEY_ENV];
    process.env[SECRET_KEY_ENV] = FAKE_TEST_KEY;
    employerApi = await client.authed('employer-1', { email: 'employer@example.test' });
    employeeApi = await client.authed('employee-1', { email: 'employee@example.test' });
});

test.afterEach(() => {
    if (savedEnv.had) {
        process.env[SECRET_KEY_ENV] = savedEnv.value;
    } else {
        delete process.env[SECRET_KEY_ENV];
    }
});

const seedHiredWorld = () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed(
        'applications',
        'app-1',
        application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
    );
    client.seed(
        'employments',
        'emp-1',
        employment({ jobId: 'job-1', applicationId: 'app-1', status: 'active' })
    );
    client.seed(
        'users',
        'employer-1',
        user({ uid: 'employer-1', email: 'employer@example.test', role: 'employer' })
    );
    client.seed(
        'users',
        'employee-1',
        user({ uid: 'employee-1', email: 'employee@example.test', role: 'employee' })
    );
};

const initializeResponse = (payload) => ({
    status: true,
    message: 'Authorization URL created',
    data: {
        authorization_url: FAKE_CHECKOUT_URL,
        access_code: 'access_code_1',
        reference: payload.reference,
    },
});

const verifyResponse = (reference, amount, overrides = {}) => ({
    status: true,
    message: 'Verification successful',
    data: {
        reference,
        currency: 'NGN',
        amount,
        status: 'success',
        fees: 1234,
        ...overrides,
    },
});

const createMilestoneContract = async () => {
    const res = await employerApi.post('/contracts', {
        body: {
            employmentId: 'emp-1',
            paymentMode: 'milestones',
            milestones: [
                { taskId: 'task-1', label: 'Phase one', amountMinor: 500000 },
                { taskId: 'task-2', label: 'Phase two', amountMinor: 1000000 },
            ],
        },
    });
    assert.equal(res.status, 200);
    assert.equal((await employeeApi.post('/contracts/emp-1/accept')).status, 200);
    return res.body.milestones.map((milestone) => milestone.id);
};

const createFullContract = async () => {
    const res = await employerApi.post('/contracts', {
        body: {
            employmentId: 'emp-1',
            paymentMode: 'full',
            totalAmountMinor: 1500000,
        },
    });
    assert.equal(res.status, 200);
    assert.equal((await employeeApi.post('/contracts/emp-1/accept')).status, 200);
    return res.body.contract.id;
};

const createMilestonePayment = async (milestoneId, key = `key-${milestoneId}`) => {
    const res = await employerApi.post('/payments', {
        body: { milestoneId, idempotencyKey: key },
    });
    assert.equal(res.status, 200);
    return res.body.payment;
};

const initializeMilestonePayment = async (milestoneId) => {
    client.paystack.respondWith(initializeResponse);
    const res = await employerApi.post('/payments/initialize', {
        body: { milestoneId },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'pending');
    return res.body;
};

const verifyMilestonePayment = async (milestoneId, amount, overrides = {}) => {
    client.paystack.respondWithVerify((reference) =>
        verifyResponse(reference, amount, overrides)
    );
    const res = await employerApi.post('/payments/verify', {
        body: { milestoneId },
    });
    assert.equal(res.status, 200);
    return res.body;
};

test('acceptance: employer pays a milestone and both parties see the confirmed history', async () => {
    seedHiredWorld();
    client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
    client.seed('tasks', 'task-2', task({ employmentId: 'emp-1', status: 'approved' }));
    const [milestoneId, otherMilestoneId] = await createMilestoneContract();

    const before = await employeeApi.get(`/payments/milestone/${milestoneId}`);
    assert.equal(before.status, 404);

    const employeeCreate = await employeeApi.post('/payments', {
        body: { milestoneId, idempotencyKey: 'employee-attempt' },
    });
    assert.equal(employeeCreate.status, 403);

    const employeeInitialize = await employeeApi.post('/payments/initialize', {
        body: { milestoneId },
    });
    assert.equal(employeeInitialize.status, 403);

    const created = await createMilestonePayment(milestoneId, 'acceptance-milestone-key');
    assert.equal(created.status, 'created');
    assert.equal(created.amountMinor, 500000);

    const employerRead = await employerApi.get(`/payments/milestone/${milestoneId}`);
    const employeeRead = await employeeApi.get(`/payments/milestone/${milestoneId}`);
    assert.equal(employerRead.status, 200);
    assert.equal(employeeRead.status, 200);
    assert.equal(employerRead.body.payment.status, 'created');
    assert.equal(employeeRead.body.payment.status, 'created');

    const initialized = await initializeMilestonePayment(milestoneId);
    assert.equal(initialized.checkoutUrl, FAKE_CHECKOUT_URL);
    assert.equal(
        initialized.chargeMinor,
        calculateCheckoutChargeMinor(500000)
    );

    const verified = await verifyMilestonePayment(
        milestoneId,
        500000,
        { amount: calculateCheckoutChargeMinor(500000) }
    );
    assert.equal(verified.verified, true);
    assert.equal(verified.payment.status, 'paid');

    const employerHistory = await employerApi.get('/payments/history?type=milestone');
    const employeeHistory = await employeeApi.get('/payments/history?type=milestone');
    assert.equal(employerHistory.status, 200);
    assert.equal(employeeHistory.status, 200);
    assert.deepEqual(employerHistory.body.payments.map((payment) => payment.id), [milestoneId]);
    assert.deepEqual(employeeHistory.body.payments.map((payment) => payment.id), [milestoneId]);
    assert.equal(employerHistory.body.payments[0].status, 'paid');
    assert.equal(employeeHistory.body.payments[0].status, 'paid');
    assert.equal(employerHistory.body.payments[0].milestoneLabel, 'Phase one');
    assert.equal(employeeHistory.body.payments[0].viewerRole, 'employee');
    assert.equal(employerHistory.body.summary.paid.amountMinor, 500000);
    assert.equal(employeeHistory.body.summary.paid.amountMinor, 500000);
    assert.equal(client.readDoc('payments', otherMilestoneId), undefined);
    assert.equal(client.readDoc('payments', milestoneId).status, 'paid');
});

test('acceptance: employer pays a full contract and both parties see the confirmed history', async () => {
    seedHiredWorld();
    const contractId = await createFullContract();

    const before = await employeeApi.get(`/payments/contract/${contractId}`);
    assert.equal(before.status, 404);

    const employeeCreate = await employeeApi.post('/payments/contract', {
        body: { contractId, idempotencyKey: 'employee-full-contract-attempt' },
    });
    assert.equal(employeeCreate.status, 403);

    const employeeInitialize = await employeeApi.post('/payments/contract/initialize', {
        body: { contractId },
    });
    assert.equal(employeeInitialize.status, 403);

    const createdRes = await employerApi.post('/payments/contract', {
        body: { contractId, idempotencyKey: 'acceptance-full-contract-key' },
    });
    assert.equal(createdRes.status, 200);
    assert.equal(createdRes.body.payment.status, 'created');
    assert.equal(createdRes.body.payment.paymentTarget, 'contract');
    assert.equal(createdRes.body.payment.amountMinor, 1500000);
    const paymentId = createdRes.body.payment.id;

    const employerRead = await employerApi.get(`/payments/contract/${contractId}`);
    const employeeRead = await employeeApi.get(`/payments/contract/${contractId}`);
    assert.equal(employerRead.status, 200);
    assert.equal(employeeRead.status, 200);
    assert.equal(employerRead.body.payment.status, 'created');
    assert.equal(employeeRead.body.payment.status, 'created');

    client.paystack.respondWith(initializeResponse);
    const initialized = await employerApi.post('/payments/contract/initialize', {
        body: { contractId },
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.body.reference, `kp_${paymentId}`);
    assert.equal(initialized.body.chargeMinor, calculateCheckoutChargeMinor(1500000));

    client.paystack.respondWithVerify((reference) =>
        verifyResponse(reference, calculateCheckoutChargeMinor(1500000))
    );
    const verified = await employerApi.post('/payments/contract/verify', {
        body: { contractId },
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.body.verified, true);
    assert.equal(verified.body.payment.status, 'paid');

    const employerHistory = await employerApi.get('/payments/history?type=full_contract');
    const employeeHistory = await employeeApi.get('/payments/history?type=full_contract');
    assert.equal(employerHistory.status, 200);
    assert.equal(employeeHistory.status, 200);
    assert.deepEqual(employerHistory.body.payments.map((payment) => payment.id), [paymentId]);
    assert.deepEqual(employeeHistory.body.payments.map((payment) => payment.id), [paymentId]);
    assert.equal(employerHistory.body.payments[0].status, 'paid');
    assert.equal(employeeHistory.body.payments[0].status, 'paid');
    assert.equal(employerHistory.body.payments[0].type, 'full_contract');
    assert.equal(employerHistory.body.summary.paid.amountMinor, 1500000);
    assert.equal(client.readDoc('payments', paymentId).status, 'paid');
});

test('acceptance: a declined Test Mode payment is recorded as failed and cannot later become paid', async () => {
    seedHiredWorld();
    client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
    client.seed('tasks', 'task-2', task({ employmentId: 'emp-1', status: 'approved' }));
    const [milestoneId] = await createMilestoneContract();

    await createMilestonePayment(milestoneId, 'acceptance-declined-key');
    await initializeMilestonePayment(milestoneId);

    const failed = await verifyMilestonePayment(
        milestoneId,
        500000,
        {
            amount: calculateCheckoutChargeMinor(500000),
            status: 'failed',
        }
    );
    assert.equal(failed.verified, true);
    assert.equal(failed.payment.status, 'failed');
    assert.equal(client.readDoc('payments', milestoneId).status, 'failed');

    const callsAfterFailure = client.paystack.calls.length;
    const retried = await verifyMilestonePayment(
        milestoneId,
        500000,
        { amount: calculateCheckoutChargeMinor(500000) }
    );
    assert.equal(retried.verified, false);
    assert.equal(retried.payment.status, 'needs_review');
    assert.equal(client.paystack.calls.length, callsAfterFailure + 1);

    const history = await employerApi.get('/payments/history?status=needs_review');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.payments.map((payment) => payment.id), [milestoneId]);
    assert.equal(history.body.payments[0].status, 'needs_review');
    assert.equal(history.body.summary.failed.count, 0);
    assert.equal(history.body.summary.needsReview.count, 1);
});

test('acceptance: a failed milestone with an existing provider transaction retries with a new reference', async () => {
    seedHiredWorld();
    client.seed('tasks', 'task-1', task({ employmentId: 'emp-1', status: 'approved' }));
    client.seed('tasks', 'task-2', task({ employmentId: 'emp-1', status: 'approved' }));
    const [milestoneId] = await createMilestoneContract();

    const created = await createMilestonePayment(milestoneId, 'acceptance-retry-key');
    const originalReference = `kp_${milestoneId}`;
    await initializeMilestonePayment(milestoneId);

    const failed = await verifyMilestonePayment(
        milestoneId,
        500000,
        {
            amount: calculateCheckoutChargeMinor(500000),
            status: 'failed',
        }
    );
    assert.equal(failed.payment.status, 'failed');
    assert.equal(client.readDoc('payments', milestoneId).verifyAttempts, 1);

    const initializeCallsBefore = client.paystack.calls.filter(
        (call) => call.op === 'initializeTransaction'
    ).length;
    client.paystack.respondWith(initializeResponse);
    const retried = await employerApi.post('/payments/initialize', {
        body: { milestoneId },
    });

    assert.equal(retried.status, 200);
    assert.equal(retried.body.reference, `kp_${milestoneId}_a2`);
    assert.equal(
        client.paystack.calls.filter((call) => call.op === 'initializeTransaction').length,
        initializeCallsBefore + 1,
        'the retry uses a new reference'
    );

    const stored = client.readDoc('payments', milestoneId);
    assert.equal(created.id, milestoneId, 'still the same single payment record');
    assert.equal(stored.milestoneId, milestoneId);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.providerReference, `kp_${milestoneId}_a2`);
    assert.equal(stored.verifyAttempts, 2, 'the retry consumes a new attempt');
    assert.equal(
        client.readDoc('paymentAttempts', `${milestoneId}__attempt_1`).reference,
        originalReference
    );
    assert.equal(
        client.readDoc('paymentAttempts', `${milestoneId}__attempt_2`).reference,
        `kp_${milestoneId}_a2`
    );

    const history = await employerApi.get('/payments/history?status=paid');
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.payments, []);
});
