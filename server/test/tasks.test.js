'use strict';

/**
 * Characterization tests for server/routes/tasks.js
 *
 * This is the route the client actually calls (ViewJobApplications.jsx), and since
 * Stage 9F the only standalone task-creation route: POST /applications/tasks was a duplicate
 * with no caller and is deleted, with a test here pinning that it now 404s.
 *
 * Since Stage 1 a task may only be created by the employer who owns the job,
 * and only assigned to a user who applied to that job.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startTestServer } = require('../testing/testApp');
const { job, application, task, legacyTask, employment, milestone, payment } = require('../testing/fixtures');

// STAGE 10G deliberately does NOT `require` services/taskService here, though the
// submission types would be tidier to read off its SUBMISSION_TYPES export. The test
// harness substitutes config/firebase.js in require.cache and then requires app.js, so
// anything a test file loads at the top is loaded against the REAL firebase config --
// and taskService, cached that way, is the one the running app then uses. Doing it
// breaks every read and write in the file in a way that looks like a data bug rather
// than an import-order bug. The three names are asserted literally below instead.

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
  // STAGE 10G. The sixth required field. 'text' is used throughout this file because
  // it is the type every other assertion in it assumes: a task the employee answers
  // with written work. The link and file types have their own section below.
  submissionType: 'text',
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

test('POST /tasks optionally links a task to a milestone on the same employment', async () => {
  seedOwnerAndApplicant();
  client.seed('employments', 'emp-1', employment());
  const storedMilestone = milestone();
  delete storedMilestone.taskId;
  client.seed('milestones', 'ms-1', storedMilestone);
  client.seed('payments', 'ms-1', payment({ status: 'paid' }));

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'ms-1' },
  });

  assert.equal(res.status, 200);
  const stored = client.readDoc('tasks', res.body.taskId);
  assert.equal(stored.milestoneId, 'ms-1');
});

test('POST /tasks allows several tasks to share one milestone', async () => {
  seedOwnerAndApplicant();
  client.seed('employments', 'emp-1', employment());
  const storedMilestone = milestone();
  delete storedMilestone.taskId;
  client.seed('milestones', 'ms-1', storedMilestone);
  client.seed('payments', 'ms-1', payment({ status: 'paid' }));

  const first = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'ms-1', taskName: 'Prepare walls' },
  });
  const second = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'ms-1', taskName: 'Paint walls' },
  });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(client.readDoc('tasks', first.body.taskId).milestoneId, 'ms-1');
  assert.equal(client.readDoc('tasks', second.body.taskId).milestoneId, 'ms-1');
});

test('POST /tasks refuses a milestone from another employment', async () => {
  seedOwnerAndApplicant();
  client.seed('employments', 'emp-1', employment());
  client.seed(
    'milestones',
    'ms-other',
    milestone({ contractId: 'emp-2', employmentId: 'emp-2', taskId: undefined })
  );

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'ms-other' },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /does not belong to this employment/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks refuses an unknown milestone', async () => {
  seedOwnerAndApplicant();
  client.seed('employments', 'emp-1', employment());

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'missing-milestone' },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Milestone not found');
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks refuses a milestone when the assignment has no employment', async () => {
  seedOwnerAndApplicant();
  client.seed(
    'milestones',
    'ms-1',
    milestone({ contractId: 'emp-1', employmentId: 'emp-1', taskId: undefined })
  );

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'ms-1' },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /without an employment/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

// ---------------------------------------------- Funded-milestone gate
//
// A task linked to a milestone may only be created once that specific milestone's
// payment record exists and persists with status exactly 'paid'. The record is read
// server-side from the milestone id -- never from the request body -- so a client
// cannot forge funding. Tasks without a milestone are unaffected.

/**
 * Seeds the employer, accepted application, employment and one milestone, plus a
 * payment record on that milestone when `paymentStatus` is given.
 */
function seedFundedWorld({ paymentStatus } = {}) {
  seedOwnerAndApplicant();
  client.seed('employments', 'emp-1', employment());
  const storedMilestone = milestone();
  delete storedMilestone.taskId;
  client.seed('milestones', 'ms-1', storedMilestone);
  if (paymentStatus !== undefined) {
    client.seed('payments', 'ms-1', payment({ status: paymentStatus }));
  }
  return 'ms-1';
}

test('POST /tasks rejects a milestone-linked task when no payment record exists', async () => {
  const milestoneId = seedFundedWorld();

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /paid/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks rejects a milestone-linked task when the payment is created', async () => {
  const milestoneId = seedFundedWorld({ paymentStatus: 'created' });

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /paid/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks rejects a milestone-linked task when the payment is pending', async () => {
  const milestoneId = seedFundedWorld({ paymentStatus: 'pending' });

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /paid/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks rejects a milestone-linked task when the payment is failed', async () => {
  const milestoneId = seedFundedWorld({ paymentStatus: 'failed' });

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /paid/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks rejects a milestone-linked task when the payment needs review', async () => {
  const milestoneId = seedFundedWorld({ paymentStatus: 'needs_review' });

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /paid/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('POST /tasks creates a task when the milestone payment is paid', async () => {
  const milestoneId = seedFundedWorld({ paymentStatus: 'paid' });

  const res = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId, taskName: 'Prepare walls' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Task created successfully');
  assert.ok(res.body.taskId);

  const stored = client.readDoc('tasks', res.body.taskId);
  assert.equal(stored.milestoneId, milestoneId);
  assert.equal(stored.taskName, 'Prepare walls');
});

test('POST /tasks without a milestone is unaffected by the funding gate', async () => {
  seedOwnerAndApplicant();

  const res = await employerApi.post('/tasks', { body: validTask });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('tasks', res.body.taskId).milestoneId, undefined);
});

test('POST /tasks pays for one milestone but not another', async () => {
  seedOwnerAndApplicant();
  client.seed('employments', 'emp-1', employment());

  const paidMilestone = milestone();
  delete paidMilestone.taskId;
  client.seed('milestones', 'ms-paid', paidMilestone);
  client.seed('payments', 'ms-paid', payment({ status: 'paid' }));

  const unpaidMilestone = milestone({ contractId: 'emp-1', employmentId: 'emp-1', taskId: undefined });
  delete unpaidMilestone.taskId;
  client.seed('milestones', 'ms-unpaid', unpaidMilestone);

  // Paying milestone A does not unlock milestone B.
  const onUnpaid = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'ms-unpaid', taskName: 'Work on unpaid' },
  });
  assert.equal(onUnpaid.status, 400);
  assert.match(onUnpaid.body.message, /paid/i);

  const onPaid = await employerApi.post('/tasks', {
    body: { ...validTask, milestoneId: 'ms-paid', taskName: 'Work on paid' },
  });
  assert.equal(onPaid.status, 200);
  assert.equal(client.readDoc('tasks', onPaid.body.taskId).milestoneId, 'ms-paid');

  assert.equal(Object.keys(client.readAll('tasks')).length, 1);
});

test('POST /tasks cannot be bypassed by supplying financial fields in the body', async () => {
  const milestoneId = seedFundedWorld({ paymentStatus: 'created' });

  const res = await employerApi.post('/tasks', {
    body: {
      ...validTask,
      milestoneId,
      // None of these client-supplied fields can substitute for a paid payment record.
      status: 'paid',
      amountMinor: 500000,
      commissionAmountMinor: 25000,
      currency: 'NGN',
    },
  });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /paid/i);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
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
  // STAGE 10G: submissionType joins the list, because POST /tasks refuses a task whose
  // delivery type was never chosen -- see the Stage 10G section for why it is
  // required rather than defaulted.
  const fields = ['jobId', 'employeeId', 'taskName', 'taskDescription', 'dueDate', 'submissionType'];

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

// ------------------------------------------- Stage 9B: the V1 data shape

/**
 * A complete hire: the job, employee-1's accepted application, and the employment
 * that hire created for it.
 *
 * The existing seedOwnerAndApplicant() deliberately stops short of the employment,
 * which is why it is kept as-is: the task tests above were written when an accepted
 * application and an employment were separate concerns, and several of them assert
 * nothing about either. Leaving it alone is what makes them the regression check
 * that the new fields cost those tests nothing.
 */
function seedHireWithEmployment() {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', employeeId: 'employee-1', applicationId: 'app-1' })
  );
}

