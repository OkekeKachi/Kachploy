var express = require('express');
var router = express.Router();
const applicationController = require('../controllers/applicationController');
const {
    protect,
    requireSelfParam,
    requireApplicationOwner,
    requireApplicationReviewer,
    requireResumeAccess,
    requireJobOwner,
    JOB_APPLICANTS_FORBIDDEN,
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

// STAGE 12.12.1. Private resume delivery. requireResumeAccess admits only the
// applicant (the resume's owner) or the employer who posted the job, and the
// handler mints a short-lived signed URL from the application's own stored resume
// reference. Registered as a three-segment GET; it cannot be shadowed by the
// two-segment GET routes above nor by PUT /:id/status below.
router.get('/:applicationId/resume/download', protect, requireResumeAccess, applicationController.downloadResume);

router.delete('/:applicationId', protect, requireApplicationOwner, applicationController.withdrawApplication);


// STAGE 9F: `POST /tasks` used to be duplicated here as `/tasks`, which shared the
// requireTaskAssignment guard but answered `{ message }` with no taskId. It had no
// caller -- the client has always posted to POST /tasks -- and two response shapes for
// one action is a trap rather than a convenience, so the duplicate and its handler are
// gone. POST /tasks in routes/tasks.js is the only standalone task-creation endpoint.
//
// No route is registered at this path, so a request here now falls through to the
// app's 404 handler. That is the intended answer: there is no second way in.


module.exports = router;
