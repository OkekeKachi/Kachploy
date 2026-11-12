// queryClient.js
//
// The shared TanStack Query client (Phase 1 of the data-fetching audit),
// created at module scope so the cache is not thrown away on every render --
// the same pattern api.js uses for the shared axios instance.
//
// DEFAULTS, and why they are this conservative
//   staleTime 60s     -- authenticated reads (user document, job lists,
//                        applications, tasks) are safe to reuse for a minute,
//                        which is what actually removes the loading flash when
//                        navigating back to a page already visited this
//                        session. Anything a mutation touches is invalidated
//                        explicitly, so freshness does not depend on this
//                        number being small.
//   gcTime 5min       -- unused data is kept for five minutes after the last
//                        observer unmounts, so back-navigation inside a short
//                        burst is served from cache while a longer absence
//                        still falls back to a real read.
//   refetchOnWindowFocus false -- no surprise requests when the reader alt-tabs
//                        back; correctness comes from invalidation-on-mutation
//                        and reconnect, not from polling the window.
//   retry 1           -- one retry for transient network failures on ordinary
//                        reads. The identity query overrides this to false in
//                        useUserQuery, matching the single-attempt behaviour
//                        every pre-query fetch in this app had.
//
// No persistent storage: the cache is in-memory and per-tab, on purpose.
// Everything behind these keys is authenticated data (Firebase ID token), so
// it must not outlive the tab or be readable by scripts after sign-out.

import { QueryClient } from '@tanstack/react-query';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 60 * 1000,
            gcTime: 5 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
});

export default queryClient;