test('POST /tasks writes the Stage 9B fields and leaves the six existing ones untouched', async () => {
  seedHireWithEmployment();

  const res = await employerApi.post('/tasks', { body: validTask });
  assert.equal(res.status, 200);

  const stored = client.readDoc('tasks', res.body.taskId);

  // The six pre-9B fields, byte for byte.
  assert.equal(stored.jobId, 'job-1');
  assert.equal(stored.employeeId, 'employee-1');
  assert.equal(stored.taskName, 'Replace washer');
  assert.equal(stored.taskDescription, 'Fit a new washer on the cold tap');
  assert.equal(stored.dueDate, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(stored.createdDate, { _seconds: 1767225600, _nanoseconds: 0 });

  // The three new ones. `status` is the only one the server decides outright; the
  // other two are recorded, never accepted from the client -- no test body here
  // sends either, and both still come out right.
  assert.equal(stored.status, 'assigned');
  assert.equal(stored.applicationId, 'app-1');
  assert.equal(stored.employmentId, 'emp-1');

  // Nothing else was added, so the shape is exactly the old six plus four.
  // STAGE 10G adds the sixth create field to that list; it is the only 10G field on a
  // task that has never been submitted.
  assert.deepEqual(
    Object.keys(stored).sort(),
    ['applicationId', 'createdDate', 'dueDate', 'employeeId', 'employmentId', 'jobId', 'status', 'submissionType', 'taskDescription', 'taskName'].sort()
  );
  assert.equal(stored.submissionType, 'text');
});

test('POST /tasks ignores any application or employment id in the request body', async () => {
  seedHireWithEmployment();

  const res = await employerApi.post('/tasks', {
    body: {
      ...validTask,
      // A client cannot choose the relationship it is assigned under. requireTaskAssignment
      // resolves both ids from the accepted application, so these are discarded rather
      // than validated-and-rejected: the request succeeds and stores the real ids.
      applicationId: 'app-attacker',
      employmentId: 'emp-attacker',
      status: 'approved',
    },
  });

  assert.equal(res.status, 200);
  const stored = client.readDoc('tasks', res.body.taskId);
  assert.equal(stored.applicationId, 'app-1');
  assert.equal(stored.employmentId, 'emp-1');
  assert.equal(stored.status, 'assigned', 'a client cannot pre-approve its own task');
});

test('POST /tasks records the accepted application, not another application from the same employee', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  // Legacy data can contain more than one application for the same
  // (jobId, employeeId) from before the duplicate guard. The older one was
  // rejected and the newer one accepted, so the task must follow the accepted
  // record rather than assume the pair is unique.
  client.seed(
    'applications',
    'app-old',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'rejected', dateApplied: new Date('2026-08-01T00:00:00.000Z') })
  );
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted', dateApplied: new Date('2026-09-02T10:00:00.000Z') })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', employeeId: 'employee-1', applicationId: 'app-1' })
  );

  const res = await employerApi.post('/tasks', { body: validTask });

  assert.equal(res.status, 200);
  const stored = client.readDoc('tasks', res.body.taskId);
  assert.equal(stored.applicationId, 'app-1', 'the rejected application is not the hire');
  assert.equal(stored.employmentId, 'emp-1');
});

test('POST /tasks records the most recent accepted application when the employee holds two', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  // Two accepted applications for one employee on one job means two employments:
  // Stage 7H-2 dedupes per applicationId, not per (jobId, employeeId) pair. This is
  // the ambiguity the guard has to resolve rather than take snapshot order.
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted', dateApplied: new Date('2026-08-01T00:00:00.000Z') })
  );
  client.seed(
    'applications',
    'app-2',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted', dateApplied: new Date('2026-09-02T10:00:00.000Z') })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', employeeId: 'employee-1', applicationId: 'app-1' })
  );
  client.seed(
    'employments',
    'emp-2',
    employment({ jobId: 'job-1', employeeId: 'employee-1', applicationId: 'app-2' })
  );

  const res = await employerApi.post('/tasks', { body: validTask });

  const stored = client.readDoc('tasks', res.body.taskId);
  assert.equal(stored.applicationId, 'app-2', 'the later hire is the current engagement');
  assert.equal(stored.employmentId, 'emp-2', 'and its employment, not the earlier one');
});

test('POST /tasks writes employmentId null when the accepted application has no employment', async () => {
  // An application can be `accepted` with no employment document -- a failed hire
  // write, or a document predating Stage 7A. The task is still created, because the
  // accepted application is what authorizes the assignment and refusing here would
  // break a hire that otherwise works.
  seedOwnerAndApplicant();

  const res = await employerApi.post('/tasks', { body: validTask });

  assert.equal(res.status, 200);
  const stored = client.readDoc('tasks', res.body.taskId);
  assert.equal(stored.status, 'assigned');
  assert.equal(stored.applicationId, 'app-1');
  assert.equal(stored.employmentId, null);
  assert.ok(
    'employmentId' in stored,
    'written as null rather than omitted, so the key still marks a post-9B task'
  );
});

test('POST /applications/tasks is gone: the duplicate route no longer exists', async () => {
  // STAGE 9F. This file previously held two tests asserting that the duplicate
  // produced the same document as POST /tasks, plus a third set in
  // applications.test.js. Those are deleted with the route, since what they asserted
  // no longer exists. This replaces them with the one fact that still matters: the
  // path is no longer registered, so a client that calls it gets a 404 rather than a
  // second way to create a task.
  //
  // The body is a complete, valid one that the removed route would have accepted --
  // job owner, accepted applicant and all -- so this cannot pass by accident through
  // an authorization refusal. Only the absence of the route produces a 404 here.
  seedHireWithEmployment();

  const res = await employerApi.post('/applications/tasks', { body: validTask });

  assert.equal(res.status, 404);
  assert.equal(
    Object.keys(client.readAll('tasks')).length,
    0,
    'no task was written by the removed path'
  );

  // POST /tasks is unaffected and is now the only way in.
  const canonical = await employerApi.post('/tasks', { body: validTask });
  assert.equal(canonical.status, 200);
  assert.equal(Object.keys(client.readAll('tasks')).length, 1);
});

test('a task written before Stage 9B reads back as assigned', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());

  const employee = await client.authed('employee-1');
  const byEmployee = await employee.get('/tasks/employee/employee-1');
  assert.equal(byEmployee.status, 200);

  const [only] = byEmployee.body.tasks;
  assert.equal(only.status, 'assigned', 'a task with no status is an assigned task');

  const byJob = await employerApi.get('/tasks/job/job-1');
  assert.equal(byJob.status, 200);
  assert.equal(byJob.body.tasks[0].status, 'assigned', 'both reads derive it');
});

test('reading a legacy task does not rewrite it', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());

  const before = client.readDoc('tasks', 'task-legacy');
  assert.equal('status' in before, false, 'seeded without a status to begin with');

  await (await client.authed('employee-1')).get('/tasks/employee/employee-1');
  await employerApi.get('/tasks/job/job-1');

  // No migration, no backfill, no rewrite-on-read: the derived value is a response
  // concern only. A write here would mean the next stage needed a migration for
  // documents this stage could have left alone.
  assert.deepEqual(client.readDoc('tasks', 'task-legacy'), before);
  assert.equal('status' in client.readDoc('tasks', 'task-legacy'), false);
});

test('a legacy task keeps every field it was stored with', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());

  const res = await employerApi.get('/tasks/job/job-1');
  const [only] = res.body.tasks;

  // `status` is the only addition. Nothing is invented, and nothing is invented as
  // null either -- applicationId and employmentId are absent, not null, because
  // these documents were written before either field existed.
  assert.equal(only.id, 'task-legacy');
  assert.equal(only.jobId, 'job-1');
  assert.equal(only.employeeId, 'employee-1');
  assert.equal(only.taskName, 'Replace washer');
  assert.equal(only.taskDescription, 'Fit a new washer on the cold tap');
  assert.equal(only.dueDate, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(only.createdDate, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.equal('applicationId' in only, false);
  assert.equal('employmentId' in only, false);
  assert.equal(only.status, 'assigned');
});

