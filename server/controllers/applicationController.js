// applicationController.js
//
// HTTP layer for the applications resource. Each export is an Express handler
// (req, res) that now does only three things: take identity and input from the
// request, call exactly one applicationService function, and translate the
// outcome into the status code and body this API has always returned.
//
// Stage 3B moved the data and business layer into services/applicationService.js.
// There is still no repository and no shared error system.
//
// Behaviour is deliberately unchanged, including the awkward parts:
//
//   - GET /job/:jobId still fails with `{ error }` while every sibling fails
//     with `{ message }`
//   - PUT /:id/status still returns two keys on failure (`message` plus the raw
//     `error: err.message`) and still logs with console.log, not console.error
//   - the NaN `proposals` value and the non-atomic withdrawal were closed in
//     Stage 5E: the field is no longer written and the withdrawal is a single
//     delete, so the response codes and error shapes here are unchanged
//   - the dead `isNegotiable` branches are NOT in that list: Stage 5D fixed the
//     field name and both now run
//   - `createTaskFromApplication` still duplicates POST /tasks with no taskId
//     in its response, and still reads `employeeId` from the body
//
// Stage 5B added the countApplicationsByJob handler and closed the Stage 5A
// IDOR-01 finding on listApplicationsForJob, whose guard moved into the router.
// Neither change alters a response shape.
//
// STAGE 7A: updateApplicationStatus now passes a hire context built from
// req.user and the guard-loaded application/job, which is where a hire records
// its employment. Every request, response, status code and error body on this
// router is unchanged, and no other handler was touched.

const applicationService = require('../services/applicationService');

/**
 * Maps a service failure onto the existing HTTP response.
 *
 * `errorKey` exists for GET /job/:jobId, which is the one endpoint in this file
 * whose failure body is `{ error }` instead of `{ message }`.
 *
 * Validation and not-found failures skip the console.error: those paths
 * previously returned before the catch block, so they never logged.
 */
const sendFailure = (res, err, { log, message, errorKey = 'message' }) => {
    if (err instanceof applicationService.ApplicationValidationError) {
        return res.status(400).json({ [errorKey]: err.message });
    }

    if (err instanceof applicationService.ApplicationNotFoundError) {
        return res.status(404).json({ [errorKey]: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ [errorKey]: message });
};

/**
 * POST /applications/apply
 *
 * The applicant is always the authenticated user; an employeeId in the body is
 * ignored so nobody can apply on someone else's behalf.
 */
const applyToJob = async (req, res) => {
    const employeeId = req.user.uid;

    try {
        await applicationService.applyToJob(req.body, employeeId);

        res.status(200).json({ message: 'Application submitted successfully' });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error applying for job:',
            message: 'Failed to apply',
        });
    }
};

/**
 * GET /applications/employee/:uid
 * Guarded by requireSelfParam('uid') in the router, so :uid is always the
 * caller.
 */
const listApplicationsForEmployee = async (req, res) => {
    const { uid } = req.params;

    try {
        const applications = await applicationService.listApplicationsForEmployee(uid);

        res.status(200).json({ applications });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching applications:',
            message: 'Failed to fetch applications',
        });
    }
};

/**
 * GET /applications/counts
 *
 * Added in Stage 5B. Returns only `{ counts: { jobId: number } }` -- no
 * application document, no applicant field. This is what replaced the three
 * dashboards' per-job calls to GET /applications/job/:jobId, which fetched the
 * entire applicant roster of every job purely to read `.length` (the Stage 5A
 * N1-02 / IDOR-01 pair).
 *
 * The route is authenticated and accepts no employer or job identifier from the
 * client, so there is no request-scoped authorization decision for this handler
 * to make: it aggregates whatever the collection holds and exposes nothing
 * identifying. The failure body keeps this resource's `{ error }` shape, matching
 * its sibling GET /job/:jobId.
 */
const countApplicationsByJob = async (req, res) => {
    try {
        const counts = await applicationService.countApplicationsByJob();

        res.status(200).json({ counts });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error counting applications:',
            message: 'Failed to count applications',
            errorKey: 'error',
        });
    }
};

