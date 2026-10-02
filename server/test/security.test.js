'use strict';

/**
 * Authorization tests (Stage 1).
 *
 * This suite asserts the SECURE contract: every endpoint requires a bearer
 * token, identity always comes from the verified token, and no user can act on
 * another user's resources.
 *
 * It replaces the Stage 0 characterization suite, which asserted the opposite
 * (that these routes were reachable anonymously). Those assertions were
 * inverted deliberately as part of Stage 1.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, user, application, interview } = require('../testing/fixtures');

let client;

test.before(async () => {
  client = await startTestServer();
});

test.after(async () => {
  await client.close();
});

test.beforeEach(() => {
  client.fake.resetAll();
});

/**
 * Every route, with fixtures and the expected status for an anonymous caller.
 */
const ENDPOINTS = [
  { name: 'GET /', method: 'GET', path: '/', setup: () => {} },
  { name: 'GET /users/', method: 'GET', path: '/users', setup: () => {} },
  {
    name: 'GET /users/getUser/:userId',
    method: 'GET',
    path: '/users/getUser/victim',
    setup: () => client.seed('users', 'victim', user({ uid: 'victim' })),
  },
  {
    name: 'PUT /users/update/:uid',
    method: 'PUT',
    path: '/users/update/victim',
    body: { fullName: 'Hijacked' },
    setup: () => client.seed('users', 'victim', user({ uid: 'victim' })),
  },
  { name: 'GET /jobs', method: 'GET', path: '/jobs', setup: () => client.seed('jobs', 'job-1', job()) },
  {
    name: 'POST /jobs/create',
    method: 'POST',
    path: '/jobs/create',
    body: {
      title: 'Anonymous job',
      description: 'd',
      location: 'l',
      jobType: 'jt',
      applicationDeadline: '2026-10-01',
      jobStartDate: '2026-10-05',
      price: 1,
    },
    setup: () => {},
  },
  {
    name: 'GET /jobs/employer/:uid',
    method: 'GET',
    path: '/jobs/employer/victim',
    setup: () => client.seed('jobs', 'job-1', job({ postedBy: 'victim' })),
  },
  {
    name: 'GET /jobs/:jobId',
    method: 'GET',
    path: '/jobs/job-1',
    setup: () => client.seed('jobs', 'job-1', job()),
  },
  {
    name: 'PUT /jobs/edit/:jobId',
    method: 'PUT',
    path: '/jobs/edit/job-1',
    body: {
      title: 'Hijacked',
      description: 'd',
      location: 'l',
      jobType: 'jt',
      applicationDeadline: '2026-10-01',
      jobStartDate: '2026-10-05',
      price: 1,
    },
    setup: () => client.seed('jobs', 'job-1', job({ postedBy: 'victim' })),
  },
  {
    name: 'DELETE /jobs/:jobId',
    method: 'DELETE',
    path: '/jobs/job-1',
    setup: () => client.seed('jobs', 'job-1', job({ postedBy: 'victim' })),
  },
  {
    name: 'PUT /jobs/:jobId/status',
    method: 'PUT',
    path: '/jobs/job-1/status',
    body: { status: 'Filled' },
    setup: () => client.seed('jobs', 'job-1', job({ postedBy: 'victim' })),
  },
  {
    name: 'POST /applications/apply',
    method: 'POST',
    path: '/applications/apply',
    body: { jobId: 'job-1' },
    setup: () => client.seed('jobs', 'job-1', job()),
  },
  {
    name: 'GET /applications/employee/:uid',
    method: 'GET',
    path: '/applications/employee/victim',
    setup: () => client.seed('applications', 'app-1', application({ employeeId: 'victim' })),
  },
  {
    name: 'GET /applications/job/:jobId',
    method: 'GET',
    path: '/applications/job/job-1',
    setup: () => client.seed('applications', 'app-1', application({ jobId: 'job-1' })),
  },
  {
    // Stage 5B count-only read. Unauthenticated callers must be rejected before
    // any aggregate is computed, so it belongs in this sweep alongside the
    // endpoints it was added to protect.
    name: 'GET /applications/counts',
    method: 'GET',
    path: '/applications/counts',
    setup: () => client.seed('applications', 'app-1', application({ jobId: 'job-1' })),
  },
  {
    name: 'PUT /applications/:id/status',
    method: 'PUT',
    path: '/applications/app-1/status',
    body: { status: 'Employed' },
    setup: () => {
      client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
      client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
    },
  },
  {
    name: 'DELETE /applications/:applicationId',
    method: 'DELETE',
    path: '/applications/app-1',
    setup: () => {
      client.seed('jobs', 'job-1', job());
      client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'victim' }));
    },
  },
  {
    name: 'POST /tasks',
    method: 'POST',
    path: '/tasks',
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 't',
      taskDescription: 'd',
      dueDate: '2026-10-01',
    },
    setup: () => {
      client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
      client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
    },
  },
  {
    name: 'POST /applications/tasks',
    method: 'POST',
    path: '/applications/tasks',
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 't',
      taskDescription: 'd',
      dueDate: '2026-10-01',
    },
    setup: () => {
      client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
      client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
    },
  },
  // STAGE 7C. The four interview routes join this sweep for the same reason the
  // Stage 5B count read did: a new resource must not be the first one in the API
  // that answers an unauthenticated caller. Each is seeded so that its guard would
  // otherwise PASS -- a victim-owned job and application, an interview belonging to
  // that victim -- so a missing `protect` would surface as a 403/404/200 rather than
  // being masked by an unrelated failure.
  {
    name: 'POST /interviews',
    method: 'POST',
    path: '/interviews',
    body: {
      applicationId: 'app-1',
      jobId: 'job-1',
      scheduledAt: '2026-10-02T10:00:00.000Z',
      type: 'online',
    },
    setup: () => {
      client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
      client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
    },
  },
  {
    name: 'PUT /interviews/:interviewId',
    method: 'PUT',
    path: '/interviews/int-1',
    body: { status: 'cancelled' },
    setup: () => {
      client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
      client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
      client.seed(
        'interviews',
        'int-1',
        interview({ applicationId: 'app-1', jobId: 'job-1', employerId: 'victim', employeeId: 'employee-1' })
      );
    },
  },
  {
    name: 'GET /interviews/job/:jobId',
    method: 'GET',
    path: '/interviews/job/job-1',
    setup: () => {
      client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
      client.seed('interviews', 'int-1', interview({ employerId: 'victim' }));
    },
  },
  {
    name: 'GET /interviews/application/:applicationId',
    method: 'GET',
    path: '/interviews/application/app-1',
    setup: () => {
      client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
      client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'victim' }));
      client.seed('interviews', 'int-1', interview({ applicationId: 'app-1' }));
    },
  },
];

