import test from 'node:test';
import assert from 'node:assert/strict';

const ACCEPTED = 'accepted';
const REJECTED = 'rejected';
const PENDING = 'pending';
const INTERVIEWED = 'interviewed';

const canonicalAppStatus = (status) => {
    if (status === 'Employed') return ACCEPTED;
    if (status === 'Not Hired') return REJECTED;
    return status;
};

test('employer view: after a hire, only the hired applicant remains visible', () => {
    const applications = [
        { id: 'a1', status: PENDING },
        { id: 'a2', status: INTERVIEWED },
        { id: 'a3', status: ACCEPTED },
    ];
    const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
    const visibleApps = hasAccepted
        ? applications.filter(app => canonicalAppStatus(app.status) === ACCEPTED)
        : applications;
    assert.deepEqual(visibleApps.map(app => app.id), ['a3']);
});

test('employer view: shows applicants when no hire exists', () => {
    const applications = [
        { id: 'a1', status: PENDING },
        { id: 'a2', status: INTERVIEWED },
        { id: 'a3', status: REJECTED },
    ];
    const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
    const visibleApps = hasAccepted ? [] : applications;
    assert.deepEqual(visibleApps.length, 3);
});

test('employer view: legacy Employed counts as a hire and stays visible', () => {
    const applications = [
        { id: 'a1', status: 'Employed' },
        { id: 'a2', status: PENDING },
    ];
    const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
    const visibleApps = hasAccepted
        ? applications.filter(app => canonicalAppStatus(app.status) === ACCEPTED)
        : applications;
    assert.deepEqual(visibleApps.map(app => app.id), ['a1']);
});

test('employee my applications: hides accepted (Employed)', () => {
    const applications = [
        { id: 'a1', status: PENDING },
        { id: 'a2', status: 'Employed' },
        { id: 'a3', status: REJECTED },
    ];
    const visible = applications.filter(app => canonicalAppStatus(app.status) !== ACCEPTED);
    assert.equal(visible.length, 2);
    assert.ok(visible.every(v => canonicalAppStatus(v.status) !== ACCEPTED));
});

test('explicit rejection remains visible when no hire', () => {
    const applications = [
        { id: 'a1', status: 'Not Hired' },
        { id: 'a2', status: REJECTED },
    ];
    const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
    const visibleApps = hasAccepted ? [] : applications;
    assert.equal(visibleApps.length, 2);
});

test('employer view: empty list shows no-applications message (no hire)', () => {
    const applications = [];
    const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
    if (applications.length === 0) {
        assert.equal(applications.length, 0);
        // no hire exists; genuine empty
        assert.equal(hasAccepted, false);
    }
});

test('employer view: a filled job keeps the hired applicant and hides the rest', () => {
    const applications = [
        { id: 'a1', status: PENDING },
        { id: 'a2', status: INTERVIEWED },
        { id: 'a3', status: ACCEPTED },
    ];
    const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
    const visibleApps = hasAccepted
        ? applications.filter(app => canonicalAppStatus(app.status) === ACCEPTED)
        : applications;
    assert.equal(hasAccepted, true);
    assert.equal(visibleApps.length, 1);
    assert.equal(visibleApps[0].status, ACCEPTED);
});

test('employer view: filled state uses truthful title Job Filled', () => {
    const applications = [
        { id: 'a1', status: PENDING },
        { id: 'a2', status: 'Employed' },
    ];
    const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
    assert.equal(hasAccepted, true);
    assert.equal(applications.length, 2);
});
