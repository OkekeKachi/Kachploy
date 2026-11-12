'use strict';

/**
 * P1. Platform commission configuration and arithmetic. Server-side only.
 *
 * This is deliberately NOT provider configuration. P1 records contracts and
 * acceptance; it charges nobody, holds nothing, and settles nothing, so there
 * is no Paystack key, no split-settlement subaccount and no provider fee
 * calculation anywhere in this file or anywhere it is called from. What it
 * does own is the one number the contract document must carry: the platform's
 * share of the agreed amount, fixed at 500 basis points (5%).
 *
 * WHY BASIS POINTS. 5% is exactly 500/10000, and basis points keep that as an
 * integer through the whole calculation. A `0.05` float would make
 * `amount * 0.05` a floating-point multiplication whose result depends on the
 * binary representation of the amount, and two "identical" calculations could
 * disagree by a kobo. Integer basis points cannot.
 *
 * MONEY IS MINOR UNITS. Every amount this module touches is an integer number
 * of kobo (the NGN minor unit), never a major-unit float -- jobs.price is a
 * parseFloat major-unit value by a preserved legacy quirk, and contracts
 * deliberately do not inherit that. See contractService for the validation
 * that guarantees inputs to these functions are positive safe integers.
 *
 * ROUNDING RULE (documented, deterministic, tested):
 *   commission = floor(amountMinor * commissionBps / 10000)
 *
 * i.e. the commission is rounded DOWN to the whole kobo, never up. This
 * module computes `Math.floor((amountMinor * bps) / 10000)` only after
 * checking that `amountMinor * bps` does not exceed Number.MAX_SAFE_INTEGER.
 * At the platform rate the MAX_AMOUNT_MINOR guard below makes that structurally
 * true; a caller-supplied snapshot rate up to 10000 bps is checked at runtime,
 * because the product can otherwise leave the exact-integer range.
 *
 * FLOOR, NOT ROUND-HALF-UP, is the rule because it is the only rounding that
 * is (a) deterministic for every input, (b) never charges a fraction of a kobo
 * that cannot be collected anyway, and (c) biased against the platform rather
 * than against the worker, which is the honest default for a marketplace fee.
 * A remainder of 1..9999 kobo-basis simply vanishes; the platform never
 * rounds a fee up in its own favour.
 *
 * NO ENVIRONMENT VARIABLE in P1. The rate is a product constant, not a
 * deployment secret: an operator changing it per-environment would change what
 * every existing contract document means, and contracts are immutable records
 * of an agreed price. If a per-deployment override is ever introduced it must
 * be validated on read (integer, 0..10000) and stamped onto each contract at
 * creation exactly like commissionBps already is, so old contracts keep
 * describing the deal that was actually agreed. Nothing in this module reads
 * process.env.
 */

/** The platform commission, in basis points of the contract total. 500 bps = 5%. */
const PLATFORM_COMMISSION_BPS = 500;

/** Denominator converting basis points to a fraction. Fixed by definition. */
const BPS_DENOMINATOR = 10000;

/**
 * The contract currency, as the only value P1 accepts anywhere.
 *
 * Centralised here rather than inlined in contractService so the "NGN only"
 * rule has exactly one spelling, and so a future multi-currency stage has one
 * obvious place to widen. Stored on every contract document; the service
 * rejects any client-supplied currency that is not this value.
 */
const CONTRACT_CURRENCY = 'NGN';

/**
 * Upper bound for a contract total, in kobo.
 *
 * Chosen so that `amountMinor * PLATFORM_COMMISSION_BPS` cannot exceed
 * Number.MAX_SAFE_INTEGER: MAX_SAFE_INTEGER / 500 = 17,592,186,044,416, and
 * this bound is rounded down to a round 10^12 for legibility. In major units
 * that is NGN 10,000,000,000 (ten billion naira) per contract, which no
 * plausible marketplace job reaches and which keeps commission arithmetic at
 * the platform rate exact without a single BigInt or decimal library. Higher
 * caller-supplied snapshot rates are product-checked separately in
 * calculateCommissionMinor, because this bound alone no longer guarantees an
 * exact product for every accepted rate.
 */