for (const endpoint of ENDPOINTS) {
  test(`UNAUTHENTICATED: ${endpoint.name} rejects a missing token`, async () => {
    endpoint.setup();
    const res = await client.request(endpoint.method, endpoint.path, { body: endpoint.body });
    assert.equal(res.status, 401, `${endpoint.name} must require authentication`);
  });

  test(`UNAUTHENTICATED: ${endpoint.name} rejects an invalid token`, async () => {
    endpoint.setup();
    const res = await client.request(endpoint.method, endpoint.path, {
      body: endpoint.body,
      token: 'not-a-real-token',
    });
    assert.equal(res.status, 401, `${endpoint.name} must reject an invalid token`);
  });
}

test('every route requires authentication (no route is left open)', async () => {
  for (const endpoint of ENDPOINTS) {
    client.fake.resetAll();
    endpoint.setup();
    const res = await client.request(endpoint.method, endpoint.path, { body: endpoint.body });
    assert.equal(res.status, 401, `${endpoint.name} is reachable without a token`);
  }
});

// ------------------------------------------------------------- job ownership

test('an employer can still edit, delete and re-status their own job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1', title: 'Mine' }));
  const api = await client.authed('employer-1');

  const edit = await api.put('/jobs/edit/job-1', {
    body: {
      title: 'Updated',
      description: 'd',
      location: 'l',
      jobType: 'jt',
      applicationDeadline: '2026-10-01',
      jobStartDate: '2026-10-05',
      price: 100,
    },
  });
  assert.equal(edit.status, 200);
  assert.equal(client.readDoc('jobs', 'job-1').title, 'Updated');

  // Stage 5G: canonical lowercase `filled`. This test is about ownership, so it
  // uses a value the endpoint accepts; the allow-list itself is covered in
  // jobs.test.js.
  const status = await api.put('/jobs/job-1/status', { body: { status: 'filled' } });
  assert.equal(status.status, 200);

  const removed = await api.delete('/jobs/job-1');
  assert.equal(removed.status, 200);
  assert.equal(client.readDoc('jobs', 'job-1'), undefined);
});

