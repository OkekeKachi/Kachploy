export const RELEASE_STATUSES = [
    'requested',
    'in_flight',
    'succeeded',
    'failed',
    'needs_review',
    'cancelled',
];

export const RELEASE_STATUS_LABELS = {
    requested: 'Awaiting approval',
    in_flight: 'Sending',
    succeeded: 'Paid',
    failed: 'Failed',
    needs_review: 'Needs review',
    cancelled: 'Cancelled',
};

export const RELEASE_STATUS_BADGE_VARIANTS = {
    requested: 'neutral',
    in_flight: 'info',
    succeeded: 'success',
    failed: 'danger',
    needs_review: 'warning',
    cancelled: 'neutral',
};

export const RELEASE_STATUS_EXPLANATIONS = {
    requested: 'The release has been requested and is waiting for the employer to approve it.',
    in_flight: 'The payout has been sent to the provider but is not confirmed yet. Check the status before trying anything else.',
    succeeded: 'The provider confirmed this payout succeeded.',
    failed: 'The provider reported that this payout failed. Check the status before deciding what to do next.',
    needs_review: 'This payout outcome is not confirmed. Check the status to reconcile it with the provider.',
    cancelled: 'This release was cancelled before any payout was sent.',
};

export const releaseStatus = (release) => {
    const value = release && release.status;
    return RELEASE_STATUSES.includes(value) ? value : null;
};

export const releaseStatusLabel = (release) => {
    const status = releaseStatus(release);
    return status ? RELEASE_STATUS_LABELS[status] : 'Not started';
};

export const releaseStatusBadgeVariant = (release) => {
    const status = releaseStatus(release);
    return status ? RELEASE_STATUS_BADGE_VARIANTS[status] : 'neutral';
};

export const releaseStatusExplanation = (release) => {
    const status = releaseStatus(release);
    return status ? RELEASE_STATUS_EXPLANATIONS[status] : '';
};

export const targetRelease = (workspace, target) => {
    if (!workspace || !target) return null;
    const releases = Array.isArray(workspace.releases) ? workspace.releases : [];
    return (
        releases.find(
            (release) =>
                release.targetType === target.targetType
                && release.targetId === target.targetId
        ) || null
    );
};

export const canApproveTarget = (release) =>
    !release || release.status === 'requested';

export const canReconcileTarget = (release) =>
    Boolean(release)
    && ['in_flight', 'needs_review', 'failed', 'succeeded'].includes(release.status);

export const targetAction = (release) => {
    if (!release || release.status === 'requested') return 'approve';
    if (canReconcileTarget(release) && release.status !== 'succeeded') return 'reconcile';
    return null;
};

export const targetActionLabel = (release) =>
    targetAction(release) === 'reconcile' ? 'Check status' : 'Approve & send';

export const targetAmountMinor = (target) =>
    target && Number.isSafeInteger(target.amountMinor) ? target.amountMinor : null;

export const releaseErrorMessage = (error, fallback) => {
    const data = error && error.response && error.response.data;
    if (!data || typeof data !== 'object') return fallback;
    if (typeof data.reason === 'string' && data.reason.trim()) {
        return `${data.message || fallback} (${data.reason})`;
    }
    if (typeof data.message === 'string' && data.message.trim()) return data.message;
    return fallback;
};
