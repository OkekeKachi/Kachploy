'use strict';

/**
 * STAGE 1A. The checkout gross-up fee model: pure functions over integer
 * kobo. No I/O, no environment, no configuration, no provider contact and no
 * side effect of any kind -- this is arithmetic, so it is testable on its own
 * and is the one piece of the payment flow that can be proved rather than
 * mocked.
 *
 * WHAT IT IS FOR. A milestone must leave a certain NET amount with the
 * employee. The checkout charges a GROSS amount, and the fee comes off the
 * top, so the gross has to be inflated ("grossed up") until the net is
 * covered. That inverse is calculateCheckoutChargeMinor. The forward
 * direction -- what fee a given gross charge carries -- is
 * calculateCheckoutFeeMinor, and calculateCheckoutNetMinor is the difference.
 *
 * UNITS. Everything in and out is an integer number of KOBO (the NGN minor
 * unit). No floats, no major units, no string coercion, and the only
 * rounding anywhere is the fee's own documented half-up percentage rule.
 *
 * THE MODEL (gross charge M, desired milestone amount P):
 *
 *   feePct(M) = Math.floor((3 * M + 100) / 200)          // 1.5%, half up
 *   fee(M)    = Math.min(feePct(M) + (M >= 250000 ? 10000 : 0), 200000)
 *   net(M)    = M - fee(M)
 *   charge(P) = min { M >= 1 : net(M) >= P }             // the inverse
 *
 * i.e. 1.5% rounded HALF UP to the kobo, plus a fixed NGN 100 (10000 kobo)
 * once the gross charge reaches NGN 2,500 (250000 kobo), with the TOTAL fee
 * capped at NGN 2,000 (200000 kobo). The half-up rule is spelled
 * floor((3M + 100) / 200) rather than floor(3M / 200) so that an exact-half
 * percentage (3M mod 200 === 100, e.g. 1.5% of 100100 = 1501.5) rounds UP to
 * the next kobo, never down. An exact whole percentage needs no adjustment
 * and is unaffected by the +100 (e.g. 1.5% of 250000 = 3750 exactly).
 *
 * WHY THE INVERSE IS TWO SEARCHES, NOT ONE. The fixed NGN 100 starts at
 * M = 250000, so net() DROPS across that boundary:
 *
 *   net(249999) = 246249
 *   net(250000) = 236250
 *
 * net() is non-decreasing on 1..249999 and separately on 250000..Infinity,
 * but NOT across the whole domain, so a single binary search over the full
 * range is invalid and can return a non-minimal or wrong answer.
 * calculateCheckoutChargeMinor therefore searches the two branches
 * INDEPENDENTLY and returns the smaller qualifying candidate:
 *
 *   branch A: M in 1..249999          (no fixed fee)
 *   branch B: M in 250000..upper       (fixed fee, possibly capped)
 *
 * Every branch-A result is <= 249999 and every branch-B result is >= 250000,
 * so "the smaller qualifying candidate" is exactly "the globally smallest
 * qualifying M". On each branch the predicate `net(M) >= P` is monotone
 * (feePct rises by 0 or 1 per step, so net rises by 0 or 1; past the cap the
 * fee is constant and net rises by exactly 1), which is what makes a binary
 * search legal there -- the discontinuity never falls inside a search.
 *
 * FEASIBILITY OF EACH BRANCH. Branch A qualifies exactly when its own maximum
 * reaches the target: net(249999) = 246249 >= P, i.e. P <= 246249. Branch B
 * always qualifies: its search upper bound is max(250000, P + 200000), and
 * since fee(M) <= 200000 we have net(P + 200000) >= P; when P + 200000
 * falls below 250000 the bound is 250000 instead, where net(250000) = 236250
 * >= P holds because that case implies P <= 49999. Only branch A can ever be
 * empty, and when it is, branch B answers.
 *
 * MIDPOINTS. Math.floor((lo + hi) / 2) throughout. A bit-shift midpoint
 * (`>> 1`) truncates to a signed 32-bit integer and yields a NEGATIVE
 * midpoint above 2^31 kobo (about NGN 21,474,836), which would silently
 * corrupt the search for any charge above that size.
 *
 * ARITHMETIC RANGE. The largest intermediate is 3 * MAX_GROSS_MINOR + 100
 * (about 3 * 10^12) and the largest bound is MAX_AMOUNT_MINOR + 200000
 * (about 10^12); both sit far below Number.MAX_SAFE_INTEGER (2^53 - 1, about
 * 9 * 10^15), so every intermediate is exact. Returned values are still
 * checked to be safe integers, and inputs are range-checked before use.
 *
 * DISTINCT FROM commission.js. Those functions compute the PLATFORM's 5%
 * commission with a FLOOR rule; these compute the checkout provider's fee
 * with a HALF-UP rule. Two different fees, two different roundings -- the
 * `Checkout` name prefix exists so the two can never be confused at an import
 * site (commission.js also exports a calculateNetMinor that means something
 * else entirely: net of platform commission, not net of checkout fee).
 */

