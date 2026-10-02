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
//   - 200 still returns { message, taskId }; the duplicate endpoint at
//     POST /applications/tasks still returns { message } with no taskId
//   - `employeeId` is still read from the request body, not from req.user
//   - createdDate is still stored as a raw Date by the service
//   - a missing field is still a 400 that logs nothing

const taskService = require('../services/taskService');

/**
 * Maps a service failure onto the existing HTTP response.
 *
 * A validation failure is turned into a 400 and deliberately skips the
 * console.error: the missing-field check used to be an early `return` from
 * before the try block, so that path never logged.
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof taskService.TaskValidationError) {
        return res.status(400).json({ message: err.message });
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
 * posts here. It shares the requireTaskAssignment guard with the duplicate at
 * POST /applications/tasks (applicationService.createTaskFromApplication), but
 * the two are NOT interchangeable:
 *
 *   this handler           uses .add() -> 200 { message, taskId }
 *   applications duplicate uses .add() -> 200 { message }  (no taskId)
 *
 * Merging them would change one of the two response shapes, so both are kept
 * until Stage 7 decides which survives.
 *
 * All five body fields are required, and `employeeId` is taken from the body
 * rather than the token -- requireTaskAssignment is what authorises it.
 */
const createTask = async (req, res) => {
    try {
        const { taskId } = await taskService.createTask(req.body);

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

module.exports = {
    createTask,
    listTasksForEmployee,
    listTasksForJob,
};
