// jobService.js
//
// Business and data layer for the jobs resource (new in Stage 3A). It owns
// every Firestore read/write, the job validation rules and the job-specific
// data shaping that used to live inline in jobController.js.
//
// Stage 3A is a structural extraction only. The jobController is now
// HTTP-focused -- it reads the request, calls one service function and
// translates the outcome into the status code and body it always sent. Nothing
// about the observable behaviour changes, so the known defects below are
// preserved deliberately and still pinned by test/jobs.test.js:
//
//   * the duplicate `GET /:jobId` registration (getJobWithDefaults is the
//     unreachable one; the router still registers both)
//   * ~~createJob writes `negotiable` while applicationController reads
//     `isNegotiable`~~ CLOSED in Stage 5D: `negotiable` is the single
//     canonical field, this service keeps writing it unchanged, and
//     applicationService.applyToJob now reads it
//   * ~~createJob writes `proposal` (singular) but nothing ever increments it,
//     and the application routes decrement `proposals` (plural)~~ CLOSED in
//     Stage 5E: both fields are no longer written at all
//   * updateJob re-reads the job that requireJobOwner already loaded
//   * createdAt/updatedAt are ISO strings here, a serverTimestamp() in
//     userController and a raw Date in taskController
//   * validation is looser on update than on create (`price === undefined`
//     accepts 0, while create rejects it via truthiness)
//
// Stage 4A moved the Firestore persistence out to repositories/jobRepository.js.
// This service no longer touches Firestore at all: it holds the validation, the
// document shaping and the error classes, and delegates every read, query,
// create, update and delete for the `jobs` collection to the repository. The
// repository returns raw snapshots, so the existence checks and the
// JobNotFoundError throws below are still made here.

const jobRepository = require('../repositories/jobRepository');

/**
 * A required field is missing. The controller turns this into a 400 with this
 * exact message, which is why the message lives on the throw site: the two
 * endpoints word it differently ("Missing required fields" vs "Required
 * fields are missing.") and both strings are asserted by the tests.
 */
class JobValidationError extends Error {}

/** The requested job document does not exist. Surfaces as a 404. */
class JobNotFoundError extends Error {}

/**
 * Lists every job, unfiltered, with the document id merged in.
 *
 * BUG (Stage 3): this is an unfiltered collection scan, so it exposes every job
 * in the database to any authenticated caller, and it has no pagination.
 */
const listJobs = async () => {
    const snapshot = await jobRepository.listAllJobs();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
};

/**
 * Creates a job for `postedBy`.
 *
 * The author is always passed in from the verified token by the controller, so
 * a `postedBy` in the request body can never be honoured.
 *
 * STAGE 5E: this used to write a hardcoded `proposal: 0` counter. Nothing ever
 * incremented it, withdrawApplication decremented a different field
 * (`proposals`, plural, which this service never created), and no code read
 * either -- so the document advertised a number that was permanently and
 * silently wrong. The write is removed rather than replaced: the applicant count
 * is derived per job from the `applications` collection and served by
 * GET /applications/counts, so there is no counter to keep. No `applicantCount`
 * field is written here either.
 *
 * Existing job documents may still carry `proposal` and `proposals` keys. They
 * are left untouched: not read, not written, not deleted.
 */
