'use strict';

/**
 * Stage 2I focused tests for the Paystack test‑mode transfer adapter.
 * All HTTP calls are mocked; no real network is made.
 * Tests exercise key validation, recipient creation, transfer initiation,
 * status mapping, normalisation and webhook handling.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const paystackTransferService = require('../services/paystackTransferService');
const {
    createPaystackTransferClient,
    PaystackHttpError,
} = require('../services/paystackTransferClient');
const { createPaystackProvider } = require('../services/paystackProvider');
const { PaystackConfigurationError } = require('../config/paystack');

const RELEASE_ID = 'rel_ms-1';
const ATTEMPT_NUMBER = 1;

process.env.PAYSTACK_SECRET_KEY = 'sk_test_abcdefghijklmnop';





test.after(async () => {
    // nothing
});

test.beforeEach(() => {
    // reset any per‑test state
});

/**
 * Helper: a minimal stub client that returns predetermined data without
 * touching the network.  It mimics the interface of createPaystackTransferClient.
 */
function stubClient(overrides = {}) {
    const defaults = {
        createRecipientResponse: { data: { recipient_code: 'RCP_test-12345' } },
        initiateTransferResponse: {
            data: {
                transfer_code: 'TRX_test-67890',
                status: 'pending',
            },
        },
        getTransferResponse: {
            data: { status: 'success' },
        },
        ...overrides,
    };

    const client = {
        createRecipient: async (payload) => {
            if (payload.account_number !== '0000000001' || payload.type !== 'nuban') {
                throw new Error('unexpected payload');
            }
            return { data: defaults.createRecipientResponse.data };
        },
        initiateTransfer: async (payload) => {
            if (
                payload.amount !== 50000
                || payload.reference !== 'rel_ms-1_attempt_1'
                || payload.source !== 'balance'
            ) {
                throw new Error('unexpected transfer payload');
            }
            return { data: defaults.initiateTransferResponse.data };
        },
        getTransfer: async (reference) => {
            // reference is ignored; return predetermined status
            return { data: defaults.getTransferResponse.data };
        },
    };
    return client;
}

