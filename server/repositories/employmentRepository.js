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

module.exports = {
    addEmployment,
    listEmploymentsByEmployee,
    listEmploymentsByEmployer,
};