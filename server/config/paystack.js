'use strict';

/**
 * STAGE 1B. Paystack Test Mode secret-key configuration, server-side only.
 *
 * The counterpart of config/cloudinary.js for the one credential the payment
 * flow carries: the secret key the SERVER uses to initialize a checkout and to
 * verify a transaction with Paystack. Nothing in this module opens a network
 * connection or contacts Paystack -- it reads one environment variable, checks
 * it, and hands the caller the key when the check passes. Verification of a
 * payment happens later, in the client this module exists to feed.
 *
 * THE ONE ENVIRONMENT VARIABLE, READ HERE AND NOWHERE ELSE:
 *
 *   PAYSTACK_SECRET_KEY    sent to Paystack as the Bearer credential, and it
 *                          NEVER leaves this process -- never into a response,
 *                          a log line, an error message or a serialized object.
 *
 * The name follows the repository's one provider convention (CLOUDINARY_CLOUD_NAME,
 * CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET): provider first, then the component.
 * No PAYSTACK_* variable existed before this stage and no other module reads one.
 *
 * TEST MODE ONLY, FAIL CLOSED. The key must begin with sk_test_. A Live Mode key
 * (sk_live_), a public key (pk_), a blank or missing value, or anything else is
 * a configuration error -- there is deliberately NO fallback path from Test Mode
 * to Live Mode, because "the test key was absent, so charge real money instead"
 * is the worst failure this file could ever have. An unconfigured server is the
 * normal state of a fresh clone: .env is gitignored, so the error must be a
 * clear 503 at the controller (PaystackConfigurationError, the same contract
 * CloudinaryConfigurationError establishes), never a 500 and never a silent
 * default. The eventual controller maps the error to HTTP 503 with a generic
 * message; that mapping is NOT implemented in this stage.
 *
 * WHY THE ENV IS READ LAZILY, ON EVERY CALL, LIKE cloudinary.js. The server is
 * unusable for payments without the key but perfectly usable for everything
 * else, and tests need to exercise the unconfigured case by removing the
 * variable around a single assertion. So nothing is read or captured at require
 * time; getSecretKey() reads the environment each time it is called.
 *
 * THE VALIDATOR IS PURE. validatePaystackSecretKey(value) takes any value and
 * returns the trimmed key or throws; getSecretKey() is a thin wrapper that only
 * supplies process.env[PAYSTACK_SECRET_KEY]. Every interesting test therefore
 * runs against the pure function without touching process.env at all, which is
 * what keeps the suite from leaking configuration between tests (the two tests
 * that do use the environment restore it in a finally block).
 *
 * WHAT IS AND IS NOT CHECKED. Checked: the value is a string, it is non-empty
 * after trimming surrounding whitespace, and it begins with sk_test_ followed
 * by at least one more character. Surrounding whitespace is trimmed and NOTHING
 * else is transformed -- no case folding, no character stripping, no
 * reformatting, because a credential must be passed to the provider byte-for-
 * byte (modulo the padding whitespace .env files accumulate). Deliberately NOT
 * checked: the shape of the characters after the prefix, and any length beyond
 * "at least one". Over-validating here would only create false rejections of a
 * key format this server does not need to understand; Paystack is the authority
 * on whether a key works, and it answers that on the first API call.
 *
 * WHAT ERROR MESSAGES MAY SAY. The environment variable's name, the expected
 * prefix, and (for a wrong type) the TYPE of the value. Never the value itself,
 * never a fragment of it, never which of those details distinguished one bad
 * deployment from another beyond what is written here. The messages are built
 * only from constants in this file, so no caller-supplied string can ever reach
 * them -- which is exactly what the tests in test/paystack-config.test.js pin.
 *
 * NO MUTABLE CONFIGURATION OBJECT IS EXPORTED. The interface is the error type,
 * the two constants, the pure validator, the environment reader and a readiness
 * probe. There is no exported settings object to mutate, serialize or pass
 * around by accident, and no accessor that hands the key to code that has no
 * business making a signed request (only getSecretKey does, and only the
 * Paystack client will call it).
 */

/** The secret-key environment variable this module reads. */
const SECRET_KEY_ENV_VAR = 'PAYSTACK_SECRET_KEY';

