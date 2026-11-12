'use strict';

// journalRepository.js
//
// Create-and-read persistence for balanced accounting journals and their
// ledger lines.
//
// There is intentionally no update, delete, replace or merge API. A journal is
// written with all of its entry documents in ONE Firestore transaction, after
// all reads. A crash therefore cannot leave a journal without entries, or
// entries without the journal that explains them.
//
// Idempotency comes from deterministic ids: replaying the same authoritative
// event resolves to the same journal id and the same line ids. If the journal
// or any of its lines already exists, the posting is a reported no-op.

const clock = require('../config/clock');
const { OUTCOME_GUARD_COLLECTION } = require('../config/accounting');
const { db } = require('../config/firebase');

const journalDoc = (journalId) => db.collection('ledgerJournals').doc(journalId);
const entryDoc = (entryId) => db.collection('ledgerEntries').doc(entryId);
const guardDoc = (guardId) =>
    db.collection(OUTCOME_GUARD_COLLECTION).doc(guardId);

/**
 * Creates a journal and every line belonging to it atomically.
 *
 * @param {string} journalId deterministic journal id
 * @param {object} journalData journal document (totals and metadata)
 * @param {Array<{entryId: string, data: object}>} entries ledger lines
 * @returns {{ created: boolean, journalId: string, entryIds?: string[] }}
 */
const createJournalWithEntries = async (journalId, journalData, entries) => {
    if (!Array.isArray(entries) || entries.length < 2) {
        throw new Error('a journal must be created with at least two entries');
    }

    try {
        return await db.runTransaction(async (tx) => {
            // All reads first: Firestore requires it, and it is what makes the
            // duplicate check and the writes one atomic decision.
            const journalSnapshot = await tx.get(journalDoc(journalId));
            const entrySnapshots = [];
            for (const entry of entries) {
                entrySnapshots.push(await tx.get(entryDoc(entry.entryId)));
            }

            if (
                journalSnapshot.exists ||
                entrySnapshots.some((snapshot) => snapshot.exists)
            ) {
                return { created: false, journalId };
            }

            tx.create(journalDoc(journalId), journalData);
            for (const entry of entries) {
                tx.create(entryDoc(entry.entryId), entry.data);
            }

            return {
                created: true,
                journalId,
                entryIds: entries.map((entry) => entry.entryId),
            };
        });
    } catch (error) {
        if (error && error.code === 6) {
            return { created: false, journalId };
        }
        throw error;
    }
};

/**
 * STAGE 2H.1. Creates a journal and its lines only if a synchronous `decide`
 * function, evaluated inside the same transaction against the outcome guard and
 * the journal/entry documents, allows it.
 *
 * `decide({ guard, journalExists })` receives the current guard document (or
 * null) and whether the journal (or any of its lines) already exists. It returns
 * one of:
 *   { action: 'create', guard }  write the guard, journal and lines
 *   { action: 'duplicate' }      report the existing journal, write nothing
 *   { action: 'retry', recovered } rebuild with the authoritative recovered
 *                                form, write nothing
 *   { action: 'refuse', reason, message } reject the posting, write nothing
 *
 * Because the guard read, the decision and every write happen in one
 * transaction, two concurrent outcome claims for the same attempt cannot both
 * create a journal.
 *
 * @param {string} journalId deterministic journal id
 * @param {object} journalData journal document (totals and metadata)
 * @param {Array<{entryId: string, data: object}>} entries ledger lines
 * @param {{ guardId: string, decide: Function }} options
 * @returns {{ created: boolean, journalId: string, entryIds?: string[] }}
 */