const MAX_AMOUNT_MINOR = 1e12;

/**
 * Validates that a value is a positive, safe integer usable as a kobo amount.
 *
 * Returns true/false rather than throwing, so contractService can decide which
 * of its several monetary fields failed and word the 400 accordingly. The
 * checks, in order:
 *   * typeof number -- a numeric string is rejected, unlike jobs.price's
 *     preserved parseFloat coercion. Money fields on new resources do not
 *     inherit that quirk.
 *   * Number.isSafeInteger -- rejects 1.5, NaN, Infinity, 2^53 and anything
 *     Firestore could not round-trip exactly.
 *   * > 0 -- zero and negatives are rejected; P1 has no zero-value contracts
 *     and no credit notes.
 *   * <= MAX_AMOUNT_MINOR -- keeps commission arithmetic exact at the platform
 *     rate (see above).
 */
const isPositiveSafeMinorAmount = (value) =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_AMOUNT_MINOR;

/**
 * Computes the platform commission for a contract total, in kobo.
 *
 * `totalAmountMinor` must already have passed isPositiveSafeMinorAmount; this
 * function does not re-validate the amount, because it is called only after
 * that validation (contractService.createContract, paymentService
 * .initiatePayment) and a second check would only duplicate a message the
 * caller has already paid for.
 *
 * STAGE P2. `commissionBps` is now an optional second parameter, defaulting to
 * the live PLATFORM_COMMISSION_BPS so every existing call keeps its meaning
 * unchanged. The one caller that passes it is paymentService.initiatePayment,
 * which computes a per-milestone commission from the RATE SNAPSHOT stored on
 * the contract document (contract.commissionBps) rather than from the live
 * constant -- so if the platform rate ever changes, a payment record for an
 * old contract still describes the deal that contract was created under. The
 * snapshot is validated here: a bps value that is not an integer in 0..10000
 * is a programmer/config error (contracts only ever store the constant this
 * module writes), so it throws rather than being coerced or defaulted, and it
 * surfaces as a 500 rather than silently producing a wrong commission.
 *
 * Returns a non-negative safe integer: floor(total * bps / 10000). The
 * product is checked against Number.MAX_SAFE_INTEGER HERE, because the
 * optional rate made the old "MAX_AMOUNT_MINOR alone guarantees exactness"
 * argument incomplete: the default 500 bps keeps the largest total at 5*10^14
 * (exact), but a stored snapshot rate up to 10000 bps can push the product
 * past 2^53. The function refuses a combination it cannot compute exactly
 * rather than silently rounding it. The total amount itself is still the
 * caller's responsibility -- both callers validate it before this point and
 * this function does not duplicate their messages.
 */
const calculateCommissionMinor = (totalAmountMinor, commissionBps = PLATFORM_COMMISSION_BPS) => {
    if (
        !Number.isSafeInteger(commissionBps) ||
        commissionBps < 0 ||
        commissionBps > BPS_DENOMINATOR
    ) {
        throw new Error(
            `calculateCommissionMinor: commissionBps must be an integer in 0..${BPS_DENOMINATOR}, got ${commissionBps}`
        );
    }

    // Check the product BEFORE dividing, and before IEEE-754 can silently
    // round it. Every exact integer above MAX_SAFE_INTEGER rounds to a double
    // strictly greater than MAX_SAFE_INTEGER (the first step past 2^53 is 2),
    // so this comparison cannot let an unsafe product through.
    if (totalAmountMinor * commissionBps > Number.MAX_SAFE_INTEGER) {
        throw new Error(
            'calculateCommissionMinor: amountMinor * commissionBps exceeds Number.MAX_SAFE_INTEGER and cannot be computed exactly'
        );
    }

    return Math.floor((totalAmountMinor * commissionBps) / BPS_DENOMINATOR);
};

