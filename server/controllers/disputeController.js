const disputeService = require('../services/disputeService');

const sendFailure = (res, err, { log, message }) => {
    if (err instanceof disputeService.DisputeValidationError) {
        return res.status(400).json({ message: err.message });
    }
    if (err instanceof disputeService.DisputeNotFoundError) {
        return res.status(404).json({ message: err.message });
    }
    if (err instanceof disputeService.DisputeForbiddenError) {
        return res.status(403).json({ message: err.message });
    }
    if (err instanceof disputeService.DisputeStateError) {
        return res.status(409).json({ message: err.message });
    }
    if (log) console.error(log, err);
    return res.status(500).json({ message });
};

const createDispute = async (req, res) => {
    const { employmentId } = req.params;
    const callerId = req.user && req.user.uid;
    const { category, reason, description, taskId, milestoneId } = req.body || {};
    try {
        const result = await disputeService.createDispute({
            employmentId,
            initiatedBy: callerId,
            category,
            reason,
            description,
            taskId,
            milestoneId,
        });
        res.status(201).json(result);
    } catch (error) {
        sendFailure(res, error, { log: 'Error creating dispute:', message: 'Failed to create dispute' });
    }
};

const getDispute = async (req, res) => {
    const { disputeId } = req.params;
    const callerId = req.user && req.user.uid;
    try {
        const result = await disputeService.getDispute(disputeId, callerId);
        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, { log: 'Error fetching dispute:', message: 'Failed to fetch dispute' });
    }
};

const getDisputeEvidence = async (req, res) => {
    const { disputeId } = req.params;
    const callerId = req.user && req.user.uid;
    try {
        const result = await disputeService.getDisputeEvidence(disputeId, callerId);
        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, { log: 'Error fetching dispute evidence:', message: 'Failed to fetch dispute evidence' });
    }
};

const listDisputesForParty = async (req, res) => {
    const { uid } = req.params;
    const callerId = req.user && req.user.uid;
    if (uid !== callerId) return res.status(403).json({ message: 'Forbidden' });
    try {
        const disputes = await disputeService.listDisputesForParty(uid);
        res.status(200).json({ disputes });
    } catch (error) {
        sendFailure(res, error, { log: 'Error fetching disputes:', message: 'Failed to fetch disputes' });
    }
};

const addDisputeEvidence = async (req, res) => {
    const { disputeId } = req.params;
    const callerId = req.user && req.user.uid;
    const { evidenceType, content, url } = req.body || {};
    try {
        const result = await disputeService.addDisputeEvidence({ disputeId, submittedBy: callerId, evidenceType, content, url });
        res.status(201).json(result);
    } catch (error) {
        sendFailure(res, error, { log: 'Error adding dispute evidence:', message: 'Failed to add dispute evidence' });
    }
};

module.exports = {
    createDispute,
    getDispute,
    getDisputeEvidence,
    listDisputesForParty,
    addDisputeEvidence,
};
