const express = require('express');
const router = express.Router();
const interviewController = require('../controllers/interviewController');
const {
    protect,
    requireJobOwner,
    JOB_INTERVIEWS_FORBIDDEN,
    requireInterviewAuthor,
    requireInterviewOwner,
    requireInterviewParty,
} = require('../middleware/auth');

// STAGE 7C: the interviews resource, mounted at /interviews in app.js.
//
// Four endpoints, no business logic and no inline handlers -- route definitions and
// middleware only, like every router in this codebase.
//
// AUTHORIZATION: every write is employer-only and every read is party-scoped, and
// all three decisions are made in the guards rather than in the controller:
//   requireInterviewAuthor  POST   the employer who posted the job the
//                                  application belongs to may schedule an interview.
//                                  Body-based, like requireTaskAssignment on
//                                  POST /tasks, because the application being
//                                  interviewed is the subject of the request rather
//                                  than part of a route.
//   requireInterviewOwner    PUT    the employer who posted the job behind the
//                                  interview may change it -- reschedule, correct a
//                                  detail, complete, cancel or mark a no-show. There
//                                  is deliberately no applicant path: an applicant may
//                                  read an interview but never modify one.
//   requireInterviewParty    GET    either party to the application -- its applicant
//                                  or the owner of its job -- may read the interviews
//                                  on it. This is the only guard in auth.js that
//                                  admits two kinds of caller.
//   requireJobOwner          GET    the employer-side, job-wide list. Existing guard,
//                                  reused with the read-accurate JOB_INTERVIEWS_FORBIDDEN
//                                  wording that Stage 6S and 6T introduced.
//
// Ordering: the two GET paths have different first segments, so neither shadows the
// other, and PUT /:interviewId is a single segment on a different method from both.
// POST / is also a single segment, so it cannot be shadowed by the two-segment GETs.
//
// No DELETE. Withdrawing an interview is not in this stage's scope: cancelling one
// exists (it is a status), and that is how an employer takes one off the schedule
// without losing the record of it.
router.post('/', protect, requireInterviewAuthor, interviewController.createInterview);
router.put('/:interviewId', protect, requireInterviewOwner, interviewController.updateInterview);
router.get('/job/:jobId', protect, requireJobOwner(JOB_INTERVIEWS_FORBIDDEN), interviewController.listInterviewsForJob);
router.get('/application/:applicationId', protect, requireInterviewParty, interviewController.listInterviewsForApplication);

module.exports = router;