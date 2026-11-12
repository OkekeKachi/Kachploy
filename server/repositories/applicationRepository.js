// applicationRepository.js
//
// Data-access layer for the `applications` collection (new in Stage 4B). It
// owns the direct Firestore calls for that collection which used to sit inside
// applicationService.js: the document reads, the two queries, the create, the
// status update and the withdrawal delete. It also owns the internal
// `applicationUniquenessKeys` collection that makes duplicate detection atomic.
//
// SCOPE: applications persistence plus that one companion guard collection.
// Two of applicationService's Firestore calls are deliberately NOT here,
// because they are not applications persistence:
//   * applyToJob reads a job document to inspect `negotiable`
//   * listApplicationsForEmployee reads one job per application (an N+1 read)
// Those stay in the service, which preserves the cross-collection orchestration
// and the write ordering that Stage 4B is not allowed to change.
//
// This layer holds no business logic. It knows nothing about HTTP, status codes,
// controllers, Express, tokens or authorisation, and it raises no error of its
// own: reads hand back the raw DocumentSnapshot or QuerySnapshot so
// applicationService keeps ownership of the `exists` checks and of the
// ApplicationNotFoundError / ApplicationValidationError classes. The per-record
// job join in listApplicationsForEmployee and the negotiable price branches are
// all service concerns and stay there. No collection other than `applications`
// and `applicationUniquenessKeys` is touched from this layer.
//
// Stage 5B added listAllApplications for the applicant-count read path, and
// moved the owner check for the applications-by-job list into
// middleware/auth.js. The repository is unaffected by that change: it holds no
// notion of who may read an application, and it never returns a count itself --
// the aggregation lives in the service.
//
// Application creation uses a companion uniqueness-key document so the
// application keeps its Firestore-generated id and a withdrawn application can
// be submitted again without inheriting old application-scoped records. The key
// is derived from (jobId, employeeId) and is created in the SAME transaction as
// the application. Withdrawal deletes the application and its key in one
// transaction. Applications written before this guard have no key; the service's
// lookup still recognises them, so legacy data keeps its existing meaning.

const crypto = require('crypto');
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
 * The deterministic id for the uniqueness key of one (jobId, employeeId) pair.
 *
 * The null separator makes the pair unambiguous before hashing. The digest is
 * a valid Firestore document id and never exposes either raw id as a path.
 */
const applicationUniquenessKeyId = (jobId, employeeId) =>
    crypto
        .createHash('sha256')
        .update(`${jobId}\u0000${employeeId}`)
        .digest('hex');

/**
 * Atomically creates an application unless one already exists for the same
 * (jobId, employeeId) pair.
 *
 * The application id remains generated, so existing id shape and all
 * application-scoped relationships are unchanged. The transaction reads and
 * writes the pair's key document and the application in one commit: concurrent
 * submissions both see the key absent, one creates it, and the other retries
 * (or observes it) and returns `{ created: false }` without writing an
 * application. A stale key whose application no longer exists is overwritten in
 * the same transaction, so an out-of-band application delete cannot block a
 * legitimate re-application forever. The key write is a transaction `set`
 * because a delete-then-create of the same document is not portable across
 * Firestore transaction implementations; the transaction's read conflict still
 * serialises two absent-key submissions.
 */
const createApplicationIfAbsent = async (data) => {
    const applicationRef = db.collection('applications').doc();
    const keyRef = db
        .collection('applicationUniquenessKeys')
        .doc(applicationUniquenessKeyId(data.jobId, data.employeeId));

    return db.runTransaction(async (tx) => {
        const keySnapshot = await tx.get(keyRef);

        if (keySnapshot.exists) {
            const existingId = keySnapshot.data().applicationId;
            const existingRef = db.collection('applications').doc(existingId);
            const existingSnapshot = await tx.get(existingRef);

            if (existingSnapshot.exists) {
                return { created: false, applicationId: existingId };
            }
        }

        tx.create(applicationRef, data);
        tx.set(keyRef, {
            jobId: data.jobId,
            employeeId: data.employeeId,
            applicationId: applicationRef.id,
        });

        return { created: true, applicationId: applicationRef.id };
    });
};

/**
 * Deletes one application and the uniqueness key that points at it, atomically.
 *
 * The key is removed only when it names this application, so an inconsistent
 * key cannot be used to erase a different application's guard. A legacy
 * application without a key is still deleted normally.
 */
const deleteApplicationWithUniquenessKey = (applicationId, jobId, employeeId) =>
    db.runTransaction(async (tx) => {
        const applicationRef = db.collection('applications').doc(applicationId);
        const keyRef = db
            .collection('applicationUniquenessKeys')
            .doc(applicationUniquenessKeyId(jobId, employeeId));

        const applicationSnapshot = await tx.get(applicationRef);
        const keySnapshot = await tx.get(keyRef);

        if (!applicationSnapshot.exists) {
            return { deleted: false };
        }

        tx.delete(applicationRef);

        if (keySnapshot.exists && keySnapshot.data().applicationId === applicationId) {
            tx.delete(keyRef);
        }

        return { deleted: true };
    });

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
 * STAGE 12.11. The applications one employee has already filed against one job,
 * used by applyToJob to refuse a duplicate submission.
 *
 * Two equality filters on two fields. Firestore serves this from its automatic
 * single-field indexes (no composite index is required for equality-only
 * filters), and the test double implements chained `where` for the same shape.
 * Returns the raw QuerySnapshot; the service decides what an empty result means.
 */
const listApplicationsByJobAndEmployee = (jobId, employeeId) =>
    db.collection('applications')
        .where('jobId', '==', jobId)
        .where('employeeId', '==', employeeId)
        .get();

/**
 * Sets the `status` field on one application.
 *
 * No existence read is performed here. The status endpoint's not-found handling
 * comes from the requireApplicationReviewer guard, before the service runs.
 */
const updateApplicationStatusField = (applicationId, newStatus) =>
    db.collection('applications').doc(applicationId).update({ status: newStatus });

module.exports = {
    getApplicationById,
    createApplicationIfAbsent,
    listAllApplications,
    listApplicationsByEmployee,
    listApplicationsByJob,
    listApplicationsByJobAndEmployee,
    updateApplicationStatusField,
    deleteApplicationWithUniquenessKey,
};
