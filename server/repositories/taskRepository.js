// taskRepository.js
//
// Data-access layer for the `tasks` collection (new in Stage 4C). It owns the
// direct Firestore calls that used to sit inside taskService.js: the create
// performed by POST /tasks, and -- added in Stage 6B -- the two single-field
// queries behind the read endpoints.
//
// STAGE 6B. Before this stage the `tasks` collection had exactly one call site in
// the whole API and no read path at all, so a persisted task was unreachable
// after creation. These two queries are the minimum needed for the future task
// UI and they are deliberately read-only: there is still no update, completion
// or delete for a task, and none is added here.
//
// SCOPE: the `tasks` collection only, and only the call made by taskService. One
// other place still reaches `tasks` directly and is deliberately left alone,
// because Stage 4C excludes it:
//   * applicationService.createTaskFromApplication issues its own near-identical
//     add, for the duplicate POST /applications/tasks endpoint, and discards
//     the returned id
// So the `tasks` collection is not yet served exclusively by this file. The two
// writes are NOT interchangeable and must not be merged here: they are separate
// call sites with different return contracts, and unifying them would change a
// response shape. That duplicate is scheduled for Stage 7.
//
// This layer holds no business logic. It knows nothing about HTTP, status codes,
// controllers, Express, tokens or authorisation, and it raises no error of its
// own. Validation and the TaskValidationError class stay in taskService, as does
// the document shape itself: the payload built there, including the raw
// `new Date()` for createdDate, is passed in whole. The field type is task
// behaviour -- jobs store ISO strings, users use serverTimestamp() -- so the
// timestamp is not generated here.
//
// No transactions and no batches are used, because none were used before this
// extraction and adding any would change the write ordering and therefore the
// observable behaviour.

const { db } = require('../config/firebase');

/**
 * Creates a task document under a Firestore-generated id and returns that id.
 *
 * A plain `.add()`, preserved exactly: the caller owns the payload and receives
 * the generated id, which taskService wraps as `{ taskId }` for the controller.
 */
const addTask = async (data) => {
    const taskRef = await db.collection('tasks').add(data);
    return taskRef.id;
};

/**
 * Every task assigned to one employee.
 *
 * STAGE 6B. Single-field equality filter on `employeeId`, mirroring
 * applicationRepository.listApplicationsByEmployee -- so it needs no composite
 * index. The uid reaches the service from the verified token via the existing
 * requireSelfParam('uid') guard, never from an unverified query parameter.
 */
const listTasksByEmployee = (employeeId) =>
    db.collection('tasks').where('employeeId', '==', employeeId).get();

/**
 * Every task belonging to one job.
 *
 * STAGE 6B. Single-field equality filter on `jobId`, mirroring
 * applicationRepository.listApplicationsByJob. The job owner is established by
 * the existing requireJobOwner guard before the service runs.
 */
const listTasksByJob = (jobId) =>
    db.collection('tasks').where('jobId', '==', jobId).get();

module.exports = {
    addTask,
    listTasksByEmployee,
    listTasksByJob,
};