/**
 * The explicit provider-mode selector. This is the ONLY other environment
 * variable this module reads.
 *
 *   unset / blank -> 'test' (the safe default; every existing deployment and
 *                    test keeps running exactly as it did before Live support)
 *   'test'        -> Test Mode, key must begin with sk_test_
 *   'live'        -> Live Mode, key must begin with sk_live_
 *
 * Any other value is a configuration error, not a fallback. The mode is read
 * lazily on every call for the same reason the key is: a process must never
 * capture a mode that a later request cannot observe.
 */
const MODE_ENV_VAR = 'PAYSTACK_MODE';

/**
 * Explicit opt-in for Live Mode transfers. Live collections are safe to enable
 * by switching PAYSTACK_MODE, but a live payout moves real money out of the
 * account and is a separate, deliberate decision. Default false: a Live Mode
 * server still refuses to submit transfers until this is exactly 'true'.
 */
const LIVE_PAYOUTS_ENV_VAR = 'PAYSTACK_LIVE_PAYOUTS_ENABLED';

/** The only two provider modes this server understands. */
const TEST_MODE = 'test';
const LIVE_MODE = 'live';
const PAYSTACK_MODES = Object.freeze([TEST_MODE, LIVE_MODE]);

/** The accepted key shape per mode. */
const TEST_MODE_KEY_PREFIX = 'sk_test_';
const LIVE_MODE_KEY_PREFIX = 'sk_live_';
const KEY_PREFIX_BY_MODE = Object.freeze({
    [TEST_MODE]: TEST_MODE_KEY_PREFIX,
    [LIVE_MODE]: LIVE_MODE_KEY_PREFIX,
});

/**
 * Raised when the environment holds no usable Test Mode secret key.
 *
 * Carries a code rather than relying on `instanceof` alone, mirroring
 * CloudinaryConfigurationError, so a controller can match it across the require
 * boundary. The message names the environment variable and the expected prefix
 * and nothing else -- it is written to reach a client log or an operator, so it
 * must be safe by construction, not by discipline at the throw site.
 */
class PaystackConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PaystackConfigurationError';
        this.code = 'PAYSTACK_NOT_CONFIGURED';
    }
}

/** A human label for a mode, built only from the mode constants. */
const modeLabel = (mode) => (mode === LIVE_MODE ? 'Live Mode' : 'Test Mode');

/** The one missing/blank message for a mode. Built from constants only. */
const missingMessage = (mode = TEST_MODE) =>
    `Paystack ${modeLabel(mode)} is not configured: set ${SECRET_KEY_ENV_VAR} to a secret key beginning with ${KEY_PREFIX_BY_MODE[mode]}`;

/** The one wrong-shape message for a mode. Built from constants only. */
const invalidMessage = (mode = TEST_MODE) =>
    `${SECRET_KEY_ENV_VAR} is not a Paystack ${modeLabel(mode)} secret key: expected a value beginning with ${KEY_PREFIX_BY_MODE[mode]}`;

/**
 * Normalises the configured mode. Absent or blank means Test Mode; the two
 * known modes are returned as-is; anything else is a configuration error.
 * The mode is never guessed from the key's prefix -- an operator must say
 * which environment this process is, and the key must then match it.
 */
const parsePaystackMode = (value) => {
    if (value === undefined || value === null) {
        return TEST_MODE;
    }

    if (typeof value !== 'string') {
        throw new TypeError(`${MODE_ENV_VAR} must be a string, got type ${typeof value}`);
    }

    const trimmed = value.trim().toLowerCase();

    if (trimmed === '') {
        return TEST_MODE;
    }

    if (!PAYSTACK_MODES.includes(trimmed)) {
        throw new PaystackConfigurationError(
            `${MODE_ENV_VAR} must be one of: ${PAYSTACK_MODES.join(', ')}`
        );
    }

    return trimmed;
};

/** Reads and normalises the configured mode from the environment, lazily. */
const getPaystackMode = () => parsePaystackMode(process.env[MODE_ENV_VAR]);

/** Whether this process is explicitly configured for Live Mode. */
const isLiveMode = () => getPaystackMode() === LIVE_MODE;

/** Whether live payouts have been explicitly enabled. Default false. */
const isLivePayoutsEnabled = () => {
    const value = process.env[LIVE_PAYOUTS_ENV_VAR];
    return typeof value === 'string' && value.trim().toLowerCase() === 'true';
};

