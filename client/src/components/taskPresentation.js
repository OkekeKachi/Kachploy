/**
 * Pure task and employment presentation logic for the employee views.
 *
 * STAGE 10F: split out of components/TaskCard.jsx, which is where these functions
 * lived from Stage 9E onward, so that the module holding the interactive component
 * exports only components. Keeping them together tripped
 * `react-refresh/only-export-components` on every one of them, which costs
 * fast-refresh for the one file whose whole job is re-rendering as the employee
 * types. It is a dev-experience rule, so it was a warning rather than an error, but
 * introducing three new warnings into a file this hot was not worth it.
 *
 * NOTHING HERE TOUCHES THE NETWORK OR REACT. Every function is pure: same input,
 * same output, no side effect, no state. That is what makes them safe to share
 * between the My Jobs list and the per-job workspace -- the two views must reach the
 * same conclusions about the same documents, and the only way to guarantee that is
 * for them to run the same code.
 *
 * The rules encoded here are also the ones the server enforces, restated for display:
 * the four task statuses and the two employment statuses are allow-lists taken from
 * taskService and employmentService, and the grouping order matches how requireTaskParty
 * resolves a task's parties. Nothing in this file grants or withholds access.
 */

/**
 * Decodes the two date shapes that reach these views.
 *
 * STAGE 6B stores `dueDate` as the ISO string ViewJobApplications.jsx sends
 * (`new Date().toISOString()`), and `createdDate` as a Firestore Timestamp, which
 * arrives as `{_seconds, _nanoseconds}` -- the same wire shape the 5H decoders in
 * ViewJobApplications.jsx and JobSplitView.jsx already handle. Both branches are
 * needed here because one page reads one of each.
 *
 * STAGE 10E: an employment's `startDate` is a THIRD case, and both branches are
 * reached by it. employmentService.resolveStartDate stores the job's own
 * `jobStartDate` verbatim when it can -- which is the string PostJobForm submits
 * -- and falls back to a serverTimestamp(), which is a Timestamp, only for a job
 * document that has no start date at all. So both shapes really do occur on this
 * one field and the existing decoder covers them without a new branch.
 *
 * Mirrors appliedOnLabel: every input, including undefined, yields a string, so a
 * malformed date can never throw and take the list down with it.
 */
export const dateLabel = (value) => {
    let date;

    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        date = new Date(value._seconds * 1000);
    } else if (typeof value === 'string' && value) {
        date = new Date(value);
    }

    return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'Date not available';
};

// STAGE 9D. Task lifecycle, which is a different state machine from the application
// lifecycle above it and is deliberately not merged with it (Stage 7C fixed that the
// two domains do not write to each other):
//
//   assigned            work not delivered yet; the employee may submit
//   submitted           work delivered; waiting on the employer
//   revision_requested  work sent back with a note; the employee may resubmit
//   approved            final; the server refuses every further transition
//
// `assigned` is not decoration. Tasks written before Stage 9B have no `status` field
// at all, and the server derives `assigned` for those on every read, so treating a
// missing status as anything else would hide the only action those tasks can take.
export const TASK_STATUS_LABELS = {
    assigned: 'Assigned',
    submitted: 'Submitted',
    revision_requested: 'Revision requested',
    approved: 'Approved',
};

export const taskStatus = (task) => (task && typeof task.status === 'string' && task.status ? task.status : 'assigned');

export const taskStatusLabel = (task) => TASK_STATUS_LABELS[taskStatus(task)] || 'No status available';

// STAGE 10E. The order the four statuses are counted in, fixed so the progress
// summary on a card does not reshuffle itself between reads: Firestore returns
// documents in key order and a task list's order within a job is whatever that
// happens to be, which would otherwise reorder the counts on every load.
//
// The list is the allow-list taskService enforces on the write path, in the
// order the work actually moves through it, so reading it here cannot report a
// status the server would refuse.
export const TASK_STATUS_ORDER = ['assigned', 'submitted', 'revision_requested', 'approved'];

