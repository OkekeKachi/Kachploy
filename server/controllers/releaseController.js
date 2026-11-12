'use strict';

const releaseService = require('../services/releaseService');
const releaseWorkspaceService = require('../services/releaseWorkspaceService');
const releaseEligibilityService = require('../services/releaseEligibilityService');
const releaseOrchestrationService = require('../services/releaseOrchestrationService');
const releaseReconciliationService = require('../services/releaseReconciliationService');
const payoutAccountService = require('../services/payoutAccountService');
const { createPaystackProvider } = require('../services/paystackProvider');
const { PaystackConfigurationError, getSecretKey } = require('../config/paystack');

const getProvider = (req) => {
    if (req.app.locals.releaseProvider) {
        return req.app.locals.releaseProvider;
    }
    getSecretKey();
    return createPaystackProvider();
};

const sendReleaseError = (res, error, fallbackMessage) => {
    if (error instanceof PaystackConfigurationError) {
        return res.status(503).json({ message: 'Payments are not configured on this server' });
    }

    if (error instanceof releaseWorkspaceService.ReleaseWorkspaceError) {
        const status = error.code === 'RELEASE_WORKSPACE_NOT_FOUND' ? 404 : 400;
        return res.status(status).json({ message: error.message });
    }

    if (error instanceof releaseService.ReleaseValidationError) {
        if (error.code === 'RELEASE_NOT_FOUND') {
            return res.status(404).json({ message: 'Release not found' });
        }
        if (
            error.code === 'RELEASE_NOT_ELIGIBLE' ||
            error.code === 'RELEASE_LIVE_PAYOUTS_DISABLED'
        ) {
            return res.status(409).json({ message: error.message });
        }
        return res.status(400).json({ message: error.message });
    }

    console.error(fallbackMessage, error);
    return res.status(500).json({ message: 'Failed to process release request' });
};

const createRelease = async (req, res) => {
    const { targetType, targetId } = req.body || {};
    const { employmentId } = req.releaseTarget;

    try {
        const eligibility = await releaseEligibilityService.getReleaseEligibility(employmentId);

        if (targetType === 'milestone') {
            const milestoneTasks = eligibility.tasks.filter(
                (task) => task.milestoneId === targetId
            );
            if (
                milestoneTasks.length === 0
                || milestoneTasks.some((task) => task.status !== 'eligible')
            ) {
                return res.status(409).json({
                    message: 'This milestone is not eligible for release',
                    reason: milestoneTasks[0]?.reason || 'work_not_eligible',
                });
            }
        } else if (eligibility.status !== 'eligible') {
            return res.status(409).json({
                message: 'This contract is not eligible for release',
                reason: eligibility.reason,
            });
        }

        const result = await releaseService.createReleaseRequest({ targetType, targetId });
        return res.status(result.created ? 201 : 200).json({
            release: result.release,
            created: result.created,
        });
    } catch (error) {
        return sendReleaseError(res, error, 'Error creating release request:');
    }
};

const getRelease = async (req, res) => res.status(200).json({ release: req.release });

const getWorkspace = async (req, res) => {
    try {
        const workspace = await releaseWorkspaceService.getReleaseWorkspace(
            req.employment.id,
            req.user.uid
        );
        return res.status(200).json(workspace);
    } catch (error) {
        return sendReleaseError(res, error, 'Error reading release workspace:');
    }
};

const approveRelease = async (req, res) => {
    const release = req.release;

    if (release.status === 'succeeded') {
        return res.status(200).json({ submitted: false, release, outcome: 'succeeded' });
    }
    if (release.status === 'in_flight') {
        return res.status(200).json({ submitted: false, release, reason: 'in_flight' });
    }
    if (release.status !== 'requested') {
        return res.status(409).json({
            message: 'This release cannot be approved in its current state',
            status: release.status,
        });
    }

    try {
        const payoutAccount = await payoutAccountService.getFullPayoutAccount(release.employeeId);
        if (!payoutAccount) {
            return res.status(409).json({
                message: 'The employee must add a payout account before this release can be approved',
            });
        }

        const provider = getProvider(req);
        const result = await releaseOrchestrationService.submitReleaseAttempt(release.id, {
            provider,
            payoutAccount,
        });

        return res.status(200).json({
            submitted: result.submitted,
            outcome: result.outcome,
            release: result.release || release,
            ...(result.reason ? { reason: result.reason } : {}),
        });
    } catch (error) {
        return sendReleaseError(res, error, 'Error approving release:');
    }
};

const reconcileRelease = async (req, res) => {
    const release = req.release;

    if (!['in_flight', 'needs_review', 'failed', 'succeeded'].includes(release.status)) {
        return res.status(409).json({
            message: 'This release cannot be reconciled in its current state',
            status: release.status,
        });
    }

    try {
        const provider = getProvider(req);
        const result = await releaseReconciliationService.reconcileRelease(release.id, {
            provider,
        });
        return res.status(200).json(result);
    } catch (error) {
        return sendReleaseError(res, error, 'Error reconciling release:');
    }
};

module.exports = {
    createRelease,
    getRelease,
    getWorkspace,
    approveRelease,
    reconcileRelease,
};
