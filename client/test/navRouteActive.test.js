import test from 'node:test';
import assert from 'node:assert/strict';
import { isNavPathActive } from '../src/components/navRouteActive.js';

const EMPLOYEE_HREFS = ['/dashboard', '/my-applications', '/employee/hired-jobs', '/profile'];
const EMPLOYER_HREFS = ['/dashboard', '/my-jobs', '/profile'];

const activeLinks = (hrefs, pathname) => hrefs.filter((href) => isNavPathActive(pathname, href));

test('Dashboard is active only on the dashboard route', () => {
    assert.deepEqual(activeLinks(EMPLOYEE_HREFS, '/dashboard'), ['/dashboard']);
    assert.deepEqual(activeLinks(EMPLOYER_HREFS, '/dashboard'), ['/dashboard']);

    // The bug this replaced: Dashboard stayed `current: true` everywhere.
    for (const pathname of ['/my-applications', '/employee/hired-jobs', '/my-jobs', '/profile', '/messages']) {
        assert.ok(
            !isNavPathActive(pathname, '/dashboard'),
            `Dashboard must not be active on ${pathname}`
        );
    }
});

test('each employee page highlights exactly its own link', () => {
    assert.deepEqual(activeLinks(EMPLOYEE_HREFS, '/my-applications'), ['/my-applications']);
    assert.deepEqual(activeLinks(EMPLOYEE_HREFS, '/employee/hired-jobs'), ['/employee/hired-jobs']);
    assert.deepEqual(activeLinks(EMPLOYEE_HREFS, '/profile'), ['/profile']);
});

test('the employee My Jobs entry stays active on its nested workspace route', () => {
    assert.deepEqual(
        activeLinks(EMPLOYEE_HREFS, '/employee/hired-jobs/employment-123'),
        ['/employee/hired-jobs']
    );
});

test('the employer My Jobs entry highlights only /my-jobs and its nested routes', () => {
    assert.deepEqual(activeLinks(EMPLOYER_HREFS, '/my-jobs'), ['/my-jobs']);
    assert.deepEqual(activeLinks(EMPLOYER_HREFS, '/my-jobs/anything'), ['/my-jobs']);
    assert.deepEqual(activeLinks(EMPLOYER_HREFS, '/dashboard'), ['/dashboard']);
});

test('employer subpages highlight no unrelated link', () => {
    for (const pathname of [
        '/employer/jobs/job-1/applications/Title',
        '/employer/jobs/job-1/employees/Title',
        '/employer/jobs/job-1/employments/emp-1',
        '/post-job',
        '/messages',
    ]) {
        assert.deepEqual(activeLinks(EMPLOYER_HREFS, pathname), [], `unexpected active link on ${pathname}`);
        assert.deepEqual(activeLinks(EMPLOYEE_HREFS, pathname), [], `unexpected active link on ${pathname}`);
    }
});

test('prefix matching respects path-segment boundaries', () => {
    assert.ok(!isNavPathActive('/my-jobsome', '/my-jobs'));
    assert.ok(!isNavPathActive('/profile-settings', '/profile'));
    assert.ok(!isNavPathActive('/employee/hired-jobsXYZ', '/employee/hired-jobs'));
    assert.ok(isNavPathActive('/my-jobs', '/my-jobs'));
    assert.ok(isNavPathActive('/my-jobs/', '/my-jobs'));
});

test('malformed inputs are inactive rather than throwing', () => {
    assert.equal(isNavPathActive(undefined, '/dashboard'), false);
    assert.equal(isNavPathActive('/dashboard', ''), false);
    assert.equal(isNavPathActive(null, null), false);
});