test('a stranger cannot edit another user\'s job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim', title: 'Victim job' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/jobs/edit/job-1', {
    body: {
      title: 'Attacker was here',
      description: 'd',
      location: 'l',
      jobType: 'jt',
      applicationDeadline: '2026-10-01',
      jobStartDate: '2026-10-05',
      price: 1,
    },
  });

  assert.equal(res.status, 403);
  assert.equal(client.readDoc('jobs', 'job-1').title, 'Victim job');
});

test('a stranger cannot delete another user\'s job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.delete('/jobs/job-1');

  assert.equal(res.status, 403);
  assert.notEqual(client.readDoc('jobs', 'job-1'), undefined);
});

test('a stranger cannot change another user\'s job status', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim', status: 'open' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/jobs/job-1/status', { body: { status: 'Filled' } });

  assert.equal(res.status, 403);
  assert.equal(client.readDoc('jobs', 'job-1').status, 'open');
});

// STAGE 6S regression guard. requireJobOwner guards two reads and three writes,
// and Stage 6S reworded only the read rejection. The three mutating job routes
// must still refuse with the original "modify this job" text, because for them
// that is an accurate description of the action the caller was refused. This test
// fails if a later change lets the read wording leak into the write guards.
test('a write on another user\'s job still reports the modify restriction', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim', status: 'open' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/jobs/job-1/status', { body: { status: 'filled' } });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to modify this job');
});

test('postedBy is taken from the token, not the request body', async () => {
  const attacker = await client.authed('attacker');

  await attacker.post('/jobs/create', {
    body: {
      title: 'Framed',
      description: 'd',
      location: 'l',
      jobType: 'jt',
      applicationDeadline: '2026-10-01',
      jobStartDate: '2026-10-05',
      price: 1,
      postedBy: 'victim',
    },
  });

  const stored = Object.values(client.readAll('jobs'))[0];
  assert.equal(stored.postedBy, 'attacker');
});

test('a user cannot read another employer\'s posted-jobs list', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.get('/jobs/employer/victim');

  assert.equal(res.status, 403);
});

test('a user can still browse all jobs and view any single job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  const api = await client.authed('employee-1');

  assert.equal((await api.get('/jobs')).status, 200);
  assert.equal((await api.get('/jobs/job-1')).status, 200);
});

test('updating a missing job returns 404 before any authorization runs', async () => {
  const api = await client.authed('employer-1');
  const res = await api.put('/jobs/ghost/status', { body: { status: 'Filled' } });

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
});

// ----------------------------------------------------- application ownership

test('an employee can still apply to a job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  const applicant = await client.authed('employee-1');

  const res = await applicant.post('/applications/apply', {
    body: { jobId: 'job-1' },
  });

  assert.equal(res.status, 200);
  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal(stored.employeeId, 'employee-1');
});

test('employeeId is taken from the token, not the request body', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  const applicant = await client.authed('employee-1');

  await applicant.post('/applications/apply', {
    body: { jobId: 'job-1', employeeId: 'victim' },
  });

  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal(stored.employeeId, 'employee-1');
});

