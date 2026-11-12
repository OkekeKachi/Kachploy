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
//   * listEmploymentsForEmployee / listEmploymentsForEmployer -- the two
//     self-scoped reads.
//   * listEmploymentsForJob / getEmployment -- STAGE 10H.1. The employer's
//     employee-management reads: every employment on one job the caller owns, and
//     one employment the caller is party to. Both are reads; this stage adds no
//     write to the resource.
//   * hasActiveEmploymentForApplication -- STAGE 10H.2. The read behind the rule
//     that an application whose employment is active cannot be moved to
//     `rejected`. It reuses listEmploymentsByApplication; it adds no write and no
//     new lifecycle.
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
 * The referenced employment does not exist. Surfaces as a 404.
 *
 * STAGE 10H.1. Mirrors InterviewNotFoundError and ConversationNotFoundError: the
 * router's requireEmploymentParty guard turns a missing employment into a 404
 * before this class is reached, so it is a backstop for a call made without that
 * guard, exactly as the other single-document reads are. The class and the
 * existence check stay because the service must be correct when called directly.
 */
class EmploymentNotFoundError extends Error {}

/**
 * The canonical employment statuses.
 *
 * An allow-list. `active` is written on creation. `completed` and `terminated`
 * are end states added for the employment lifecycle; `ended` remains supported
 * for backwards compatibility.
 */
const EMPLOYMENT_STATUSES = ['active', 'ended', 'completed', 'terminated'];

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
 * IDEMPOTENCE AND REPAIR. The single guard is the query on the `employments`
 * collection below: an application that already has an employment -- whatever its
 * status -- records no second one. It is the authority rather than an inference
 * from the application's status, because the application statuses are an
 * allow-list and not a transition matrix: an employer may write `accepted` to an
 * application that already holds it, any number of times, and the client's
 * in-flight guard only stops two clicks within one tick. Without the query each of
 * those writes would append another employment for one hire.
 *
 * Because the query, not the application's previous status, decides, re-sending
 * `accepted` for an application that is already accepted but has NO employment
 * records the missing one. That is the repair path for the divergence recorded at
 * the call site: applicationService writes the status and the employment as two
 * independent writes (no transaction), so a failure between them can leave an
 * accepted application with no employment, and a retry now heals it instead of
 * being silently skipped. A retry after a hire whose employment write succeeded is
 * still a no-op: the query finds the existing record and returns null.
 *
 * STAGE 7H-2 introduced the query for the duplicate the old `previousStatus`
 * inference could not see: an application that is rejected and then cleared for
 * hiring and hired again arrives with previousStatus `interviewed`, so an
 * inference from the status alone passed it through, and it used to get a second
 * employment for one hire. Asking the collection instead of inferring from the
 * application is what closes that.
 *
 * An employer who later rejects an application that is recorded as employed does
 * not end the employment; nothing in this stage writes `ended` or an endDate.
 * That is the deferred end-employment write, and it is why this stage adds no
 * update path for the collection.
 */