/**
 * The same four statuses rendered as shared Badge primitives.
 *
 * LABELS: identical to TASK_STATUS_LABELS except `revision_requested`, which reads
 * "Sent back for changes" -- the words the employer's own action button uses
 * ("Send back for changes") and the clearest statement of what happened to the
 * work. TASK_STATUS_LABELS is untouched because the progress summary counts in it
 * ("2 revision requested") and that wording is a separate sentence.
 *
 * VARIANTS: canonical status -> shared Badge variant, mirroring the
 * appStatusBadgeVariant / employmentStatusBadgeVariant maps the pages already use,
 * so a task's state reads with the same colour semantics everywhere the shared
 * Badge is used. An unrecognised stored value falls back to neutral rather than
 * claiming a state the document never said -- same rule as employmentStatusLabel.
 */
export const TASK_STATUS_BADGE_LABELS = {
    ...TASK_STATUS_LABELS,
    revision_requested: 'Sent back for changes',
};

export const TASK_STATUS_BADGE_VARIANTS = {
    assigned: 'neutral',
    submitted: 'info',
    revision_requested: 'warning',
    approved: 'success',
};

export const taskStatusBadgeLabel = (task) =>
    TASK_STATUS_BADGE_LABELS[taskStatus(task)] || 'No status available';

export const taskStatusBadgeVariant = (task) =>
    TASK_STATUS_BADGE_VARIANTS[taskStatus(task)] || 'neutral';

// STAGE 10E. An employment's own status, which is a third lifecycle again and not
// the task one above: `active` is the only value anything writes today, because
// ending an employment is still deferred server-side (employmentService registers
// no update path and EMPLOYMENT_STATUSES is the allow-list those writes will be
// checked against).
//
// An unrecognised value is labelled as such rather than assumed to be `active`.
// The missing-status default on tasks above is safe because the server itself
// derives `assigned` for those documents, so the client is only matching what the
// server decided; there is no equivalent server-side derivation for an employment,
// so claiming `active` here would be this page asserting something no document
// says.
const EMPLOYMENT_STATUS_LABELS = {
    active: 'Active',
    ended: 'Ended',
    completed: 'Completed',
    terminated: 'Terminated',
};

export const employmentStatusLabel = (employment) => {
    const status = employment && typeof employment.status === 'string' ? employment.status : '';

    return EMPLOYMENT_STATUS_LABELS[status] || 'No status available';
};

// Only these two statuses offer the submit control. `submitted` and `approved` do
// not, and the server would reject both with 400 anyway: offering a button whose
// request is guaranteed to fail is the bug Stage 7G-2 removed from the hire control.
export const SUBMITTABLE_STATUSES = ['assigned', 'revision_requested'];

/**
 * STAGE 10G. The three ways a task's work can be delivered, and what each is called.
 *
 * The list is the client's copy of taskService's SUBMISSION_TYPES, and the labels are
 * what the employee reads on the card. Both are restated in the employer's select on
 * ViewJobApplications.jsx; the server is the only authority, and it refuses a fourth
 * value with the same three names.
 *
 * A task stored before Stage 10G has no `submissionType` and is a `text` task, because
 * submitTask used to accept exactly one field and it was written text. So the default
 * below is not a preference -- it is what every existing task is, and getting it wrong
 * would hide the submit control for the whole database.
 *
 * An unrecognised stored value falls back to `text` here even though the SERVER refuses
 * to submit such a task. The asymmetry is deliberate: this list must always render
 * something, and the alternative is a card with no control and no explanation. The
 * refusal is still there -- the employee's submission comes back 400 with the value
 * named -- so nothing incorrect can be stored, only an error the user can report.
 */
export const SUBMISSION_TYPES = ['text', 'link', 'file'];

export const SUBMISSION_TYPE_LABELS = {
    text: 'Written text',
    link: 'Link',
    file: 'File',
};

export const taskSubmissionType = (task) =>
    task && typeof task.submissionType === 'string' && SUBMISSION_TYPES.includes(task.submissionType)
        ? task.submissionType
        : 'text';

export const taskSubmissionTypeLabel = (task) => SUBMISSION_TYPE_LABELS[taskSubmissionType(task)];

