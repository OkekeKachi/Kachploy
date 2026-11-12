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
// STAGE 9C adds `getTaskById` and `updateTaskFields`, the minimum for the task
// lifecycle: a guard has to resolve one task to decide who may act on it, and a
// transition has to write. Both are still single-document operations, so the
// no-composite-index property above is unchanged. Nothing else about the
// collection's access pattern moves.
//
// SCOPE: the `tasks` collection only, and only the calls made by taskService and
// applicationService's hire transaction.
// STAGE 9F: this file is now the only thing that writes `tasks`. The second caller
// that used to reach the collection directly -- applicationService's inline add for
// the duplicate POST /applications/tasks endpoint, which discarded the generated id
// -- is gone, so the caveat Stage 4C recorded about a second direct write no longer
// applies.
//
// STAGE 3E adds the two transaction-aware operations the hire needs to create one
// deterministic task per accepted milestone. They are still single-document
// operations and still contain no business logic: applicationService owns the
// ids, the document shape and the atomicity, while this file remains the only
// place that names `db.collection('tasks')`.
//
// This layer holds no business logic. It knows nothing about HTTP, status codes,
// controllers, Express, tokens or authorisation, and it raises no error of its
// own. Validation and the TaskValidationError class stay in taskService, as does
// the document shape itself: the payload built there, including the
// `serverTimestamp()` sentinel for createdDate, is passed in whole. The field type is task
// behaviour -- jobs store ISO strings, users use serverTimestamp() -- so the
// timestamp is not generated here.
//
// No transactions and no batches are used, because none were used before this
// extraction and adding any would change the write ordering and therefore the
// observable behaviour.

const { db } = require('../config/firebase');
const taskEventRepository = require('./taskEventRepository');

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

/**
 * Every task explicitly associated with one milestone.
 *
 * A single-field equality filter on `milestoneId`, so no composite index is
 * needed. Tasks written before the association existed simply do not match; the
 * legacy `milestone.taskId` link is resolved separately by paymentService.
 */
const listTasksByMilestoneId = (milestoneId) =>
    db.collection('tasks').where('milestoneId', '==', milestoneId).get();

/**
 * One task, by document id.
 *
 * STAGE 9C. Added for requireTaskParty, which must resolve a single task before it
 * can decide who may act on it, and for GET /tasks/:taskId. Returns the same raw
 * snapshot every other read in this file returns, so this file still decides
 * nothing about existence -- the guard does, and turns a missing document into the
 * 404 the API has always used.
 *
 * A single-document `.get()`, which needs no index and, unlike the two queries
 * above, cannot be answered from a filter that has to be scanned per owner.
 */
const getTaskById = (taskId) => db.collection('tasks').doc(taskId).get();

/**
 * Reads one task inside an existing transaction.
 *
 * STAGE 3E. The hire creates tasks under deterministic ids, so it must discover
 * a collision before it stages any write. Doing that through the caller's
 * transaction also makes a concurrent write to the same id conflict and retry,
 * exactly as the other hire reads do.
 */
const getTaskByIdInTransaction = (tx, taskId) =>
    tx.get(db.collection('tasks').doc(taskId));

/**
 * Stages a whole task document inside an existing transaction.
 *
 * STAGE 3E. Used only by the hire, after the read phase has proved the id is
 * free. The caller has already built the document with taskService's builder, so
 * the persisted shape stays identical to POST /tasks.
 */
const setTaskInTransaction = (tx, taskId, data) =>
    tx.set(db.collection('tasks').doc(taskId), data);

/**
 * Applies a partial update to one existing task document.
 *
 * STAGE 9C. The first write this collection has ever had after creation, and the
 * only reason `tasks` stopped being create-only. Deliberately a partial update
 * rather than a replace: a transition must be able to move `status` and stamp a
 * timestamp without being able to touch `taskName`, `taskDescription`, `dueDate`,
 * `jobId`, `employeeId`, `applicationId` or `employmentId`, and `update()` enforces
 * that by only ever writing the keys it is handed. A whole-document `set()` would
 * put those seven fields one careless caller away from being overwritten.
 *
 * No existence read here. The guard has already loaded the document by the time any
 * caller reaches this, so the not-found case is settled before it -- and a task
 * deleted between that read and this write (nothing deletes tasks, but the fake can
 * be made to) surfaces as a Firestore failure rather than a 404, exactly as
 * updateJobFields documents for jobs.
 */
const updateTaskFields = (taskId, partial) => db.collection('tasks').doc(taskId).update(partial);

/**
 * STAGE 1. One task transition, decided and written atomically.
 *
 * The previous task lifecycle was read-then-write: `applyTransition` read the
 * document and then updated it, so two concurrent requests could both observe
 * `submitted` and both write a terminal status. The review workflow adds actions
 * whose whole point is contention (two admins deciding one dispute, an employer
 * approving while an employee escalates), so the status check now happens inside
 * the transaction. A competing write bumps the document version, the transaction
 * retries, and the callback sees the committed status and refuses.
 *
 * `decide` runs inside the callback, receives the freshly read task and returns
 * `{ status, fields, event }`. It may throw a business error, which aborts the
 * transaction with no writes and surfaces to the controller unchanged. All reads
 * happen before any write in the callback, as Firestore requires.
 *
 * The event, when supplied, is staged in the same transaction through
 * taskEventRepository, so a task can never move without a matching history row.
 */
const applyTaskTransition = async (taskId, { decide, eventId }) => {
    const taskRef = db.collection('tasks').doc(taskId);

    return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(taskRef);

        if (!snapshot.exists) return { missing: true };

        const task = { id: snapshot.id, ...snapshot.data() };
        const decided = decide(task);

        tx.update(taskRef, decided.fields);

        if (eventId && decided.event) {
            taskEventRepository.setEventInTransaction(tx, eventId, decided.event);
        }

        return { taskId, status: decided.status };
    });
};

/** Every task belonging to one employment. Single-field equality filter. */
const listTasksByEmployment = (employmentId) =>
    db.collection('tasks').where('employmentId', '==', employmentId).get();

/** Every task, for the admin review queue. Small-scale read, no index needed. */
const listAllTasks = () => db.collection('tasks').get();

module.exports = {
    addTask,
    getTaskById,
    getTaskByIdInTransaction,
    setTaskInTransaction,
    listTasksByEmployee,
    listTasksByJob,
    listTasksByEmployment,
    listTasksByMilestoneId,
    listAllTasks,
    updateTaskFields,
    applyTaskTransition,
};
