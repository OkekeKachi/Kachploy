// applicationRepository.js
//
// Data-access layer for the `applications` collection (new in Stage 4B). It
// owns the direct Firestore calls for that one collection which used to sit
// inside applicationService.js: the document reads, the two queries, the create,
// the status update and the delete.
//
// SCOPE: the `applications` collection only. Three of applicationService's
// Firestore calls are deliberately NOT here, because they are not applications
// persistence:
//   * applyToJob reads a job document to inspect `negotiable`
//   * listApplicationsForEmployee reads one job per application (an N+1 read)
//   * withdrawApplication reads the application to authorise it, then deletes
//     it. Stage 5E removed the parent-job counter write it used to do, so it
//     touches no other collection
// Those stay in the service, along with the `tasks` add in
// createTaskFromApplication. Keeping them there preserves the cross-collection
// orchestration and the write ordering that Stage 4B is not allowed to change.
//
// This layer holds no business logic. It knows nothing about HTTP, status codes,
// controllers, Express, tokens or authorisation, and it raises no error of its
// own: reads hand back the raw DocumentSnapshot or QuerySnapshot so
// applicationService keeps ownership of the `exists` checks and of the
// ApplicationNotFoundError / ApplicationValidationError classes. The per-record
// job join in listApplicationsForEmployee and the negotiable price branches are
// all service concerns and stay there. Stage 5E removed the last of the
// cross-collection writes, so nothing outside `applications` is touched from
// this layer any more.
//
// Stage 5B added listAllApplications for the applicant-count read path, and
// moved the owner check for the applications-by-job list into
// middleware/auth.js. The repository is unaffected by that change: it holds no
// notion of who may read an application, and it never returns a count itself --
// the aggregation lives in the service.
//
// No transactions and no batches. Stage 5E removed the one write that reached
// outside this collection, so the repository is now a single-collection layer
// and withdrawApplication is a single delete. No transaction is introduced here
// either: doing so would change observable behaviour that this stage is not
// allowed to touch. The N+1 job read in listApplicationsForEmployee is left
// exactly as it is; no getJobsByIds helper exists yet.

const { db } = require('../config/firebase');

/**
 * Reads one application document.
 *
 * Returns the raw snapshot -- including `exists` and `id` -- so the caller
 * decides what a missing document means. No NotFound error is raised here.
 */
const getApplicationById = (applicationId) =>
    db.collection('applications').doc(applicationId).get();

/**
 * Creates an application document under a Firestore-generated id and returns
 * that id.
 *
 * A non-merge write, exactly as before. The current caller discards the returned
 * id, which is preserved: nothing about the endpoint's response may change.
 */
const addApplication = async (data) => {
    const applicationRef = await db.collection('applications').add(data);
    return applicationRef.id;
};

/**
 * Every application document, unfiltered.
 *
 * Added in Stage 5B so the dashboards can build a per-job applicant count from a
 * single read instead of one `listApplicationsByJob` call per job. The caller
 * must aggregate the snapshot and must not forward the documents themselves: this
 * is the same unfiltered-scan shape as jobRepository.listAllJobs, and it is the
 * only way to count every job's applications in one round trip without an
 * aggregate `count()` query, which the in-memory test double does not implement.
 *
 * No applicant data leaves through the count path; see the service.
 */
const listAllApplications = () => db.collection('applications').get();

/**
 * One applicant's applications.
 *
 * Single-field equality filter on `employeeId`, preserved verbatim. The uid
 * reaches the service from the verified token via requireSelfParam.
 */
const listApplicationsByEmployee = (employeeId) =>
    db.collection('applications').where('employeeId', '==', employeeId).get();

/**
 * Every application filed against one job.
 *
 * Single-field equality filter on `jobId`, preserved verbatim. The identical
 * query also exists in middleware/auth.js requireTaskAssignment, which is out of
 * scope for this stage and still issues its own.
 */
const listApplicationsByJob = (jobId) =>
    db.collection('applications').where('jobId', '==', jobId).get();

/**
 * Sets the `status` field on one application.
 *
 * No existence read is performed here. The status endpoint's not-found handling
 * comes from the requireApplicationReviewer guard, before the service runs.
 */
const updateApplicationStatusField = (applicationId, newStatus) =>
    db.collection('applications').doc(applicationId).update({ status: newStatus });

/** Deletes one application document. No existence read is performed here. */
const deleteApplicationById = (applicationId) =>
    db.collection('applications').doc(applicationId).delete();

module.exports = {
    getApplicationById,
    addApplication,
    listAllApplications,
    listApplicationsByEmployee,
    listApplicationsByJob,
    updateApplicationStatusField,
    deleteApplicationById,
};