test('ensureTestModeKey throws PaystackConfigurationError when key absent', async () => {
    // Temporarily remove the environment variable so getSecretKey throws.
    const orig = process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SECRET_KEY;
    try {
        // Calling ensureTestModeKey (internal to service) will throw.
        // We test the config module directly.
        const { validatePaystackSecretKey } = require('../config/paystack');
        try {
            validatePaystackSecretKey(undefined);
            assert.fail('should have thrown');
        } catch (e) {
            assert.strictEqual(e.name, 'PaystackConfigurationError');
        }
    } finally {
        // restore
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('ensureTestModeKey rejects live key prefix sk_live_', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    try {
        const { validatePaystackSecretKey } = require('../config/paystack');
        try {
            validatePaystackSecretKey(process.env.PAYSTACK_SECRET_KEY);
            assert.fail('should have thrown for live key');
        } catch (e) {
            assert.strictEqual(e.name, 'PaystackConfigurationError');
        }
    } finally {
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('createRecipient uses test key and returns recipient code', async () => {
    const client = stubClient();
    const recipientCode = await paystackTransferService.createRecipient(
        '0000000001',
        '057',
        'Test Beneficiary',
        { client }
    );
    assert.strictEqual(recipientCode, 'RCP_test-12345');
});

test('initiateTransfer returns a transfer code', async () => {
    const client = stubClient();
    const result = await paystackTransferService.initiateTransfer(
        RELEASE_ID,
        ATTEMPT_NUMBER,
        'RCP_test-12345',
        50000,
        { client }
    );
    assert.strictEqual(result.transferCode, 'TRX_test-67890');
    assert.strictEqual(result.reference, 'rel_ms-1_attempt_1');
});

test('getTransferOutcome maps success to succeeded', async () => {
    const client = stubClient();
    // Override getTransfer to return success status
    client.getTransfer = async () => {
        return { data: { status: 'success' } };
    };
    const outcome = await paystackTransferService.getTransferOutcome('ref_1', { client });
    assert.strictEqual(outcome.outcome, 'succeeded');
});

test('getTransferOutcome maps failed to failed', async () => {
    const client = stubClient();
    client.getTransfer = async () => {
        return { data: { status: 'failed' } };
    };
    const outcome = await paystackTransferService.getTransferOutcome('ref_1', { client });
    assert.strictEqual(outcome.outcome, 'failed');
    assert.strictEqual(outcome.failureReason, 'paystack_transfer_failed');
});

test('getTransferOutcome maps reversed to failed', async () => {
    const client = stubClient();
    client.getTransfer = async () => {
        return { data: { status: 'reversed' } };
    };
    const outcome = await paystackTransferService.getTransferOutcome('ref_1', { client });
    assert.strictEqual(outcome.outcome, 'failed');
    assert.strictEqual(outcome.failureReason, 'paystack_transfer_reversed');
});

test('getTransferOutcome returns null outcome for pending', async () => {
    const client = stubClient();
    client.getTransfer = async () => {
        return { data: { status: 'pending' } };
    };
    const outcome = await paystackTransferService.getTransferOutcome('ref_1', { client });
    assert.strictEqual(outcome.outcome, null);
});

test('normaliseProviderOutcome routes through releaseProvider path', async () => {
    const result = paystackTransferService.normaliseProviderOutcome({
        outcome: 'succeeded',
        providerReference: 'ref_123',
    });
    assert.strictEqual(result.outcome, 'succeeded');
    assert.strictEqual(result.providerReference, 'ref_123');
});

test('handlePaystackTransferWebhook with success event', async () => {
    // Build a minimal transfer success event body (as Paystack would send).
    const successEvent = {
        event: 'transfer',
        data: {
            id: 'evt_test',
            reference: 'transfer_ref_1',
            amount: 50000,
            currency: 'NGN',
            status: 'success',
        },
    };
    const result = await paystackTransferService.handlePaystackTransferWebhook(successEvent);
    assert.strictEqual(result.outcome, 'succeeded');
});

test('handlePaystackTransferWebhook with failure event', async () => {
    const failureEvent = {
        event: 'transfer',
        data: {
            id: 'evt_test',
            reference: 'transfer_ref_1',
            amount: 50000,
            currency: 'NGN',
            status: 'failed',
        },
    };
    const result = await paystackTransferService.handlePaystackTransferWebhook(failureEvent);
    assert.strictEqual(result.outcome, 'failed');
});

test('handlePaystackTransferWebhook rejects non‑transfer event', async () => {
    const nonTransfer = {
        event: 'payment',
        data: { reference: 'xxx', amount: 100, currency: 'NGN', status: 'success' },
    };
    try {
        await paystackTransferService.handlePaystackTransferWebhook(nonTransfer);
        assert.fail('should have thrown');
    } catch (e) {
        assert.strictEqual(e.message, 'not a transfer event');
    }
});

test('full flow: createRecipient → initiateTransfer → getTransferOutcome', async () => {
    const client = stubClient();
    const recipientCode = await paystackTransferService.createRecipient(
        '0000000001',
        '057',
        'Test Beneficiary',
        { client }
    );
    assert.strictEqual(recipientCode, 'RCP_test-12345');

    const transferInfo = await paystackTransferService.initiateTransfer(
        RELEASE_ID,
        ATTEMPT_NUMBER,
        recipientCode,
        50000,
        { client }
    );
    assert.strictEqual(transferInfo.transferCode, 'TRX_test-67890');

    const outcome = await paystackTransferService.getTransferOutcome(
        transferInfo.reference,
        { client }
    );
    assert.strictEqual(outcome.outcome, 'succeeded');
});

test('provider verifies with the transfer reference, never the transfer_code', async () => {
    const client = stubClient();
    let requestedReference;

    client.getTransfer = async (reference) => {
        requestedReference = reference;
        return {
            data: {
                status: 'success',
                reference,
                currency: 'NGN',
                amount: 50000,
            },
        };
    };

    const provider = createPaystackProvider({ client });
    const result = await provider.lookupReleaseOutcome({
        releaseId: RELEASE_ID,
        attemptNumber: ATTEMPT_NUMBER,
        transferReference: 'rel_ms-1_attempt_1',
        providerReference: 'TRX_transfer_code_must_not_be_used',
    });

    assert.equal(requestedReference, 'rel_ms-1_attempt_1');
    assert.equal(result.outcome, 'succeeded');
});

test('provider preserves sanitized provider error details on recipient failure', async () => {
    const client = stubClient();
    client.createRecipient = async () => {
        throw new PaystackHttpError('Paystack recipient creation was rejected with HTTP 400', {
            statusCode: 400,
            operation: 'createRecipient',
            providerMessage: 'Account could not be resolved',
            providerErrorType: 'invalid_params',
        });
    };

    const provider = createPaystackProvider({ client });
    const result = await provider.submitRelease({
        releaseId: RELEASE_ID,
        attemptNumber: ATTEMPT_NUMBER,
        amountMinor: 50000,
        bankAccountNumber: '0123456789',
        bankCode: '057',
        accountName: 'Test Beneficiary',
    });

    assert.equal(result.outcome, 'unknown');
    assert.equal(result.failureReason, 'PAYSTACK_HTTP_ERROR');
    assert.deepEqual(result.providerError, {
        statusCode: 400,
        message: 'Account could not be resolved',
        type: 'invalid_params',
        operation: 'createRecipient',
    });
});

test('webhook handler routes transfer events correctly', async () => {
    // The test server's fake paystack is not needed; we directly invoke the
    // controller‑level handler after mocking the signature verification.
    // Here we just verify the service function routing.
    const successEvent = {
        event: 'transfer',
        data: { reference: 'transfer_ref_1', amount: 50000, currency: 'NGN', status: 'success' },
    };
    const result = await paystackTransferService.handlePaystackTransferWebhook(successEvent);
    assert.strictEqual(result.outcome, 'succeeded');
});

/**
 * Integration check: ensure that a live‑key prefix is rejected at startup.
 * This test just validates the config module; no server start required.
 */
test('config rejects live key at config load', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_12345';
    try {
        const { isPaystackConfigured } = require('../config/paystack');
        const ok = isPaystackConfigured();
        assert.strictEqual(ok, false);
    } finally {
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('config allows test key', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_abcdefghijklmnop';
    try {
        const { isPaystackConfigured } = require('../config/paystack');
        const ok = isPaystackConfigured();
        assert.strictEqual(ok, true);
    } finally {
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});