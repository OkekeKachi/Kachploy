import test from 'node:test';
import assert from 'node:assert/strict';
import {
    TASK_STATUS_BADGE_VARIANTS,
    TASK_STATUS_LABELS,
    milestoneLabelForTask,
    taskStatus,
    taskStatusBadgeLabel,
    taskStatusBadgeVariant,
    taskStatusLabel,
} from '../src/components/taskPresentation.js';

test('every server status renders a distinct badge variant', () => {
    assert.equal(taskStatusBadgeVariant({ status: 'assigned' }), 'neutral');
    assert.equal(taskStatusBadgeVariant({ status: 'submitted' }), 'info');
    assert.equal(taskStatusBadgeVariant({ status: 'revision_requested' }), 'warning');
    assert.equal(taskStatusBadgeVariant({ status: 'approved' }), 'success');

    const variants = Object.values(TASK_STATUS_BADGE_VARIANTS);
    assert.equal(new Set(variants).size, variants.length, 'variants must be visually distinct');
});

test('the badge wording is immediately clear for the two review outcomes', () => {
    assert.equal(taskStatusBadgeLabel({ status: 'approved' }), 'Approved');
    assert.equal(taskStatusBadgeLabel({ status: 'revision_requested' }), 'Sent back for changes');
    assert.equal(taskStatusBadgeLabel({ status: 'submitted' }), 'Submitted');
    assert.equal(taskStatusBadgeLabel({ status: 'assigned' }), 'Assigned');
});

test('a legacy task with no stored status still reads as assigned', () => {
    assert.equal(taskStatus({ id: 't1' }), 'assigned');
    assert.equal(taskStatusBadgeVariant({ id: 't1' }), 'neutral');
    assert.equal(taskStatusBadgeLabel({ id: 't1' }), 'Assigned');
});

test('an unrecognised status falls back to a neutral badge, not a wrong state', () => {
    assert.equal(taskStatusBadgeVariant({ status: 'archived' }), 'neutral');
    assert.equal(taskStatusBadgeLabel({ status: 'archived' }), 'No status available');
});

test('the count labels keep the canonical status wording', () => {
    assert.equal(taskStatusLabel({ status: 'revision_requested' }), 'Revision requested');
    assert.deepEqual(Object.keys(TASK_STATUS_LABELS), [
        'assigned',
        'submitted',
        'revision_requested',
        'approved',
    ]);
});

test('a linked milestone renders its human label, never its internal id', () => {
    const milestones = [
        { id: 'ms-1', label: ' Foundation ' },
        { id: 'ms-2', label: '' },
    ];

    assert.equal(milestoneLabelForTask({ milestoneId: 'ms-1' }, milestones), 'Foundation');
    assert.equal(milestoneLabelForTask({ milestoneId: 'missing' }, milestones), '');
    assert.equal(milestoneLabelForTask({ milestoneId: 'ms-2' }, milestones), '');
    assert.equal(milestoneLabelForTask({ id: 'task-1' }, milestones), '');
    assert.equal(milestoneLabelForTask({ milestoneId: 'ms-1' }, null), '');
});
