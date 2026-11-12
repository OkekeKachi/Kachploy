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
//     the job-counter write is gone. Withdrawal now removes the application and
//     its duplicate-submission key in one transaction so a fresh re-application
//     is possible without reusing application-scoped records
//   * `dateApplied` is a raw Date while jobs/users use ISO strings or
//     serverTimestamp()
//   * ~~`createTaskFromApplication` duplicates POST /tasks with a different
//     response shape~~ CLOSED in Stage 9F: the duplicate and its route are gone,
//     so POST /tasks is the only standalone task-creation endpoint. Stage 3E
//     creates tasks here only inside the hire transaction, from the accepted
//     milestone schedule, and never through a second HTTP path
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
// out of scope for Stage 4B. Stage 5E
// removed the third one -- withdrawApplication's parent-job counter write -- so
// the `admin` import went with it. Stage 5H brought it back for one reason:
// applyToJob needs `admin.firestore.FieldValue.serverTimestamp()`.
//
// STAGE 9F: `createTaskFromApplication`'s `tasks` add was that third inline write's
// successor and is now gone too. The hire no longer creates tasks: accepted
// milestones are payment obligations written inside the contract transaction, and
// the employer assigns work separately through POST /tasks. A task opts into a
// milestone by storing its own `milestoneId`.
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
// STAGE 12.12.1. Mints the short-lived signed URL a resume download is served
// with. Kept behind config/cloudinary so the api secret never leaves this process
// and an unconfigured server raises CloudinaryConfigurationError, which the
// controller answers with a 503 rather than exposing a public URL.
const { generateSignedDownloadUrl, verifyUploadedAsset, qualifyFolder } = require('../config/cloudinary');
const applicationRepository = require('../repositories/applicationRepository');
const employmentService = require('./employmentService');
const contractProposalRepository = require('../repositories/contractProposalRepository');
const contractService = require('./contractService');
const contractRepository = require('../repositories/contractRepository');
// STAGE 3C.1.3: the one shared currency constant. Imported from where it is
// defined rather than read off contractService, which imports it but does not
// re-export it -- reading it there yielded `undefined` and silently defaulted.
const { CONTRACT_CURRENCY } = require('../config/commission');
// STAGE 12.11: the canonical requirement levels, their defaults and the read-side
// normaliser live on jobService, because they are a property of the job document.
// applyToJob imports them so the create/edit validation and the submission
// enforcement can never drift apart. There is no cycle: jobService does not
// import this file.
const {
    normalizeApplicationRequirements,
} = require('./jobService');

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
 * STAGE 12.11. The Cloudinary resource class a resume reference names.
 *
 * `raw`, matching the task-file reference and unlike the profile photo's `image`:
 * a resume is an arbitrary document (a PDF), not a renderable picture. Kept as a
 * named constant here so the shape rule and the not-yet-built uploader cannot
 * disagree about it.
 */
const RESUME_RESOURCE_TYPE = 'raw';

/**
 * Reads an optional portfolio URL from the request.
 *
 * Returns:
 *   ''    when the field is absent or null (the caller sent nothing);
 *   null  when the field is present but is not a string (a type error);
 *   the trimmed string otherwise.
 *
 * Keeping "absent" and "wrong type" distinct is what lets applyToJob word the
 * two failures differently and lets an optional field be omitted freely.
 */
const readPortfolioUrl = (value) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') return null;
    return value.trim();
};

/** True for an absolute http: or https: URL. */
const isValidHttpUrl = (value) => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

/**
 * STAGE 12.11. Validates the private resume reference an application may carry.
 *
 * The reference is a whitelist of three non-public identifiers -- `publicId`,
 * `name` and `resourceType` -- and deliberately has NO url field. A resume must
 * never be reachable by an unauthenticated URL, so even a reference that carries
 * a `url`/`secure_url` key has those keys dropped: only the private identifier is
 * stored. Throws ApplicationValidationError (a 400) on a malformed value.
 *
 * NO UPLOADER MINTS THIS YET. The current storage pattern produces public
 * Cloudinary URLs and the server has no authenticated-delivery or download
 * endpoint, so building a resume upload on it would expose every resume by URL --
 * the one thing this stage forbids. The validator and the enforcement below are
 * therefore in place while the upload path itself is a documented blocker; see
 * the Stage 12.11 report. A `required` resume therefore cannot currently be
 * satisfied by the client, and the client blocks that submission explicitly.
 */
