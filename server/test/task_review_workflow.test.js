'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, task, employment, milestone, payment } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;
let current = '2026-01-01T00:00:00.000Z';
const clock = () => current;

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');
const timestamp = (ms) => ({ _seconds: Math.floor(ms / 1000), _nanoseconds: 0 });

test.before(async () => {
  client = await startTestServer({ clock });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  current = '2026-01-01T00:00:00.000Z';
  client.fake.resetAll();
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

function seedWorld({ taskStatus = 'assigned', taskOverrides = {} } = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({
      jobId: 'job-1',
      employerId: 'employer-1',
      employeeId: 'employee-1',
      applicationId: 'app-1',
    })
  );
  client.seed(
    'tasks',
    'task-1',
    task({
      jobId: 'job-1',
      employeeId: 'employee-1',
      applicationId: 'app-1',
      employmentId: 'emp-1',
      status: taskStatus,
      ...taskOverrides,
    })
  );
}

function seedSubmittedWithoutDeadline(overrides = {}) {
  seedWorld({
    taskStatus: 'submitted',
    taskOverrides: {
      submissionText: 'First delivery',
      submittedAt: timestamp(BASE_MS),
      submissionVersion: 1,
      ...overrides,
    },
  });
}

const SUBMISSION = { submissionText: 'Replaced the washer' };

test('submit stamps a seven-day deadline and the first submission version', async () => {
  seedWorld();

  const res = await employeeApi.post('/tasks/task-1/submit', { body: SUBMISSION });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');

  const stored = client.readDoc('tasks', 'task-1');
  assert.deepEqual(stored.reviewDeadlineAt, timestamp(BASE_MS + 7 * DAY_MS));
  assert.equal(stored.submissionVersion, 1);

  const read = await employeeApi.get('/tasks/task-1');
  assert.equal(read.status, 200);
  assert.equal(read.body.task.reviewWindowDays, 7);
  assert.equal(read.body.task.deadlinePassed, false);
  assert.equal(read.body.task.canRequestAdminReview, false);
});

test('a resubmission bumps the version and restarts the review deadline', async () => {
  seedWorld();
  await employeeApi.post('/tasks/task-1/submit', { body: SUBMISSION });

  current = '2026-01-02T00:00:00.000Z';
  const revision = await employerApi.post('/tasks/task-1/request-revision', {
    body: { revisionNote: 'Please replace the valve too' },
  });
  assert.equal(revision.status, 200);

  current = '2026-01-03T00:00:00.000Z';
  const second = await employeeApi.post('/tasks/task-1/submit', {
    body: { submissionText: 'Replaced the valve as well' },
  });

  assert.equal(second.status, 200);

  const stored = client.readDoc('tasks', 'task-1');
  assert.equal(stored.submissionVersion, 2);
  assert.deepEqual(
    stored.reviewDeadlineAt,
    timestamp(Date.parse('2026-01-10T00:00:00.000Z'))
  );
});

test('the employee cannot escalate before the review window has elapsed', async () => {
  seedSubmittedWithoutDeadline({ reviewDeadlineAt: timestamp(BASE_MS + 7 * DAY_MS) });

  current = '2026-01-07T23:59:59.999Z';
  const res = await employeeApi.post('/tasks/task-1/admin-review-request', {
    body: { reason: 'No answer from the employer' },
  });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /has not elapsed/i);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted');
  assert.equal(Object.keys(client.readAll('adminReviewRequests')).length, 0);
  assert.equal(Object.keys(client.readAll('taskReviewEvents')).length, 0);
});

