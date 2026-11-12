'use strict';

// paymentAttemptRepository.js
//
// Durable, immutable-per-attempt provider transactions for the payments
// resource. A payment record stays the single local request for a milestone or
// contract; every time that request is sent to the provider a new attempt is
// recorded here, with its own single-use reference. This is what lets a
// definitive provider failure be retried safely without ever reusing a Paystack
// reference.
//
// Collections:
//   paymentAttempts/{paymentId}__attempt_{n}
//     The identity and outcome of one provider transaction attempt.
//   paymentReferences/{sha256(reference)}
//     A write-once reference claim. The hash keeps arbitrary reference text out
//     of document ids and makes "this reference belongs to exactly one attempt"
//     a property of the key space.
//
// The attempt claim, the reference claim and the parent payment's in-flight
// latch are committed in ONE Firestore transaction, so a concurrent duplicate
// cannot create two attempts or two references for the same decision point.

const crypto = require('crypto');
const { db } = require('../config/firebase');

const ATTEMPTS_COLLECTION = 'paymentAttempts';
const REFERENCES_COLLECTION = 'paymentReferences';
const REFERENCE_PREFIX = 'kp_';

const attemptDocumentId = (paymentId, attemptNumber) =>
    `${paymentId}__attempt_${attemptNumber}`;

const referenceForAttempt = (paymentId, attemptNumber) =>
    attemptNumber === 1
        ? `${REFERENCE_PREFIX}${paymentId}`
        : `${REFERENCE_PREFIX}${paymentId}_a${attemptNumber}`;

const referenceDocumentId = (reference) =>
    crypto.createHash('sha256').update(reference).digest('hex');

const toPlainObject = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });

/**
 * Atomically claims the next attempt for a payment.
 *
 * The caller supplies pure builders so this repository owns only storage and
 * compare-and-set, exactly like the other repositories in this codebase:
 *   nextAttemptsFor(record)   -> the next attempt number
 *   buildAttempt(record, n, r)-> the attempt document to write
 *   buildLegacyAttempt(record,n,r) -> optional backfill for a historical
 *                               reference that had no attempt document
 *
 * Returns discriminated results; the service maps them to its safe refusals.
 */
const claimPaymentAttempt = async ({
    paymentId,
    nextAttemptsFor,
    allowFailedRetry = false,
    buildAttempt,
    buildLegacyAttempt,
}) =>
    db.runTransaction(async (tx) => {
        const paymentRef = db.collection('payments').doc(paymentId);
        const paymentSnapshot = await tx.get(paymentRef);
        if (paymentSnapshot === undefined || paymentSnapshot.data() === undefined) {
            return { claimed: false, reason: 'missing' };
        }

        const record = paymentSnapshot.data();
        const claimable =
            record.status === 'created' ||
            (allowFailedRetry && record.status === 'failed');
        if (!claimable) {
            return { claimed: false, reason: 'not-claimable', status: record.status };
        }

        const attemptNumber = nextAttemptsFor(record);
        if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
            return { claimed: false, reason: 'invalid-attempt-number' };
        }

        const attemptId = attemptDocumentId(paymentId, attemptNumber);
        const attemptRef = db.collection(ATTEMPTS_COLLECTION).doc(attemptId);
        const attemptSnapshot = await tx.get(attemptRef);
        if (attemptSnapshot.exists) {
            return { claimed: false, reason: 'attempt-exists', attemptId };
        }

        let reference = referenceForAttempt(paymentId, attemptNumber);
        let referenceRef = db.collection(REFERENCES_COLLECTION).doc(referenceDocumentId(reference));
        let referenceSnapshot = await tx.get(referenceRef);
        let collision = 1;
        while (referenceSnapshot.exists && collision <= 3) {
            reference = `${referenceForAttempt(paymentId, attemptNumber)}_r${collision}`;
            referenceRef = db.collection(REFERENCES_COLLECTION).doc(
                referenceDocumentId(reference)
            );
            referenceSnapshot = await tx.get(referenceRef);
            collision += 1;
        }
        if (referenceSnapshot.exists) {
            return { claimed: false, reason: 'reference-conflict' };
        }

        const legacyAttemptNumber = attemptNumber - 1;
        const historicalReference =
            typeof record.providerReference === 'string' && record.providerReference.trim()
                ? record.providerReference
                : null;
        let legacyAttemptRef = null;
        let legacyAttemptSnapshot = null;
        let legacyReferenceRef = null;
        let legacyReferenceSnapshot = null;

        if (
            typeof buildLegacyAttempt === 'function' &&
            historicalReference &&
            historicalReference !== reference &&
            legacyAttemptNumber >= 1
        ) {
            const legacyAttemptId = attemptDocumentId(paymentId, legacyAttemptNumber);
            legacyAttemptRef = db.collection(ATTEMPTS_COLLECTION).doc(legacyAttemptId);
            legacyAttemptSnapshot = await tx.get(legacyAttemptRef);

            legacyReferenceRef = db
                .collection(REFERENCES_COLLECTION)
                .doc(referenceDocumentId(historicalReference));
            legacyReferenceSnapshot = await tx.get(legacyReferenceRef);
        }

        const createdAt = new Date();

        if (
            legacyAttemptRef &&
            legacyAttemptSnapshot &&
            !legacyAttemptSnapshot.exists
        ) {
            tx.create(
                legacyAttemptRef,
                buildLegacyAttempt(record, legacyAttemptNumber, historicalReference)
            );
            if (!legacyReferenceSnapshot.exists) {
                tx.create(legacyReferenceRef, {
                    reference: historicalReference,
                    paymentId,
                    attemptId: attemptDocumentId(paymentId, legacyAttemptNumber),
                    attemptNumber: legacyAttemptNumber,
                    createdAt,
                    legacy: true,
                });
            }
        }

        tx.create(attemptRef, buildAttempt(record, attemptNumber, reference));
        tx.create(referenceRef, {
            reference,
            paymentId,
            attemptId,
            attemptNumber,
            createdAt,
            legacy: false,
        });
        tx.update(paymentRef, {
            status: 'pending',
            verifyAttempts: attemptNumber,
        });

        return {
            claimed: true,
            attemptId,
            attemptNumber,
            reference,
            previousStatus: record.status,
        };
    });