test('an applicant can still withdraw their own application', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1' })
  );
  const applicant = await client.authed('employee-1');

  const res = await applicant.delete('/applications/app-1');

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1'), undefined);
});

test('a stranger cannot withdraw another user\'s application', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'victim' })
  );
  const attacker = await client.authed('attacker');

  const res = await attacker.delete('/applications/app-1');

  assert.equal(res.status, 403);
  assert.notEqual(client.readDoc('applications', 'app-1'), undefined);
});

test('the employer who posted the job can still change application status', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1' })
  );
  const employer = await client.authed('employer-1');

  // Stage 5G: canonical lowercase `accepted`. This test is about who may change
  // the status, so it uses a value the endpoint accepts; the allow-list itself
  // is covered in applications.test.js.
  const res = await employer.put('/applications/app-1/status', { body: { status: 'accepted' } });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
});

test('an unrelated employer cannot change application status', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1' })
  );
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/applications/app-1/status', { body: { status: 'Employed' } });

  assert.equal(res.status, 403);
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
});

test('an applicant cannot set their own application status', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1' })
  );
  const applicant = await client.authed('employee-1');

  const res = await applicant.put('/applications/app-1/status', { body: { status: 'Employed' } });

  assert.equal(res.status, 403);
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
});

test('a user cannot read another user\'s application list', async () => {
  client.seed('applications', 'app-1', application({ employeeId: 'victim' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.get('/applications/employee/victim');

  assert.equal(res.status, 403);
});

// --------------------------------------------------- applicant list per job
//
// STAGE 5B regression tests for the Stage 5A IDOR-01 finding.
//
// GET /applications/job/:jobId used to be `protect`-only, so any authenticated
// caller could read every applicant's identity (employeeId, fullName, message,
// employeePrice, status) for any job they could name. It is now guarded by
// requireJobOwner, i.e. job.postedBy === req.user.uid.

test('CASE 1: GET /applications/job/:jobId is rejected without a token', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));

  const res = await client.get('/applications/job/job-1');

  assert.equal(res.status, 401);
});

test('CASE 2: an applicant cannot read the applicant list for a job they applied to', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-1', employeeId: 'employee-2' }));
  const applicant = await client.authed('employee-1');

  const res = await applicant.get('/applications/job/job-1');

  // 403 even for the job they applied to: this endpoint is the employer's view.
  assert.equal(res.status, 403);
  // No applicant identity may leak in the rejection body either.
  assert.equal(res.body.applications, undefined);
  assert.equal(JSON.stringify(res.body).includes('employee-2'), false);
});

test('CASE 3: an employer cannot read the applicant list for another employer\'s job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  const rival = await client.authed('rival-employer');

  const res = await rival.get('/applications/job/job-1');

  assert.equal(res.status, 403);
  assert.equal(JSON.stringify(res.body).includes('Test User'), false);
});

test('CASE 4: the job owner still receives the full application list', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-1', employeeId: 'employee-2' }));
  const owner = await client.authed('employer-1');

  const res = await owner.get('/applications/job/job-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.applications.length, 2);
  // The legitimate employer view keeps every applicant field ViewJobApplications
  // renders, with no renaming.
  assert.deepEqual(
    res.body.applications.map((a) => a.employeeId).sort(),
    ['employee-1', 'employee-2']
  );
  assert.equal(res.body.applications[0].fullName, 'Test User');
  assert.equal(res.body.applications[0].status, 'pending');
});

test('CASE 5: an authenticated caller can retrieve the counts the dashboards need', async () => {
  client.seed('jobs', 'job-1', job());
  client.seed('jobs', 'job-2', job());
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-3', application({ jobId: 'job-2' }));
  const reader = await client.authed('employee-1');

  const res = await reader.get('/applications/counts');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.counts, { 'job-1': 2, 'job-2': 1 });
});

