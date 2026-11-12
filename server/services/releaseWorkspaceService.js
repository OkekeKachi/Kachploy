'use strict';

const {
    isValidDocumentId,
    releaseRequestId,
} = require('../config/release');
const { paymentCommissionSplit } = require('../config/commission');
const releaseRepository = require('../repositories/releaseRepository');
const contractRepository = require('../repositories/contractRepository');
const employmentRepository = require('../repositories/employmentRepository');
const paymentRepository = require('../repositories/paymentRepository');
const releaseEligibilityService = require('./releaseEligibilityService');
const payoutAccountService = require('./payoutAccountService');

class ReleaseWorkspaceError extends Error {
    constructor(message, code = 'RELEASE_WORKSPACE_INVALID') {
        super(message);
        this.name = 'ReleaseWorkspaceError';
        this.code = code;
    }
}

const toPlain = (snapshot) => {
    const rows = [];
    if (!snapshot) return rows;
    if (Array.isArray(snapshot.docs)) return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    if (typeof snapshot.forEach === 'function') {
        snapshot.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
    }
    return rows;
};

const commissionBreakdown = (split) =>
    split.commissionIncluded
        ? {
              agreedAmountMinor: split.grossAmountMinor,
              commissionAmountMinor: split.commissionAmountMinor,
              commissionBps: split.commissionBps,
          }
        : {};

const releaseSummary = (release) => ({
    releaseId: release.id || release.releaseId,
    targetType: release.targetType,
    targetId: release.targetId,
    status: release.status,
    amountMinor: release.amountMinor,
    currency: release.currency,
    ...(release.agreedAmountMinor !== undefined
        ? {
              agreedAmountMinor: release.agreedAmountMinor,
              commissionAmountMinor: release.commissionAmountMinor,
              commissionBps: release.commissionBps,
          }
        : {}),
    attemptCount: release.attemptCount || 0,
    lastFailureReason: release.lastFailureReason || null,
    lastProviderReference: release.lastProviderReference || null,
    createdAt: release.createdAt || null,
    updatedAt: release.updatedAt || null,
    completedAt: release.completedAt || null,
});

const isPaid = (payment) => Boolean(payment) && payment.status === 'paid';

const getReleaseWorkspace = async (employmentId, viewerUid) => {
    if (!isValidDocumentId(employmentId)) {
        throw new ReleaseWorkspaceError('employmentId must be a valid document id');
    }

    const employmentSnapshot = await employmentRepository.getEmploymentById(employmentId);
    if (!employmentSnapshot.exists) {
        throw new ReleaseWorkspaceError('Employment not found', 'RELEASE_WORKSPACE_NOT_FOUND');
    }
    const employment = { id: employmentSnapshot.id, ...employmentSnapshot.data() };

    const [contractSnapshot, eligibility, releasesSnapshot, payoutAccount] = await Promise.all([
        contractRepository.getContractById(employmentId),
        releaseEligibilityService.getReleaseEligibility(employmentId),
        releaseRepository.listReleasesByEmployment(employmentId),
        payoutAccountService.getPayoutAccountSummary(employment.employeeId),
    ]);

    const contract = contractSnapshot.exists
        ? { id: contractSnapshot.id, ...contractSnapshot.data() }
        : null;

    const releases = toPlain(releasesSnapshot)
        .map(releaseSummary)
        .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')));

    const releaseByTarget = new Map(
        releases.map((release) => [`${release.targetType}:${release.targetId}`, release])
    );

    const targets = [];
    if (contract) {
        if (contract.paymentMode === 'full') {
            if (eligibility.status === 'eligible') {
                const paymentSnapshot = await paymentRepository.getPaymentByContractId(employmentId);
                const payment = paymentSnapshot.exists
                    ? { id: paymentSnapshot.id, ...paymentSnapshot.data() }
                    : null;
                if (isPaid(payment) && payment.paymentTarget === 'contract') {
                    const releaseId = releaseRequestId(payment.id);
                    const split = paymentCommissionSplit(payment);
                    targets.push({
                        targetType: 'contract',
                        targetId: employmentId,
                        label: 'Full contract',
                        amountMinor: split.netPayableMinor,
                        currency: payment.currency,
                        ...commissionBreakdown(split),
                        paymentId: payment.id,
                        releaseId,
                        releaseStatus: releaseByTarget.get(`contract:${employmentId}`)?.status || null,
                    });
                }
            }
        } else {
            const eligibleMilestones = new Set(
                eligibility.tasks
                    .filter((task) => task.status === 'eligible' && task.milestoneId)
                    .map((task) => task.milestoneId)
            );

            const milestonesSnapshot = await contractRepository.listMilestonesByContract(employmentId);
            const milestones = toPlain(milestonesSnapshot);

            for (const milestone of milestones) {
                if (!eligibleMilestones.has(milestone.id)) continue;
                const paymentSnapshot = await paymentRepository.getPaymentByMilestoneId(milestone.id);
                const payment = paymentSnapshot.exists
                    ? { id: paymentSnapshot.id, ...paymentSnapshot.data() }
                    : null;
                if (!isPaid(payment)) continue;
                const releaseId = releaseRequestId(payment.id);
                const split = paymentCommissionSplit(payment);
                targets.push({
                    targetType: 'milestone',
                    targetId: milestone.id,
                    label: milestone.label || milestone.id,
                    amountMinor: split.netPayableMinor,
                    currency: payment.currency,
                    ...commissionBreakdown(split),
                    paymentId: payment.id,
                    releaseId,
                    releaseStatus: releaseByTarget.get(`milestone:${milestone.id}`)?.status || null,
                });
            }
        }
    }

    const canSeePayoutDetails = viewerUid === employment.employeeId;

    return {
        employmentId,
        contractId: contract ? contract.id : null,
        employerId: employment.employerId,
        employeeId: employment.employeeId,
        eligibility: {
            status: eligibility.status,
            reason: eligibility.reason,
            blockedByDisputeId: eligibility.blockedByDisputeId || null,
        },
        targets,
        releases,
        payoutAccount: canSeePayoutDetails
            ? payoutAccount
            : { configured: Boolean(payoutAccount.configured) },
    };
};

module.exports = {
    ReleaseWorkspaceError,
    getReleaseWorkspace,
    releaseSummary,
};
