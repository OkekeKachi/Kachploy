// useUserQuery.js
//
// The shared identity query from Phases 1-2 of the data-fetching audit: one
// cached, per-uid read of GET /users/getUser/:uid, replacing the module-level
// cache AppNavbar used to keep for itself and the per-page fetches that
// duplicated it (RoleBasedDashboard fetched the document, then the dashboard
// it rendered fetched the same document again on every /dashboard visit).
//
// WHY A QUERY INSTEAD OF A MODULE CACHE
//   * Every component observing the same key shares ONE request and ONE cached
//     document, on /dashboard and on every page that later migrates to it.
//   * The cache survives unmount/remount, so navigating back to a page shows
//     the role/name immediately instead of re-requesting it.
//   * PUT /users/update/:uid sites (Profile, completeProfile) invalidate the
//     key, so the navbar and the dashboards see the saved document without a
//     reload -- something the old AppNavbar cache could never do (it kept the
//     pre-edit fullName for the whole session).
//
// BEHAVIOUR MATCHES THE OLD PER-PAGE FETCHES
//   * Single attempt, no retry loop: the old reads logged and gave up once.
//     A failed read leaves `data` undefined; callers treat that as "no
//     document", exactly like the navbar's cached null.
//   * `enabled: Boolean(uid)` -- no session, no request (the old reads
//     navigated to /login themselves; the callers below keep doing that).
//   * The axios instance in api.js still attaches the Firebase ID token, so
//     authorization and the server's self-only rule on /users/getUser/:uid
//     are unchanged.

import { useQuery } from '@tanstack/react-query';
import api from './api';
import queryKeys from './queryKeys';

/**
 * The query function. Resolves to the user document, or null when the response
 * has no `user` -- the same `(res.data && res.data.user) || null` shape the
 * AppNavbar cache used, so a well-formed-but-empty response is "no document"
 * rather than an error.
 *
 * A failure is logged once and re-thrown so the query enters its error state
 * (data stays undefined); react-query will not retry it.
 */
export const fetchUserDocument = async (uid) => {
    try {
        const res = await api.get(`/users/getUser/${uid}`);
        return (res.data && res.data.user) || null;
    } catch (err) {
        console.error('Error fetching user identity:', err);
        throw err;
    }
};

/**
 * useUserQuery(uid, options?)
 *
 * uid     -- the AUTHENTICATED caller's uid (auth.currentUser.uid). Pass ''
 *            when there is no session: the query is disabled rather than
 *            firing an unauthenticated request.
 * options -- forwarded to useQuery, so a caller can widen `enabled` or override
 *            staleness for a specific screen without forking the fetcher.
 *
 * Returns the react-query result. The interesting fields are `data` (the user
 * document, undefined until it arrives or after a failure) and the status
 * flags; `isPending`/`isSuccess` are what the dashboards gate their follow-on
 * requests on, preserving the old "identity first, then jobs" sequencing.
 */
export const useUserQuery = (uid, options) =>
    useQuery({
        queryKey: queryKeys.user(uid),
        queryFn: () => fetchUserDocument(uid),
        enabled: Boolean(uid),
        // One attempt, matching every pre-query read in this app. A transient
        // failure recovers on the next mount or invalidation rather than
        // hammering the endpoint from a retry loop.
        retry: false,
        ...options,
    });

export default useUserQuery;
