'use strict';

/**
 * Stage 7A tests for the employments resource.
 *
 * An employment is the record of the relationship created when an employer hires
 * an applicant. It has no create endpoint of its own: it exists as a consequence
 * of the hire, which in this codebase is the client-orchestrated three-call
 * sequence in ViewJobApplications.jsx. So the only server-side step that can
 * identify both parties is the first of those calls --
 * PUT /applications/:id/status with `accepted` -- and that is where these tests
 * drive the flow from.
 *
 * The suite covers the four things Stage 7A has to get right:
 *   1. a successful hire records an employment, with the required fields, an
 *      `active` status and a null endDate
 *   2. a hire that fails records nothing, for every way the existing flow can fail
 *   3. each party can read their own employments
 *   4. neither party can read the other's
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, employment } = require('../testing/fixtures');

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

/** Every employment document currently stored, as an array. */
const employments = () => Object.values(client.readAll('employments'));

/**
 * Seeds the job employer-1 posted and employee-1's application to it, in the
 * state a hire starts from: the application is pending.
 */
function seedPendingApplication(jobOverrides = {}, applicationOverrides = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1', ...jobOverrides }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'pending', ...applicationOverrides })
  );
}

/**
 * STAGE 7G-1: the same seed, with the application `interviewed` instead.
 *
 * This is now the state a hire starts from. `accepted` is refused unless the
 * application is `interviewed` or already `accepted`, so every test in this file
 * that expects a hire to succeed seeds through here. `seedPendingApplication` is
 * kept because the refusal tests still need an application that has NOT been
 * cleared for hiring -- rejecting, writing pending, an unknown status, a missing
 * status and every authorization failure all legitimately start from `pending`,
 * and none of them reaches the gate.
 */
function seedInterviewedApplication(jobOverrides = {}, applicationOverrides = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1', ...jobOverrides }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'interviewed', ...applicationOverrides })
  );
}

/** The single hire call under test. */
const hire = (status = 'accepted', applicationId = 'app-1') =>
  employerApi.put(`/applications/${applicationId}/status`, { body: { status } });

// ---------------------------------------------------------------------------
// 1. A successful hire records an employment.
// ---------------------------------------------------------------------------

test('accepting an application records an employment for the hired applicant', async () => {
  seedInterviewedApplication();

  const res = await hire();

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Status updated successfully');
  // The hire's own behaviour is unchanged by Stage 7A.
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');

  assert.equal(employments().length, 1);
  const [record] = employments();
  assert.equal(record.employerId, 'employer-1');
  assert.equal(record.employeeId, 'employee-1');
  assert.equal(record.jobId, 'job-1');
  assert.equal(record.applicationId, 'app-1');
});

test('a new employment starts active with no end date', async () => {
seedInterviewedApplication();

  await hire();

  const [record] = employments();
  assert.equal(record.status, 'active');
  assert.equal(record.endDate, null);
  // `ended` is the only other value EMPLOYMENT_STATUSES allows, and nothing in
  // this stage may write it: an employment begins open.
  assert.notEqual(record.status, 'ended');
});

test('an employment stores every required field and nothing else', async () => {
seedInterviewedApplication();

  await hire();

  // The complete stored shape. Asserted as a key set rather than field by field
  // so an invented field (a client-supplied one, or a stray body field leaking
  // into the record) fails here rather than passing unnoticed.
  assert.deepEqual(Object.keys(employments()[0]).sort(), [
    'applicationId',
    'employeeId',
    'employerId',
    'endDate',
    'jobId',
    'startDate',
    'status',
  ]);
});

test('the employment takes its start date from the job', async () => {
seedInterviewedApplication({ jobStartDate: '2026-10-05' });

  await hire();

  // Stored verbatim, the same way jobService persists jobStartDate: parsed,
  // reformatted and defaulted would all be reinterpreting a user-entered value.
  assert.equal(employments()[0].startDate, '2026-10-05');
});

