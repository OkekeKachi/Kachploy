// adminReviewService.js
//
// STAGE 1. The admin side of the review workflow: the dispute/review queues, one
// case in full, and the decision that resolves it.
//
// An admin is authorised ONLY by the `admin === true` Firebase custom claim,
// checked by requireAdmin. Nothing here reads `users.role`; a stored role is
// profile data, not an authority, and treating it as one would let a client-side
// registration field decide who can resolve money-adjacent disputes.
//
// Decisions are append-only. `request_info` does not resolve the task -- it
// records the question, marks the request as awaiting an employee response, and
// leaves the deadline unable to drift into an approval. Only `approve` and
// `reject` produce a terminal `resolved` task, and each writes the task, the
// dispute, the request, a decision row and a history event in one transaction.

const disputeRepository = require('../repositories/disputeRepository');
const disputeEvidenceRepository = require('../repositories/disputeEvidenceRepository');
const taskRepository = require('../repositories/taskRepository');
const taskEventRepository = require('../repositories/taskEventRepository');
const adminReviewRepository = require('../repositories/adminReviewRepository');
const clock = require('../config/clock');
const {
    TaskTransitionError,
    ADMIN_DECISION_ACTIONS,
    resolveTransition,
    taskStatus,
    toMillis,
} = require('./taskReviewState');

class AdminValidationError extends Error {}
class AdminNotFoundError extends Error {}
class AdminStateError extends Error {}

const toPlain = (snapshot) => {
    const rows = [];
    if (!snapshot) return rows;
    if (Array.isArray(snapshot)) {
        snapshot.forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
        return rows;
    }
    if (Array.isArray(snapshot.docs)) return toPlain(snapshot.docs);
    if (typeof snapshot.forEach === 'function') {
        snapshot.forEach((doc) => {
            if (doc) rows.push({ id: doc.id, ...doc.data() });
        });
    }
    return rows;
};

const byCreatedAt = (a, b) => {
    const left = toMillis(a.createdAt) || 0;
    const right = toMillis(b.createdAt) || 0;
    return left - right;
};

const listDisputes = async () => {
    const snapshot = await disputeRepository.listAllDisputes();
    return toPlain(snapshot).sort(byCreatedAt);
};

const listReviews = async () => {
    const [tasksSnap, requestsSnap] = await Promise.all([
        taskRepository.listAllTasks(),
        adminReviewRepository.listAllReviewRequests(),
    ]);

    const requestsById = new Map(toPlain(requestsSnap).map((row) => [row.id, row]));

    const reviews = toPlain(tasksSnap)
        .filter((task) => ['disputed', 'admin_review_requested'].includes(taskStatus(task)))
        .map((task) => {
            const requestId = task.activeAdminReviewRequestId || null;
            return {
                ...task,
                adminReviewRequest: requestId ? requestsById.get(requestId) || null : null,
            };
        })
        .sort(byCreatedAt);

    return reviews;
};

const getReview = async (taskId) => {
    const snapshot = await taskRepository.getTaskById(taskId);
    if (!snapshot.exists) throw new AdminNotFoundError('Task not found');

    const task = { id: snapshot.id, ...snapshot.data() };
    const [eventsSnap, decisionsSnap, requestSnap, disputeSnap] = await Promise.all([
        taskEventRepository.listEventsByTaskId(taskId),
        adminReviewRepository.listDecisionsForTask(taskId),
        task.activeAdminReviewRequestId
            ? adminReviewRepository.getReviewRequest(task.activeAdminReviewRequestId)
            : Promise.resolve(null),
        task.activeDisputeId
            ? disputeRepository.getDisputeById(task.activeDisputeId)
            : Promise.resolve(null),
    ]);

    const evidence = task.activeDisputeId
        ? await disputeEvidenceRepository.listEvidenceByDispute(task.activeDisputeId)
        : null;

    return {
        task,
        request: requestSnap && requestSnap.exists
            ? { id: requestSnap.id, ...requestSnap.data() }
            : null,
        dispute: disputeSnap && disputeSnap.exists
            ? { id: disputeSnap.id, ...disputeSnap.data() }
            : null,
        evidence: evidence ? toPlain(evidence) : [],
        events: toPlain(eventsSnap).sort(byCreatedAt),
        decisions: toPlain(decisionsSnap).sort(byCreatedAt),
    };
};

const decide = async (taskId, { action, rationale }, adminUid) => {
    if (!ADMIN_DECISION_ACTIONS.includes(action)) {
        throw new AdminValidationError(
            `action must be one of: ${ADMIN_DECISION_ACTIONS.join(', ')}`
        );
    }

    if (typeof rationale !== 'string' || rationale.trim() === '') {
        throw new AdminValidationError('A rationale is required for every decision');
    }

    if (!adminUid) {
        throw new AdminValidationError('An admin identity is required');
    }

    const now = clock.now();
    const decisionId = adminReviewRepository.newDecisionId();
    const eventId = taskEventRepository.newEventId();
    const outcome = action === 'approve'
        ? 'employee_favoured'
        : action === 'reject'
            ? 'employer_favoured'
            : null;

    try {
        const result = await adminReviewRepository.runDecisionTransaction({
            taskId,
            decisionId,
            eventId,
            decide: (task, request, dispute) => {
                const fromStatus = taskStatus(task);
                let next = fromStatus;
                let resolution = null;

                if (action === 'request_info') {
                    if (!['disputed', 'admin_review_requested'].includes(fromStatus)) {
                        throw new AdminStateError(
                            `Cannot request more information for a task that is '${fromStatus}'`
                        );
                    }
                } else {
                    next = resolveTransition(task, action === 'approve' ? 'admin_approve' : 'admin_reject');
                    resolution = {
                        outcome,
                        decidedBy: adminUid,
                        decidedAt: now,
                        rationale: rationale.trim(),
                    };
                }

                const decision = {
                    taskId: task.id,
                    disputeId: dispute ? dispute.id : null,
                    requestId: request ? request.id : null,
                    action,
                    outcome: outcome || 'request_info',
                    rationale: rationale.trim(),
                    decidedBy: adminUid,
                    fromStatus,
                    toStatus: next,
                    createdAt: now,
                };

                const event = {
                    taskId: task.id,
                    type: action === 'request_info' ? 'admin_request_info' : `admin_${action}`,
                    actorId: adminUid,
                    actorRole: 'admin',
                    fromStatus,
                    toStatus: next,
                    detail: { decisionId, rationale: rationale.trim() },
                    createdAt: now,
                };

                if (action === 'request_info') {
                    return {
                        status: next,
                        resolution: null,
                        taskFields: { adminInfoRequestedAt: now },
                        requestFields: request ? { status: 'info_requested', updatedAt: now } : null,
                        disputeFields: null,
                        decision,
                        event,
                    };
                }

                return {
                    status: next,
                    resolution,
                    taskFields: {
                        status: next,
                        resolution,
                        resolvedAt: now,
                        activeDisputeId: null,
                        activeAdminReviewRequestId: null,
                    },
                    requestFields: request ? { status: 'resolved', updatedAt: now } : null,
                    disputeFields: dispute
                        ? { status: 'resolved', resolution, resolvedAt: now, updatedAt: now }
                        : null,
                    decision,
                    event,
                };
            },
        });

        if (result.missing) throw new AdminNotFoundError('Task not found');

        return result;
    } catch (err) {
        if (err instanceof TaskTransitionError) {
            throw new AdminStateError(err.message);
        }
        throw err;
    }
};

module.exports = {
    AdminValidationError,
    AdminNotFoundError,
    AdminStateError,
    listDisputes,
    listReviews,
    getReview,
    decide,
};
