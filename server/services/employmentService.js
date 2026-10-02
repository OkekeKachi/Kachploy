// employmentService.js
//
// Business and data layer for the employments resource (new in Stage 7A). An
// employment is the record of the relationship that comes into existence when an
// employer hires an applicant. It is a new collection, so unlike the four
// services that predate it there is nothing here to preserve characterise-wise;
// what follows is the shape this resource is created with and the two rules that
// are deliberately not implemented yet.
//
// WHAT EXISTS HERE
//   * createEmploymentFromHire -- the only write path. It is called from
//     applicationService.updateApplicationStatus once the hire's own write has
//     succeeded, never from a route of its own.
//   * listEmploymentsForEmployee / listEmploymentsForEmployer -- the two reads.
//
// WHAT DELIBERATELY DOES NOT EXIST YET
//   * No create endpoint. An employment is never created by a direct client
//     request; it exists as a consequence of a hire. That is the point of the
//     domain, and it is why no POST route is registered in routes/employments.js.
//   * No update or end-employment path. `status` is written as `active` and
//     `endDate` as null, and nothing in this stage can change either: ending an
//     employment (and the `ended` status, and the endDate write that goes with
//     it) is deliberately deferred, as is the employment UI. EMPLOYMENT_STATUSES
//     is therefore the allow-list those writes will be checked against, and it
//     is exported so the first writer cannot invent a third value.
//   * No transaction, because Stage 7A is not allowed to add one. The hire's
//     status write and this add are two independent writes, so they can diverge
//     if the process dies between them; see the comment at the call site in
//     applicationService.updateApplicationStatus, which owns that ordering.
//
// AUTHORIZATION: like taskService.listTasksForEmployee, both reads trust their
// caller completely and perform no ownership check of their own. The uid reaches
// them from the verified token through the existing requireSelfParam('uid')
// guard, which rejects any path parameter that is not req.user.uid. That is the
// same arrangement applications and tasks already use, so no new guard was
// introduced for this resource.

const { admin } = require('../config/firebase');
const employmentRepository = require('../repositories/employmentRepository');

/**
 * A field required to record an employment is missing.
 *
 * Exists for the same reason as TaskValidationError and
 * ApplicationValidationError: so a caller can distinguish "this employment
 * cannot be described" from an unexpected Firestore failure. It is not reachable
 * from the live hire path -- employerId, employeeId, jobId and applicationId all
 * come from the verified token or from documents the authorization guard has
 * already loaded -- so it is a guard on the service's own contract rather than
 * on the HTTP surface, and no route maps it to a status code.
 */
class EmploymentValidationError extends Error {}

/**
 * The canonical employment statuses.
 *
 * An allow-list, not a transition matrix, exactly as APPLICATION_STATUSES is.
 * `active` is the only value written in this stage; `ended` is reserved for the
 * end-employment write that is deliberately deferred. There is no `paused`,
 * `onLeave` or any other value, and nothing here accepts one from a client --
 * there is no client-supplied status on this path at all.
 */
const EMPLOYMENT_STATUSES = ['active', 'ended'];

/** The status a newly recorded employment is created with. */
const ACTIVE_EMPLOYMENT_STATUS = 'active';

/**
 * The one application status that means "this applicant has been hired".
 *
 * STAGE 5G made `accepted` the canonical spelling; `Employed` was the legacy
 * title-cased value the client used to write. middleware/auth.js already
 * reproduces the same single literal for requireTaskAssignment, with the same
 * reasoning: applicationService owns APPLICATION_STATUSES and is not exported,
 * updateApplicationStatus refuses to write anything outside it, and legacy
 * `Employed` documents are not migrated or normalised anywhere server-side. So
 * the only value a server-written application can hold that means "hired" is
 * `accepted`, and a legacy `Employed` application re-submitted for review reads
 * as not-hired until an employer writes `accepted` on it.
 */
const HIRED_APPLICATION_STATUS = 'accepted';

/**
 * The identity fields every employment record must carry.
 *
 * Checked in this order so the message names the first missing field rather than
 * reporting the same generic text four times. `startDate` is deliberately absent
 * from this list: it is required to be *present* but has a computed fallback
 * (resolveStartDate), so it can never be missing.
 */
const REQUIRED_EMPLOYMENT_FIELDS = ['employerId', 'employeeId', 'jobId', 'applicationId'];

/**
 * Decides what an employment's `startDate` is.
 *
 * STAGE 7A. The start date is taken from the job's own `jobStartDate`, because
 * that is the only start date this system holds: `jobs.jobStartDate` is what
 * PostJobForm/EditJobForm submit, and jobService requires it on both create and
 * update, so every job written through the API carries one. It is stored
 * verbatim, not parsed and re-formatted, following the same rule jobService
 * follows for `negotiable` -- the value is persisted as written and read as
 * written.
 *
 * The fallback is defensive rather than expected, and it is here because it makes
 * the write unconditionally valid. Firestore rejects an `undefined` field value,
 * so writing the job's date straight through would turn any job document that
 * happens to lack `jobStartDate` -- one predating that requirement, or written
 * outside jobService -- into a failed hire *after* the application had already
 * been accepted. Instead the date the hire happened is used, committed by
 * Firestore through serverTimestamp(): the same choice Stage 5H made for
 * `tasks.createdDate` and `applications.dateApplied`, so it cannot be skewed by a
 * drifting host clock.
 *
 * CONSEQUENCE, recorded rather than hidden: `startDate` has two possible stored
 * types, a string taken from the job and a Timestamp from the fallback. That
 * variance already exists across this codebase by design (jobs store ISO strings,
 * users/applications/tasks store Timestamps) but it is new *within* a single
 * field, so a reader must cope with both. Normalising to one type would mean
 * either parsing the job's string -- silently reinterpreting a user-entered
 * value -- or discarding the real start date in favour of the hire date, and both
 * are worse than the variance is. It is listed here as a known sharp edge rather
 * than fixed.
 */