const createEmploymentFromHire = async ({ applicationId, newStatus, employerId, employeeId, jobId, jobStartDate }) => {
    if (newStatus !== HIRED_APPLICATION_STATUS) return null;

    const context = { employerId, employeeId, jobId, applicationId };
    for (const field of REQUIRED_EMPLOYMENT_FIELDS) {
        if (!context[field]) {
            throw new EmploymentValidationError(`Missing required field: ${field}`);
        }
    }

    // STAGE 7H-2: the authoritative duplicate check.
    //
    // It asks the collection rather than inferring from the application's status.
    // The old `previousStatus` inference was caller-supplied and wrong for any
    // application that passed through `rejected` on its way back, which Stage 7G
    // made reachable from the employer UI: reject, clear for hiring, hire again.
    // That path left two `active` employments for one hire, because the second
    // write saw previousStatus `interviewed` rather than `accepted`. Asking the
    // collection is what closes it -- and, being the only guard, it is also what
    // lets a repeated `accepted` repair a hire whose employment write failed.
    //
    // Deliberately AFTER the required-field loop, so a call that cannot describe an
    // employment still fails on its own validation without spending a read, and
    // BEFORE the add, so at most one document is ever written for an application.
    //
    // Any existing document blocks the add regardless of its status: an `ended`
    // employment still means this application was already hired, and hiring the
    // same applicant again for the same job is properly a new application.
    //
    // NOT A TRANSACTION, and this does not make it one. This is read-before-write:
    // two genuinely concurrent hires of the same application can both observe an
    // empty collection and both write. No transaction is permitted in this stage,
    // and that residual window is the same class of divergence the two-write hire
    // above already records. Closing it needs a transaction or a uniqueness
    // constraint on the document id, both of which belong with the employment
    // lifecycle work rather than here.
    const existing = await employmentRepository.listEmploymentsByApplication(applicationId);
    if (!existing.empty) return null;

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

class EmploymentStateError extends Error {}

const TERMINATION_REASONS = ['mutual', 'employer_initiated', 'employee_initiated', 'contract_breach', 'other'];
const COMPLETION_REASONS = ['completed', 'contract_expired', 'mutual_completion'];

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

/**
 * STAGE 10H.1. Every employment recorded on one job, as plain objects.
 *
 * The employer-side management read: a job may have hired several applicants, so
 * the caller needs every employment the job produced rather than the single one
 * an application read would return. `toPlainObjects` gives each entry the same
 * `{ id, ...document }` shape the other three reads produce.
 *
 * AUTHORIZATION: the service performs none. `jobId` reaches here from the path
 * through requireJobOwner in routes/employments.js, which loads the job and
 * answers 403 unless `job.postedBy === req.user.uid` -- the same guard that
 * already protects GET /applications/job/:jobId and GET /tasks/job/:jobId, so
 * being the job's poster is the one condition, and a client-supplied employer id
 * plays no part. A job with no hires is an empty list, not a 404: the job exists
 * and "nobody has been hired" is not a missing resource.
 *
 * There is deliberately no join to `jobs` or `applications`. The employment
 * document already carries `jobId` and `applicationId`, and a per-record read of
 * another collection would be the N+1 pattern Stage 4 documented, buying the UI
 * nothing it cannot fetch itself.
 */
const listEmploymentsForJob = async (jobId) => {
    const snapshot = await employmentRepository.listEmploymentsByJob(jobId);

    return toPlainObjects(snapshot);
};

/**
 * STAGE 10H.1. One employment by document id, as a plain object.
 *
 * The first single-document read on this collection that is reachable from a
 * route. `getEmploymentById` already existed -- Stage 9C added it for the task
 * guard -- so this reuses it rather than issuing a second kind of lookup.
 *
 * AUTHORIZATION: performed by the router's requireEmploymentParty guard, which
 * has already established that the caller is the employment's employer or its
 * employee, so the 404 below is a backstop for a call made without it -- the same
 * arrangement conversationService.getConversation and taskService.getTask use.
 *
 * The result is `{ id, ...document }`, exactly the shape the four list reads
 * produce, so a single-employment read and its row in a list agree field for
 * field.
 */
const getEmployment = async (employmentId) => {
    const snapshot = await employmentRepository.getEmploymentById(employmentId);

    if (!snapshot.exists) {
        throw new EmploymentNotFoundError('Employment not found');
    }

    return { id: snapshot.id, ...snapshot.data() };
};

const isEmploymentActive = (employment) => {
    if (!employment) return false;
    const status = employment.status;
    return status === ACTIVE_EMPLOYMENT_STATUS || status === 'active';
};

/**
 * Complete an employment (mutual/completion). Both parties can initiate
 * with reasons; prevents duplicate completion/termination.
 */
const completeEmployment = async ({ employmentId, callerId, reason = 'completed', note = '', metadata = {} } = {}) => {
    if (!employmentId) throw new EmploymentValidationError('employmentId is required');
    if (!callerId) throw new EmploymentValidationError('callerId is required');

    const snapshot = await employmentRepository.getEmploymentById(employmentId);
    if (!snapshot.exists) throw new EmploymentNotFoundError('Employment not found');
    const employment = { id: snapshot.id, ...snapshot.data() };

    if (employment.employerId !== callerId && employment.employeeId !== callerId) {
        throw new EmploymentValidationError('Not authorized to complete this employment');
    }

    if (employment.status === 'completed' || employment.status === 'terminated' || employment.status === 'ended') {
        throw new EmploymentStateError('Employment already ended');
    }

    if (!COMPLETION_REASONS.includes(reason)) {
        throw new EmploymentValidationError('Invalid completion reason');
    }

    const updates = {
        status: 'completed',
        completionReason: reason,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
        completedBy: callerId,
        completionNote: typeof note === 'string' ? note : '',
        completionMetadata: metadata || {},
    };

    await employmentRepository.updateEmploymentFields(employmentId, updates);
    const updated = await employmentRepository.getEmploymentById(employmentId);
    return { id: updated.id, ...updated.data() };
};

/**
 * Terminate an employment (early termination). Both parties can initiate
 * with reasons; prevents duplicate completion/termination.
 */
const terminateEmployment = async ({ employmentId, callerId, reason = 'other', note = '', metadata = {} } = {}) => {
    if (!employmentId) throw new EmploymentValidationError('employmentId is required');
    if (!callerId) throw new EmploymentValidationError('callerId is required');

    const snapshot = await employmentRepository.getEmploymentById(employmentId);
    if (!snapshot.exists) throw new EmploymentNotFoundError('Employment not found');
    const employment = { id: snapshot.id, ...snapshot.data() };

    if (employment.employerId !== callerId && employment.employeeId !== callerId) {
        throw new EmploymentValidationError('Not authorized to terminate this employment');
    }

    if (employment.status === 'completed' || employment.status === 'terminated' || employment.status === 'ended') {
        throw new EmploymentStateError('Employment already ended');
    }

    if (!TERMINATION_REASONS.includes(reason)) {
        throw new EmploymentValidationError('Invalid termination reason');
    }

    const updates = {
        status: 'terminated',
        terminationReason: reason,
        terminatedAt: admin.firestore.FieldValue.serverTimestamp(),
        terminatedBy: callerId,
        terminationNote: typeof note === 'string' ? note : '',
        terminationMetadata: metadata || {},
    };

    await employmentRepository.updateEmploymentFields(employmentId, updates);
    const updated = await employmentRepository.getEmploymentById(employmentId);
    return { id: updated.id, ...updated.data() };
};

/**
 * Record settlement/protection state for an ended employment (no payments moved).
 */
const recordEmploymentSettlement = async ({ employmentId, callerId, settlement = {} } = {}) => {
    if (!employmentId) throw new EmploymentValidationError('employmentId is required');
    if (!callerId) throw new EmploymentValidationError('callerId is required');

    const snapshot = await employmentRepository.getEmploymentById(employmentId);
    if (!snapshot.exists) throw new EmploymentNotFoundError('Employment not found');
    const employment = { id: snapshot.id, ...snapshot.data() };

    if (employment.employerId !== callerId && employment.employeeId !== callerId) {
        throw new EmploymentValidationError('Not authorized to update settlement for this employment');
    }

    const updates = {
        settlement: settlement || {},
        settlementUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        settlementUpdatedBy: callerId,
    };

    await employmentRepository.updateEmploymentFields(employmentId, updates);
    const updated = await employmentRepository.getEmploymentById(employmentId);
    return { id: updated.id, ...updated.data() };
};

/**
 * STAGE 10H.2. Whether an application is currently employed -- that is, whether it
 * has an employment whose status is `active`.
 */
const hasActiveEmploymentForApplication = async (applicationId) => {
    const snapshot = await employmentRepository.listEmploymentsByApplication(applicationId);

    return snapshot.docs.some((doc) => {
        const data = doc.data();
        const status = data.status;
        return status === ACTIVE_EMPLOYMENT_STATUS || status === 'active';
    });
};

module.exports = {
    EmploymentValidationError,
    EmploymentNotFoundError,
    EmploymentStateError,
    EMPLOYMENT_STATUSES,
    ACTIVE_EMPLOYMENT_STATUS,
    HIRED_APPLICATION_STATUS,
    TERMINATION_REASONS,
    COMPLETION_REASONS,
    createEmploymentFromHire,
    listEmploymentsForEmployee,
    listEmploymentsForEmployer,
    listEmploymentsForJob,
    getEmployment,
    hasActiveEmploymentForApplication,
    isEmploymentActive,
    completeEmployment,
    terminateEmployment,
    recordEmploymentSettlement,
};