'use strict';

// paymentRepository.js
//
// Data-access layer for the `payments` collection (new in Stage P2). It owns
// the direct Firestore calls for the local payment-RECORD foundation: the
// deterministic-id create, the one-document read behind the idempotency
// handling and the GET, and the idempotency-key query.
//
// SCOPE: this one collection. Nothing else in the codebase reaches it, so --
// like `contracts` and `milestones` before it -- it is served exclusively by
// this file from the moment it is created. This layer holds no business logic:
// it knows nothing about HTTP, status codes, controllers, Express, tokens or
// authorisation, and it raises no error of its own. It owns the direct
// Firestore calls for the payment record: the deterministic-id create, the
// one-document read behind the idempotency handling and the GET, the
// idempotency-key query, and -- since Stage 1D -- the partial-update path the
// provider-verification stages will build on.
//
// WHAT A PAYMENT RECORD IS. It is Kachploy having stored a payment REQUEST for
// one milestone. It is not evidence that a payment provider was contacted, that
// the employer was charged, or that the employee was paid -- P2 writes no
// provider field and reads no provider configuration, and the status vocabulary
// has exactly one value ('created'). Every provider-facing stage comes later
// and must verify money movement server-side; nothing in this file moves any.
//
// DETERMINISTIC PAYMENT ID. The payment document is stored under its
// MILESTONE's id, which makes "at most one payment record per milestone" a
// property of the id space rather than of a query-then-write race: two
// concurrent initiations for the same milestone resolve to the SAME document
// id, so they collide on one key instead of producing two documents. As with
// contracts, collision is not protection -- a later set() REPLACES whatever
// the earlier one wrote -- but here that is acceptable by design: both writers
// are writing the same server-derived record for the same milestone, differing
// at most in the client's idempotencyKey, and no money moves off the back of
// whichever write lands. The SEQUENTIAL duplicate is handled in
// paymentService.initiatePayment (same key replays, different key is a 400).
//
// IDEMPOTENCY-KEY UNIQUENESS IS A QUERY, NOT A CONSTRAINT. Firestore has no
// unique index this harness models, so cross-milestone key uniqueness is
// enforced by findPaymentsByIdempotencyKey below -- a check-then-write, with
// the same documented concurrent-creation race the contracts resource has.
// There is no transaction and no batch, because the test harness supports
// neither; that limitation is recorded in paymentService rather than hidden
// here. The single-document create at the end of the flow means the payments
// resource has NO partial-write window of its own (unlike contract +
// milestones): a refused request writes nothing, and a request that reaches
// the write writes exactly one document.

const crypto = require('crypto');
const { db, admin } = require('../config/firebase');

/**
 * STAGE 2G. The document-id field handle for the bounded paid-payment page
 * query. `admin.firestore.FieldPath.documentId()` is stable in the SDK and the
 * fake returns the sentinel the fake Query engine understands.
 */
const DOCUMENT_ID_FIELD = admin.firestore.FieldPath.documentId();

/**
 * Creates (or replaces) one payment document under a deterministic id -- the
 * milestone id -- and returns that id.
 *
 * A plain `.set()`, not `.add()`: the id is chosen by the caller (the
 * milestone id) precisely so the one-payment-per-milestone rule is enforced by
 * the key space. No merge flag: a create owns the whole document. The partial
 * update below is a separate, explicit path -- it never runs through a create,
 * so no create can accidentally preserve a field from a previous document.
 */
const createPayment = async (milestoneId, data) => {
    await db.collection('payments').doc(milestoneId).set(data);
    return milestoneId;
};

/**
 * STAGE 1K. Atomically creates the one payment document for a milestone, or
 * reports that one already exists.
 *
 * `.create()`, not `.set()`: the real SDK rejects an existing document with a
 * code-6 ALREADY_EXISTS error, so two concurrent creates on the same
 * deterministic id cannot both succeed and the second CANNOT overwrite the
 * first's idempotency key or money fields. `.set()` (createPayment above) is a
 * blind replace and is retained only for callers that genuinely need
 * create-or-replace; the payment-creation path deliberately does not.
 *
 * Returns `{ created: true }` when this call stored the document, or
 * `{ created: false }` when one was already present (the caller re-reads and
 * decides replay-vs-conflict). No business meaning is assigned here -- what an
 * existing document implies stays the service's decision, exactly as
 * getPaymentByMilestoneId's missing-document meaning does.
 */
const createPaymentIfAbsent = async (milestoneId, data) => {
    try {
        await db.collection('payments').doc(milestoneId).create(data);
        return { created: true };
    } catch (error) {
        // Code 6 is the SDK's ALREADY_EXISTS. Anything else (a transport fault,
        // an unexpected shape) is rethrown rather than guessed as a conflict.
        if (error && error.code === 6) {
            return { created: false };
        }
        throw error;
    }
};

