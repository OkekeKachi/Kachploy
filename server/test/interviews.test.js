'use strict';

/**
 * Stage 7C tests for the interviews resource.
 *
 * An interview belongs to an application. It is created by the employer who posted
 * that application's job, may be changed only by that same employer, and may be read
 * by either party to the application.
 *
 * The suite covers what Stage 7C has to get right:
 *   1. creation: the stored document, the server-owned fields, and the fact that
 *      identity comes from the token and the application rather than the body
 *   2. validation: required fields, the type and status allow-lists, and the
 *      application/job relationship rules
 *   3. authorization: employer-only writes, on both the create and the update
 *   4. employee reads of their own application's interviews, and the refusal of
 *      everyone else's
 *   5. status changes, and that they do not reach any other collection
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, interview } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;
const now = () => '2026-01-01T00:00:00.000Z';

test.before(async () => {
  client = await startTestServer({ clock: now });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  // Fixtures use postedBy: 'employer-1' and employeeId: 'employee-1'.
  employerApi = await client.authed('employer-1');
  employeeApi = await client.authed('employee-1');
});

/** Every interview document currently stored, as an array. */
const interviews = () => Object.values(client.readAll('interviews'));

/** Seeds employer-1's job and employee-1's pending application to it. */
function seedJobWithApplication(jobOverrides = {}, applicationOverrides = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1', ...jobOverrides }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'pending', ...applicationOverrides })
  );
}

/** Seeds two interviews: one on app-1, one on a second application for job-1. */
function seedInterviews() {
  seedJobWithApplication();
  client.seed(
    'applications',
    'app-2',
    application({ jobId: 'job-1', employeeId: 'employee-2', status: 'pending' })
  );
  client.seed('interviews', 'int-1', interview());
  client.seed(
    'interviews',
    'int-2',
    interview({ applicationId: 'app-2', employeeId: 'employee-2' })
  );
}

const validCreate = {
  applicationId: 'app-1',
  jobId: 'job-1',
  scheduledAt: '2026-10-02T10:00:00.000Z',
  type: 'online',
};

/** The create call under test. Defaults to the minimal valid body. */
const create = (body = validCreate, api = employerApi) => api.post('/interviews', { body });

// ---------------------------------------------------------------------------
// 1. Creation.
// ---------------------------------------------------------------------------

test('an employer can schedule an interview for an application', async () => {
  seedJobWithApplication();

  const res = await create();

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Interview created successfully');
  assert.ok(res.body.interviewId);

  assert.equal(interviews().length, 1);
  const [record] = interviews();
  assert.equal(record.applicationId, 'app-1');
  assert.equal(record.jobId, 'job-1');
  assert.equal(record.employerId, 'employer-1');
  assert.equal(record.employeeId, 'employee-1');
  assert.equal(record.scheduledAt, '2026-10-02T10:00:00.000Z');
  assert.equal(record.type, 'online');
});

test('a new interview starts scheduled', async () => {
  seedJobWithApplication();

  await create();

  assert.equal(interviews()[0].status, 'scheduled');
});