/**
 * STAGE 10G. Would the server accept this as a submitted link?
 *
 * The same rule as taskService.isValidHttpUrl, restated rather than imported because
 * the two run in different processes: http and https only, and `new URL()` as the
 * parser, so `javascript:` and `data:` are refused here exactly as they are there.
 *
 * This exists to disable the button, not to decide whether a submission is valid. It
 * is a duplicate of a server rule by nature -- there is no shared module across the
 * client/server boundary in this codebase -- so the server stays authoritative and this
 * only saves the employee a round trip they would lose.
 */
export const isValidHttpUrl = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;

    let parsed;

    try {
        parsed = new URL(value.trim());
    } catch {
        return false;
    }

    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
};

/**
 * STAGE 10E. Places each task in the card of the hire it belongs to.
 *
 * Three fallbacks, in this order, because a task names its hire less completely
 * depending on when it was written:
 *
 *   1. `task.employmentId` -- the authoritative link. Stage 9B writes it, and
 *      requireTaskParty on POST /tasks/:taskId/submit authorizes on it, so when it
 *      is present this is the same link the server itself uses.
 *   2. `task.applicationId` -- also written by Stage 9B, and every employment
 *      carries the application it came from, so this recovers tasks whose
 *      employmentId is null.
 *   3. `task.jobId` -- the pre-9B shape, which carried neither. Stage 9B's
 *      resolveEmploymentId documents why the first two can be null: an application
 *      can be accepted without an employment document if that second write failed
 *      or predates Stage 7A, and the guard returns null rather than refusing the
 *      assignment. Falling back to the job still finds the hire in that case.
 *
 * This is presentation only. Nothing here grants or withholds access -- the server
 * re-derives the caller's right to submit on every request -- so a mis-grouping could
 * show a task in the wrong place, never unlock the wrong thing.
 *
 * Where two employments share a jobId, the fallback keys keep the FIRST. Callers sort
 * their employments oldest-first before calling this, so that is the earlier hire; a
 * legacy task in that state is genuinely ambiguous -- nothing in it says which of the
 * two hires it belongs to -- and one deterministic home keeps it visible rather than
 * duplicated into both cards or dropped.
 *
 * A task matching no employment at all comes back as `unassigned` rather than being
 * dropped, which is what keeps it listed (read-only) on the My Jobs page instead of
 * silently disappearing from the employee's work.
 *
 * STAGE 10F: the workspace page calls this with a ONE-element employment list -- the
 * employment it validated -- so the same rules that file a task under a card on My
 * Jobs file it under the workspace heading, and a task belonging to a different hire
 * cannot be returned.
 */
export const milestoneLabelForTask = (task, milestones) => {
    const milestoneId = task && typeof task.milestoneId === 'string' ? task.milestoneId : '';
    if (!milestoneId || !Array.isArray(milestones)) return '';

    const milestone = milestones.find((row) => row && row.id === milestoneId);
    return milestone && typeof milestone.label === 'string' ? milestone.label.trim() : '';
};

export const groupTasksByEmployment = (employments, tasks) => {
    const byEmploymentId = {};
    const firstByApplicationId = {};
    const firstByJobId = {};

    employments.forEach((employment) => {
        if (employment.id) byEmploymentId[employment.id] = employment;
        if (employment.applicationId && !firstByApplicationId[employment.applicationId]) {
            firstByApplicationId[employment.applicationId] = employment;
        }
        if (employment.jobId && !firstByJobId[employment.jobId]) {
            firstByJobId[employment.jobId] = employment;
        }
    });

    const buckets = {};
    const unassigned = [];

    tasks.forEach((task) => {
        const owner =
            (task.employmentId && byEmploymentId[task.employmentId]) ||
            (task.applicationId && firstByApplicationId[task.applicationId]) ||
            (task.jobId && firstByJobId[task.jobId]);

        if (!owner) {
            unassigned.push(task);
            return;
        }

        if (!buckets[owner.id]) buckets[owner.id] = [];
        buckets[owner.id].push(task);
    });

    return { buckets, unassigned };
};