test('the reads return legacy and new documents side by side', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());
  client.seed('tasks', 'task-new', task({ applicationId: 'app-1', employmentId: 'emp-1' }));

  const employee = await client.authed('employee-1');
  const byEmployee = await employee.get('/tasks/employee/employee-1');
  assert.equal(byEmployee.body.tasks.length, 2);

  const byId = Object.fromEntries(byEmployee.body.tasks.map((t) => [t.id, t]));

  // The new document is still forwarded verbatim -- the derivation must not touch a
  // document that already carries a status, or the two shapes would converge and
  // the legacy path would stop being testable.
  assert.deepEqual(byId['task-new'], { id: 'task-new', ...client.readDoc('tasks', 'task-new') });
  assert.equal(byId['task-new'].status, 'assigned');
  assert.equal(byId['task-new'].employmentId, 'emp-1');

  assert.equal(byId['task-legacy'].status, 'assigned');
  assert.equal('employmentId' in byId['task-legacy'], false);

  const byJob = await employerApi.get('/tasks/job/job-1');
  assert.equal(byJob.body.tasks.length, 2);
  for (const t of byJob.body.tasks) {
    assert.equal(t.status, 'assigned');
  }
});

test('an unknown status is forwarded rather than rewritten', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  // Stage 5G's decision applied to tasks: the reads derive a *missing* status and
  // leave an unrecognised one alone. Nothing validates a status in Stage 9B, so
  // this is only reachable by seeding, but coercing it here would silently discard
  // whatever wrote it.
  client.seed('tasks', 'task-weird', task({ status: 'submitted' }));

  const res = await employerApi.get('/tasks/job/job-1');

  assert.equal(res.body.tasks[0].status, 'submitted');
});

// ------------------------------------------- Stage 9C: the task lifecycle
//
// `assigned -> submitted -> approved`, with `submitted -> revision_requested ->
// submitted` for work sent back, and `approved` terminal. Every authorization
// decision below is made by requireTaskParty from the task's stored
// `employmentId`, so these tests seed a complete hire: job, accepted application,
// employment, and a task that points at all three.

// STAGE 10G: a text task is answered with `submissionText`, which is what submitTask
// reads for a task stored as `text` -- and every task seeded by seedWorkflow is one,
// because the fixture stores 'text'. `submittedBody` is no longer a field any write
// path accepts; the tests below that assert on it are asserting that it is GONE.
const SUBMISSION = { submissionText: 'Replaced the washer and tested for leaks' };
const REVISION = { revisionNote: 'The isolation valve is still dripping' };

/**
 * A complete hire plus one task on it.
 *
 * `taskStatus` defaults to `assigned` because that is what a create writes and what
 * every pre-9B document holds. Tests that need a task the employer can act on pass
 * 'submitted' rather than driving it there, so each transition assertion starts from
 * a known state instead of depending on the transition before it having worked.
 *
 * `employmentId: null` on a task, and `legacyTask()` for a pre-9B document, are the
 * two ways a task can lack the linkage the guard authorizes through; the tests for
 * those pass them explicitly.
 */
function seedWorkflow({ taskStatus = 'assigned', taskOverrides = {}, employmentOverrides = {} } = {}) {
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
      ...employmentOverrides,
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

const asEmployee = () => client.authed('employee-1');

// ---------------------------------------------- authorization

test('the employee may read and submit their own task', async () => {
  seedWorkflow();
  const employee = await asEmployee();

  const read = await employee.get('/tasks/task-1');
  assert.equal(read.status, 200);
  assert.equal(read.body.task.id, 'task-1');
  assert.equal(read.body.task.taskName, 'Replace washer');

  const res = await employee.post('/tasks/task-1/submit', { body: SUBMISSION });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');
  assert.equal(res.body.taskId, 'task-1');
});

test('the employee may not approve their own task', async () => {
  seedWorkflow({ taskStatus: 'submitted' });
  const employee = await asEmployee();

  const res = await employee.post('/tasks/task-1/approve', { body: {} });

  // requireTaskParty admits the employee as a party and then the role rule refuses:
  // the guard is not "is this your task", it is "is this your task to do this to".
  assert.equal(res.status, 403);
  assert.match(res.body.message, /permission/);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted');
});

test('the employee may not request a revision of their own task', async () => {
  seedWorkflow({ taskStatus: 'submitted' });
  const employee = await asEmployee();

  const res = await employee.post('/tasks/task-1/request-revision', { body: REVISION });

  assert.equal(res.status, 403);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted');
});

test('the employer may approve submitted work', async () => {
  seedWorkflow({ taskStatus: 'submitted' });

  const res = await employerApi.post('/tasks/task-1/approve', { body: {} });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(client.readDoc('tasks', 'task-1').status, 'approved');
});

test('the employer may request a revision', async () => {
  seedWorkflow({ taskStatus: 'submitted' });

  const res = await employerApi.post('/tasks/task-1/request-revision', { body: REVISION });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'revision_requested');
  assert.equal(client.readDoc('tasks', 'task-1').status, 'revision_requested');
});

test('the employer may not submit on the employee\'s behalf', async () => {
  seedWorkflow();
  const employer = await employerApi;

  const res = await employer.post('/tasks/task-1/submit', { body: SUBMISSION });

  // Submitting is the employee's declaration that the work is done. An employer
  // performing it would make the whole approval step unverifiable.
  assert.equal(res.status, 403);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
});

test('an unrelated authenticated user can neither read nor act on the task', async () => {
  seedWorkflow();
  const stranger = await client.authed('stranger-1');

  for (const [method, path, body] of [
    ['get', '/tasks/task-1', undefined],
    ['post', '/tasks/task-1/submit', SUBMISSION],
    ['post', '/tasks/task-1/approve', {}],
    ['post', '/tasks/task-1/request-revision', REVISION],
  ]) {
    const res = await stranger[method](path, body ? { body } : undefined);
    assert.equal(res.status, 403, `${method.toUpperCase()} ${path} must be refused`);
    assert.match(res.body.message, /permission/);
    assert.equal(res.body.task, undefined, 'no task data may leak in a 403 body');
  }

  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
});

test('the job owner is refused when they are not the employment employer', async () => {
  // The distinction Stage 9B stored employmentId for: employer-2 posted the job, so
  // job.postedBy says they may see work on it, while the employment says the work
  // was hired by employer-1. The employment wins, or the jobId field would be the
  // authority and employmentId would be decorative.
  seedWorkflow({
    taskStatus: 'submitted',
    employmentOverrides: { employerId: 'employer-1' },
  });
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-2' }));

  const jobOwner = await client.authed('employer-2');

  // The job owner can still reach the task through the endpoint that authorizes on
  // the job, which is the pre-existing list behaviour and is unchanged.
  const viaJob = await jobOwner.get('/tasks/job/job-1');
  assert.equal(viaJob.status, 200, 'list reads still authorize on the job');

  // ...but not through the workflow.
  for (const [path, body] of [
    ['/tasks/task-1/approve', {}],
    ['/tasks/task-1/request-revision', REVISION],
    ['/tasks/task-1/submit', SUBMISSION],
  ]) {
    const res = await jobOwner.post(path, { body });
    assert.equal(res.status, 403, `${path} must be refused`);
  }

  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted');
});

test('a lifecycle mutation without a token is 401', async () => {
  seedWorkflow();

  for (const [path, body] of [
    ['/tasks/task-1/submit', SUBMISSION],
    ['/tasks/task-1/approve', {}],
    ['/tasks/task-1/request-revision', REVISION],
  ]) {
    const res = await client.post(path, { body });
    assert.equal(res.status, 401, `${path} must require a token`);
  }

  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
});

test('an unknown task is a 404, not a 500', async () => {
  seedWorkflow();
  const employee = await asEmployee();

  const read = await employee.get('/tasks/no-such-task');
  assert.equal(read.status, 404);
  assert.equal(read.body.message, 'Task not found');

  for (const [path, body] of [
    ['/tasks/no-such-task/submit', SUBMISSION],
    ['/tasks/no-such-task/approve', {}],
    ['/tasks/no-such-task/request-revision', REVISION],
  ]) {
    const res = await employee.post(path, { body });
    assert.equal(res.status, 404, `${path} must be a 404`);
    assert.equal(res.body.message, 'Task not found');
  }
});

// ---------------------------------------------- legal transitions

test('assigned -> submitted', async () => {
  seedWorkflow({ taskStatus: 'assigned' });

  const res = await (await asEmployee()).post('/tasks/task-1/submit', { body: SUBMISSION });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');
  assert.equal(res.body.message, 'Task submitted successfully');
  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted');
});

