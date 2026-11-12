import test from 'node:test';
import assert from 'node:assert/strict';
import {
    RELEASE_STATUSES,
    canApproveTarget,
    canReconcileTarget,
    releaseErrorMessage,
    releaseStatusBadgeVariant,
    releaseStatusExplanation,
    releaseStatusLabel,
    targetAction,
    targetActionLabel,
    targetRelease,
} from '../src/components/releasePresentation.js';

test('every release status has a label, explanation and badge, and only succeeded is success', () => {
    assert.deepEqual(RELEASE_STATUSES, [
        'requested',
        'in_flight',
        'succeeded',
        'failed',
        'needs_review',
        'cancelled',
    ]);

    for (const status of RELEASE_STATUSES) {
        assert.ok(releaseStatusLabel({ status }));
        assert.ok(releaseStatusExplanation({ status }));
        assert.ok(releaseStatusBadgeVariant({ status }));
        if (status !== 'succeeded') {
            assert.notEqual(releaseStatusBadgeVariant({ status }), 'success');
        }
    }
    assert.equal(releaseStatusBadgeVariant({ status: 'succeeded' }), 'success');
});

test('an unknown or missing release reads as not started without claiming success', () => {
    assert.equal(releaseStatusLabel(null), 'Not started');
    assert.equal(releaseStatusLabel({ status: 'provider_pending' }), 'Not started');
    assert.equal(releaseStatusBadgeVariant(null), 'neutral');
    assert.equal(releaseStatusExplanation({ status: 'provider_pending' }), '');
});

test('target lookup uses both the target type and target id', () => {
    const workspace = {
        releases: [
            { releaseId: 'rel_ms-1', targetType: 'milestone', targetId: 'ms-1', status: 'requested' },
            { releaseId: 'rel_contract_1', targetType: 'contract', targetId: 'emp-1', status: 'succeeded' },
        ],
    };

    assert.equal(targetRelease(workspace, { targetType: 'milestone', targetId: 'ms-1' }).releaseId, 'rel_ms-1');
    assert.equal(targetRelease(workspace, { targetType: 'contract', targetId: 'emp-1' }).releaseId, 'rel_contract_1');
    assert.equal(targetRelease(workspace, { targetType: 'milestone', targetId: 'emp-1' }), null);
});

test('the UI offers approval before submission and reconciliation after an uncertain outcome', () => {
    assert.equal(canApproveTarget(null), true);
    assert.equal(canApproveTarget({ status: 'requested' }), true);
    assert.equal(canApproveTarget({ status: 'failed' }), false);

    assert.equal(targetAction(null), 'approve');
    assert.equal(targetActionLabel(null), 'Approve & send');
    assert.equal(targetAction({ status: 'requested' }), 'approve');
    assert.equal(targetAction({ status: 'in_flight' }), 'reconcile');
    assert.equal(targetAction({ status: 'needs_review' }), 'reconcile');
    assert.equal(targetAction({ status: 'failed' }), 'reconcile');
    assert.equal(targetAction({ status: 'succeeded' }), null);
    assert.equal(targetAction({ status: 'cancelled' }), null);
    assert.equal(targetActionLabel({ status: 'failed' }), 'Check status');

    assert.equal(canReconcileTarget({ status: 'succeeded' }), true);
    assert.equal(canReconcileTarget({ status: 'cancelled' }), false);
});

test('server errors surface their message and safe reason', () => {
    assert.equal(
        releaseErrorMessage(
            { response: { data: { message: 'Not eligible', reason: 'work_not_approved' } } },
            'fallback'
        ),
        'Not eligible (work_not_approved)'
    );
    assert.equal(
        releaseErrorMessage({ response: { data: { message: 'No payout account' } } }, 'fallback'),
        'No payout account'
    );
    assert.equal(releaseErrorMessage({}, 'fallback'), 'fallback');
});
