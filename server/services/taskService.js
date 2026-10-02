// taskService.js
//
// Business and data layer for the tasks resource (new in Stage 3C). It owns
// the required-field validation and the task payload construction that used to
// live inline in controllers/taskController.js.
//
// Stage 3C is a structural extraction only. The controller is now HTTP-focused:
// it reads the request, calls exactly one service function, and translates the
// outcome into the status code and body this API has always returned. Nothing
// observable changes, so the quirks below are preserved deliberately and stay
// pinned by test/tasks.test.js:
//
//   * `createdDate` used to be a raw Date read off the process clock, unlike the
//     serverTimestamp() users write. Stage 5H moved it onto serverTimestamp(), so
//     this quirk is gone; jobs still store ISO strings, which is tracked separately
//   * the endpoint is a create-only resource: there is no read, update or
//     delete for tasks anywhere in the API
//   * `employeeId` is taken from the request body rather than the token
//
// Stage 4C moved the one Firestore write out to repositories/taskRepository.js.
// The document shape, the timestamp and the `{ taskId }` return value all stay
// here, so the service still decides what is stored and what the caller sees.
//
// No shared error system is introduced: the single error class below exists only
// so the controller can reproduce the existing 400 body.

const { admin } = require('../config/firebase');
const taskRepository = require('../repositories/taskRepository');

/**
 * A required field is missing. Surfaces as a 400 carrying this exact message,
 * which is why the wording lives on the throw site -- the service has no other
 * validation message, and the 400 text is asserted by the tests.
 */
class TaskValidationError extends Error {}

/**
 * Creates a task and returns its generated document id.
 *
 * POST /tasks -- the endpoint the client actually calls; ViewJobApplications.jsx
 * posts here.
 *
 * QUIRK (preserved): `employeeId` comes from the request payload, not from the
 * verified token. The router's requireTaskAssignment guard is what authorises
 * it -- it checks the caller may assign that employee to that job -- so
 * switching this to req.user.uid would change which assignments are accepted
 * for multi-employee jobs. Left exactly as it is.
 *
 * DEAD-CODE NOTE: the router also exposes POST /applications/tasks, whose logic
 * now lives in applicationService.createTaskFromApplication. The two are NOT
 * interchangeable -- this one returns `taskId`, that one does not -- so they are
 * not merged. Unifying them is scheduled for Stage 7.
 */
const createTask = async (payload) => {
    const { jobId, employeeId, taskName, taskDescription, dueDate } = payload;

    if (!jobId || !employeeId || !taskName || !taskDescription || !dueDate) {
        throw new TaskValidationError('Missing required fields');
    }

    // Create a new task in the 'tasks' collection
    const taskId = await taskRepository.addTask({
        jobId,
        employeeId,
        taskName,
        taskDescription,
        dueDate,
        // STAGE 5H: was `new Date()`. Firestore converts a Date to a Timestamp on
        // write, so the stored type was already a Timestamp and the field name
        // and API shape are unchanged -- what changed is whose clock decides. The
        // value is now committed by Firestore instead of being read off the Node
        // process clock, matching users.createdAt / applications.dateApplied.
        createdDate: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { taskId };
};

/**
 * Every task assigned to one employee, as plain objects.
 *
 * STAGE 6B. Added because a task had no read path at all: it could be written but
 * never read back by anyone, so the assignee could not see their own work.
 *
 * AUTHORIZATION: this function trusts its caller completely -- it performs no
 * ownership check. `uid` reaches it from the verified token via the existing
 * requireSelfParam('uid') guard in routes/tasks.js, which rejects any path
 * parameter that is not req.user.uid. That is the same arrangement
 * listApplicationsForEmployee already uses, and it is why no new guard is needed.
 *
 * The document is returned as `{ id, ...data }`, matching listApplicationsForJob:
 * no field is renamed, dropped or reshaped, so the task a UI reads back is byte
 * for byte the document that was stored. There is deliberately no per-task
 * employer/employee join here; the future UI can use jobId and employeeId, and
 * adding a read of another collection would change nothing about this contract.
 *
 * An unknown uid returns an empty array rather than a 404: this is a list of the
 * caller's own tasks, and "you have none" is not a missing resource.
 */
const listTasksForEmployee = async (uid) => {
    const snapshot = await taskRepository.listTasksByEmployee(uid);

    const tasks = [];
    snapshot.forEach((doc) => {
        tasks.push({ id: doc.id, ...doc.data() });
    });

    return tasks;
};

/**
 * Every task belonging to one job, as plain objects.
 *
 * STAGE 6B. The employer-side counterpart of listTasksForEmployee, and the reason
 * an employer can see the work they assigned.
 *
 * AUTHORIZATION: as above, this trusts its caller. `requireJobOwner` in
 * routes/tasks.js has already loaded the job and confirmed job.postedBy ===
 * req.user.uid, so a non-owner never reaches this function -- it is turned away
 * with a 403, or a 404 if the job does not exist, before the query runs.
 *
 * Same `{ id, ...data }` shape and the same "empty list, not 404" rule as
 * listTasksForEmployee: a job that exists but has no tasks yet returns [].
 */
const listTasksForJob = async (jobId) => {
    const snapshot = await taskRepository.listTasksByJob(jobId);

    const tasks = [];
    snapshot.forEach((doc) => {
        tasks.push({ id: doc.id, ...doc.data() });
    });

    return tasks;
};

module.exports = {
    TaskValidationError,
    createTask,
    listTasksForEmployee,
    listTasksForJob,
};
