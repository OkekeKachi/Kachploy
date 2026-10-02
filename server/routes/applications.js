var express = require('express');
var router = express.Router();
const applicationController = require('../controllers/applicationController');
const {
    protect,
    requireSelfParam,
    requireApplicationOwner,
    requireApplicationReviewer,
    requireJobOwner,
    JOB_APPLICANTS_FORBIDDEN,
    requireTaskAssignment,
} = require("../middleware/auth");


router.post('/apply', protect, applicationController.applyToJob);


router.get('/employee/:uid', protect, requireSelfParam('uid'), applicationController.listApplicationsForEmployee);

// Stage 5B: applicant counts for every job, numbers only. Registered before
// /job/:jobId so the count-only path is unambiguous to read; it is a distinct
// single-segment route and cannot be shadowed by it.
router.get('/counts', protect, applicationController.countApplicationsByJob);

// Stage 5B: owner-guarded. This endpoint returns every applicant's identity for a
// job, so it now requires job.postedBy === req.user.uid via the existing
// requireJobOwner guard (middleware/auth.js). Registered before /:id/... routes,
// which are two-segment paths and unaffected.
//
// Stage 6S: this is a READ, so the guard is given the read-accurate 403 wording.
// It used to reject with "You do not have permission to modify this job", which
// described an edit the caller never attempted. The status is still 403 and the
// ownership test is untouched; only the sentence changed.
router.get('/job/:jobId', protect, requireJobOwner(JOB_APPLICANTS_FORBIDDEN), applicationController.listApplicationsForJob);


router.put('/:id/status', protect, requireApplicationReviewer, applicationController.updateApplicationStatus);

router.delete('/:applicationId', protect, requireApplicationOwner, applicationController.withdrawApplication);


// Route to create a task for the hired applicant
// NOTE: duplicate of POST /tasks, kept until Stage 7. The two handlers are not
// identical -- this one returns no taskId.
router.post('/tasks', protect, requireTaskAssignment, applicationController.createTaskFromApplication);


module.exports = router;