const createJournalWithEntriesGuarded = async (
    journalId,
    journalData,
    entries,
    { guardId, decide } = {}
) => {
    if (!Array.isArray(entries) || entries.length < 2) {
        throw new Error('a journal must be created with at least two entries');
    }
    if (typeof guardId !== 'string' || !guardId.trim()) {
        throw new Error('a guarded journal requires a guard id');
    }
    if (typeof decide !== 'function') {
        throw new Error('a guarded journal requires a decide function');
    }

    try {
        return await db.runTransaction(async (tx) => {
            const guardSnapshot = await tx.get(guardDoc(guardId));
            const journalSnapshot = await tx.get(journalDoc(journalId));
            const entrySnapshots = [];
            for (const entry of entries) {
                entrySnapshots.push(await tx.get(entryDoc(entry.entryId)));
            }

            const decision = decide({
                guard: guardSnapshot.exists ? guardSnapshot.data() : null,
                journalExists:
                    journalSnapshot.exists
                    || entrySnapshots.some((snapshot) => snapshot.exists),
            });

            if (!decision || decision.action === 'duplicate') {
                return { created: false, journalId, duplicate: true };
            }
            if (decision.action === 'retry') {
                return {
                    created: false,
                    journalId,
                    retry: true,
                    recovered: Boolean(decision.recovered),
                };
            }
            if (decision.action === 'refuse') {
                return {
                    created: false,
                    journalId,
                    refused: true,
                    reason: decision.reason,
                    message: decision.message,
                };
            }
            if (decision.action !== 'create' || !decision.guard) {
                throw new Error('decide returned an unsupported guard action');
            }

            tx.set(guardDoc(guardId), decision.guard);
            tx.create(journalDoc(journalId), journalData);
            for (const entry of entries) {
                tx.create(entryDoc(entry.entryId), entry.data);
            }

            return {
                created: true,
                journalId,
                entryIds: entries.map((entry) => entry.entryId),
            };
        });
    } catch (error) {
        if (error && error.code === 6) {
            return { created: false, journalId, duplicate: true };
        }
        throw error;
    }
};

const guardCompensationUpdates = (guard, journalId, updatedAt) => {
    if (!guard) return null;
    const updates = {};
    if (
        guard.terminalJournalId === journalId
        && guard.terminalCompensated !== true
    ) {
        updates.terminalCompensated = true;
    }
    if (
        guard.unknownJournalId === journalId
        && guard.unknownCompensated !== true
    ) {
        updates.unknownCompensated = true;
    }
    if (Object.keys(updates).length === 0) {
        return null;
    }
    updates.updatedAt = updatedAt;
    return updates;
};

/**
 * STAGE 2H.2. Creates a compensating journal and its lines, and marks the
 * outcome guard that points at the compensated journal, in ONE transaction.
 *
 * A crash can therefore never leave a committed compensation whose guard still
 * believes the terminal/unknown outcome is active. Replaying against an
 * existing compensation also repairs a guard left behind by an older
 * non-atomic write, without creating a second journal.
 *
 * The guard is only marked when its terminal/unknown journal id is exactly the
 * journal being compensated; compensating an initiation (or compensating a
 * compensation) never changes an unrelated outcome guard.
 *
 * @param {string} journalId deterministic compensating journal id
 * @param {object} journalData journal document
 * @param {Array<{entryId: string, data: object}>} entries ledger lines
 * @param {{ guardId: string, targetJournalId: string }} options
 */
