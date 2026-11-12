'use strict';

/**
 * STAGE 1A tests for config/fees.js -- the checkout gross-up fee model.
 *
 * The calculator is pure arithmetic, so almost every assertion here is an
 * EXACT expected kobo value, hand-checked against the documented model:
 *
 *   feePct(M) = Math.floor((3 * M + 100) / 200)          // 1.5%, half up
 *   fee(M)    = Math.min(feePct(M) + (M >= 250000 ? 10000 : 0), 200000)
 *   net(M)    = M - fee(M)
 *   charge(P) = min { M >= 1 : net(M) >= P }
 *
 * Independent cross-checks (intentionally NOT the implementation's code):
 *   - referenceFee/referenceNet below re-express the same model with a
 *     different rounding primitive (Math.round of the raw percentage), which
 *     is equivalent to the half-up floor for every supported input.
 *   - linearExpected brute-forces the inverse with a linear scan per branch,
 *     the ground truth a binary search must reproduce.
 *
 * Hand-derived anchors (each re-derived in the comments of the tests that use
 * them): fee(100100) = 1502 (1.5% of 100100 = 1501.5, rounds UP),
 * fee(250100) = 13752, fee(249999) = 3750, fee(250000) = 13750,
 * fee(12666633) = 199999, fee(12666634) = 200000 (cap reached).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_AMOUNT_MINOR,
  MIN_GROSS_MINOR,
  FIXED_FEE_THRESHOLD_MINOR,
  FIXED_FEE_MINOR,
  FEE_CAP_MINOR,
  MAX_GROSS_MINOR,
  calculateCheckoutFeeMinor,
  calculateCheckoutNetMinor,
  calculateCheckoutChargeMinor,
} = require('../config/fees');

// ---------------------------------------------------------------------------
// Independent references
// ---------------------------------------------------------------------------

const referenceFee = (grossMinor) =>
  Math.min(
    Math.round((3 * grossMinor) / 200) +
      (grossMinor >= FIXED_FEE_THRESHOLD_MINOR ? FIXED_FEE_MINOR : 0),
    FEE_CAP_MINOR
  );

const referenceNet = (grossMinor) => grossMinor - referenceFee(grossMinor);

/**
 * Ground-truth inverse for milestone amounts in [pLo, pHi]: scan each branch
 * of the discontinuity in ascending order with a cursor over the ascending
 * target list, recording the FIRST gross charge whose net reaches each
 * target. Branch A answers are <= 249999 and always beat branch B answers
 * (>= 250000), so a single cursor across both scans is the global minimum.
 * Only targets never reached by branch A (i.e. P > 246249) remain for
 * branch B.
 */
const linearExpected = (pLo, pHi) => {
  const targets = [];
  for (let p = pLo; p <= pHi; p += 1) {
    targets.push(p);
  }
  const expected = new Map();
  let cursor = 0;
  const assign = (m) => {
    while (cursor < targets.length && referenceNet(m) >= targets[cursor]) {
      expected.set(targets[cursor], m);
      cursor += 1;
    }
  };
  for (let m = MIN_GROSS_MINOR; m <= FIXED_FEE_THRESHOLD_MINOR - 1 && cursor < targets.length; m += 1) {
    assign(m);
  }
  if (cursor < targets.length) {
    const start = Math.max(FIXED_FEE_THRESHOLD_MINOR, targets[0]);
    for (let m = start; m <= pHi + FEE_CAP_MINOR && cursor < targets.length; m += 1) {
      assign(m);
    }
  }
  return expected;
};