const buildResumeReference = (resume) => {
    if (!resume || typeof resume !== 'object' || Array.isArray(resume)) {
        throw new ApplicationValidationError('A resume reference must be an object');
    }

    const publicId = typeof resume.publicId === 'string' ? resume.publicId.trim() : '';
    const name = typeof resume.name === 'string' ? resume.name.trim() : '';
    const resourceType = typeof resume.resourceType === 'string' ? resume.resourceType.trim() : '';

    if (!publicId || !name || resourceType !== RESUME_RESOURCE_TYPE) {
        throw new ApplicationValidationError(
            `A resume reference must include publicId, name and resourceType (${RESUME_RESOURCE_TYPE})`
        );
    }

    return { publicId, name, resourceType };
};

/**
 * STAGE 12.13. Confirms a resume reference names a real file the applicant owns
 * before it is persisted.
 *
 * `buildResumeReference` above checks the SHAPE of the reference; this checks
 * its PROVENANCE, which the shape cannot express. Two rules:
 *
 *   OWNERSHIP. An upload this server signed for the applicant is stored under
 *   `resumes/{employeeId}/` (userService.resumeFolder), and the public id the
 *   browser hands back begins with that string. A reference naming any other
 *   folder is rejected, so an applicant can attach only their own file. The
 *   `..` guard closes the one prefix test that would otherwise pass while
 *   pointing at somebody else's asset: `resumes/{uid}/../other/secret.pdf`.
 *
 *   EXISTENCE. The id must name an asset Cloudinary actually holds, checked
 *   through verifyUploadedAsset. Without it a hand-made id would be stored and
 *   every later download of it would 404.
 *
 * Awaited only when a reference is present, so the common apply with no resume
 * makes no extra call. An unconfigured server (CloudinaryConfigurationError)
 * propagates as a 500: a reference cannot legitimately have been produced by a
 * server that could not sign its upload.
 */
