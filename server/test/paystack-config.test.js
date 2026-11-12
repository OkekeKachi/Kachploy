'use strict';

/**
 * STAGE 1B tests for config/paystack.js -- Test Mode secret-key configuration.
 *
 * Almost every test here runs against the PURE validator, validatePaystackSecretKey,
 * so it never touches process.env and cannot leak configuration into another test.
 * The handful of tests that do exercise the environment reader (getSecretKey,
 * isPaystackConfigured) save the variable in a `try` and restore it in a `finally`,
 * matching how test/tasks.test.js and test/users.test.js already handle the
 * Cloudinary variables -- and note that assigning `undefined` to process.env
 * coerces it to the string "undefined", so restoration must `delete` when the
 * variable was originally absent.
 *
 * No test supplies a real credential: every key here is an obviously fake string
 * that exists only to prove the shape check accepts or rejects it. No test makes
 * a network request -- this module cannot.
 *
 * The two properties this file exists to pin:
 *   1. only `sk_test_...` (non-empty after the prefix) is ever accepted, and
 *   2. no supplied value, fragment of a value, or Live Mode key can ever appear
 *      in an error message or be silently accepted as a fallback.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SECRET_KEY_ENV_VAR,
  MODE_ENV_VAR,
  LIVE_PAYOUTS_ENV_VAR,
  TEST_MODE,
  LIVE_MODE,
  TEST_MODE_KEY_PREFIX,
  LIVE_MODE_KEY_PREFIX,
  PaystackConfigurationError,
  parsePaystackMode,
  getPaystackMode,
  isLiveMode,
  isLivePayoutsEnabled,
  validatePaystackSecretKey,
  validatePaystackSecretKeyForMode,
  getSecretKey,
  isPaystackConfigured,
} = require('../config/paystack');

// Obviously fake key material. Never a real credential, and every test that
// checks message hygiene looks for exactly these distinctive tails.
const FAKE_TEST_KEY = 'sk_test_000000000000FAKEKEYTAIL';
const FAKE_LIVE_KEY = ['sk', 'live', 'fake_live_key_for_tests'].join('_');
const FAKE_PUBLIC_KEY = 'pk_test_000000000000FAKEPUBLICTAIL';

/** Runs `fn` with PAYSTACK_SECRET_KEY forced to `value`, restoring exactly. */
const withSecretKey = (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV_VAR);
  const saved = process.env[SECRET_KEY_ENV_VAR];
  try {
    if (value === undefined) {
      delete process.env[SECRET_KEY_ENV_VAR];
    } else {
      process.env[SECRET_KEY_ENV_VAR] = value;
    }
    return fn();
  } finally {
    if (had) {
      process.env[SECRET_KEY_ENV_VAR] = saved;
    } else {
      delete process.env[SECRET_KEY_ENV_VAR];
    }
  }
};

/** Runs `fn` with PAYSTACK_MODE forced to `value`, restoring exactly. */
const withMode = (value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, MODE_ENV_VAR);
  const saved = process.env[MODE_ENV_VAR];
  try {
    if (value === undefined) {
      delete process.env[MODE_ENV_VAR];
    } else {
      process.env[MODE_ENV_VAR] = value;
    }
    return fn();
  } finally {
    if (had) {
      process.env[MODE_ENV_VAR] = saved;
    } else {
      delete process.env[MODE_ENV_VAR];
    }
  }
};

/**
 * Returns the error `fn` threw, or null. Node's assert.throws does not hand the
 * error back (it returns undefined on v20), and several assertions here need to
 * inspect `.message`, `.code` and `.stack` for leaked material.
 */
const caught = (fn) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
};