test('the employment falls back to a server timestamp when the job has no start date', async () => {
seedInterviewedApplication({ jobStartDate: undefined });

  await hire();

  // jobService requires jobStartDate on both create and update, so this is a
  // document that predates that requirement or was written outside jobService
  // rather than one POST /jobs/create can produce. Firestore rejects an
  // `undefined` field value, so the hire must not fail on it: the application is
  // already accepted by this point and there is no transaction to undo that. The
  // fallback is committed by Firestore (the Stage 5H change), so it resolves
  // against the injected clock rather than the Node process clock.
  const [record] = employments();
  assert.deepEqual(record.startDate, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.equal(record.startDate instanceof Date, false, 'a Timestamp is not a Date');
});

test('the employment ignores any employment field sent in the request body', async () => {
  seedInterviewedApplication();

  const res = await employerApi.put('/applications/app-1/status', {
    body: {
      status: 'accepted',
      employerId: 'attacker',
      employeeId: 'attacker',
      jobId: 'job-2',
      applicationId: 'app-2',
      startDate: '1999-01-01',
      endDate: '1999-12-31',
      status2: 'ended',
    },
  });

  // The hire succeeds and every identity field comes from the token, the loaded
  // application and the loaded job. Nothing in the body can redirect the record.
  assert.equal(res.status, 200);
  const [record] = employments();
  assert.equal(record.employerId, 'employer-1');
  assert.equal(record.employeeId, 'employee-1');
  assert.equal(record.jobId, 'job-1');
  assert.equal(record.applicationId, 'app-1');
  assert.equal(record.startDate, '2026-10-05');
  assert.equal(record.endDate, null);
  assert.equal(record.status, 'active');
});

test('rejecting an application records no employment', async () => {
  seedPendingApplication();

  const res = await hire('rejected');

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'rejected');
  // Most of a hire is rejections: ViewJobApplications.jsx restatuses every other
  // applicant in the same operation, and none of those may produce a record.
  assert.deepEqual(employments(), []);
});

test('a pending status records no employment', async () => {
  seedPendingApplication();

  await hire('pending');

  assert.deepEqual(employments(), []);
});

test('accepting an already-accepted application does not record a second employment', async () => {
seedInterviewedApplication();
  await hire();
  assert.equal(employments().length, 1);

  // Stage 5G made the statuses an allow-list and not a transition matrix, so an
  // employer may write `accepted` to an application that already holds it, any
  // number of times. Each such write must not append another record for one hire.
  await hire();

  assert.equal(employments().length, 1);
});

// ---------------------------------------------------------------------------
// 2. A hire that fails records nothing.
// ---------------------------------------------------------------------------

test('a rejected status value records no employment', async () => {
  seedPendingApplication();

  const res = await hire('Employed');

  assert.equal(res.status, 400);
  // STAGE 7G-1: the allow-list gained `interviewed`, and this message is generated
  // from APPLICATION_STATUSES, so the exact string moved. The value under test is
  // still refused as an unrecognised status, not by the hire gate: `Employed` fails
  // the allow-list check, which runs first.
  assert.equal(res.body.message, 'Invalid status. Must be one of: pending, interviewed, accepted, rejected.');
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
  assert.deepEqual(employments(), [], 'the validation failure precedes the write');
});

test('a missing status records no employment', async () => {
  seedPendingApplication();

  const res = await employerApi.put('/applications/app-1/status', { body: {} });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Status is required');
  assert.deepEqual(employments(), []);
});

test('an employer who does not own the job records no employment', async () => {
  seedPendingApplication();
  const stranger = await client.authed('attacker');

  const res = await stranger.put('/applications/app-1/status', { body: { status: 'accepted' } });

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to modify this application');
  assert.deepEqual(employments(), []);
});

test('the applicant themselves recording their own acceptance is refused', async () => {
  seedPendingApplication();

  // The employee cannot hire themselves: only the employer who posted the job may
  // review an application, so the guard answers before the hire write.
  const res = await employeeApi.put('/applications/app-1/status', { body: { status: 'accepted' } });

  assert.equal(res.status, 403);
  assert.deepEqual(employments(), []);
});

test('a missing application records no employment', async () => {
  const res = await hire('accepted', 'ghost-app');

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Application not found');
  assert.deepEqual(employments(), []);
});

