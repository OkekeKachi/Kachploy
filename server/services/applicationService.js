// applicationService.js
//
// Business and data layer for the applications resource (new in Stage 3B). It
// owns every Firestore read/write, the application validation rules and the
// application-specific data shaping that used to live inline in
// controllers/applicationController.js.
//
// Stage 3B is a structural extraction only. The controller is now HTTP-focused:
// it takes identity from req.user, calls exactly one service function, and
// translates the outcome into the status code and body this API has always
// returned. Nothing observable changes, so the defects below are preserved
// deliberately and stay pinned by test/applications.test.js:
//
//   * ~~`isNegotiable` is read but `jobController` writes `negotiable`~~ CLOSED
//     in Stage 5D: `negotiable` is canonical and both price branches now run
//   * ~~`proposals = proposal - 1` stores NaN on the normal path~~ CLOSED in
//     Stage 5E: the arithmetic and the persisted `proposals` field are gone
//   * ~~the parent job's counter is decremented as `proposals` (plural) although
//     the create route writes `proposal` (singular), and nothing increments it~~
//     CLOSED in Stage 5E: the decrement and the `proposal: 0` initialisation are
//     both removed; the applicant count is derived by countApplicationsByJob
//   * ~~withdrawal is a non-atomic decrement-then-delete~~ CLOSED in Stage 5E:
//     withdrawal is a single delete, so there is no second write to be atomic
//     with. The withdrawal is NOT transactional and does not need to be
//   * `dateApplied` is a raw Date while jobs/users use ISO strings or
//     serverTimestamp()
//   * `createTaskFromApplication` duplicates POST /tasks with a different
//     response shape
//
// Stage 5B added the applicant-count read path and closed the Stage 5A IDOR-01
// finding: the applications-by-job list is now owner-guarded in the router, and
// countApplicationsByJob lets the dashboards keep showing per-job counts without
// ever receiving an applicant document.
//
// Stage 4B moved the `applications` persistence out to
// repositories/applicationRepository.js. This service no longer touches the
// applications collection at all: it keeps the validation, the negotiable-price
// branches, the per-record job join, the
// cross-collection orchestration and the error classes, and delegates only the
// applications reads, queries, create, status update and delete. The repository
// returns raw snapshots, so the existence checks and the throws below are still
// made here. No shared error system is introduced: the two error classes exist
// only so the controller can reproduce this resource's existing 400/404 bodies.
//
// The Firebase import stays on purpose. Two Firestore calls in this file are not
// applications persistence and remain inline: applyToJob reads a job for
// `negotiable`, and listApplicationsForEmployee reads one job per application
// (the N+1 read, deliberately unoptimised). Moving any of those is
// out of scope for Stage 4B. createTaskFromApplication's `tasks` add stays too,
// since this repository covers the applications collection only. Stage 5E
// removed the third one -- withdrawApplication's parent-job counter write -- so
// the `admin` import went with it. Stage 5H brought it back for one reason:
// applyToJob needs `admin.firestore.FieldValue.serverTimestamp()`.
//
// STAGE 7A added the `employmentService` import, which is the only new
// dependency in this file and the only cross-collection call it makes in the
// hire path. It is imported here rather than in the controller on purpose:
// recording the employment is business orchestration that follows the status
// write, and the controllers in this codebase stay HTTP-only with one service
// call per handler. The `employments` collection itself is reached exclusively
// through employmentRepository from employmentService -- this file never names
// the collection. See updateApplicationStatus for the integration point.

const { db, admin } = require('../config/firebase');
const applicationRepository = require('../repositories/applicationRepository');
const employmentService = require('./employmentService');

/**
 * A field required by an endpoint is missing. Surfaces as a 400 carrying this
 * exact message, which is why the wording lives on the throw site: the two
 * endpoints word their 400s differently ("Missing required fields" vs
 * "Status is required") and both are asserted by the tests.
 */
class ApplicationValidationError extends Error {}

/**
 * The referenced job or application document does not exist. Surfaces as a 404.
 * The message is carried on the instance because this resource uses two
 * different strings for it: "Job not found" on apply, "Application not found"
 * on withdraw.
 */