test('submitted -> approved', async () => {
  seedWorkflow({ taskStatus: 'submitted' });

  const res = await employerApi.post('/tasks/task-1/approve', { body: {} });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'approved');
  assert.equal(client.readDoc('tasks', 'task-1').status, 'approved');
});

test('submitted -> revision_requested', async () => {
  seedWorkflow({ taskStatus: 'submitted' });

  const res = await employerApi.post('/tasks/task-1/request-revision', { body: REVISION });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'revision_requested');
  assert.equal(client.readDoc('tasks', 'task-1').status, 'revision_requested');
});

test('revision_requested -> submitted, and a task can be sent back more than once', async () => {
  seedWorkflow({ taskStatus: 'revision_requested' });

  const res = await (await asEmployee()).post('/tasks/task-1/submit', { body: SUBMISSION });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted');
});

test('a legacy task with no status can still be submitted', async () => {
  // Stage 9B reads a missing status as `assigned`, and the transition table has to
  // agree or every task already in the database would be frozen.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', employerId: 'employer-1', employeeId: 'employee-1', applicationId: 'app-1' })
  );
  // Spreading rather than passing employmentId into legacyTask(): that builder
  // strips all three Stage 9B fields to model a pre-9B document, so it would strip
  // this one too and leave a task with no employment to authorize through. This is
  // the shape that matters here -- no status, but employment-linked -- and it is
  // reachable for real: employmentId could have been backfilled without status.
  client.seed('tasks', 'task-legacy', { ...legacyTask(), employmentId: 'emp-1' });

  const res = await (await asEmployee()).post('/tasks/task-legacy/submit', { body: SUBMISSION });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');
});

// ---------------------------------------------- refused transitions

const illegalTransition = async (taskStatus, path, body) => {
  seedWorkflow({ taskStatus });
  const actor = path.includes('submit') ? await asEmployee() : await client.authed('employer-1');
  const res = await actor.post(path, { body });
  return res;
};

test('assigned -> approved is refused: work cannot be approved before it is delivered', async () => {
  const res = await illegalTransition('assigned', '/tasks/task-1/approve', {});

  assert.equal(res.status, 400);
  assert.match(res.body.message, /approve/);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');
});

test('assigned -> revision_requested is refused: there is nothing submitted to send back', async () => {
  const res = await illegalTransition('assigned', '/tasks/task-1/request-revision', REVISION);

  assert.equal(res.status, 400);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
});

test('revision_requested -> approved is refused: the employee must submit again first', async () => {
  const res = await illegalTransition('revision_requested', '/tasks/task-1/approve', {});

  assert.equal(res.status, 400);
  assert.match(res.body.message, /approve/);
  assert.match(res.body.message, /revision_requested/, 'the message names the current status');
  assert.equal(client.readDoc('tasks', 'task-1').status, 'revision_requested');
});

test('approved is terminal: nothing can move a task out of it', async () => {
  for (const [path, body] of [
    ['/tasks/task-1/submit', SUBMISSION],
    ['/tasks/task-1/approve', {}],
    ['/tasks/task-1/request-revision', REVISION],
  ]) {
    const res = await illegalTransition('approved', path, body);
    assert.equal(res.status, 400, `${path} must be refused on an approved task`);
    assert.match(res.body.message, /approved/);
  }

  assert.equal(client.readDoc('tasks', 'task-1').status, 'approved');
});

test('an unknown status is refused rather than guessed at', async () => {
  const res = await illegalTransition('in_progress', '/tasks/task-1/submit', SUBMISSION);

  // Not "cannot submit a task that is 'in_progress'" -- that would imply the value
  // was understood and merely out of order. It is reported as unknown, which is the
  // difference between a document from a future stage and a bug.
  assert.equal(res.status, 400);
  assert.match(res.body.message, /unknown status/);
  assert.match(res.body.message, /in_progress/);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'in_progress');
});

test('submit and request-revision both require their text', async () => {
  seedWorkflow();
  const employee = await asEmployee();
  const employer = await client.authed('employer-1');

  // STAGE 10G: `submissionText` is the field a text task is answered with. The
  // pre-10G field name is in this list deliberately -- a body carrying only
  // `submittedBody` is refused exactly like an empty one, which is what proves the
  // old field is read but never written rather than quietly still accepted.
  for (const body of [
    {},
    { submissionText: '' },
    { submissionText: '   ' },
    { submissionText: 42 },
    { submittedBody: 'Replaced the washer' },
  ]) {
    const res = await employee.post('/tasks/task-1/submit', { body });
    assert.equal(res.status, 400, `submit must refuse ${JSON.stringify(body)}`);
    assert.equal(res.body.message, 'Missing required fields');
  }

  seedWorkflow({ taskStatus: 'submitted' });
  for (const body of [{}, { revisionNote: '' }, { revisionNote: '  ' }]) {
    const res = await employer.post('/tasks/task-1/request-revision', { body });
    assert.equal(res.status, 400, `revision must refuse ${JSON.stringify(body)}`);
  }

  assert.equal(client.readDoc('tasks', 'task-1').status, 'submitted', 'no write on a refused body');
});

// ---------------------------------------------- employment lifecycle

test('an ended employment still allows both parties to read the task', async () => {
  seedWorkflow({ taskStatus: 'submitted', employmentOverrides: { status: 'ended', endDate: '2026-09-30' } });

  const employeeRead = await (await asEmployee()).get('/tasks/task-1');
  assert.equal(employeeRead.status, 200);
  assert.equal(employeeRead.body.task.status, 'submitted');

  const employerRead = await employerApi.get('/tasks/task-1');
  assert.equal(employerRead.status, 200);
  assert.equal(employerRead.body.task.id, 'task-1');
});

test('an ended employment blocks submit, approve and request-revision', async () => {
  for (const [taskStatus, path, body] of [
    ['assigned', '/tasks/task-1/submit', SUBMISSION],
    ['submitted', '/tasks/task-1/approve', {}],
    ['submitted', '/tasks/task-1/request-revision', REVISION],
  ]) {
    seedWorkflow({ taskStatus, employmentOverrides: { status: 'ended', endDate: '2026-09-30' } });

    const actor = path.includes('submit') ? await asEmployee() : await client.authed('employer-1');
    const res = await actor.post(path, { body });

    assert.equal(res.status, 403, `${path} must be refused on an ended employment`);
    assert.match(res.body.message, /ended/);
    assert.equal(
      client.readDoc('tasks', 'task-1').status,
      taskStatus,
      'ending an employment must not change the task'
    );
  }
});

test('an employment with an unrecognised status is treated as ended', async () => {
  // Fail-closed. A status this API has never written, or a document missing the
  // field entirely, can only remove permission -- never grant it.
  for (const overrides of [{ status: undefined }, { status: 'finished' }]) {
    seedWorkflow({ taskStatus: 'submitted', employmentOverrides: overrides });

    const blocked = await employerApi.post('/tasks/task-1/approve', { body: {} });
    assert.equal(blocked.status, 403, `${JSON.stringify(overrides)} must not authorize`);

    // Reading is still allowed: an unreadable status is not a reason to hide a task
    // from the two people who are party to it.
    const read = await employerApi.get('/tasks/task-1');
    assert.equal(read.status, 200);
  }
});

// ---------------------------------------------- legacy / unlinked tasks

test('a task with no employment linkage stays readable by both of its old parties', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());
  client.seed('tasks', 'task-null', task({ employmentId: null }));

  // The assignee, for both shapes.
  const employee = await asEmployee();
  for (const id of ['task-legacy', 'task-null']) {
    const res = await employee.get(`/tasks/${id}`);
    assert.equal(res.status, 200, `${id} must stay readable by the assignee`);
    assert.equal(res.body.task.status, 'assigned');
  }

  // The job owner, which is the only employer a pre-9B task can name.
  for (const id of ['task-legacy', 'task-null']) {
    const res = await employerApi.get(`/tasks/${id}`);
    assert.equal(res.status, 200, `${id} must stay readable by the job owner`);
  }

  // And still not by a stranger.
  const stranger = await client.authed('stranger-1');
  assert.equal((await stranger.get('/tasks/task-legacy')).status, 403);
});

