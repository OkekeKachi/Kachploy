const express = require('express');
const router = express.Router();
const disputeController = require('../controllers/disputeController');
const reviewController = require('../controllers/reviewController');
const { protect, requireEmploymentParty, requireSelfParam } = require('../middleware/auth');

router.post('/employments/:employmentId/disputes', protect, requireEmploymentParty, disputeController.createDispute);
router.get('/disputes/:disputeId', protect, disputeController.getDispute);
router.get('/disputes/:disputeId/evidence', protect, disputeController.getDisputeEvidence);
router.get('/disputes/party/:uid', protect, requireSelfParam('uid'), disputeController.listDisputesForParty);
router.post('/disputes/:disputeId/evidence', protect, disputeController.addDisputeEvidence);

router.post('/employments/:employmentId/reviews', protect, requireEmploymentParty, reviewController.createReview);
router.get('/employments/:employmentId/reviews', protect, requireEmploymentParty, reviewController.listReviewsForEmployment);

module.exports = router;
