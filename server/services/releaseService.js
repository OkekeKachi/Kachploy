'use strict';

// releaseService.js
//
// STAGE 2A. Domain construction of a release request from authoritative stored
// funding records. There is NO route in this stage, no provider adapter and no
// execution. This service reads a paid payment record (the funding authority),
// validates the contract / employment / milestone chain, and creates a
// deterministic request plus its audit event.
//
// The client (when a later stage exposes a route) may name only the target type
// and target id. Amount, currency, employer, employee, contract and employment
// ids are always copied from stored records after cross-checking them; they are
// never accepted from a request body.
//
// A positive release-eligibility projection is NOT a funding authority. This
// service never calls releaseEligibilityService and never reads a task as proof
// of funding. A task without a milestone is not a release target at all.

const clock = require('../config/clock');
const {
    isPositiveSafeMinorAmount,
    paymentCommissionSplit,
} = require('../config/commission');
const {
    RELEASE_TARGET_TYPES,
    RELEASE_CURRENCY,
    isValidDocumentId,
    releaseRequestId,
    releaseEventId,
} = require('../config/release');
const releaseRepository = require('../repositories/releaseRepository');
const paymentRepository = require('../repositories/paymentRepository');
const contractRepository = require('../repositories/contractRepository');
const employmentRepository = require('../repositories/employmentRepository');

class ReleaseValidationError extends Error {
    constructor(message, code = 'RELEASE_INVALID_REQUEST') {
        super(message);
        this.name = 'ReleaseValidationError';
        this.code = code;
    }
}

const fail = (message, code) => {
    throw new ReleaseValidationError(message, code);
};

const asDocument = (snapshot, id) => ({ id, ...snapshot.data() });

const requireDocument = (snapshot, id, code, label) => {
    if (!snapshot || !snapshot.exists) {
        fail(`${label} ${id} was not found`, code);
    }
    return asDocument(snapshot, id);
};

const same = (left, right) => left === right;

