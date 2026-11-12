// taskReviewState.js
//
// STAGE 1. The milestone review state machine, extracted from taskService so the
// task routes, the dispute creation path and the admin decision path all resolve a
// transition through the same table. Before this stage `approved` was terminal and
// the table lived in taskService; the review workflow adds three statuses
// (`disputed`, `admin_review_requested`, `resolved`) and four actions, and a second
// copy of the rules would be a second place to get them wrong.
//
// The model is deliberately small:
//
//   assigned              work not delivered; the employee may submit
//   submitted             delivered; the employer may approve, request a revision,
//                         raise a dispute, and after the deadline the employee may
//                         ask an admin to review
//   revision_requested    sent back; the employee may resubmit
//   approved              accepted; still disputed-able while no release is recorded
//   disputed              an open dispute names this task; admin resolves it
//   admin_review_requested  escalated to admins by the employee after the deadline
//   resolved              terminal; an admin recorded employee_favoured or
//                         employer_favoured
//
// `approved` is no longer terminal in the Stage 9C sense: the employer and the
// employee may open a dispute against approved work while the payment has not been
// released. It remains terminal with respect to submit/approve/request-revision,
// which is the property the existing Stage 9C tests pin.
//
// This file holds no Firestore access and no HTTP knowledge. It is a pure decision
// layer plus the constants the rest of the stage shares.

class TaskTransitionError extends Error {}

const ASSIGNED_TASK_STATUS = 'assigned';

const TASK_STATUSES = [
    'assigned',
    'submitted',
    'approved',
    'revision_requested',
    'disputed',
    'admin_review_requested',
    'resolved',
];

const REVIEW_WINDOW_DAYS = 7;
const REVIEW_WINDOW_MS = REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const ADMIN_DECISION_ACTIONS = ['approve', 'reject', 'request_info'];
const ADMIN_RESOLUTIONS = ['employee_favoured', 'employer_favoured'];

const TASK_TRANSITIONS = {
    submit: {
        from: [ASSIGNED_TASK_STATUS, 'revision_requested'],
        to: 'submitted',
    },
    approve: {
        from: ['submitted'],
        to: 'approved',
    },
    request_revision: {
        from: ['submitted'],
        to: 'revision_requested',
    },
    dispute: {
        from: ['submitted', 'approved'],
        to: 'disputed',
    },
    request_admin_review: {
        from: ['submitted'],
        to: 'admin_review_requested',
    },
    admin_approve: {
        from: ['disputed', 'admin_review_requested'],
        to: 'resolved',
    },
    admin_reject: {
        from: ['disputed', 'admin_review_requested'],
        to: 'resolved',
    },
};

const taskStatus = (task) => (task && task.status == null ? ASSIGNED_TASK_STATUS : task.status);

const resolveTransition = (task, action) => {
    const current = taskStatus(task);

    if (!TASK_STATUSES.includes(current)) {
        throw new TaskTransitionError(
            `Cannot ${action.replace(/_/g, ' ')} a task with an unknown status '${current}'`
        );
    }

    const rule = TASK_TRANSITIONS[action];

    if (!rule || !rule.from.includes(current)) {
        throw new TaskTransitionError(
            `Cannot ${action.replace(/_/g, ' ')} a task that is '${current}'`
        );
    }

    return rule.to;
};

/**
 * Reads a stored firestore value as milliseconds since the epoch.
 *
 * A real Timestamp has `toMillis()`; the fake harness stores `{_seconds,
 * _nanoseconds}`; a `Date` can reach a service directly; and a legacy document
 * may hold an ISO string. Every one of those is understood here so a deadline
 * comparison never depends on which of those shapes a deployment produced.
 */
const toMillis = (value) => {
    if (value == null) return null;
    if (typeof value === 'object' && typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value === 'object' && typeof value._seconds === 'number') {
        return value._seconds * 1000 + Math.floor((value._nanoseconds || 0) / 1e6);
    }
    if (value instanceof Date) return value.getTime();

    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? null : parsed;
};

const deadlinePassed = (task, atMs) => {
    if (!task || taskStatus(task) !== 'submitted') return false;
    const deadline = toMillis(task.reviewDeadlineAt);
    if (deadline == null) return false;
    return atMs >= deadline;
};

const submissionSnapshot = (task) => {
    if (!task) return null;
    const snapshot = { submittedAt: task.submittedAt ?? null };
    if (task.submissionText != null) snapshot.submissionText = task.submissionText;
    if (task.submissionUrl != null) snapshot.submissionUrl = task.submissionUrl;
    if (task.submissionFile != null) snapshot.submissionFile = task.submissionFile;
    return snapshot;
};

module.exports = {
    TaskTransitionError,
    ASSIGNED_TASK_STATUS,
    TASK_STATUSES,
    REVIEW_WINDOW_DAYS,
    REVIEW_WINDOW_MS,
    ADMIN_DECISION_ACTIONS,
    ADMIN_RESOLUTIONS,
    TASK_TRANSITIONS,
    taskStatus,
    resolveTransition,
    toMillis,
    deadlinePassed,
    submissionSnapshot,
};
