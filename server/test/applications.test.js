'use strict';

/**
 * Characterization tests for server/routes/applications.js
 *
 * This router contains the most damaged domain logic in the codebase. The
 * tests below pin down exactly how it misbehaves today so that Stages 3-5 can
 * change it deliberately rather than by accident.
 *
 * Since Stage 1 every route requires a token, and identity always comes from
 * the token rather than the body.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { startTestServer } = require('../testing/testApp');
const { job, application } = require('../testing/fixtures');

let client;
let employeeApi;
let employerApi;
const now = () => '2026-01-01T00:00:00.000Z';

test.before(async () => {
  client = await startTestServer({ clock: now });
});

test.after(async () => {
  await client.close();
});

test.afterEach(async () => {
  // Reset the shared job‑1 document to a clean open state so that later tests
  // are not affected by earlier tests that changed job status or deadline.
  client.seed('jobs', 'job-1', job());
});

test.beforeEach(async () => {
  client.fake.resetAll();
  // Fixtures use postedBy: 'employer-1' and employeeId: 'employee-1'.
  employeeApi = await client.authed('employee-1');
  employerApi = await client.authed('employer-1');
  // Reset the shared job‑1 document to a known open state so that every test
  // starts from the same baseline.  Tests that need a different job status
  // (filled / closed / custom deadline) will override this with their own
  // `client.seed` call.
  await client.seed('jobs', 'job-1', job());
});

// ------------------------------------------------------------------- /apply

test('POST /applications/apply stores an application', async () => {
  client.seed('jobs', 'job-1', job());

  const res = await employeeApi.post('/applications/apply', {
    body: {
      jobId: 'job-1',
      fullName: 'Test User',
      message: 'I can do this',
    },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Application submitted successfully');

  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal(stored.jobId, 'job-1');
  assert.equal(stored.employeeId, 'employee-1');
  assert.equal(stored.status, 'pending');
  assert.equal(stored.message, 'I can do this');
});

test('POST /applications/apply rejects a sequential duplicate submission', async () => {
  client.seed('jobs', 'job-1', job());
  const body = { jobId: 'job-1', fullName: 'Test User', message: 'First' };

  const first = await employeeApi.post('/applications/apply', { body });
  assert.equal(first.status, 200);

  const second = await employeeApi.post('/applications/apply', { body });

  assert.equal(second.status, 400);
  assert.equal(second.body.message, 'You have already applied to this job');
  assert.equal(Object.keys(client.readAll('applications')).length, 1);
});

test('withdrawing an application allows a fresh re-application', async () => {
  client.seed('jobs', 'job-1', job());
  const body = { jobId: 'job-1', fullName: 'Test User', message: 'First' };

  const first = await employeeApi.post('/applications/apply', { body });
  assert.equal(first.status, 200);
  const firstId = Object.keys(client.readAll('applications'))[0];
  assert.ok(firstId);

  const withdrawn = await employeeApi.delete(`/applications/${firstId}`);
  assert.equal(withdrawn.status, 200);
  assert.equal(Object.keys(client.readAll('applications')).length, 0);
  assert.equal(Object.keys(client.readAll('applicationUniquenessKeys')).length, 0,
    'withdrawal removes the uniqueness key with the application');

  const second = await employeeApi.post('/applications/apply', {
    body: { ...body, message: 'Second' },
  });
  assert.equal(second.status, 200);

  const reapplied = Object.keys(client.readAll('applications'));
  assert.equal(reapplied.length, 1);
  assert.notEqual(reapplied[0], firstId,
    're-application gets a fresh application id, not the withdrawn one');
});

test('apply replaces a stale uniqueness key left by an out-of-band application delete', async () => {
  client.seed('jobs', 'job-1', job());
  const keyId = crypto
    .createHash('sha256')
    .update('job-1\u0000employee-1')
    .digest('hex');
  client.seed('applicationUniquenessKeys', keyId, {
    jobId: 'job-1',
    employeeId: 'employee-1',
    applicationId: 'application-that-was-deleted',
  });

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'Recover' },
  });
  assert.equal(res.status, 200);

  const applications = client.readAll('applications');
  assert.equal(Object.keys(applications).length, 1);
  assert.equal(
    client.readAll('applicationUniquenessKeys')[keyId].applicationId,
    Object.keys(applications)[0]
  );
});

test('POST /applications/apply allows only one winner under concurrent submissions', async () => {
  client.seed('jobs', 'job-1', job());
  const body = { jobId: 'job-1', fullName: 'Test User', message: 'Same instant' };

  // Hold requests at the existing duplicate lookup until at least two have
  // arrived. This makes the check-then-create race deterministic: both observe
  // an empty collection before any create runs. The lookup and the create
  // themselves remain the real repository calls.
  const applicationRepository = require('../repositories/applicationRepository');
  const originalLookup = applicationRepository.listApplicationsByJobAndEmployee;
  const submissions = 5;
  const concurrentChecks = 2;
  let arrived = 0;
  let releaseLookup;
  const raceReady = new Promise((resolve) => {
    releaseLookup = resolve;
  });

  applicationRepository.listApplicationsByJobAndEmployee = async (...args) => {
    arrived += 1;
    if (arrived === concurrentChecks) releaseLookup();
    await raceReady;
    return originalLookup(...args);
  };

  let results;
  try {
    results = await Promise.all(
      Array.from({ length: submissions }, () => employeeApi.post('/applications/apply', { body }))
    );
  } finally {
    applicationRepository.listApplicationsByJobAndEmployee = originalLookup;
  }

  const winners = results.filter((res) => res.status === 200);
  const duplicates = results.filter((res) => res.status === 400);

  assert.equal(winners.length, 1, 'exactly one concurrent submission succeeds');
  assert.equal(duplicates.length, 4, 'every other submission is rejected');
  for (const duplicate of duplicates) {
    assert.equal(duplicate.body.message, 'You have already applied to this job');
  }

  const stored = Object.values(client.readAll('applications'));
  assert.equal(stored.length, 1, 'the race created no duplicate application');
  assert.equal(stored[0].jobId, 'job-1');
  assert.equal(stored[0].employeeId, 'employee-1');

  const calls = client.fake.store.calls;
  const duplicateChecks = calls.filter(
    (call) => call.op === 'query' && call.path === 'applications'
      && Array.isArray(call.constraints) && call.constraints.length === 2
  );
  const firstCreate = calls.findIndex(
    (call) => call.op === 'create' && call.path.startsWith('applications/')
  );
  assert.ok(firstCreate >= 0, 'the application was written with an atomic create');
  const checksBeforeCreate = calls
    .slice(0, firstCreate)
    .filter((call) => duplicateChecks.includes(call)).length;
  assert.ok(
    checksBeforeCreate >= 2,
    'at least two concurrent requests passed the duplicate pre-check before the first create'
  );
});

test('different (jobId, employeeId) applications remain independent under concurrency', async () => {
  client.seed('jobs', 'job-1', job());
  client.seed('jobs', 'job-2', job({ title: 'Second job' }));
  const secondEmployee = await client.authed('employee-2');

  const results = await Promise.all([
    employeeApi.post('/applications/apply', {
      body: { jobId: 'job-1', fullName: 'Test User', message: 'Job one' },
    }),
    employeeApi.post('/applications/apply', {
      body: { jobId: 'job-2', fullName: 'Test User', message: 'Job two' },
    }),
    secondEmployee.post('/applications/apply', {
      body: { jobId: 'job-1', fullName: 'Second User', message: 'Same job, other applicant' },
    }),
  ]);

  assert.deepEqual(results.map((res) => res.status), [200, 200, 200]);
  assert.equal(Object.keys(client.readAll('applications')).length, 3);
});

test('POST /applications/apply stamps dateApplied from the fake clock as a Timestamp', async () => {
  client.seed('jobs', 'job-1', job());

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 200);

  // STAGE 5H. dateApplied used to be `new Date()`, i.e. a process-clock instant.
  // Firestore turns a Date into a Timestamp on write either way, so the stored
  // type is a Timestamp in both versions -- what the test could not previously
  // observe, because the fake kept Dates as Dates and then serialized them to an
  // ISO string. It is now the {"_seconds","_nanoseconds"} wire shape that
  // MyApplications.jsx and ViewJobApplications.jsx decode.
  const stored = Object.values(client.readAll('applications'))[0];

  assert.deepEqual(stored.dateApplied, { _seconds: 1767225600, _nanoseconds: 0 });
  assert.equal(stored.dateApplied instanceof Date, false, 'a Timestamp is not a Date');
  assert.equal(JSON.stringify(stored.dateApplied), '{"_seconds":1767225600,"_nanoseconds":0}');
  assert.equal(stored.dateApplied._seconds, Math.floor(Date.parse(now()) / 1000),
    'the value comes from the injected clock, not the process clock');
});

test('GET /applications/employee/:uid returns dateApplied as a Timestamp', async () => {
  client.seed('jobs', 'job-1', job());
  await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });

  // The list endpoint is what MyApplications.jsx reads, and its decoder branches
  // on `_seconds` being present. This pins that the branch is reachable against
  // the real endpoint rather than only against a seeded document.
  const res = await employeeApi.get('/applications/employee/employee-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.applications[0].dateApplied, { _seconds: 1767225600, _nanoseconds: 0 });
});

test('POST /applications/apply requires a jobId', async () => {
  const res = await employeeApi.post('/applications/apply', {
    body: { fullName: 'No job' },
  });

  // Stage 1: employeeId comes from the token, so jobId is the only required
  // field. The status code and message are unchanged.
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Missing required fields');
});

test('POST /applications/apply requires authentication', async () => {
  client.seed('jobs', 'job-1', job());
  const res = await client.post('/applications/apply', {
    body: { jobId: 'job-1' },
  });

  assert.equal(res.status, 401);
});

test('POST /applications/apply returns 404 when the job does not exist', async () => {
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'ghost' },
  });

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
});

test('POST /applications/apply defaults a missing message to empty string', async () => {
  client.seed('jobs', 'job-1', job());

  await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1' },
  });

  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal(stored.message, '');
});

// STAGE 5D. This test used to be called "...discards employeePrice because
// isNegotiable is never set" and asserted `employeePrice === null` for a
// negotiable job. That assertion WAS the bug: `negotiable` is the canonical
// field, so a negotiable job must now keep the price it was sent.
test('POST /applications/apply stores employeePrice for a negotiable job', async () => {
  client.seed('jobs', 'job-1', job({ negotiable: 'yes', price: 15000 }));

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', employeePrice: 9000 },
  });

  assert.equal(res.status, 200);
  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal(stored.employeePrice, 9000);
});

test('POST /applications/apply rejects a price on a non-negotiable job', async () => {
  // The other half of the same fix. The `isNegotiable === false` branch was dead
  // because it read a field nothing ever wrote, so a price sent to a fixed-price
  // job was silently discarded with a 200. It is now reachable and rejects.
  client.seed('jobs', 'job-1', job({ negotiable: 'no', price: 15000 }));

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', employeePrice: 9000 },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'This job is not negotiable, price cannot be provided.');
  assert.equal(Object.keys(client.readAll('applications')).length, 0, 'nothing may be stored');
});

test('POST /applications/apply stores a null price on a non-negotiable job', async () => {
  // The fixed-price path the client actually takes: JobDetails.jsx sends
  // `employeePrice: null` when the job is not negotiable.
  client.seed('jobs', 'job-1', job({ negotiable: 'no', price: 15000 }));

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', employeePrice: null },
  });

  assert.equal(res.status, 200);
  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal(stored.employeePrice, null);
});

test('POST /applications/apply validates a negative price on a negotiable job', async () => {
  // The `employeePrice <= 0` guard was unreachable while the branch was dead.
  client.seed('jobs', 'job-1', job({ negotiable: 'yes', price: 15000 }));

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', employeePrice: -500 },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Invalid price. It must be greater than 0.');
});

test('POST /applications/apply treats a job with no negotiable field as fixed-price', async () => {
  // Legacy document handling. Nothing in this codebase has ever persisted
  // `isNegotiable`, and a document written before `negotiable` existed simply
  // lacks the field. The absent value is read as NOT negotiable, which is the
  // conservative direction: served at its fixed price, and a stray price is
  // rejected rather than silently accepted. No migration is performed.
  const legacyJob = job({ price: 15000 });
  delete legacyJob.negotiable;
  client.seed('jobs', 'job-1', legacyJob);

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', employeePrice: 9000 },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'This job is not negotiable, price cannot be provided.');
});

test('POST /applications/apply honours a boolean true on the negotiable field', async () => {
  // The stored contract is the string "yes"/"no", but a document holding a real
  // boolean true still reads as negotiable rather than silently flipping to
  // fixed-price.
  client.seed('jobs', 'job-1', job({ negotiable: true, price: 15000 }));

  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', employeePrice: 9000 },
  });

  assert.equal(res.status, 200);
  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal(stored.employeePrice, 9000);
});

// STAGE 5E. The two tests this replaces asserted the dead counter itself: one
// pinned a NaN (`proposal - 1` with the client's undefined input) and one pinned
// the decrement (`proposal: 5` in, `proposals: 4` stored). Nothing read that
// field. They are rewritten to assert the new contract -- the field is not
// written, and a client-supplied `proposal` is not honoured -- rather than
// deleted.
test('POST /applications/apply does not write a proposals field', async () => {
  client.seed('jobs', 'job-1', job());

  await employeeApi.post('/applications/apply', { body: { jobId: 'job-1' } });

  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal('proposals' in stored, false, 'no proposals field may be written');
  assert.equal('proposal' in stored, false, 'no proposal field may be written');
});

test('POST /applications/apply ignores a client-supplied proposal value', async () => {
  client.seed('jobs', 'job-1', job());

  // The old code persisted `body.proposal - 1`, so a client could write an
  // arbitrary number into the database. That value is now discarded entirely,
  // and no field carries it.
  await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', proposal: 5 },
  });

  const stored = Object.values(client.readAll('applications'))[0];
  assert.equal('proposals' in stored, false);
  assert.equal(stored.proposal, undefined);
  assert.equal(stored.proposals, undefined);
});

test('POST /applications/apply never increments the job counter', async () => {
  // The applicant count is derived from the applications collection, not kept on
  // the job. Submitting must leave the parent job document completely alone.
  client.seed('jobs', 'job-1', job());

  await employeeApi.post('/applications/apply', { body: { jobId: 'job-1' } });

  const storedJob = client.readDoc('jobs', 'job-1');
  assert.equal(storedJob.proposal, 0, 'the legacy proposal field is left as-is');
  assert.equal(storedJob.applicantCount, undefined, 'no counter may be written on the job');
  assert.equal(storedJob.proposals, undefined, 'no proposals field may be created');
});

test('POST /applications/apply ignores a client-supplied status', async () => {
  client.seed('jobs', 'job-1', job());

  await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', status: 'accepted' },
  });

  const stored = Object.values(client.readAll('applications'))[0];
  // The handler hardcodes status: "pending"; the body's status is discarded.
  assert.equal(stored.status, 'pending');
});

// ------------------------------------------------------------ /employee/:uid

test('GET /applications/employee/:uid joins each application with its job', async () => {
  client.seed('jobs', 'job-1', job({ title: 'Tap job' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));

  const res = await employeeApi.get('/applications/employee/employee-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.applications.length, 1);
  assert.equal(res.body.applications[0].job.title, 'Tap job');
  assert.equal(res.body.applications[0].id, 'app-1');
});

test('GET /applications/employee/:uid rejects another user\'s list', async () => {
  client.seed('applications', 'app-1', application({ employeeId: 'someone-else' }));

  const res = await employeeApi.get('/applications/employee/someone-else');

  // Stage 1: an application list may only be read by its owner.
  assert.equal(res.status, 403);
});

test('GET /applications/employee/:uid issues one job read per application', async () => {
  client.seed('jobs', 'job-1', job());
  client.seed('jobs', 'job-2', job());
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-2' }));
  client.seed('applications', 'app-3', application({ jobId: 'job-1' }));

  await employeeApi.get('/applications/employee/employee-1');

  const jobReads = client.fake.store.calls.filter(
    (c) => c.op === 'get' && c.path.startsWith('jobs/')
  );

  // PERFORMANCE: N+1 -- three applications cause three sequential job reads.
  // db.getAll() or a batch would collapse this into one round trip.
  assert.equal(jobReads.length, 3);
});

test('GET /applications/employee/:uid returns a null job when the job was deleted', async () => {
  client.seed('applications', 'app-1', application({ jobId: 'deleted-job' }));

  const res = await employeeApi.get('/applications/employee/employee-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.applications[0].job, null);
});

// --------------------------------------------------------------- /job/:jobId

// STAGE 5B: this endpoint used to be `protect`-only, so any authenticated user
// could read every applicant's identity for any job (the Stage 5A IDOR-01
// finding). It is now owner-guarded, so the caller below is the employer who
// posted the job rather than an arbitrary employee. The response contract for
// that legitimate caller is unchanged, and these two tests now assert it.

test('GET /applications/job/:jobId returns applications for a job to its owner', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('jobs', 'job-2', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-2' }));

  const res = await employerApi.get('/applications/job/job-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.applications.length, 1);
  assert.equal(res.body.applications[0].id, 'app-1');

  // Part 2: the employer still receives the full application document, with
  // every applicant field intact and nothing renamed.
  assert.equal(res.body.applications[0].employeeId, 'employee-1');
  assert.equal(res.body.applications[0].fullName, 'Test User');
  assert.equal(res.body.applications[0].message, 'I can do this');
  assert.equal(res.body.applications[0].status, 'pending');
});

test('GET /applications/job/:jobId returns an empty array when the job has no applications', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));

  const res = await employerApi.get('/applications/job/job-1');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { applications: [] });
});

test('GET /applications/job/:jobId requires authentication', async () => {
  client.seed('jobs', 'job-1', job());
  client.seed('applications', 'app-1', application());
  const res = await client.get('/applications/job/job-1');
  assert.equal(res.status, 401);
});

// STAGE 6S: this endpoint is a READ, so its 403 has to describe a read
// restriction. It used to say "You do not have permission to modify this job",
// which named an edit the caller never attempted -- so a client reading the body
// could not tell that the refusal was about viewing rather than changing.
test('GET /applications/job/:jobId tells a non-owner the restriction is on viewing', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));

  const res = await employeeApi.get('/applications/job/job-1');

  // The status is deliberately unchanged: this stage reworded the rejection only.
  assert.equal(res.status, 403);
  assert.equal(
    res.body.message,
    'You do not have permission to view applications for this job'
  );
  // And it no longer implies the caller attempted to change the job.
  assert.equal(res.body.message.includes('modify'), false);
});

// ------------------------------------------------------------------ /counts

test('GET /applications/counts returns per-job counts and nothing else', async () => {
  client.seed('jobs', 'job-1', job());
  client.seed('jobs', 'job-2', job());
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-3', application({ jobId: 'job-2' }));

  const res = await employeeApi.get('/applications/counts');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { counts: { 'job-1': 2, 'job-2': 1 } });

  // Count-only: no applicant identity may appear anywhere in the payload.
  assert.equal(JSON.stringify(res.body).includes('employee-1'), false);
  assert.equal(JSON.stringify(res.body).includes('Test User'), false);
});

test('GET /applications/counts omits jobs with no applications', async () => {
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));

  const res = await employeeApi.get('/applications/counts');

  assert.deepEqual(res.body, { counts: { 'job-1': 1 } });
});

test('GET /applications/counts derives the applicant count from the applications collection', async () => {
  // STAGE 5E: with the job counters gone, this endpoint is the single source of
  // applicant counts for the whole app -- the three dashboards and JobDetails.
  // It must therefore reflect reality after a submit AND after a withdrawal,
  // which is the property the deleted counters never had.
  client.seed('jobs', 'job-1', job());
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-1' }));

  const before = await employeeApi.get('/applications/counts');
  assert.deepEqual(before.body.counts, { 'job-1': 2 });

  await employeeApi.delete('/applications/app-1');

  const after = await employeeApi.get('/applications/counts');
  assert.deepEqual(after.body.counts, { 'job-1': 1 });
});

test('POST /applications/apply then withdraw leaves the count correct without any job field', async () => {
  // End-to-end replacement for the deleted counter: create an application, see
  // the count rise, withdraw it, see the count fall -- with nothing written to
  // the job document at any point.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));

  await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'Hi' },
  });

  const created = await employeeApi.get('/applications/counts');
  assert.deepEqual(created.body.counts, { 'job-1': 1 });

  // The job document is untouched: the fixture's legacy `proposal: 0` is still
  // exactly 0, and neither a `proposals` field nor an `applicantCount` was added.
  const jobDoc = client.readDoc('jobs', 'job-1');
  assert.equal(jobDoc.proposal, 0, 'the legacy counter is not incremented or removed');
  assert.equal('proposals' in jobDoc, false);
  assert.equal('applicantCount' in jobDoc, false);

  const appId = Object.keys(client.readAll('applications'))[0];
  await employeeApi.delete(`/applications/${appId}`);

  const withdrawn = await employeeApi.get('/applications/counts');
  assert.deepEqual(withdrawn.body.counts, {}, 'a job with no applications is omitted');
});

test('GET /applications/counts requires authentication', async () => {
  client.seed('applications', 'app-1', application());

  const res = await client.get('/applications/counts');
  assert.equal(res.status, 401);
});

// -------------------------------------------------------------- /:id/status

test('PUT /applications/:id/status updates the status', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  // STAGE 7G-1: seeded `interviewed`, not the fixture's `pending`. A hire is only
  // legal from `interviewed` (or from `accepted`, for a re-send), so this test
  // exercises the write itself rather than the gate that now precedes it.
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1', status: 'interviewed' }));
  // STAGE 3C.1.1: need a genuinely accepted proposal
  client.seed('contractProposals', 'prop-1', {
    applicationId: 'app-1',
    jobId: 'job-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    paymentMode: 'full',
    currency: 'NGN',
    totalAmountMinor: 1000000,
    commissionBps: 500,
    commissionAmountMinor: 50000,
    milestones: [],
    status: 'accepted',
    acceptedAt: { _seconds: 1767225600, _nanoseconds: 0 },
    acceptedBy: 'employee-1',
  });

  const res = await employerApi.put('/applications/app-1/status', {
    body: { status: 'accepted' },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Status updated successfully');
  // Stage 5G: was the title-cased 'Employed' the client used to write.
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
});

test('PUT /applications/:id/status rejects a value outside the allow-list', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', status: 'pending' }));

  // Stage 5G: the value used to be unvalidated, so this returned 200 and stored
  // 'anything'. `Employed` and `Not Hired` are the legacy spellings the client
  // wrote; they are still read for display compatibility but are no longer
  // accepted on write. `paused` belongs to jobs, not applications.
  for (const status of ['anything', 'Employed', 'Not Hired', 'paused', 'Accepted']) {
    const res = await employerApi.put('/applications/app-1/status', { body: { status } });

    assert.equal(res.status, 400, `expected 400 for ${status}`);
    // STAGE 7G-1: the allow-list gained `interviewed`, and this message is
    // generated from APPLICATION_STATUSES, so the exact string moved.
    assert.equal(res.body.message, 'Invalid status. Must be one of: pending, interviewed, accepted, rejected.');
    assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
  }
});

test('PUT /applications/:id/status leaves a legacy value readable', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', status: 'Employed' }));

  // Stage 5G: legacy documents are not migrated, backfilled or cleaned up, so
  // the employer still sees the accepted application they hired.
  const res = await employerApi.get('/applications/job/job-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.applications[0].status, 'Employed');
});

test('PUT /applications/:id/status requires a status value', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));

  const res = await employerApi.put('/applications/app-1/status', { body: {} });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Status is required');
});

test('PUT /applications/:id/status returns 404 for a missing application', async () => {
  const res = await employerApi.put('/applications/ghost/status', {
    body: { status: 'accepted' },
  });

  // Stage 1: the authorization guard loads the application first, so this is a
  // 404 instead of the 500 (with a leaked internal error string) it produced
  // before the endpoint had any existence check.
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Application not found');
  assert.equal(res.body.error, undefined);
});

test('PUT /applications/:id/status accepts every canonical status', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));

  // Stage 5G: an allow-list, not a transition matrix. Each canonical value is
  // written from the same starting application with no relation to the previous
  // status.
  //
  // STAGE 7G-1: the seed is `interviewed` rather than `pending`, and the list
  // gained a fourth value. `pending` would make the `accepted` case fail on the
  // hire gate instead of on the allow-list, which would no longer be what this
  // test is about; `interviewed` is a status every one of the four is legal from,
  // so the allow-list stays the only thing under test.
  //
  // STAGE 10H.2: the collections are reset each iteration (client.fake.reset()
  // clears the store but not the issued tokens). Writing `accepted` now also
  // records an employment, and a surviving `active` employment would make the
  // `rejected` case fail on the new no-reject-while-employed rule -- a real
  // precondition, but not the allow-list this test is about. Reseeding the job and
  // the application keeps the two concerns apart.
  for (const status of ['pending', 'interviewed', 'accepted', 'rejected']) {
    client.fake.reset();
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1', status: 'interviewed' }));
    if (status === 'accepted') {
      client.seed('contractProposals', 'prop-1', {
        applicationId: 'app-1',
        jobId: 'job-1',
        employerId: 'employer-1',
        employeeId: 'employee-1',
        paymentMode: 'full',
        currency: 'NGN',
        totalAmountMinor: 1000000,
        commissionBps: 500,
        commissionAmountMinor: 50000,
        milestones: [],
        status: 'accepted',
        acceptedAt: { _seconds: 1767225600, _nanoseconds: 0 },
        acceptedBy: 'employee-1',
      });
    }

    const res = await employerApi.put('/applications/app-1/status', { body: { status } });

    assert.equal(res.status, 200, `expected 200 for ${status}`);
    assert.equal(client.readDoc('applications', 'app-1').status, status);
  }
});

test('PUT /applications/:id/status refuses to hire a pending application', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', status: 'pending' }));

  const res = await employerApi.put('/applications/app-1/status', {
    body: { status: 'accepted' },
  });

  // STAGE 7G-1: the lifecycle rule. An applicant who has not been cleared for
  // hiring cannot be hired, and the refusal is a validation error on the existing
  // ApplicationValidationError path -- no new error class, no new status code.
  assert.equal(res.status, 400);
  assert.match(res.body.message, /interviewed/);
  // The validation failure precedes the write, so nothing moved.
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
});

test('PUT /applications/:id/status hires an interviewed application', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1', status: 'interviewed' }));
  client.seed('contractProposals', 'prop-1', {
    applicationId: 'app-1',
    jobId: 'job-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    paymentMode: 'full',
    currency: 'NGN',
    totalAmountMinor: 1000000,
    commissionBps: 500,
    commissionAmountMinor: 50000,
    milestones: [],
    status: 'accepted',
    acceptedAt: { _seconds: 1767225600, _nanoseconds: 0 },
    acceptedBy: 'employee-1',
  });

  const res = await employerApi.put('/applications/app-1/status', {
    body: { status: 'accepted' },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
});

test('PUT /applications/:id/status re-sending a hire to a hired application stays idempotent', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' }));

  // STAGE 7G-1: the gate exempts an application that is already `accepted`, so the
  // retry a client performs after a failed hire still succeeds. Without that
  // exemption the documented retry path in ViewJobApplications.jsx would turn a
  // partial failure into a permanent one.
  const res = await employerApi.put('/applications/app-1/status', {
    body: { status: 'accepted' },
  });

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
});

test('PUT /applications/:id/status refuses to hire an already-rejected application', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', status: 'rejected' }));

  const res = await employerApi.put('/applications/app-1/status', {
    body: { status: 'accepted' },
  });

  // The two directions of the decision are not symmetric. `rejected` -> `accepted`
  // would silently undo a rejection, so it has to pass back through `interviewed`
  // first -- which is a decision the employer makes deliberately, not a side effect
  // of a restatus sweep.
  assert.equal(res.status, 400);
  assert.equal(client.readDoc('applications', 'app-1').status, 'rejected');
});

test('PUT /applications/:id/status refuses to hire a legacy application that predates the allow-list', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  // A document written before Stage 5G validated the field, and one written before
  // Stage 7G-1 existed: it holds the legacy title-cased `Employed`.
  client.seed('applications', 'app-1', application({ jobId: 'job-1', status: 'Employed' }));

  const res = await employerApi.put('/applications/app-1/status', {
    body: { status: 'accepted' },
  });

  // The read side still displays this value (the tests above pin that), but the
  // gate compares it against the canonical pair and does not recognise it as
  // hired. It must therefore be cleared for hiring explicitly, like any other
  // status the gate does not recognise -- the alternative, treating a legacy
  // value as hired, would make an unread document decide the outcome.
  assert.equal(res.status, 400);
  assert.equal(client.readDoc('applications', 'app-1').status, 'Employed');
});

test('PUT /applications/:id/status rejects an application whose status field is absent', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  // Seeded without a `status` key rather than with an undefined one, which
  // Firestore rejects outright. Built as a local so the fixture object is not
  // mutated for any later test that reuses it.
  const statusless = application({ jobId: 'job-1' });
  delete statusless.status;
  client.seed('applications', 'app-1', statusless);

  const res = await employerApi.put('/applications/app-1/status', {
    body: { status: 'accepted' },
  });

  // A document with no status is not a document that has been cleared for hiring,
  // so the gate refuses it and the message says so rather than printing
  // `undefined`. This can only arise from a hand-written or pre-Stage-5G
  // document: applyToJob has always written `pending`.
  assert.equal(res.status, 400);
  assert.match(res.body.message, /unset/);
});

// ------------------------------------------------------------ DELETE /:id

test('DELETE /applications/:applicationId removes the applicant\'s own application', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));

  const res = await employeeApi.delete('/applications/app-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Application withdrawn successfully');
  assert.equal(client.readDoc('applications', 'app-1'), undefined);
});

test('DELETE /applications/:applicationId returns 404 when missing', async () => {
  const res = await employeeApi.delete('/applications/ghost');
  assert.equal(res.status, 404);
});

test('DELETE /applications/:applicationId requires authentication', async () => {
  client.seed('jobs', 'job-1', job());
  client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));

  const res = await client.delete('/applications/app-1');

  assert.equal(res.status, 401);
});

// STAGE 5E. This test used to pin the counter bug itself: it seeded
// `proposal: 3`, withdrew, and asserted the job came back holding
// `proposal: 3` next to a brand-new `proposals: -1`. It is rewritten to assert
// the new contract -- withdrawal touches no job field at all.
test('DELETE /applications/:applicationId no longer writes any job counter', async () => {
  // Seeded with both legacy counter fields present, representing a job document
  // written before Stage 5E. They must be left exactly as they are.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1', proposal: 3, proposals: -1 }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));

  await employeeApi.delete('/applications/app-1');

  const storedJob = client.readDoc('jobs', 'job-1');
  // Untouched, not cleaned up, not decremented further.
  assert.equal(storedJob.proposal, 3);
  assert.equal(storedJob.proposals, -1);
  assert.equal(storedJob.applicantCount, undefined);
});

test('DELETE /applications/:applicationId still deletes the application', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));
  client.seed('applications', 'app-2', application({ jobId: 'job-1' }));

  const res = await employeeApi.delete('/applications/app-1');

  assert.equal(res.status, 200);
  // Only the target is removed; a sibling application is untouched.
  assert.deepEqual(Object.keys(client.readAll('applications')), ['app-2']);
});

test('DELETE /applications/:applicationId no longer needs to write the parent job', async () => {
  client.seed('applications', 'app-1', application({ jobId: 'ghost-job' }));

  // Previously the parent-job counter update ran first, so a missing job made
  // the whole withdrawal fail 500 and left the application in place. With the
  // counter gone there is no second write to fail.
  const res = await employeeApi.delete('/applications/app-1');

  assert.equal(res.status, 200);
  assert.equal(Object.keys(client.readAll('applications')).length, 0);
});

// ------------------------------------------- STAGE 9F: the duplicate is gone
//
// The two tests that stood here asserted that POST /applications/tasks duplicated
// POST /tasks: one that it answered 200 and wrote the document, one that it refused
// an empty body with 400. Both are deleted with the route, because the route they
// described no longer exists. Task creation is characterized in tasks.test.js, which
// now also pins that this path 404s.
//
// Nothing below this line tests a task; this router creates applications only.

// ----------------------------------------- STAGE 12.12.1: resume downloads
//
// A resume is stored as a private reference ({ publicId, name, resourceType }) and
// is only reachable through this endpoint, which mints a short-lived signed URL.
// The signature is computed locally by the Cloudinary SDK, so these tests install
// their own credentials and assert on the signed URL shape rather than calling the
// cloud. The rule under test is authorization: only the applicant and the employer
// who owns the job may receive a URL, and no caller may name the asset.

const RESUME_PUBLIC_ID = 'resumes/employee-1/resume-abc123';
const RESUME_REFERENCE = {
  publicId: RESUME_PUBLIC_ID,
  name: 'cv.pdf',
  resourceType: 'raw',
};

// Install deterministic Cloudinary credentials for the duration of one test and
// restore whatever the environment held before. Mirrors the save/restore the
// profile-photo signing tests use.
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

test('GET /applications/:id/resume/download returns a signed URL to the applicant', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({
      jobId: 'job-1',
      employeeId: 'employee-1',
      resume: RESUME_REFERENCE,
    }));

    const res = await employeeApi.get('/applications/app-1/resume/download');

    assert.equal(res.status, 200);
    assert.equal(res.body.name, 'cv.pdf');
    assert.equal(typeof res.body.url, 'string');
    assert.match(res.body.url, /^https:\/\//);
    // The URL points at the stored public id, URL-encoded, and never exposes the
    // api secret.
    assert.equal(res.body.url.includes(encodeURIComponent(RESUME_PUBLIC_ID)), true);
    assert.equal(res.body.url.includes('test-secret'), false);
  });
});

test('GET /applications/:id/resume/download returns a signed URL to the job owner', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({
      jobId: 'job-1',
      employeeId: 'employee-1',
      resume: RESUME_REFERENCE,
    }));

    const res = await employerApi.get('/applications/app-1/resume/download');

    assert.equal(res.status, 200);
    assert.equal(res.body.url.includes(encodeURIComponent(RESUME_PUBLIC_ID)), true);
  });
});

test('GET /applications/:id/resume/download signs the employer URL for the raw upload type', async () => {
  // REGRESSION (employer path). A resume is stored as resource_type `raw`, type
  // `upload`. verifyUploadedAsset proves an asset at those exact coordinates, but
  // private_download_url with no `type` reaches Cloudinary's admin /download
  // endpoint in the wrong storage class and is answered "Resource not found" for a
  // file that exists -- so the employer's signed URL must carry BOTH coordinates:
  // the raw namespace AND type=upload. This pins the second half of the mismatch
  // that kept the job owner's download 404ing after the raw-namespace fix.
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({
      jobId: 'job-1',
      employeeId: 'employee-1',
      resume: RESUME_REFERENCE,
    }));

    const res = await employerApi.get('/applications/app-1/resume/download');

    assert.equal(res.status, 200);
    assert.equal(res.body.url.includes('/raw/download'), true);
    assert.equal(res.body.url.includes('type=upload'), true);
    assert.equal(res.body.url.includes('/image/'), false);
  });
});

test('GET /applications/:id/resume/download denies an unrelated user', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({
      jobId: 'job-1',
      employeeId: 'employee-1',
      resume: RESUME_REFERENCE,
    }));

    const strangerApi = await client.authed('stranger-1');
    const res = await strangerApi.get('/applications/app-1/resume/download');

    assert.equal(res.status, 403);
    // No resume detail leaks in the failure body.
    assert.equal(JSON.stringify(res.body).includes('resume-abc123'), false);
  });
});

test('GET /applications/:id/resume/download denies an employer who owns a different job', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({
      jobId: 'job-1',
      employeeId: 'employee-1',
      resume: RESUME_REFERENCE,
    }));

    const otherEmployerApi = await client.authed('employer-2');
    const res = await otherEmployerApi.get('/applications/app-1/resume/download');

    assert.equal(res.status, 403);
  });
});

test('GET /applications/:id/resume/download ignores any client-supplied asset id', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({
      jobId: 'job-1',
      employeeId: 'employee-1',
      resume: RESUME_REFERENCE,
    }));

    // A caller naming a different public id is ignored: the signature is built
    // from the reference the server stored, not from the request.
    const res = await employeeApi.get(
      '/applications/app-1/resume/download?publicId=resumes/attacker/evil.pdf'
    );

    assert.equal(res.status, 200);
    assert.equal(res.body.url.includes(encodeURIComponent(RESUME_PUBLIC_ID)), true);
    assert.equal(res.body.url.includes('attacker'), false);
  });
});

test('GET /applications/:id/resume/download is 404 when the application has no resume', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({ jobId: 'job-1', employeeId: 'employee-1' }));

    const res = await employeeApi.get('/applications/app-1/resume/download');

    assert.equal(res.status, 404);
  });
});

test('GET /applications/:id/resume/download is 404 when the application does not exist', async () => {
  await withCloudinaryCredentials(async () => {
    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));

    const res = await employeeApi.get('/applications/missing/resume/download');

    assert.equal(res.status, 404);
  });
});

test('GET /applications/:id/resume/download is unavailable, not public, when Cloudinary is unconfigured', async () => {
  const saved = {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    secret: process.env.CLOUDINARY_API_SECRET,
  };

  try {
    delete process.env.CLOUDINARY_CLOUD_NAME;
    delete process.env.CLOUDINARY_API_KEY;
    delete process.env.CLOUDINARY_API_SECRET;

    client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
    client.seed('applications', 'app-1', application({
      jobId: 'job-1',
      employeeId: 'employee-1',
      resume: RESUME_REFERENCE,
    }));

    const res = await employeeApi.get('/applications/app-1/resume/download');

    assert.equal(res.status, 503);
    assert.match(res.body.message, /not configured/i);
    // No URL of any kind is returned when signing is impossible.
    assert.equal('url' in res.body, false);
    assert.equal(/secret|api[_-]?key/i.test(res.body.message), false, 'the answer names no variable');
  } finally {
    // Assign undefined would coerce the env value to the string "undefined", so
    // delete instead when the variable was not set before this test.
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

test('GET /applications/:id/resume/download requires authentication', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('applications', 'app-1', application({
    jobId: 'job-1',
    employeeId: 'employee-1',
    resume: RESUME_REFERENCE,
  }));

  const res = await client.get('/applications/app-1/resume/download');

  assert.equal(res.status, 401);
});

// -------------------------------------- STAGE 12.13: resume verification on apply
//
// A resume reference an application carries must name a file the APPLICANT owns
// and that Cloudinary actually holds. Ownership is a path rule -- the public id
// must sit under `resumes/{employeeId}/` -- and existence is one admin API call.
// These tests install deterministic credentials and stub that single admin call,
// so no real cloud is contacted and no real credentials are needed. Nothing in
// the request can name another user's asset on the way in.
const cloudinaryConfig = require('../config/cloudinary');

// Run `run` with fake credentials in place AND cloudinary.api.resource stubbed to
// report exactly `foundPublicIds` as existing; every other id is a 404. The SDK
// object is a shared singleton, so the stub is swapped on the same instance the
// service imported and restored afterwards even if the body throws.
async function withCloudinaryAssets(foundPublicIds, run) {
  const original = cloudinaryConfig.cloudinary.api.resource;

  cloudinaryConfig.cloudinary.api.resource = async (publicId) => {
    if (foundPublicIds.includes(publicId)) {
      return { public_id: publicId, resource_type: 'raw' };
    }

    const missing = new Error('Resource not found');
    missing.http_code = 404;
    throw missing;
  };

  try {
    return await withCloudinaryCredentials(run);
  } finally {
    cloudinaryConfig.cloudinary.api.resource = original;
  }
}

const OWNED_RESUME_ID = 'resumes/employee-1/resume-abc123';
const OWNED_RESUME_REFERENCE = {
  publicId: OWNED_RESUME_ID,
  name: 'cv.pdf',
  resourceType: 'raw',
};

// A job that requires a resume and nothing else, so a resume failure is isolated
// from the cover-letter and portfolio rules.
const RESUME_REQUIRED_JOB = {
  applicationRequirements: { resume: 'required', coverLetter: 'not_needed', portfolio: 'not_needed' },
};

test('POST /applications/apply stores an owned resume that Cloudinary holds', async () => {
  await withCloudinaryAssets([OWNED_RESUME_ID], async () => {
    client.seed('jobs', 'job-1', job(RESUME_REQUIRED_JOB));

    const res = await employeeApi.post('/applications/apply', {
      body: {
        jobId: 'job-1',
        fullName: 'Test User',
        message: 'I can do this',
        resume: OWNED_RESUME_REFERENCE,
      },
    });

    assert.equal(res.status, 200);
    const stored = Object.values(client.readAll('applications'))[0];
    assert.deepEqual(stored.resume, OWNED_RESUME_REFERENCE);
  });
});

test('POST /applications/apply rejects a resume under another user\'s folder', async () => {
  await withCloudinaryAssets(['resumes/victim/secret.pdf'], async () => {
    client.seed('jobs', 'job-1', job(RESUME_REQUIRED_JOB));

    const res = await employeeApi.post('/applications/apply', {
      body: {
        jobId: 'job-1',
        fullName: 'Test User',
        message: 'I can do this',
        // Even though the stub reports this id as existing, it is under someone
        // else's folder, so ownership fails before any existence check.
        resume: { publicId: 'resumes/victim/secret.pdf', name: 'secret.pdf', resourceType: 'raw' },
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Resume does not belong to you');
    assert.deepEqual(Object.values(client.readAll('applications')), []);
  });
});

test('POST /applications/apply rejects a `..` id that only passes the folder prefix', async () => {
  await withCloudinaryAssets(['resumes/employee-1/../victim/secret.pdf'], async () => {
    client.seed('jobs', 'job-1', job(RESUME_REQUIRED_JOB));

    const res = await employeeApi.post('/applications/apply', {
      body: {
        jobId: 'job-1',
        fullName: 'Test User',
        message: 'I can do this',
        // Starts with `resumes/employee-1/` but escapes it. The traversal guard
        // must catch what the prefix test alone would let through.
        resume: {
          publicId: 'resumes/employee-1/../victim/secret.pdf',
          name: 'secret.pdf',
          resourceType: 'raw',
        },
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Resume does not belong to you');
    assert.deepEqual(Object.values(client.readAll('applications')), []);
  });
});

test('POST /applications/apply rejects an owned resume Cloudinary does not hold', async () => {
  await withCloudinaryAssets([], async () => {
    client.seed('jobs', 'job-1', job(RESUME_REQUIRED_JOB));

    const res = await employeeApi.post('/applications/apply', {
      body: {
        jobId: 'job-1',
        fullName: 'Test User',
        message: 'I can do this',
        resume: OWNED_RESUME_REFERENCE,
      },
    });

    assert.equal(res.status, 400);
    assert.equal(res.body.message, 'Resume file could not be found');
    assert.deepEqual(Object.values(client.readAll('applications')), []);
  });
});

test('POST /applications/apply never consults Cloudinary when no resume is supplied', async () => {
  // The stub throws if it is reached, so a 200 proves the write-side verification
  // is skipped entirely for the common apply with no resume -- no admin call, no
  // credential requirement.
  const original = cloudinaryConfig.cloudinary.api.resource;
  cloudinaryConfig.cloudinary.api.resource = async () => {
    throw new Error('verifyUploadedAsset must not be called without a resume');
  };

  try {
    client.seed('jobs', 'job-1', job());

    const res = await employeeApi.post('/applications/apply', {
      body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
    });

    assert.equal(res.status, 200);
  } finally {
    cloudinaryConfig.cloudinary.api.resource = original;
  }
});

test('POST /applications/apply rejects a filled job', async () => {
  client.seed('jobs', 'job-1', job({ status: 'filled' }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'This job is filled and no longer accepts applications.');
  assert.equal(Object.keys(client.readAll('applications')).length, 0,
    'no application should be created for a filled job');
});

test('POST /applications/apply rejects a legacy Filled job', async () => {
  client.seed('jobs', 'job-1', job({ status: 'Filled' }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'This job is filled and no longer accepts applications.');
  assert.equal(Object.keys(client.readAll('applications')).length, 0,
    'no application should be created for a Filled job');
});

test('POST /applications/apply rejects a closed job', async () => {
  client.seed('jobs', 'job-1', job({ status: 'closed' }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Applications for this job are closed.');
  assert.equal(Object.keys(client.readAll('applications')).length, 0,
    'no application should be created for a closed job');
});

test('POST /applications/apply rejects a legacy Closed job', async () => {
  client.seed('jobs', 'job-1', job({ status: 'Closed' }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Applications for this job are closed.');
  assert.equal(Object.keys(client.readAll('applications')).length, 0,
    'no application should be created for a Closed job');
});

test('POST /applications/apply rejects an expired deadline', async () => {
  client.seed('jobs', 'job-1', job({ applicationDeadline: '2023-01-01' }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'The application deadline for this job has passed.');
  assert.equal(Object.keys(client.readAll('applications')).length, 0,
    'no application should be created when deadline has passed');
});

test('POST /applications/apply accepts a job with a future deadline', async () => {
  const futureDeadline = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  await client.seed('jobs', 'job-1', job({ applicationDeadline: futureDeadline }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Application submitted successfully');
  const apps = Object.keys(client.readAll('applications'));
  assert.equal(apps.length, 1, 'application should be created');
});

test('POST /applications/apply succeeds when job deadline is null', async () => {
  client.seed('jobs', 'job-1', job({ applicationDeadline: null }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Application submitted successfully');
  const apps = Object.keys(client.readAll('applications'));
  assert.equal(apps.length, 1, 'application should be created');
});

test('POST /applications/apply succeeds when job deadline is an invalid date string', async () => {
  client.seed('jobs', 'job-1', job({ applicationDeadline: 'not-a-date' }));
  const res = await employeeApi.post('/applications/apply', {
    body: { jobId: 'job-1', fullName: 'Test User', message: 'I can do this' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Application submitted successfully');
  const apps = Object.keys(client.readAll('applications'));


});
