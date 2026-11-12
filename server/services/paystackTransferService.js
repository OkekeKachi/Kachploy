'use strict';

const { createPaystackTransferClient } = require('./paystackTransferClient');
const { normalizeProviderOutcome } = require('./releaseProvider');
const {
    getSecretKey,
    getPaystackMode,
    isLivePayoutsEnabled,
} = require('../config/paystack');
const {
    parseReleaseTransferReference,
    releaseTransferReference,
} = require('../config/release');
const releaseRepository = require('../repositories/releaseRepository');
const releaseReconciliationService = require('./releaseReconciliationService');

const TRANSFER_EVENT_PREFIX = 'transfer';

class PaystackTransferSafetyError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'PaystackTransferSafetyError';
        this.code = code;
    }
}

const normalizeProviderEnvironment = (value) => {
    if (value === undefined || value === null) return undefined;

    if (typeof value !== 'string') {
        throw new PaystackTransferSafetyError(
            'providerEnvironment must be a string',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    const trimmed = value.trim().toLowerCase();
    if (trimmed === '') return undefined;

    if (trimmed !== 'test' && trimmed !== 'live') {
        throw new PaystackTransferSafetyError(
            'providerEnvironment must be test or live',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    return trimmed;
};

const assertTransferEnvironment = (
    providerEnvironment,
    { requirePayoutsEnabled = true } = {}
) => {
    const expected = normalizeProviderEnvironment(providerEnvironment);
    const current = getPaystackMode();

    if (expected && expected !== current) {
        throw new PaystackTransferSafetyError(
            'this transfer belongs to a different Paystack environment',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    if (!expected && current === 'live') {
        throw new PaystackTransferSafetyError(
            'live transfers require a verified Paystack environment',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    if (requirePayoutsEnabled && current === 'live' && !isLivePayoutsEnabled()) {
        throw new PaystackTransferSafetyError(
            'live payouts are disabled on this server',
            'RELEASE_LIVE_PAYOUTS_DISABLED'
        );
    }

    return current;
};

const defaultInitiatePayload = (reference, amountKobo, recipient) => ({
    amount: amountKobo,
    currency: 'NGN',
    recipient,
    reference,
    source: 'balance',
});

const mapPaystackTransferStatus = (status) => {
    const value = String(status || '').toLowerCase();
    if (value === 'success' || value === 'succeeded') {
        return { outcome: 'succeeded' };
    }
    if (value === 'failed') {
        return { outcome: 'failed', failureReason: 'paystack_transfer_failed' };
    }
    if (value === 'reversed') {
        return { outcome: 'failed', failureReason: 'paystack_transfer_reversed' };
    }
    return null;
};

const assertTransferSecretKey = () => getSecretKey();

const createRecipient = async (
    bankAccountNumber,
    bankCode,
    accountName,
    options = {}
) => {
    assertTransferSecretKey();
    assertTransferEnvironment(options.providerEnvironment);
    const client = options.client || createPaystackTransferClient();
    const response = await client.createRecipient({
        type: 'nuban',
        name: accountName,
        account_number: bankAccountNumber,
        bank_code: bankCode,
        currency: 'NGN',
    });
    if (!response.data || !response.data.recipient_code) {
        throw new Error('Paystack recipient creation did not return a recipient_code');
    }
    return response.data.recipient_code;
};

const initiateTransfer = async (
    releaseId,
    attemptNumber,
    recipientCode,
    amountMinor,
    options = {}
) => {
    assertTransferSecretKey();
    assertTransferEnvironment(options.providerEnvironment);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        throw new TypeError('amountMinor must be a positive safe integer');
    }
    const client = options.client || createPaystackTransferClient();
    const reference = options.reference || releaseTransferReference(releaseId, attemptNumber);
    const payload = defaultInitiatePayload(reference, amountMinor, recipientCode);
    const response = await client.initiateTransfer(payload);
    if (!response.data || !response.data.transfer_code) {
        throw new Error('Paystack transfer initiation did not return a transfer_code');
    }
    return {
        transferCode: response.data.transfer_code,
        reference,
        status: response.data.status,
    };
};

const getTransferOutcome = async (reference, options = {}) => {
    assertTransferSecretKey();
    assertTransferEnvironment(options.providerEnvironment, {
        requirePayoutsEnabled: false,
    });
    const client = options.client || createPaystackTransferClient();
    const response = await client.getTransfer(reference);
    const data = response && response.data;
    if (!data) {
        return { outcome: null, reference };
    }

    const mapped = mapPaystackTransferStatus(data.status);
    const providerReference =
        typeof data.transfer_code === 'string' && data.transfer_code.trim()
            ? data.transfer_code.trim()
            : undefined;

    return {
        outcome: mapped ? mapped.outcome : null,
        status: data.status,
        reference: data.reference || reference,
        ...(providerReference ? { providerReference } : {}),
        ...(mapped && mapped.failureReason ? { failureReason: mapped.failureReason } : {}),
        ...(Number.isSafeInteger(data.amount) ? { amountMinor: data.amount } : {}),
        ...(typeof data.currency === 'string' ? { currency: data.currency } : {}),
    };
};

const normalizeBank = (bank) => {
    if (!bank || typeof bank !== 'object' || Array.isArray(bank)) return null;
    const code = typeof bank.code === 'string' ? bank.code.trim() : '';
    const name = typeof bank.name === 'string' ? bank.name.trim() : '';
    if (!/^\d{1,10}$/.test(code) || !name) return null;

    return {
        name,
        code,
        ...(typeof bank.slug === 'string' && bank.slug.trim()
            ? { slug: bank.slug.trim() }
            : {}),
        ...(typeof bank.type === 'string' && bank.type.trim()
            ? { type: bank.type.trim() }
            : {}),
        ...(typeof bank.currency === 'string' && bank.currency.trim()
            ? { currency: bank.currency.trim().toUpperCase() }
            : {}),
    };
};

const listBanks = async (options = {}) => {
    assertTransferSecretKey();
    const client = options.client || createPaystackTransferClient();
    const response = await client.listBanks({ currency: 'NGN' });
    const data = response && response.data;
    if (!Array.isArray(data)) {
        throw new Error('Paystack bank list did not return an array');
    }

    return data
        .map(normalizeBank)
        .filter(Boolean)
        .sort((left, right) => left.name.localeCompare(right.name));
};

const resolveBankAccount = async (bankAccountNumber, bankCode, options = {}) => {
    assertTransferSecretKey();
    if (!/^\d{10}$/.test(String(bankAccountNumber || ''))) {
        throw new TypeError('bankAccountNumber must be a 10-digit account number');
    }
    if (!/^\d{1,10}$/.test(String(bankCode || ''))) {
        throw new TypeError('bankCode must be a numeric Paystack bank code');
    }

    const client = options.client || createPaystackTransferClient();
    const response = await client.resolveAccount(bankAccountNumber, bankCode);
    const resolvedName =
        response
        && response.data
        && typeof response.data.account_name === 'string'
            ? response.data.account_name.trim()
            : '';
    if (!resolvedName) {
        throw new Error('Paystack account resolution did not return an account name');
    }
    if (resolvedName.length > 100) {
        throw new Error('Paystack account resolution returned an unusable account name');
    }

    return { accountName: resolvedName };
};

const normaliseProviderOutcome = (raw) => normalizeProviderOutcome(raw) || { outcome: 'unknown' };

const isTransferEvent = (kind) =>
    kind === TRANSFER_EVENT_PREFIX
    || (typeof kind === 'string' && kind.startsWith(`${TRANSFER_EVENT_PREFIX}.`));

const handlePaystackTransferWebhook = async (event, options = {}) => {
    if (!event || typeof event !== 'object') {
        throw new Error('invalid webhook payload');
    }

    const { event: kind, data } = event;
    if (!isTransferEvent(kind) || !data) {
        throw new Error('not a transfer event');
    }

    const { reference, status } = data;
    if (!reference) {
        throw new Error('transfer webhook missing reference');
    }

    const mapped = mapPaystackTransferStatus(status);
    const outcome = mapped ? mapped.outcome : 'unknown';
    const parsed = parseReleaseTransferReference(reference);

    if (!parsed) {
        return { outcome, reference, handled: false, reason: 'not_release_transfer' };
    }

    const releaseSnapshot = await releaseRepository.getReleaseById(parsed.releaseId);
    if (!releaseSnapshot.exists) {
        return { outcome, reference, handled: false, reason: 'release_not_found' };
    }

    const provider = options.provider
        || require('./paystackProvider').createPaystackProvider();
    const reconciliation = await releaseReconciliationService.reconcileRelease(
        parsed.releaseId,
        { provider }
    );

    return {
        outcome,
        reference,
        releaseId: parsed.releaseId,
        handled: true,
        reconciled: true,
        reconciliation,
    };
};

module.exports = {
    defaultInitiatePayload,
    mapPaystackTransferStatus,
    PaystackTransferSafetyError,
    assertTransferSecretKey,
    assertTransferEnvironment,
    ensureTestModeKey: assertTransferSecretKey,
    createRecipient,
    initiateTransfer,
    getTransferOutcome,
    listBanks,
    resolveBankAccount,
    normaliseProviderOutcome,
    handlePaystackTransferWebhook,
};