const { MAX_AMOUNT_MINOR } = require('./commission');

/** Smallest supported gross charge, and the smallest supported P, in kobo. */
const MIN_GROSS_MINOR = 1;

/** Below this gross charge the fixed NGN 100 does not apply (NGN 2,500). */
const FIXED_FEE_THRESHOLD_MINOR = 250000;

/** The fixed fee component, in kobo (NGN 100). */
const FIXED_FEE_MINOR = 10000;

/** The cap on the TOTAL fee, in kobo (NGN 2,000). */
const FEE_CAP_MINOR = 200000;

/**
 * The largest gross charge the calculator accepts, in kobo.
 *
 * calculateCheckoutChargeMinor(P) can legitimately exceed MAX_AMOUNT_MINOR --
 * the milestone bound in commission.js, which bounds P (the requested
 * milestone amount), not the gross -- by at most FEE_CAP_MINOR, because
 * net(M) >= P requires M <= P + fee(M) <= P + 200000. So the gross domain
 * extends exactly one fee cap past the milestone domain. Both stay far inside
 * the safe integer range.
 */
const MAX_GROSS_MINOR = MAX_AMOUNT_MINOR + FEE_CAP_MINOR;

/**
 * Type/domain gate shared by every public function.
 *
 * TypeError  -- the value is not a `number` at all (string, null, undefined,
 *               boolean, object, array, bigint, symbol). Nothing is coerced:
 *               silently accepting "3000" or 3000.5 is how a client and a
 *               document come to disagree about money.
 * RangeError -- it IS a number but not one this model supports: NaN,
 *               Infinity, a fraction, an unsafe integer (all caught by one
 *               Number.isSafeInteger test), or a value outside [min, max].
 *
 * `label` names the argument in the message; the value itself is only ever
 * interpolated when it is already known to be a number, so no exotic type can
 * break message construction.
 */
const assertSupportedKobo = (value, label, min, max) => {
    if (typeof value !== 'number') {
        throw new TypeError(`${label} must be a number of kobo, got type ${typeof value}`);
    }

    if (!Number.isSafeInteger(value)) {
        throw new RangeError(`${label} must be a safe integer number of kobo, got ${value}`);
    }

    if (value < min || value > max) {
        throw new RangeError(`${label} must be within ${min}..${max} kobo, got ${value}`);
    }

    return value;
};

/**
 * fee(M), unchecked. Callers (the public wrappers and the branch searches)
 * only ever pass values already proven to lie in 1..MAX_GROSS_MINOR, and every
 * such value keeps 3 * M + 100 below 3.000001 * 10^12 << 2^53, so the
 * arithmetic is exact without re-validating on each step of a search.
 */
const feeUnchecked = (grossMinor) =>
    Math.min(
        Math.floor((3 * grossMinor + 100) / 200) +
            (grossMinor >= FIXED_FEE_THRESHOLD_MINOR ? FIXED_FEE_MINOR : 0),
        FEE_CAP_MINOR
    );

/**
 * The fee a gross charge of `grossMinor` kobo carries, in kobo.
 *
 * Half-up on the 1.5% component, plus the fixed NGN 100 from 250000 kobo,
 * capped at NGN 2,000 overall. `grossMinor` may be as large as
 * MAX_GROSS_MINOR (a gross charge can sit one fee cap above the milestone
 * bound); it must be a positive safe integer in that range.
 */
