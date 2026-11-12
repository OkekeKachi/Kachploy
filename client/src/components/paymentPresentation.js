/**
 * Pure payment presentation logic for the employer milestone panel.
 *
 * STAGE 1I.1. Kept in its own module for the same reason taskPresentation.js is
 * separate from TaskCard.jsx: the interactive component exports only a component
 * (so react-refresh keeps working), while the maps and rules below are pure --
 * no React, no network, no side effects -- which is what lets client/test/
 * exercise them with the plain node --test setup.
 *
 * NOTHING HERE GRANTS OR WITHHOLDS ACCESS, AND NOTHING HERE DECIDES PAYMENT
 * TRUTH. The server owns the payment status (paymentService.PAYMENT_STATUSES);
 * these functions only restate it for display, exactly as the employment and
 * task helpers in taskPresentation.js restate theirs. The variant maps mirror
 * the shared Badge variants used across the app so a payment state reads with
 * the same colour semantics everywhere.
 */

// The five statuses paymentService exports as PAYMENT_STATUSES, in the order the
// lifecycle moves through them. Restated rather than imported because the client
// and server run in different processes and share no module (the same boundary
// taskPresentation.js documents for its allow-lists).
export const PAYMENT_STATUSES = ['created', 'pending', 'paid', 'failed', 'needs_review'];

/**
 * Historical export retained for callers of this module. Initialization is no
 * longer permanently exhausted by an attempt count; the server throttles bursts
 * and allows a definitive failed attempt to be retried with a new reference.
 */
export const MAX_PAYMENT_INITIALIZATION_ATTEMPTS = 3;

// Short badge wording. `needs_review` and `pending` are worded to make clear that
// the outcome is NOT confirmed, and `failed` is left unadorned because the server
// already decided it.
export const PAYMENT_STATUS_LABELS = {
    created: 'Not paid',
    pending: 'Awaiting confirmation',
    paid: 'Paid',
    failed: 'Failed',
    needs_review: 'Needs review',
};

// Canonical status -> shared Badge variant. `paid` is the only success; `created`
// is neutral (nothing has happened yet); `pending` is informational; `failed` is
// danger; `needs_review` is a warning, never a success.
export const PAYMENT_STATUS_BADGE_VARIANTS = {
    created: 'neutral',
    pending: 'info',
    paid: 'success',
    failed: 'danger',
    needs_review: 'warning',
};

/**
 * A one-sentence, user-safe explanation of what each status means for the
 * employer. Never claims more than the server reported, and never mentions
 * provider internals, secrets or raw error text.
 */
export const PAYMENT_STATUS_EXPLANATIONS = {
    created: 'A payment record exists. Checkout has not been started yet.',
    pending: 'This payment attempt is not yet confirmed. Return here and refresh the status to check it.',
    paid: 'The server has confirmed this payment as successful.',
    failed: 'This payment attempt did not succeed. You can start a new checkout attempt safely.',
    needs_review: 'This payment needs manual review before its outcome can be confirmed.',
};

/** True only for a full-contract paymentMode, not a milestone schedule. */
export const isFullContract = (contract) =>
    Boolean(contract) && contract.paymentMode === 'full';

/**
 * Builds the client idempotency key for creating a full-contract payment.
 * The caller supplies one unique value and must reuse it when retrying the
 * exact same creation. Capped at the server's 128-character limit.
 */
export const makeContractPaymentIdempotencyKey = (contractId, uniqueId) => {
    if (typeof contractId !== 'string' || !contractId.trim()) return '';
    if (typeof uniqueId !== 'string' || !uniqueId.trim()) return '';
    return `kp-contract-${contractId.trim()}-${uniqueId.trim()}`.slice(0, 128);
};

/** The status of a payment record, or 'created' when none exists yet. */
export const paymentStatus = (payment) => {
    if (payment && typeof payment.status === 'string' && PAYMENT_STATUSES.includes(payment.status)) {
        return payment.status;
    }
    // No record, or an unrecognised stored value: the milestone is simply not
    // paid. This is a display default, never a claim about the server's state.
    return 'created';
};

export const paymentStatusLabel = (payment) => PAYMENT_STATUS_LABELS[paymentStatus(payment)] || 'Not paid';

export const paymentStatusBadgeVariant = (payment) =>
    PAYMENT_STATUS_BADGE_VARIANTS[paymentStatus(payment)] || 'neutral';

/** How many initialization attempts the server has recorded, normalised safely. */
export const paymentInitializationAttempts = (payment) => {
    if (!payment || !Number.isInteger(payment.verifyAttempts) || payment.verifyAttempts < 0) {
        return 0;
    }
    return payment.verifyAttempts;
};

