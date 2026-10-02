'use strict';

/**
 * Characterization tests for server/routes/tasks.js
 *
 * This is the route the client actually calls (ViewJobApplications.jsx).
 * POST /applications/tasks is an unused duplicate and is covered in
 * applications.test.js.
 *
 * Since Stage 1 a task may only be created by the employer who owns the job,
 * and only assigned to a user who applied to that job.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, task } = require('../testing/fixtures');

let client;
let employerApi;
const now = () => '2026-01-01T00:00:00.000Z';

test.before(async () => {
  client = await startTestServer({ clock: now });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  employerApi = await client.authed('employer-1');
});

/**
 * Seeds the job the employer owns plus an application from employee-1.
 *
 * STAGE 6K: the application is seeded `accepted`. requireTaskAssignment no
 * longer treats "applied" as sufficient -- the assignee's application must be
 * accepted -- and the shared application() fixture defaults to `pending`, so
 * every POST /tasks test below that is not itself testing the guard needed this.
 */
function seedOwnerAndApplicant() {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
}

const validTask = {
  jobId: 'job-1',
  employeeId: 'employee-1',
  taskName: 'Replace washer',
  taskDescription: 'Fit a new washer on the cold tap',
  dueDate: '2026-10-01T00:00:00.000Z',
};

test('POST /tasks creates a task and returns its id', async () => {
  seedOwnerAndApplicant();

  const res = await employerApi.post('/tasks', { body: validTask });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Task created successfully');
  assert.ok(res.body.taskId);

  const stored = client.readDoc('tasks', res.body.taskId);
  assert.equal(stored.jobId, 'job-1');
  assert.equal(stored.employeeId, 'employee-1');
  assert.equal(stored.taskName, 'Replace washer');
  assert.equal(stored.taskDescription, 'Fit a new washer on the cold tap');
  assert.equal(stored.dueDate, '2026-10-01T00:00:00.000Z');
});

test('POST /tasks stamps createdDate from the fake clock as a Timestamp', async () => {
  seedOwnerAndApplicant();

  const res = await employerApi.post('/tasks', { body: validTask });

  // STAGE 5H. This used to assert `stored.createdDate instanceof Date`, which
  // encoded the fake's old stand-in and was the opposite of production: Firestore
  // converts a Date to a Timestamp on write, so the stored value has never been a
  // Date against real Firestore. It is now the same Timestamp shape that
  // `GET /users` puts on the wire, and the same one the client decodes.
  const stored = client.readDoc('tasks', res.body.taskId);

  assert.deepEqual(stored.createdDate, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.equal(stored.createdDate instanceof Date, false, 'a Timestamp is not a Date');
});

test('POST /tasks stores createdDate as the wire shape the client decodes', async () => {
  seedOwnerAndApplicant();

  const res = await employerApi.post('/tasks', { body: validTask });
  const stored = client.readDoc('tasks', res.body.taskId);

  // The literal JSON contract, asserted independently of timestampFrom so the
  // fake cannot drift away from what res.json() actually emits for a real
  // admin-SDK Timestamp (no toJSON(); only _seconds and _nanoseconds are own
  // properties). MyApplications.jsx and ViewJobApplications.jsx both decode this.
  assert.equal(JSON.stringify(stored.createdDate), '{"_seconds":1767225600,"_nanoseconds":0}');
});

test('POST /tasks takes createdDate from the fake clock, not the process clock', async () => {
  seedOwnerAndApplicant();

  const res = await employerApi.post('/tasks', { body: validTask });
  const stored = client.readDoc('tasks', res.body.taskId);

  // STAGE 5H. The value is committed through FieldValue.serverTimestamp(), so it
  // resolves against the injected clock. Had it stayed `new Date()`, it would have
  // been the real wall-clock time -- which for a fake means "not the seeded one" --
  // and would additionally have been a process-clock instant in production.
  assert.equal(stored.createdDate._seconds, Math.floor(Date.parse(now()) / 1000));
  assert.notEqual(stored.createdDate._seconds, Math.floor(Date.now() / 1000));
});

test('POST /tasks requires every field', async () => {
  seedOwnerAndApplicant();
  const fields = ['jobId', 'employeeId', 'taskName', 'taskDescription', 'dueDate'];

  for (const field of fields) {
    const body = { ...validTask };
    delete body[field];
    const res = await employerApi.post('/tasks', { body });
    assert.equal(res.status, 400, `expected 400 when ${field} is missing`);
    assert.equal(res.body.message, 'Missing required fields');
  }
});

test('POST /tasks returns 404 when the job does not exist', async () => {
  const res = await employerApi.post('/tasks', {
    body: { ...validTask, jobId: 'ghost-job' },
  });

  // Stage 1: the assignment guard checks the job exists and is owned before the
  // handler runs. Previously any jobId was accepted.
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks refuses an assignee who never applied to the job', async () => {
  seedOwnerAndApplicant();

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, employeeId: 'unrelated-person' },
  });

  assert.equal(res.status, 403);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks refuses an employer who does not own the job', async () => {
  seedOwnerAndApplicant();
  const stranger = await client.authed('attacker');

  const res = await stranger.post('/tasks', { body: validTask });

  assert.equal(res.status, 403);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks requires authentication', async () => {
  seedOwnerAndApplicant();

  const res = await client.post('/tasks', { body: validTask });

  assert.equal(res.status, 401);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks rejects a non-JSON body with a 400 from the JSON parser', async () => {
  const res = await client.post('/tasks', {
    body: 'this is not json',
    headers: { 'Content-Type': 'application/json' },
  });

  // Documents the framework-level behaviour: express.json() throws before the
  // router runs (and therefore before `protect`), and the global Jade error
  // handler renders HTML. Stage 6 replaces this handler.
  assert.equal(res.status, 400);
  assert.match(res.contentType, /text\/html/);
});