const calculateCheckoutFeeMinor = (grossMinor) => {
    assertSupportedKobo(grossMinor, 'gross charge', MIN_GROSS_MINOR, MAX_GROSS_MINOR);
    return feeUnchecked(grossMinor);
};

/**
 * net(M) = M - fee(M): what a gross charge of `grossMinor` kobo actually
 * delivers after the checkout fee, in kobo.
 *
 * NOT monotonic across the whole domain (see the header): it falls by 9999 at
 * M = 250000 when the fixed NGN 100 switches on. Monotone on each of the two
 * branches separately, which is all the search needs. Same input domain as
 * calculateCheckoutFeeMinor.
 */
const calculateCheckoutNetMinor = (grossMinor) => {
    assertSupportedKobo(grossMinor, 'gross charge', MIN_GROSS_MINOR, MAX_GROSS_MINOR);
    return grossMinor - feeUnchecked(grossMinor);
};

/**
 * Smallest M in [lo..hi] with net(M) >= milestoneMinor.
 *
 * Preconditions (established by calculateCheckoutChargeMinor before each
 * call): net(hi) >= milestoneMinor, and net is non-decreasing on [lo..hi].
 * The first makes the answer exist, the second makes a lower-bound binary
 * search correct. The midpoint is Math.floor((lo + hi) / 2) -- never a bit
 * shift, per the header. At most ~40 iterations for any supported range, so
 * termination is bounded and no input can loop indefinitely.
 */
const smallestGrossWithNetAtLeast = (milestoneMinor, lo, hi) => {
    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (mid - feeUnchecked(mid) >= milestoneMinor) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
};

/**
 * charge(P): the GLOBALLY SMALLEST gross charge M >= 1 whose net is at least
 * `milestoneMinor` kobo.
 *
 * Two independent searches, one per branch of the discontinuity (see the
 * header for why a single search is invalid), taking the smaller qualifying
 * candidate. `milestoneMinor` must be a positive safe integer no greater than
 * MAX_AMOUNT_MINOR (the same bound the repository puts on a contract total).
 *
 * Returns a positive safe integer in 1..MAX_GROSS_MINOR. The result is always
 * >= P (the fee only ever removes kobo, so net(M) <= M) and may exceed
 * MAX_AMOUNT_MINOR by at most FEE_CAP_MINOR.
 */
const calculateCheckoutChargeMinor = (milestoneMinor) => {
    assertSupportedKobo(milestoneMinor, 'milestone amount', MIN_GROSS_MINOR, MAX_AMOUNT_MINOR);

    // Branch A: 1..249999, no fixed fee. Only searched when the branch's own
    // maximum still reaches the target, i.e. net(249999) = 246249 >= P.
    const branchATop = FIXED_FEE_THRESHOLD_MINOR - 1;
    let best = null;
    if (branchATop - feeUnchecked(branchATop) >= milestoneMinor) {
        best = smallestGrossWithNetAtLeast(milestoneMinor, MIN_GROSS_MINOR, branchATop);
    }

    // Branch B: 250000..upper. The endpoint always qualifies (see header), so
    // this search always returns a valid candidate and the sufficiency of the
    // overall answer never depends on branch A.
    const upper = Math.max(FIXED_FEE_THRESHOLD_MINOR, milestoneMinor + FEE_CAP_MINOR);
    const fixedFeeBranch = smallestGrossWithNetAtLeast(
        milestoneMinor,
        FIXED_FEE_THRESHOLD_MINOR,
        upper
    );

    const result = best === null ? fixedFeeBranch : Math.min(best, fixedFeeBranch);

    // Defensive: a returned gross charge outside the safe integer range would
    // be a broken search, not a bad input (the input passed its own checks).
    if (!Number.isSafeInteger(result) || result < MIN_GROSS_MINOR || result > MAX_GROSS_MINOR) {
        throw new RangeError('checkout gross charge fell outside 1..MAX_GROSS_MINOR');
    }

    return result;
};

module.exports = {
    MAX_AMOUNT_MINOR,
    MIN_GROSS_MINOR,
    FIXED_FEE_THRESHOLD_MINOR,
    FIXED_FEE_MINOR,
    FEE_CAP_MINOR,
    MAX_GROSS_MINOR,
    calculateCheckoutFeeMinor,
    calculateCheckoutNetMinor,
    calculateCheckoutChargeMinor,
};