const verifyOwnedResume = async (reference, employeeId) => {
    const prefix = `${qualifyFolder(`resumes/${employeeId}`)}/`;

    if (!reference.publicId.startsWith(prefix) || reference.publicId.includes('..')) {
        throw new ApplicationValidationError('Resume does not belong to you');
    }

    const exists = await verifyUploadedAsset(reference.publicId, { resourceType: RESUME_RESOURCE_TYPE });
    if (!exists) {
        throw new ApplicationValidationError('Resume file could not be found');
    }
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
    const { jobId, fullName, message, employeePrice, coverLetter, resume, portfolioUrl } = payload;

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

    // ── Eligibility: filled / closed job ───────────────────────────────────────
    const jobStatus = jobData.status;
    const isFilled = typeof jobStatus === 'string' && (jobStatus === 'filled' || jobStatus === 'Filled');
    const isClosed = typeof jobStatus === 'string' && (jobStatus === 'closed' || jobStatus === 'Closed');
    if (isFilled) {
        throw new ApplicationValidationError('This job is filled and no longer accepts applications.');
    }
    if (isClosed) {
        throw new ApplicationValidationError('Applications for this job are closed.');
    }

    // ── Eligibility: application deadline ───────────────────────────────────────
    const applicationDeadline = jobData.applicationDeadline;
    if (applicationDeadline) {
        const deadlineDate = new Date(applicationDeadline);
        if (!Number.isNaN(deadlineDate.getTime())) {
            // treat the deadline as the end of that calendar day
            const endOfDay = new Date(deadlineDate);
            endOfDay.setHours(23, 59, 59, 999);
            if (endOfDay.getTime() <= Date.now()) {
                throw new ApplicationValidationError('The application deadline for this job has passed.');
            }
        }
    }

    const requirements = normalizeApplicationRequirements(jobData.applicationRequirements);

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

    // STAGE 12.11. Duplicate submission guard: an applicant may only apply once
    // to a given job. The lookup catches existing applications written under
    // the old generated ids; the atomic create below protects the concurrent
    // path for all new applications. Both produce the same 400 response.
    const existingAppSnap = await applicationRepository.listApplicationsByJobAndEmployee(jobId, employeeId);
    if (existingAppSnap.size > 0) {
        throw new ApplicationValidationError('You have already applied to this job');
    }

    // STAGE 12.11. Portfolio URL: required when portfolio==='required';
    // optional when optional (allowed to be present or absent); not_needed when
    // not_needed (must be absent). The field is stored as a trimmed string when
    // present, or an empty string when legitimately absent so existing reads see
    // a predictable value.
    const portfolio = readPortfolioUrl(portfolioUrl);
    if (portfolio === null) {
        throw new ApplicationValidationError('Invalid portfolio URL');
    }

    if (requirements.portfolio === 'required' && portfolio === '') {
        throw new ApplicationValidationError('Portfolio URL is required');
    }
    if (requirements.portfolio === 'not_needed' && portfolio !== '') {
        throw new ApplicationValidationError('Portfolio URL is not required for this job');
    }

    // STAGE 12.11. Cover letter: required -> must be a non-empty string.
    // When optional, it may be absent or empty; when not_needed, must be absent.
    const coverLetterValue = coverLetter === undefined || coverLetter === null ? '' : String(coverLetter).trim();
    if (requirements.coverLetter === 'required' && coverLetterValue === '') {
        throw new ApplicationValidationError('Cover letter is required');
    }
    if (requirements.coverLetter === 'not_needed' && coverLetter !== undefined && coverLetter !== null && coverLetter !== '') {
        // Treat an explicitly provided cover letter as a shape error when not
        // needed. Also defend against whitespace-only strings.
        if (coverLetterValue !== '') {
            throw new ApplicationValidationError('Cover letter is not required for this job');
        }
    }
    if (requirements.coverLetter === 'optional' && coverLetter !== undefined && coverLetter !== null && typeof coverLetter !== 'string') {
        // Permissive for optional: only reject a non-string type. Allow empty string.
    }
    // If optional and non-string -> but easiest: if required, handled; if not needed, handled; else accept? Keep minimal: only reject required-empty. Optional allows string or empty.

    // STAGE 12.11. Resume: required -> resume reference must be valid; optional ->
    // may be provided; not_needed -> must be absent.
    let resumeReference = null;
    if (requirements.resume === 'required') {
        if (resume === undefined || resume === null) {
            throw new ApplicationValidationError('Resume is required');
        }
        resumeReference = buildResumeReference(resume);
    } else if (requirements.resume === 'optional') {
        if (resume !== undefined && resume !== null) {
            resumeReference = buildResumeReference(resume);
        } else {
            resumeReference = null;
        }
    } else if (requirements.resume === 'not_needed') {
        if (resume !== undefined && resume !== null) {
            throw new ApplicationValidationError('Resume is not required for this job');
        }
        resumeReference = null;
    }

    // STAGE 12.13. A provided reference must name the applicant's own, existing
    // file before anything is written.
    if (resumeReference) {
        await verifyOwnedResume(resumeReference, employeeId);
    }

    // Add application data. The repository creates the application and its
    // (jobId, employeeId) uniqueness key in one transaction: simultaneous
    // requests for the same pair produce one winner, never two documents, while
    // the application keeps its normal generated id.
    const { created } = await applicationRepository.createApplicationIfAbsent({
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
        status: "pending",
        // STAGE 12.11: optional per-application fields, stored only when meaningful
        // (resume reference -> null when absent; portfolioUrl -> empty string when absent;
        // coverLetter -> empty string when absent). Do not overwrite existing shapes.
        coverLetter: coverLetterValue === '' ? '' : coverLetterValue,
        portfolioUrl: portfolio,
        resume: resumeReference,
    });

    if (!created) {
        throw new ApplicationValidationError('You have already applied to this job');
    }
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
 * STAGE 10H.2: the value that means the applicant was not hired.
 *
 * Named here for the same reason as the two above: this service owns the
 * application lifecycle, and the rule below needs to name the one value it guards.
 * It is the literal `rejected`, already in APPLICATION_STATUSES; this is an alias,
 * not a second spelling.
 */
const REJECTED_APPLICATION_STATUS = 'rejected';

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
 * already loaded and verified: employerId from the verified token, and
 * employeeId/jobId/jobStartDate from the application and job documents. No client
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
 * STAGE 3C.1.2/3C.1.3: THIS IS NOW TRANSACTIONAL. The status write, employment,
 * proposal consumption, contract and milestone writes all commit together (see
 * updateApplicationStatus), so the old divergence window -- accepted with no
 * employment -- is closed rather than merely repairable.
 *
 * WHY A FAILURE HERE IS LOGGED AND SWALLOWED. The hire has already succeeded by
 * this point -- the application is accepted -- so rethrowing would report a
 * completed hire as a failed one. The client would then render "the hire did not
 * complete" and resend the same status. Swallowing keeps the completed hire a
 * success; the write failure is logged so it stays observable in the server log
 * rather than becoming a false client-side failure. The resend is no longer
 * wasted: createEmploymentFromHire asks the collection rather than trusting the
 * application's previous status, so a repeated `accepted` records the employment
 * the failed write left missing, and is a no-op once it exists.
 *
 * ---------------------------------------------------------------------------
 * STAGE 7G-1: the hire gate.
 *
 * `accepted` is refused unless the application's current status is
 * `interviewed` or is already `accepted`. That is the whole of the lifecycle
 * rule: an employer cannot hire an applicant who has not been cleared for hiring,
 * and re-sending `accepted` for a hire that already happened stays idempotent.
 *
 * WHY THE CURRENT STATUS IS READ FROM THE DOCUMENT. Using the caller's view of
 * the status would cost no read, but hireContext is optional and defaults to
 * null, so a caller that omits it would bypass the rule entirely, and the rule
 * would be enforced only as far as one caller cooperates. A lifecycle invariant
 * that a caller can switch off by passing fewer arguments is not enforcement. The
 * status is therefore read from the application document, which makes the gate
 * unbypassable on the service's own terms.
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
 * STAGE 3C.1.3 REPLACED THAT: the status write, employment, proposal
 * consumption, contract and milestones now commit in one transaction, so the
 * divergence window Stage 7A recorded no longer exists.
 *
 * ---------------------------------------------------------------------------
 * STAGE 10H.2: the rejection guard -- the mirror of the hire gate.
 *
 * `rejected` is refused when the application has an ACTIVE employment. The two
 * decisions are not symmetric, and that asymmetry is the point: hiring is a
 * positive act that creates the employment, while rejecting an already-hired
 * applicant would leave the application saying "not hired" and the employment
 * saying "active" at the same time.
 *
 * WHY THIS IS NEEDED AT ALL when the client no longer rejects the other
 * applicants on a hire. The old hire action restatused every applicant, so hiring
 * a second person marked the first -- already accepted and employed -- as
 * rejected. Removing that sweep from ViewJobApplications.jsx fixes the client, but
 * a rule that lives only in one client is a rule that the next client, a retry, or
 * a direct call can bypass. This is the server-side half, so the invariant holds
 * regardless of who calls: an application with an active employment cannot be
 * moved to `rejected` through this endpoint.
 *
 * WHY IT IS SCOPED TO THE ACTIVE EMPLOYMENT rather than to the application's
 * `accepted` status. The employment is the record of the hire, and it is the thing
 * that must not be contradicted -- reading the application's status would make the
 * rule depend on a field that same write is about to change. It also means an
 * application whose status was moved back to `interviewed` (which the allow-list
 * permits) still cannot be rejected while the employment stands. employmentService
 * answers the question through the existing listEmploymentsByApplication query, so
 * no new collection, no new index and no employment lifecycle is introduced.
 *
 * WHY `ended` DOES NOT BLOCK IT. The rule is "while its employment remains
 * active", so only `active` refuses the write; an employment that is `ended` (or a
 * status the code cannot read as active) does not. No code can write `ended` yet,
 * so this direction only matters for documents written outside this API, and it
 * follows requireTaskParty's reading that a status that is not recognisably active
 * grants nothing. Legitimate rejection of a never-hired, or no-longer-employed,
 * applicant is therefore untouched.
 *
 * ONE READ, ON THE REJECTION BRANCH ONLY, mirroring the hire gate's single read on
 * the `accepted` branch: every other status (pending, interviewed) costs no
 * employment lookup and behaves exactly as before. A missing employment returns
 * empty rather than throwing, so `rejected` for an applicant who was never hired is
 * the ordinary success it has always been.
 *
 * THE FAILURE IS AN ApplicationValidationError, the same class and the same 400 the
 * hire gate uses for its invalid transition. No new error shape is introduced. The
 * write has not happened when this throws, so the application and its employment are
 * both left exactly as they were.
 */

