'use strict';

/**
 * STAGE 1M. Cross-Origin Resource Sharing configuration, read from one
 * environment variable.
 *
 * WHAT THIS REPLACES. app.js previously mounted `cors()` with no options, which
 * reflects EVERY request origin back in `Access-Control-Allow-Origin`. That is
 * convenient in development -- the Vite dev server runs on a different port
 * (5173) from the API (3000), so a browser there is cross-origin -- but in
 * production it allows any site to call this API from a browser with the
 * caller's cookies/credentials. This module keeps development working while
 * letting a deployment pin the browser origins that may call the API.
 *
 * THE ONE ENVIRONMENT VARIABLE:
 *
 *   CORS_ORIGINS   a comma-separated allowlist of browser origins, e.g.
 *                  "https://app.example.com,https://staging.example.com".
 *
 * TWO MODES, ONE RULE:
 *   * UNSET or empty -- DEVELOPMENT MODE. The previous behaviour is preserved
 *     exactly: any origin is reflected. This is why local development, and
 *     every existing test, keeps working unchanged if the operator sets
 *     nothing.
 *   * SET -- ALLOWLIST MODE. Only the listed origins are reflected. A request
 *     from any other origin receives no CORS headers and the browser blocks it.
 *
 * NON-BROWSER REQUESTS ARE NEVER BLOCKED. CORS is a browser-enforced policy and
 * the `cors` middleware only ever WRITES response headers; it does not reject a
 * request. A request with NO `Origin` header (server-to-server, curl, the
 * Paystack webhook, the test harness) is always allowed through -- there is no
 * origin to restrict, and none of the existing callers are browsers. So
 * enabling the allowlist cannot break the API or the webhook; it only narrows
 * which browsers may read responses.
 *
 * WHAT IS DELIBERATELY NOT HERE. No production domain names are invented -- the
 * repository contains none. No wildcard subdomain matching, no regex engine, no
 * per-route policy: an exact-match allowlist is the smallest thing that closes
 * the hole and cannot be fooled by a lookalike origin the way a suffix test can
 * ("https://evil-app.example.com".endsWith("app.example.com") is false, but
 * the reverse ordering mistake is easy to make). Trailing slashes are stripped
 * so "https://app.example.com/" and "https://app.example.com" are the same
 * entry.
 */

/** The only environment variable this module reads. */
const CORS_ORIGINS_ENV_VAR = 'CORS_ORIGINS';

/**
 * Pure parser for the raw environment value.
 *
 * Splits on commas, trims surrounding whitespace, drops empty entries and
 * strips a single trailing slash from each. Returns an array of unique origins
 * in first-seen order. A non-string value (undefined, null) parses to an empty
 * array -- the caller reads that as DEVELOPMENT MODE.
 */
const parseCorsOrigins = (value) => {
    if (typeof value !== 'string') return [];

    const seen = new Set();
    const origins = [];

    for (const part of value.split(',')) {
        const trimmed = part.trim().replace(/\/$/, '');
        if (trimmed === '') continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        origins.push(trimmed);
    }

    return origins;
};

/**
 * Builds the options object for the `cors` middleware.
 *
 * `allowlist` is the parsed origin array (see parseCorsOrigins). An empty
 * allowlist preserves the historical behaviour: reflect any origin
 * (`origin: true`). A non-empty allowlist permits an exact match OR a request
 * with no Origin header; anything else is refused a CORS header.
 *
 * Returned as a plain object so tests can assert the policy without starting a
 * server, and so app.js stays a one-liner.
 */
const buildCorsOptions = (allowlist) => {
    if (!Array.isArray(allowlist) || allowlist.length === 0) {
        // DEVELOPMENT MODE: unchanged from the original `cors()` call.
        return { origin: true };
    }

    return {
        origin(origin, callback) {
            // No Origin header -> not a browser cross-origin request
            // (server-to-server, curl, webhook, tests). Always allowed.
            if (!origin) return callback(null, true);
            return callback(null, allowlist.includes(origin));
        },
    };
};

/**
 * Reads CORS_ORIGINS from the environment and returns the middleware options.
 * Read lazily (on demand) so a test can set or unset the variable around a
 * single assertion, matching config/paystack.js and config/cloudinary.js.
 */
const getCorsOptions = () => {
    const isProduction = process.env.NODE_ENV === 'production';
    const origins = parseCorsOrigins(process.env[CORS_ORIGINS_ENV_VAR]);

    // Production mode: require an explicit origin allowlist.
    if (isProduction && !origins.length) {
        // Reject any browser origin; non‑browser calls (no Origin header) are still allowed.
        return {
            origin(origin, callback) {
                // No Origin header -> not a browser cross‑origin request (server‑to‑server, curl, webhook, tests). Always allowed.
                if (!origin) return callback(null, true);
                return callback(null, false);
            },
        };
    }

    return buildCorsOptions(origins);
};

module.exports = {
    CORS_ORIGINS_ENV_VAR,
    parseCorsOrigins,
    buildCorsOptions,
    getCorsOptions,
};
