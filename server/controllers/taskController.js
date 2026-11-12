// taskController.js
//
// HTTP layer for the tasks resource. A single Express handler that now does
// only three things: read the request, call exactly one taskService function,
// and translate the outcome into the status code and body this API has always
// returned.
//
// Stage 3C moved the data and business layer into services/taskService.js.
// There is still no repository and no shared error system.
//
// Behaviour is deliberately unchanged, including the awkward parts:
//
//   - 200 still returns { message, taskId }
//   - `employeeId` is still read from the request body, not from req.user
//   - createdDate is still stored as a raw Date by the service
//   - a missing field is still a 400 that logs nothing
//
// STAGE 9F removes the last duplicate: this handler was one of two for task
// creation, the other being POST /applications/tasks in applicationController.js,
// which returned { message } with no taskId and had no caller. createTask here is
// the only standalone task-creation handler in the API.
//
// STAGE 9C adds four handlers -- one read and the three lifecycle actions -- on the
// same three-step contract. Each takes its subject from req.params, calls one
// taskService function, and maps the outcome through the same sendFailure. No
// authorization happens here: requireTaskParty has already run, and each handler
// reads the task it needs from the `req.task` the guard attached rather than
// loading anything itself.
//
// STAGE 10G.1 adds one more handler, signTaskUpload, on the same contract: it reads
// req.task (attached by the guard, as every handler here does), calls one taskService
// function, and translates the result. Its one departure is a 503 for an
// unconfigured Cloudinary, which sendFailure has no class for -- see the handler.

// STAGE 10G.1: the error class config/cloudinary raises when the three environment
// variables are absent. Required here rather than caught generically so the 503 below
// is produced by the same rule that produced the error, and so an unexpected failure
// still falls through to the 500 it has always been.
const { CloudinaryConfigurationError } = require('../config/cloudinary');
const taskService = require('../services/taskService');

/**
 * Maps a service failure onto the existing HTTP response.
 *
 * A validation failure is turned into a 400 and deliberately skips the
 * console.error: the missing-field check used to be an early `return` from
 * before the try block, so that path never logged.
 *
 * STAGE 9C adds two classes, each with its own code, so the handlers below stay a
 * translation layer: TaskNotFoundError is a 404 carrying its own message, and
 * TaskTransitionError is a 400 -- the same code an illegal application status
 * change already returns. Neither logs, because neither is a server fault. Anything
 * else is still an unexpected failure and still a 500.
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof taskService.TaskValidationError) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof taskService.TaskNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (err instanceof taskService.TaskTransitionError) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof taskService.TaskDeadlineError) {
        return res.status(409).json({ message: err.message });
    }

    if (err instanceof taskService.TaskReviewConflictError) {
        return res.status(409).json({ message: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * POST /tasks
 *
 * This is the endpoint the client actually calls -- ViewJobApplications.jsx
 * posts here, through the TaskCreateForm the employer uses to assign work.
 *
 * STAGE 9F: it is now the ONLY standalone task-creation endpoint. The duplicate at
 * POST /applications/tasks, whose handler was applicationController's
 * createTaskFromApplication, is deleted along with that handler. Nothing else about
 * this one changed: `employeeId` is still taken from the body rather than the token,
 * and requireTaskAssignment is still what authorises it.
 *
 * STAGE 10G makes a sixth body field required -- `submissionType` -- and the handler
 * itself does not look at it: createTask reads it, checks it against the three names
 * taskService accepts, and stores it. The controller's job is unchanged, which is the
 * point of the three-step contract this file documents.
 */
const createTask = async (req, res) => {
    try {
        // STAGE 9B: req.taskAssignment is the applicationId/employmentId pair
          // requireTaskAssignment resolved from the accepted application. Passing it
          // through keeps the controller HTTP-only and the guard's decision the
          // single source of it.
          const { taskId } = await taskService.createTask(req.body, req.taskAssignment);

        // Return the created task's ID
        res.status(200).json({ message: 'Task created successfully', taskId });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating task:',
            message: 'Failed to create task',
        });
    }
};

/**
 * GET /tasks/employee/:uid
 *
 * STAGE 6B. Added because tasks were write-only: the assignee could never see the
 * work assigned to them.
 *
 * Guarded by the existing requireSelfParam('uid') in the router, which compares
 * the path parameter against the verified token and answers 403 on a mismatch.
 * No new authorization middleware is introduced, and the uid is not taken from a
 * query string.
 *
 * Responds `{ tasks }`, mirroring `{ applications }` on the equivalent endpoint.
 */
