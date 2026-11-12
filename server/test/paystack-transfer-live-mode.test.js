'use strict';

/**
 * Focused Live Mode tests for the Paystack transfer adapter.
 * All HTTP calls are mocked; no real network is made.
 * Tests verify mode-aware key validation, provider environment enforcement,
 * and live payouts gating.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { PaystackConfigurationError } = require('../config/paystack');
const paystackTransferService = require('../services/paystackTransferService');

const RELEASE_ID = 'rel_ms-1';
const ATTEMPT_NUMBER = 1;

process.env.PAYSTACK_SECRET_KEY = 'sk_test_abcdefghijklmnop';


test.after(async () => {
    // nothing
});

let savedEnv = {};

test.beforeEach(() => {
    savedEnv = {
        secretKey: process.env.PAYSTACK_SECRET_KEY,
        mode: process.env.PAYSTACK_MODE,
        livePayouts: process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED,
    };
});

test.afterEach(() => {
    if (savedEnv.secretKey !== undefined) process.env.PAYSTACK_SECRET_KEY = savedEnv.secretKey; else delete process.env.PAYSTACK_SECRET_KEY;
    if (savedEnv.mode !== undefined) process.env.PAYSTACK_MODE = savedEnv.mode; else delete process.env.PAYSTACK_MODE;
    if (savedEnv.livePayouts !== undefined) process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = savedEnv.livePayouts; else delete process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED;
});

/**
 * Helper: a minimal stub client that returns predetermined data without
 * touching the network.  It mimics the interface of createPaystackTransferClient.
 * Also tracks provider-call counts so tests can verify calls were or were not made.
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

    const calls = {
        initiateTransfer: 0,
        createRecipient: 0,
        getTransfer: 0,
    };

    const client = {
        createRecipient: async (payload) => {
            if (payload.account_number !== '0000000001' || payload.type !== 'nuban') {
                throw new Error('unexpected payload');
            }
            calls.createRecipient++;
            return { data: defaults.createRecipientResponse.data };
        },
        initiateTransfer: async (payload) => {
            calls.initiateTransfer++;
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
            calls.getTransfer++;
            return { data: defaults.getTransferResponse.data };
        },
        listBanks: async (options = {}) => {
            calls.listBanks++;
            const currency = typeof options.currency === 'string' && options.currency.trim()
                ? options.currency.trim().toUpperCase()
                : 'NGN';
            return {
                data: [
                    { code: '057', name: 'Access Bank', slug: 'accessbank', type: 'bank', currency: 'USD' },
                    { code: '033', name: 'GTBank', slug: 'gtbank', type: 'bank', currency: 'USD' },
                ],
            };
        },
        resolveAccount: async (accountNumber, bankCode) => {
            calls.resolveAccount++;
            return {
                data: { account_name: 'Test Beneficiary' },
            };
        },
    };
    return { client, calls };
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Key validation in Test Mode
// ---------------------------------------------------------------------------

test('Test Mode initiateTransfer with a test key succeeds', async () => {
    const { client, calls } = stubClient();
    const result = await paystackTransferService.initiateTransfer(
        RELEASE_ID,
        ATTEMPT_NUMBER,
        'RCP_test_1',
        50000,
        { client }
    );
    assert.strictEqual(result.transferCode, 'TRX_test-67890');
    assert.strictEqual(calls.initiateTransfer, 1);
});

test('Test Mode initiateTransfer with a live key throws PaystackConfigurationError', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    try {
        const { client } = stubClient();
        await assert.rejects(
            () => paystackTransferService.initiateTransfer(
                RELEASE_ID,
                ATTEMPT_NUMBER,
                'RCP_live_1',
                50000,
                { client }
            ),
            (error) => {
                assert.strictEqual(error.name, 'PaystackConfigurationError');
                assert.strictEqual(error.code, 'PAYSTACK_NOT_CONFIGURED');
                return true;
            }
        );
    } finally {
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

// ---------------------------------------------------------------------------
// Key validation in Live Mode
// ---------------------------------------------------------------------------

test('Live Mode initiateTransfer with a test key throws PaystackConfigurationError before any provider call', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origMode = process.env.PAYSTACK_MODE;
    const origLivePayouts = process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED;
    process.env.PAYSTACK_MODE = 'live';
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_abcdefghijklmnop';
    process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = 'false';
    try {
        const { client, calls } = stubClient();
        await assert.rejects(
            () => paystackTransferService.initiateTransfer(
                RELEASE_ID,
                ATTEMPT_NUMBER,
                'RCP_test_1',
                50000,
                { client, providerEnvironment: 'test' }
            ),
            (error) => {
                assert.strictEqual(error.name, 'PaystackConfigurationError');
                assert.strictEqual(error.code, 'PAYSTACK_NOT_CONFIGURED');
                return true;
            }
        );
        assert.strictEqual(calls.initiateTransfer, 0);
    } finally {
        process.env.PAYSTACK_MODE = origMode;
        process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = origLivePayouts;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('Live Mode initiateTransfer with a live key and live flag false throws RELEASE_LIVE_PAYOUTS_DISABLED before any provider call', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origFlag = process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED;
    const origMode = process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = 'false';
    process.env.PAYSTACK_MODE = 'live';
    try {
        const { client, calls } = stubClient();
        await assert.rejects(
            () => paystackTransferService.initiateTransfer(
                RELEASE_ID,
                ATTEMPT_NUMBER,
                'RCP_live_1',
                50000,
                { client, providerEnvironment: 'live' }
            ),
            (error) => {
                assert.strictEqual(error.code, 'RELEASE_LIVE_PAYOUTS_DISABLED');
                return true;
            }
        );
        assert.strictEqual(calls.initiateTransfer, 0);
    } finally {
        process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = origFlag;
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('Live Mode initiateTransfer with a live key, live flag true and providerEnvironment live succeeds and calls the client', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origFlag = process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED;
    const origMode = process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = 'true';
    process.env.PAYSTACK_MODE = 'live';
    try {
        const { client, calls } = stubClient();
        const result = await paystackTransferService.initiateTransfer(
            RELEASE_ID,
            ATTEMPT_NUMBER,
            'RCP_live_1',
            50000,
            { client, providerEnvironment: 'live' }
        );
        assert.strictEqual(result.transferCode, 'TRX_test-67890');
        assert.strictEqual(calls.initiateTransfer, 1);
    } finally {
        process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = origFlag;
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('Live Mode initiateTransfer without providerEnvironment fails closed', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origMode = process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_MODE = 'live';
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    try {
        const { client, calls } = stubClient();
        await assert.rejects(
            () => paystackTransferService.initiateTransfer(
                RELEASE_ID,
                ATTEMPT_NUMBER,
                'RCP_live_1',
                50000,
                { client }
            ),
            (error) => {
                assert.strictEqual(error.code, 'RELEASE_INCONSISTENT_RECORD');
                return true;
            }
        );
    } finally {
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

// ---------------------------------------------------------------------------
// Provider environment cross‑mode rejection
// ---------------------------------------------------------------------------

test('Live Mode initiateTransfer rejects a test-mode provider environment', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origMode = process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_MODE = 'live';
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    try {
        const { client, calls } = stubClient();
        await assert.rejects(
            () => paystackTransferService.initiateTransfer(
                RELEASE_ID,
                ATTEMPT_NUMBER,
                'RCP_test_1',
                50000,
                { client, providerEnvironment: 'test' }
            ),
            (error) => {
                assert.strictEqual(error.code, 'RELEASE_INCONSISTENT_RECORD');
                return true;
            }
        );
    } finally {
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('Test Mode initiateTransfer rejects a live-mode provider environment', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origMode = process.env.PAYSTACK_MODE;
    const origLivePayouts = process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED;
    delete process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_abcdefghijklmnop';
    process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = 'false';
    try {
        const { client, calls } = stubClient();
        await assert.rejects(
            () => paystackTransferService.initiateTransfer(
                RELEASE_ID,
                ATTEMPT_NUMBER,
                'RCP_live_1',
                50000,
                { client, providerEnvironment: 'live' }
            ),
            (error) => {
                assert.strictEqual(error.code, 'RELEASE_INCONSISTENT_RECORD');
                return true;
            }
        );
    } finally {
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
        process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = origLivePayouts;
    }
});

// ---------------------------------------------------------------------------
// getTransferOutcome environment checks
// ---------------------------------------------------------------------------

test('Live Mode getTransferOutcome with providerEnvironment live succeeds', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origMode = process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_MODE = 'live';
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    try {
        const { client } = stubClient();
        const outcome = await paystackTransferService.getTransferOutcome('ref_1', {
            client,
            providerEnvironment: 'live',
        });
        assert.strictEqual(outcome.outcome, 'succeeded');
    } finally {
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('Test Mode getTransferOutcome without providerEnvironment succeeds', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origMode = process.env.PAYSTACK_MODE;
    delete process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_abcdefghijklmnop';
    try {
        const { client } = stubClient();
        const outcome = await paystackTransferService.getTransferOutcome('ref_1', {
            client,
        });
        assert.strictEqual(outcome.outcome, 'succeeded');
    } finally {
        process.env.PAYSTACK_MODE = origMode || 'test';
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

// ---------------------------------------------------------------------------
// createRecipient environment checks
// ---------------------------------------------------------------------------

test('Test Mode createRecipient with providerEnvironment test succeeds', async () => {
    const { client } = stubClient();
    const code = await paystackTransferService.createRecipient(
        '0000000001',
        '057',
        'Test Beneficiary',
        { client, providerEnvironment: 'test' }
    );
    assert.strictEqual(code, 'RCP_test-12345');
});

test('Live Mode createRecipient with providerEnvironment live and live flag false throws before provider call', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origFlag = process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED;
    const origMode = process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = 'false';
    process.env.PAYSTACK_MODE = 'live';
    try {
        const { client } = stubClient();
        await assert.rejects(
            () => paystackTransferService.createRecipient(
                '0000000001',
                '057',
                'Test Beneficiary',
                { client, providerEnvironment: 'live' }
            ),
            (error) => {
                assert.strictEqual(error.code, 'RELEASE_LIVE_PAYOUTS_DISABLED');
                return true;
            }
        );
    } finally {
        process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = origFlag;
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

test('Live Mode createRecipient with providerEnvironment live and live flag true succeeds', async () => {
    const orig = process.env.PAYSTACK_SECRET_KEY;
    const origFlag = process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED;
    const origMode = process.env.PAYSTACK_MODE;
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_FakeKey';
    process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = 'true';
    process.env.PAYSTACK_MODE = 'live';
    try {
        const { client } = stubClient();
        const code = await paystackTransferService.createRecipient(
            '0000000001',
            '057',
            'Test Beneficiary',
            { client, providerEnvironment: 'live' }
        );
        assert.strictEqual(code, 'RCP_test-12345');
    } finally {
        process.env.PAYSTACK_LIVE_PAYOUTS_ENABLED = origFlag;
        process.env.PAYSTACK_MODE = origMode;
        if (orig !== undefined) process.env.PAYSTACK_SECRET_KEY = orig;
    }
});

// ---------------------------------------------------------------------------
// listBanks / resolveBankAccount only need key validation
// ---------------------------------------------------------------------------

test('listBanks succeeds with a test key', async () => {
    const { client } = stubClient();
    const banks = await paystackTransferService.listBanks({ client });
    assert.ok(Array.isArray(banks));
});

test('resolveBankAccount succeeds with a test key', async () => {
    const { client } = stubClient();
    const account = await paystackTransferService.resolveBankAccount('0000000001', '057', { client });
    assert.strictEqual(account.accountName, 'Test Beneficiary');
});

// ---------------------------------------------------------------------------
// ensureTestModeKey alias compatibility
// ---------------------------------------------------------------------------

test('ensureTestModeKey alias exists and delegates to assertTransferSecretKey', async () => {
    const service = require('../services/paystackTransferService');
    assert.strictEqual(typeof service.ensureTestModeKey, 'function');
    assert.strictEqual(service.ensureTestModeKey, service.assertTransferSecretKey);
});