test('a new interview is stamped with server timestamps for createdAt and updatedAt', async () => {
  seedJobWithApplication();

  await create();

  // STAGE 7C uses FieldValue.serverTimestamp(), the same choice Stage 5H made for
  // tasks.createdDate and applications.dateApplied, so the value is committed by
  // Firestore against the injected clock and cannot be skewed by a host clock.
  const [record] = interviews();
  assert.deepEqual(record.createdAt, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.deepEqual(record.updatedAt, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.equal(record.createdAt instanceof Date, false, 'a Timestamp is not a Date');
});

test('the optional fields are stored when supplied', async () => {
  seedJobWithApplication();

  await create({
    ...validCreate,
    type: 'in_person',
    duration: 45,
    meetingLink: 'https://example.test/room',
    location: 'Lagos, Nigeria',
  });

  const [record] = interviews();
  assert.equal(record.type, 'in_person');
  assert.equal(record.duration, 45);
  assert.equal(record.meetingLink, 'https://example.test/room');
  assert.equal(record.location, 'Lagos, Nigeria');
});

test('an interview stores no key for an optional field that was not supplied', async () => {
  seedJobWithApplication();

  await create();

  // Firestore has no `undefined`, so an absent optional field is omitted rather
  // than written as null. Asserted as an exact key set so a stray field cannot slip
  // in either.
  const [record] = interviews();
  assert.deepEqual(Object.keys(record).sort(), [
    'applicationId',
    'createdAt',
    'employeeId',
    'employerId',
    'jobId',
    'scheduledAt',
    'status',
    'type',
    'updatedAt',
  ]);
  assert.equal('duration' in record, false);
  assert.equal('meetingLink' in record, false);
  assert.equal('location' in record, false);
});

test('the applicant on the interview is read from the application, not the body', async () => {
  seedJobWithApplication();

  const res = await create({ ...validCreate, employeeId: 'attacker', employerId: 'attacker' });

  // Both identity fields belong to the server: employerId from the verified token,
  // employeeId from the application document. A body field of either name is
  // ignored rather than honoured.
  assert.equal(res.status, 200);
  const [record] = interviews();
  assert.equal(record.employerId, 'employer-1');
  assert.equal(record.employeeId, 'employee-1');
});

test('a client-supplied status is ignored on create', async () => {
  seedJobWithApplication();

  await create({ ...validCreate, status: 'completed' });

  // `scheduled` is server-owned: an interview cannot be born completed.
  assert.equal(interviews()[0].status, 'scheduled');
});

test('an interview is accepted for an application whose status is not pending', async () => {
  seedJobWithApplication({}, { status: 'accepted' });

  // There is no interview-related application status in this stage, so an interview
  // for an already-accepted (hired) application is a legitimate record rather than a
  // contradiction. Nothing here consults the application status at all.
  const res = await create();

  assert.equal(res.status, 200);
  assert.equal(interviews().length, 1);
});

// ---------------------------------------------------------------------------
// 2. Validation.
// ---------------------------------------------------------------------------

test('creation requires applicationId, jobId, scheduledAt and type', async () => {
  seedJobWithApplication();

  for (const field of ['applicationId', 'jobId', 'scheduledAt', 'type']) {
    const body = { ...validCreate };
    delete body[field];

    const res = await create(body);

    assert.equal(res.status, 400, `expected 400 when ${field} is missing`);
    assert.equal(res.body.message, 'Missing required fields');
  }

  assert.deepEqual(interviews(), [], 'nothing may be stored');
});

test('creation rejects a type outside the allow-list', async () => {
  seedJobWithApplication();

  for (const type of ['phone', 'OnLine', 'video', 'anything']) {
    const res = await create({ ...validCreate, type });

    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(type)}`);
    assert.equal(res.body.message, 'Invalid type. Must be one of: online, in_person.');
  }

  assert.deepEqual(interviews(), []);
});

test('a blank required field is reported as missing rather than invalid', async () => {
  seedJobWithApplication();

  // An empty string is a missing value, so it is caught by the required-field check
  // before the allow-list one -- the same 'Missing required fields' answer POST /tasks
  // gives for an empty required field, and more honest than naming an invalid type.
  for (const field of ['type', 'scheduledAt']) {
    const res = await create({ ...validCreate, [field]: '' });

    assert.equal(res.status, 400, `expected 400 for a blank ${field}`);
    assert.equal(res.body.message, 'Missing required fields');
  }

  assert.deepEqual(interviews(), []);
});

test('creation accepts both canonical types', async () => {
  seedJobWithApplication();

  for (const [index, type] of ['online', 'in_person'].entries()) {
    const res = await create({ ...validCreate, type });

    assert.equal(res.status, 200, `expected 200 for ${type}`);
    assert.equal(interviews().length, index + 1);
    assert.equal(interviews()[index].type, type);
  }
});

test('creation rejects an unparseable scheduledAt', async () => {
  seedJobWithApplication();

  for (const scheduledAt of ['not a date', 'tomorrow-ish', '   ']) {
    const res = await create({ ...validCreate, scheduledAt });

    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(scheduledAt)}`);
    assert.equal(
      res.body.message,
      'Invalid scheduledAt. It must be a parseable date or time string.'
    );
  }

  assert.deepEqual(interviews(), []);
});

test('creation accepts a date string, a datetime string and a past instant', async () => {
  seedJobWithApplication();

  for (const scheduledAt of ['2026-10-02', '2026-10-02T10:00:00.000Z', '2020-01-01T00:00:00.000Z']) {
    const res = await create({ ...validCreate, scheduledAt });

    // Nothing checks the future: rescheduling into the past is how a correction
    // gets made, and a client clock is not worth holding an interview hostage to.
    assert.equal(res.status, 200, `expected 200 for ${scheduledAt}`);
  }
});

