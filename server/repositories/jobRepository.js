// jobRepository.js
//
// Data-access layer for the `jobs` collection (new in Stage 4A). It owns every
// direct Firestore call that used to sit inside jobService.js: the collection
// and document references, the reads, the queries, the create, the updates and
// the delete.
//
// SCOPE: the `jobs` collection only, and only the calls made by jobService.
// Two other places still reach `jobs` directly and are deliberately left alone
// for now, because Stage 4A excludes them:
//   * applicationService.applyToJob reads a job (to check `negotiable`) and
//     applicationService.withdrawApplication decrements a counter on one
//   * middleware/auth.js loadJob reads a job for the ownership guards
// So the `jobs` collection is not yet served exclusively by this file.
//
// This layer holds no business logic. It knows nothing about HTTP, status codes,
// controllers, Express, tokens or authorisation, and it never raises an error of
// its own: reads hand back the raw DocumentSnapshot so jobService keeps
// ownership of the `exists` checks and of the JobNotFoundError /
// JobValidationError classes. Document shaping stays in the service too --
// merging `id` into the payload and defaulting the three arrays are job
// concerns, not data-access ones.
//
// No transactions and no batches are used, because none were used before this
// extraction and adding any would change the write ordering and therefore the
// observable behaviour. Reads are also left unoptimised: updateJob and deleteJob
// still re-read a document that requireJobOwner has already loaded, and
// getJobWithDefaults still duplicates getJob's read.
//
// Timestamps are not generated here. jobService decides what a created/updated
// value is, because the value type is job behaviour: ISO strings today, while
// the users collection uses serverTimestamp() and tasks uses a raw Date.

const { db } = require('../config/firebase');

/**
 * Reads one job document.
 *
 * Returns the raw snapshot -- including `exists` and `id` -- so the caller
 * decides what a missing document means. No NotFound error is raised here.
 */
const getJobById = (jobId) => db.collection('jobs').doc(jobId).get();

/**
 * Every job document, unfiltered.
 *
 * An unfiltered collection scan, preserved as-is: this is the query the
 * endpoint has always issued, including the absence of pagination.
 */
const listAllJobs = () => db.collection('jobs').get();

/**
 * The jobs posted by one employer.
 *
 * Single-field equality filter on `postedBy`; the uid arrives from the caller's
 * verified identity, not from anything in the document.
 */
const listJobsByEmployer = (uid) => db.collection('jobs').where('postedBy', '==', uid).get();

/**
 * Creates a job document under a Firestore-generated id and returns that id.
 *
 * A non-merge write, exactly as before: a fresh document, not an upsert over an
 * existing one. `.doc()` with no argument is kept rather than `.add()` so the
 * reference used for the write and the id returned to the caller remain the same
 * object, as they were when the service did this itself.
 */
const createJobDoc = async (data) => {
    const jobRef = db.collection('jobs').doc();
    await jobRef.set(data);
    return jobRef.id;
};

/**
 * Applies a partial update to an existing job document.
 *
 * No existence read is performed here; callers that need one ask for the
 * document first via getJobById.
 */
const updateJobFields = (jobId, partial) => db.collection('jobs').doc(jobId).update(partial);

/**
 * Sets the `status` field only.
 *
 * Kept distinct from updateJobFields because the status endpoint deliberately
 * does not read the document first, so a missing job surfaces as a Firestore
 * write failure rather than a 404. Folding the two together would introduce
 * that read.
 */
const updateJobStatusField = (jobId, status) => db.collection('jobs').doc(jobId).update({ status });

/** Deletes one job document. No existence read is performed here. */
const deleteJobById = (jobId) => db.collection('jobs').doc(jobId).delete();

module.exports = {
    getJobById,
    listAllJobs,
    listJobsByEmployer,
    createJobDoc,
    updateJobFields,
    updateJobStatusField,
    deleteJobById,
};
