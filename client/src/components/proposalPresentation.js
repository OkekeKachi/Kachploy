/**
 * Pure presentation and gating logic for application-linked contract proposals
 * (STAGE 3D).
 *
 * A proposal is the pre-hire agreement between an employer and an applicant.
 * Accepting it does NOT hire anyone: the employer still has to finalize the hire,
 * and the server refuses that finalization until the proposal is accepted.
 *
 * Kept in its own module for the same reason contractPresentation.js and
 * taskPresentation.js are: the page components export only components so
 * react-refresh keeps working, while the maps and rules below are pure -- no
 * React, no network, no side effects -- which lets client/test/ exercise them
 * with the plain node --test setup.
 *
 * NOTHING HERE IS AUTHORITATIVE. The status values and lifecycle are restated
 * from contractService/proposal handling for display and client-side gating
 * only. The server re-validates every request and remains the only authority on
 * whether a proposal or a hire may proceed.
 */

import { formatKoboAsNaira, parseNairaToKobo } from './contractPresentation.js';

// The three statuses the proposal endpoints write. An allow-list, so an
// unrecognised stored value is surfaced rather than assumed.
export const PROPOSAL_PENDING = 'pending_acceptance';
export const PROPOSAL_CHANGES_REQUESTED = 'changes_requested';
export const PROPOSAL_ACCEPTED = 'accepted';

export const PROPOSAL_STATUSES = [
    PROPOSAL_PENDING,
    PROPOSAL_CHANGES_REQUESTED,
    PROPOSAL_ACCEPTED,
];

export const PROPOSAL_STATUS_LABELS = {
    [PROPOSAL_PENDING]: 'Awaiting employee response',
    [PROPOSAL_CHANGES_REQUESTED]: 'Changes requested',
    [PROPOSAL_ACCEPTED]: 'Terms accepted',
};

export const PROPOSAL_STATUS_BADGE_VARIANTS = {
    [PROPOSAL_PENDING]: 'warning',
    [PROPOSAL_CHANGES_REQUESTED]: 'info',
    [PROPOSAL_ACCEPTED]: 'success',
};

export const proposalStatusLabel = (status) =>
    PROPOSAL_STATUS_LABELS[status] || 'Status unavailable';

export const proposalStatusBadgeVariant = (status) =>
    PROPOSAL_STATUS_BADGE_VARIANTS[status] || 'neutral';

// When more than one proposal exists (legacy data), the most final one is the
// one that governs the next step. Accepted wins because hiring is gated on it;
// changes_requested comes next because it needs employer action; a pending
// proposal is last because it is waiting on the employee.
const ACTIVE_PRECEDENCE = {
    [PROPOSAL_ACCEPTED]: 0,
    [PROPOSAL_CHANGES_REQUESTED]: 1,
    [PROPOSAL_PENDING]: 2,
};

export const selectActiveProposal = (proposals) => {
    if (!Array.isArray(proposals)) return null;

    let active = null;

    for (const proposal of proposals) {
        if (!proposal || ACTIVE_PRECEDENCE[proposal.status] === undefined) continue;

        if (!active || ACTIVE_PRECEDENCE[proposal.status] < ACTIVE_PRECEDENCE[active.status]) {
            active = proposal;
        }
    }

    return active;
};

/**
 * Whether the employer may finalize this applicant's hire.
 *
 * Both conditions are the server's: the application must be `interviewed`
 * (cleared for hiring) and its active proposal must be accepted. The backend
 * enforces the same pair, so enabling the button on anything less would offer an
 * action guaranteed to fail.
 */
export const canFinalizeHire = (applicationStatus, proposals) =>
    applicationStatus === 'interviewed'
    && selectActiveProposal(proposals)?.status === PROPOSAL_ACCEPTED;

/**
 * What the employer's proposal area should render for the current proposal list:
 *   create   -- no proposal exists (the employer may send one)
 *   revise   -- the employee requested changes (prefill and resend)
 *   pending  -- waiting for the employee to respond
 *   accepted -- waiting for the employer to finalize the hire
 */
export const proposalEditorMode = (proposals) => {
    const active = selectActiveProposal(proposals);

    if (!active) return 'create';
    if (active.status === PROPOSAL_ACCEPTED) return 'accepted';
    if (active.status === PROPOSAL_CHANGES_REQUESTED) return 'revise';

    return 'pending';
};

/**
 * Converts a stored integer-kobo amount back to the naira string an input shows.
 * The form names are historical; their values are naira, not minor units.
 */
