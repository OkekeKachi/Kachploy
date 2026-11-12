'use strict';

// ledgerRepository.js
//
// STAGE 2A. Create-and-read persistence for immutable ledger entries.
//
// There is intentionally no update, delete, replace or merge API. A correction
// is a NEW entry with a new deterministic id. `createEntryIfAbsent` uses
// Firestore `create` semantics, so an existing id is never overwritten.
//
// This layer validates nothing about accounting semantics; the trusted server
// must construct entries through services/releaseLedger.js. As with events,
// repository immutability does not replace Firestore security rules or the
// assumption that only the trusted server writes these collections.

const { db } = require('../config/firebase');

const crypto = require('crypto');

const entryDoc = (entryId) => db.collection('ledgerEntries').doc(entryId);

const createEntryInTransaction = (tx, entryId, data) =>
    tx.create(entryDoc(entryId), data);

/**
 * Generates a deterministic compensating entry id from an original entry id.
 * The compensating entry uses the same releaseId and a hashed key so that
 * duplicate compensating entries are idempotent (same as createEntryIfAbsent).
 */
const compensatingEntryId = (entryId) => {
    const digest = crypto.createHash('sha256').update(`comp_${entryId}`).digest('hex');
    return `comp_${digest}`;
};

/**
 * Creates one ledger entry if its deterministic id is free. A duplicate returns
 * `{ created: false }` and leaves the stored entry unchanged.
 */
const createEntryIfAbsent = async (entryId, data) => {
    try {
        await entryDoc(entryId).create(data);
        return { created: true, entryId };
    } catch (error) {
        if (error && error.code === 6) {
            return { created: false, entryId };
        }
        throw error;
    }
};

/**
 * Creates a compensating entry for an existing ledger entry if absent.
 * The compensating entry has the opposite direction and a reference
 * to the original entry id, enabling append-only corrections.
 * A duplicate compensating entry returns `{ created: false }` and leaves
 * both entries unchanged.
 *
 * @param {string} originalEntryId - the deterministic id of the original entry
 * being compensated
 * @param {string} releaseId - the release id the entry belongs to
 * @param {string} direction - the direction for the compensating entry
 *   ('debit' or 'credit', opposite of the original entry's direction)
 * @param {number} amountMinor - the amount minor of the original entry
 * @param {string} currency - the currency of the original entry
 * @param {string} account - the account of the original entry
 * @returns {{ created: boolean, entryId: string }} - created status and the
 * new compensating entry id
 */
const createCompensatingEntryIfAbsent = async (
    originalEntryId,
    releaseId,
    direction,
    amountMinor,
    currency,
    account
) => {
    const compEntryId = compensatingEntryId(originalEntryId);
    const compData = {
        releaseId,
        entryType: 'release_payable',
        direction,
        amountMinor,
        currency,
        account,
        reference: `comp_${originalEntryId}`,
        createdAt: new Date(),
    };

    try {
        await entryDoc(compEntryId).create(compData);
        return { created: true, entryId: compEntryId };
    } catch (error) {
        if (error && error.code === 6) {
            return { created: false, entryId: compEntryId };
        }
        throw error;
    }
};

const getEntryById = (entryId) => entryDoc(entryId).get();

const listEntriesByReleaseId = (releaseId) =>
    db.collection('ledgerEntries').where('releaseId', '==', releaseId).get();

module.exports = {
    createEntryInTransaction,
    createEntryIfAbsent,
    createCompensatingEntryIfAbsent,
    compensatingEntryId,
    getEntryById,
    listEntriesByReleaseId,
};