/**
 * STAGE 1K. Atomically claims an existing payment record for initialization:
 * the read of the current status and the write of the in-progress state happen
 * in ONE transaction, so two concurrent initialize requests cannot both move a
 * retryable record to `pending` and each go on to call the provider.
 *
 * The transaction re-checks the SAME gate the sequential path does. A `created`
 * record is always claimable; a `failed` record is claimable only when the
 * caller permits a retry. It then writes
 * `{ status: 'pending', verifyAttempts: <n+1> }`. It returns a discriminated
 * result rather than throwing, because "somebody else claimed it first" is a
 * normal outcome the service maps to its existing refusal, not an error:
 *
 *   { claimed: true,  verifyAttempts, previousStatus }  -- moved to pending
 *   { claimed: false, reason: 'missing' }  -- no document (raced an absence)
 *   { claimed: false, reason: 'not-claimable', status } -- pending/paid/review
 *   { claimed: false, reason: 'attempt-limit', status } -- no attempts left
 *
 * `nextAttemptsFor(current)` is supplied by the service so the attempt-count
 * policy stays where it is already defined; this file only performs the
 * compare-and-set. Returning `null` means the attempt limit has been reached.
 * No status value or transition rule other than `created|failed -> pending`
 * lives here.
 */
const claimPaymentForInitialization = async (
    milestoneId,
    nextAttemptsFor,
    { allowFailedRetry = false } = {}
) =>
    db.runTransaction(async (tx) => {
        const ref = db.collection('payments').doc(milestoneId);
        const snapshot = await tx.get(ref);
        if (snapshot === undefined || snapshot.data() === undefined) {
            return { claimed: false, reason: 'missing' };
        }
        const record = snapshot.data();
        const claimable =
            record.status === 'created' ||
            (allowFailedRetry && record.status === 'failed');
        if (!claimable) {
            return { claimed: false, reason: 'not-claimable', status: record.status };
        }
        const verifyAttempts = nextAttemptsFor(record);
        if (verifyAttempts === null) {
            return {
                claimed: false,
                reason: 'attempt-limit',
                status: record.status,
                verifyAttempts: record.verifyAttempts,
            };
        }
        tx.update(ref, {
            status: 'pending',
            verifyAttempts,
        });
        return {
            claimed: true,
            verifyAttempts,
            previousStatus: record.status,
        };
    });

/**
 * One payment, by the milestone id it is stored under.
 *
 * Mirrors getContractById, including returning a raw snapshot: what a missing
 * document means (an idempotent replay's sibling, a duplicate's refusal, or a
 * 404 on read) is the service's decision, not this file's. Both the service's
 * idempotency handling and its read path use this single lookup.
 */
const getPaymentByMilestoneId = (milestoneId) =>
    db.collection('payments').doc(milestoneId).get();

/**
 * Every payment recorded against one idempotency key.
 *
 * Single-field equality filter, mirroring the other single-field queries in
 * this codebase -- so it needs no composite Firestore index and the fake
 * harness supports it (its only implemented operator). Returns the raw
 * QuerySnapshot so the service keeps ownership of what a non-empty result
 * means. This is the cross-milestone duplicate-key check; see the race note at
 * the top of this file.
 */
const findPaymentsByIdempotencyKey = (idempotencyKey) =>
    db.collection('payments').where('idempotencyKey', '==', idempotencyKey).get();

/**
 * Every payment record in which one user is the employer.
 *
 * A single-field equality filter, so it needs no composite Firestore index and
 * is supported by the fake harness. The caller's uid comes from the verified
 * token, never from a request parameter; what a record means and whether the
 * caller may see it is the service's decision.
 */
const listPaymentsByEmployerId = (employerId) =>
    db.collection('payments').where('employerId', '==', employerId).get();

/** Every payment record in which one user is the employee. */
const listPaymentsByEmployeeId = (employeeId) =>
    db.collection('payments').where('employeeId', '==', employeeId).get();

/** Every payment record. Read-only; used by accounting audit checks. */
const listAllPayments = () => db.collection('payments').get();

/**
 * STAGE 2G. One bounded page of PAID payment records.
 *
 * Equality filter on `status` plus a document-id ordering -- no composite
 * index required. The page is the trusted enumeration source the historical
 * collection backfill needed: the WHERE clause keeps it to the only status a
 * collection journal may post for, and the ordering gives a stable cursor.
 * `afterId` resumes strictly after that document id; absent means the first
 * page. This layer performs no eligibility or amount checks -- the backfill
 * service decides what each returned record justifies.
 */
const listPaidPaymentsPage = ({ limit = 100, afterId } = {}) => {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new TypeError('limit must be a positive safe integer');
    }

    let query = db
        .collection('payments')
        .where('status', '==', 'paid')
        .orderBy(DOCUMENT_ID_FIELD)
        .limit(limit);
    if (afterId !== undefined && afterId !== null) {
        query = query.startAfter(afterId);
    }
    return query.get();
};