test('interface: the module exports only the smallest configuration surface', () => {
  assert.deepEqual(Object.keys(require('../config/paystack')).sort(), [
    'KEY_PREFIX_BY_MODE',
    'LIVE_MODE',
    'LIVE_MODE_KEY_PREFIX',
    'LIVE_PAYOUTS_ENV_VAR',
    'MODE_ENV_VAR',
    'PAYSTACK_MODES',
    'PaystackConfigurationError',
    'SECRET_KEY_ENV_VAR',
    'TEST_MODE',
    'TEST_MODE_KEY_PREFIX',
    'getPaystackMode',
    'getSecretKey',
    'isLiveMode',
    'isLivePayoutsEnabled',
    'isPaystackConfigured',
    'parsePaystackMode',
    'validatePaystackSecretKey',
    'validatePaystackSecretKeyForMode',
  ]);
  assert.equal(SECRET_KEY_ENV_VAR, 'PAYSTACK_SECRET_KEY');
  assert.equal(MODE_ENV_VAR, 'PAYSTACK_MODE');
  assert.equal(TEST_MODE_KEY_PREFIX, 'sk_test_');
  assert.equal(LIVE_MODE_KEY_PREFIX, 'sk_live_');
  // No settings/config object, no URL, no credential accessor beyond getSecretKey.
  const exported = require('../config/paystack');
  assert.equal(typeof exported.getSecretKey, 'function');
  assert.equal(typeof exported.validatePaystackSecretKey, 'function');
});

test('validate: accepts a Test Mode secret key and returns it unchanged', () => {
  assert.equal(validatePaystackSecretKey(FAKE_TEST_KEY), FAKE_TEST_KEY);
  // Any non-empty body after the prefix passes: shape beyond the prefix is
  // deliberately Paystack's business, not this module's.
  assert.equal(validatePaystackSecretKey('sk_test_a'), 'sk_test_a');
});

test('validate: requires key material after the prefix, not just the prefix', () => {
  assert.throws(() => validatePaystackSecretKey('sk_test_'), PaystackConfigurationError);
  assert.throws(() => validatePaystackSecretKey('  sk_test_  '), PaystackConfigurationError);
});

test('validate: trims surrounding whitespace and transforms nothing else', () => {
  assert.equal(validatePaystackSecretKey(`  \t${FAKE_TEST_KEY}\n`), FAKE_TEST_KEY);
  assert.equal(validatePaystackSecretKey(` ${FAKE_TEST_KEY} `), FAKE_TEST_KEY);
  // Case, digits and the prefix body survive exactly as supplied.
  const mixed = 'sk_test_MixedCase-123_tail';
  assert.equal(validatePaystackSecretKey(mixed), mixed);
});

test('validate: missing, empty and whitespace-only values are configuration errors', () => {
  const absent = [undefined, null];
  for (const value of absent) {
    assert.throws(
      () => validatePaystackSecretKey(value),
      PaystackConfigurationError,
      `${String(value)} must be a configuration error`
    );
  }
  for (const value of ['', ' ', '   ', '\t', '\n', ' \t\n ']) {
    assert.throws(() => validatePaystackSecretKey(value), PaystackConfigurationError);
  }
});

test('validate: a public key is rejected', () => {
  for (const value of [FAKE_PUBLIC_KEY, 'pk_live_0000FAKE', 'pk_']) {
    assert.throws(() => validatePaystackSecretKey(value), PaystackConfigurationError);
  }
});

test('validate: a Live Mode secret is rejected -- there is no Live fallback', () => {
  for (const value of [FAKE_LIVE_KEY, 'sk_live_', `  ${FAKE_LIVE_KEY}  `, 'sk_live_abc123']) {
    assert.throws(() => validatePaystackSecretKey(value), PaystackConfigurationError);
    const error = caught(() => validatePaystackSecretKey(value));
    assert.equal(error.code, 'PAYSTACK_NOT_CONFIGURED');
  }
  // The accepted shape is exactly Test Mode, so a Live key can never be
  // "close enough" to slip through after trimming.
  assert.throws(() => validatePaystackSecretKey(` ${FAKE_LIVE_KEY}`), PaystackConfigurationError);
});

