/**
 * Route matching for the shared navbar's active-link state.
 *
 * Pure (no React, no network), same rule as taskPresentation.js: the logic that
 * decides which link is highlighted lives in one testable function rather than in
 * two render branches of AppNavbar.jsx that could drift apart.
 *
 * RULES
 *   * An exact match always counts.
 *   * `/dashboard` counts ONLY on itself, so Dashboard cannot stay highlighted on
 *     another page (the hardcoded `current: true` this replaced).
 *   * Every other entry also matches its nested routes by segment boundary --
 *     `/employee/hired-jobs/abc` is still "My Jobs" -- but never a path that merely
 *     starts with the same characters (`/my-jobs-x` is not `/my-jobs`), so two
 *     links can never both be active for one location.
 */
export const isNavPathActive = (pathname, href) => {
    if (typeof pathname !== 'string' || typeof href !== 'string' || href === '') return false;

    if (pathname === href) return true;
    if (href === '/dashboard') return false;

    return pathname.startsWith(`${href}/`);
};