test('a task with no employment linkage cannot be transitioned', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());
  client.seed('tasks', 'task-null', task({ employmentId: null }));

  const employee = await asEmployee();
  const employer = await client.authed('employer-1');

  for (const id of ['task-legacy', 'task-null']) {
    // Even the job owner, who is authorized to read it and to have created it, is
    // refused: there is no employment, so there is no record of who the parties to
    // this work are, and the job relationship is not offered as a stand-in.
    for (const [actor, path, body] of [
      [employee, `/tasks/${id}/submit`, SUBMISSION],
      [employer, `/tasks/${id}/approve`, {}],
      [employer, `/tasks/${id}/request-revision`, REVISION],
    ]) {
      const res = await actor.post(path, { body });
      assert.equal(res.status, 403, `${path} must be refused for ${id}`);
      assert.match(res.body.message, /not linked to an employment/);
    }
  }

  assert.equal(client.readDoc('tasks', 'task-legacy').status, undefined, 'a legacy task is not quietly promoted');
  assert.equal(client.readDoc('tasks', 'task-null').status, 'assigned', 'nor is a null-employmentId one');
});

test('a task whose employment document has gone missing cannot be transitioned', async () => {
  // employmentId points at a document that is not there. Stage 9B only writes a
  // non-null employmentId for one that existed and named this job and this employee,
  // so this is drift rather than a normal state. It is treated like an unlinked task
  // rather than trusted: there is nothing left that could establish who the parties
  // are, and inferring them from the job would be the substitute this guard refuses.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-1', task({ employmentId: 'emp-deleted' }));

  const employee = await asEmployee();
  const employer = await client.authed('employer-1');

  for (const [actor, path, body] of [
    [employee, '/tasks/task-1/submit', SUBMISSION],
    [employer, '/tasks/task-1/approve', {}],
  ]) {
    const res = await actor.post(path, { body });
    assert.equal(res.status, 403, `${path} must be refused`);
    assert.match(res.body.message, /could not be found/);
  }

  // The job owner cannot read it either -- with no employment there is no record of
  // who the parties are, so even the read fallback has nothing to fall back to.
  const read = await employer.get('/tasks/task-1');
  assert.equal(read.status, 403);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
});

// ---------------------------------------------- integrity

test('a submit writes the submission fields and nothing else', async () => {
  seedWorkflow();

  const before = client.readDoc('tasks', 'task-1');
  await (await asEmployee()).post('/tasks/task-1/submit', { body: SUBMISSION });
  const after = client.readDoc('tasks', 'task-1');

  const added = Object.keys(after).filter((k) => !(k in before));
  // STAGE 10G: `submissionText` replaces `submittedBody` for a text task, and only
  // that one of the three submission fields appears. The two assertions below it are
  // the point of the whole stage: a link or a file reference cannot end up on a text
  // task, and the legacy field is not written alongside the new one.
  //
  // STAGE 1 adds exactly two fields to a submit: the review deadline that starts when
  // the work arrives, and the version that names this submission (and therefore the
  // admin-review request id for it). Neither is optional -- a submission without a
  // deadline could never be reviewed on time, and a submission without a version
  // could not tell two deliveries apart.
  assert.deepEqual(added.sort(), ['reviewDeadlineAt', 'submissionText', 'submissionVersion', 'submittedAt']);
  assert.equal('submittedBody' in after, false, 'the pre-10G field is not written any more');
  assert.equal('submissionUrl' in after, false, 'a text task stores no url');
  assert.equal('submissionFile' in after, false, 'a text task stores no file');

  // Every pre-existing field except `status` must be byte-identical afterwards --
  // taskName, taskDescription, dueDate, jobId, employeeId, applicationId,
  // employmentId, submissionType and createdDate. Compared with deepEqual rather than
  // `!==`, because readDoc hands back a fresh clone each call, so two structurally
  // equal timestamps are never the same object.
  for (const field of Object.keys(before)) {
    if (field === 'status') continue;
    assert.deepEqual(after[field], before[field], `${field} must be untouched`);
  }

  assert.equal(after.status, 'submitted');
  assert.equal(after.submissionText, SUBMISSION.submissionText);
  assert.deepEqual(after.submittedAt, { _seconds: 1767225600, _nanoseconds: 0 });
});

test('an approve stamps reviewedAt and nothing else', async () => {
  seedWorkflow({ taskStatus: 'submitted' });

  const before = client.readDoc('tasks', 'task-1');
  await employerApi.post('/tasks/task-1/approve', { body: {} });
  const after = client.readDoc('tasks', 'task-1');

  assert.deepEqual(
    Object.keys(after).filter((k) => !(k in before)),
    ['reviewedAt']
  );
  assert.deepEqual(after.reviewedAt, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.equal(after.status, 'approved');
  assert.equal('submittedBody' in after, false, 'approval does not invent a submission');
  assert.deepEqual(after.submittedAt, before.submittedAt, 'and does not restamp one');
});

test('a request-revision records the note and stamps reviewedAt', async () => {
  seedWorkflow({ taskStatus: 'submitted' });

  await employerApi.post('/tasks/task-1/request-revision', { body: REVISION });
  const after = client.readDoc('tasks', 'task-1');

  assert.equal(after.status, 'revision_requested');
  assert.equal(after.revisionNote, REVISION.revisionNote);
  assert.deepEqual(after.reviewedAt, { _seconds: 1767225600, _nanoseconds: 0 });
});

test('re-submitting after a revision replaces the previous submission', async () => {
  // If both bodies survived, the employer would be reviewing the union of two
  // attempts with no way to tell which text is current.
  seedWorkflow({ taskStatus: 'submitted' });
  await employerApi.post('/tasks/task-1/request-revision', { body: REVISION });
  await (await asEmployee()).post('/tasks/task-1/submit', {
    body: { submissionText: 'Second attempt, valve replaced' },
  });

  const after = client.readDoc('tasks', 'task-1');

  assert.equal(after.status, 'submitted');
  assert.equal(after.submissionText, 'Second attempt, valve replaced');
  assert.equal(after.revisionNote, REVISION.revisionNote, 'the note that prompted the resubmission is kept');
});

test('the whole assigned -> submitted -> approved path works end to end', async () => {
  seedWorkflow();
  const employee = await asEmployee();
  const employer = await client.authed('employer-1');

  const submitted = await employee.post('/tasks/task-1/submit', { body: SUBMISSION });
  assert.equal(submitted.body.status, 'submitted');

  const sentBack = await employer.post('/tasks/task-1/request-revision', { body: REVISION });
  assert.equal(sentBack.body.status, 'revision_requested');

  const resubmitted = await employee.post('/tasks/task-1/submit', {
    body: { submissionText: 'Second attempt' },
  });
  assert.equal(resubmitted.body.status, 'submitted');

  const approved = await employer.post('/tasks/task-1/approve', { body: {} });
  assert.equal(approved.body.status, 'approved');

  // Terminal, and the document is still readable by both parties afterwards.
  assert.equal((await employee.post('/tasks/task-1/submit', { body: SUBMISSION })).status, 400);

  const read = await employerApi.get('/tasks/task-1');
  assert.equal(read.status, 200);
  assert.equal(read.body.task.status, 'approved');
  assert.equal(read.body.task.submissionText, 'Second attempt');
});

test('the list endpoints are unchanged by the lifecycle', async () => {
  seedWorkflow({ taskStatus: 'submitted' });
  await employerApi.post('/tasks/task-1/approve', { body: {} });

  const employee = await asEmployee();

  const byEmployee = await employee.get('/tasks/employee/employee-1');
  assert.equal(byEmployee.status, 200);
  assert.equal(byEmployee.body.tasks.length, 1);
  assert.equal(byEmployee.body.tasks[0].status, 'approved');

  const byJob = await employerApi.get('/tasks/job/job-1');
  assert.equal(byJob.status, 200);
  assert.equal(byJob.body.tasks[0].id, 'task-1');
  assert.equal(byJob.body.tasks[0].status, 'approved');
});

// ------------------------------------------- Stage 10G: submission types
//
// `assigned -> submitted -> approved` is unchanged, and so is every authorization
// decision above: this stage decides WHICH field a submission must carry, not who may
// make it. What is new is that a task's stored `submissionType` is authoritative, so
// each of these tests is really asking one question -- does the payload match what
// this task was configured to accept?

const LINK_SUBMISSION = { submissionUrl: 'https://github.com/employee-1/washer-evidence' };

/**
 * A file reference in the shape Stage 10G.1 stores it: exactly the four fields
 * buildFileSubmission keeps from what a Cloudinary upload returns.
 *
 * `publicId` is `taskSubmissions/{taskId}/{timestamp}-{random}` -- the prefix the
 * server-side validation requires and the name signTaskSubmissionUpload mints. The url
 * is that id's delivery url, carrying the `/raw/upload/` segment an upload returns for
 * a raw asset. Nothing here is fetched: the API checks the shape of a reference, not
 * that an asset exists, and the two fields must agree (check 3 in buildFileSubmission).
 */
const fileReference = (taskId, name = 'evidence.png') => {
  const publicId = `taskSubmissions/${taskId}/1735689600000-abc123`;
  return {
    url: `https://res.cloudinary.com/demo/raw/upload/v1735689600000/${publicId}`,
    publicId,
    name,
    resourceType: 'raw',
  };
};

test('POST /tasks stores each of the three submission types', async () => {
  // The three names, asserted literally. taskService holds the same list, and the
  // refusal test below pins its error message to that exact string, so the two cannot
  // drift apart without a test failing.
  const submissionTypes = ['text', 'link', 'file'];

  // seedHireWithEmployment() seeds the same three ids every pass, so each iteration
  // re-establishes the hire rather than adding to it, and the three tasks it creates
  // are all still on the collection afterwards.
  for (const submissionType of submissionTypes) {
    seedHireWithEmployment();

    const res = await employerApi.post('/tasks', { body: { ...validTask, submissionType } });

    assert.equal(res.status, 200, `${submissionType} must be accepted`);
    assert.equal(client.readDoc('tasks', res.body.taskId).submissionType, submissionType);
  }

  assert.equal(Object.keys(client.readAll('tasks')).length, submissionTypes.length);
});

test('POST /tasks refuses a submission type this API does not have', async () => {
  seedHireWithEmployment();

  // A type that was not chosen at all is a missing field; a type that was chosen wrong
  // gets the list. createTask checks them in that order and the two answers are
  // different on purpose.
  for (const submissionType of ['', null, undefined, false]) {
    const res = await employerApi.post('/tasks', { body: { ...validTask, submissionType } });

    assert.equal(res.status, 400, `${JSON.stringify(submissionType)} must be refused`);
    assert.equal(res.body.message, 'Missing required fields');
  }

  for (const submissionType of ['attachment', 'TEXT', ' text', 42, ['text'], { type: 'text' }]) {
    const res = await employerApi.post('/tasks', { body: { ...validTask, submissionType } });

    // The answer names the three valid values, because an employer who posts
    // 'attachment' needs to know what the field accepts, not that a field is missing.
    assert.equal(res.status, 400, `${JSON.stringify(submissionType)} must be refused`);
    assert.equal(res.body.message, 'submissionType must be one of: text, link, file');
  }

  assert.equal(Object.keys(client.readAll('tasks')).length, 0, 'nothing is written');
});

test('a task written before Stage 10G reads back as a text task', async () => {
  // No migration, no backfill: the value is derived on the response, exactly as
  // `assigned` has been derived for a pre-9B task since Stage 9B.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());
  assert.equal('submissionType' in client.readDoc('tasks', 'task-legacy'), false);

  const employee = await asEmployee();
  const byId = await employee.get('/tasks/task-legacy');
  assert.equal(byId.status, 200);
  assert.equal(byId.body.task.submissionType, 'text');

  const byEmployee = await employee.get('/tasks/employee/employee-1');
  assert.equal(byEmployee.body.tasks[0].submissionType, 'text');

  const byJob = await employerApi.get('/tasks/job/job-1');
  assert.equal(byJob.body.tasks[0].submissionType, 'text', 'both lists derive it');
});

test('reading a legacy task does not give it a submissionType', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('tasks', 'task-legacy', legacyTask());

  const before = client.readDoc('tasks', 'task-legacy');
  await (await asEmployee()).get('/tasks/task-legacy');
  await (await asEmployee()).get('/tasks/employee/employee-1');
  await employerApi.get('/tasks/job/job-1');

  assert.deepEqual(client.readDoc('tasks', 'task-legacy'), before);
  assert.equal('submissionType' in client.readDoc('tasks', 'task-legacy'), false);
});

