// employmentController.js
//
// HTTP layer for the employments resource (new in Stage 7A). Four Express
// handlers, each doing only the three things every controller in this codebase
// does: read the request, call exactly one employmentService function, and
// translate the outcome into a status code and body. STAGE 10H.1 added the two
// employer-management reads -- one job's employments and one employment by id --
// alongside the two self-scoped reads Stage 7A introduced.
//
// There is no create handler, and that is the design rather than an omission. An
// employment exists only as the consequence of a hire, and the hire is performed
// by PUT /applications/:id/status; this resource has no POST of its own, so a
// client cannot manufacture one. See services/employmentService.js for why.
//
// Both handlers respond `{ employments }`, mirroring `{ tasks }` on
// GET /tasks/employee/:uid and `{ applications }` on
// GET /applications/employee/:uid, and both are failures-only counterparts of
// those endpoints. The success body is new, so it is defined here rather than
// inherited.

const employmentService = require('../services/employmentService');
const releaseEligibilityService = require('../services/releaseEligibilityService');

/**
 * Maps a service failure onto the HTTP response.
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof employmentService.EmploymentValidationError) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof employmentService.EmploymentNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (err instanceof employmentService.EmploymentStateError) {
        return res.status(409).json({ message: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * GET /employments/employee/:uid
 *
 * The employee's own employments. Guarded by requireSelfParam('uid') in the
 * router, which compares the path parameter against the verified token and
 * answers 403 on a mismatch, so no second user can read this list -- the
 * authorization lives in the router, exactly as it does for the applications and
 * tasks reads, and this handler makes no request-scoped decision of its own.
 */
const listEmploymentsForEmployee = async (req, res) => {
    const { uid } = req.params;

    try {
        const employments = await employmentService.listEmploymentsForEmployee(uid);

        res.status(200).json({ employments });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching employments:',
            message: 'Failed to fetch employments',
        });
    }
};

/**
 * GET /employments/employer/:uid
 *
 * The employer's own employments, guarded by requireSelfParam('uid') on the same
 * terms as the employee read: a 403 for any uid that is not the caller, with no
 * employment data in the body.
 *
 * Note that the guard is about identity, not role. A caller may read this path
 * for their own uid whether or not they have ever hired anyone, and gets an empty
 * list -- the same behaviour as GET /jobs/employer/:uid. Nothing checks
 * `users.role`, so no role assumption is introduced here.
 */
const listEmploymentsForEmployer = async (req, res) => {
    const { uid } = req.params;

    try {
        const employments = await employmentService.listEmploymentsForEmployer(uid);

        res.status(200).json({ employments });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching employments for employer:',
            message: 'Failed to fetch employments',
        });
    }
};

/**
 * STAGE 10H.1. GET /employments/job/:jobId
 *
 * Every employment recorded on one job, for the employer who owns it. Guarded by
 * requireJobOwner in the router, which has already loaded the job and confirmed
 * `job.postedBy === req.user.uid`; a missing job is that guard's 404, and a
 * non-owner is its 403, so this handler performs no authorization of its own.
 *
 * Responds `{ employments }`, the same shape as the two existing reads, with an
 * empty array rather than a 404 when the job has hired nobody.
 */
const listEmploymentsForJob = async (req, res) => {
    const { jobId } = req.params;

    try {
        const employments = await employmentService.listEmploymentsForJob(jobId);

        res.status(200).json({ employments });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching employments for job:',
            message: 'Failed to fetch employments',
        });
    }
};

/**
 * STAGE 10H.1. GET /employments/:employmentId
 *
 * One employment, for a caller who is one of its two parties. Guarded by
 * requireEmploymentParty in the router, which has already loaded the employment
 * and refused a missing one with a 404 and a stranger with a 403, so this handler
 * performs no authorization of its own.
 *
 * Responds `{ employment: { id, ...document } }`, the single-employment
 * counterpart of the list reads.
 */
const getEmployment = async (req, res) => {
    const { employmentId } = req.params;

    try {
        const employment = await employmentService.getEmployment(employmentId);

        res.status(200).json({ employment });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching employment:',
            message: 'Failed to fetch employment',
        });
    }
};

/**
 * POST /employments/:employmentId/complete
 */
const completeEmployment = async (req, res) => {
    const { employmentId } = req.params;
    const callerId = req.user && req.user.uid;
    const { reason, note, metadata } = req.body || {};

    try {
        const employment = await employmentService.completeEmployment({
            employmentId,
            callerId,
            reason,
            note,
            metadata,
        });

        res.status(200).json({ employment });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error completing employment:',
            message: 'Failed to complete employment',
        });
    }
};

/**
 * POST /employments/:employmentId/terminate
 */
const terminateEmployment = async (req, res) => {
    const { employmentId } = req.params;
    const callerId = req.user && req.user.uid;
    const { reason, note, metadata } = req.body || {};

    try {
        const employment = await employmentService.terminateEmployment({
            employmentId,
            callerId,
            reason,
            note,
            metadata,
        });

        res.status(200).json({ employment });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error terminating employment:',
            message: 'Failed to terminate employment',
        });
    }
};

/**
 * POST /employments/:employmentId/settlement
 */
const recordEmploymentSettlement = async (req, res) => {
    const { employmentId } = req.params;
    const callerId = req.user && req.user.uid;
    const { settlement } = req.body || {};

    try {
        const employment = await employmentService.recordEmploymentSettlement({
            employmentId,
            callerId,
            settlement,
        });

        res.status(200).json({ employment });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error recording employment settlement:',
            message: 'Failed to record employment settlement',
        });
    }
};

/**
 * GET /employments/:employmentId/release-eligibility
 *
 * STAGE 1. A derived, read-only answer. requireEmploymentParty has already
 * confirmed the caller is one of the employment's two parties; the service reads
 * tasks, milestones, payments and disputes and writes nothing.
 */
const getReleaseEligibility = async (req, res) => {
    const { employmentId } = req.params;

    try {
        const eligibility = await releaseEligibilityService.getReleaseEligibility(employmentId);
        res.status(200).json(eligibility);
    } catch (error) {
        console.error('Error computing release eligibility:', error);
        res.status(500).json({ message: 'Failed to compute release eligibility' });
    }
};

module.exports = {
    listEmploymentsForEmployee,
    listEmploymentsForEmployer,
    listEmploymentsForJob,
    getEmployment,
    getReleaseEligibility,
    completeEmployment,
    terminateEmployment,
    recordEmploymentSettlement,
};