const createJob = async (payload, postedBy) => {
    const {
        title,
        description,
        location,
        jobType,
        applicationDeadline,
        jobStartDate,
        expectedEndDate,
        price,
        negotiable,
        skillsRequired = [],
        requirements = [],      // New field for job requirements
        responsibilities = []   // New field for job responsibilities
    } = payload;

    // Validate required fields
    if (
        !title || !description || !location || !jobType ||
        !applicationDeadline || !jobStartDate || !price || !postedBy
    ) {
        throw new JobValidationError('Missing required fields');
    }

    const jobId = await jobRepository.createJobDoc({
        title,
        description,
        location,
        jobType,
        applicationDeadline,
        jobStartDate,
        expectedEndDate: expectedEndDate || null,
        price,
        negotiable,
        // STAGE 5G: hardcoded, never read from the body. `status` used to be
        // destructured with a `'open'` default, which meant a caller could post
        // `status: 'Filled'` and create a job that was already filled, or any
        // other string. A new job is always open; updateJobStatus is the only
        // way to change it.
        status: 'open',
        postedBy,
        skillsRequired,         // Store the skills array
        requirements,           // Store the requirements array
        responsibilities,       // Store the responsibilities array
        createdAt: new Date().toISOString(),
    });

    return { jobId };
};

/**
 * Lists the jobs posted by one employer.
 *
 * The two console.log calls are load-bearing for nothing at runtime, but they
 * are preserved verbatim rather than quietly dropped: Stage 2 owns removing
 * them, and the debug-output count is tracked in ENDPOINTS.md.
 */
const listEmployerJobs = async (uid) => {
    const jobsSnapshot = await jobRepository.listJobsByEmployer(uid);

    if (jobsSnapshot.empty) {
        console.log("nothing here");
        return [];
    }

    const jobs = [];
    jobsSnapshot.forEach(doc => {
        jobs.push({ id: doc.id, ...doc.data() });
    });
    console.log(jobs);

    return jobs;
};

/**
 * The LIVE `GET /:jobId` read.
 *
 * Returns the raw document with no `id` and no defaults for
 * skillsRequired/requirements/responsibilities. JobDetails.jsx calls .map() on
 * all three, so a job document predating those fields crashes that page.
 * BUG (Stage 3) -- fixed only by dropping the duplicate registration, which is
 * why getJobWithDefaults below must stay as it is for now.
 */
const getJob = async (jobId) => {
    const jobSnapshot = await jobRepository.getJobById(jobId);

    if (!jobSnapshot.exists) {
        throw new JobNotFoundError('Job not found');
    }

    return jobSnapshot.data();
};

/**
 * The UNREACHABLE variant of the read above.
 *
 * DEAD CODE: the router registers `GET /:jobId` twice and Express matches in
 * registration order, so getJob always wins and this never runs. It is the
 * variant that returns `id` and defaults the three arrays -- i.e. the shape
 * JobDetails.jsx actually expects. Removal is scheduled for Stage 7; until then
 * it is kept registered so the duplicate stays visible and covered.
 */
const getJobWithDefaults = async (jobId) => {
    const jobSnapshot = await jobRepository.getJobById(jobId);

    if (!jobSnapshot.exists) {
        throw new JobNotFoundError('Job not found');
    }

    const jobData = jobSnapshot.data();

    return {
        id: jobSnapshot.id,
        ...jobData,
        // Ensure arrays exist even if not set in database
        skillsRequired: jobData.skillsRequired || [],
        requirements: jobData.requirements || [],
        responsibilities: jobData.responsibilities || []
    };
};

/**
 * Applies a partial update to a job and returns the field names that were
 * written, which the controller echoes back as `updatedFields`.
 *
 * QUIRK (preserved): the field validation here is looser than createJob's --
 * it tests `price === undefined`, so a price of 0 is accepted, whereas
 * createJob rejects 0 via a truthiness check.
 *
 * QUIRK (preserved): `price` is coerced with parseFloat, so a non-numeric
 * price becomes NaN and is written to Firestore as such.
 *
 * QUIRK (preserved): the optional fields are only written when truthy, so a
 * client cannot clear `expectedEndDate` by sending an empty value.
 *
 * BUG (Stage 3): this re-reads the job document that requireJobOwner has
 * already loaded and verified in the router, so every update costs two reads.
 * Collapsing them needs the ownership check to pass its result down.
 */