test('a legacy task is still submitted with text, and keeps working after approval', async () => {
  // The whole point of reading a missing type as `text`: a task in the database from
  // before this stage must remain deliverable, not frozen.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  client.seed(
    'employments',
    'emp-1',
    employment({ jobId: 'job-1', employerId: 'employer-1', employeeId: 'employee-1', applicationId: 'app-1' })
  );
  client.seed('tasks', 'task-legacy', { ...legacyTask(), employmentId: 'emp-1' });

  const submitted = await (await asEmployee()).post('/tasks/task-legacy/submit', { body: SUBMISSION });
  assert.equal(submitted.status, 200);

  const afterSubmit = client.readDoc('tasks', 'task-legacy');
  assert.equal(afterSubmit.status, 'submitted');
  assert.equal(afterSubmit.submissionText, SUBMISSION.submissionText);
  assert.equal('submissionType' in afterSubmit, false, 'a submission does not write the type either');

  const approved = await employerApi.post('/tasks/task-legacy/approve', { body: {} });
  assert.equal(approved.status, 200);
  assert.equal(client.readDoc('tasks', 'task-legacy').status, 'approved');
});

// ---- link

test('a link task accepts a valid url and stores only submissionUrl', async () => {
  seedWorkflow({ taskOverrides: { submissionType: 'link' } });

  const res = await (await asEmployee()).post('/tasks/task-1/submit', { body: LINK_SUBMISSION });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');

  const after = client.readDoc('tasks', 'task-1');
  assert.equal(after.submissionUrl, LINK_SUBMISSION.submissionUrl);
  assert.equal('submissionText' in after, false);
  assert.equal('submissionFile' in after, false);
  assert.equal('submittedBody' in after, false);
});

test('a link task refuses anything that is not an http or https url', async () => {
  // `javascript:` and `data:` parse as URLs and are exactly what a reader would
  // render as an anchor, so the protocol check is the whole point of this list.
  const refused = [
    {},
    { submissionUrl: '' },
    { submissionUrl: '   ' },
    { submissionUrl: 'not a url' },
    { submissionUrl: 'javascript:alert(1)' },
    { submissionUrl: 'data:text/html,<script>alert(1)</script>' },
    { submissionUrl: 'ftp://files.example.test/evidence' },
    { submissionUrl: 'mailto:employee-1@example.test' },
    { submissionUrl: 42 },
    { submissionUrl: null },
    { submissionUrl: ['https://example.test'] },
  ];

  for (const body of refused) {
    seedWorkflow({ taskOverrides: { submissionType: 'link' } });
    const res = await (await asEmployee()).post('/tasks/task-1/submit', { body });

    assert.equal(res.status, 400, `link task must refuse ${JSON.stringify(body)}`);
    assert.match(res.body.message, /submissionUrl/);
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');
  }
});

test('a link task refuses a text submission', async () => {
  seedWorkflow({ taskOverrides: { submissionType: 'link' } });

  const res = await (await asEmployee()).post('/tasks/task-1/submit', { body: SUBMISSION });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /submissionUrl/);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
});