// ---------------------------------------------------------------------------
// STAGE 6B: reading tasks back.
//
// Until this stage the collection had a single write and no read path, so a task
// was unreachable after it was created. These tests pin the two reads and, more
// importantly, the authorization on them: a task is only ever visible to the
// employee it is assigned to or to the employer who owns the job.
// ---------------------------------------------------------------------------

/**
 * Seeds a job owned by employer-1, its applicant, and two tasks on that job.
 *
 * STAGE 6K: the application is `accepted` for the same reason as in
 * seedOwnerAndApplicant -- this helper is also used to create a task over the
 * API.
 */
function seedJobWithTasks() {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed('tasks', 'task-1', task({ jobId: 'job-1', employeeId: 'employee-1' }));
  client.seed(
    'tasks',
    'task-2',
    task({ jobId: 'job-1', employeeId: 'employee-2', taskName: 'Replace the upstairs tap' })
  );
}

test('GET /tasks/employee/:uid lets an employee read the tasks assigned to them', async () => {
  seedJobWithTasks();
  const employee = await client.authed('employee-1');

  const res = await employee.get('/tasks/employee/employee-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.tasks.length, 1);

  const [only] = res.body.tasks;
  assert.equal(only.id, 'task-1');
  assert.equal(only.jobId, 'job-1');
  assert.equal(only.employeeId, 'employee-1');
  assert.equal(only.taskName, 'Replace washer');
  assert.equal(only.taskDescription, 'Fit a new washer on the cold tap');
  assert.equal(only.dueDate, '2026-10-01T00:00:00.000Z');
});

test('GET /tasks/employee/:uid returns the stored document unreshaped', async () => {
  seedJobWithTasks();
  const employee = await client.authed('employee-1');

  const res = await employee.get('/tasks/employee/employee-1');
  const [only] = res.body.tasks;

  // The read adds the document id and nothing else: every stored field is
  // forwarded verbatim, including the Timestamp, which must stay the
  // {_seconds,_nanoseconds} wire shape the client decodes rather than being
  // normalised into a Date or dropped.
  const stored = client.readDoc('tasks', 'task-1');
  assert.deepEqual(only, { id: 'task-1', ...stored });
  assert.deepEqual(only.createdDate, { _seconds: 1767225600, _nanoseconds: 0 });
});

test('GET /tasks/employee/:uid refuses to show one employee another employee\'s task', async () => {
  seedJobWithTasks();
  const employee = await client.authed('employee-1');

  // employee-2's task exists on this job, so the refusal is about identity, not
  // about the query being empty.
  assert.equal(client.readDoc('tasks', 'task-2').employeeId, 'employee-2');

  const res = await employee.get('/tasks/employee/employee-2');

  // requireSelfParam compares the path parameter against the verified token.
  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'Forbidden');
  assert.equal(res.body.tasks, undefined, 'no task data may leak in a 403 body');
});