const createCompensatingJournalWithGuardUpdate = async (
    journalId,
    journalData,
    entries,
    { guardId, targetJournalId } = {}
) => {
    if (!Array.isArray(entries) || entries.length < 2) {
        throw new Error('a journal must be created with at least two entries');
    }
    if (typeof guardId !== 'string' || !guardId.trim()) {
        throw new Error('a compensating journal requires a guard id');
    }
    if (typeof targetJournalId !== 'string' || !targetJournalId.trim()) {
        throw new Error('a compensating journal requires a target journal id');
    }
    if (
        journalData
        && journalData.compensatesJournalId !== targetJournalId
    ) {
        throw new Error('compensating journal must target the named journal');
    }

    try {
        return await db.runTransaction(async (tx) => {
            const guardSnapshot = await tx.get(guardDoc(guardId));
            const journalSnapshot = await tx.get(journalDoc(journalId));
            const entrySnapshots = [];
            for (const entry of entries) {
                entrySnapshots.push(await tx.get(entryDoc(entry.entryId)));
            }

            const guard = guardSnapshot.exists
                ? guardSnapshot.data()
                : null;
            const exists =
                journalSnapshot.exists
                || entrySnapshots.some((snapshot) => snapshot.exists);

            if (exists) {
                // A replay may repair the guard only for an existing journal
                // that really is this compensation. A stray or partial
                // document at the deterministic id must never deactivate the
                // guard for the journal it claims to reverse.
                const storedJournal = journalSnapshot.exists
                    ? journalSnapshot.data()
                    : null;
                const validCompensation =
                    storedJournal
                    && storedJournal.journalType === 'compensating'
                    && storedJournal.compensatesJournalId === targetJournalId
                    && storedJournal.totalDebitMinor
                        === journalData.totalDebitMinor
                    && storedJournal.totalCreditMinor
                        === journalData.totalCreditMinor
                    && entrySnapshots.every((snapshot, index) => {
                        if (!snapshot.exists) return false;
                        const stored = snapshot.data();
                        const expected = entries[index].data;
                        return (
                            stored.journalId === journalId
                            && stored.account === expected.account
                            && stored.direction === expected.direction
                            && stored.amountMinor === expected.amountMinor
                        );
                    });

                if (!validCompensation) {
                    return {
                        created: false,
                        journalId,
                        duplicate: true,
                        guardUpdated: false,
                        invalidCompensation: true,
                    };
                }

                const updates = guardCompensationUpdates(
                    guard,
                    targetJournalId,
                    clock.now()
                );
                if (updates) {
                    tx.update(guardDoc(guardId), updates);
                }
                return {
                    created: false,
                    journalId,
                    duplicate: true,
                    guardUpdated: Boolean(updates),
                };
            }

            tx.create(journalDoc(journalId), journalData);
            for (const entry of entries) {
                tx.create(entryDoc(entry.entryId), entry.data);
            }

            const updates = guardCompensationUpdates(
                guard,
                targetJournalId,
                clock.now()
            );
            if (updates) {
                tx.update(guardDoc(guardId), updates);
            }

            return {
                created: true,
                journalId,
                entryIds: entries.map((entry) => entry.entryId),
                guardUpdated: Boolean(updates),
            };
        });
    } catch (error) {
        if (error && error.code === 6) {
            return { created: false, journalId, duplicate: true };
        }
        throw error;
    }
};

/**
 * Marks the guard for an attempt as compensated when the journal it points at
 * is reversed. Replayed reversals call this again harmlessly. Kept as a
 * separate repair helper; normal compensation uses the atomic write above.
 */
const markOutcomeGuardCompensated = async (guardId, journalId) => {
    if (typeof guardId !== 'string' || !guardId.trim()) {
        throw new Error('a guard id is required');
    }
    if (typeof journalId !== 'string' || !journalId.trim()) {
        throw new Error('a journal id is required');
    }

    return db.runTransaction(async (tx) => {
        const snapshot = await tx.get(guardDoc(guardId));
        if (!snapshot.exists) {
            return false;
        }
        const updates = guardCompensationUpdates(
            snapshot.data(),
            journalId,
            clock.now()
        );
        if (!updates) {
            return false;
        }
        tx.update(guardDoc(guardId), updates);
        return true;
    });
};

const getJournalById = (journalId) => journalDoc(journalId).get();

const listEntriesByJournalId = (journalId) =>
    db.collection('ledgerEntries').where('journalId', '==', journalId).get();

const listJournalsByReleaseId = (releaseId) =>
    db.collection('ledgerJournals').where('releaseId', '==', releaseId).get();

const listJournalsByPaymentId = (paymentId) =>
    db.collection('ledgerJournals').where('paymentId', '==', paymentId).get();

// STAGE 2G read helpers for the read-only accounting audit
// (accountingReconciliationService): whole-ledger checks over journal and
// entry documents. Deliberately read-only like every other query here.
const listAllJournals = () => db.collection('ledgerJournals').get();
const listAllEntries = () => db.collection('ledgerEntries').get();

module.exports = {
    createJournalWithEntries,
    createJournalWithEntriesGuarded,
    createCompensatingJournalWithGuardUpdate,
    markOutcomeGuardCompensated,
    getJournalById,
    listEntriesByJournalId,
    listJournalsByReleaseId,
    listJournalsByPaymentId,
    listAllJournals,
    listAllEntries,
};
