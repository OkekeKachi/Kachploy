const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { protect, requireTaskAssignment, requireTaskParty, requireSelfParam, requireJobOwner, JOB_TASKS_FORBIDDEN } = require("../middleware/auth");
const { uploadRateLimiter } = require('../middleware/rateLimit');

// Route to create a task
router.post('/', protect, requireTaskAssignment, taskController.createTask);

// STAGE 6B: read endpoints. Before this the resource was create-only, so a stored
// task could never be read back by anyone -- not the assignee, not the employer.
//
// Both reuse guards that already exist and are already used the same way by
// GET /applications/employee/:uid and GET /applications/job/:jobId, so no new
// authorization check was needed:
//   requireSelfParam('uid') -> the path parameter must equal req.user.uid
//   requireJobOwner         -> job.postedBy must equal req.user.uid
// Both are two-segment paths, so neither can shadow the single-segment POST '/'.
//
// STAGE 6T: requireJobOwner is a factory, so it must be invoked. This read passes
// JOB_TASKS_FORBIDDEN, which is the last route still reporting a read refusal with
// the write-oriented "modify this job" wording after Stage 6S corrected the
// applicant read. Status stays 403 and the ownership check is untouched; only the
// sentence changed.
router.get('/employee/:uid', protect, requireSelfParam('uid'), taskController.listTasksForEmployee);
router.get('/job/:jobId', protect, requireJobOwner(JOB_TASKS_FORBIDDEN), taskController.listTasksForJob);

// STAGE 9C: the task lifecycle -- one read and the three transitions.
//
// Registered after the two list reads for readability only. `/:taskId` binds exactly
// one segment, so it can never shadow the two-segment `/employee/:uid` and
// `/job/:jobId` above, and those can never shadow it either.
//
// requireTaskParty is a factory because the four uses differ. A read admits both
// parties of the employment AND falls back to the job relationship for a task with
// no employment linkage. A mutation refuses that fallback, refuses an ended
// employment, and requires the caller to hold the one role that owns the action:
// submitting is the employee's, approving and requesting a revision are the
// employer's. See the guard for why the fallback is not treated as authority.
//
// One route per action, never a generic status update. A `PUT /tasks/:taskId/status`
// taking an arbitrary status would have to re-derive this table from whatever the
// client sent, and could only be as strict as the least careful entry in it; naming
// the action in the URL makes an illegal transition unrepresentable from the client
// and keeps the four rules that apply differently (submittedBody, revisionNote, the
// two timestamps) attached to the action that owns them.
// STAGE 10G.1: the signing endpoint that starts a `file` submission.
//
// Registered BEFORE `/:taskId` would not be necessary -- that route is a GET and this
// is a POST, so the two can never match the same request -- but it sits with the
// transition routes because it is guarded exactly like the one it exists to feed:
// protect, then requireTaskParty({ mutation: true, role: 'employee' }). The same
// guard, the same three decisions and the same 403 bodies as POST /:taskId/submit,
// so a caller who cannot submit a task cannot get a signature to upload with either.
//
// `mutation: true` is what makes that true rather than merely similar: it refuses a
// task with no employment linkage and an ended employment, exactly as submit does,
// instead of falling back to the job relationship the read routes accept.
//
// The route name says what it returns, not what it does with it: this endpoint never
// receives a file, never talks to Cloudinary, and never writes to the task. The
// upload goes browser -> Cloudinary, and the reference comes back through the
// submit route below.
router.post(
    '/:taskId/upload-signature',
    uploadRateLimiter,
    protect,
    requireTaskParty({ mutation: true, role: 'employee' }),
    taskController.signTaskUpload
);

router.get('/:taskId', protect, requireTaskParty(), taskController.getTask);
router.get('/:taskId/history', protect, requireTaskParty(), taskController.getTaskHistory);
router.post('/:taskId/submit', protect, requireTaskParty({ mutation: true, role: 'employee' }), taskController.submitTask);
router.post('/:taskId/approve', protect, requireTaskParty({ mutation: true, role: 'employer' }), taskController.approveTask);
router.post('/:taskId/request-revision', protect, requireTaskParty({ mutation: true, role: 'employer' }), taskController.requestTaskRevision);
router.post('/:taskId/admin-review-request', protect, requireTaskParty({ mutation: true, role: 'employee' }), taskController.requestAdminReview);
router.post('/:taskId/admin-review-response', protect, requireTaskParty({ mutation: true, role: 'employee' }), taskController.respondToAdminReview);

module.exports = router;