const listTasksForEmployee = async (req, res) => {
    const { uid } = req.params;

    try {
        const tasks = await taskService.listTasksForEmployee(uid);

        res.status(200).json({ tasks });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching tasks:',
            message: 'Failed to fetch tasks',
        });
    }
};

/**
 * GET /tasks/job/:jobId
 *
 * STAGE 6B. The employer-side view of the work they assigned. Guarded by the
 * existing requireJobOwner, which has already resolved the job -- so a missing
 * job is a 404 from that guard, not from here, and this handler only ever runs
 * for the job's owner.
 *
 * Responds `{ tasks }`.
 */
const listTasksForJob = async (req, res) => {
    const { jobId } = req.params;

    try {
        const tasks = await taskService.listTasksForJob(jobId);

        res.status(200).json({ tasks });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching tasks for job:',
            message: 'Failed to fetch tasks',
        });
    }
};

/**
 * GET /tasks/:taskId
 *
 * STAGE 9C. The single-task read the lifecycle needs, and the one route in this
 * file that is not a list or a create.
 *
 * The response is the whole stored document, `{ task: { id, ...document } }`, on the
 * same terms as the two list endpoints: no field renamed, dropped or reshaped, and
 * the derived `status` applied for a document written before Stage 9B. Returning the
 * whole document rather than a summary is deliberate -- this task's submitted work
 * (`submissionText`, `submissionUrl` or `submissionFile`), `revisionNote` and
 * timestamps are the review, and a projection here would be a second shape to keep in
 * step with the stored one.
 *
 * requireTaskParty has already established that the caller is one of the two parties
 * and that the task exists, so this handler performs no authorization of its own and
 * its 404 arm is unreachable through the router.
 */
const getTask = async (req, res) => {
    const { taskId } = req.params;

    try {
        const task = await taskService.getTask(taskId);

        res.status(200).json({ task });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching task:',
            message: 'Failed to fetch task',
        });
    }
};

/**
 * POST /tasks/:taskId/upload-signature
 *
 * STAGE 10G.1. The first half of a `file` submission: a signed payload the browser
 * can use to upload one file directly to Cloudinary, and nothing else.
 *
 * The flow this endpoint exists inside is sign -> upload -> submit. Only the first
 * step is new; the third is still POST /:taskId/submit above, unchanged, and the file
 * travels browser -> Cloudinary without touching this API at any point.
 *
 * NO AUTHORIZATION HERE. requireTaskParty({ mutation: true, role: 'employee' }) has
 * already loaded the task from req.params, confirmed the caller is its employee
 * party, and refused an ended employment -- the same three decisions, in the same
 * order and with the same 403 bodies, that gate the submit endpoint itself. That is
 * deliberate: a caller who cannot submit the task must not be able to obtain a
 * signature for it, and the cheapest way to guarantee the two never disagree is for
 * them to share one guard rather than for this handler to restate a rule.
 *
 * The task is passed to the service rather than a folder name, so the folder signed
 * is derived from the task the guard loaded and never from the request.
 *
 * Responds 200 with `{ cloudName, apiKey, timestamp, signature, folder, publicId,
 * resourceType }` -- exactly what the browser needs to make the upload, and no more.
 * The api secret is used to sign inside config/cloudinary and is not part of this
 * body.
 *
 * 503 when Cloudinary is not configured. This is the one task endpoint that can fail
 * for a reason that is not the caller's fault and not a bug: the three environment
 * variables may simply be absent on a fresh deployment, which leaves text and link
 * submissions fully working and only file signing unavailable. 503 says that --
 * "not configured, try again once it is" -- where a 500 would say the server broke,
 * and a 400 would blame the request for the server's own configuration. The message
 * names no variable value and no credential.
 */
const signTaskUpload = async (req, res) => {
    try {
        res.status(200).json(taskService.signTaskSubmissionUpload(req.task));
    } catch (error) {
        if (error instanceof CloudinaryConfigurationError) {
            return res.status(503).json({ message: 'File uploads are not configured on this server' });
        }

        console.error('Error signing task upload:', error);
        return res.status(500).json({ message: 'Failed to sign upload request' });
    }
};

