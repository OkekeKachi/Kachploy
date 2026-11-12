const { db } = require('../config/firebase');
const taskEventRepository = require('./taskEventRepository');

const OPEN_DISPUTE_STATUSES = ['open', 'under_review'];

/**
 * Raised inside the transaction when the employment's open-dispute lock points
 * at a dispute that is still open or under review. The service maps this to its
 * own state error so the controller can answer 409.
 */
class DisputeLockedError extends Error {}

/**
 * STAGE 1. The task named by a dispute disappeared between the service's
 * validation read and the transaction. Thrown inside the transaction so the
 * dispute, the lock and the task write all abort together.
 */
class DisputeTaskLinkError extends Error {}

const addDispute = async (data) => {
    const ref = await db.collection('disputes').add(data);
    return ref.id;
};

/** A pre-generated id, so the dispute and its lock commit in one transaction. */
const newDisputeId = () => db.collection('disputes').doc().id;

/**
 * Commits a new dispute and the per-employment open-dispute lock together.
 *
 * The lock document is the contention point: every creation for one employment
 * reads and writes the same id, so Firestore serialises competing transactions.
 * A transaction that reads the lock before another commits is retried and then
 * sees the committed lock; if the dispute it references is still open the
 * callback throws and nothing is written. This closes the concurrent window
 * for disputes created through this path.
 *
 * Claim boundary: disputes written before this lock existed have no lock, so
 * the service's query pre-check still guards them. That pre-check is not part
 * of the transaction and remains read-then-write; it is not claimed to be
 * atomic for legacy rows. The lock is also not deleted by a status change made
 * outside this module, so the transaction re-reads the referenced dispute's
 * status instead of trusting the lock alone.
 */
const createDisputeWithLock = async ({ employmentId, disputeId, data, task }) => {
    const lockRef = db.collection('disputeLocks').doc(employmentId);
    const disputeRef = db.collection('disputes').doc(disputeId);
    const taskRef = task ? db.collection('tasks').doc(task.taskId) : null;

    await db.runTransaction(async (tx) => {
        const lockSnap = await tx.get(lockRef);
        if (lockSnap.exists) {
            const lock = lockSnap.data() || {};
            if (lock.disputeId) {
                const currentSnap = await tx.get(db.collection('disputes').doc(lock.disputeId));
                if (
                    currentSnap.exists
                    && OPEN_DISPUTE_STATUSES.includes(currentSnap.data().status)
                ) {
                    throw new DisputeLockedError('An open dispute already exists for this employment');
                }
            }
        }

        if (taskRef) {
            const taskSnap = await tx.get(taskRef);

            if (!taskSnap.exists) {
                throw new DisputeTaskLinkError('The task named by this dispute could not be found');
            }

            const currentTask = { id: taskSnap.id, ...taskSnap.data() };
            const taskFields = task.decide(currentTask);

            tx.update(taskRef, taskFields);
            taskEventRepository.setEventInTransaction(
                tx,
                task.eventId,
                task.event({ ...currentTask, ...taskFields })
            );
        }

        tx.set(lockRef, {
            employmentId,
            disputeId,
            status: 'open',
            updatedAt: data.updatedAt,
        });
        tx.set(disputeRef, data);
    });

    return disputeId;
};

const getDisputeById = (disputeId) => db.collection('disputes').doc(disputeId).get();

const listDisputesByEmployment = (employmentId) =>
    db.collection('disputes').where('employmentId', '==', employmentId).get();

const listDisputesByTaskId = (taskId) =>
    db.collection('disputes').where('taskId', '==', taskId).get();

const listAllDisputes = () => db.collection('disputes').get();

const listDisputesByParty = (uid) =>
    Promise.all([
        db.collection('disputes').where('initiatedBy', '==', uid).get(),
        db.collection('disputes').where('employerId', '==', uid).get(),
        db.collection('disputes').where('employeeId', '==', uid).get(),
    ]).then(([a, b, c]) => {
        const map = new Map();
        a.forEach(d => map.set(d.id, d));
        b.forEach(d => map.set(d.id, d));
        c.forEach(d => map.set(d.id, d));
        return { docs: Array.from(map.values()) };
    });

const updateDisputeFields = (disputeId, updates) =>
    db.collection('disputes').doc(disputeId).update(updates);

module.exports = {
    DisputeLockedError,
    DisputeTaskLinkError,
    addDispute,
    newDisputeId,
    createDisputeWithLock,
    getDisputeById,
    listDisputesByEmployment,
    listDisputesByTaskId,
    listDisputesByParty,
    listAllDisputes,
    updateDisputeFields,
};
