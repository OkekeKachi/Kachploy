// interviewController.js
//
// HTTP layer for the interviews resource (new in Stage 7C). Four Express handlers,
// each doing only the three things every controller in this codebase does: take
// identity from the verified token, call exactly one interviewService function, and
// translate the outcome into a status code and body.
//
// All four endpoints are employer-authorised for writes and party-authorised for
// reads; the decisions themselves are made by the three Stage 7C guards in the
// router, exactly as requireJobOwner and requireApplicationReviewer are for jobs
// and applications. No handler here re-derives ownership, and no handler reads an
// identity from the request body.
//
// WHAT THIS CONTROLLER DELIBERATELY DOES NOT DO
//   * It does not touch `applications`. Scheduling an interview leaves the
//     application's status exactly as it was: Stage 7C adds no application status,
//     so there is nothing here to write.
//   * It does not touch `employments`. An interview is not a hire. Employment
//     records are created in exactly one place --
//     applicationService.updateApplicationStatus with `accepted` -- so no number of
//     interviews can produce one, and nothing in the interview path imports
//     employmentService.

const interviewService = require('../services/interviewService');

/**
 * Maps a service failure onto the HTTP response.
 *
 * The same helper the other four controllers use. Validation failures are turned
 * into a 400 and deliberately skip the console.error, matching the existing
 * convention that a request the caller got wrong is not a server fault.
 *
 * `errorKey` is not needed: unlike GET /job/:jobId, no endpoint in this resource
 * fails with `{ error }` instead of `{ message }`.
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof interviewService.InterviewValidationError) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof interviewService.InterviewNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * POST /interviews
 *
 * Guarded by requireInterviewAuthor, which has already resolved the application and
 * its job and confirmed the caller posted the job. So the 404s and the 403 below
 * come from that guard before this handler runs.
 *
 * `employerId` is `req.user.uid`, never a body field, so an employer cannot schedule
 * an interview that claims somebody else posted the job. `employeeId` is never
 * passed at all: interviewService reads the applicant from the application document,
 * so a body field of that name is ignored rather than honoured.
 *
 * Responds `{ message, interviewId }`, mirroring POST /tasks, which is the closest
 * existing create-and-report-an-id endpoint.
 */
const createInterview = async (req, res) => {
    const employerId = req.user.uid;

    try {
        const { interviewId } = await interviewService.createInterview(req.body, employerId);

        res.status(200).json({ message: 'Interview created successfully', interviewId });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating interview:',
            message: 'Failed to create interview',
        });
    }
};

/**
 * PUT /interviews/:interviewId
 *
 * Guarded by requireInterviewOwner, so only the employer who posted the job behind
 * the interview reaches this handler -- an applicant who is party to it is refused
 * with a 403 at the guard, and a missing interview is a 404 there too.
 *
 * A partial update: the service changes only the fields present in the body, so one
 * endpoint serves a reschedule, a detail correction and every status change
 * (completed / cancelled / no_show). Responds `{ message }`, as
 * PUT /applications/:id/status and PUT /jobs/:jobId/status do -- no endpoint in this
 * API returns the updated document.
 */
const updateInterview = async (req, res) => {
    const { interviewId } = req.params;

    try {
        await interviewService.updateInterview(interviewId, req.body);

        res.status(200).json({ message: 'Interview updated successfully' });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error updating interview:',
            message: 'Failed to update interview',
        });
    }
};

/**
 * GET /interviews/job/:jobId
 *
 * The employer's view of one job's recruitment: every interview held on it, across
 * all applicants. Guarded by the existing requireJobOwner with the read-accurate
 * JOB_INTERVIEWS_FORBIDDEN wording that Stage 6S and 6T established, so a non-owner
 * is told they may not *view* interviews rather than not modify the job.
 *
 * Responds `{ interviews }`, mirroring `{ tasks }` and `{ employments }` on the other
 * list endpoints.
 */
const listInterviewsForJob = async (req, res) => {
    const { jobId } = req.params;

    try {
        const interviews = await interviewService.listInterviewsForJob(jobId);

        res.status(200).json({ interviews });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching interviews for job:',
            message: 'Failed to fetch interviews',
        });
    }
};

/**
 * GET /interviews/application/:applicationId
 *
 * The shared read: the applicant whose recruitment this is, and the employer who owns
 * it, both reach this handler through requireInterviewParty, and everyone else gets
 * a 403 from it with no interview data in the body.
 *
 * Responds `{ interviews }`. An application with no interview arranged yet is an
 * empty list, not a 404 -- the same rule the tasks and employments lists follow.
 */
const listInterviewsForApplication = async (req, res) => {
    const { applicationId } = req.params;

    try {
        const interviews = await interviewService.listInterviewsForApplication(applicationId);

        res.status(200).json({ interviews });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching interviews for application:',
            message: 'Failed to fetch interviews',
        });
    }
};

module.exports = {
    createInterview,
    updateInterview,
    listInterviewsForJob,
    listInterviewsForApplication,
};