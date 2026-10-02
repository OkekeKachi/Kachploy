var express = require('express');
var router = express.Router();
const jobController = require('../controllers/jobController');
const { protect, requireJobOwner, requireSelfParam } = require("../middleware/auth");

router.get('/', protect, jobController.listJobs);

router.post('/create', protect, jobController.createJob);

router.get('/employer/:uid', protect, requireSelfParam('uid'), jobController.listEmployerJobs);

// NOTE: the live handler. It returns the raw document with no `id` and no array
// defaults. The second registration further down is unreachable dead code.
router.get('/:jobId', protect, jobController.getJob);

// STAGE 6S: requireJobOwner is a factory (it takes the 403 wording), so all
// three mutating routes below invoke it. Passing the bare function would make
// Express treat the factory as the middleware, and it would never call next().
router.put('/edit/:jobId', protect, requireJobOwner(), jobController.updateJob);

// Also, you might want to update your GET route to return the new fields
// NOTE: unreachable duplicate of GET /:jobId above, kept until Stage 7. Express
// matches in registration order, so jobController.getJob always wins and
// jobController.getJobWithDefaults never runs.
router.get('/:jobId', protect, jobController.getJobWithDefaults);

router.delete('/:jobId', protect, requireJobOwner(), jobController.deleteJob);

// PUT /jobs/:jobId/status
// Called with no argument, so these three keep the original "modify this job"
// rejection text unchanged.
router.put('/:jobId/status', protect, requireJobOwner(), jobController.updateJobStatus);

module.exports = router;