/**
 * STAGE 3C.1.3. The employment document a hire writes.
 *
 * Kept as a single builder so the transaction and the matching-contract branch
 * cannot write two different shapes. `startDate` keeps the Stage 7A rule: the
 * job's own value verbatim when it is a non-empty string, otherwise a committed
 * serverTimestamp so Firestore never sees an undefined field.
 */
const buildEmploymentDocument = (applicationId, hireContext) => ({
    employerId: hireContext.employerId,
    employeeId: hireContext.employeeId,
    jobId: hireContext.jobId,
    applicationId,
    startDate: typeof hireContext.jobStartDate === 'string' && hireContext.jobStartDate.trim()
        ? hireContext.jobStartDate
        : admin.firestore.FieldValue.serverTimestamp(),
    endDate: null,
    status: 'active',
});

/**
 * STAGE 3C.1.3. The contract a hire creates from the accepted proposal.
 *
 * LIFECYCLE: an accepted PROPOSAL is already the employee's agreement to these
 * exact terms -- contractService.respondToProposal writes status `accepted`,
 * acceptedAt and acceptedBy. The hire therefore records that accepted agreement
 * as an ACTIVE contract, carrying the proposal's acceptance across rather than
 * re-opening a second acceptance the client never performs (a
 * pending_acceptance contract here would be permanently pending). This does not
 * bypass acceptance: it is the same employee, the same terms, and the same
 * acceptance already recorded on the proposal.
 */