/**
 * POST /tasks/:taskId/submit
 *
 * STAGE 9C. The employee's half of the lifecycle: `assigned` (and
 * `revision_requested`) -> `submitted`.
 *
 * Responds `{ message: 'Task submitted successfully', taskId, status }`. `status` is
 * returned because after this call the client cannot get the new one any other way:
 * the list endpoints have no single-task read for an employee to poll, and the
 * pre-Stage-9B documents mean a client cannot infer the result from what it sent.
 *
 * There is no body echo and no task document here, matching the create handler's
 * `{ message, taskId }` rather than inventing a second success shape.
 *
 * STAGE 10G: the body is still opaque here. Which of `submissionText`,
 * `submissionUrl` or `submissionFile` this endpoint requires, and whether what was
 * sent matches the task at all, is decided in taskService from the task's stored
 * `submissionType` -- not from anything in this request. A refused submission is still
 * a 400 through the same sendFailure, so a mismatched payload and an empty one are
 * reported by the same path.
 */
const submitTask = async (req, res) => {
    const { taskId } = req.params;

    try {
        const result = await taskService.submitTask(taskId, req.body, req.user);

        res.status(200).json({ message: 'Task submitted successfully', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error submitting task:',
            message: 'Failed to submit task',
        });
    }
};

/**
 * POST /tasks/:taskId/approve
 *
 * STAGE 9C. The employer's other half: `submitted` -> `approved`, terminal.
 *
 * Takes no body. Responds `{ message: 'Task approved successfully', taskId, status }`.
 */
const approveTask = async (req, res) => {
    const { taskId } = req.params;

    try {
        const result = await taskService.approveTask(taskId, req.user);

        res.status(200).json({ message: 'Task approved successfully', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error approving task:',
            message: 'Failed to approve task',
        });
    }
};

/**
 * POST /tasks/:taskId/request-revision
 *
 * STAGE 9C. `submitted` -> `revision_requested`, with the employer's note.
 *
 * The route segment is `request-revision` while the action is `request_revision` and
 * the stored status is `revision_requested`. The kebab form is what a URL segment can
 * be; the underscore forms are the ones the transition table and the document use.
 *
 * Responds `{ message: 'Revision requested successfully', taskId, status }`.
 */
const requestTaskRevision = async (req, res) => {
    const { taskId } = req.params;

    try {
        const result = await taskService.requestTaskRevision(taskId, req.body, req.user);

        res.status(200).json({ message: 'Revision requested successfully', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error requesting task revision:',
            message: 'Failed to request task revision',
        });
    }
};

/**
 * POST /tasks/:taskId/admin-review-request
 *
 * STAGE 1. The employee escalates a submitted task after the seven-day employer
 * window. requireTaskParty({ mutation: true, role: 'employee' }) has already
 * established the caller is the employee party; the service checks the deadline
 * against the task's own stored timestamp.
 *
 * 409 when the window has not elapsed or this submission was already escalated.
 */
const requestAdminReview = async (req, res) => {
    const { taskId } = req.params;

    try {
        const result = await taskService.requestAdminReview(taskId, req.body, req.user);
        res.status(200).json({ message: 'Admin review requested successfully', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error requesting admin review:',
            message: 'Failed to request admin review',
        });
    }
};

/**
 * POST /tasks/:taskId/admin-review-response
 *
 * STAGE 1. The employee's answer to an admin `request_info`. It records the
 * response without changing the status, so the case stays open and eligible for
 * another admin decision.
 */
const respondToAdminReview = async (req, res) => {
    const { taskId } = req.params;

    try {
        const result = await taskService.respondToAdminReview(taskId, req.body, req.user);
        res.status(200).json({ message: 'Response recorded', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error recording admin-review response:',
            message: 'Failed to record response',
        });
    }
};

/** GET /tasks/:taskId/history -- append-only review events plus admin decisions. */
const getTaskHistory = async (req, res) => {
    const { taskId } = req.params;

    try {
        const history = await taskService.listTaskHistory(taskId);
        res.status(200).json({ taskId, ...history });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching task history:',
            message: 'Failed to fetch task history',
        });
    }
};

module.exports = {
    createTask,
    getTask,
    getTaskHistory,
    signTaskUpload,
    submitTask,
    approveTask,
    requestTaskRevision,
    requestAdminReview,
    respondToAdminReview,
    listTasksForEmployee,
    listTasksForJob,
};
