const { db } = require('../config/firebase');
const taskEventRepository = require('./taskEventRepository');

/**
 * STAGE 1. Admin review requests and decisions.
 *
 * Request ids are deterministic: `{taskId}_v{submissionVersion}`. That is what
 * makes a second escalation for the same submission an ALREADY_EXISTS rather
 * than a second request, and it is why the id is computed here from the task the
 * transaction just read rather than accepted from the caller.
 */
class ReviewRequestExistsError extends Error {}

const newDecisionId = () => db.collection('adminDecisions').doc().id;

const requestIdFor = (taskId, submissionVersion) =>
    `${taskId}_v${Number(submissionVersion) || 0}`;

const requestRef = (requestId) => db.collection('adminReviewRequests').doc(requestId);

const createReviewRequestTransaction = async ({ taskId, decide, eventId }) => {
    const taskRef = db.collection('tasks').doc(taskId);
    let createdRequestId = null;

    const result = await db.runTransaction(async (tx) => {
        const snapshot = await tx.get(taskRef);

        if (!snapshot.exists) return { missing: true };

        const task = { id: snapshot.id, ...snapshot.data() };
        const decided = decide(task);
        const requestId = requestIdFor(task.id, decided.submissionVersion);

        const existing = await tx.get(requestRef(requestId));
        if (existing.exists) {
            throw new ReviewRequestExistsError(
                'An admin review has already been requested for this submission'
            );
        }

        createdRequestId = requestId;
        tx.create(requestRef(requestId), decided.request);
        tx.update(taskRef, decided.fields);
        taskEventRepository.setEventInTransaction(tx, eventId, decided.event);

        return { taskId, status: decided.status, requestId };
    });

    if (result.missing) return result;

    return { ...result, requestId: createdRequestId };
};

/**
 * One admin decision, committed with the task, the request and the dispute.
 *
 * The callback owns the business rules and returns every document it wants
 * written. The repository only stages them, after all reads, in one transaction
 * -- so an approval cannot land on the task while the dispute remains open, and
 * two admins deciding the same case contend on the task document itself.
 */
const runDecisionTransaction = async ({ taskId, decide, decisionId, eventId }) => {
    const taskRef = db.collection('tasks').doc(taskId);

    return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(taskRef);

        if (!snapshot.exists) return { missing: true };

        const task = { id: snapshot.id, ...snapshot.data() };

        const requestId = task.activeAdminReviewRequestId || null;
        const requestSnap = requestId ? await tx.get(requestRef(requestId)) : null;
        const request = requestSnap && requestSnap.exists
            ? { id: requestSnap.id, ...requestSnap.data() }
            : null;

        const disputeId = task.activeDisputeId || null;
        const disputeSnap = disputeId
            ? await tx.get(db.collection('disputes').doc(disputeId))
            : null;
        const dispute = disputeSnap && disputeSnap.exists
            ? { id: disputeSnap.id, ...disputeSnap.data() }
            : null;

        const decided = decide(task, request, dispute);

        tx.update(taskRef, decided.taskFields);
        taskEventRepository.setEventInTransaction(tx, eventId, decided.event);
        tx.set(db.collection('adminDecisions').doc(decisionId), decided.decision);

        if (request && decided.requestFields) {
            tx.update(requestRef(request.id), decided.requestFields);
        }

        if (dispute && decided.disputeFields) {
            tx.update(db.collection('disputes').doc(dispute.id), decided.disputeFields);
        }

        return {
            taskId,
            status: decided.status,
            resolution: decided.resolution || null,
        };
    });
};

const getReviewRequest = (requestId) => requestRef(requestId).get();

const listAllReviewRequests = () => db.collection('adminReviewRequests').get();

const listDecisionsForTask = (taskId) =>
    db.collection('adminDecisions').where('taskId', '==', taskId).get();

module.exports = {
    ReviewRequestExistsError,
    newDecisionId,
    requestIdFor,
    createReviewRequestTransaction,
    runDecisionTransaction,
    getReviewRequest,
    listAllReviewRequests,
    listDecisionsForTask,
};