const koboToNairaInput = (kobo) => {
    if (typeof kobo !== 'number' || !Number.isSafeInteger(kobo) || kobo < 0) return '';
    if (kobo === 0) return '0';

    const whole = Math.floor(kobo / 100);
    const fraction = kobo % 100;

    return fraction === 0
        ? String(whole)
        : `${whole}.${String(fraction).padStart(2, '0')}`;
};

/**
 * Formats a stored kobo amount for either proposal summary. Proposal documents
 * remain canonical kobo; only the employer/employee display is in naira.
 */
export const formatProposalAmount = (kobo) => formatKoboAsNaira(kobo);

/**
 * Initial form values for a create (no proposal) or revise (existing proposal).
 * Amounts are kept as naira strings because they populate text/number inputs;
 * stored proposal amounts are integer kobo and buildProposalPayload converts
 * the naira form values back to kobo exactly once.
 */
export const proposalFormValues = (proposal) => {
    if (!proposal) {
        return {
            paymentMode: 'full',
            totalAmount: '',
            milestones: [{ label: '', amountMinor: '', description: '' }],
        };
    }

    const paymentMode = proposal.paymentMode === 'milestones' ? 'milestones' : 'full';

    const milestones = Array.isArray(proposal.milestones) && proposal.milestones.length > 0
        ? proposal.milestones.map((milestone) => ({
            label: milestone?.label ?? '',
            amountMinor: koboToNairaInput(milestone?.amountMinor),
            description: milestone?.description ?? '',
        }))
        : [{ label: '', amountMinor: '', description: '' }];

    return {
        paymentMode,
        totalAmount: koboToNairaInput(proposal.totalAmountMinor),
        milestones,
    };
};

/**
 * Builds the request body from the form state.
 *
 * `applicationId` is required by create and harmless on revise (the revise
 * endpoint reads only paymentMode/totalAmountMinor/milestones). The form values
 * are naira; the payload is integer kobo. The server still owns commission,
 * currency and status; no such field is sent from here.
 */
export const buildProposalPayload = (applicationId, form) => {
    const paymentMode = form?.paymentMode;
    const payload = { applicationId, paymentMode };

    if (paymentMode === 'milestones') {
        const rows = (form?.milestones || []).filter((milestone) => milestone
            && milestone.label
            && milestone.amountMinor !== ''
            && milestone.amountMinor !== null
            && milestone.amountMinor !== undefined);

        if (rows.length === 0) {
            return { ok: false, error: 'Add at least one milestone with a label and amount.' };
        }

        const milestones = [];

        for (let index = 0; index < rows.length; index += 1) {
            const milestone = rows[index];
            const amountMinor = parseNairaToKobo(milestone.amountMinor);

            if (amountMinor === null) {
                return {
                    ok: false,
                    error: `Milestone ${index + 1}: enter a positive amount in naira (for example 500000 or 500000.50).`,
                };
            }

            milestones.push({
                label: milestone.label,
                amountMinor,
                description: milestone.description || '',
            });
        }

        payload.milestones = milestones;
    } else if (paymentMode === 'full') {
        const totalAmountMinor = parseNairaToKobo(form?.totalAmount);

        if (totalAmountMinor === null) {
            return {
                ok: false,
                error: 'Enter a positive total amount in naira (for example 500000 or 500000.50).',
            };
        }

        payload.totalAmountMinor = totalAmountMinor;
    } else {
        return {
            ok: false,
            error: 'Choose how the contract is paid: one total or a milestone schedule.',
        };
    }

    return { ok: true, payload };
};

/**
 * A new proposal may only be created when the application is cleared for hiring
 * AND no proposal exists. The backend refuses a second one while any proposal is
 * outstanding or accepted, so the form is hidden rather than offered and failed.
 */
export const canCreateProposal = (applicationStatus, proposals) =>
    applicationStatus === 'interviewed'
    && (!Array.isArray(proposals) || proposals.length === 0);

/**
 * Finds the employment a hire just created, from the job's employment list.
 *
 * The hire response carries no employment id (the backend contract is unchanged),
 * so the workspace is selected from server data rather than invented. Documents
 * created by the current transactional hire use the application id as their own
 * id, and `applicationId` is matched too so a legacy auto-id hire is still found.
 */
export const findHireEmployment = (employments, applicationId) => {
    if (!Array.isArray(employments) || !applicationId) return null;

    return employments.find((employment) => employment
        && (employment.applicationId === applicationId || employment.id === applicationId))
        || null;
};

export const employmentWorkspacePath = (jobId, employmentId) =>
    `/employer/jobs/${jobId}/employments/${employmentId}`;