class ApplicationNotFoundError extends Error {}

/**
 * Records an application from `employeeId` against a job.
 *
 * The applicant is always passed in from the verified token by the controller,
 * so an `employeeId` in the request body can never be honoured.
 *
/**
 * Interprets the canonical `negotiable` field as a boolean.
 *
 * STAGE 5D. `negotiable` is the one canonical name for this concept: it is what
 * jobService.createJob and jobService.updateJob have always persisted, and what
 * PostJobForm/EditJobForm have always submitted. Nothing in this codebase has
 * ever written `isNegotiable` -- it was a read-side name that never matched a
 * persisted field, so every price branch in applyToJob was dead code.
 *
 * The stored value is the raw string `"yes"` or `"no"`, produced by the
 * `<select>` in both job forms and passed through jobService untouched. That
 * value is deliberately NOT normalised to a boolean: it is persisted as written
 * and read as written. This helper only exists so the two comparisons in
 * applyToJob read as intent rather than as string-truthiness, because `"no"` is
 * a non-empty string and would be truthy.
 *
 * A non-string `true` is still honoured so a document written with a real
 * boolean keeps behaving as negotiable. Anything else -- including an absent
 * field -- is treated as NOT negotiable, which is the conservative direction:
 * a job we cannot read as negotiable is served at its fixed price, and a
 * stray `employeePrice` is rejected rather than silently accepted.
 */
const isNegotiableJob = (jobData) => {
    const value = jobData.negotiable;

    if (typeof value === 'string') {
        return value === 'yes';
    }

    return value === true;
};

/**
 * Submits an application.
 *
 * The applicant is always passed in from the verified token by the controller,
 * so an `employeeId` in the request body can never be honoured.
 *
 * BUG (Stage 3), CLOSED in Stage 5E: this used to compute
 * `proposals = proposal - 1` and persist it on the application. The client
 * sent `proposal: job.proposals`, a job field that no write path has ever
 * created, so the normal result was a NaN written to the database, and a
 * numeric result was a client-supplied value stored without any server-side
 * computation. Nothing read the field. The arithmetic, the input and the
 * persisted field are all gone; `employeePrice` is untouched.
 *
 * STAGE 5D: both price branches below are now reachable. They previously read
 * `jobData.isNegotiable`, a field no write path has ever persisted, so the
 * "negotiable" job stored `employeePrice: null`, the `<= 0` guard never ran,
 * and the non-negotiable rejection never fired. They read the canonical
 * `negotiable` field through isNegotiableJob instead.
 */
const applyToJob = async (payload, employeeId) => {
    const { jobId, fullName, message, employeePrice } = payload;

    if (!jobId || !employeeId) {
        throw new ApplicationValidationError('Missing required fields');
    }

    // Get the job from the database to check if it is negotiable
    const jobRef = db.collection('jobs').doc(jobId);
    const jobSnapshot = await jobRef.get();

    if (!jobSnapshot.exists) {
        throw new ApplicationNotFoundError('Job not found');
    }

    const jobData = jobSnapshot.data();
    const jobIsNegotiable = isNegotiableJob(jobData);

    // If the job is negotiable, store the employee's requested price
    if (jobIsNegotiable && employeePrice != null) {
        // Optionally, validate the employee price, e.g., check if it's greater than 0
        if (employeePrice <= 0) {
            throw new ApplicationValidationError('Invalid price. It must be greater than 0.');
        }
    } else if (!jobIsNegotiable && employeePrice != null) {
        // If the job is not negotiable, reject the price field
        throw new ApplicationValidationError('This job is not negotiable, price cannot be provided.');
    }

    // Add application data
    await applicationRepository.addApplication({
        jobId,
        employeeId,
        fullName,
        message: message || '',
        employeePrice: jobIsNegotiable ? employeePrice : null, // Only store employeePrice if the job is negotiable
        // STAGE 5H: was `new Date()`, which took its value from the Node process
        // clock rather than from Firestore's. The field name and the API shape are
        // unchanged -- Firestore turns both forms into a Timestamp -- but the
        // value is now committed server-side, so it cannot be skewed by a drifting
        // host clock. `users.createdAt` already used serverTimestamp(); this
        // brings the last process-clock instant in this service in line.
        dateApplied: admin.firestore.FieldValue.serverTimestamp(),
        // STAGE 5G: the server owns this field. The client used to send
        // `status: "pending"` in the apply body (JobDetails.jsx) and it was
        // already discarded here; the send has been removed so the body does not
        // imply a write that never happened. A new application is always pending.
        status: "pending"
    });
};