/**
 * True once the server has stored a provider reference for any initialization.
 * Historical export retained for callers. It must NOT gate retries: a failed
 * payment is retried with a new reference, so this only describes the past.
 */
export const paymentHasProviderTransaction = (payment) =>
    Boolean(
        payment &&
            typeof payment.providerReference === 'string' &&
            payment.providerReference.trim()
    );

/**
 * A milestone's work may begin only when its payment record is confirmed paid.
 *
 * True only when a payment record exists and its persisted status is exactly
 * `paid` -- the one status the server writes only after provider-verified
 * collection. `created`, `pending`, `failed`, `needs_review` and a missing
 * record all return false: this is fail-closed, so an unconfirmed milestone is
 * never presented as funded. It never invents a `funded` field and never
 * describes `paid` as escrow, reserved for the employee, or guaranteed to be
 * released later.
 */
export const milestonePaymentIsConfirmed = (payment) => paymentStatus(payment) === 'paid';

export const paymentStatusExplanation = (payment) => {
    if (!payment) return 'No payment has been started yet.';
    if (paymentStatus(payment) === 'failed') {
        return 'This payment attempt did not succeed. You can start a new checkout attempt safely; each retry uses a new payment reference.';
    }
    return PAYMENT_STATUS_EXPLANATIONS[paymentStatus(payment)] || '';
};

/**
 * May Checkout be started for this payment right now?
 *
 * TRUE when the viewer is the employer AND the record is `created` (or does
 * not exist yet) or it is `failed`. A failed transaction is retryable with a
 * NEW provider reference; it is the server that decides whether a particular
 * request succeeds or is temporarily throttled. `pending`, `paid` and
 * `needs_review` are NO.
 */
export const canInitiatePayment = (payment, isEmployer) => {
    if (!isEmployer) return false;
    const status = paymentStatus(payment);
    return status === 'created' || status === 'failed';
};

/**
 * May the status be refreshed through POST /payments/verify?
 *
 * Only the employer, and only once a record exists whose status is not already
 * `created` -- there is nothing to verify before an attempt has been made.
 */
export const canRefreshStatus = (payment, isEmployer) =>
    Boolean(isEmployer) && payment !== null && payment !== undefined && paymentStatus(payment) !== 'created';

/**
 * Is this checkout URL a trusted Paystack-hosted URL?
 *
 * HTTPS only, and the hostname must be EXACTLY `checkout.paystack.com`. An exact
 * match (not a substring or suffix test) is what refuses lookalikes such as
 * `checkout.paystack.com.evil.example` and `evil-checkout.paystack.com`. This
 * duplicates the server's own isTrustedCheckoutUrl by necessity -- the client and
 * server share no module -- and exists to double-check before a full-page
 * navigation, not to replace the server's check.
 */
export const isTrustedCheckoutUrl = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;

    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch {
        return false;
    }

    return parsed.protocol === 'https:' && parsed.hostname === 'checkout.paystack.com';
};

/**
 * Formats a kobo amount for display only.
 *
 * The project's existing money display is `₦{value.toLocaleString()}` for whole
 * naira (EmployerDashboard, JobDetails), but every payment figure the backend
 * returns is in KOBO (`amountMinor`, `chargeMinor`, `feeMinor`). This divides by
 * 100 for readability and NGN is a 2-decimal minor unit, so no rounding is
 * implied. It is PRESENTATION ONLY: the backend stays authoritative for the
 * actual amount, fee and charge, and nothing here recomputes them. A non-finite
 * or missing value renders as an em dash rather than a fabricated number.
 */
export const formatKoboAsNaira = (kobo) => {
    if (typeof kobo !== 'number' || !Number.isFinite(kobo)) return '—';

    return `₦${(kobo / 100).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
};

/**
 * Extracts a user-safe message for a failed request without ever surfacing a
 * raw provider body or a secret.
 *
 * The backend's error responses are always `{ message }` with a fixed, safe
 * sentence (paymentController.sendFailure), so only that string is read. A 503
 * is the documented "Paystack not configured" case and gets its own words; every
 * other failure gets a generic, user-safe sentence.
 */
export const paymentErrorMessage = (err) => {
    const status = err && err.response && err.response.status;

    if (status === 503) {
        return 'Payments are not available on this server right now. Please try again later.';
    }

    const serverMessage =
        err && err.response && err.response.data && typeof err.response.data.message === 'string'
            ? err.response.data.message
            : '';

    if (serverMessage) return serverMessage;

    return 'Something went wrong while contacting the payment service. Please try again.';
};