test('an http url is accepted, not only https', async () => {
  seedWorkflow({ taskOverrides: { submissionType: 'link' } });

  const res = await (await asEmployee()).post('/tasks/task-1/submit', {
    body: { submissionUrl: 'http://example.test/evidence' },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('tasks', 'task-1').submissionUrl, 'http://example.test/evidence');
});

// ---- file

test('a file task accepts a Cloudinary reference under its own prefix and stores only submissionFile', async () => {
  seedWorkflow({ taskOverrides: { submissionType: 'file' } });
  const reference = fileReference('task-1');

  const res = await (await asEmployee()).post('/tasks/task-1/submit', {
    body: { submissionFile: reference },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'submitted');

  const after = client.readDoc('tasks', 'task-1');
  assert.deepEqual(after.submissionFile, reference);
  assert.equal('submissionText' in after, false);
  assert.equal('submissionUrl' in after, false);
  assert.equal('submittedBody' in after, false);
});

test('a file task refuses a reference that is not complete', async () => {
  const complete = fileReference('task-1');
  const incomplete = [
    undefined,
    null,
    'https://example.test/evidence.png',
    ['https://example.test/evidence.png'],
    {},
    { url: complete.url },
    { publicId: complete.publicId },
    { name: complete.name },
    { resourceType: complete.resourceType },
    { url: complete.url, publicId: complete.publicId },
    { url: complete.url, publicId: complete.publicId, name: complete.name },
    // THE OLD SHAPE. Stage 10G stored the Firebase Storage triple `{url, path, name}`;
    // a document still holding one must not be accepted as a new submission, so `path`
    // is not read as a fallback for `publicId`.
    { url: complete.url, path: complete.publicId, name: complete.name },
    { ...complete, url: '' },
    { ...complete, publicId: '' },
    { ...complete, name: '' },
    { ...complete, resourceType: '' },
    { ...complete, url: '   ' },
    { ...complete, publicId: '   ' },
    { ...complete, url: 42 },
    { ...complete, publicId: 42 },
    { ...complete, name: ['evidence.png'] },
    { ...complete, resourceType: 42 },
    { ...complete, url: 'javascript:alert(1)' },
  ];

  for (const submissionFile of incomplete) {
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });
    const res = await (await asEmployee()).post('/tasks/task-1/submit', {
      body: { submissionFile },
    });

    assert.equal(res.status, 400, `file task must refuse ${JSON.stringify(submissionFile)}`);
    assert.match(res.body.message, /file reference/i);
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');
  }
});

test('a file task refuses a resourceType that is not raw', async () => {
  // `resourceType` selects the Cloudinary upload endpoint, and the url carries the same
  // choice as `/raw/upload/`; both are checked, which is what stops a reference built by
  // hand from an image delivery url being accepted. A padded value is trimmed, like the
  // other string fields, so only a genuinely different type is refused.
  const refused = [
    { ...fileReference('task-1'), resourceType: 'image' },
    { ...fileReference('task-1'), resourceType: 'video' },
    { ...fileReference('task-1'), resourceType: 'RAW' },
  ];

  for (const submissionFile of refused) {
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });
    const res = await (await asEmployee()).post('/tasks/task-1/submit', {
      body: { submissionFile },
    });

    assert.equal(res.status, 400, `must refuse resourceType ${submissionFile.resourceType}`);
    assert.match(res.body.message, /resourceType must be raw/);
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');
  }
});

test('a file task refuses a url that is not a Cloudinary raw upload url', async () => {
  const complete = fileReference('task-1');
  const refused = [
    { ...complete, url: `https://res.cloudinary.com/demo/image/upload/v1/${complete.publicId}` },
    { ...complete, url: `https://example.test/${complete.publicId}` },
    { ...complete, url: `https://res.cloudinary.com/demo/raw/${complete.publicId}` },
  ];

  for (const submissionFile of refused) {
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });
    const res = await (await asEmployee()).post('/tasks/task-1/submit', {
      body: { submissionFile },
    });

    assert.equal(res.status, 400, `must refuse url ${submissionFile.url}`);
    assert.match(res.body.message, /raw upload URL/);
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');
  }
});

test('a file task refuses a url that does not name its publicId', async () => {
  // The url and the id must agree: the check above allows any id under this task's own
  // folder, and this check is what stops a url for a different asset travelling with
  // one of those ids.
  seedWorkflow({ taskOverrides: { submissionType: 'file' } });
  const complete = fileReference('task-1');
  const submissionFile = {
    ...complete,
    url: complete.url.replace(complete.publicId, 'taskSubmissions/task-1/9999999999999-deadbeef'),
  };

  const res = await (await asEmployee()).post('/tasks/task-1/submit', { body: { submissionFile } });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /url does not match its publicId/);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');
});

test('a file task refuses a publicId outside taskSubmissions/{taskId}/', async () => {
  // This is the one check here that is about authorization rather than shape: an
  // employee may deliver a file for task-1 and for nothing else. The `..` case is the
  // reason the prefix test alone is not enough -- it starts with the prefix and still
  // names an object outside it.
  const keep = fileReference('task-1').url;
  const outside = [
    fileReference('task-2'),
    fileReference('some-other-task'),
    { ...fileReference('task-1'), publicId: 'taskSubmissions/task-2/1-evidence.png' },
    { ...fileReference('task-1'), publicId: 'profilePics/employee-1' },
    { ...fileReference('task-1'), publicId: 'taskSubmissions/task-1' },
    { ...fileReference('task-1'), publicId: 'taskSubmissions/task-1/' },
    { ...fileReference('task-1'), publicId: 'taskSubmissions/task-1/../task-2/1-evidence.png' },
    { ...fileReference('task-1'), publicId: 'taskSubmissions/task-1/../../profilePics/employee-1' },
  ];

  for (const submissionFile of outside) {
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });
    const res = await (await asEmployee()).post('/tasks/task-1/submit', {
      body: { submissionFile: { ...submissionFile, url: keep } },
    });

    assert.equal(res.status, 400, `must refuse publicId ${submissionFile.publicId}`);
    // The refusal names the id, because that is the field the caller got wrong. The
    // url is left correct on purpose to show the id check is what caught it.
    assert.match(res.body.message, /publicId/);
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');
  }
});

test('a file task refuses a text or link submission', async () => {
  for (const body of [SUBMISSION, LINK_SUBMISSION]) {
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });
    const res = await (await asEmployee()).post('/tasks/task-1/submit', { body });

    assert.equal(res.status, 400, `file task must refuse ${JSON.stringify(body)}`);
    assert.match(res.body.message, /file reference/i);
  }
});

test('a file submission survives the rest of the lifecycle unchanged', async () => {
  seedWorkflow({ taskOverrides: { submissionType: 'file' } });
  const reference = fileReference('task-1');

  await (await asEmployee()).post('/tasks/task-1/submit', { body: { submissionFile: reference } });

  const sentBack = await employerApi.post('/tasks/task-1/request-revision', { body: REVISION });
  assert.equal(sentBack.status, 200);
  assert.equal(sentBack.body.status, 'revision_requested');

  const replacement = fileReference('task-1', 'evidence-v2.png');
  const resubmitted = await (await asEmployee()).post('/tasks/task-1/submit', {
    body: { submissionFile: replacement },
  });
  assert.equal(resubmitted.status, 200);

  const approved = await employerApi.post('/tasks/task-1/approve', { body: {} });
  assert.equal(approved.status, 200);

  const after = client.readDoc('tasks', 'task-1');
  assert.equal(after.status, 'approved');
  // The second attempt replaces the first entirely, as it does for text: the employer
  // reviews one delivery, not the union of two.
  assert.deepEqual(after.submissionFile, replacement);
  assert.equal(after.revisionNote, REVISION.revisionNote);
});

// ---- the type is authoritative

test('a text task refuses a link or file submission', async () => {
  for (const body of [LINK_SUBMISSION, { submissionFile: fileReference('task-1') }]) {
    seedWorkflow();
    const res = await (await asEmployee()).post('/tasks/task-1/submit', { body });

    assert.equal(res.status, 400, `text task must refuse ${JSON.stringify(body)}`);
    assert.equal(res.body.message, 'Missing required fields');
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');
  }
});

test('a task whose submission type is not one this API knows is refused, not guessed at', async () => {
  // Fail-closed, for the same reason an unknown status is: treating it as `text` would
  // let a submission through on rules nobody chose for it.
  seedWorkflow({ taskOverrides: { submissionType: 'attachment' } });

  const res = await (await asEmployee()).post('/tasks/task-1/submit', { body: SUBMISSION });

  assert.equal(res.status, 400);
  assert.match(res.body.message, /unknown submissionType/);
  assert.match(res.body.message, /attachment/);
  assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned');

  // And a read forwards it untouched rather than coercing it, so the value that caused
  // the refusal is still visible to whoever has to fix it.
  const read = await (await asEmployee()).get('/tasks/task-1');
  assert.equal(read.body.task.submissionType, 'attachment');
});

test('the submission type cannot be chosen by the employee at submission time', async () => {
  seedWorkflow();

  const res = await (await asEmployee()).post('/tasks/task-1/submit', {
    body: { ...SUBMISSION, submissionType: 'link' },
  });

  // A `text` task answered with text is still a `text` task. There is no update
  // endpoint for a task at all, so the stored type is the only one there has ever been.
  assert.equal(res.status, 200);
  const after = client.readDoc('tasks', 'task-1');
  assert.equal(after.submissionType, 'text');
  assert.equal(after.submissionText, SUBMISSION.submissionText);
});

