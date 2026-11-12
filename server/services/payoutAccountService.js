'use strict';

const clock = require('../config/clock');
const payoutAccountRepository = require('../repositories/payoutAccountRepository');
const transferService = require('./paystackTransferService');

class PayoutAccountValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PayoutAccountValidationError';
        this.code = 'PAYOUT_ACCOUNT_INVALID';
    }
}

class PayoutAccountNotFoundError extends Error {
    constructor(message = 'Payout account not found') {
        super(message);
        this.name = 'PayoutAccountNotFoundError';
        this.code = 'PAYOUT_ACCOUNT_NOT_FOUND';
    }
}

class PayoutAccountProviderError extends Error {
    constructor(
        message = 'Paystack account verification failed',
        { statusCode, operation, providerMessage, providerErrorType } = {}
    ) {
        super(message);
        this.name = 'PayoutAccountProviderError';
        this.code = 'PAYOUT_ACCOUNT_PROVIDER_ERROR';
        if (Number.isSafeInteger(statusCode)) this.statusCode = statusCode;
        if (operation) this.operation = operation;
        if (providerMessage) this.providerMessage = providerMessage;
        if (providerErrorType) this.providerErrorType = providerErrorType;
    }
}

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

const getTransferProvider = (options = {}) => options.provider || transferService;

const normalizePayoutAccount = (input = {}) => {
    const bankAccountNumber = normalizeText(input.bankAccountNumber);
    const bankCode = normalizeText(input.bankCode);

    if (!/^\d{10}$/.test(bankAccountNumber)) {
        throw new PayoutAccountValidationError('bankAccountNumber must be a 10-digit account number');
    }
    if (!/^\d{1,10}$/.test(bankCode)) {
        throw new PayoutAccountValidationError('bankCode must be a valid Paystack bank code');
    }

    return { bankAccountNumber, bankCode };
};

const toProviderError = (error) => {
    if (error instanceof PayoutAccountProviderError) return error;

    return new PayoutAccountProviderError('Paystack account verification failed', {
        ...(error && Number.isSafeInteger(error.statusCode)
            ? { statusCode: error.statusCode }
            : {}),
        ...(error && typeof error.operation === 'string'
            ? { operation: error.operation }
            : {}),
        ...(error && typeof error.providerMessage === 'string'
            ? { providerMessage: error.providerMessage }
            : {}),
        ...(error && typeof error.providerErrorType === 'string'
            ? { providerErrorType: error.providerErrorType }
            : {}),
    });
};

const toSummary = (account) => {
    if (!account) return { configured: false };
    return {
        configured: true,
        bankCode: account.bankCode,
        bankName: account.bankName || null,
        accountName: account.accountName,
        accountNumberLast4: String(account.bankAccountNumber).slice(-4),
        updatedAt: account.updatedAt || null,
    };
};

const getPayoutAccountSummary = async (uid) => {
    const snapshot = await payoutAccountRepository.getPayoutAccount(uid);
    return toSummary(snapshot.exists ? snapshot.data() : null);
};

const getSupportedBanks = async (options = {}) => {
    try {
        return await getTransferProvider(options).listBanks({
            client: options.client,
        });
    } catch (error) {
        throw toProviderError(error);
    }
};

const resolvePayoutAccount = async (input = {}, options = {}) => {
    const { bankAccountNumber, bankCode } = normalizePayoutAccount(input);

    const banks = await getSupportedBanks(options);
    const bank = banks.find((candidate) => candidate.code === bankCode);
    if (!bank) {
        throw new PayoutAccountValidationError('bankCode is not a supported Paystack bank');
    }

    let resolved;
    try {
        resolved = await getTransferProvider(options).resolveBankAccount(
            bankAccountNumber,
            bankCode,
            { client: options.client }
        );
    } catch (error) {
        if (error && (error.statusCode === 400 || error.statusCode === 422)) {
            throw new PayoutAccountValidationError(
                normalizeText(error.providerMessage)
                || 'Could not verify that bank account with Paystack'
            );
        }
        throw toProviderError(error);
    }

    const accountName = normalizeText(resolved && resolved.accountName);
    if (!accountName || accountName.length > 100) {
        throw new PayoutAccountProviderError('Paystack returned an unusable account name');
    }

    return {
        bankAccountNumber,
        bankCode,
        bankName: bank.name,
        accountName,
    };
};

const getFullPayoutAccount = async (uid) => {
    const snapshot = await payoutAccountRepository.getPayoutAccount(uid);
    if (!snapshot.exists) return null;
    const account = snapshot.data();
    if (
        !account
        || !/^\d{10}$/.test(String(account.bankAccountNumber || ''))
        || !/^\d{1,10}$/.test(String(account.bankCode || ''))
        || !normalizeText(account.accountName)
    ) {
        return null;
    }
    return {
        bankAccountNumber: String(account.bankAccountNumber),
        bankCode: String(account.bankCode),
        bankName: normalizeText(account.bankName) || null,
        accountName: normalizeText(account.accountName),
    };
};

const savePayoutAccount = async (uid, input, options = {}) => {
    const account = await resolvePayoutAccount(input, options);
    const updatedAt = clock.now();
    await payoutAccountRepository.savePayoutAccount(uid, {
        uid,
        ...account,
        updatedAt,
    });
    return getPayoutAccountSummary(uid);
};

module.exports = {
    PayoutAccountValidationError,
    PayoutAccountNotFoundError,
    PayoutAccountProviderError,
    normalizePayoutAccount,
    getPayoutAccountSummary,
    getSupportedBanks,
    resolvePayoutAccount,
    getFullPayoutAccount,
    savePayoutAccount,
};