/**
 * Lists one applicant's applications, each joined with its parent job.
 *
 * PERFORMANCE (Stage 4): one sequential job read per application (N+1).
 * db.getAll() or a batch would collapse this into a single round trip.
 *
 * The console.log(applications) debug output this function used to emit was
 * removed in Stage 6Z. It printed the whole joined application list, so every
 * applicant's fullName, message and job data went to stdout on each request.
 * No test asserted on it -- the harness only filters morgan's HTTP lines -- so
 * removing it changes no behaviour and no response shape.
 */
const listApplicationsForEmployee = async (uid) => {
    const snapshot = await applicationRepository.listApplicationsByEmployee(uid);

    const applications = [];

    for (const doc of snapshot.docs) {
        const data = doc.data();

        // Fetch job details too
        const jobDoc = await db.collection('jobs').doc(data.jobId).get();
        const jobData = jobDoc.exists ? jobDoc.data() : null;

        applications.push({
            id: doc.id,
            ...data,
            job: jobData,
        });
    }

    return applications;
};

/**
 * Counts how many applications each job has, as a plain `{ jobId: count }` map.
 *
 * Added in Stage 5B as the count-only replacement for the dashboards' per-job
 * `listApplicationsForJob` calls, which existed solely to read `.length` and
 * which returned every applicant's PII to any authenticated caller.
 *
 * PRIVACY: nothing but a number leaves this function. No document, no
 * `employeeId`, no `fullName`, no `employeePrice`, no status and no message is
 * included in the returned map, so no downstream handler can leak them by
 * accident. The aggregation itself is business/data shaping, so it lives here
 * rather than in the repository, which only issues the read.
 *
 * SCOPE (Stage 5B decision): the map covers every job in the collection rather
 * than only the caller's own jobs, because the employee dashboard displays a
 * count for jobs it does not own and there is no identity-scoped source for
 * those. What is exposed is one integer per job -- an aggregate that discloses
 * no applicant identity -- and `GET /jobs` already exposes every job document to
 * every authenticated caller. If a future product decision requires
 * employer-scoped counts only, the employee dashboard's per-job count would have
 * to be removed rather than this function narrowed, because the underlying read
 * would still be a full collection scan.
 *
 * A job with zero applications is simply absent from the map; callers default it
 * to 0. That matches the dashboards' previous `|| 0` behaviour.
 */
const countApplicationsByJob = async () => {
    const snapshot = await applicationRepository.listAllApplications();

    const counts = {};

    snapshot.forEach(doc => {
        const { jobId } = doc.data();
        if (jobId === undefined) return;
        counts[jobId] = (counts[jobId] || 0) + 1;
    });

    return counts;
};

/**
 * Lists every application for one job.
 *
 * AUTHORIZATION (Stage 5B): the caller must be the employer who posted the job.
 * The route runs middleware's requireJobOwner, which compares
 * `job.postedBy` against `req.user.uid` and 404s a missing job or 403s a
 * non-owner. The service itself is unchanged and still returns the full document
 * shape the employer page needs.
 *
 * The former caller set -- any authenticated user -- was the Stage 5A IDOR-01
 * finding; the count-only path above exists so dashboards no longer depend on
 * this endpoint.
 */
const listApplicationsForJob = async (jobId) => {
    const snapshot = await applicationRepository.listApplicationsByJob(jobId);

    const applications = [];

    snapshot.forEach(doc => {
        applications.push({ id: doc.id, ...doc.data() });
    });

    return applications;
};

