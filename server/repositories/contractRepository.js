'use strict';

// contractRepository.js
//
// Data-access layer for the `contracts` and `milestones` collections (new in
// Stage P1). It owns the direct Firestore calls for both: the deterministic-id
// contract and initial-schedule transaction, the reads behind the guards and
// GET routes, the acceptance update, and the milestone reads.
//
// SCOPE: these two collections only. Nothing else in the codebase reaches
// either one, so -- like `employments` and `conversations` before them -- they
// are served exclusively by this file from the moment they are created.
//
// This layer holds no business logic, exactly as every repository that
// predates it. It knows nothing about HTTP, status codes, controllers,
// Express, tokens or authorisation, and it raises no error of its own: reads
// hand back the raw snapshot so contractService keeps ownership of what a
// missing document means, and the transaction hands back the ids so the
// service keeps ownership of what the caller is told.
//
// ATOMIC CONTRACT + INITIAL SCHEDULE. The contract document is stored under
// its employment's id, so two concurrent creates for the same employment
// resolve to the same document. The transaction reads that id first, then
// creates the contract and every initial milestone in one commit. A duplicate
// returns `{ created: false }` without writing anything; any write failure
// aborts the whole commit, so there is no contract with a partial schedule.
//
// Bounds: the service caps a schedule at 50 milestones, so the transaction is
// at most 51 writes (1 contract + 50 milestones), well below Firestore's
// 500-write transaction limit. The service performs all validation, including
// its bounded task reads, BEFORE entering this transaction; the callback does
// no external calls or unrelated side effects.

const { db } = require('../config/firebase');

/**
 * Atomically creates the contract under its deterministic employment id and,
 * when supplied, its complete initial milestone schedule.
 *
 * The contract uses `.create()` semantics through `tx.create`, not a replace:
 * an existing contract -- pending or accepted -- is never overwritten. The
 * transaction reads the contract id before the first write, so every read is
 * in the required read phase and a concurrent creator conflicts and retries
 * into the `{ created: false }` branch instead of writing a second schedule.
 *
 * Milestone ids remain Firestore-generated. Their references are allocated
 * before the transaction so a retry targets the same ids, and every milestone
 * is created in the same commit as the contract.
 */
const createContractWithMilestonesIfAbsent = async (
    employmentId,
    contractData,
    milestoneData
) => {
    const contractRef = db.collection('contracts').doc(employmentId);
    const milestoneRefs = milestoneData.map(() => db.collection('milestones').doc());

    return db.runTransaction(async (tx) => {
        const existing = await tx.get(contractRef);
        if (existing.exists) {
            return { created: false, contractId: employmentId, milestoneIds: [] };
        }

        tx.create(contractRef, contractData);
        milestoneData.forEach((data, index) => {
            tx.create(milestoneRefs[index], data);
        });

        return {
            created: true,
            contractId: employmentId,
            milestoneIds: milestoneRefs.map((ref) => ref.id),
        };
    });
};

/**
 * One contract, by document id.
 *
 * Mirrors employmentRepository.getEmploymentById, including returning a raw
 * snapshot: what a missing document means is the caller's decision, not this
 * file's. Both the router guards and the service reads use this single
 * lookup; there is no second kind of contract read.
 */
const getContractById = (contractId) =>
    db.collection('contracts').doc(contractId).get();

/**
 * Applies a partial update to one existing contract document.
 *
 * The only writer after create, used by the acceptance path. Deliberately a
 * partial update rather than a replace: acceptance must be able to move
 * `status` and stamp `acceptedAt`/`acceptedBy` without being able to touch
 * `totalAmountMinor`, `commissionAmountMinor` or any of the copied
 * employment identities -- and `update()` enforces that by only ever writing
 * the keys it is handed.
 *
 * No existence read here. The guard has already loaded the document by the
 * time the service calls this, so the not-found case is settled before it.
 */
const updateContractFields = (contractId, partial) =>
    db.collection('contracts').doc(contractId).update(partial);

/**
 * One milestone, by document id.
 *
 * STAGE P2. Added for the payments resource: the payment guards and service
 * need to load a single milestone by the id the client names, and this
 * repository already owns the `milestones` collection ("served exclusively by
 * this file from the moment they are created"). Same raw-snapshot contract as
 * getContractById: what a missing document means stays the caller's decision.
 */
const getMilestoneById = (milestoneId) =>
    db.collection('milestones').doc(milestoneId).get();

/**
 * Every milestone recorded against one contract.
 *
 * Single-field equality filter on `contractId`, mirroring the other
 * single-field list queries in this codebase -- so it needs no composite
 * Firestore index. Returns the raw QuerySnapshot, so the service keeps
 * ownership of the document shaping.
 *
 * Deliberately NOT a subcollection of the contract: the fake-Firestore test
 * harness has no subcollection support (DocRef has no .collection()), and
 * every other many-to-one relationship in this codebase -- messages to
 * conversations, tasks to employments, interviews to applications -- is
 * modelled as a top-level collection carrying the parent id as a field. This
 * follows that pattern exactly.
 */
const listMilestonesByContract = (contractId) =>
    db.collection('milestones').where('contractId', '==', contractId).get();

module.exports = {
    createContractWithMilestonesIfAbsent,
    getContractById,
    updateContractFields,
    getMilestoneById,
    listMilestonesByContract,
};
