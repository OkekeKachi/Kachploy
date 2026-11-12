'use strict';

// releaseEventRepository.js
//
// STAGE 2A. Append-only audit history for release requests and attempts.
//
// This API exposes ONLY create and read operations. There is no update, delete,
// replace or merge method, so an already-written event cannot be changed
// through this layer. Corrections are additional events.
//
// This is an application-level restriction, not a complete security boundary:
// Firestore security rules and the trusted-server deployment must also deny
// client writes (or all direct client access) to `releaseEvents`.

const { db } = require('../config/firebase');

const eventDoc = (eventId) => db.collection('releaseEvents').doc(eventId);

const appendEventInTransaction = (tx, eventId, data) =>
    tx.create(eventDoc(eventId), data);

/**
 * Creates one event if its deterministic id is free. A second append with the
 * same id returns `{ created: false }` and leaves the first event untouched.
 */
const appendEventIfAbsent = async (eventId, data) => {
    try {
        await eventDoc(eventId).create(data);
        return { created: true, eventId };
    } catch (error) {
        if (error && error.code === 6) {
            return { created: false, eventId };
        }
        throw error;
    }
};

const getEventById = (eventId) => eventDoc(eventId).get();

const listEventsByReleaseId = (releaseId) =>
    db.collection('releaseEvents').where('releaseId', '==', releaseId).get();

module.exports = {
    appendEventInTransaction,
    appendEventIfAbsent,
    getEventById,
    listEventsByReleaseId,
};
