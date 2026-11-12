const reviewService = require('../services/reviewService');

const sendFailure = (res, err, { log, message }) => {
    if (err instanceof reviewService.ReviewValidationError) {
        return res.status(400).json({ message: err.message });
    }
    if (err instanceof reviewService.ReviewNotFoundError) {
        return res.status(404).json({ message: err.message });
    }
    if (err instanceof reviewService.ReviewForbiddenError) {
        return res.status(403).json({ message: err.message });
    }
    if (err instanceof reviewService.ReviewStateError) {
        return res.status(409).json({ message: err.message });
    }
    if (log) console.error(log, err);
    return res.status(500).json({ message });
};

const createReview = async (req, res) => {
    const { employmentId } = req.params;
    const callerId = req.user && req.user.uid;
    const { revieweeId, rating, comment, role } = req.body || {};
    try {
        const result = await reviewService.createReview({ employmentId, reviewerId: callerId, revieweeId, rating, comment, role });
        res.status(201).json(result);
    } catch (error) {
        sendFailure(res, error, { log: 'Error creating review:', message: 'Failed to create review' });
    }
};

const listReviewsForEmployment = async (req, res) => {
    const { employmentId } = req.params;
    try {
        const reviews = await reviewService.listReviewsForEmployment(employmentId);
        res.status(200).json({ reviews });
    } catch (error) {
        sendFailure(res, error, { log: 'Error fetching reviews:', message: 'Failed to fetch reviews' });
    }
};

module.exports = {
    createReview,
    listReviewsForEmployment,
};
