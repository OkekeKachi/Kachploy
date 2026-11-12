const { db } = require('../config/firebase');

const addReview = async (data) => {
    const ref = await db.collection('reviews').add(data);
    return ref.id;
};

/**
 * Writes a review at a caller-chosen id and refuses to overwrite one that is
 * already there. Firestore's `create()` is the atomic primitive: the existence
 * check and the write are one operation, so two concurrent requests for the
 * same id can never both succeed (the loser gets code 6 ALREADY_EXISTS).
 *
 * The id is deterministic (employment + reviewer), which is what gives the
 * service a key to contend on. Legacy reviews with auto-generated ids are not
 * addressed by this call; the service's read check still guards those.
 */
const createReviewWithId = async (reviewId, data) => {
    await db.collection('reviews').doc(reviewId).create(data);
    return reviewId;
};

const getReviewById = (reviewId) => db.collection('reviews').doc(reviewId).get();

const listReviewsByEmployment = (employmentId) =>
    db.collection('reviews').where('employmentId', '==', employmentId).get();

const listReviewsByReviewer = (reviewerId) =>
    db.collection('reviews').where('reviewerId', '==', reviewerId).get();

module.exports = {
    addReview,
    createReviewWithId,
    getReviewById,
    listReviewsByEmployment,
    listReviewsByReviewer,
};
