/**
 * Pure contract presentation and form-validation logic for the employer/employee
 * contract workflow (STAGE 1I.3).
 *
 * Kept in its own module for the same reason taskPresentation.js and
 * paymentPresentation.js are: the interactive component (ContractSetupPanel.jsx)
 * exports only a component so react-refresh keeps working, while the maps and
 * rules below are pure -- no React, no network, no side effects -- which is what
 * lets client/test/ exercise them with the plain node --test setup.
 *
 * NOTHING HERE IS AUTHORITATIVE. The contract status values, payment modes and
 * amount rules are restated from contractService and config/commission.js for
 * DISPLAY AND CLIENT-SIDE PRE-CHECKS ONLY. The server re-validates everything
 * (createContract), owns the employment identity and the commission, and is the
 * only authority on a contract's status. The checks here exist so the employer
 * gets an immediate, readable message instead of a round-trip they would lose --
 * the server still answers 400 to anything wrong.
 */

// The two statuses contractService.CONTRACT_STATUSES writes and reads. An
// allow-list, so an unrecognised stored value is surfaced rather than assumed.
export const CONTRACT_STATUSES = ['pending_acceptance', 'active'];

// Short wording for the shared Badge.
export const CONTRACT_STATUS_LABELS = {
    pending_acceptance: 'Pending acceptance',
    active: 'Active',
};

// Canonical status -> shared Badge variant. `active` is the only success;
// `pending_acceptance` is informational. An unknown value falls back to neutral
// rather than claiming a state the document never said.
export const CONTRACT_STATUS_BADGE_VARIANTS = {
    pending_acceptance: 'info',
    active: 'success',
};

/** The two payment modes contractService accepts. */
export const CONTRACT_PAYMENT_MODES = ['full', 'milestones'];

export const PAYMENT_MODE_LABELS = {
    full: 'One total',
    milestones: 'Milestone schedule',
};

/**
 * The contract amount bound, restated from config/commission.js
 * (MAX_AMOUNT_MINOR = 1e12 kobo). Used only to pre-check a typed amount so the
 * employer is told before submitting; the server enforces the same ceiling.
 */
export const MAX_AMOUNT_MINOR = 1e12;

/** Milestone schedule bounds, restated from contractService (1..50). */
export const MIN_MILESTONES = 1;
export const MAX_MILESTONES = 50;

/**
 * The contract's status, or '' when the document carries no recognised status.
 *
 * Unlike taskPresentation's taskStatus default, there is NO fallback to a real
 * status here: contractService derives nothing client-side, so defaulting a
 * missing status to `pending_acceptance` would be this UI asserting a state no
 * document stated. An empty string renders as "No status available".
 */
export const contractStatus = (contract) => {
    if (contract && typeof contract.status === 'string' && CONTRACT_STATUSES.includes(contract.status)) {
        return contract.status;
    }
    return '';
};

export const contractStatusLabel = (contract) =>
    CONTRACT_STATUS_LABELS[contractStatus(contract)] || 'No status available';

export const contractStatusBadgeVariant = (contract) =>
    CONTRACT_STATUS_BADGE_VARIANTS[contractStatus(contract)] || 'neutral';

/** True when a stored contract is waiting for the employee to accept it. */
export const isPendingAcceptance = (contract) => contractStatus(contract) === 'pending_acceptance';

/** True when a stored contract has been accepted and is now binding. */
export const isActiveContract = (contract) => contractStatus(contract) === 'active';

/**
 * Parses a naira amount typed by the employer into an integer number of kobo.
 *
 * The contract request is in KOBO (`totalAmountMinor`, `milestones[].amountMinor`),
 * but people type naira. This converts major -> minor (x100) and rejects
 * anything that is not a positive whole number of kobo within the bound. It
 * accepts a plain decimal string ("5000", "5000.50") and returns an integer, or
 * `null` when the input cannot be a valid amount. It performs NO rounding of a
 * fractional kobo: "5000.555" is refused rather than silently altered.
 *
 * This is a pre-check, not the authority. The server still validates with
 * isPositiveSafeMinorAmount; sending a value this accepted is not a guarantee.
 */
