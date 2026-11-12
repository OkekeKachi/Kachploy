const { db } = require('../config/firebase');

/**
 * STAGE 1. Append-only history for a task's review lifecycle.
 *
 * Every transition that Stage 1 adds -- submit, approve, request-revision,
 * dispute, admin-review request, admin decision -- appends one document here
 * inside the same transaction as the task write. Nothing in this file updates or
 * deletes an event: a resubmission adds a new snapshot and leaves the previous
 * one readable, which is what makes "resubmission must not overwrite previous
 * evidence" true even though the task document itself only holds the latest
 * submission.
 */
const newEventId = () => db.collection('taskReviewEvents').doc().id;

const setEventInTransaction = (tx, eventId, data) =>
    tx.set(db.collection('taskReviewEvents').doc(eventId), data);

const addEvent = async (data) => {
    const ref = await db.collection('taskReviewEvents').add(data);
    return ref.id;
};

const listEventsByTaskId = (taskId) =>
    db.collection('taskReviewEvents').where('taskId', '==', taskId).get();

const listAllEvents = () => db.collection('taskReviewEvents').get();

module.exports = {
    newEventId,
    setEventInTransaction,
    addEvent,
    listEventsByTaskId,
    listAllEvents,
};
