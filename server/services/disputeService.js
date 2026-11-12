// disputeService.js
const { admin } = require('../config/firebase');
const disputeRepository = require('../repositories/disputeRepository');
const disputeEvidenceRepository = require('../repositories/disputeEvidenceRepository');
const employmentRepository = require('../repositories/employmentRepository');
const taskRepository = require('../repositories/taskRepository');
const taskEventRepository = require('../repositories/taskEventRepository');
const paymentRepository = require('../repositories/paymentRepository');
const clock = require('../config/clock');
const {
    TaskTransitionError,
    resolveTransition,
    taskStatus,
} = require('./taskReviewState');

class DisputeValidationError extends Error {}
class DisputeNotFoundError extends Error {}
class DisputeForbiddenError extends Error {}
class DisputeStateError extends Error {}

const DISPUTE_STATUSES = ['open', 'under_review', 'resolved', 'closed', 'rejected'];
const DISPUTE_CATEGORIES = ['payment', 'work_quality', 'scope', 'non_payment', 'other'];

const OPEN_DISPUTE_STATUSES = ['open', 'under_review'];

const toPlain = (snapshot) => {
    const rows = [];
    if (!snapshot) return rows;
    if (Array.isArray(snapshot)) {
        for (const item of snapshot) {
            if (!item) continue;
            rows.push(typeof item.data === 'function' ? { id: item.id, ...item.data() } : item);
        }
        return rows;
    }
    if (Array.isArray(snapshot.docs)) {
        return toPlain(snapshot.docs);
    }
    if (typeof snapshot.forEach === 'function') {
        snapshot.forEach((doc) => {
            if (!doc) return;
            rows.push(typeof doc.data === 'function' ? { id: doc.id, ...doc.data() } : doc);
        });
    }
    return rows;
};

/**
 * Opens a dispute on one employment.
 *
 * The caller must be a party to the employment. Only one open/under-review
 * dispute may exist per employment: a second request while one is still open is
 * refused with a state error rather than allowed to fork the record.
 *
 * New disputes are committed together with a per-employment lock inside a
 * Firestore transaction, so two concurrent creations contend on one document
 * and only one can commit. Disputes written before the lock existed have no
 * lock document; the query below still refuses those, but that pre-check is
 * read-then-write and is not claimed to be atomic for legacy rows.
 */
/**
 * STAGE 1. A payment is "released" only when a release marker exists on it.
 *
 * `paid` is NOT that marker. A milestone-linked task can only be created after
 * the milestone payment is `paid`, so treating `paid` as released would make the
 * approved -> disputed edge impossible by construction. In this stage nothing
 * writes a release marker, so this returns false for every real record -- which
 * is the intended state, not a gap: there is no payout path yet.
 *
 * The check fails CLOSED: a truthy `releasedAt`, or an explicit
 * `releaseStatus: 'released'`, is enough to refuse a post-approval dispute.
 */
const paymentReleased = (payment) => {
    if (!payment) return false;
    if (payment.releasedAt != null) return true;
    return payment.releaseStatus === 'released';
};

