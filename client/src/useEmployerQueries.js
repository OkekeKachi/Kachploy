// useEmployerQueries.js
//
// The three employer reads shared by EmployerDashboard and MyJobs (Phase 3 of
// the data-fetching audit): the posted-jobs list, the count-only applications
// read and the employments read. Before this phase each page fetched all three
// with its own useEffect chain, so a /dashboard -> /my-jobs round trip
// re-requested documents the other page had just loaded; both pages now
// observe the same cache entries through these hooks.
//
// BEHAVIOUR MATCHES THE OLD PER-PAGE FETCHES
//   * Endpoints, parameters and response fallbacks are unchanged:
//     GET /jobs/employer/:uid -> res.data.jobs || [],
//     GET /applications/counts -> res.data.counts || {},
//     GET /employments/employer/:uid -> res.data.employments || [].
//   * One attempt, no retry loop (retry: false), matching the old reads that
//     logged and gave up once -- and keeping a failure from lingering behind a
//     retry backoff before the pages' error UI can appear.
//   * `enabled: Boolean(uid)` -- no session, no request. EmployerDashboard
//     widens this to its identity gate via the options argument.
//   * The axios instance in api.js still attaches the Firebase ID token, so
//     authorization (requireSelfParam on the :uid routes, token-scoped counts)
//     is unchanged.
//
// STALENESS (resolved in Phase 4)
//   These hooks used `staleTime: 0` as a temporary Phase 3 compatibility
//   measure: the pages that CREATE and EDIT jobs and the hire flow did not
//   invalidate these keys yet, so the lists had to revalidate on every mount to
//   stay correct. Phase 4 added that invalidation at every same-client mutation
//   site that changes these documents (PostJobForm and EditJobForm -> the jobs
//   entry, the hire flow in ViewJobApplications -> the jobs and employments
//   entries), and deletion patches the jobs entry directly, so the override is
//   gone and the client default (staleTime 60s from queryClient.js) applies: a
//   return visit paints the cached list and refetches only once it is stale or
//   was invalidated.
//
//   What this does NOT cover, and never could from here: another session's
//   writes. An employee applying or withdrawing changes this employer's
//   applicationCounts, but that write happens in a different client with its
//   own in-memory cache, so no invalidation in this app can reach it -- the
//   same limitation the old fetch-on-mount effects had for an employer who
//   stayed on a page. A hire that fails after its first write commits is an
//   error path the page reports rather than patches, also by requirement; see
//   the Phase 4 report.
//
// DELETION
//   handleDeleteJob on both pages writes the filtered list into the
//   employerJobs cache entry with queryClient.setQueryData after a successful
//   DELETE -- the same immediate local removal the old setJobs filters did,
//   with no refetch. The counts and employments entries are left alone, which
//   is what the old local filters did to the other two arrays.

import { useQuery } from '@tanstack/react-query';
import api from './api';
import queryKeys from './queryKeys';

/**
 * The jobs query function. Resolves to the employer's posted jobs, or [] when
 * the response has no `jobs`. A failure is logged once and re-thrown so the
 * query enters its error state (data stays undefined).
 */
export const fetchEmployerJobs = async (uid) => {
    try {
        const res = await api.get(`/jobs/employer/${uid}`);
        return res.data.jobs || [];
    } catch (err) {
        console.error('Error fetching employer jobs:', err);
        throw err;
    }
};

/**
 * The counts query function. Resolves to the per-job applicant totals map, or
 * {} when the response has no `counts`. Takes no uid argument: the server
 * reads the caller from the verified token. A failure is logged and re-thrown;
 * the pages degrade a missing map to 0 exactly as the old inner catches did.
 */
export const fetchApplicationCounts = async () => {
    try {
        const res = await api.get('/applications/counts');
        return res.data.counts || {};
    } catch (err) {
        console.error('Error fetching application counts:', err);
        throw err;
    }
};

/**
 * The employments query function. Resolves to the employer's employment
 * records, or [] when the response has no `employments`. The per-job employee
 * count reduction stays in the pages (it feeds their card presentation); a
 * failure degrades every job to 0 employees, as before.
 */
export const fetchEmployerEmployments = async (uid) => {
    try {
        const res = await api.get(`/employments/employer/${uid}`);
        return res.data.employments || [];
    } catch (err) {
        console.error('Error fetching employments for job cards:', err);
        throw err;
    }
};

/**
 * useEmployerJobsQuery(uid, options?)
 *
 * uid     -- the authenticated employer's uid; pass '' when there is no session.
 * options -- forwarded to useQuery, so EmployerDashboard can gate the query on
 *            its identity check without forking the fetcher.
 */
export const useEmployerJobsQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.employerJobs(uid),
        queryFn: () => fetchEmployerJobs(uid),
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });

/**
 * useApplicationCountsQuery(uid, options?)
 *
 * Same shape as useEmployerJobsQuery; the uid is for the cache key only (see
 * fetchApplicationCounts).
 */
export const useApplicationCountsQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.applicationCounts(uid),
        queryFn: fetchApplicationCounts,
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });

/**
 * useEmployerEmploymentsQuery(uid, options?)
 *
 * Same shape as useEmployerJobsQuery.
 */
export const useEmployerEmploymentsQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.employerEmployments(uid),
        queryFn: () => fetchEmployerEmployments(uid),
        enabled: Boolean(uid),
        retry: false,
        ...options,
    });

export default useEmployerJobsQuery;
