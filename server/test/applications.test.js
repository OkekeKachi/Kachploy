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

test.beforeEach(async () => {
  client.fake.resetAll();
  // Fixtures use postedBy: 'employer-1' and employeeId: 'employee-1'.
  employeeApi = await client.authed('employee-1');
  employerApi = await client.authed('employer-1');
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
  client.seed('applications', 'app-1', application({ jobId: 'job-1' }));

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
    assert.equal(res.body.message, 'Invalid status. Must be one of: pending, accepted, rejected.');
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
  // written from a pending application with no relation to the previous status.
  for (const status of ['pending', 'accepted', 'rejected']) {
    client.seed('applications', 'app-1', application({ jobId: 'job-1' }));

    const res = await employerApi.put('/applications/app-1/status', { body: { status } });

    assert.equal(res.status, 200, `expected 200 for ${status}`);
    assert.equal(client.readDoc('applications', 'app-1').status, status);
  }
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

// ----------------------------------------------------- duplicate POST /tasks

test('POST /applications/tasks duplicates POST /tasks', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  // STAGE 6K: this route shares requireTaskAssignment with POST /tasks, so it now
  // inherits the requirement that the assignee's application is accepted too.
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'accepted' })
  );

  const res = await employerApi.post('/applications/tasks', {
    body: {
      jobId: 'job-1',
      employeeId: 'employee-1',
      taskName: 'Replace washer',
      taskDescription: 'Fit a new washer',
      dueDate: '2026-10-01',
    },
  });

  // DEAD CODE: this route is never called by the client, which uses POST /tasks.
  // It now applies the same task-assignment authorization guard.
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Task created successfully');

  const stored = Object.values(client.readAll('tasks'))[0];
  assert.equal(stored.taskName, 'Replace washer');
});

test('POST /applications/tasks rejects a body with no jobId or employeeId', async () => {
  const res = await employerApi.post('/applications/tasks', { body: {} });

  // Stage 1: was 200 (creating an entirely empty task document); the shared
  // assignment guard now rejects it with 400 like POST /tasks does.
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Missing required fields');
  assert.equal(Object.keys(client.readAll('tasks')).length, 0);
});
