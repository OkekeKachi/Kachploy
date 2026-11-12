const adminReviewService = require('../services/adminReviewService');

const sendFailure = (res, err, { log, message }) => {
    if (err instanceof adminReviewService.AdminValidationError) {
        return res.status(400).json({ message: err.message });
    }
    if (err instanceof adminReviewService.AdminNotFoundError) {
        return res.status(404).json({ message: err.message });
    }
    if (err instanceof adminReviewService.AdminStateError) {
        return res.status(409).json({ message: err.message });
    }
    if (log) console.error(log, err);
    return res.status(500).json({ message });
};

const listDisputes = async (req, res) => {
    try {
        const disputes = await adminReviewService.listDisputes();
        res.status(200).json({ disputes });
    } catch (error) {
        sendFailure(res, error, { log: 'Error listing disputes:', message: 'Failed to list disputes' });
    }
};

const listReviews = async (req, res) => {
    try {
        const reviews = await adminReviewService.listReviews();
        res.status(200).json({ reviews });
    } catch (error) {
        sendFailure(res, error, { log: 'Error listing reviews:', message: 'Failed to list reviews' });
    }
};

const getReview = async (req, res) => {
    try {
        const review = await adminReviewService.getReview(req.params.taskId);
        res.status(200).json(review);
    } catch (error) {
        sendFailure(res, error, { log: 'Error fetching review:', message: 'Failed to fetch review' });
    }
};

const decide = async (req, res) => {
    const { action, rationale } = req.body || {};

    try {
        const result = await adminReviewService.decide(
            req.params.taskId,
            { action, rationale },
            req.user.uid
        );
        res.status(200).json({ message: 'Decision recorded', ...result });
    } catch (error) {
        sendFailure(res, error, { log: 'Error recording decision:', message: 'Failed to record decision' });
    }
};

module.exports = {
    listDisputes,
    listReviews,
    getReview,
    decide,
};
