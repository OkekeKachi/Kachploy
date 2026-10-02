// interviewRepository.js
//
// Data-access layer for the `interviews` collection (new in Stage 7C). It owns the
// direct Firestore calls for that one collection: the create, the single-document
// read the authorization guards need, the two single-field equality queries behind
// the list endpoints, and the field-level update.
//
// SCOPE: the `interviews` collection only. Nothing else in the codebase reaches
// it, so like `employments` (Stage 7A) it is served exclusively by this file from
// the moment it is created. Unlike every collection that predates it, it is NOT
// reached by middleware/auth.js for its own sake -- the three Stage 7C guards read
// it only through getInterviewById below, to establish which job an interview
// belongs to, exactly as the existing guards read `jobs` and `applications`.
//
// This layer holds no business logic, as the five repositories that predate it do.
// It knows nothing about HTTP, status codes, controllers, Express, tokens or
// authorisation, and it raises no error of its own: reads hand back the raw
// snapshot so interviewService keeps ownership of the `exists` checks and of the
// InterviewNotFoundError / InterviewValidationError classes, and updateInterviewFields
// hands back nothing so the service keeps ownership of the patch it built.
//
// Every query here is a single-field `==` filter, so no composite index is
// required -- the same reason applications and tasks can be listed by employee or
// job without one. Two queries rather than one, because an interview is reachable
// by two different owners of the truth: the job it was held for (the employer's
// view) and the application it belongs to (the applicant's view). Collapsing them
// would mean one of those two views reading through a field it does not own.
//
// No transactions and no batches. An interview is a single add, and an update is a
// single field-level update; Stage 7C does not require more, and introducing a
// transaction would change write ordering that no existing behaviour depends on.

const { db } = require('../config/firebase');

/**
 * Creates an interview document under a Firestore-generated id and returns that
 * id.
 *
 * A plain `.add()`, matching taskRepository.addTask, employmentRepository's
 * addEmployment and applicationRepository.addApplication. The caller owns the
 * payload in whole, including the `createdAt` serverTimestamp() -- the timestamp
 * is domain behaviour, not persistence, so it is built in the service.
 */
const addInterview = async (data) => {
    const interviewRef = await db.collection('interviews').add(data);
    return interviewRef.id;
};

/**
 * Reads one interview document.
 *
 * Returns the raw snapshot -- including `exists` and `id` -- so the caller decides
 * what a missing document means. No NotFound error is raised here. Used by the
 * service's existence check and by middleware/auth.js's requireInterviewOwner.
 */
const getInterviewById = (interviewId) =>
    db.collection('interviews').doc(interviewId).get();

/**
 * Every interview held for one job.
 *
 * Single-field equality filter on `jobId`, mirroring taskRepository.listTasksByJob
 * and employmentRepository.listEmploymentsByEmployee. The job's owner is
 * established by the existing requireJobOwner guard before the service runs.
 */
const listInterviewsByJob = (jobId) =>
    db.collection('interviews').where('jobId', '==', jobId).get();

/**
 * Every interview belonging to one application.
 *
 * Single-field equality filter on `applicationId`, mirroring
 * applicationRepository.listApplicationsByJob. This is the query the applicant
 * reads through: requireInterviewParty has already established that the caller is
 * either that application's employee or the owner of its job.
 */
const listInterviewsByApplication = (applicationId) =>
    db.collection('interviews').where('applicationId', '==', applicationId).get();

/**
 * Applies a pre-built field-level patch to one interview.
 *
 * A plain `.update()`, not a `set`, so fields absent from the patch are left alone
 * -- which is what makes a partial update (change only the status, or only the
 * time) possible without the service first reading the document to merge it. It
 * also throws NOT_FOUND on a missing document, exactly as the real SDK does; the
 * service's existence check runs first, so that is a backstop rather than the
 * 404 path clients see.
 *
 * No existence read is performed here. No field is allow-listed here either: which
 * fields may be written is decided in interviewService, and this function applies
 * whatever patch it is handed.
 */
const updateInterviewFields = (interviewId, patch) =>
    db.collection('interviews').doc(interviewId).update(patch);

module.exports = {
    addInterview,
    getInterviewById,
    listInterviewsByJob,
    listInterviewsByApplication,
    updateInterviewFields,
};