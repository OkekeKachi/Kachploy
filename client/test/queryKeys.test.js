import test from 'node:test';
import assert from 'node:assert/strict';
import { queryKeys } from '../src/queryKeys.js';

test('the user key is namespaced by family and uid', () => {
    assert.deepEqual(queryKeys.user('uid-123'), ['user', 'uid-123']);
});

test('the same uid always produces the same key, so observers share one cache entry', () => {
    // The whole point of the shared identity query: AppNavbar, RoleBasedDashboard
    // and both dashboards must address ONE entry per uid, or the duplicate
    // GET /users/getUser/:uid reads the audit identified would survive.
    assert.deepEqual(queryKeys.user('abc'), queryKeys.user('abc'));
});

test('different uids produce different keys, so one caller cannot read another', () => {
    // Invalidate-after-profile-update relies on this: invalidating the caller's
    // key must not address anyone else's cached document.
    assert.notDeepEqual(queryKeys.user('employer-1'), queryKeys.user('employee-2'));
});

test('keys are plain arrays of strings, suitable for invalidateQueries prefix matching', () => {
    const key = queryKeys.user('uid-1');
    assert.ok(Array.isArray(key));
    assert.ok(key.every((segment) => typeof segment === 'string'));
    // A ['user'] prefix invalidation would cover this entry (prefix matching).
    assert.deepEqual(key.slice(0, 1), ['user']);
});

test('the employer jobs key is namespaced by family and uid', () => {
    assert.deepEqual(queryKeys.employerJobs('uid-123'), ['employer', 'jobs', 'uid-123']);
});

test('the application counts key is uid-scoped even though the endpoint carries no uid', () => {
    // GET /applications/counts reads the caller from the verified token, but
    // the cache entry must still belong to one signed-in account: a
    // sign-out/sign-in as a different user cannot inherit the previous
    // caller's counts.
    assert.deepEqual(queryKeys.applicationCounts('uid-123'), ['applications', 'counts', 'uid-123']);
});

test('the employer employments key is namespaced by family and uid', () => {
    assert.deepEqual(queryKeys.employerEmployments('uid-123'), ['employer', 'employments', 'uid-123']);
});

test('the two employer families share only the employer root, so a jobs invalidation leaves employments cached', () => {
    // The pages invalidate through exact keys, but prefix matching means an
    // ['employer', 'jobs', uid] invalidation must not also wipe the
    // employments entry -- the differing second segment is what keeps them
    // apart, and the ['employer'] root is what a future family-wide
    // invalidation would target.
    const jobs = queryKeys.employerJobs('u');
    const employments = queryKeys.employerEmployments('u');
    assert.notDeepEqual(jobs.slice(0, 2), employments.slice(0, 2));
    assert.deepEqual(jobs.slice(0, 1), employments.slice(0, 1));
});

test('employer keys are stable per uid and distinct across uids', () => {
    // EmployerDashboard and MyJobs must address ONE cache entry per document
    // per uid, or the duplicate reads the audit identified would survive --
    // and one employer must never be served another's cached list.
    assert.deepEqual(queryKeys.employerJobs('a'), queryKeys.employerJobs('a'));
    assert.notDeepEqual(queryKeys.employerJobs('a'), queryKeys.employerJobs('b'));
    assert.notDeepEqual(queryKeys.applicationCounts('a'), queryKeys.applicationCounts('b'));
    assert.notDeepEqual(queryKeys.employerEmployments('a'), queryKeys.employerEmployments('b'));
});

test('job-scoped reads share a job root but keep their child lists independently targetable', () => {
    assert.deepEqual(queryKeys.job('job-1'), ['jobs', 'job-1']);
    assert.deepEqual(queryKeys.jobApplications('job-1'), ['jobs', 'job-1', 'applications']);
    assert.deepEqual(queryKeys.jobInterviews('job-1'), ['jobs', 'job-1', 'interviews']);
    assert.deepEqual(queryKeys.jobTasks('job-1'), ['jobs', 'job-1', 'tasks']);
    assert.deepEqual(queryKeys.jobEmployments('job-1'), ['jobs', 'job-1', 'employments']);

    assert.deepEqual(queryKeys.jobApplications('job-1').slice(0, 2), queryKeys.job('job-1'));
    assert.notDeepEqual(queryKeys.jobTasks('job-1').slice(0, 3), queryKeys.jobInterviews('job-1').slice(0, 3));
    assert.notDeepEqual(queryKeys.jobTasks('job-1'), queryKeys.jobTasks('job-2'));
});

test('employee list keys are uid-scoped and do not collide with employer lists', () => {
    assert.deepEqual(queryKeys.employeeApplications('u1'), ['applications', 'employee', 'u1']);
    assert.deepEqual(queryKeys.employeeEmployments('u1'), ['employments', 'employee', 'u1']);
    assert.deepEqual(queryKeys.employeeTasks('u1'), ['tasks', 'employee', 'u1']);

    assert.notDeepEqual(queryKeys.employeeApplications('u1'), queryKeys.employeeApplications('u2'));
    assert.notDeepEqual(queryKeys.employeeEmployments('u1'), queryKeys.employerEmployments('u1'));
});

test('application-scoped interview and proposal keys separate their resources', () => {
    assert.deepEqual(
        queryKeys.applicationInterviews('app-1'),
        ['interviews', 'application', 'app-1']
    );
    assert.deepEqual(
        queryKeys.contractProposals('app-1'),
        ['contracts', 'proposals', 'app-1']
    );
    assert.notDeepEqual(
        queryKeys.applicationInterviews('app-1'),
        queryKeys.applicationInterviews('app-2')
    );
    assert.notDeepEqual(
        queryKeys.contractProposals('app-1'),
        queryKeys.contractProposals('app-2')
    );
});

test('contract keys are employment-scoped, and only the payment history list is cached', () => {
    assert.deepEqual(
        queryKeys.contract('employment-1'),
        ['contracts', 'employment', 'employment-1']
    );
    assert.notDeepEqual(queryKeys.contract('employment-1'), queryKeys.contract('employment-2'));

    assert.deepEqual(
        queryKeys.paymentHistory('uid-1', { page: 1, pageSize: 10 }),
        ['payments', 'history', 'uid-1', { page: 1, pageSize: 10 }]
    );
    assert.notDeepEqual(
        queryKeys.paymentHistory('uid-1', { page: 1 }),
        queryKeys.paymentHistory('uid-2', { page: 1 })
    );
    assert.notDeepEqual(
        queryKeys.paymentHistory('uid-1', { page: 1 }),
        queryKeys.paymentHistory('uid-1', { page: 2 })
    );
});

test('a public profile key never aliases the caller identity key', () => {
    assert.deepEqual(queryKeys.publicUser('u1'), ['users', 'public', 'u1']);
    assert.notDeepEqual(queryKeys.publicUser('u1'), queryKeys.user('u1'));
    assert.notDeepEqual(queryKeys.publicUser('u1'), queryKeys.publicUser('u2'));
});
