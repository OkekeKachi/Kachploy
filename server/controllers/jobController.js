// jobController.js
//
// HTTP layer for the jobs resource. Each export is an Express handler
// (req, res) that now does only three things: read the request, call exactly
// one jobService function, and translate the outcome into the status code and
// body this API has always returned.
//
// Stage 3A moved the data and business layer into services/jobService.js. There
// is still no repository, so the service talks to Firestore directly, and there
// is still no jobService for any other resource.
//
// Behaviour is deliberately unchanged. Every status code, response body, error
// message and console call below is the one the previous inline handler sent, so
// test/jobs.test.js continues to describe the live API:
//
//   * 201 on create, 400 with the endpoint's own wording for a missing field,
//     404 'Job not found', 500 with a per-endpoint message
//   * `updatedFields` still lists the exact keys the service wrote
//   * the duplicate `GET /:jobId` registration is still registered, so
//     getJobWithDefaults remains unreachable-but-present
//   * updateJobStatus returns 404 for a missing job (the requireJobOwner guard
//     loads it first) and, since Stage 5G, 400 for a status outside the
//     allow-list. It still logs nothing on failure

const jobService = require('../services/jobService');

/**
 * Maps a service failure onto the HTTP response for that endpoint.
 *
 * Validation and not-found failures are turned into 400/404 using the message
 * the service threw, and deliberately skip the console.error: previously those
 * paths returned before the catch block, so they never logged. Anything else is
 * an unexpected Firestore failure and keeps its per-endpoint 500 message.
 *
 * `log` is omitted where the original handler logged nothing (updateJobStatus).
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof jobService.JobValidationError) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof jobService.JobNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * GET /jobs
 * Returns every job with its document id merged in. Unfiltered.
 */
const listJobs = async (req, res) => {
    try {
        const jobs = await jobService.listJobs();
        res.status(200).json({ jobs });
    } catch (err) {
        sendFailure(res, err, {
            log: 'Error fetching jobs:',
            message: 'Failed to fetch jobs',
        });
    }
};

/**
 * POST /jobs/create
 * The author is always the authenticated user; a postedBy in the body is
 * ignored so a job cannot be posted on someone else's behalf.
 */
const createJob = async (req, res) => {
    const postedBy = req.user.uid;

    try {
        const { jobId } = await jobService.createJob(req.body, postedBy);

        res.status(201).json({
            message: 'Job posted successfully',
            jobId
        });
    } catch (err) {
        sendFailure(res, err, {
            log: 'Error posting job:',
            message: 'Internal server error',
        });
    }
};

/**
 * GET /jobs/employer/:uid
 * Guarded by requireSelfParam('uid') in the router, so :uid is always the
 * caller.
 */
const listEmployerJobs = async (req, res) => {
    const { uid } = req.params;

    try {
        const jobs = await jobService.listEmployerJobs(uid);

        res.status(200).json({ jobs });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching employer jobs:',
            message: 'Failed to fetch jobs',
        });
    }
};

/**
 * GET /jobs/:jobId
 *
 * The LIVE handler. Returns the document raw: no `id`, and no defaults for
 * skillsRequired/requirements/responsibilities. JobDetails.jsx calls .map() on
 * all three, so a job document predating those fields crashes that page.
 */
const getJob = async (req, res) => {
    const { jobId } = req.params;

    try {
        const job = await jobService.getJob(jobId);
        res.status(200).json({ job });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching job:',
            message: 'Failed to fetch job',
        });
    }
};

/**
 * GET /jobs/:jobId (second registration)
 *
 * UNREACHABLE DEAD CODE, preserved as-is. The router registers this path twice
 * and Express matches in registration order, so getJob above always wins and
 * this handler never runs. It is the variant that would have returned `id` and
 * defaulted the three arrays -- i.e. the shape JobDetails.jsx actually expects.
 *
 * Removal is scheduled for Stage 7. Until then it stays registered so the
 * duplicate remains visible and covered by test/jobs.test.js.
 */
const getJobWithDefaults = async (req, res) => {
    const { jobId } = req.params;

    try {
        const job = await jobService.getJobWithDefaults(jobId);

        res.status(200).json({ job });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching job:',
            message: 'Failed to fetch job',
        });
    }
};

/**
 * PUT /jobs/edit/:jobId
 * Guarded by requireJobOwner in the router. Note the field validation is looser
 * than createJob's: it uses `price === undefined`, so a price of 0 is accepted,
 * whereas createJob rejects it via a truthiness check.
 */
const updateJob = async (req, res) => {
    const { jobId } = req.params;

    try {
        const { updatedFields } = await jobService.updateJob(jobId, req.body);

        res.status(200).json({
            message: 'Job updated successfully',
            updatedFields,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error updating job:',
            message: 'Failed to update job',
        });
    }
};

/**
 * DELETE /jobs/:jobId
 * Guarded by requireJobOwner in the router.
 */
const deleteJob = async (req, res) => {
    const { jobId } = req.params;

    try {
        await jobService.deleteJob(jobId);

        return res.status(200).json({ message: 'Job deleted successfully' });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error deleting job:',
            message: 'Failed to delete job',
        });
    }
};

/**
 * PUT /jobs/:jobId/status
 * Guarded by requireJobOwner in the router, which is what turns a missing job
 * into a 404 -- the handler itself has no existence check. `status` is neither
 * required nor validated, so an absent value overwrites the field with
 * undefined. This is also the only handler that never logged its failures.
 */
const updateJobStatus = async (req, res) => {
    const { jobId } = req.params;
    const { status } = req.body;

    try {
        await jobService.updateJobStatus(jobId, status);
        res.status(200).json({ message: 'Job status updated' });
    } catch (err) {
        sendFailure(res, err, {
            message: 'Failed to update job status',
        });
    }
};

module.exports = {
    listJobs,
    createJob,
    listEmployerJobs,
    getJob,
    getJobWithDefaults,
    updateJob,
    deleteJob,
    updateJobStatus,
};