test('creation rejects a duration that is not a positive number of minutes', async () => {
  seedJobWithApplication();

  for (const duration of [0, -30, '45', NaN, Infinity, null, true]) {
    const res = await create({ ...validCreate, duration });

    assert.equal(res.status, 400, `expected 400 for ${String(duration)}`);
    assert.equal(
      res.body.message,
      'Invalid duration. It must be a positive number of minutes.'
    );
  }

  assert.deepEqual(interviews(), []);
});

test('creation rejects a blank meeting link or location', async () => {
  seedJobWithApplication();

  for (const field of ['meetingLink', 'location']) {
    const res = await create({ ...validCreate, [field]: '' });

    assert.equal(res.status, 400, `expected 400 for a blank ${field}`);
    assert.equal(res.body.message, `Invalid ${field}. It must be a non-empty string or null.`);
  }

  assert.deepEqual(interviews(), []);
});

test('creation is refused for an application that does not exist', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));

  const res = await create({ ...validCreate, applicationId: 'ghost-app' });

  // The guard loads the application before the handler runs, so this is a 404 from
  // the guard rather than from the service's own existence check.
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Application not found');
  assert.deepEqual(interviews(), []);
});

test('creation is refused for an application whose job does not exist', async () => {
  client.seed('applications', 'app-1', application({ jobId: 'ghost-job', status: 'pending' }));

  const res = await create({ ...validCreate, jobId: 'ghost-job' });

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
  assert.deepEqual(interviews(), []);
});

test('creation is refused when the jobId does not match the application\'s job', async () => {
  // The caller owns BOTH jobs here, so nothing is being withheld from them: the
  // request is simply incoherent. An interview whose applicationId and jobId point
  // at two different employers would be invisible to each side's own query.
  seedJobWithApplication();
  client.seed('jobs', 'job-2', job({ postedBy: 'employer-1', title: 'A second job' }));

  const res = await create({ ...validCreate, jobId: 'job-2' });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "Interview jobId does not match the application's jobId");
  assert.deepEqual(interviews(), []);
});

test('creation requires authentication', async () => {
  seedJobWithApplication();

  const res = await create(validCreate, client);

  assert.equal(res.status, 401);
  assert.deepEqual(interviews(), []);
});

// ---------------------------------------------------------------------------
// 3. Authorization on writes.
// ---------------------------------------------------------------------------

test('an applicant cannot schedule an interview on their own application', async () => {
  seedJobWithApplication();

  // The requirement is one-directional: an applicant may read the interviews on
  // their application but never create or change one. Signed in as employee-1, who
  // owns app-1 but did not post the job it belongs to.
  const res = await create(validCreate, employeeApi);

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to create interviews for this job');
  assert.deepEqual(interviews(), []);
});

test('an employer who does not own the job cannot schedule an interview', async () => {
  seedJobWithApplication();
  const stranger = await client.authed('employer-2');

  const res = await create(validCreate, stranger);

  assert.equal(res.status, 403);
  assert.deepEqual(interviews(), []);
});

test('the create guard refuses a missing applicationId before reading anything', async () => {
  seedJobWithApplication();

  const res = await create({ jobId: 'job-1', scheduledAt: '2026-10-02T10:00:00.000Z', type: 'online' });

  // The guard is body-based, so a missing subject is answered the same way
  // requireTaskAssignment answers it on POST /tasks.
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Missing required fields');
  assert.deepEqual(interviews(), []);
});

test('only the owning employer can update an interview', async () => {
  seedInterviews();

  const stranger = await client.authed('employer-2');
  const res = await stranger.put('/interviews/int-1', { body: { status: 'cancelled' } });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to modify this interview');
  assert.equal(client.readDoc('interviews', 'int-1').status, 'scheduled');
});

test('the applicant cannot update an interview on their own application', async () => {
  seedInterviews();

  // This is the requirement-6 boundary: employee-1 may read int-1 and is refused
  // every attempt to change it, however they phrase the request.
  const res = await employeeApi.put('/interviews/int-1', { body: { status: 'cancelled' } });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to modify this interview');
  assert.equal(client.readDoc('interviews', 'int-1').status, 'scheduled');
});

test('an update for a missing interview is a 404', async () => {
  seedInterviews();

  const res = await employerApi.put('/interviews/ghost', { body: { status: 'completed' } });

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Interview not found');
});

test('update requires authentication', async () => {
  seedInterviews();

  const res = await client.put('/interviews/int-1', { body: { status: 'completed' } });

  assert.equal(res.status, 401);
  assert.equal(client.readDoc('interviews', 'int-1').status, 'scheduled');
});