test('validate: arbitrary invalid prefixes and shapes are rejected', () => {
  const invalid = [
    'sk_testx_abc', // underscore missing
    'SK_TEST_ABC', // case must not be folded into acceptance
    'sk__abc', // double underscore, wrong scheme
    'sk_test', // prefix itself truncated
    'secret_abc', // not a Paystack scheme at all
    'bearer sk_test_abc', // prefix not at the start
    '000000000000FAKEKEYTAIL', // raw material with no scheme
    'sk_TEST_000000000000FAKEKEYTAIL', // mangled case
    'sk_liveSUPERSECRETVALUE123', // live scheme with its underscore lost
  ];
  for (const value of invalid) {
    assert.throws(
      () => validatePaystackSecretKey(value),
      PaystackConfigurationError,
      `must reject ${JSON.stringify(value)}`
    );
  }
});

test('validate: non-string, non-nullish values are TypeErrors, absent values are not', () => {
  for (const value of [123, 0, -1, 3.5, true, false, {}, [], 123n, Symbol('sk')]) {
    const error = assert.throws(() => validatePaystackSecretKey(value), TypeError);
    assert.equal(
      error instanceof PaystackConfigurationError,
      false,
      'a TypeError must not also be mislabelled a configuration error'
    );
  }
  // The distinction the controller depends on: absence is the 503 path...
  assert.throws(() => validatePaystackSecretKey(undefined), PaystackConfigurationError);
  assert.throws(() => validatePaystackSecretKey(null), PaystackConfigurationError);
  // ...a caller passing the wrong TYPE is a bug, not a deployment state.
  assert.throws(() => validatePaystackSecretKey(123), TypeError);
});