test('after the deadline the employee can escalate, and the request is persisted once', async () => {
  seedSubmittedWithoutDeadline({ reviewDeadlineAt: timestamp(BASE_MS + 7 * DAY_MS) });

  current = '2026-01-09T00:00:00.000Z';
  const res = await employeeApi.post('/tasks/task-1/admin-review-request', {
    body: { reason: 'The employer has not reviewed for over a week' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'admin_review_requested');
  assert.equal(res.body.requestId, 'task-1_v1');

  const stored = client.readDoc('tasks', 'task-1');
  assert.equal(stored.status, 'admin_review_requested');
  assert.equal(stored.activeAdminReviewRequestId, 'task-1_v1');

  const request = client.readDoc('adminReviewRequests', 'task-1_v1');
  assert.equal(request.requestedBy, 'employee-1');
  assert.equal(request.submissionVersion, 1);
  assert.equal(request.status, 'pending');
  assert.equal(request.reason, 'The employer has not reviewed for over a week');

  const events = Object.values(client.readAll('taskReviewEvents'));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'request_admin_review');
  assert.equal(events[0].toStatus, 'admin_review_requested');

  const duplicate = await employeeApi.post('/tasks/task-1/admin-review-request', { body: {} });
  assert.equal(duplicate.status, 409);
  assert.equal(Object.keys(client.readAll('adminReviewRequests')).length, 1);
});

test('a submitted task without a review deadline fails closed instead of escalating', async () => {
  seedSubmittedWithoutDeadline();

  current = '2030-01-01T00:00:00.000Z';
  const res = await employeeApi.post('/tasks/task-1/admin-review-request', { body: {} });

  assert.equal(res.status, 409);
  assert.match(res.body.message, /has not elapsed/i);
  assert.equal(Object.keys(client.readAll('adminReviewRequests')).length, 0);
});

test('the employer cannot escalate their own task to an admin', async () => {
  seedSubmittedWithoutDeadline({ reviewDeadlineAt: timestamp(BASE_MS + 7 * DAY_MS) });

  current = '2026-01-09T00:00:00.000Z';
  const res = await employerApi.post('/tasks/task-1/admin-review-request', { body: {} });

  assert.equal(res.status, 403);
});

test('an employee can only answer when an admin review actually awaits a response', async () => {
  seedSubmittedWithoutDeadline({ reviewDeadlineAt: timestamp(BASE_MS + 7 * DAY_MS) });

  const tooEarly = await employeeApi.post('/tasks/task-1/admin-review-response', {
    body: { message: 'Here is more detail' },
  });
  assert.equal(tooEarly.status, 409);

  current = '2026-01-09T00:00:00.000Z';
  await employeeApi.post('/tasks/task-1/admin-review-request', { body: {} });

  const blank = await employeeApi.post('/tasks/task-1/admin-review-response', {
    body: { message: '   ' },
  });
  assert.equal(blank.status, 400);

  const res = await employeeApi.post('/tasks/task-1/admin-review-response', {
    body: { message: 'The employer asked for evidence I have now uploaded' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'admin_review_requested');
  assert.equal(client.readDoc('tasks', 'task-1').status, 'admin_review_requested');

  const events = Object.values(client.readAll('taskReviewEvents'));
  const response = events.find((event) => event.type === 'review_response');
  assert.equal(response.detail.message, 'The employer asked for evidence I have now uploaded');
  assert.equal(response.fromStatus, 'admin_review_requested');
  assert.equal(response.toStatus, 'admin_review_requested');
});

test('approved work cannot be escalated to an admin review request', async () => {
  seedWorld({ taskStatus: 'approved' });

  const res = await employeeApi.post('/tasks/task-1/admin-review-request', { body: {} });

  assert.equal(res.status, 409);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'approved');
});

test('a transition appends history, and history is readable by both parties', async () => {
  seedWorld();

  await employeeApi.post('/tasks/task-1/submit', { body: SUBMISSION });
  await employerApi.post('/tasks/task-1/approve', { body: {} });

  const byEmployee = await employeeApi.get('/tasks/task-1/history');
  assert.equal(byEmployee.status, 200);
  assert.equal(byEmployee.body.taskId, 'task-1');
  assert.deepEqual(
    byEmployee.body.events.map((event) => event.type),
    ['submit', 'approve']
  );
  assert.deepEqual(byEmployee.body.decisions, []);

  const byEmployer = await employerApi.get('/tasks/task-1/history');
  assert.equal(byEmployer.status, 200);
  assert.equal(byEmployer.body.events.length, 2);
});

test('a stranger cannot read the task history or escalate the task', async () => {
  seedSubmittedWithoutDeadline({ reviewDeadlineAt: timestamp(BASE_MS + 7 * DAY_MS) });
  current = '2026-01-09T00:00:00.000Z';
  const stranger = await client.authed('stranger-1');

  assert.equal((await stranger.get('/tasks/task-1/history')).status, 403);
  assert.equal((await stranger.post('/tasks/task-1/admin-review-request', { body: {} })).status, 403);
});

test('a milestone-linked task can be escalated without touching its payment record', async () => {
  seedSubmittedWithoutDeadline({
    reviewDeadlineAt: timestamp(BASE_MS + 7 * DAY_MS),
    milestoneId: 'ms-1',
  });
  client.seed('milestones', 'ms-1', milestone());
  client.seed('payments', 'ms-1', payment({ status: 'paid' }));
  const before = client.readDoc('payments', 'ms-1');

  current = '2026-01-09T00:00:00.000Z';
  const res = await employeeApi.post('/tasks/task-1/admin-review-request', { body: {} });

  assert.equal(res.status, 200);
  assert.deepEqual(client.readDoc('payments', 'ms-1'), before);
});