// ---------------------------------------------------------------------------
// 4. Reads.
// ---------------------------------------------------------------------------

test('an employee can read the interviews on their own application', async () => {
  seedInterviews();

  const res = await employeeApi.get('/interviews/application/app-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.interviews.length, 1);

  const [only] = res.body.interviews;
  assert.equal(only.id, 'int-1');
  assert.equal(only.applicationId, 'app-1');
  assert.equal(only.jobId, 'job-1');
  assert.equal(only.employerId, 'employer-1');
  assert.equal(only.employeeId, 'employee-1');
  assert.equal(only.scheduledAt, '2026-10-02T10:00:00.000Z');
  assert.equal(only.type, 'online');
  assert.equal(only.status, 'scheduled');
});

test('an employer can read the interviews on an application they own', async () => {
  seedInterviews();

  // The same route, the other branch of requireInterviewParty.
  const res = await employerApi.get('/interviews/application/app-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.interviews.length, 1);
  assert.equal(res.body.interviews[0].id, 'int-1');
});

test('an employee cannot read the interviews on another employee\'s application', async () => {
  seedInterviews();
  const employee2 = await client.authed('employee-2');

  // int-2 belongs to employee-2, so the refusal is about identity, not about the
  // query being empty.
  assert.equal(client.readDoc('interviews', 'int-2').employeeId, 'employee-2');

  const res = await employee2.get('/interviews/application/app-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to view interviews for this application');
  assert.equal(res.body.interviews, undefined, 'no interview data may leak in a 403 body');
});

test('an employer cannot read another employer\'s application interviews', async () => {
  seedInterviews();
  const stranger = await client.authed('employer-2');

  const res = await stranger.get('/interviews/application/app-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.interviews, undefined);
});

test('an unrelated authenticated user cannot read application interviews', async () => {
  seedInterviews();
  const stranger = await client.authed('attacker');

  const res = await stranger.get('/interviews/application/app-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.interviews, undefined);
});

test('an application read returns 404 for an application that does not exist', async () => {
  const res = await employeeApi.get('/interviews/application/ghost-app');

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Application not found');
});

test('an application read returns an empty list when no interview has been arranged', async () => {
  seedJobWithApplication();

  const res = await employeeApi.get('/interviews/application/app-1');

  // The application exists and simply has no interview yet, so this is an empty 200
  // rather than a 404 -- the same rule the tasks and employments lists follow.
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interviews, []);
});

test('an employer can list every interview on their job across applicants', async () => {
  seedInterviews();

  const res = await employerApi.get('/interviews/job/job-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interviews.map((i) => i.id).sort(), ['int-1', 'int-2']);
});

test('a job list is scoped to one job', async () => {
  seedInterviews();
  client.seed('jobs', 'job-2', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-3',
    application({ jobId: 'job-2', employeeId: 'employee-3', status: 'pending' })
  );
  client.seed(
    'interviews',
    'int-3',
    interview({ applicationId: 'app-3', jobId: 'job-2', employeeId: 'employee-3' })
  );

  const res = await employerApi.get('/interviews/job/job-1');

  assert.deepEqual(res.body.interviews.map((i) => i.id).sort(), ['int-1', 'int-2']);
});

test('a job list refuses an employer who does not own the job', async () => {
  seedInterviews();
  const stranger = await client.authed('employer-2');

  const res = await stranger.get('/interviews/job/job-1');

  assert.equal(res.status, 403);
  // A read, so the 403 must describe a read restriction -- not the write-oriented
  // "modify this job" wording that Stage 6S and 6T replaced.
  assert.equal(
    res.body.message,
    'You do not have permission to view interviews for this job'
  );
  assert.equal(res.body.message.includes('modify'), false);
  assert.equal(res.body.interviews, undefined);
});

test('the applicant is refused the job-wide list', async () => {
  seedInterviews();

  // employee-1 is party to int-1 but the job-wide view is the employer's; their own
  // interviews come from /application/app-1.
  const res = await employeeApi.get('/interviews/job/job-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.interviews, undefined);
});

test('a job list returns 404 for a job that does not exist', async () => {
  const res = await employerApi.get('/interviews/job/ghost-job');

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
});

test('a job list returns an empty list for a job with no interviews', async () => {
  seedJobWithApplication();

  const res = await employerApi.get('/interviews/job/job-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.interviews, []);
});

test('all three reads require authentication', async () => {
  seedInterviews();

  const byApplication = await client.get('/interviews/application/app-1');
  const byJob = await client.get('/interviews/job/job-1');
  const created = await client.post('/interviews', { body: validCreate });

  // `protect` answers 401 with plain text, not JSON, as it always has.
  assert.equal(byApplication.status, 401);
  assert.equal(byJob.status, 401);
  assert.equal(created.status, 401);
});

test('the reads return the stored document unreshaped', async () => {
  seedInterviews();

  const res = await employeeApi.get('/interviews/application/app-1');
  const stored = client.readDoc('interviews', 'int-1');

  // The read adds the document id and nothing else: no field is renamed, dropped or
  // normalised, so a client sees exactly what was written.
  assert.deepEqual(res.body.interviews[0], { id: 'int-1', ...stored });
});

test('an interview created through the API is immediately readable by both parties', async () => {
  seedJobWithApplication();

  const created = await create();
  assert.equal(created.status, 200);

  const byEmployee = await employeeApi.get('/interviews/application/app-1');
  const byEmployer = await employerApi.get('/interviews/job/job-1');

  assert.equal(byEmployee.status, 200);
  assert.equal(byEmployer.status, 200);
  assert.equal(byEmployee.body.interviews[0].id, created.body.interviewId);
  assert.equal(byEmployer.body.interviews[0].id, created.body.interviewId);
});

// ---------------------------------------------------------------------------
// 5. Status changes and detail updates.
// ---------------------------------------------------------------------------

test('an employer can complete, cancel or mark an interview a no-show', async () => {
  seedInterviews();

  // One endpoint serves all three: Stage 7C specifies no separate routes for them,
  // and `status` is in the updatable-field allow-list.
  for (const status of ['completed', 'cancelled', 'no_show']) {
    const res = await employerApi.put('/interviews/int-1', { body: { status } });

    assert.equal(res.status, 200, `expected 200 for ${status}`);
    assert.equal(res.body.message, 'Interview updated successfully');
    assert.equal(client.readDoc('interviews', 'int-1').status, status);
  }
});

test('an update rejects a status outside the allow-list', async () => {
  seedInterviews();

  for (const status of ['interviewing', 'Completed', 'no-show', 'done', '', null]) {
    const res = await employerApi.put('/interviews/int-1', { body: { status } });

    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(status)}`);
    assert.equal(
      res.body.message,
      'Invalid status. Must be one of: scheduled, completed, cancelled, no_show.'
    );
  }

  assert.equal(client.readDoc('interviews', 'int-1').status, 'scheduled');
});

test('an update can reschedule an interview and refresh updatedAt', async () => {
  seedInterviews();

  const res = await employerApi.put('/interviews/int-1', {
    body: { scheduledAt: '2026-11-01T09:30:00.000Z', duration: 30 },
  });

  assert.equal(res.status, 200);
  const stored = client.readDoc('interviews', 'int-1');
  assert.equal(stored.scheduledAt, '2026-11-01T09:30:00.000Z');
  assert.equal(stored.duration, 30);
  // A partial update: the fields absent from the body are left exactly as stored.
  assert.equal(stored.type, 'online');
  assert.equal(stored.status, 'scheduled');
});

test('an update changes only the fields it names', async () => {
  seedInterviews();

  await employerApi.put('/interviews/int-1', { body: { location: 'Lagos, Nigeria' } });

  const stored = client.readDoc('interviews', 'int-1');
  assert.equal(stored.location, 'Lagos, Nigeria');
  assert.equal(stored.scheduledAt, '2026-10-02T10:00:00.000Z');
  assert.equal(stored.type, 'online');
  assert.equal(stored.status, 'scheduled');
  assert.equal(stored.createdAt instanceof Object, true, 'createdAt is untouched');
});

test('an optional detail may be cleared with an explicit null', async () => {
  seedInterviews();
  client.seed(
    'interviews',
    'int-clear',
    interview({ meetingLink: 'https://example.test/room', location: 'Lagos, Nigeria' })
  );

  const res = await employerApi.put('/interviews/int-clear', {
    body: { meetingLink: null, location: null },
  });

  // JSON cannot express `undefined`, so null is unambiguous: it means "clear this".
  assert.equal(res.status, 200);
  const stored = client.readDoc('interviews', 'int-clear');
  assert.equal(stored.meetingLink, null);
  assert.equal(stored.location, null);
});

test('an update cannot change the identities or the creation time', async () => {
  seedInterviews();
  const before = client.readDoc('interviews', 'int-1');

  const res = await employerApi.put('/interviews/int-1', {
    body: {
      status: 'completed',
      applicationId: 'app-2',
      jobId: 'job-2',
      employerId: 'attacker',
      employeeId: 'attacker',
      createdAt: { _seconds: 0, _nanoseconds: 0 },
      somethingUnknown: 'dropped',
    },
  });

  assert.equal(res.status, 200);
  const after = client.readDoc('interviews', 'int-1');

  // The five fields that say what this interview is are not in
  // UPDATABLE_INTERVIEW_FIELDS, so a body key of that name is dropped rather than
  // honoured -- and `somethingUnknown` with them.
  assert.equal(after.applicationId, before.applicationId);
  assert.equal(after.jobId, before.jobId);
  assert.equal(after.employerId, before.employerId);
  assert.equal(after.employeeId, before.employeeId);
  assert.deepEqual(after.createdAt, before.createdAt);
  assert.equal('somethingUnknown' in after, false);
  assert.equal(after.status, 'completed', 'the one updatable field present was applied');
});

test('an update with no updatable field is refused', async () => {
  seedInterviews();

  for (const body of [{}, { applicationId: 'app-2' }, { createdAt: '2020-01-01' }]) {
    const res = await employerApi.put('/interviews/int-1', { body });

    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(res.body.message, 'Missing fields to update');
  }
});

test('an update rejects an invalid detail value', async () => {
  seedInterviews();

  const cases = [
    [{ type: 'phone' }, 'Invalid type. Must be one of: online, in_person.'],
    [{ duration: -1 }, 'Invalid duration. It must be a positive number of minutes.'],
    [{ scheduledAt: 'whenever' }, 'Invalid scheduledAt. It must be a parseable date or time string.'],
    [{ location: '' }, 'Invalid location. It must be a non-empty string or null.'],
  ];

  for (const [body, message] of cases) {
    const res = await employerApi.put('/interviews/int-1', { body });

    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(res.body.message, message);
  }

  assert.equal(client.readDoc('interviews', 'int-1').status, 'scheduled');
});

test('an update can be repeated, including back to an earlier status', async () => {
  seedInterviews();

  // An allow-list, not a transition matrix -- the same deliberate choice Stage 5G
  // made for application statuses. A recorded no-show can still be corrected.
  await employerApi.put('/interviews/int-1', { body: { status: 'no_show' } });
  await employerApi.put('/interviews/int-1', { body: { status: 'completed' } });
  await employerApi.put('/interviews/int-1', { body: { status: 'completed' } });

  assert.equal(client.readDoc('interviews', 'int-1').status, 'completed');
});

// ---------------------------------------------------------------------------
// Isolation from the rest of the domain.
// ---------------------------------------------------------------------------

test('scheduling an interview does not change the application', async () => {
  seedJobWithApplication();
  const before = client.readDoc('applications', 'app-1');

  await create();

  // Stage 7C adds no application status, so there is nothing here to write.
  assert.deepEqual(client.readDoc('applications', 'app-1'), before);
});

test('no interview creates an employment, however many are scheduled', async () => {
  seedJobWithApplication();

  await create();
  await create();

  // Requirement: employment remains created only when the application is actually
  // hired, and the hire is an application-status write. Nothing in the interview
  // path imports employmentService.
  assert.equal(interviews().length, 2);
  assert.deepEqual(client.readAll('employments'), {});
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
});

test('updating an interview does not touch any other collection', async () => {
  seedInterviews();
  const appBefore = client.readDoc('applications', 'app-1');
  const jobBefore = client.readDoc('jobs', 'job-1');

  await employerApi.put('/interviews/int-1', {
    body: { status: 'cancelled', location: 'Lagos, Nigeria' },
  });

  assert.deepEqual(client.readDoc('applications', 'app-1'), appBefore);
  assert.deepEqual(client.readDoc('jobs', 'job-1'), jobBefore);
  assert.deepEqual(client.readAll('employments'), {});
  assert.deepEqual(client.readAll('tasks'), {});
});

test('an interview created before the hire survives the hire unchanged', async () => {
  seedJobWithApplication();
  await create();
  const before = interviews()[0];

  await employerApi.put('/applications/app-1/status', { body: { status: 'accepted' } });

  // The hire creates an employment (Stage 7A) and leaves the interview alone: the
  // two domains do not write to each other in either direction.
  assert.equal(Object.keys(client.readAll('employments')).length, 1);
  assert.deepEqual(interviews()[0], before);
  assert.equal(interviews()[0].status, 'scheduled');
});