test('an application whose job no longer exists records no employment', async () => {
  // The guard loads the application and then its job, so a job deleted out from
  // under an application is a 404 from the guard rather than an employment
  // pointing at a job that is not there.
  client.seed('applications', 'app-1', application({ jobId: 'ghost-job', status: 'pending' }));

  const res = await hire();

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
  assert.deepEqual(employments(), []);
});

test('an unauthenticated hire records no employment', async () => {
  seedPendingApplication();

  const res = await client.put('/applications/app-1/status', { body: { status: 'accepted' } });

  assert.equal(res.status, 401);
  assert.deepEqual(employments(), []);
});

test('a hire that is refused still writes the application status it asked for, or nothing at all', async () => {
  seedInterviewedApplication();
  client.seed(
    'applications',
    'app-2',
    application({ jobId: 'job-1', employeeId: 'employee-2', status: 'pending' })
  );

  // The shape of a real hire: one accepted, the rest rejected. Exactly one
  // employment results, for the accepted one.
  await Promise.all([hire(), employerApi.put('/applications/app-2/status', { body: { status: 'rejected' } })]);

  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
  assert.equal(client.readDoc('applications', 'app-2').status, 'rejected');
  assert.equal(employments().length, 1);
  assert.equal(employments()[0].applicationId, 'app-1');
});

// ---------------------------------------------------------------------------
// 4. STAGE 7G-1: the lifecycle gate and what it does not create.
// ---------------------------------------------------------------------------

test('clearing an application for hiring records no employment', async () => {
  seedPendingApplication();

  const res = await hire('interviewed');

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'interviewed');
  // `interviewed` means the applicant may now be hired. It is emphatically not a
  // hire: an employment is created by `accepted` and by nothing else, so the
  // intermediate state the gate introduces cannot start an employment early.
  assert.deepEqual(employments(), []);
});

test('hiring an application that is not cleared for hiring records no employment', async () => {
  seedPendingApplication();

  const res = await hire();

  assert.equal(res.status, 400);
  // The gate refuses before the status write, so the application is untouched...
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
  // ...and, because the status write is what triggers the employment, no record
  // exists either. The two assertions are the same fact seen from both sides.
  assert.deepEqual(employments(), []);
});