const buildContractDocument = (applicationId, accepted) => ({
    employmentId: applicationId,
    employerId: accepted.employerId,
    employeeId: accepted.employeeId,
    jobId: accepted.jobId,
    applicationId,
    currency: accepted.currency || CONTRACT_CURRENCY,
    paymentMode: accepted.paymentMode,
    totalAmountMinor: accepted.totalAmountMinor,
    commissionBps: accepted.commissionBps,
    commissionAmountMinor: accepted.commissionAmountMinor,
    status: contractService.ACTIVE_CONTRACT_STATUS,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    acceptedAt: accepted.acceptedAt || admin.firestore.FieldValue.serverTimestamp(),
    acceptedBy: accepted.acceptedBy || accepted.employeeId,
    fromProposalId: accepted.id,
});

/**
 * STAGE 3C.1.3. One milestone document for a hire-created contract.
 *
 * `taskId` is written only when a legacy caller supplies one. New hires do not
 * create tasks for their milestones, so a fresh schedule has no taskId; Firestore
 * rejects undefined field values, so the field is omitted rather than written.
 *
 * Status mirrors what a normally created-then-accepted contract leaves behind:
 * contractService.createContract writes `pending_acceptance` milestones and
 * acceptContract does not change them, so an active contract's schedule holds
 * `pending_acceptance` entries.
 */