test('CASE 6: the count endpoint exposes no applicant data', async () => {
  client.seed('jobs', 'job-1', job());
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));
  const reader = await client.authed('employee-1');

  const res = await reader.get('/applications/counts');

  // Every value must be a bare integer, and no applicant field may be present.
  assert.deepEqual(Object.values(res.body.counts), [1]);
  for (const value of Object.values(res.body.counts)) {
    assert.equal(typeof value, 'number');
  }
  const payload = JSON.stringify(res.body);
  for (const leaked of ['employee-1', 'Test User', 'I can do this', 'pending', 'employeePrice']) {
    assert.equal(payload.includes(leaked), false, `count payload must not contain ${leaked}`);
  }
});

test('CASE 6b: the count endpoint is rejected without a token', async () => {
  client.seed('applications', 'app-1', application());

  const res = await client.get('/applications/counts');

  assert.equal(res.status, 401);
});

test('CASE 7: the count endpoint does not replace the employer full-list endpoint', async () => {
  // Both still exist and are independently reachable: the count path for the
  // dashboards, the full list for the job owner. Consolidating them would either
  // strip the employer view or re-expose it, so both contracts are pinned.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  const owner = await client.authed('employer-1');

  const full = await owner.get('/applications/job/job-1');
  const counts = await owner.get('/applications/counts');

  assert.equal(full.status, 200);
  assert.ok(Array.isArray(full.body.applications));
  assert.equal(full.body.applications.length, 1);

  assert.equal(counts.status, 200);
  assert.deepEqual(counts.body.counts, { 'job-1': 1 });
  assert.equal(counts.body.applications, undefined);
});

// ------------------------------------------------------------ task assignment

/**
 * STAGE 6K. This test used to be called "an employer can still create a task for
 * someone who applied" and seeded a `pending` application, which asserted the
 * rule this stage closed: the guard compared only `employeeId`. It now pins the
 * rule that replaced it -- accepted, not merely applied.
 */
test('an employer can create a task for an applicant whose application was accepted', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  const employer = await client.authed('employer-1');

  const res = await employer.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 'Replace washer',
      taskDescription: 'Fit a new washer',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 200);
  const task = Object.values(client.readAll('tasks'))[0];
  assert.equal(task.employeeId, 'employee-1');
});

test('an employer cannot create a task on a job they do not own', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1' })
  );
  const attacker = await client.authed('attacker');

  const res = await attacker.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 't',
      taskDescription: 'd',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 403);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('a task cannot be assigned to someone who never applied to the job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1' })
  );
  const employer = await client.authed('employer-1');

  const res = await employer.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'unrelated-person',
      taskName: 't',
      taskDescription: 'd',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 403);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

// -------------------------------------------- stage 6k: accepted, not applied
//
// requireTaskAssignment previously accepted any applicant, so a task could be
// created for someone whose application was pending or rejected -- and that task
// then appeared on their own "Your Hired Jobs" page. The tests below pin the
// replacement rule and prove the pre-existing owner and applicant checks are
// unchanged and still evaluated first.

test('a task cannot be assigned to an applicant whose application was rejected', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'rejected' })
  );
  const employer = await client.authed('employer-1');

  const res = await employer.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 'Replace washer',
      taskDescription: 'Fit a new washer',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 403);
  assert.match(res.body.message, /accepted/);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('a task cannot be assigned to an applicant whose application is still pending', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'pending' })
  );
  const employer = await client.authed('employer-1');

  const res = await employer.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 'Replace washer',
      taskDescription: 'Fit a new washer',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 403);
  assert.match(res.body.message, /accepted/);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('a task cannot be assigned to an unrelated employee even by the job owner', async () => {
  // The applicant check must still win over the new status check for someone who
  // never applied at all, and must keep its own message.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  const employer = await client.authed('employer-1');

  const res = await employer.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'someone-who-never-applied',
      taskName: 'Replace washer',
      taskDescription: 'Fit a new washer',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 403);
  assert.match(res.body.message, /applied to this job/);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('the job owner check still runs before the accepted-applicant check', async () => {
  // A non-owner must be refused for being a non-owner. The seeded application is
  // `accepted` on purpose: if the owner check were removed or reordered, this
  // request would be authorised and the task would be created.
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );
  const attacker = await client.authed('attacker');

  const res = await attacker.post('/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 'Replace washer',
      taskDescription: 'Fit a new washer',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 403);
  assert.match(res.body.message, /permission to create tasks for this job/);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

test('the accepted-applicant rule covers the duplicate POST /applications/tasks path', async () => {
  // Both task-creation routes share requireTaskAssignment, so neither can be used
  // to reach the weaker rule. The duplicate returns no taskId, so the stored
  // document is read back from the collection.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'rejected' })
  );
  const employer = await client.authed('employer-1');

  const res = await employer.post('/applications/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 'Replace washer',
      taskDescription: 'Fit a new washer',
      dueDate: '2026-10-01',
    },
  });

  assert.equal(res.status, 403);
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});