/**
 * Pure validator for an explicit mode: the configured value in, the trimmed key
 * out, or a throw. Test Mode keeps exactly the historical contract (sk_test_,
 * no Live fallback); Live Mode requires sk_live_. A key from the other mode is
 * rejected rather than silently used, which is the whole point of the split.
 */
const validatePaystackSecretKeyForMode = (value, mode = TEST_MODE) => {
    const resolvedMode = parsePaystackMode(mode);
    const prefix = KEY_PREFIX_BY_MODE[resolvedMode];

    if (value === undefined || value === null) {
        throw new PaystackConfigurationError(missingMessage(resolvedMode));
    }

    if (typeof value !== 'string') {
        throw new TypeError(`${SECRET_KEY_ENV_VAR} must be a string, got type ${typeof value}`);
    }

    const trimmed = value.trim();

    if (trimmed === '') {
        throw new PaystackConfigurationError(missingMessage(resolvedMode));
    }

    if (!trimmed.startsWith(prefix) || trimmed.length === prefix.length) {
        throw new PaystackConfigurationError(invalidMessage(resolvedMode));
    }

    return trimmed;
};

/**
 * Pure validator: the configured value in, the trimmed key out, or a throw.
 *
 *   PaystackConfigurationError  the value is absent or is not a Test Mode key
 *                               (undefined/null, empty, whitespace-only, pk_,
 *                               sk_live_, anything else). Absence is a
 *                               DEPLOYMENT state, so it is this error and not a
 *                               TypeError -- a server simply may not have set
 *                               the variable yet, and that must reach the
 *                               controller as the 503 it will answer with.
 *   TypeError                   the value is a non-string, non-nullish type
 *                               (number, boolean, object, array, bigint,
 *                               symbol). process.env can only produce strings
 *                               or undefined, so this is a programming error in
 *                               the caller, not a deployment state, and it
 *                               stays a 500. This is also where this function
 *                               deliberately differs from the money validators
 *                               in config/fees.js: there, a wrong type means
 *                               malformed money; here, `undefined` means "not
 *                               configured yet", which is a valid server state.
 *
 * The supplied value is NEVER interpolated into any message -- only its typeof.
 * Returns value.trim() unmodified otherwise: the key travels to Paystack exactly
 * as configured, minus the whitespace an .env line accumulates.
 */
const validatePaystackSecretKey = (value) =>
    validatePaystackSecretKeyForMode(value, TEST_MODE);

/**
 * Reads SECRET_KEY_ENV_VAR from the environment and validates it.
 *
 * Called on demand rather than captured at require time, for the same reason
 * cloudinary.js re-reads its credentials on every signature: the unconfigured
 * case must be observable in tests, and a key must never sit in a module-level
 * binding that a require-cache substitution could outlive. Returns the trimmed
 * key. Throws PaystackConfigurationError when the variable is missing, blank or
 * not a Test Mode key -- there is no Live Mode fallback and no default of any
 * kind. The only environment read in this module is process.env[SECRET_KEY_ENV_VAR].
 */
const getSecretKey = () =>
    validatePaystackSecretKeyForMode(process.env[SECRET_KEY_ENV_VAR], getPaystackMode());

/**
 * Whether this server can talk to the configured Paystack mode at all. Readiness
 * only -- it throws nothing and returns a boolean, so a health check or a test
 * can ask without paying the cost of (or being unable to catch) the real read.
 */
const isPaystackConfigured = () => {
    try {
        getSecretKey();
        return true;
    } catch (error) {
        return false;
    }
};

module.exports = {
    SECRET_KEY_ENV_VAR,
    MODE_ENV_VAR,
    LIVE_PAYOUTS_ENV_VAR,
    TEST_MODE,
    LIVE_MODE,
    PAYSTACK_MODES,
    TEST_MODE_KEY_PREFIX,
    LIVE_MODE_KEY_PREFIX,
    KEY_PREFIX_BY_MODE,
    PaystackConfigurationError,
    parsePaystackMode,
    getPaystackMode,
    isLiveMode,
    isLivePayoutsEnabled,
    validatePaystackSecretKey,
    validatePaystackSecretKeyForMode,
    getSecretKey,
    isPaystackConfigured,
};