test('errors: no message, stack or serialization ever contains supplied secret material', () => {
  const hostileValues = [
    FAKE_LIVE_KEY,
    FAKE_PUBLIC_KEY,
    'sk_live_SUPERSECRETVALUE123',
    'not-a-key-at-all SUPERSECRETVALUE123',
    '  sk_live_WHITESPACESECRET456  ',
    'sk_test_',
    '',
    '   ',
    'SUPERSECRETVALUE123',
  ];
  for (const value of hostileValues) {
    let error;
    try {
      validatePaystackSecretKey(value);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, `expected ${JSON.stringify(value)} to be rejected`);
    const surfaces = [error.message, String(error), JSON.stringify(error), error.stack];
    for (const surface of surfaces) {
      assert.equal(surface.includes('SUPERSECRETVALUE123'), false, `message leaked: ${surface}`);
      assert.equal(surface.includes('WHITESPACESECRET456'), false, `message leaked: ${surface}`);
      assert.equal(surface.includes('FAKELIVETAIL'), false, `message leaked: ${surface}`);
      assert.equal(surface.includes('FAKEPUBLICTAIL'), false, `message leaked: ${surface}`);
    }
    // The whole value must never be echoed. Skipped only for values that ARE
    // module constants (the empty string, 'sk_test_'), which may legitimately
    // appear in a message; the distinctive tails above cover the real secrets.
    if (value !== '' && value !== '   ' && value !== 'sk_test_') {
      assert.equal(error.message.includes(value.trim()), false, `message echoed the value: ${error.message}`);
    }
  }

  // A well-formed Live key is a CONFIGURATION error (503 path), never a
  // TypeError (500 path) -- the shape check runs, it just rejects.
  const liveError = (() => {
    try {
      validatePaystackSecretKey(FAKE_LIVE_KEY);
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(liveError instanceof PaystackConfigurationError, 'a Live key is a configuration error');
  assert.equal(liveError instanceof TypeError, false);

  const wrongTypeError = (() => {
    try {
      validatePaystackSecretKey(42);
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(wrongTypeError instanceof TypeError);
  assert.equal(wrongTypeError.message.includes('42'), false, 'the numeric value must not be echoed');
  assert.match(wrongTypeError.message, /got type number/);
});

test('errors: the contract a controller maps to HTTP 503', () => {
  const error = caught(() => validatePaystackSecretKey(undefined));
  assert.ok(error instanceof PaystackConfigurationError);
  assert.equal(error.name, 'PaystackConfigurationError');
  assert.equal(error.code, 'PAYSTACK_NOT_CONFIGURED');
  assert.ok(error instanceof Error);
  // The message says what to set, and names only this module's own constants.
  assert.match(error.message, /PAYSTACK_SECRET_KEY/);
  assert.match(error.message, /sk_test_/);
  // Every ALL-CAPS token in the message is the one documented variable, so a
  // 503 built from it discloses nothing about the deployment beyond that
  // setting (no other variable, file path or provider name creeps in).
  const capsTokens = error.message.match(/[A-Z][A-Z0-9_]{3,}/g) || [];
  assert.deepEqual([...new Set(capsTokens)], ['PAYSTACK_SECRET_KEY']);

  // The wrong-shape message passes the same one-variable check.
  const shapeError = caught(() => validatePaystackSecretKey(FAKE_LIVE_KEY));
  assert.ok(shapeError instanceof PaystackConfigurationError);
  const shapeTokens = shapeError.message.match(/[A-Z][A-Z0-9_]{3,}/g) || [];
  assert.deepEqual([...new Set(shapeTokens)], ['PAYSTACK_SECRET_KEY']);

  // Every rejection route produces the same catchable type, so one
  // `instanceof` in the controller covers all of them.
  for (const value of ['', '   ', FAKE_LIVE_KEY, FAKE_PUBLIC_KEY, 'nonsense', null, undefined]) {
    assert.throws(() => validatePaystackSecretKey(value), PaystackConfigurationError);
  }
});

test('getSecretKey: reads PAYSTACK_SECRET_KEY from the environment, lazily', () => {
  withSecretKey(FAKE_TEST_KEY, () => {
    assert.equal(getSecretKey(), FAKE_TEST_KEY);
  });
  withSecretKey(`  ${FAKE_TEST_KEY}\n`, () => {
    assert.equal(getSecretKey(), FAKE_TEST_KEY, 'surrounding whitespace is trimmed on read');
  });
  // Lazy: a second read sees the new value, so nothing was captured at require time.
  withSecretKey(FAKE_LIVE_KEY, () => {
    assert.throws(() => getSecretKey(), PaystackConfigurationError, 'a Live key in the env still fails');
  });
  withSecretKey('sk_test_secondkey', () => {
    assert.equal(getSecretKey(), 'sk_test_secondkey');
  });
});

test('getSecretKey: missing or blank environment variable is a configuration error', () => {
  withSecretKey(undefined, () => {
    assert.throws(() => getSecretKey(), PaystackConfigurationError);
  });
  withSecretKey('', () => {
    assert.throws(() => getSecretKey(), PaystackConfigurationError);
  });
  withSecretKey('   ', () => {
    assert.throws(() => getSecretKey(), PaystackConfigurationError);
  });
});

test('getSecretKey: the thrown error never contains the configured value', () => {
  withSecretKey(FAKE_LIVE_KEY, () => {
    const error = caught(() => getSecretKey());
    assert.ok(error instanceof PaystackConfigurationError);
    assert.equal(error.message.includes('FAKELIVETAIL'), false);
    assert.equal(JSON.stringify(error).includes('FAKELIVETAIL'), false);
  });
  withSecretKey('sk_live_ENVSECRET999', () => {
    const error = caught(() => getSecretKey());
    assert.ok(error instanceof PaystackConfigurationError);
    assert.equal(error.message.includes('ENVSECRET999'), false);
    assert.equal(error.message.includes('sk_live_'), false, 'the message names only the expected prefix');
  });
});

test('isPaystackConfigured: a boolean probe that never throws', () => {
  withSecretKey(FAKE_TEST_KEY, () => {
    assert.equal(isPaystackConfigured(), true);
  });
  withSecretKey(undefined, () => {
    assert.equal(isPaystackConfigured(), false);
  });
  withSecretKey('', () => {
    assert.equal(isPaystackConfigured(), false);
  });
  withSecretKey('   ', () => {
    assert.equal(isPaystackConfigured(), false);
  });
  withSecretKey(FAKE_LIVE_KEY, () => {
    assert.equal(isPaystackConfigured(), false, 'a configured Live key is NOT "configured" here');
  });
  withSecretKey(FAKE_PUBLIC_KEY, () => {
    assert.equal(isPaystackConfigured(), false);
  });
  withSecretKey(42, () => {
    assert.equal(isPaystackConfigured(), false, 'even a mis-typed value answers false, not a throw');
  });
});

test('environment: the process variable is left exactly as it was found', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV_VAR);
  const before = process.env[SECRET_KEY_ENV_VAR];
  withSecretKey(FAKE_TEST_KEY, () => {
    assert.equal(getSecretKey(), FAKE_TEST_KEY);
  });
  assert.equal(Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV_VAR), had);
  assert.equal(process.env[SECRET_KEY_ENV_VAR], before);
  // And the module read nothing else: the probe works with only this variable set.
  withSecretKey(FAKE_TEST_KEY, () => {
    assert.equal(isPaystackConfigured(), true);
  });
  assert.equal(Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV_VAR), had);
  assert.equal(process.env[SECRET_KEY_ENV_VAR], before);
});

test('no network or provider contact happens at require time or during validation', () => {
  // The module is loaded above, before any of this runs, with whatever the
  // ambient environment holds -- including nothing at all -- and the suite got
  // here. Re-requiring it with the variable absent must also be silent: if the
  // module read or validated at load time, this would throw.
  const had = Object.prototype.hasOwnProperty.call(process.env, SECRET_KEY_ENV_VAR);
  const saved = process.env[SECRET_KEY_ENV_VAR];
  try {
    delete process.env[SECRET_KEY_ENV_VAR];
    delete require.cache[require.resolve('../config/paystack')];
    const fresh = require('../config/paystack');
    assert.equal(typeof fresh.getSecretKey, 'function');
    assert.throws(() => fresh.getSecretKey(), fresh.PaystackConfigurationError);
    assert.equal(fresh.isPaystackConfigured(), false);
  } finally {
    if (had) {
      process.env[SECRET_KEY_ENV_VAR] = saved;
    } else {
      delete process.env[SECRET_KEY_ENV_VAR];
    }
    delete require.cache[require.resolve('../config/paystack')];
  }
});

test('mode: absent, blank and explicit test all mean Test Mode', () => {
  assert.equal(parsePaystackMode(undefined), TEST_MODE);
  assert.equal(parsePaystackMode(null), TEST_MODE);
  assert.equal(parsePaystackMode(''), TEST_MODE);
  assert.equal(parsePaystackMode('   '), TEST_MODE);
  assert.equal(parsePaystackMode('test'), TEST_MODE);
  assert.equal(parsePaystackMode(' TEST '), TEST_MODE);
  assert.equal(parsePaystackMode('live'), LIVE_MODE);
  assert.equal(parsePaystackMode(' LIVE '), LIVE_MODE);
});

test('mode: an unknown mode is a configuration error, never a fallback', () => {
  for (const value of ['production', 'livee', 'TESTING', '0', 'true']) {
    const error = caught(() => parsePaystackMode(value));
    assert.ok(error instanceof PaystackConfigurationError, value);
    assert.equal(error.message.includes(value), false, 'the supplied value is never echoed');
    assert.ok(error.message.includes(MODE_ENV_VAR));
  }
  assert.ok(caught(() => parsePaystackMode(42)) instanceof TypeError);
});

test('mode: getPaystackMode and isLiveMode read the environment lazily', () => {
  withMode(undefined, () => {
    assert.equal(getPaystackMode(), TEST_MODE);
    assert.equal(isLiveMode(), false);
  });
  withMode('live', () => {
    assert.equal(getPaystackMode(), LIVE_MODE);
    assert.equal(isLiveMode(), true);
  });
  withMode('bogus', () => {
    assert.ok(caught(() => getPaystackMode()) instanceof PaystackConfigurationError);
  });
});

test('validateForMode: each mode accepts only its own key prefix', () => {
  assert.equal(validatePaystackSecretKeyForMode(FAKE_TEST_KEY, TEST_MODE), FAKE_TEST_KEY);
  assert.equal(validatePaystackSecretKeyForMode(FAKE_LIVE_KEY, LIVE_MODE), FAKE_LIVE_KEY);
  assert.equal(validatePaystackSecretKeyForMode(FAKE_TEST_KEY), FAKE_TEST_KEY, 'test is the default');

  assert.ok(caught(() => validatePaystackSecretKeyForMode(FAKE_LIVE_KEY, TEST_MODE)) instanceof PaystackConfigurationError);
  assert.ok(caught(() => validatePaystackSecretKeyForMode(FAKE_TEST_KEY, LIVE_MODE)) instanceof PaystackConfigurationError);
  assert.ok(caught(() => validatePaystackSecretKeyForMode(FAKE_PUBLIC_KEY, LIVE_MODE)) instanceof PaystackConfigurationError);
  assert.ok(caught(() => validatePaystackSecretKeyForMode(LIVE_MODE_KEY_PREFIX, LIVE_MODE)) instanceof PaystackConfigurationError);
  assert.ok(caught(() => validatePaystackSecretKeyForMode(undefined, LIVE_MODE)) instanceof PaystackConfigurationError);
  assert.ok(caught(() => validatePaystackSecretKeyForMode('', LIVE_MODE)) instanceof PaystackConfigurationError);
});

test('getSecretKey: a live mode server requires an sk_live_ key and vice versa', () => {
  withMode('live', () => {
    withSecretKey(FAKE_LIVE_KEY, () => assert.equal(getSecretKey(), FAKE_LIVE_KEY));
    withSecretKey(FAKE_TEST_KEY, () => {
      const error = caught(() => getSecretKey());
      assert.ok(error instanceof PaystackConfigurationError);
      assert.equal(error.message.includes('FAKEKEYTAIL'), false);
      assert.ok(error.message.includes(LIVE_MODE_KEY_PREFIX));
    });
    withSecretKey(undefined, () => assert.ok(caught(() => getSecretKey()) instanceof PaystackConfigurationError));
  });
  withMode('test', () => {
    withSecretKey(FAKE_TEST_KEY, () => assert.equal(getSecretKey(), FAKE_TEST_KEY));
    withSecretKey(FAKE_LIVE_KEY, () => assert.ok(caught(() => getSecretKey()) instanceof PaystackConfigurationError));
  });
});

test('isPaystackConfigured: reflects the configured mode and its matching key', () => {
  withMode('live', () => {
    withSecretKey(FAKE_LIVE_KEY, () => assert.equal(isPaystackConfigured(), true));
    withSecretKey(FAKE_TEST_KEY, () => assert.equal(isPaystackConfigured(), false));
    withSecretKey(undefined, () => assert.equal(isPaystackConfigured(), false));
  });
  withMode('bogus', () => {
    withSecretKey(FAKE_TEST_KEY, () => assert.equal(isPaystackConfigured(), false, 'an invalid mode is not configured'));
  });
});

test('live payouts: disabled unless explicitly set to true', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, LIVE_PAYOUTS_ENV_VAR);
  const saved = process.env[LIVE_PAYOUTS_ENV_VAR];
  try {
    delete process.env[LIVE_PAYOUTS_ENV_VAR];
    assert.equal(isLivePayoutsEnabled(), false);
    for (const value of ['', 'false', '1', 'yes', 'TRUE ', ' true ']) {
      process.env[LIVE_PAYOUTS_ENV_VAR] = value;
      assert.equal(isLivePayoutsEnabled(), value.trim().toLowerCase() === 'true', value);
    }
  } finally {
    if (had) {
      process.env[LIVE_PAYOUTS_ENV_VAR] = saved;
    } else {
      delete process.env[LIVE_PAYOUTS_ENV_VAR];
    }
  }
});
