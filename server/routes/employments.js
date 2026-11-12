const express = require('express');
const router = express.Router();
const employmentController = require('../controllers/employmentController');
const {
    protect,
    requireSelfParam,
    requireJobOwner,
    requireEmploymentParty,
    JOB_EMPLOYMENTS_FORBIDDEN,
} = require('../middleware/auth');

// STAGE 7A/10H/emp-lifecycle: employments resource. Reads + lifecycle mutations
// (complete/terminate/settlement) for parties to the employment.
router.get('/employee/:uid', protect, requireSelfParam('uid'), employmentController.listEmploymentsForEmployee);
router.get('/employer/:uid', protect, requireSelfParam('uid'), employmentController.listEmploymentsForEmployer);
router.get('/job/:jobId', protect, requireJobOwner(JOB_EMPLOYMENTS_FORBIDDEN), employmentController.listEmploymentsForJob);
// Lifecycle mutations (must be before generic :employmentId to avoid ambiguity if needed, but order fine)
router.get('/:employmentId/release-eligibility', protect, requireEmploymentParty, employmentController.getReleaseEligibility);
router.post('/:employmentId/complete', protect, requireEmploymentParty, employmentController.completeEmployment);
router.post('/:employmentId/terminate', protect, requireEmploymentParty, employmentController.terminateEmployment);
router.post('/:employmentId/settlement', protect, requireEmploymentParty, employmentController.recordEmploymentSettlement);
router.get('/:employmentId', protect, requireEmploymentParty, employmentController.getEmployment);

module.exports = router;