/**
 * The net amount left after the platform commission, in kobo.
 *
 * Derived rather than stored: the contract document keeps totalAmountMinor and
 * commissionAmountMinor, and net is a pure function of the two, so storing it
 * would be a third copy of the same arithmetic with a place to drift. Provided
 * as a function because the client will need it and because "total - commission"
 * expressed once here cannot disagree with itself.
 */
const calculateNetMinor = (totalAmountMinor) =>
    totalAmountMinor - calculateCommissionMinor(totalAmountMinor);

/**
 * Resolves the gross/net/commission split stored on a payment.
 *
 * New payments carry `netPayableMinor`, the one field that marks the
 * commission-aware model. Legacy payments do not have it, so their entire
 * `amountMinor` remains payable to the employee and no commission is
 * recognised. That fallback is deliberate: adding commission to historical
 * records would retroactively change money that was already paid out.
 *
 * For a new payment the three amounts must be internally consistent:
 *   * gross `amountMinor` is a positive safe minor amount;
 *   * `netPayableMinor` is a positive safe minor amount;
 *   * `commissionAmountMinor` is a non-negative safe integer;
 *   * net + commission equals gross;
 *   * commissionBps is an integer in 0..10000 and reproduces the stored
 *     commission under the documented floor rule.
 *
 * A malformed new-model payment throws rather than falling back to legacy.
 * Treating a missing/incorrect net as "pay the gross amount" would silently
 * overpay the employee and under-recognise platform revenue.
 */
const paymentCommissionSplit = (payment) => {
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)) {
        throw new Error('paymentCommissionSplit: payment must be an object');
    }

    const grossAmountMinor = payment.amountMinor;
    if (!isPositiveSafeMinorAmount(grossAmountMinor)) {
        throw new Error(
            'paymentCommissionSplit: payment amountMinor must be a positive safe integer within the supported range'
        );
    }

    if (payment.netPayableMinor === undefined) {
        return {
            grossAmountMinor,
            netPayableMinor: grossAmountMinor,
            commissionAmountMinor: 0,
            commissionBps: undefined,
            commissionIncluded: false,
        };
    }

    const { netPayableMinor, commissionAmountMinor, commissionBps } = payment;

    if (!isPositiveSafeMinorAmount(netPayableMinor)) {
        throw new Error(
            'paymentCommissionSplit: netPayableMinor must be a positive safe integer within the supported range'
        );
    }
    if (
        !Number.isSafeInteger(commissionAmountMinor) ||
        commissionAmountMinor < 0
    ) {
        throw new Error(
            'paymentCommissionSplit: commissionAmountMinor must be a non-negative safe integer'
        );
    }
    if (
        !Number.isSafeInteger(commissionBps) ||
        commissionBps < 0 ||
        commissionBps > BPS_DENOMINATOR
    ) {
        throw new Error(
            `paymentCommissionSplit: commissionBps must be an integer in 0..${BPS_DENOMINATOR}`
        );
    }
    if (netPayableMinor + commissionAmountMinor !== grossAmountMinor) {
        throw new Error(
            'paymentCommissionSplit: netPayableMinor + commissionAmountMinor must equal amountMinor'
        );
    }
    if (
        calculateCommissionMinor(grossAmountMinor, commissionBps) !==
        commissionAmountMinor
    ) {
        throw new Error(
            'paymentCommissionSplit: commissionAmountMinor does not match commissionBps'
        );
    }

    return {
        grossAmountMinor,
        netPayableMinor,
        commissionAmountMinor,
        commissionBps,
        commissionIncluded: true,
    };
};

module.exports = {
    PLATFORM_COMMISSION_BPS,
    BPS_DENOMINATOR,
    CONTRACT_CURRENCY,
    MAX_AMOUNT_MINOR,
    isPositiveSafeMinorAmount,
    calculateCommissionMinor,
    calculateNetMinor,
    paymentCommissionSplit,
};
