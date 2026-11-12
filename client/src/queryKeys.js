// queryKeys.js
//
// Pure query-key builders for the TanStack Query cache (Phase 1 of the
// data-fetching audit). Every cache entry in this app is addressed through a
// key from this module, so invalidation sites and hook call sites cannot drift
// apart by spelling their own literal arrays.
//
// Pure by the same rule as navRouteActive.js and taskPresentation.js: no
// React, no network, no imports -- which is what lets client/test/ exercise it
// with the existing node --test setup.
//
// SHAPE
//   Keys are arrays whose first segment is the resource family and whose
//   remaining segments identify the specific document. invalidateQueries
//   matches by prefix, so invalidating ['user', uid] refreshes exactly that
//   user and nothing else, while a future ['user'] root would cover all users.
//
// Adding a family: add a builder here, import it from the hook and from the
// mutation site, and extend client/test/queryKeys.test.js.

export const queryKeys = {
    // The CALLER's user document -- GET /users/getUser/:uid as read for
    // oneself (whole document, including role and profileComplete). Keyed by
    // uid because the document is per-user: a uid change (sign-out/sign-in)
    // must address a different cache entry than the previous caller's.
    user: (uid) => ['user', uid],

    // The employer's own posted jobs -- GET /jobs/employer/:uid, the list both
    // EmployerDashboard and MyJobs render. The server scopes the read to the
    // caller via requireSelfParam('uid'); the key is uid-scoped for the same
    // reason user() is, so a sign-out/sign-in as a different account cannot
    // address the previous employer's cached list.
    employerJobs: (uid) => ['employer', 'jobs', uid],

    // Per-job applicant totals -- GET /applications/counts (self-scoped from
    // the verified token, no :uid in the path). Still keyed by uid so the cache
    // entry belongs to one signed-in account; the endpoint shape and the
    // counts fallback-to-0 are unchanged.
    applicationCounts: (uid) => ['applications', 'counts', uid],

    // The employer's employment records -- GET /employments/employer/:uid,
    // reduced client-side into the per-job employee counts both pages show.
    // Same uid-scoping rationale as employerJobs.
    employerEmployments: (uid) => ['employer', 'employments', uid],

    // One job document -- GET /jobs/:jobId. Public to signed-in readers through
    // the existing route guard, but still cached under a job-scoped key so an
    // edit can invalidate exactly this document instead of every job read.
    job: (jobId) => ['jobs', jobId],

    // The employer's reads for ONE job. These families share the job root, so a
    // job-scoped invalidation can refresh the document and its child lists
    // together, while the extra segment keeps each list independently targetable.
    jobApplications: (jobId) => ['jobs', jobId, 'applications'],
    jobInterviews: (jobId) => ['jobs', jobId, 'interviews'],
    jobTasks: (jobId) => ['jobs', jobId, 'tasks'],
    jobEmployments: (jobId) => ['jobs', jobId, 'employments'],

    // The employee's own lists. Uid scoping prevents a different signed-in
    // account from addressing the previous account's cached documents.
    employeeApplications: (uid) => ['applications', 'employee', uid],
    employeeEmployments: (uid) => ['employments', 'employee', uid],
    employeeTasks: (uid) => ['tasks', 'employee', uid],

    // One application's applicant-readable interviews. Keyed by application
    // because that is the endpoint's scope and the applicant cannot read the
    // job-wide interview list.
    applicationInterviews: (applicationId) => ['interviews', 'application', applicationId],

    // Contract proposals attached to one application.
    contractProposals: (applicationId) => ['contracts', 'proposals', applicationId],

    // The contract and milestone schedule for one employment. Individual
    // payment records deliberately have no cache key: their status is always
    // read explicitly from the server. The history LIST is cached because it is
    // a server-paginated read, scoped by both caller and the exact filters.
    contract: (employmentId) => ['contracts', 'employment', employmentId],
    paymentHistory: (uid, params) => ['payments', 'history', uid, params],

    // Another user's public profile document, as read by a counterparty. Kept
    // separate from user() so invalidating the caller's own document cannot
    // accidentally address somebody else's public entry.
    publicUser: (uid) => ['users', 'public', uid],
};

export default queryKeys;