test('the submission type does not widen who may submit', async () => {
  // A file task is still the employee's to submit and nobody else's, and the
  // authorization above is untouched by anything in this stage.
  seedWorkflow({ taskOverrides: { submissionType: 'file' } });
  const reference = fileReference('task-1');

  const stranger = await client.authed('stranger-1');
  const strangerSubmit = await stranger.post('/tasks/task-1/submit', {
    body: { submissionFile: reference },
  });
  assert.equal(strangerSubmit.status, 403);

  const employerSubmit = await employerApi.post('/tasks/task-1/submit', {
    body: { submissionFile: reference },
  });
  assert.equal(employerSubmit.status, 403);

  const after = client.readDoc('tasks', 'task-1');
  assert.equal(after.status, 'assigned');
  assert.equal('submissionFile' in after, false, 'a refused submit writes nothing');
});

// ---------------------------------- Stage 10G.1: signed direct uploads
//
// The browser no longer uploads THROUGH this API: it asks for a signature for one task
// and sends the bytes to Cloudinary itself. Nothing about who may submit changed, so
// these tests cover two rules -- the signature is only minted for a task its caller
// could already act on, and the reference submitted afterwards must be the kind that
// signature could have produced.

// Install deterministic Cloudinary credentials for the duration of one test and
// restore whatever the environment held before. Signing is local arithmetic, so no
// cloud account or network call is involved. Mirrors the resume/profile-photo
// signing tests in applications.test.js and users.test.js.
async function withCloudinaryCredentials(run) {
  const saved = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };

  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';

  try {
    return await run();
  } finally {
    restoreEnv('CLOUDINARY_CLOUD_NAME', saved.cloudName);
    restoreEnv('CLOUDINARY_API_KEY', saved.apiKey);
    restoreEnv('CLOUDINARY_API_SECRET', saved.secret);
  }
}

// Assigning `undefined` to process.env coerces it to the string "undefined", so a
// variable that was absent before a test must be deleted, not reassigned.
function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test('an employee gets a signature for their own file task, and it signs that task\'s folder', async () => {
  await withCloudinaryCredentials(async () => {
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });

    const res = await (await asEmployee()).post('/tasks/task-1/upload-signature', { body: {} });

    assert.equal(res.status, 200);

    const signed = res.body;
    assert.equal(signed.cloudName, process.env.CLOUDINARY_CLOUD_NAME);
    assert.equal(signed.apiKey, process.env.CLOUDINARY_API_KEY);
    assert.equal(signed.resourceType, 'raw', 'the type buildFileSubmission will also require');
    assert.equal(signed.folder, 'taskSubmissions/task-1');
    // The signed `public_id` is the NAME UNDER THAT FOLDER, not the full path: Cloudinary
    // joins the two, and the id it returns after the upload -- which the client stores as
    // `submissionFile.publicId` -- is `taskSubmissions/task-1/{this}`. `{timestamp}-{12
    // hex}` is asserted as a pattern rather than a value, because the point is the shape
    // the client echoes back.
    assert.match(signed.publicId, /^\d+-[0-9a-f]{12}$/);
    assert.equal(typeof signed.timestamp, 'number');

    // The signature covers the folder and the public id, exactly as the browser sends
    // them, and nothing else. It is recomputed here rather than compared to a fixture so
    // the test pins the ALGORITHM -- sorted `key=value` pairs joined with `&`, suffixed
    // with the secret -- not one output.
    const expected = crypto
      .createHash('sha1')
      .update(
        `folder=${signed.folder}&public_id=${signed.publicId}&timestamp=${signed.timestamp}${process.env.CLOUDINARY_API_SECRET}`
      )
      .digest('hex');
    assert.equal(signed.signature, expected);

    // The secret itself never travels: a signature reproducible from the response would
    // be no signature at all.
    assert.equal(JSON.stringify(res.body).includes(process.env.CLOUDINARY_API_SECRET), false);
    assert.equal('apiSecret' in signed, false);
  });
});

test('each signature request mints a fresh public id', async () => {
  await withCloudinaryCredentials(async () => {
    // Two requests for one task must not name the same object, or a resubmission after a
    // revision would collide with the delivery the employer is still reviewing.
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });
    const employee = await asEmployee();

    const first = await employee.post('/tasks/task-1/upload-signature', { body: {} });
    const second = await employee.post('/tasks/task-1/upload-signature', { body: {} });

    assert.notEqual(first.body.publicId, second.body.publicId);
  });
});

test('a signature asks nothing of the client and writes nothing', async () => {
  await withCloudinaryCredentials(async () => {
    seedWorkflow({ taskOverrides: { submissionType: 'file' } });
    const before = client.readDoc('tasks', 'task-1');

    // Whatever the client sends is ignored: folder and public id are decided here, so
    // there is no field it could set to redirect the upload at another task or user.
    const res = await (await asEmployee()).post('/tasks/task-1/upload-signature', {
      body: { folder: 'taskSubmissions/task-2', publicId: 'evil', resourceType: 'image' },
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.folder, 'taskSubmissions/task-1');
    assert.equal(res.body.resourceType, 'raw');
    assert.deepEqual(client.readDoc('tasks', 'task-1'), before, 'signing is not a write');
  });
});

test('a signature cannot be obtained for another employee\'s task', async () => {
  // Signing is the first half of a submit, so the party guard that refuses a stranger's
  // submit must refuse a stranger's signature with the same answer.
  seedWorkflow({ taskOverrides: { submissionType: 'file' } });

  const stranger = await client.authed('stranger-1');
  const res = await stranger.post('/tasks/task-1/upload-signature', { body: {} });

  assert.equal(res.status, 403);
});

test('the employer cannot request a signature for the employee\'s task', async () => {
  // Same reason, the other side of the same guard: a file is delivered BY the employee.
  seedWorkflow({ taskOverrides: { submissionType: 'file' } });

  const res = await employerApi.post('/tasks/task-1/upload-signature', { body: {} });

  assert.equal(res.status, 403);
});

test('a signature requires the same task linkage a submission does', async () => {
  // A task with no employment linkage is the case requireTaskParty refuses specifically,
  // and signing must reach the same answer for the same reason.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'tasks',
    'task-1',
    task({ jobId: 'job-1', employeeId: 'employee-1', employmentId: undefined, submissionType: 'file' })
  );

  const res = await (await asEmployee()).post('/tasks/task-1/upload-signature', { body: {} });

  assert.equal(res.status, 403);
  assert.match(res.body.message, /not linked to an employment/);
});

test('upload signing is unavailable, not broken, when Cloudinary is not configured', async () => {
  // The one configuration this stage adds is required only for file uploads, so its
  // absence must be a clear 503 on this route and nothing else. The variables are
  // removed and restored around the test because config/cloudinary reads them lazily:
  // that laziness is exactly what lets a server start without them.
  seedWorkflow({ taskOverrides: { submissionType: 'file' } });
  client.seed(
    'tasks',
    'task-text',
    task({ jobId: 'job-1', employeeId: 'employee-1', employmentId: 'emp-1', submissionType: 'text' })
  );

  const saved = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };

  try {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;

    const res = await (await asEmployee()).post('/tasks/task-1/upload-signature', { body: {} });

    assert.equal(res.status, 503);
    assert.match(res.body.message, /not configured/i);
    assert.equal(/secret|api[_-]?key/i.test(res.body.message), false, 'the answer names no variable');
    assert.equal(client.readDoc('tasks', 'task-1').status, 'assigned', 'no partial write');

    // Text does not touch Cloudinary, so the rest of task submission keeps working
    // while file uploads are down.
    const text = await (await asEmployee()).post('/tasks/task-text/submit', { body: SUBMISSION });
    assert.equal(text.status, 200);
  } finally {
    if (saved.cloudName === undefined) {
      delete process.env.CLOUDINARY_CLOUD_NAME;
    } else {
      process.env.CLOUDINARY_CLOUD_NAME = saved.cloudName;
    }
    if (saved.apiKey === undefined) {
      delete process.env.CLOUDINARY_API_KEY;
    } else {
      process.env.CLOUDINARY_API_KEY = saved.apiKey;
    }
    if (saved.secret === undefined) {
      delete process.env.CLOUDINARY_API_SECRET;
    } else {
      process.env.CLOUDINARY_API_SECRET = saved.secret;
    }
  }
});