test('GET /tasks/employee/:uid scopes the result to the caller', async () => {
  seedJobWithTasks();
  const employee2 = await client.authed('employee-2');

  const res = await employee2.get('/tasks/employee/employee-2');

  assert.equal(res.status, 200);
  assert.equal(res.body.tasks.length, 1);
  assert.equal(res.body.tasks[0].id, 'task-2', 'must not receive employee-1\'s task');
});

test('GET /tasks/job/:jobId lets the job owner read the tasks they assigned', async () => {
  seedJobWithTasks();

  const res = await employerApi.get('/tasks/job/job-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.tasks.length, 2);
  assert.deepEqual(
    res.body.tasks.map((t) => t.id).sort(),
    ['task-1', 'task-2']
  );
});

test('GET /tasks/job/:jobId refuses an employer who does not own the job', async () => {
  seedJobWithTasks();
  const stranger = await client.authed('attacker');

  const res = await stranger.get('/tasks/job/job-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.tasks, undefined, 'no task data may leak in a 403 body');

  // STAGE 6T: this is a read, so the 403 must describe a read restriction. It
  // used to say "You do not have permission to modify this job", naming an edit
  // the caller never attempted -- after Stage 6S fixed the same wording on
  // GET /applications/job/:jobId, this was the last route left reporting a read
  // refusal with write wording.
  assert.equal(
    res.body.message,
    'You do not have permission to view tasks for this job'
  );
  assert.equal(res.body.message.includes('modify'), false);
});

test('GET /tasks/job/:jobId refuses the applicant, who is not the employer', async () => {
  seedJobWithTasks();
  const applicant = await client.authed('employee-1');

  // employee-1 applied to this job and is assigned a task on it, but the job's
  // tasks are the employer's view; their own tasks come from /employee/:uid.
  const res = await applicant.get('/tasks/job/job-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.tasks, undefined);
  // STAGE 6T: the assigned applicant is refused by the same read restriction and
  // so gets the same accurate message, not a different one.
  assert.equal(
    res.body.message,
    'You do not have permission to view tasks for this job'
  );
});

test('GET /tasks/job/:jobId returns 404 for a job that does not exist', async () => {
  const res = await employerApi.get('/tasks/job/ghost-job');

  // The same not-found the create path already returns, raised by the existing
  // requireJobOwner guard before the query runs.
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
});

test('GET /tasks/job/:jobId returns an empty list for a job with no tasks yet', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));

  const res = await employerApi.get('/tasks/job/job-1');

  // A missing *task* is not a missing resource: the job exists and simply has no
  // work yet, so this is an empty 200 rather than a 404.
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tasks, []);
});

test('GET /tasks/employee/:uid returns an empty list for an employee with no tasks', async () => {
  const res = await (await client.authed('employee-1')).get('/tasks/employee/employee-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.tasks, []);
});

test('GET /tasks/employee/:uid requires authentication', async () => {
  seedJobWithTasks();

  const res = await client.get('/tasks/employee/employee-1');

  // `protect` answers 401 with plain text, not JSON -- the contract it has always
  // had, so only the status is asserted here, as POST /tasks does above.
  assert.equal(res.status, 401);
});

test('GET /tasks/job/:jobId requires authentication', async () => {
  seedJobWithTasks();

  const res = await client.get('/tasks/job/job-1');

  assert.equal(res.status, 401);
});

test('the read endpoints return every task the create endpoint persisted', async () => {
  seedOwnerAndApplicant();

  const created = await employerApi.post('/tasks', { body: validTask });
  assert.equal(created.status, 200);

  // Round trip: a task written through POST /tasks is immediately readable back
  // through both reads, which is the capability Stage 6B exists to add.
  const byEmployee = await (await client.authed('employee-1')).get('/tasks/employee/employee-1');
  assert.equal(byEmployee.status, 200);
  assert.equal(byEmployee.body.tasks.length, 1);
  assert.equal(byEmployee.body.tasks[0].taskId, undefined, 'no invented field');

  const byJob = await employerApi.get('/tasks/job/job-1');
  assert.equal(byJob.status, 200);
  assert.equal(byJob.body.tasks.length, 1);
  assert.equal(byJob.body.tasks[0].id, created.body.taskId);
});
