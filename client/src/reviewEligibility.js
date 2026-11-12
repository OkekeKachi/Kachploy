export const COMPLETED_EMPLOYMENT_STATUSES = ['completed', 'terminated', 'ended'];
export const JOB_STATUSES_THAT_BLOCK_EMPLOYER_REVIEW = ['open', 'filled'];

const normalizedStatus = (value) =>
    typeof value === 'string' ? value.toLowerCase() : '';

export const isEmployerReviewEligible = (employment, job) => {
    if (!employment) return false;

    if (COMPLETED_EMPLOYMENT_STATUSES.includes(normalizedStatus(employment.status))) {
        return true;
    }

    if (!employment.jobId) return false;
    if (!job) return false;
    if (job.postedBy !== employment.employerId) return false;

    const jobStatus = normalizedStatus(job.status);
    return jobStatus !== '' && !JOB_STATUSES_THAT_BLOCK_EMPLOYER_REVIEW.includes(jobStatus);
};

export const canReviewEmployment = (employment, job, reviewerId) => {
    if (!employment || !reviewerId) return false;

    const reviewerIsEmployer = employment.employerId === reviewerId;
    return !reviewerIsEmployer || isEmployerReviewEligible(employment, job);
};