const createDispute = async ({
    employmentId,
    initiatedBy,
    category,
    reason,
    description,
    taskId,
    milestoneId,
}) => {
    if (!employmentId) throw new DisputeValidationError('employmentId is required');
    if (!initiatedBy) throw new DisputeValidationError('initiatedBy is required');
    if (!category) throw new DisputeValidationError('category is required');
    if (!DISPUTE_CATEGORIES.includes(category)) {
        throw new DisputeValidationError(`Invalid category. Must be one of: ${DISPUTE_CATEGORIES.join(', ')}.`);
    }
    if (typeof reason !== 'string' || !reason.trim()) {
        throw new DisputeValidationError('reason is required');
    }

    const empSnap = await employmentRepository.getEmploymentById(employmentId);
    if (!empSnap.exists) throw new DisputeNotFoundError('Employment not found');
    const employment = empSnap.data();

    if (employment.employerId !== initiatedBy && employment.employeeId !== initiatedBy) {
        throw new DisputeForbiddenError('Not authorized to create a dispute for this employment');
    }

    let linkedTask = null;

    if (taskId != null && taskId !== '') {
        if (typeof taskId !== 'string') {
            throw new DisputeValidationError('taskId must be a string');
        }

        const taskSnap = await taskRepository.getTaskById(taskId.trim());
        if (!taskSnap.exists) throw new DisputeNotFoundError('Task not found');

        linkedTask = { id: taskSnap.id, ...taskSnap.data() };

        if (linkedTask.employmentId !== employmentId) {
            throw new DisputeValidationError('Task does not belong to this employment');
        }

        if (milestoneId && linkedTask.milestoneId && milestoneId !== linkedTask.milestoneId) {
            throw new DisputeValidationError('milestoneId does not match the task');
        }

        if (linkedTask.activeDisputeId) {
            throw new DisputeStateError('This task already has an open dispute');
        }

        if (linkedTask.status === 'approved') {
            const paymentId = linkedTask.milestoneId;
            if (paymentId) {
                const paymentSnap = await paymentRepository.getPaymentByMilestoneId(paymentId);
                if (paymentSnap.exists && paymentReleased(paymentSnap.data())) {
                    throw new DisputeStateError(
                        'This work has already been released and cannot be disputed'
                    );
                }
            }
        }
    }

    const existing = await disputeRepository.listDisputesByEmployment(employmentId);
    const alreadyOpen = toPlain(existing).some((d) => OPEN_DISPUTE_STATUSES.includes(d.status));
    if (alreadyOpen) {
        throw new DisputeStateError('An open dispute already exists for this employment');
    }

    const counterpartyId =
        employment.employerId === initiatedBy ? employment.employeeId : employment.employerId;
    const now = clock.now();
    const disputeId = disputeRepository.newDisputeId();
    const eventId = taskEventRepository.newEventId();
    const disputeMilestoneId = milestoneId || (linkedTask && linkedTask.milestoneId) || null;

    try {
        await disputeRepository.createDisputeWithLock({
            employmentId,
            disputeId,
            data: {
                employmentId,
                jobId: employment.jobId || '',
                employerId: employment.employerId,
                employeeId: employment.employeeId,
                initiatedBy,
                respondentId: counterpartyId,
                category,
                reason: reason.trim(),
                description: typeof description === 'string' ? description : '',
                status: 'open',
                ...(linkedTask ? { taskId: linkedTask.id, milestoneId: disputeMilestoneId } : {}),
                createdAt: now,
                updatedAt: now,
            },
            ...(linkedTask
                ? {
                    task: {
                        taskId: linkedTask.id,
                        eventId,
                        decide: (currentTask) => {
                            resolveTransition(currentTask, 'dispute');
                            return {
                                status: 'disputed',
                                activeDisputeId: disputeId,
                                disputedAt: now,
                            };
                        },
                        event: () => ({
                            taskId: linkedTask.id,
                            type: 'dispute',
                            actorId: initiatedBy,
                            actorRole:
                                employment.employerId === initiatedBy ? 'employer' : 'employee',
                            fromStatus: taskStatus(linkedTask),
                            toStatus: 'disputed',
                            detail: { disputeId },
                            createdAt: now,
                        }),
                    },
                }
                : {}),
        });
    } catch (err) {
        if (err instanceof disputeRepository.DisputeLockedError) {
            throw new DisputeStateError(err.message);
        }
        if (err instanceof disputeRepository.DisputeTaskLinkError) {
            throw new DisputeNotFoundError(err.message);
        }
        if (err instanceof TaskTransitionError) {
            throw new DisputeStateError(err.message);
        }
        throw err;
    }

    const written = await disputeRepository.getDisputeById(disputeId);
    return { dispute: { id: written.id, ...written.data() } };
};

const getDispute = async (disputeId, callerId) => {
    const snap = await disputeRepository.getDisputeById(disputeId);
    if (!snap.exists) throw new DisputeNotFoundError('Dispute not found');
    const dispute = { id: snap.id, ...snap.data() };
    if (dispute.employerId !== callerId && dispute.employeeId !== callerId) {
        throw new DisputeForbiddenError('Not authorized to view this dispute');
    }
    const evSnap = await disputeEvidenceRepository.listEvidenceByDispute(disputeId);
    return { dispute, evidence: toPlain(evSnap) };
};

/** STAGE 1. The evidence attached to one dispute, for a party to that dispute. */
const getDisputeEvidence = async (disputeId, callerId) => {
    const snap = await disputeRepository.getDisputeById(disputeId);
    if (!snap.exists) throw new DisputeNotFoundError('Dispute not found');

    const dispute = { id: snap.id, ...snap.data() };
    if (dispute.employerId !== callerId && dispute.employeeId !== callerId) {
        throw new DisputeForbiddenError('Not authorized to view this dispute');
    }

    const evidence = await disputeEvidenceRepository.listEvidenceByDispute(disputeId);
    return { disputeId, evidence: toPlain(evidence) };
};

const listDisputesForParty = async (uid) => {
    const result = await disputeRepository.listDisputesByParty(uid);
    return toPlain(result);
};

const addDisputeEvidence = async ({ disputeId, submittedBy, evidenceType, content, url = '' }) => {
    if (!disputeId) throw new DisputeValidationError('disputeId is required');
    if (!submittedBy) throw new DisputeValidationError('submittedBy is required');
    if (!evidenceType) throw new DisputeValidationError('evidenceType is required');
    if (!content && !url) throw new DisputeValidationError('Evidence content or url is required');

    const snap = await disputeRepository.getDisputeById(disputeId);
    if (!snap.exists) throw new DisputeNotFoundError('Dispute not found');
    const dispute = snap.data();
    if (dispute.employerId !== submittedBy && dispute.employeeId !== submittedBy) {
        throw new DisputeForbiddenError('Not authorized to add evidence to this dispute');
    }
    if (dispute.status === 'resolved' || dispute.status === 'closed') {
        throw new DisputeStateError('Cannot add evidence to a resolved/closed dispute');
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const evidenceId = await disputeEvidenceRepository.addEvidence({
        disputeId,
        submittedBy,
        evidenceType,
        content: content || '',
        url: typeof url === 'string' ? url : '',
        createdAt: now,
    });

    await disputeRepository.updateDisputeFields(disputeId, { updatedAt: now });
    return { evidenceId };
};

module.exports = {
    DisputeValidationError,
    DisputeNotFoundError,
    DisputeForbiddenError,
    DisputeStateError,
    DISPUTE_STATUSES,
    DISPUTE_CATEGORIES,
    createDispute,
    getDispute,
    getDisputeEvidence,
    listDisputesForParty,
    addDisputeEvidence,
};