/**
 * The canonical application statuses.
 *
 * STAGE 5G. The value used to be unvalidated, so a client could store any string
 * at all (`test/applications.test.js` pinned that with `{ status: 'anything' }`).
 * The two values the product actually has are `accepted` and `rejected`; the
 * client previously wrote the title-cased `Employed` and `Not Hired` instead,
 * while the server defaulted new applications to lowercase `pending`, so three
 * casings of the same three ideas were in circulation. `pending` completes the
 * set because it is what applyToJob writes.
 *
 * This is a value allow-list, not a transition matrix: an employer may still
 * move an application between any two of these repeatedly. `Employed` and
 * `Not Hired` are deliberately NOT accepted on write -- they are the legacy
 * spellings of `accepted` and `rejected`, and they are still read for display
 * compatibility (see the components), never written again.
 *
 * `paused` is not a job status and is not introduced here; `tasks` statuses are
 * out of scope.
 *
 * ---------------------------------------------------------------------------
 * STAGE 7G-1: `interviewed`, the state between applied and hired.
 *
 * The lifecycle this now enforces is four values wide:
 *
 *   pending      applied, not yet cleared for hiring
 *   interviewed  the interview process is done; the applicant may now be hired
 *   accepted     hired
 *   rejected     not hired
 *
 * `interviewed` exists because `accepted` already means two different things --
 * "hired" to employmentService and to requireTaskAssignment, and "the winning
 * application" to the employer's restatus-everyone sweep -- and because nothing
 * in the model previously represented "the interview happened". Without it an
 * employer can hire an applicant straight from `pending`, with no interview
 * having been scheduled, held or completed.
 *
 * It is a value allow-list, like the rest: an employer may still move an
 * application between any two of these repeatedly. What stops a premature hire is
 * not a transition matrix but the one rule in updateApplicationStatus below.
 *
 * It is written by an explicit employer action, NOT derived from an interview's
 * status. That is deliberate: deriving it would mean interviewService writing to
 * the applications collection, inverting the deliberate isolation between the two
 * domains (interviewService.js, "WHAT DELIBERATELY DOES NOT EXIST YET", pinned by
 * interviews.test.js), and it would make cancelling or rescheduling a second
 * interview silently revoke eligibility.
 */
const APPLICATION_STATUSES = ['pending', 'interviewed', 'accepted', 'rejected'];

/**
 * STAGE 7G-1: the value that means the applicant is cleared for hiring.
 *
 * This service owns the lifecycle, so it owns this name. `accepted` is NOT
 * re-spelled here: employmentService already exports the constant that means
 * "hired" and owns the employment consequence of it, and duplicating the literal
 * here would be the same drift auth.js:36 documents when it reproduces its own
 * copy for requireTaskAssignment. There is now one owner for both values.
 */
const INTERVIEWED_APPLICATION_STATUS = 'interviewed';
const HIRED_APPLICATION_STATUS = employmentService.HIRED_APPLICATION_STATUS;