const updateJob = async (jobId, payload) => {
    const {
        title,
        description,
        location,
        jobType,
        applicationDeadline,
        jobStartDate,
        expectedEndDate,
        price,
        negotiable,
        skillsRequired,
        requirements,
        responsibilities
    } = payload;

    // Validate the required fields
    if (!title || !description || !location || !jobType || !applicationDeadline || !jobStartDate || price === undefined) {
        throw new JobValidationError('Required fields are missing.');
    }

    const jobSnapshot = await jobRepository.getJobById(jobId);

    // Check if the job exists in the database
    if (!jobSnapshot.exists) {
        throw new JobNotFoundError('Job not found');
    }

    // Prepare the update data
    const updateData = {
        title,
        description,
        location,
        jobType,
        applicationDeadline,
        jobStartDate,
        price: parseFloat(price), // Ensure price is a number
        negotiable,
        updatedAt: new Date().toISOString(), // Add timestamp for when job was last updated
    };

    // Add optional fields if they exist
    if (expectedEndDate) {
        updateData.expectedEndDate = expectedEndDate;
    }

    if (skillsRequired && Array.isArray(skillsRequired)) {
        updateData.skillsRequired = skillsRequired;
    }

    if (requirements && Array.isArray(requirements)) {
        updateData.requirements = requirements;
    }

    if (responsibilities && Array.isArray(responsibilities)) {
        updateData.responsibilities = responsibilities;
    }

    // Update the job document with the new data
    await jobRepository.updateJobFields(jobId, updateData);

    return { updatedFields: Object.keys(updateData) };
};

/** Deletes a job document. Ownership is enforced by requireJobOwner. */
const deleteJob = async (jobId) => {
    const jobSnapshot = await jobRepository.getJobById(jobId);

    if (!jobSnapshot.exists) {
        throw new JobNotFoundError('Job not found');
    }

    // Delete the job document
    await jobRepository.deleteJobById(jobId);
};

/**
 * The canonical job statuses.
 *
 * STAGE 5G. `open` is what createJob writes. `filled` and `closed` are the two
 * states a job can be moved into. The client used to write the title-cased
 * `Filled` when hiring, which no other code path used -- the dashboards all
 * compare against `open`, so a filled job was displayed as closed to the
 * employer. `Filled` is still read as `filled` for compatibility, but only the
 * lowercase spelling is written now.
 *
 * `paused` was offered as a dashboard filter and badge with no writer anywhere
 * in the codebase. It is not adopted here and no writer is being added; the
 * frontend options for it are removed.
 */
const JOB_STATUSES = ['open', 'filled', 'closed'];

/**
 * Sets a job's status.
 *
 * STAGE 5G: the value is checked against JOB_STATUSES, so an arbitrary string
 * (`banana`), a value with no writer (`paused`), the legacy title-cased `Filled`,
 * and a missing or undefined value are all rejected with a JobValidationError,
 * which jobController maps to 400 using the same shape as every other validation
 * failure on this resource.
 *
 * The previous behaviour of writing any string -- including overwriting `status`
 * with `undefined` when the body omitted it, losing the previous value -- is
 * deliberately no longer supported: an absent status is not a valid status.
 *
 * QUIRK (preserved): there is no existence check here. A missing job surfaces as
 * a 404 from the requireJobOwner guard in routes/jobs.js, which loads the job
 * before this runs; the 500-from-Firestore behaviour the old comment described
 * no longer applies.
 */
const updateJobStatus = async (jobId, status) => {
    if (!JOB_STATUSES.includes(status)) {
        throw new JobValidationError(
            `Invalid status. Must be one of: ${JOB_STATUSES.join(', ')}.`
        );
    }

    await jobRepository.updateJobStatusField(jobId, status);
};

module.exports = {
    JobValidationError,
    JobNotFoundError,
    listJobs,
    createJob,
    listEmployerJobs,
    getJob,
    getJobWithDefaults,
    updateJob,
    deleteJob,
    updateJobStatus,
};
