// employmentRepository.js
//
// Data-access layer for the `employments` collection (new in Stage 7A). It owns
// the direct Firestore calls for that one collection: the create performed when
// an employer hires an applicant, and the two single-field equality queries
// behind the read endpoints.
//
// SCOPE: the `employments` collection only. Nothing else in the codebase reaches
// this collection, so unlike `jobs`, `applications` and `tasks` it is served
// exclusively by this file from the moment it is created.
//
// This layer holds no business logic, exactly as the four repositories that
// predate it do. It knows nothing about HTTP, status codes, controllers,
// Express, tokens or authorisation, and it raises no error of its own: reads
// hand back the raw QuerySnapshot so employmentService keeps ownership of the
// document shaping, and the create hands back the generated id so
// employmentService keeps ownership of what the caller is told.
//
// The decision about WHEN an employment is recorded -- that it happens on a
// successful hire and not otherwise -- is business logic and belongs to
// employmentService.createEmploymentFromHire, which this layer is called from.
// The `startDate` payload is likewise built in the service, including the
// serverTimestamp() fallback: jobs store `jobStartDate` as an ISO string while
// users/applications/tasks use FieldValue.serverTimestamp(), so a timestamp's
// form is domain behaviour, not persistence.
//
// No transactions and no batches. Nothing in this stage required them: an
// employment is a single `.add()` that runs only after the hire's own write has
// already succeeded, and adding a transaction would change that ordering -- which
// is the behaviour Stage 7A is required to keep.

const { db } = require('../config/firebase');

/**
 * Creates an employment document under a Firestore-generated id and returns
 * that id.
 *
 * A plain `.add()`, matching taskRepository.addTask and
 * applicationRepository.addApplication. The caller owns the payload in whole.
 */
const addEmployment = async (data) => {
    const employmentRef = await db.collection('employments').add(data);
    return employmentRef.id;
};

/**
 * Every employment one employee holds.
 *
 * Single-field equality filter on `employeeId`, mirroring
 * taskRepository.listTasksByEmployee and
 * applicationRepository.listApplicationsByEmployee -- so it needs no composite
 * Firestore index. The uid reaches the service from the verified token via the
 * existing requireSelfParam('uid') guard, never from an unverified parameter.
 */
const listEmploymentsByEmployee = (employeeId) =>
    db.collection('employments').where('employeeId', '==', employeeId).get();

/**
 * Every employment one employer has offered.
 *
 * Single-field equality filter on `employerId`, mirroring
 * jobRepository.listJobsByEmployer (`postedBy`). Same reasoning as the employee
 * query above: one equality filter, no composite index.
 */
const listEmploymentsByEmployer = (employerId) =>
    db.collection('employments').where('employerId', '==', employerId).get();

/**
 * Every employment recorded for one job.
 *
 * STAGE 10H.1. Added for the employer-side employee-management read: one job may
 * have hired several applicants, and "who is employed on this job" is a question
 * keyed on the job rather than on either person. Single-field equality filter on
 * `jobId`, so like its three siblings above it needs no composite Firestore index.
 *
 * Returns the raw QuerySnapshot, so the service keeps ownership of the document
 * shaping, exactly as it does for the employee, employer and application reads.
 */
const listEmploymentsByJob = (jobId) =>
    db.collection('employments').where('jobId', '==', jobId).get();

/**
 * Every employment recorded for one application.
 *
 * STAGE 7H-2. Added for the duplicate-employment guard in
 * employmentService.createEmploymentFromHire, and nothing else calls it: the two
 * read endpoints keep using the employee and employer queries above, because a
 * caller asking "what has this person been hired for" is not the same question as
 * "has this application already been hired".
 *
 * Single-field equality filter on `applicationId`, so like its two siblings it
 * needs no composite Firestore index. `applicationId` is on every employment this
 * codebase writes -- it is one of the four fields createEmploymentFromHire
 * validates before it adds anything -- so there is no document this query could
 * miss for a reason that matters, and no backfill to consider.
 *
 * Returns the raw QuerySnapshot, so the service keeps ownership of what the empty
 * or non-empty result means, exactly as it does for the other two reads.
 */
const listEmploymentsByApplication = (applicationId) =>
    db.collection('employments').where('applicationId', '==', applicationId).get();

/**
 * One employment, by document id.
 *
 * STAGE 9C. The first single-document read on this collection, and the reason the
 * task guard can be built on `employmentId` rather than on a chain. Every other
 * read here is a query, which means a lookup keyed on something the employment
 * carries; a task carries the employment's own id, so resolving it needs a direct
 * `.doc()` read and cannot be expressed as an equality filter over a field the task
 * does not have.
 *
 * Mirrors jobRepository.getJobById, including returning a raw snapshot: what a
 * missing document means is the caller's decision, not this file's.
 */
const getEmploymentById = (employmentId) =>
    db.collection('employments').doc(employmentId).get();

const updateEmploymentFields = (employmentId, updates) =>
    db.collection('employments').doc(employmentId).update(updates);

module.exports = {
    addEmployment,
    getEmploymentById,
    listEmploymentsByEmployee,
    listEmploymentsByEmployer,
    listEmploymentsByJob,
    listEmploymentsByApplication,
    updateEmploymentFields,
};