/**
 * Applies a partial update to one existing payment document (stored under the
 * milestone id), writing only the keys it is handed.
 *
 * STAGE 1D. The first write this collection has ever had after creation, and
 * the only reason `payments` stopped being create-only. A plain `.update()`,
 * not a `set` -- mirroring updateTaskFields, updateJobFields and
 * updateInterviewFields -- so fields absent from the patch are left alone and
 * a caller can move one field without first reading the document to merge it.
 * A whole-document `set()` would put every other stored field one careless
 * caller away from being overwritten.
 *
 * No existence read here, and no error of this file's own: a missing document
 * surfaces as the SDK's NOT_FOUND, exactly as the interview/task/job update
 * paths document. No field is allow-listed here either, and no status or
 * value is inspected, normalised or transition-checked -- which fields may be
 * written, and what a status change means, is the calling service's decision,
 * not this file's. The harness's update primitive is a merge of the supplied
 * keys only; it does not model transactions, and none is attempted.
 */
const updatePaymentFields = (milestoneId, fields) =>
    db.collection('payments').doc(milestoneId).update(fields);

/**
 * Atomic create + global idempotency-key claim.
 *
 * The query in findPaymentsByIdempotencyKey is a fast sequential check, but it
 * cannot make "this key is unused" true for two concurrent requests: both can
 * read an empty result and then write two different payment ids. This
 * transaction removes that window by claiming a deterministic key document in
 * `paymentIdempotencyKeys` in the SAME commit as the payment create. The hash
 * keeps arbitrary client keys out of document ids.
 *
 * Returns `{ created: true }`, `{ created: false, reason: 'payment-exists' }`
 * when this payment id was already written, or
 * `{ created: false, reason: 'key-conflict', paymentId }` when the key is
 * claimed by another payment. The service keeps ownership of what each result
 * means for its response.
 */
const idempotencyKeyDocumentId = (idempotencyKey) =>
    crypto.createHash('sha256').update(idempotencyKey).digest('hex');

const createPaymentWithIdempotencyGuard = (paymentId, data) =>
    db.runTransaction(async (tx) => {
        const paymentRef = db.collection('payments').doc(paymentId);
        const keyRef = db
            .collection('paymentIdempotencyKeys')
            .doc(idempotencyKeyDocumentId(data.idempotencyKey));

        const paymentSnapshot = await tx.get(paymentRef);
        const keySnapshot = await tx.get(keyRef);

        if (paymentSnapshot.exists) {
            return { created: false, reason: 'payment-exists' };
        }

        if (keySnapshot.exists) {
            return {
                created: false,
                reason: 'key-conflict',
                paymentId: keySnapshot.data().paymentId,
            };
        }

        tx.create(paymentRef, data);
        tx.create(keyRef, {
            paymentId,
            idempotencyKey: data.idempotencyKey,
            createdAt: data.createdAt,
        });
        return { created: true };
    });

// ---------------------------------------------------------------------------
// Contract-level payment identity
// ---------------------------------------------------------------------------
//
// A full-contract payment is stored under `contract_<contractId>`, a sibling
// of the milestone-keyed records in the same collection. The prefix keeps the
// two id spaces disjoint: a contract id can never collide with a milestone id,
// and the provider reference derived from this document id is
// `kp_contract_<contractId>`. The milestone functions above are deliberately
// left unchanged so every existing record keeps its identity.

const CONTRACT_PAYMENT_ID_PREFIX = 'contract_';

const contractPaymentId = (contractId) => `${CONTRACT_PAYMENT_ID_PREFIX}${contractId}`;

const createContractPaymentIfAbsent = (contractId, data) =>
    createPaymentWithIdempotencyGuard(contractPaymentId(contractId), data);

const claimContractPaymentForInitialization = (
    contractId,
    nextAttemptsFor,
    options
) =>
    claimPaymentForInitialization(
        contractPaymentId(contractId),
        nextAttemptsFor,
        options
    );

const getPaymentByContractId = (contractId) =>
    getPaymentByMilestoneId(contractPaymentId(contractId));

const updateContractPaymentFields = (contractId, fields) =>
    updatePaymentFields(contractPaymentId(contractId), fields);

module.exports = {
    createPayment,
    createPaymentIfAbsent,
    claimPaymentForInitialization,
    getPaymentByMilestoneId,
    findPaymentsByIdempotencyKey,
    listPaymentsByEmployerId,
    listPaymentsByEmployeeId,
    listAllPayments,
    listPaidPaymentsPage,
    updatePaymentFields,
    createPaymentWithIdempotencyGuard,
    idempotencyKeyDocumentId,
    contractPaymentId,
    createContractPaymentIfAbsent,
    claimContractPaymentForInitialization,
    getPaymentByContractId,
    updateContractPaymentFields,
};