test('clearing for hiring and then hiring records exactly one employment', async () => {
  seedPendingApplication();

  const cleared = await hire('interviewed');
  assert.equal(cleared.status, 200);
  assert.deepEqual(employments(), [], 'the intermediate write creates nothing');

  const hired = await hire();
  assert.equal(hired.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');

  assert.equal(employments().length, 1);
  assert.equal(employments()[0].applicationId, 'app-1');
});

test('a refused premature hire can be corrected by clearing for hiring and retrying', async () => {
  seedPendingApplication();

  const premature = await hire();
  assert.equal(premature.status, 400);

  const cleared = await hire('interviewed');
  assert.equal(cleared.status, 200);

  const retried = await hire();
  assert.equal(retried.status, 200);

  // The gate is a precondition, not a terminal state: an employer who hit it is
  // never locked out of hiring, they just have to clear the applicant first. Only
  // one employment results, because there was only one accepted write.
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
  assert.equal(employments().length, 1);
});

test('re-sending a hire for an already-hired application records no second employment', async () => {
  seedInterviewedApplication();
  await hire();
  assert.equal(employments().length, 1);

  // STAGE 7G-1: the gate exempts an application that is already `accepted`, so this
  // retry -- the one ViewJobApplications.jsx performs after a partial failure --
  // still succeeds, and employmentService's own previousStatus guard still holds.
  const res = await hire();

  assert.equal(res.status, 200);
  assert.equal(employments().length, 1);
});

// ---------------------------------------------------------------------------
// STAGE 7H-2: one employment per application.
//
// The 7G-1 tests above cover the paths the employer UI actually walks. These cover
// the duplicate the `previousStatus` inference could not see: an application that
// is rejected and then cleared for hiring and hired again arrives with
// previousStatus `interviewed`, so the inference passed and a second employment was
// written for a single hire. The guard is now a query on the collection instead.
// ---------------------------------------------------------------------------

test('a first hire records exactly one employment', async () => {
  seedInterviewedApplication();

  const res = await hire();

  assert.equal(res.status, 200);
  assert.equal(employments().length, 1);
  assert.equal(employments()[0].applicationId, 'app-1');
  assert.equal(employments()[0].status, 'active');
});

test('hiring again after a rejection records no second employment', async () => {
  // The regression this stage exists for. Every write here succeeds -- the gate
  // permits each one, because before the rejection the application is `accepted`
  // and after the clear it is `interviewed` -- so nothing but the collection check
  // stands between this path and a duplicate.
  seedInterviewedApplication();
  await hire();
  assert.equal(employments().length, 1);

  const rejected = await hire('rejected');
  assert.equal(rejected.status, 200);

  const cleared = await hire('interviewed');
  assert.equal(cleared.status, 200);

  const rehired = await hire();
  assert.equal(rehired.status, 200);

  // The application ends accepted and the hire is not undone -- rejecting an
  // application is not an end-employment write, which is still deferred.
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');

  // One hire, one employment. The first document is untouched: the guard skips the
  // add rather than replacing anything.
  assert.equal(employments().length, 1);
  assert.equal(employments()[0].status, 'active');
  assert.equal(employments()[0].employeeId, 'employee-1');
});

test('an existing employment for the application blocks a second one', async () => {
  // The guard asks the collection rather than the application, so it holds even
  // when the application says nothing useful -- and this seed is chosen so the OLD
  // inference would NOT have caught it. The application is `interviewed`, so
  // previousStatus is `interviewed` rather than `accepted`: the gate permits the
  // hire and the previousStatus guard passes it straight through. Only a query on
  // the collection stands between this and a duplicate. The employment is seeded
  // directly because there is no create endpoint for this resource.
  seedInterviewedApplication();
  client.seed('employments', 'emp-existing', employment({ applicationId: 'app-1' }));
  assert.equal(employments().length, 1);

  const res = await hire();

  // The status write still succeeds and is still reported as a success -- the
  // guard governs the employment, not the application's status.
  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');

  // The pre-existing document is still the only one, and it is still the one that
  // was there: nothing was overwritten and nothing was added.
  assert.equal(employments().length, 1);
  assert.deepEqual(Object.keys(client.readAll('employments')), ['emp-existing']);
});

test('an employment for a different application does not block this one', async () => {
  // The query is scoped to the application, not to the job or the pair of people:
  // one employer hiring two applicants for the same job is two employments, and a
  // guard that matched more widely would silently drop the second hire.
  seedInterviewedApplication();
  client.seed(
    'employments',
    'emp-other',
    employment({ employerId: 'employer-1', employeeId: 'employee-2', applicationId: 'app-2' })
  );

  const res = await hire();

  assert.equal(res.status, 200);
  assert.equal(employments().length, 2);
  assert.deepEqual(
    employments().map((e) => e.applicationId).sort(),
    ['app-1', 'app-2']
  );
});

test('an ended employment still blocks a second one for the same application', async () => {
  // Matching on existence rather than on status: an `ended` employment still means
  // this application was already hired, and hiring the same applicant again for the
  // same job is properly a new application rather than a second record here.
  seedInterviewedApplication();
  client.seed(
    'employments',
    'emp-ended',
    employment({ applicationId: 'app-1', status: 'ended', endDate: '2026-10-06' })
  );

  const res = await hire();

  assert.equal(res.status, 200);
  assert.equal(employments().length, 1);
  assert.equal(employments()[0].status, 'ended');
});

// ---------------------------------------------------------------------------
// 5. Each party can read their own employments.
// ---------------------------------------------------------------------------

test('an employee can read their own employments', async () => {
seedInterviewedApplication();
  await hire();

  const res = await employeeApi.get('/employments/employee/employee-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.employments.length, 1);

  const [only] = res.body.employments;
  assert.ok(only.id, 'the document id is added');
  assert.equal(only.employeeId, 'employee-1');
  assert.equal(only.employerId, 'employer-1');
  assert.equal(only.jobId, 'job-1');
  assert.equal(only.applicationId, 'app-1');
  assert.equal(only.status, 'active');
  assert.equal(only.endDate, null);
});

test('an employer can read their own employments', async () => {
seedInterviewedApplication();
  await hire();

  const res = await employerApi.get('/employments/employer/employer-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.employments.length, 1);

  // The same record the employee read above, reached through the employerId query.
  const [only] = res.body.employments;
  const [storedId] = Object.keys(client.readAll('employments'));
  assert.equal(only.id, storedId);
  assert.equal(only.employerId, 'employer-1');
  assert.equal(only.employeeId, 'employee-1');
  assert.equal(only.jobId, 'job-1');
  assert.equal(only.applicationId, 'app-1');
});

test('the read returns the stored document unreshaped', async () => {
seedInterviewedApplication();
  await hire();

  const res = await employeeApi.get('/employments/employee/employee-1');
  const stored = Object.entries(client.readAll('employments'))[0];

  // The read adds the document id and nothing else: no field is renamed, dropped
  // or normalised, so startDate reaches the client in whichever of its two forms
  // the hire stored.
  assert.deepEqual(res.body.employments[0], { id: stored[0], ...stored[1] });
});

test('an employment recorded by a hire is immediately readable by both parties', async () => {
seedInterviewedApplication();
  await hire();

  const byEmployee = await employeeApi.get('/employments/employee/employee-1');
  const byEmployer = await employerApi.get('/employments/employer/employer-1');

  assert.equal(byEmployee.status, 200);
  assert.equal(byEmployer.status, 200);
  // Both sides read the same record, reached through two independent queries.
  assert.deepEqual(byEmployee.body.employments[0].id, byEmployer.body.employments[0].id);
  assert.equal(byEmployee.body.employments[0].applicationId, 'app-1');
});

test('each side sees only their own employments', async () => {
seedInterviewedApplication();
  await hire();
  client.seed(
    'employments',
    'emp-other',
    employment({ employerId: 'employer-2', employeeId: 'employee-2', applicationId: 'app-2' })
  );
  const [hiredId] = Object.keys(client.readAll('employments')).filter((id) => id !== 'emp-other');

  const employee1 = await employeeApi.get('/employments/employee/employee-1');
  const employer1 = await employerApi.get('/employments/employer/employer-1');
  const employee2 = await (await client.authed('employee-2')).get('/employments/employee/employee-2');
  const employer2 = await (await client.authed('employer-2')).get('/employments/employer/employer-2');

  // Two employments exist; each caller sees exactly their own.
  assert.equal(Object.keys(client.readAll('employments')).length, 2);
  assert.deepEqual(employee1.body.employments.map((e) => e.id), [hiredId]);
  assert.deepEqual(employer1.body.employments.map((e) => e.id), [hiredId]);
  assert.deepEqual(employee2.body.employments.map((e) => e.id), ['emp-other']);
  assert.deepEqual(employer2.body.employments.map((e) => e.id), ['emp-other']);
});

test('an employer is not shown the employments they are party to as an employee', async () => {
seedInterviewedApplication();
  await hire();

  // Reading the *employee* path with their own uid is permitted by the guard --
  // it checks identity, not role -- and simply returns nothing, because
  // employer-1 holds no employment as a worker. The important part is that it
  // cannot reach another user's records, which the next two tests cover.
  const res = await employerApi.get('/employments/employee/employer-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.employments, []);
});

test('the reads return an empty list, not a 404, when there is nothing yet', async () => {
  const byEmployee = await employeeApi.get('/employments/employee/employee-1');
  const byEmployer = await employerApi.get('/employments/employer/employer-1');

  // "You have no employments" is not a missing resource.
  assert.equal(byEmployee.status, 200);
  assert.deepEqual(byEmployee.body.employments, []);
  assert.equal(byEmployer.status, 200);
  assert.deepEqual(byEmployer.body.employments, []);
});

// ---------------------------------------------------------------------------
// 6. Neither party can read the other's employments.
// ---------------------------------------------------------------------------

test('an employee cannot read another employee\'s employments', async () => {
seedInterviewedApplication();
  await hire();
  client.seed(
    'employments',
    'emp-other',
    employment({ employerId: 'employer-2', employeeId: 'employee-2', applicationId: 'app-2' })
  );

  // employee-2's employment exists, so the refusal is about identity rather than
  // about the query being empty.
  assert.equal(client.readDoc('employments', 'emp-other').employeeId, 'employee-2');

  const res = await employeeApi.get('/employments/employee/employee-2');

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'Forbidden');
  assert.equal(res.body.employments, undefined, 'no employment data may leak in a 403 body');
});

test('an employer cannot read another employer\'s employments', async () => {
seedInterviewedApplication();
  await hire();
  client.seed(
    'employments',
    'emp-other',
    employment({ employerId: 'employer-2', employeeId: 'employee-2', applicationId: 'app-2' })
  );

  assert.equal(client.readDoc('employments', 'emp-other').employerId, 'employer-2');

  const res = await employerApi.get('/employments/employer/employer-2');

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'Forbidden');
  assert.equal(res.body.employments, undefined, 'no employment data may leak in a 403 body');
});

test('an employer cannot reach their own employments through another user\'s uid', async () => {
seedInterviewedApplication();
  await hire();
  client.seed(
    'employments',
    'emp-other',
    employment({ employerId: 'employer-2', employeeId: 'employee-2', applicationId: 'app-2' })
  );

  // The uid in the path is employer-2, so the guard refuses before the query --
  // the record is not filtered out of the result, the request never runs.
  const res = await employerApi.get('/employments/employer/employer-2');

  assert.equal(res.status, 403);
  assert.equal(res.body.employments, undefined);
});

test('both reads require authentication', async () => {
  const byEmployee = await client.get('/employments/employee/employee-1');
  const byEmployer = await client.get('/employments/employer/employer-1');

  // `protect` answers 401 with plain text, not JSON, as it always has.
  assert.equal(byEmployee.status, 401);
  assert.equal(byEmployer.status, 401);
});

test('an invalid token cannot read employments', async () => {
seedInterviewedApplication();
  await hire();

  const res = await client.get('/employments/employee/employee-1', { token: 'not-a-real-token' });

  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------
// Service-level rules that the HTTP surface cannot reach.
// ---------------------------------------------------------------------------

test('createEmploymentFromHire refuses to record a hire missing a required field', async () => {
  // The only non-HTTP test in this file, and necessarily so: on the live path all
  // four identity fields come from the verified token or from documents the
  // authorization guard has already loaded, so no request can omit one. Required
  // in the test file because the service requires it.
  //
  // Required lazily, after startTestServer has installed the fake Firestore in
  // require.cache: requiring it at the top of the file would load the real
  // config/firebase.js and call admin.initializeApp() against the committed
  // service account.
  const employmentService = require('../services/employmentService');

  const base = {
    newStatus: 'accepted',
    previousStatus: 'pending',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    jobId: 'job-1',
    applicationId: 'app-1',
  };

  for (const field of ['employerId', 'employeeId', 'jobId', 'applicationId']) {
    const context = { ...base };
    delete context[field];

    await assert.rejects(
      () => employmentService.createEmploymentFromHire(context),
      (err) => {
        assert.ok(err instanceof employmentService.EmploymentValidationError);
        assert.equal(err.message, `Missing required field: ${field}`);
        return true;
      }
    );
  }

  assert.deepEqual(client.readAll('employments'), {}, 'nothing may be written');
});

test('createEmploymentFromHire writes nothing for a status that is not a hire', async () => {
  const employmentService = require('../services/employmentService');

  for (const newStatus of ['pending', 'rejected', 'anything', undefined]) {
    const result = await employmentService.createEmploymentFromHire({
      applicationId: 'app-1',
      newStatus,
      previousStatus: 'pending',
      employerId: 'employer-1',
      employeeId: 'employee-1',
      jobId: 'job-1',
    });

    // null, not a throw: rejection is the normal path for most of a hire.
    assert.equal(result, null, `expected no employment for ${newStatus}`);
  }

  assert.deepEqual(client.readAll('employments'), {});
});

test('the employment status allow-list is active/ended and only active is written', async () => {
  const employmentService = require('../services/employmentService');

  assert.deepEqual(employmentService.EMPLOYMENT_STATUSES, ['active', 'ended']);
  assert.equal(employmentService.ACTIVE_EMPLOYMENT_STATUS, 'active');

seedInterviewedApplication();
  await hire();

  assert.equal(employments()[0].status, employmentService.ACTIVE_EMPLOYMENT_STATUS);
});