const resolveStartDate = (jobStartDate) =>
    (typeof jobStartDate === 'string' && jobStartDate.trim()
        ? jobStartDate
        : admin.firestore.FieldValue.serverTimestamp());

/**
 * Records the employment created by a hire.
 *
 * Called from applicationService.updateApplicationStatus AFTER the application's
 * own status write has succeeded, which is what makes requirement "no employment
 * is created when the hire fails" structural rather than incidental: if the
 * validation above that write rejects the status, or the write itself throws,
 * this function is never reached at all. There is no rollback and no compensating
 * delete, because there is nothing to roll back.
 *
 * Returns `{ employmentId }` on success, and null when the status change is not a
 * hire -- that is the normal answer for the `rejected` writes that make up most of
 * a hire, since ViewJobApplications.jsx restatuses every other applicant to
 * rejected in the same operation.
 *
 * `previousStatus` suppresses a SECOND employment for an application that was
 * already accepted. Stage 5G made the application statuses an allow-list and not
 * a transition matrix, so an employer may write `accepted` to an application that
 * already holds it, any number of times, and the client's in-flight guard only
 * stops two clicks within one tick. Without this check each of those writes would
 * append another employment for one hire. The consequence, accepted here because
 * no transaction is permitted and no repair path is in scope, is that a hire
 * whose employment write FAILED cannot be retried into existence by re-sending
 * the same status: the application is already accepted, so this returns null. A
 * repair path for that case belongs with the employment lifecycle work, not here.
 *
 * An employer who later rejects an application that is recorded as employed does
 * not end the employment; nothing in this stage writes `ended` or an endDate.
 * That is the deferred end-employment write, and it is why this stage adds no
 * update path for the collection.
 */
const createEmploymentFromHire = async ({ applicationId, newStatus, previousStatus, employerId, employeeId, jobId, jobStartDate }) => {
    if (newStatus !== HIRED_APPLICATION_STATUS) return null;
    if (previousStatus === HIRED_APPLICATION_STATUS) return null;

    const context = { employerId, employeeId, jobId, applicationId };
    for (const field of REQUIRED_EMPLOYMENT_FIELDS) {
        if (!context[field]) {
            throw new EmploymentValidationError(`Missing required field: ${field}`);
        }
    }

    const employmentId = await employmentRepository.addEmployment({
        employerId,
        employeeId,
        jobId,
        applicationId,
        startDate: resolveStartDate(jobStartDate),
        // An employment begins open. endDate stays null and status `active` until
        // the end-employment write is added, so nothing here has to invent a
        // termination date or back-date one from the job's expectedEndDate: that
        // field is the job's expectation, not a fact about anyone's employment.
        endDate: null,
        status: ACTIVE_EMPLOYMENT_STATUS,
    });

    return { employmentId };
};

/**
 * Flattens a QuerySnapshot into `{ id, ...data }` objects.
 *
 * The same shape listTasksForEmployee, listTasksForJob and
 * listApplicationsForEmployee all produce: the document id is added and no field
 * is renamed, dropped or reshaped, so what a caller reads back is the stored
 * document byte for byte. That includes startDate in whichever of its two forms
 * resolveStartDate chose -- see the note there.
 */
const toPlainObjects = (snapshot) => {
    const employments = [];

    snapshot.forEach((doc) => {
        employments.push({ id: doc.id, ...doc.data() });
    });

    return employments;
};

/**
 * Every employment held by one employee.
 *
 * AUTHORIZATION: this trusts its caller. `uid` reaches it from the verified token
 * via the existing requireSelfParam('uid') guard in routes/employments.js, which
 * rejects any path parameter that is not req.user.uid with a 403 before the query
 * runs -- the same arrangement listTasksForEmployee uses.
 *
 * An unknown uid returns an empty array rather than a 404: this is a list of the
 * caller's own employments, and "you have none" is not a missing resource.
 *
 * There is deliberately no join to `jobs` or `applications` here. The employment
 * document already carries jobId and applicationId, and adding a per-record read
 * of another collection would buy a UI nothing it cannot fetch itself -- and
 * would repeat the N+1 pattern Stage 4 documented in
 * listApplicationsForEmployee without being asked to.
 */
const listEmploymentsForEmployee = async (uid) => {
    const snapshot = await employmentRepository.listEmploymentsByEmployee(uid);

    return toPlainObjects(snapshot);
};

/**
 * Every employment one employer has offered, as plain objects.
 *
 * The employer-side counterpart of listEmploymentsForEmployee, and the reason an
 * employer can see who they have actually hired rather than inferring it from
 * application statuses.
 *
 * AUTHORIZATION: as above -- requireSelfParam has already compared the path
 * parameter against the verified token. Same `{ id, ...data }` shape and the same
 * "empty list, not 404" rule: an employer who has hired nobody returns [].
 */
const listEmploymentsForEmployer = async (uid) => {
    const snapshot = await employmentRepository.listEmploymentsByEmployer(uid);

    return toPlainObjects(snapshot);
};

module.exports = {
    EmploymentValidationError,
    EMPLOYMENT_STATUSES,
    ACTIVE_EMPLOYMENT_STATUS,
    HIRED_APPLICATION_STATUS,
    createEmploymentFromHire,
    listEmploymentsForEmployee,
    listEmploymentsForEmployer,
};