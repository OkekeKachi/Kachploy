'use strict';

const { normalizeProviderOutcome } = require('./releaseProvider');
const { getSecretKey, getPaystackMode } = require('../config/paystack');
const { releaseTransferReference } = require('../config/release');
const transferService = require('./paystackTransferService');

const hasBankDetails = (input) => {
    const { bankAccountNumber, bankCode, accountName } = input || {};
    return (
        typeof bankAccountNumber === 'string' && bankAccountNumber.trim() !== ''
        && typeof bankCode === 'string' && bankCode.trim() !== ''
        && typeof accountName === 'string' && accountName.trim() !== ''
    );
};

const unknown = (failureReason, extra = {}) =>
    normalizeProviderOutcome({ outcome: 'unknown', failureReason, ...extra })
    || { outcome: 'unknown' };

const providerErrorFrom = (error, fallbackOperation) => {
    if (!error || typeof error !== 'object') return undefined;

    return {
        ...(Number.isSafeInteger(error.statusCode)
            ? { statusCode: error.statusCode }
            : {}),
        ...(typeof error.providerMessage === 'string'
            ? { message: error.providerMessage }
            : {}),
        ...(typeof error.providerErrorType === 'string'
            ? { type: error.providerErrorType }
            : {}),
        ...(typeof error.operation === 'string'
            ? { operation: error.operation }
            : fallbackOperation
                ? { operation: fallbackOperation }
                : {}),
    };
};

const codedFailure = (error, fallbackOperation) => {
    const providerError = providerErrorFrom(error, fallbackOperation);
    return unknown(
        error && error.code ? error.code : 'PAYSTACK_PROVIDER_ERROR',
        providerError ? { providerError } : {}
    );
};

const createPaystackProvider = (options = {}) => {
    const client = options.client;

    const submitRelease = async (input = {}) => {
        let operation = 'createRecipient';

        try {
            transferService.assertTransferSecretKey();

            if (!hasBankDetails(input)) {
                return unknown('missing_bank_details');
            }

            if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
                return unknown('invalid_transfer_amount');
            }

            const transferReference =
                input.transferReference
                || releaseTransferReference(input.releaseId, input.attemptNumber);

            const recipientCode = await transferService.createRecipient(
                input.bankAccountNumber,
                input.bankCode,
                input.accountName,
                { client, providerEnvironment: input.providerEnvironment }
            );

            operation = 'initiateTransfer';

            const transfer = await transferService.initiateTransfer(
                input.releaseId,
                input.attemptNumber,
                recipientCode,
                input.amountMinor,
                { client, reference: transferReference, providerEnvironment: input.providerEnvironment }
            );

            const mapped = transferService.mapPaystackTransferStatus(transfer.status);
            if (!mapped) {
                return normalizeProviderOutcome({
                    outcome: 'unknown',
                    providerReference: transfer.transferCode,
                    failureReason: 'paystack_transfer_pending',
                }) || { outcome: 'unknown' };
            }

            return normalizeProviderOutcome({
                outcome: mapped.outcome,
                providerReference: transfer.transferCode,
                ...(mapped.failureReason ? { failureReason: mapped.failureReason } : {}),
            }) || unknown('paystack_outcome_not_interpretable');
        } catch (error) {
            return codedFailure(error, operation);
        }
    };

    const lookupReleaseOutcome = async (input = {}) => {
        const reference =
            input.transferReference
            || releaseTransferReference(input.releaseId, input.attemptNumber);

        try {
            const result = await transferService.getTransferOutcome(
                reference,
                { client, providerEnvironment: input.providerEnvironment || 'test' }
            );
            const outcome = result.outcome || 'unknown';

            return {
                outcome,
                releaseId: input.releaseId,
                attemptId: input.attemptId,
                attemptNumber: input.attemptNumber,
                currency: result.currency || input.currency,
                amountMinor: Number.isSafeInteger(result.amountMinor)
                    ? result.amountMinor
                    : input.amountMinor,
                ...(result.providerReference
                    ? { providerReference: result.providerReference }
                    : {}),
                ...(result.failureReason ? { failureReason: result.failureReason } : {}),
            };
        } catch (error) {
            const providerError = providerErrorFrom(error, 'getTransfer');
            return {
                outcome: 'unknown',
                releaseId: input.releaseId,
                attemptId: input.attemptId,
                attemptNumber: input.attemptNumber,
                currency: input.currency,
                amountMinor: input.amountMinor,
                failureReason:
                    error && error.code
                        ? error.code
                        : 'paystack_transfer_lookup_failed',
                ...(providerError ? { providerError } : {}),
            };
        }
    };

    return {
        providerId: `paystack-${getPaystackMode()}`,
        submitRelease,
        lookupReleaseOutcome,
    };
};

module.exports = {
    createPaystackProvider,
};
