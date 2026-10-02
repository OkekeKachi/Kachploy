const express = require('express');
const router = express.Router();
const taskController = require('../controllers/taskController');
const { protect, requireTaskAssignment, requireSelfParam, requireJobOwner, JOB_TASKS_FORBIDDEN } = require("../middleware/auth");

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

module.exports = router;