/**
 * Sets an application's status.
 *
 * STAGE 5G: the value is now checked against APPLICATION_STATUSES. An unknown,
 * empty or missing value is a 400 through the existing ApplicationValidationError
 * path, which is the same class and the same wording this function has always
 * used for a missing status, so no new error shape is introduced.
 *
 * A missing value is still rejected first, which keeps the original
 * 'Status is required' message for `{}` rather than reporting it as an
 * unrecognised status.
 *
 * The console.log("heyyy") that used to sit between the write and the return was
 * removed in Stage 7B, leaving the two writes -- the status update and, on a hire,
 * the employment record -- as the only work this function does. It was pure debug
 * output: no test asserted on it (the harness only filters morgan's HTTP lines),
 * it carried no information the caller could use, and it never ran on a failure
 * path. Removing it changes no status code, no response body and no write.
 *
 * The router's requireApplicationReviewer guard is what turns a missing
 * application into a 404 before this runs, which is why there is no existence
 * check here.
 *
 * ---------------------------------------------------------------------------
 * STAGE 7A: the hire-flow integration point.
 *
 * `hireContext` is optional and defaults to null, so the function's existing
 * two-argument contract -- and the response shape, status code and error bodies
 * the applications tests pin -- are unchanged for any caller that does not supply
 * one. The single live caller (applicationController.updateApplicationStatus)
 * always does, passing only facts the requireApplicationReviewer guard has
 * already loaded and verified: employerId from the verified token,
 * employeeId/jobId from the application document, jobStartDate from the job, and
 * previousStatus from the application as it stood before this write. No client
 * field is read here, so a caller cannot choose who is employed.
 *
 * WHY HERE. Accepting an application IS the hire, in this codebase's own terms:
 * `accepted` is the only application status that means hired
 * (middleware/auth.js's requireTaskAssignment already gates task assignment on
 * it, and HiredJobs.jsx/MyApplications.jsx render it as employment). The hire
 * itself is a three-call sequence orchestrated by the client
 * (ViewJobApplications.jsx changeStatus): restatus every applicant, create the
 * task, then mark the job filled. This write is the only step that identifies both
 * parties unambiguously -- the task step names an assignee without naming an
 * application, and the job-status step names neither -- so it is the only place
 * an employment can be built with all four of its identity fields.
 *
 * WHY IT CANNOT CREATE ONE FOR A FAILED HIRE: it runs strictly after the status
 * write has resolved. An unknown status, a missing status, a 403 from the guard
 * and a failed write all return or throw before this block is entered, so
 * "no employment when the hire fails" is structural rather than a rollback.
 *
 * NO TRANSACTION, deliberately (Stage 7A forbids adding one). The status write and
 * the employment add are therefore two independent writes that can diverge if the
 * process dies between them: an application can be accepted with no employment.
 * A transaction would close that window but would also change the observable
 * behaviour of this endpoint, which is out of scope.
 *
 * WHY A FAILURE HERE IS LOGGED AND SWALLOWED. The hire has already succeeded by
 * this point -- the application is accepted -- so rethrowing would report a
 * completed hire as a failed one. The client would then render "the hire did not
 * complete", re-send the same status, and (because the application is already
 * accepted) get no employment either time: a loud, wrong error with no repair
 * path. The write failure is logged instead, so it stays observable in the server
 * log rather than becoming a false client-side failure. A repair path belongs with
 * the deferred employment lifecycle work.
 *
 * ---------------------------------------------------------------------------
 * STAGE 7G-1: the hire gate.
 *
 * `accepted` is refused unless the application's current status is
 * `interviewed` or is already `accepted`. That is the whole of the lifecycle
 * rule: an employer cannot hire an applicant who has not been cleared for hiring,
 * and re-sending `accepted` for a hire that already happened stays idempotent.
 *
 * WHY THE CURRENT STATUS IS READ HERE RATHER THAN TAKEN FROM hireContext.
 * hireContext carries previousStatus, and using it would cost no read -- but it
 * is optional and defaults to null, so a caller that omits it would bypass the
 * rule entirely, and the rule would be enforced only as far as one caller
 * cooperates. A lifecycle invariant that a caller can switch off by passing fewer
 * arguments is not enforcement. The status is therefore read from the application
 * document, which makes the gate unbypassable on the service's own terms.
 *
 * WHY THE READ IS NARROWED TO `accepted`. Every other status write is unaffected
 * by the rule, so rejecting, clearing or re-listing an application must not pay
 * for a read it does not need -- and must not gain a new failure mode. The read
 * is issued only on the one branch that has a precondition to check.
 *
 * WHY A MISSING DOCUMENT SKIPS THE GATE. The gate has nothing to say about an
 * application that is not there, and the router's requireApplicationReviewer has
 * already turned that into a 404 before this runs. Skipping it leaves the write
 * itself to fail exactly as it did before this stage, rather than replacing a
 * not-found outcome with a validation error.
 *
 * NO TRANSACTION, unchanged: the status write and the employment add remain two
 * independent writes, with the divergence window Stage 7A recorded.
 */