export const parseNairaToKobo = (value) => {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return null;
        value = String(value);
    }

    if (typeof value !== 'string') return null;

    const trimmed = value.trim();
    if (trimmed === '') return null;

    // Only digits with an optional single decimal point (1-2 decimal places).
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;

    // Convert via string arithmetic so no float ever touches the amount.
    const [whole, fraction = ''] = trimmed.split('.');
    const paddedFraction = (fraction + '00').slice(0, 2);
    const kobo = Number(whole) * 100 + Number(paddedFraction);

    if (!Number.isSafeInteger(kobo) || kobo <= 0 || kobo > MAX_AMOUNT_MINOR) return null;

    return kobo;
};

/** Formats an integer number of kobo as naira for display (display only). */
export const formatKoboAsNaira = (kobo) => {
    if (typeof kobo !== 'number' || !Number.isFinite(kobo)) return '—';

    return `₦${(kobo / 100).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
};

/**
 * Builds and validates the POST /contracts body from the raw form state.
 *
 * Returns `{ ok: true, payload }` or `{ ok: false, error }` with a single,
 * user-readable sentence. The payload it produces contains ONLY the fields the
 * backend accepts -- `employmentId`, `paymentMode`, and either
 * `totalAmountMinor` (full) or `milestones` (milestones) -- and never a
 * forbidden field (identities, commission, status). Nothing is sent that the
 * contract document does not own.
 *
 * `milestones` is the raw form list of `{ label, amountNaira }`. Milestones are
 * independent payment obligations: they do not need a task, and tasks opt into
 * one later by storing its id.
 */
export const buildContractPayload = ({ employmentId, paymentMode, totalNaira, milestones }) => {
    if (typeof employmentId !== 'string' || !employmentId.trim()) {
        return { ok: false, error: 'This employment could not be identified, so a contract cannot be created.' };
    }

    if (!CONTRACT_PAYMENT_MODES.includes(paymentMode)) {
        return { ok: false, error: 'Choose how the contract is paid: one total or a milestone schedule.' };
    }

    if (paymentMode === 'full') {
        const totalAmountMinor = parseNairaToKobo(totalNaira);
        if (totalAmountMinor === null) {
            return { ok: false, error: 'Enter a positive total amount in naira (for example 5000 or 5000.50).' };
        }

        return { ok: true, payload: { employmentId: employmentId.trim(), paymentMode: 'full', totalAmountMinor } };
    }

    // milestones mode
    if (!Array.isArray(milestones) || milestones.length < MIN_MILESTONES) {
        return { ok: false, error: 'Add at least one milestone.' };
    }

    if (milestones.length > MAX_MILESTONES) {
        return { ok: false, error: `A contract can have at most ${MAX_MILESTONES} milestones.` };
    }

    const cleaned = [];

    for (let index = 0; index < milestones.length; index += 1) {
        const entry = milestones[index] || {};
        const position = index + 1;

        const label = typeof entry.label === 'string' ? entry.label.trim() : '';
        if (!label) {
            return { ok: false, error: `Milestone ${position}: enter a label.` };
        }

        const amountMinor = parseNairaToKobo(entry.amountNaira);
        if (amountMinor === null) {
            return {
                ok: false,
                error: `Milestone ${position}: enter a positive amount in naira (for example 5000 or 5000.50).`,
            };
        }

        cleaned.push({ label, amountMinor });
    }

    return {
        ok: true,
        payload: { employmentId: employmentId.trim(), paymentMode: 'milestones', milestones: cleaned },
    };
};

/**
 * A user-safe message for a failed contract request, reading only the server's
 * fixed `{ message }` sentence. Never surfaces a raw error, stack or secret.
 * 403/404 get their own wording because the server's own sentences for those
 * are already user-appropriate; a network failure gets a generic sentence.
 */
export const contractErrorMessage = (err) => {
    const status = err && err.response && err.response.status;
    const serverMessage =
        err && err.response && err.response.data && typeof err.response.data.message === 'string'
            ? err.response.data.message
            : '';

    if (serverMessage) return serverMessage;

    if (status === 404) {
        return 'This contract or employment could not be found.';
    }

    if (status === 403) {
        return 'You do not have permission to do that on this contract.';
    }

    return 'Something went wrong while contacting the server. Please try again.';
};