/**
 * GET /applications/job/:jobId
 *
 * Guarded by requireJobOwner since Stage 5B, so only the employer who posted the
 * job can read its applicants. This is the Stage 5A IDOR-01 fix: the endpoint was
 * previously `protect`-only, which let any authenticated user read every
 * applicant's identity for any job.
 *
 * ViewJobApplications.jsx is the one legitimate consumer and it is the job owner
 * by construction, so its behaviour is unchanged. The response shape is
 * unchanged too, including the `{ error }` failure body that differs from every
 * sibling's `{ message }`.
 */
const listApplicationsForJob = async (req, res) => {
    const { jobId } = req.params;

    try {
        const applications = await applicationService.listApplicationsForJob(jobId);

        res.status(200).json({ applications });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching applications for job:',
            message: 'Failed to fetch applications',
            errorKey: 'error',
        });
    }
};

/**
 * PUT /applications/:id/status
 * Guarded by requireApplicationReviewer in the router, which is what turns a
 * missing application into a 404 before this handler runs.
 *
 * The catch below still echoes err.message to the client as a second key and
 * still logs with console.log rather than console.error. Both are preserved
 * verbatim; normalising them is a Stage 6 candidate.
 *
 * STAGE 7A: this is where the hire flow's employment is assembled. The third
 * argument is the hire context, and every field in it is taken from the verified
 * token or from the two documents requireApplicationReviewer has already loaded
 * onto the request -- never from the body:
 *
 *   employerId     req.user.uid          the reviewer; the guard has already
 *                                        established job.postedBy === uid
 *   employeeId     req.application.employeeId
 *   jobId          req.application.jobId
 *   jobStartDate   req.job.jobStartDate  the job's own start date, which
 *                                        employmentService uses for startDate
 *                                        and falls back to a serverTimestamp
 *                                        when the job has none
 *   previousStatus req.application.status as it stood before this write, which
 *                                        is what stops a repeated `accepted`
 *                                        appending a second employment
 *
 * The response is unchanged: still 200 `{ message: 'Status updated successfully' }`
 * on the same conditions as before. No client field is added, so the body a
 * caller sends is still just `{ status }`, and the hire the client performs is
 * still the same three calls. See services/applicationService.js
 * updateApplicationStatus for the ordering and for why a failure to write the
 * employment is logged rather than returned.
 */
const updateApplicationStatus = async (req, res) => {
    const applicationId = req.params.id;
    const newStatus = req.body.status;

    try {
        await applicationService.updateApplicationStatus(applicationId, newStatus, {
            employerId: req.user.uid,
            employeeId: req.application.employeeId,
            jobId: req.application.jobId,
            jobStartDate: req.job.jobStartDate,
            previousStatus: req.application.status,
        });

        res.status(200).json({ message: 'Status updated successfully' });
    } catch (err) {
        // A missing `status` used to be an early `return` from inside the try
        // block, so it short-circuited this catch entirely: 400, and no log
        // line. The service reports it as a validation error instead, so it has
        // to be intercepted here before the generic failure path below.
        if (err instanceof applicationService.ApplicationValidationError) {
            return res.status(400).json({ message: err.message });
        }

        console.log("not working");
        res.status(500).json({ message: 'Failed to update status', error: err.message });
    }
};

/**
 * DELETE /applications/:applicationId
 * Guarded by requireApplicationOwner in the router.
 */
const withdrawApplication = async (req, res) => {
    const { applicationId } = req.params;

    try {
        await applicationService.withdrawApplication(applicationId);

        res.status(200).json({ message: 'Application withdrawn successfully' });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error withdrawing application:',
            message: 'Failed to withdraw application',
        });
    }
};

/**
 * POST /applications/tasks
 *
 * DEAD CODE: a duplicate of POST /tasks (routes/tasks.js), never called by the
 * client -- ViewJobApplications.jsx posts to /tasks. It survives Stage 1 only
 * because both paths now share the requireTaskAssignment guard. Removal is
 * scheduled for Stage 7.
 *
 * Not identical to the tasks.js handler: this uses .add() and returns no
 * taskId, so its response shape differs. `employeeId` still comes from the body,
 * which requireTaskAssignment authorises.
 */
const createTaskFromApplication = async (req, res) => {
    try {
        await applicationService.createTaskFromApplication(req.body);

        res.status(200).json({ message: 'Task created successfully' });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating task:',
            message: 'Failed to create task',
        });
    }
};

module.exports = {
    applyToJob,
    listApplicationsForEmployee,
    listApplicationsForJob,
    countApplicationsByJob,
    updateApplicationStatus,
    withdrawApplication,
    createTaskFromApplication,
};