/** Full contract check for one (P, M) pair: sufficiency + global minimality. */
const assertChargeIsExact = (milestoneMinor, expectedGross) => {
  const gross = calculateCheckoutChargeMinor(milestoneMinor);
  assert.equal(gross, expectedGross, `charge(${milestoneMinor})`);
  assert.equal(
    typeof gross,
    'number',
    'charge must return a number'
  );
  assert.ok(Number.isSafeInteger(gross), `charge(${milestoneMinor}) must be a safe integer`);
  assert.ok(gross >= MIN_GROSS_MINOR && gross <= MAX_GROSS_MINOR, 'charge must be in 1..MAX_GROSS_MINOR');
  assert.ok(gross >= milestoneMinor, 'charge can never be below the milestone amount');
  assert.ok(
    calculateCheckoutNetMinor(gross) >= milestoneMinor,
    `charge(${milestoneMinor}) = ${gross} must be sufficient: net must cover P`
  );
  if (gross > MIN_GROSS_MINOR) {
    assert.ok(
      calculateCheckoutNetMinor(gross - 1) < milestoneMinor,
      `charge(${milestoneMinor}) = ${gross} must be minimal: net(${gross - 1}) must miss P`
    );
  }
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

test('exports: documented constants are exact', () => {
  assert.equal(MIN_GROSS_MINOR, 1);
  assert.equal(FIXED_FEE_THRESHOLD_MINOR, 250000);
  assert.equal(FIXED_FEE_MINOR, 10000);
  assert.equal(FEE_CAP_MINOR, 200000);
  assert.equal(MAX_AMOUNT_MINOR, 1e12);
  assert.equal(MAX_GROSS_MINOR, MAX_AMOUNT_MINOR + FEE_CAP_MINOR);
});

// ---------------------------------------------------------------------------
// Forward direction: fee(M) and net(M)
// ---------------------------------------------------------------------------

test('fee: percentage rounding boundaries, half up to the kobo', () => {
  // 1.5% of 100 = 1.5 exactly -> rounds UP to 2 (a plain floor would give 1).
  assert.equal(calculateCheckoutFeeMinor(100), 2);
  // 1.5% of 300 = 4.5 exactly -> rounds UP to 5 (plain floor: 4).
  assert.equal(calculateCheckoutFeeMinor(300), 5);
  // Non-half cases round to the nearest kobo either way.
  assert.equal(calculateCheckoutFeeMinor(299), 4); // 4.485
  assert.equal(calculateCheckoutFeeMinor(301), 5); // 4.515
  // Below 1 kobo of percentage fee: floor of 0.495 and 0.51.
  assert.equal(calculateCheckoutFeeMinor(33), 0);
  assert.equal(calculateCheckoutFeeMinor(34), 1);
  assert.equal(calculateCheckoutFeeMinor(99), 1); // 1.485
  // 1.5% of 100100 = 1501.5 exactly -> rounds UP to 1502.
  assert.equal(calculateCheckoutFeeMinor(100100), 1502);
  // The observed Paystack test-mode fee for a 250100 gross:
  // floor((750400) / 200) = 3752, plus the fixed 10000 = 13752.
  assert.equal(calculateCheckoutFeeMinor(250100), 13752);
});

test('fee: fixed NGN 100 switches on at exactly 250000', () => {
  // floor((3 * 249999 + 100) / 200) = floor(750097 / 200) = 3750, no fixed.
  assert.equal(calculateCheckoutFeeMinor(249999), 3750);
  // 1.5% of 250000 = 3750 exactly (the +100 half-up nudge cannot change an
  // exact whole percentage), plus the fixed 10000 = 13750.
  assert.equal(calculateCheckoutFeeMinor(250000), 13750);
  // The step across the boundary is the fixed fee plus the percentage drift.
  assert.equal(calculateCheckoutFeeMinor(250000) - calculateCheckoutFeeMinor(249999), 10000);
});

test('net: falls by 9999 at the fixed-fee threshold', () => {
  assert.equal(calculateCheckoutNetMinor(249999), 246249); // 249999 - 3750
  assert.equal(calculateCheckoutNetMinor(250000), 236250); // 250000 - 13750
  assert.equal(calculateCheckoutNetMinor(249999) - calculateCheckoutNetMinor(250000), 9999);
});

test('fee: cap crossover at 12666634, net stays continuous', () => {
  // floor((3 * 12666633 + 100) / 200) = floor(37999999 / 200) = 189999
  // (+10000 = 199999, still under the 200000 cap).
  assert.equal(calculateCheckoutFeeMinor(12666633), 199999);
  // floor((3 * 12666634 + 100) / 200) = floor(38000002 / 200) = 190000
  // (+10000 = 200000, exactly at the cap).
  assert.equal(calculateCheckoutFeeMinor(12666634), 200000);
  assert.equal(calculateCheckoutFeeMinor(MAX_GROSS_MINOR), 200000);
  // net(M) = M - 200000 past the cap, so the cap boundary itself is
  // continuous: 12666633 - 199999 === 12666634 - 200000.
  assert.equal(calculateCheckoutNetMinor(12666633), 12466634);
  assert.equal(calculateCheckoutNetMinor(12666634), 12466634);
});

test('fee/net: agree with an independent reference over dense windows and stride probes', () => {
  const windows = [
    [1, 5000],
    [249500, 250500],
    [12666500, 12666800],
    [MAX_GROSS_MINOR - 500, MAX_GROSS_MINOR],
  ];
  for (const [lo, hi] of windows) {
    for (let m = lo; m <= hi; m += 1) {
      assert.equal(calculateCheckoutFeeMinor(m), referenceFee(m), `fee(${m})`);
      assert.equal(calculateCheckoutNetMinor(m), referenceNet(m), `net(${m})`);
      assert.equal(
        calculateCheckoutFeeMinor(m) + calculateCheckoutNetMinor(m),
        m,
        `fee + net must equal gross at ${m}`
      );
    }
  }

  // Deterministic probes across the whole domain, at offsets chosen to hit
  // varied residues modulo 200 (where the half-up rounding can flip) and to
  // include both sides of the threshold and the cap.
  const stride = 3999913; // prime-ish, coprime with 200
  const offsets = [0, 137, 199];
  for (const offset of offsets) {
    for (let m = offset; m <= MAX_GROSS_MINOR; m += stride) {
      if (m < MIN_GROSS_MINOR) {
        continue;
      }
      assert.equal(calculateCheckoutFeeMinor(m), referenceFee(m), `fee(${m})`);
      assert.equal(calculateCheckoutNetMinor(m), referenceNet(m), `net(${m})`);
      assert.equal(calculateCheckoutFeeMinor(m) + calculateCheckoutNetMinor(m), m, `fee + net at ${m}`);
    }
  }
});

test('net: non-decreasing on each branch, drops only across the threshold', () => {
  // Branch A: 1..249999 sampled densely around the exact-half residues.
  let previous = calculateCheckoutNetMinor(1);
  for (let m = 2; m <= FIXED_FEE_THRESHOLD_MINOR - 1; m += 1) {
    const net = calculateCheckoutNetMinor(m);
    assert.ok(net >= previous, `net must not fall on branch A at ${m}`);
    previous = net;
  }
  // Branch B: sampled from the threshold upward past the cap.
  previous = calculateCheckoutNetMinor(FIXED_FEE_THRESHOLD_MINOR);
  const stride = 97; // odd, hits varied percentage residues
  for (let m = FIXED_FEE_THRESHOLD_MINOR + stride; m <= 3000000; m += stride) {
    const net = calculateCheckoutNetMinor(m);
    assert.ok(net >= previous, `net must not fall on branch B at ${m}`);
    previous = net;
  }
});

// ---------------------------------------------------------------------------
// Inverse direction: charge(P)
// ---------------------------------------------------------------------------

test('charge: hand-checked anchors, each sufficient and globally minimal', () => {
  const anchors = [
    // P = 1: net(1) = 1 - 0 = 1 already covers it.
    [1, 1],
    // P = 240000: solve M - floor((3M + 100) / 200) >= 240000 on branch A.
    // M = 243655: floor((730965 + 100) / 200) = 3655, net = 240000 exactly;
    // M = 243654: same fee, net = 239999 (one short).
    [240000, 243655],
    // P = 246248: M = 249998, fee = floor(750094 / 200) = 3750, net = 246248;
    // M = 249997 gives net = 246247.
    [246248, 249998],
    // P = 246249: the largest target branch A can still reach, at its own top.
    [246249, 249999],
    // P = 246250: branch A is now empty (net(249999) = 246249 < P), so the
    // answer jumps into branch B: M = 260152, fee = 3902 + 10000 = 13902,
    // net = 246250 exactly; M = 260151 gives net = 246249.
    [246250, 260152],
    // P = 250000: M = 263959, fee = 3959 + 10000 = 13959, net = 250000.
    [250000, 263959],
    // P = 10000000 (NGN 100,000): M = 10162437, fee = 152437 + 10000 =
    // 162437, net = 10000000; M - 1 gives net = 9999999.
    [10000000, 10162437],
    // P = 12466634: the last target before the cap; M = 12666633,
    // fee = 189999 + 10000 = 199999 (pre-cap), net = 12466634.
    [12466634, 12666633],
    // Past the cap net(M) = M - 200000 exactly, so charge(P) = P + 200000
    // for every target whose answer already sits in the capped region.
    [12466666, 12666666],
    [12466667, 12666667],
    [12466668, 12666668],
    [20000000, 20200000],
    // The domain maximum: charge can exceed MAX_AMOUNT_MINOR by exactly the
    // fee cap.
    [1000000000000, 1000000200000],
  ];
  for (const [p, expected] of anchors) {
    assertChargeIsExact(p, expected);
  }
});

test('charge: branch A emptiness flips exactly between 246249 and 246250', () => {
  const below = calculateCheckoutChargeMinor(246249);
  const above = calculateCheckoutChargeMinor(246250);
  assert.ok(below <= FIXED_FEE_THRESHOLD_MINOR - 1, 'P = 246249 must be answered inside branch A');
  assert.ok(above >= FIXED_FEE_THRESHOLD_MINOR, 'P = 246250 must be answered inside branch B');
  assert.ok(above > 249999, 'the branch B answer cannot stay at branch A range');
});

test('charge: matches a linear-scan ground truth for P = 1..285500', () => {
  const expected = linearExpected(1, 285500);
  assert.equal(expected.size, 285500, 'the scan must resolve every target');
  for (let p = 1; p <= 285500; p += 1) {
    assert.equal(calculateCheckoutChargeMinor(p), expected.get(p), `charge(${p})`);
  }
});

test('charge: matches a linear-scan ground truth across the cap window', () => {
  const lo = 12466600;
  const hi = 12466700;
  const expected = linearExpected(lo, hi);
  assert.equal(expected.size, hi - lo + 1, 'the scan must resolve every target');
  for (let p = lo; p <= hi; p += 1) {
    assert.equal(calculateCheckoutChargeMinor(p), expected.get(p), `charge(${p})`);
  }
});

test('charge: sufficient, minimal, monotone and in-range over dense windows', () => {
  const windows = [
    [1, 2000],
    [246240, 246260],
    [249995, 250010],
    [12466628, 12466640],
  ];
  for (const [lo, hi] of windows) {
    let previous = null;
    for (let p = lo; p <= hi; p += 1) {
      const gross = calculateCheckoutChargeMinor(p);
      assert.ok(Number.isSafeInteger(gross), `charge(${p}) must be a safe integer`);
      assert.ok(gross >= MIN_GROSS_MINOR && gross <= MAX_GROSS_MINOR, `charge(${p}) out of range`);
      assert.ok(gross >= p, `charge(${p}) must be >= P`);
      assert.ok(calculateCheckoutNetMinor(gross) >= p, `charge(${p}) must be sufficient`);
      if (gross > MIN_GROSS_MINOR) {
        assert.ok(calculateCheckoutNetMinor(gross - 1) < p, `charge(${p}) must be minimal`);
      }
      if (previous !== null) {
        assert.ok(gross >= previous, `charge must be non-decreasing at P = ${p}`);
      }
      previous = gross;
    }
  }
});

test('charge: deterministic probe sweep across the full domain', () => {
  const stride = 3999913;
  const offsets = [0, 137, 199];
  const probes = [];
  for (const offset of offsets) {
    for (let p = offset; p <= MAX_AMOUNT_MINOR; p += stride) {
      if (p < MIN_GROSS_MINOR) {
        continue;
      }
      probes.push(p);
    }
  }
  probes.sort((a, b) => a - b);
  assert.ok(probes.length > 500000, `sweep must stay broad, saw ${probes.length} probes`);

  let previousP = null;
  let previousGross = null;
  for (const p of probes) {
    const gross = calculateCheckoutChargeMinor(p);
    assert.ok(Number.isSafeInteger(gross), `charge(${p}) must be a safe integer`);
    assert.ok(gross >= MIN_GROSS_MINOR && gross <= MAX_GROSS_MINOR, `charge(${p}) out of range`);
    assert.ok(gross >= p, `charge(${p}) must be >= P`);
    assert.ok(calculateCheckoutNetMinor(gross) >= p, `charge(${p}) must be sufficient`);
    if (gross > MIN_GROSS_MINOR) {
      assert.ok(calculateCheckoutNetMinor(gross - 1) < p, `charge(${p}) must be minimal`);
    }
    if (previousP !== null) {
      assert.ok(p > previousP, 'probe order must be strictly ascending');
      assert.ok(gross >= previousGross, `charge must be non-decreasing from P = ${previousP} to ${p}`);
    }
    previousP = p;
    previousGross = gross;
  }
});

test('charge: domain boundaries are accepted', () => {
  assertChargeIsExact(1, 1);
  assertChargeIsExact(MAX_AMOUNT_MINOR, MAX_AMOUNT_MINOR + FEE_CAP_MINOR);
  assert.equal(calculateCheckoutFeeMinor(MAX_GROSS_MINOR), FEE_CAP_MINOR);
  assert.equal(
    calculateCheckoutNetMinor(MAX_GROSS_MINOR),
    MAX_GROSS_MINOR - FEE_CAP_MINOR
  );
});

// ---------------------------------------------------------------------------
// Invalid input: no coercion, no silent rounding, no out-of-domain values
// ---------------------------------------------------------------------------

test('invalid input: TypeError for anything that is not a number', () => {
  const notNumbers = [
    ['100', 'string'],
    ['', 'empty string'],
    [null, 'null'],
    [undefined, 'undefined'],
    [true, 'true'],
    [false, 'false'],
    [{}, 'object'],
    [[], 'array'],
    [123n, 'bigint'],
    [Symbol('100'), 'symbol'],
  ];
  for (const [value, description] of notNumbers) {
    assert.throws(
      () => calculateCheckoutFeeMinor(value),
      TypeError,
      `fee must reject ${description}`
    );
    assert.throws(
      () => calculateCheckoutNetMinor(value),
      TypeError,
      `net must reject ${description}`
    );
    assert.throws(
      () => calculateCheckoutChargeMinor(value),
      TypeError,
      `charge must reject ${description}`
    );
  }

  // The message names the offending argument and the actual type.
  assert.throws(
    () => calculateCheckoutFeeMinor('100'),
    (error) =>
      error instanceof TypeError &&
      error.message.includes('gross charge') &&
      error.message.includes('string')
  );
  assert.throws(
    () => calculateCheckoutChargeMinor(null),
    (error) =>
      error instanceof TypeError &&
      error.message.includes('milestone amount') &&
      error.message.includes('object')
  );
});

test('invalid input: RangeError for non-integers and unsafe integers', () => {
  const notSafeIntegers = [
    [1.5, 'fraction'],
    [-0.5, 'negative fraction'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
    [2 ** 53, 'unsafe integer'],
    [-(2 ** 53), 'negative unsafe integer'],
  ];
  for (const [value, description] of notSafeIntegers) {
    assert.throws(
      () => calculateCheckoutFeeMinor(value),
      RangeError,
      `fee must reject ${description}`
    );
    assert.throws(
      () => calculateCheckoutNetMinor(value),
      RangeError,
      `net must reject ${description}`
    );
    assert.throws(
      () => calculateCheckoutChargeMinor(value),
      RangeError,
      `charge must reject ${description}`
    );
  }
});

test('invalid input: RangeError outside each supported domain', () => {
  // Every function requires M or P >= 1 (zero and negatives are money-less).
  for (const value of [0, -0, -1, -250000, -MAX_AMOUNT_MINOR]) {
    assert.throws(() => calculateCheckoutFeeMinor(value), RangeError, `fee(${value})`);
    assert.throws(() => calculateCheckoutNetMinor(value), RangeError, `net(${value})`);
    assert.throws(() => calculateCheckoutChargeMinor(value), RangeError, `charge(${value})`);
  }

  // charge caps P at MAX_AMOUNT_MINOR (the milestone bound).
  assert.throws(
    () => calculateCheckoutChargeMinor(MAX_AMOUNT_MINOR + 1),
    RangeError
  );
  assert.throws(() => calculateCheckoutChargeMinor(MAX_AMOUNT_MINOR + 200001), RangeError);

  // fee/net accept a gross up to MAX_GROSS_MINOR but no further.
  assert.doesNotThrow(() => calculateCheckoutFeeMinor(MAX_GROSS_MINOR));
  assert.throws(() => calculateCheckoutFeeMinor(MAX_GROSS_MINOR + 1), RangeError);
  assert.throws(() => calculateCheckoutNetMinor(MAX_GROSS_MINOR + 1), RangeError);
  // A gross between the milestone bound and the gross bound is legal: only
  // charge() (whose input is a milestone amount) is capped at 1e12.
  assert.doesNotThrow(() => calculateCheckoutFeeMinor(MAX_AMOUNT_MINOR + 1));
});