const getPaymentAttempt = (paymentId, attemptNumber) =>
    db.collection(ATTEMPTS_COLLECTION).doc(attemptDocumentId(paymentId, attemptNumber)).get();

const getAttemptByReference = (reference) =>
    db
        .collection(REFERENCES_COLLECTION)
        .doc(referenceDocumentId(reference))
        .get();

const listAttemptsByPaymentId = (paymentId) =>
    db.collection(ATTEMPTS_COLLECTION).where('paymentId', '==', paymentId).get();

const updatePaymentAttempt = (attemptId, fields) =>
    db.collection(ATTEMPTS_COLLECTION).doc(attemptId).update(fields);

/**
 * Applies one outcome to the parent payment and its attempt in one commit. The
 * attempt is optional so legacy records with no attempt document can still use
 * the normal parent update path.
 *
 * The decision is made INSIDE the transaction, against the document as it is
 * NOW, not against the snapshot the caller read before contacting the provider.
 * `resolveWrite(currentRecord, paymentFields, attemptFields)` is supplied by the
 * service as a pure policy: it may refuse the write (a terminal state wins over
 * a slower outcome) or substitute safer fields (a forbidden promotion becomes
 * review). Returning `apply: false` leaves BOTH documents untouched, which is
 * what makes a concurrent late write unable to downgrade a settled payment.
 *
 * Returns `{ applied, status, reason? }`, where `status` is the record's status
 * after the commit (or the current status when the write was refused). Reads
 * all happen before the first buffered write, as the SDK requires.
 */
const applyPaymentAndAttemptOutcome = async ({
    paymentId,
    attemptNumber,
    paymentFields,
    attemptFields,
    resolveWrite,
}) =>
    db.runTransaction(async (tx) => {
        const paymentRef = db.collection('payments').doc(paymentId);
        const paymentSnapshot = await tx.get(paymentRef);
        if (paymentSnapshot === undefined || paymentSnapshot.data() === undefined) {
            return { applied: false, reason: 'missing-payment' };
        }
        const currentRecord = paymentSnapshot.data();

        let attemptRef = null;
        if (Number.isInteger(attemptNumber) && attemptNumber >= 1) {
            attemptRef = db
                .collection(ATTEMPTS_COLLECTION)
                .doc(attemptDocumentId(paymentId, attemptNumber));
            await tx.get(attemptRef);
        }

        const decision =
            typeof resolveWrite === 'function'
                ? resolveWrite(currentRecord, paymentFields, attemptFields) || {}
                : {};

        if (decision.apply === false) {
            return {
                applied: false,
                reason: decision.reason || 'refused',
                status: currentRecord.status,
            };
        }

        const nextPaymentFields =
            decision.paymentFields !== undefined ? decision.paymentFields : paymentFields;
        const nextAttemptFields =
            decision.attemptFields !== undefined ? decision.attemptFields : attemptFields;

        tx.update(paymentRef, nextPaymentFields);
        if (attemptRef) {
            tx.update(attemptRef, nextAttemptFields);
        }

        return {
            applied: true,
            status:
                nextPaymentFields && nextPaymentFields.status !== undefined
                    ? nextPaymentFields.status
                    : currentRecord.status,
            escalated: Boolean(decision.escalated),
        };
    });

module.exports = {
    ATTEMPTS_COLLECTION,
    REFERENCES_COLLECTION,
    REFERENCE_PREFIX,
    attemptDocumentId,
    referenceForAttempt,
    referenceDocumentId,
    claimPaymentAttempt,
    getPaymentAttempt,
    getAttemptByReference,
    listAttemptsByPaymentId,
    updatePaymentAttempt,
    applyPaymentAndAttemptOutcome,
    toPlainObject,
};
