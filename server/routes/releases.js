'use strict';

const express = require('express');
const releaseController = require('../controllers/releaseController');
const {
    protect,
    requireEmploymentParty,
    requireReleaseParty,
    requireReleaseEmployer,
    requireReleaseTargetEmployer,
} = require('../middleware/auth');
const { releaseRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

router.use(protect);

router.get(
    '/employment/:employmentId',
    requireEmploymentParty,
    releaseController.getWorkspace
);
router.post(
    '/',
    releaseRateLimiter,
    requireReleaseTargetEmployer,
    releaseController.createRelease
);
router.get('/:releaseId', requireReleaseParty, releaseController.getRelease);
router.post(
    '/:releaseId/approve',
    releaseRateLimiter,
    requireReleaseEmployer,
    releaseController.approveRelease
);
router.post(
    '/:releaseId/reconcile',
    releaseRateLimiter,
    requireReleaseEmployer,
    releaseController.reconcileRelease
);

module.exports = router;
