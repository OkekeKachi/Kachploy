// reviewService.js
const crypto = require('crypto');
const { admin } = require('../config/firebase');
const reviewRepository = require('../repositories/reviewRepository');
const employmentRepository = require('../repositories/employmentRepository');
const jobRepository = require('../repositories/jobRepository');

class ReviewValidationError extends Error {}
class ReviewNotFoundError extends Error {}
class ReviewForbiddenError extends Error {}
class ReviewStateError extends Error {}

const COMPLETED_EMPLOYMENT_STATUSES = ['completed', 'terminated', 'ended'];
const JOB_STATUSES_THAT_BLOCK_EMPLOYER_REVIEW = ['open', 'filled'];

const isEmployerReviewEligible = async (employment) => {
    const employmentStatus = typeof employment.status === 'string' ? employment.status.toLowerCase() : '';
    if (COMPLETED_EMPLOYMENT_STATUSES.includes(employmentStatus)) return true;

    if (!employment.jobId) return false;

    const jobSnap = await jobRepository.getJobById(employment.jobId);
    if (!jobSnap.exists) return false;

    const job = jobSnap.data() || {};
    if (job.postedBy !== employment.employerId) return false;

    const jobStatus = typeof job.status === 'string' ? job.status.toLowerCase() : '';
    return jobStatus !== '' && !JOB_STATUSES_THAT_BLOCK_EMPLOYER_REVIEW.includes(jobStatus);
};

const toPlain = (snapshot) => {
    const rows = [];
    snapshot.forEach((doc) => rows.push({ id: doc.id, ...doc.data() }));
    return rows;
};

const createReview = async ({ employmentId, reviewerId, revieweeId, rating, comment = '', role = '' }) => {
    if (!employmentId) throw new ReviewValidationError('employmentId is required');
    if (!reviewerId) throw new ReviewValidationError('reviewerId is required');
    if (!revieweeId) throw new ReviewValidationError('revieweeId is required');
    if (rating === undefined || rating === null) throw new ReviewValidationError('rating is required');

    const r = Number(rating);
    if (Number.isNaN(r) || r < 1 || r > 5) throw new ReviewValidationError('rating must be between 1 and 5');

    const empSnap = await employmentRepository.getEmploymentById(employmentId);
    if (!empSnap.exists) throw new ReviewNotFoundError('Employment not found');
    const employment = empSnap.data();

    const isParty = employment.employerId === reviewerId || employment.employeeId === reviewerId;
    if (!isParty) throw new ReviewForbiddenError('Not authorized to review this employment');

    const expectedReviewee = employment.employerId === reviewerId ? employment.employeeId : employment.employerId;
    if (revieweeId !== expectedReviewee) throw new ReviewValidationError('revieweeId must be the other party to the employment');

    // Legacy reviews carry auto-generated ids, so the read check is still the
    // only way to recognise one submitted before this path existed.
    const existing = await reviewRepository.listReviewsByEmployment(employmentId);
    const dup = toPlain(existing).some(rv => rv.reviewerId === reviewerId);
    if (dup) throw new ReviewStateError('You have already submitted a review for this employment');

    const reviewerIsEmployer = employment.employerId === reviewerId;
    if (reviewerIsEmployer && !(await isEmployerReviewEligible(employment))) {
        throw new ReviewStateError(
            'Reviews are available once the employment is completed or terminated, or the job is closed'
        );
    }

    // One reviewer reviews one employment once. Deriving the document id from
    // that pair makes the uniqueness constraint the document key itself, so the
    // atomic `create()` below -- not the read above -- decides concurrent
    // requests: exactly one wins and the other sees ALREADY_EXISTS.
    const reviewId = crypto
        .createHash('sha256')
        .update(`${employmentId}\u0000${reviewerId}`)
        .digest('hex');

    const now = admin.firestore.FieldValue.serverTimestamp();
    try {
        await reviewRepository.createReviewWithId(reviewId, {
            employmentId,
            jobId: employment.jobId,
            employerId: employment.employerId,
            employeeId: employment.employeeId,
            reviewerId,
            revieweeId,
            rating: r,
            comment: typeof comment === 'string' ? comment : '',
            role,
            createdAt: now,
        });
    } catch (err) {
        if (err && err.code === 6) {
            throw new ReviewStateError('You have already submitted a review for this employment');
        }
        throw err;
    }

    const written = await reviewRepository.getReviewById(reviewId);
    return { review: { id: written.id, ...written.data() } };
};

const listReviewsForEmployment = async (employmentId) => {
    const snap = await reviewRepository.listReviewsByEmployment(employmentId);
    return toPlain(snap);
};

const listReviewsForUser = async (uid) => {
    const snap = await reviewRepository.listReviewsByReviewer(uid);
    return toPlain(snap);
};

module.exports = {
    ReviewValidationError,
    ReviewNotFoundError,
    ReviewForbiddenError,
    ReviewStateError,
    createReview,
    listReviewsForEmployment,
    listReviewsForUser,
};