// --------------------------------------------------------- profile ownership

test('a user can still update their own profile', async () => {
  client.seed('users', 'user-1', user({ uid: 'user-1' }));
  const api = await client.authed('user-1');

  const res = await api.put('/users/update/user-1', { body: { fullName: 'Renamed' } });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('users', 'user-1').fullName, 'Renamed');
});

test('a user cannot update another user\'s profile', async () => {
  client.seed('users', 'attacker', user({ uid: 'attacker' }));
  client.seed('users', 'victim', user({ uid: 'victim' }));
  const attacker = await client.authed('attacker');

  const res = await attacker.put('/users/update/victim', { body: { fullName: 'Hacked' } });

  assert.equal(res.status, 403);
  assert.notEqual(client.readDoc('users', 'victim').fullName, 'Hacked');
});

test('a user cannot escalate their own role or overwrite their uid', async () => {
  client.seed('users', 'user-1', user({ uid: 'user-1', role: 'employee' }));
  const api = await client.authed('user-1');

  const res = await api.put('/users/update/user-1', {
    body: { role: 'admin', uid: 'spoofed', isSuperUser: true, fullName: 'Still fine' },
  });

  assert.equal(res.status, 200);
  const stored = client.readDoc('users', 'user-1');
  assert.equal(stored.role, 'employee', 'role must not be self-assignable');
  assert.equal(stored.uid, 'user-1', 'uid must not be writable');
  assert.equal(stored.isSuperUser, undefined, 'unknown fields must be dropped');
  assert.equal(stored.fullName, 'Still fine', 'allowlisted fields must still save');
});

test('a user can still read another user\'s public profile', async () => {
  // STAGE 5C: this test used to assert `res.body.user.uid === 'victim'` on a
  // cross-user read, which is the Stage 5A finding itself -- the raw uid of a
  // third party. Cross-user reads are still allowed, because JobSplitView.jsx
  // needs the job poster's name, avatar, location, join date, rating and bio;
  // the uid is not among them. The test keeps its original intent (cross-user
  // access is not revoked) and now pins the narrower payload.
  client.seed('users', 'victim', user({
    uid: 'victim',
    fullName: 'Victim Person',
    location: 'Abuja',
    bio: 'Hire me for plumbing',
    email: 'victim@private.example.test',
    phone: '+2348012345678',
    role: 'employer',
  }));
  const api = await client.authed('employee-1');

  const res = await api.get('/users/getUser/victim');

  assert.equal(res.status, 200);
  assert.equal(res.body.user.uid, undefined, 'a third party uid must not be readable');
  assert.equal(res.body.user.email, undefined, 'a third party email must not be readable');
  assert.equal(res.body.user.phone, undefined, 'a third party phone must not be readable');
  assert.equal(res.body.user.role, undefined, 'a third party role must not be readable');
  assert.equal(res.body.user.fullName, 'Victim Person');
  assert.equal(res.body.user.location, 'Abuja');
  assert.equal(res.body.user.bio, 'Hire me for plumbing');
});