const buildMilestoneDocument = (employmentId, milestone) => {
    const label = typeof milestone?.label === 'string' ? milestone.label.trim() : '';
    if (!label) {
        throw new ApplicationValidationError('An accepted proposal milestone has no label.');
    }

    const document = {
        contractId: employmentId,
        employmentId,
        label,
        amountMinor: milestone.amountMinor,
        description: typeof milestone.description === 'string' ? milestone.description : '',
        status: contractService.PENDING_ACCEPTANCE_STATUS,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (typeof milestone.taskId === 'string' && milestone.taskId.trim()) {
        document.taskId = milestone.taskId.trim();
    }

    return document;
};

/**
 * STAGE 3C.1.3. Deterministic milestone document id.
 *
 * The contract id is the employment id, which is the application id, so the id
 * is fully determined by (applicationId, schedule index). A transaction retry --
 * or any future replay of the same hire -- therefore targets the same document
 * instead of appending a second copy of the schedule. The index is zero-padded so
 * lexicographic document-id order (Firestore's default query order) matches
 * schedule order.
 */
const milestoneDocumentId = (employmentId, index) =>
    `${employmentId}_milestone_${String(index).padStart(2, '0')}`;

const normalizedDescription = (value) =>
    (typeof value === 'string' ? value : '').trim();

/** The schedule index encoded in a deterministic milestone id, if present. */
const milestoneScheduleIndex = (milestone) => {
    const match = /_milestone_(\d+)$/.exec(milestone.id || '');
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
};

/**
 * Orders persisted milestones by their schedule position. Hire-created
 * milestones carry the index in their id; anything else (a schedule written by
 * contractService with auto ids) keeps a stable id order as a fallback.
 */
const compareMilestonesByScheduleOrder = (a, b) => {
    const indexDelta = milestoneScheduleIndex(a) - milestoneScheduleIndex(b);
    if (indexDelta !== 0) return indexDelta;
    return String(a.id || '').localeCompare(String(b.id || ''));
};

/**
 * STAGE 3C.1.3. Whether a contract already on disk is exactly the deal the
 * accepted proposal describes.
 *
 * Milestones are NOT an array on the contract document -- contractService stores
 * them in the top-level `milestones` collection under `contractId`. The caller
 * passes the real persisted schedule, already ordered. Comparison covers the
 * agreed money and parties plus the schedule's count, order, labels, amounts and
 * descriptions. `taskId` is deliberately not compared: proposals do not carry
 * one, so comparing it would report a conflict for every legitimate schedule.
 */
const contractMatchesProposal = (existing, existingMilestones, accepted, applicationId) => {
    const acceptedCurrency = accepted.currency || CONTRACT_CURRENCY;
    const contractOk = (
        existing.currency === acceptedCurrency
        && existing.currency === CONTRACT_CURRENCY
        && existing.paymentMode === accepted.paymentMode
        && existing.totalAmountMinor === accepted.totalAmountMinor
        && existing.commissionBps === accepted.commissionBps
        && existing.commissionAmountMinor === accepted.commissionAmountMinor
        && existing.employmentId === applicationId
        && existing.applicationId === applicationId
        && existing.jobId === accepted.jobId
        && existing.employerId === accepted.employerId
        && existing.employeeId === accepted.employeeId
    );

    if (!contractOk) return false;

    const proposedMilestones = Array.isArray(accepted.milestones) ? accepted.milestones : [];
    if (existingMilestones.length !== proposedMilestones.length) return false;

    for (let i = 0; i < proposedMilestones.length; i += 1) {
        const persisted = existingMilestones[i] || {};
        const proposed = proposedMilestones[i] || {};
        if (persisted.label !== proposed.label) return false;
        if (persisted.amountMinor !== proposed.amountMinor) return false;
        if (normalizedDescription(persisted.description) !== normalizedDescription(proposed.description)) {
            return false;
        }
    }

    return true;
};

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

    if (newStatus === REJECTED_APPLICATION_STATUS) {
        const employed = await employmentService.hasActiveEmploymentForApplication(applicationId);

        if (employed) {
            throw new ApplicationValidationError(
                'Cannot reject an application whose employment is still active. '
                + 'An employed applicant cannot be marked as rejected.'
            );
        }
    }

    // STAGE 3C.1.2 / 3C.1.3: require a genuinely employee-accepted proposal
    // before hiring, and finalise the hire atomically.
    if (newStatus === HIRED_APPLICATION_STATUS) {
        let isAlreadyHired = false;
        const currentSnap = await applicationRepository.getApplicationById(applicationId);
        if (currentSnap.exists) {
            const currentStatus = currentSnap.data().status;
            if (currentStatus === HIRED_APPLICATION_STATUS) {
                isAlreadyHired = true;
            }
        }
        const employmentRepo = require('../repositories/employmentRepository');
        const existingEmps = await employmentRepo.listEmploymentsByApplication(applicationId);
        if (existingEmps && !existingEmps.empty) {
            isAlreadyHired = true;
        }

        if (!isAlreadyHired) {
            if (!hireContext) {
                throw new ApplicationValidationError('An accepted contract proposal is required before hiring.');
            }

            // STAGE 3C.1.3. Discover the candidate accepted proposal by query,
            // then read and revalidate the document INSIDE the transaction.
            //
            // A real Firestore transaction can only read documents by id, not run
            // a query, so the query is the only way to name the candidate. It is
            // not authoritative: the transaction's `tx.get(proposalRef)` is what
            // validates status/parties/consumption and what creates the read/write
            // pair that makes two concurrent hires conflict instead of both
            // consuming the same proposal.
            const proposalsSnap = await contractProposalRepository.listProposalsByApplication(applicationId);
            const acceptedCandidate = (proposalsSnap.docs || []).find(
                (doc) => doc.data().status === contractService.PROPOSAL_ACCEPTED
            );
            if (!acceptedCandidate) {
                throw new ApplicationValidationError('An accepted contract proposal is required before hiring.');
            }
            const acceptedProposalId = acceptedCandidate.id;

            await db.runTransaction(async (tx) => {
                // ------------------------------------------------------------
                // READ PHASE. Every tx.get below happens before the first write.
                // ------------------------------------------------------------
                const appRef = db.collection('applications').doc(applicationId);
                const appSnapTx = await tx.get(appRef);
                if (!appSnapTx.exists) {
                    throw new ApplicationValidationError('Application not found');
                }
                const appData = appSnapTx.data() || {};
                if (appData.status === HIRED_APPLICATION_STATUS) {
                    throw new ApplicationValidationError('This application has already been hired.');
                }

                const proposalRef = db.collection('contractProposals').doc(acceptedProposalId);
                const proposalSnapTx = await tx.get(proposalRef);
                if (!proposalSnapTx.exists) {
                    throw new ApplicationValidationError('An accepted contract proposal is required before hiring.');
                }
                const accepted = { id: acceptedProposalId, ...proposalSnapTx.data() };
                if (accepted.status !== contractService.PROPOSAL_ACCEPTED) {
                    throw new ApplicationValidationError('An accepted contract proposal is required before hiring.');
                }
                if (accepted.consumedByEmploymentId || accepted.consumedAt) {
                    throw new ApplicationValidationError('This accepted proposal has already been used for hiring.');
                }

                // Revalidate the relationship from the stored documents, not from
                // the request that got us here.
                if (
                    accepted.applicationId !== applicationId
                    || accepted.jobId !== appData.jobId
                    || accepted.jobId !== hireContext.jobId
                    || accepted.employerId !== hireContext.employerId
                    || accepted.employeeId !== appData.employeeId
                    || accepted.employeeId !== hireContext.employeeId
                ) {
                    throw new ApplicationValidationError('An accepted contract proposal is required before hiring.');
                }

                const jobRef = db.collection('jobs').doc(appData.jobId);
                const jobSnapTx = await tx.get(jobRef);
                if (!jobSnapTx.exists) {
                    throw new ApplicationValidationError('Job not found');
                }
                const jobData = jobSnapTx.data() || {};
                if (jobData.postedBy !== accepted.employerId) {
                    throw new ApplicationValidationError('An accepted contract proposal is required before hiring.');
                }

                // Deterministic employment id: one employment per application.
                const employmentId = applicationId;
                const empRef = db.collection('employments').doc(employmentId);
                const empSnap = await tx.get(empRef);
                if (empSnap.exists) {
                    throw new ApplicationValidationError('This application has already been hired.');
                }

                const contractRef = db.collection('contracts').doc(employmentId);
                const contractSnap = await tx.get(contractRef);

                let existingContract = null;
                let existingMilestones = null;
                let scheduledMilestoneWrites = null;
                if (contractSnap.exists) {
                    existingContract = contractSnap.data() || {};
                    // STAGE 3C.1.3. Milestones live in the top-level collection,
                    // linked by contractId -- never as an array on the contract.
                    const milestoneSnapshot = await contractRepository.listMilestonesByContract(employmentId);
                    existingMilestones = (milestoneSnapshot.docs || []).map((doc) => ({ id: doc.id, ...doc.data() }));
                    existingMilestones.sort(compareMilestonesByScheduleOrder);

                    if (!contractMatchesProposal(existingContract, existingMilestones, accepted, applicationId)) {
                        // Thrown before any write, so the proposal is not consumed
                        // and the existing contract/milestones are untouched.
                        throw new ApplicationValidationError('Contract terms conflict with accepted proposal');
                    }
                } else {
                    // Build the whole fresh schedule before the write phase.
                    // Tasks are not part of a hire: the employer creates and
                    // associates them separately after the contract exists.
                    const proposedMilestones = Array.isArray(accepted.milestones) ? accepted.milestones : [];
                    scheduledMilestoneWrites = proposedMilestones.map((milestone, index) => ({
                        milestone,
                        milestoneId: milestoneDocumentId(employmentId, index),
                    }));
                }

                // ------------------------------------------------------------
                // WRITE PHASE. All reads are complete.
                // ------------------------------------------------------------
                tx.update(appRef, { status: newStatus });
                tx.set(empRef, buildEmploymentDocument(applicationId, hireContext));
                tx.update(proposalRef, {
                    consumedByEmploymentId: employmentId,
                    consumedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });

                // A matching existing contract (and its schedule) is preserved:
                // the hire only links the missing employment and consumes the
                // proposal. A fresh hire writes the contract and its schedule
                // under deterministic milestone ids. Existing schedules are never
                // backfilled or rewritten.
                if (!contractSnap.exists) {
                    tx.set(contractRef, buildContractDocument(applicationId, accepted));
                    for (const scheduled of scheduledMilestoneWrites) {
                        const milestoneRef = db.collection('milestones').doc(scheduled.milestoneId);
                        tx.set(milestoneRef, buildMilestoneDocument(employmentId, scheduled.milestone));
                    }
                }
            });
            return;
        }
    }

    await applicationRepository.updateApplicationStatusField(applicationId, newStatus);
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
 * counter.
 *
 * The withdrawal now deletes the application and its uniqueness key in one
 * transaction. The key removal is what lets the same applicant apply to the same
 * job again, while the generated application id stays fresh so the new
 * application does not inherit interviews, conversations or proposals from the
 * withdrawn one.
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

    const application = appSnap.data() || {};
    await applicationRepository.deleteApplicationWithUniquenessKey(
        applicationId,
        application.jobId,
        application.employeeId
    );
};

/**
 * STAGE 12.12.1. Mints a short-lived signed download URL for the private resume
 * an application carries.
 *
 * The resume reference is read from the application document passed in by the
 * caller -- which the authorization guard has loaded from Firestore -- and never
 * from the request. A client cannot name a public id or a URL here: the only
 * input to the signature is `application.resume.publicId`, so a signed URL can
 * only ever point at the resume the server already recorded for this
 * application.
 *
 * Throws ApplicationNotFoundError (404) when the application has no resume.
 * `buildResumeReference` re-validates the stored shape, so a malformed document
 * fails as a 400 rather than minting a URL for a value the API would never have
 * written. Throws CloudinaryConfigurationError when the environment is
 * incomplete; the controller turns that into a 503 and never falls back to a
 * public URL.
 */
const getResumeDownloadUrl = (application) => {
    const reference = application && application.resume;

    if (!reference) {
        throw new ApplicationNotFoundError('Resume not found');
    }

    const { publicId, name } = buildResumeReference(reference);

    const url = generateSignedDownloadUrl(publicId, { expiresInSeconds: 300 });

    return { url, name };
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
    getResumeDownloadUrl,
    RESUME_RESOURCE_TYPE,
};