const updateApplicationStatus = async (applicationId, newStatus, hireContext = null) => {
    if (!newStatus) throw new ApplicationValidationError('Status is required');

    if (!APPLICATION_STATUSES.includes(newStatus)) {
        throw new ApplicationValidationError(
            `Invalid status. Must be one of: ${APPLICATION_STATUSES.join(', ')}.`
        );
    }

    if (newStatus === HIRED_APPLICATION_STATUS) {
        const snapshot = await applicationRepository.getApplicationById(applicationId);

        if (snapshot.exists) {
            const currentStatus = snapshot.data().status;
            const alreadyHired = currentStatus === HIRED_APPLICATION_STATUS;
            const clearedForHiring = currentStatus === INTERVIEWED_APPLICATION_STATUS;

            if (!alreadyHired && !clearedForHiring) {
                const described = currentStatus === undefined ? 'unset' : `"${currentStatus}"`;
                throw new ApplicationValidationError(
                    `Cannot mark an application as hired while its status is ${described}. `
                    + `An application must be "${INTERVIEWED_APPLICATION_STATUS}" before it can be hired.`
                );
            }
        }
    }

    await applicationRepository.updateApplicationStatusField(applicationId, newStatus);

    if (hireContext) {
        try {
            await employmentService.createEmploymentFromHire({
                ...hireContext,
                applicationId,
                newStatus,
            });
        } catch (err) {
            console.error('Hire succeeded but no employment record was written:', err);
        }
    }
};

/**
 * Withdraws an application.
 *
 * STAGE 5E: this used to decrement `proposals` (plural) on the parent job, a
 * field jobService.createJob never initialised -- it wrote `proposal`
 * (singular), hardcoded to 0 and never incremented. Firestore therefore
 * created `proposals: -1` on the first withdrawal and drove it further negative
 * from there, on a counter that no code read and that `POST /jobs/create`
 * ignored from the client's input. The whole write is gone.
 *
 * Consequence worth recording: the job-update-then-delete pair was not atomic,
 * so a failure between the two writes could leave the counter decremented with
 * the application still present. That class of inconsistency disappears with the
 * counter. The withdrawal is now the single write it always should have been.
 * No transaction is introduced.
 *
 * The applicant count is not a stored number: it is derived per job from the
 * `applications` collection by countApplicationsByJob, which is what
 * GET /applications/counts serves. Deleting the application is what changes the
 * count, so there is nothing to keep in sync.
 *
 * Existing job documents may still carry `proposal` and `proposals` keys from
 * before this change. They are not read, not written and not deleted; removing
 * them from stored documents would be a migration and is deliberately not done.
 */
const withdrawApplication = async (applicationId) => {
    const appSnap = await applicationRepository.getApplicationById(applicationId);

    if (!appSnap.exists) {
        throw new ApplicationNotFoundError('Application not found');
    }

    // Delete the application
    await applicationRepository.deleteApplicationById(applicationId);
};

/**
 * Creates a task from an application.
 *
 * DEAD CODE: a duplicate of POST /tasks (taskController.createTask), never
 * called by the client -- ViewJobApplications.jsx posts to /tasks. It survives
 * Stage 1 only because both paths now share the requireTaskAssignment guard.
 * Removal is scheduled for Stage 7.
 *
 * Not identical to taskController.createTask: this uses .add() and returns no
 * taskId, so its response shape differs. Merging them would change a response
 * shape, so both are kept.
 *
 * QUIRK (preserved): `employeeId` is taken from the request payload, not from
 * the verified token. The router's requireTaskAssignment guard is what
 * authorises it -- it checks the caller may assign that employee to the job --
 * so switching this to req.user.uid would change which assignments are
 * accepted for multi-employee jobs.
 */
const createTaskFromApplication = async (payload) => {
    const { jobId, employeeId, taskName, taskDescription, dueDate } = payload;

    // Adding the new task to the 'tasks' collection
    await db.collection('tasks').add({
        jobId,
        employeeId,
        taskName,
        taskDescription,
        dueDate,
        // STAGE 5H: same change, and for the same reason, as the `createdDate`
        // taskService writes for POST /tasks. This is the identical field in the
        // identical collection, so leaving it on the process clock would have
        // meant two endpoints stamping `tasks.createdDate` from two different
        // clocks -- the inconsistency this stage removes.
        createdDate: admin.firestore.FieldValue.serverTimestamp(),
    });
};

module.exports = {
    ApplicationValidationError,
    ApplicationNotFoundError,
    applyToJob,
    listApplicationsForEmployee,
    listApplicationsForJob,
    countApplicationsByJob,
    updateApplicationStatus,
    withdrawApplication,
    createTaskFromApplication,
};