const assertIdentityChain = (payment, contract, employment) => {
    if (
        !same(payment.contractId, contract.id) ||
        !same(payment.employmentId, contract.employmentId) ||
        !same(payment.employerId, contract.employerId) ||
        !same(payment.employeeId, contract.employeeId)
    ) {
        fail(
            'payment, contract and employment identities are inconsistent',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    if (
        !same(employment.employerId, contract.employerId) ||
        !same(employment.employeeId, contract.employeeId)
    ) {
        fail(
            'employment parties do not match the contract',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }
};

const validateFundingAmounts = (payment, contract, expectedAmountMinor) => {
    if (!isPositiveSafeMinorAmount(payment.amountMinor)) {
        fail(
            'funding amountMinor must be a positive safe integer within the supported range',
            'RELEASE_INVALID_AMOUNT'
        );
    }
    if (!same(payment.amountMinor, expectedAmountMinor)) {
        fail(
            'funding amount does not match the authoritative contract/milestone amount',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    let split;
    try {
        split = paymentCommissionSplit(payment);
    } catch {
        fail(
            'funding payment has an inconsistent commission split',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    if (payment.currency !== RELEASE_CURRENCY || contract.currency !== RELEASE_CURRENCY) {
        fail(
            `release currency must be ${RELEASE_CURRENCY}`,
            'RELEASE_UNSUPPORTED_CURRENCY'
        );
    }
    if (!same(payment.currency, contract.currency)) {
        fail(
            'payment and contract currencies disagree',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    return split;
};

const assertFundingPaid = (payment) => {
    if (payment.status !== 'paid') {
        fail(
            `release funding must be confirmed as paid (current status: ${payment.status})`,
            'RELEASE_FUNDING_NOT_CONFIRMED'
        );
    }
};

const loadEmployment = async (employmentId) => {
    if (!isValidDocumentId(employmentId)) {
        fail('payment has no valid employmentId', 'RELEASE_INCONSISTENT_RECORD');
    }
    const snapshot = await employmentRepository.getEmploymentById(employmentId);
    return requireDocument(
        snapshot,
        employmentId,
        'RELEASE_EMPLOYMENT_NOT_FOUND',
        'employment'
    );
};

const loadContract = async (contractId) => {
    if (!isValidDocumentId(contractId)) {
        fail('funding record has no valid contractId', 'RELEASE_INCONSISTENT_RECORD');
    }
    const snapshot = await contractRepository.getContractById(contractId);
    return requireDocument(
        snapshot,
        contractId,
        'RELEASE_CONTRACT_NOT_FOUND',
        'contract'
    );
};

const loadMilestoneFunding = async (milestoneId) => {
    const paymentSnapshot = await paymentRepository.getPaymentByMilestoneId(milestoneId);
    const payment = requireDocument(
        paymentSnapshot,
        milestoneId,
        'RELEASE_FUNDING_NOT_FOUND',
        'funding payment'
    );

    if (!same(payment.milestoneId, milestoneId)) {
        fail(
            'funding record is not the payment for the named milestone',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    assertFundingPaid(payment);

    const contract = await loadContract(payment.contractId);
    if (contract.paymentMode !== 'milestones') {
        fail(
            'a milestone release requires a milestones-mode contract',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    const milestoneSnapshot = await contractRepository.getMilestoneById(milestoneId);
    const milestone = requireDocument(
        milestoneSnapshot,
        milestoneId,
        'RELEASE_MILESTONE_NOT_FOUND',
        'milestone'
    );

    if (
        !same(milestone.contractId, contract.id) ||
        !same(milestone.employmentId, contract.employmentId)
    ) {
        fail(
            'milestone does not belong to the funding contract/employment',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    const split = validateFundingAmounts(
        payment,
        contract,
        milestone.amountMinor
    );

    const employment = await loadEmployment(contract.employmentId);
    assertIdentityChain(payment, contract, employment);

    return {
        paymentId: milestoneId,
        contractId: contract.id,
        employmentId: contract.employmentId,
        employerId: contract.employerId,
        employeeId: contract.employeeId,
        providerEnvironment: payment.providerEnvironment || 'test',
        amountMinor: split.netPayableMinor,
        currency: contract.currency,
        ...(split.commissionIncluded
            ? {
                  agreedAmountMinor: split.grossAmountMinor,
                  commissionAmountMinor: split.commissionAmountMinor,
                  commissionBps: split.commissionBps,
              }
            : {}),
    };
};

const loadContractFunding = async (contractId) => {
    const contract = await loadContract(contractId);
    if (contract.paymentMode !== 'full') {
        fail(
            'a contract release requires a full-mode contract',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    const paymentSnapshot = await paymentRepository.getPaymentByContractId(contractId);
    const paymentId = paymentRepository.contractPaymentId(contractId);
    const payment = requireDocument(
        paymentSnapshot,
        paymentId,
        'RELEASE_FUNDING_NOT_FOUND',
        'funding payment'
    );

    if (payment.paymentTarget !== 'contract') {
        fail(
            'full-contract funding must be a contract payment',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    if (payment.milestoneId !== undefined && payment.milestoneId !== null) {
        fail(
            'full-contract funding must not carry a milestoneId',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    assertFundingPaid(payment);
    const split = validateFundingAmounts(
        payment,
        contract,
        contract.totalAmountMinor
    );

    const employment = await loadEmployment(contract.employmentId);
    assertIdentityChain(payment, contract, employment);

    return {
        paymentId,
        contractId: contract.id,
        employmentId: contract.employmentId,
        employerId: contract.employerId,
        employeeId: contract.employeeId,
        providerEnvironment: payment.providerEnvironment || 'test',
        amountMinor: split.netPayableMinor,
        currency: contract.currency,
        ...(split.commissionIncluded
            ? {
                  agreedAmountMinor: split.grossAmountMinor,
                  commissionAmountMinor: split.commissionAmountMinor,
                  commissionBps: split.commissionBps,
              }
            : {}),
    };
};

const targetFundingPaymentId = (targetType, targetId) => {
    if (targetType === 'contract') {
        return paymentRepository.contractPaymentId(targetId);
    }
    return targetId;
};

const releaseIdentityFields = [
    'paymentId',
    'contractId',
    'employmentId',
    'employerId',
    'employeeId',
    'amountMinor',
    'currency',
    'agreedAmountMinor',
    'commissionAmountMinor',
    'commissionBps',
];

const revalidateReleaseFunding = async (release) => {
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
        fail('release must be an object', 'RELEASE_INCONSISTENT_RECORD');
    }
    if (!RELEASE_TARGET_TYPES.includes(release.targetType)) {
        fail('release has an invalid targetType', 'RELEASE_INCONSISTENT_RECORD');
    }
    if (!isValidDocumentId(release.targetId)) {
        fail('release has an invalid targetId', 'RELEASE_INCONSISTENT_RECORD');
    }

    const funding = release.targetType === 'milestone'
        ? await loadMilestoneFunding(release.targetId)
        : await loadContractFunding(release.targetId);

    for (const field of releaseIdentityFields) {
        if (release[field] !== funding[field]) {
            fail(
                'release identity no longer matches the authoritative funding records',
                'RELEASE_INCONSISTENT_RECORD'
            );
        }
    }

    const expectedTargetId = release.targetType === 'milestone'
        ? funding.paymentId
        : funding.contractId;
    if (release.targetId !== expectedTargetId) {
        fail(
            'release target no longer matches its authoritative funding record',
            'RELEASE_INCONSISTENT_RECORD'
        );
    }

    return funding;
};

/**
 * Creates (or returns) the deterministic release request for one funded
 * target. Only `targetType` and `targetId` are read from the caller.
 *
 * Idempotency: the deterministic id is checked first, then the request and its
 * event are created in one transaction. Repeated or concurrent claims for the
 * same target therefore return the same request and never append a second
 * `release_requested` event.
 */
const createReleaseRequest = async (payload = {}) => {
    const targetType = payload && payload.targetType;
    const targetId = payload && payload.targetId;

    if (!RELEASE_TARGET_TYPES.includes(targetType)) {
        fail(
            `targetType must be one of: ${RELEASE_TARGET_TYPES.join(', ')}`,
            'RELEASE_INVALID_TARGET'
        );
    }
    if (!isValidDocumentId(targetId)) {
        fail('targetId must be a valid document id', 'RELEASE_INVALID_TARGET');
    }

    const paymentId = targetFundingPaymentId(targetType, targetId);
    const releaseId = releaseRequestId(paymentId);

    const existing = await releaseRepository.getReleaseById(releaseId);
    if (existing.exists) {
        return {
            created: false,
            release: { id: existing.id, ...existing.data() },
        };
    }

    const funding = targetType === 'milestone'
        ? await loadMilestoneFunding(targetId)
        : await loadContractFunding(targetId);

    const createdAt = clock.now();
    const release = {
        releaseId,
        targetType,
        targetId,
        paymentId: funding.paymentId,
        contractId: funding.contractId,
        employmentId: funding.employmentId,
        employerId: funding.employerId,
        employeeId: funding.employeeId,
        providerEnvironment: funding.providerEnvironment,
        amountMinor: funding.amountMinor,
        currency: funding.currency,
        ...(funding.agreedAmountMinor !== undefined
            ? {
                  agreedAmountMinor: funding.agreedAmountMinor,
                  commissionAmountMinor: funding.commissionAmountMinor,
                  commissionBps: funding.commissionBps,
              }
            : {}),
        status: 'requested',
        attemptCount: 0,
        createdAt,
        updatedAt: createdAt,
    };

    const eventId = releaseEventId(releaseId, 'release_requested');
    const event = {
        releaseId,
        eventType: 'release_requested',
        targetType,
        targetId,
        paymentId: funding.paymentId,
        fromStatus: null,
        toStatus: 'requested',
        amountMinor: funding.amountMinor,
        currency: funding.currency,
        createdAt,
    };

    const result = await releaseRepository.createReleaseWithEventIfAbsent(
        releaseId,
        release,
        eventId,
        event
    );

    if (!result.created) {
        return result;
    }

    // Return the stored shape, not the pre-write Date object. The fake and a
    // real Firestore both normalise timestamps on write, so a created response
    // and an idempotent duplicate response must not disagree about shape.
    const stored = await releaseRepository.getReleaseById(releaseId);
    return {
        created: true,
        release: { id: stored.id, ...stored.data() },
        eventId: result.eventId,
    };
};

module.exports = {
    ReleaseValidationError,
    createReleaseRequest,
    revalidateReleaseFunding,
};
