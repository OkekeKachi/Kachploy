'use strict';

/**
 * Characterization tests for server/routes/jobs.js
 *
 * These lock in CURRENT behaviour, including known bugs. Tests marked
 * "QUIRK" or "BUG" assert behaviour that is wrong today; they exist so the
 * safety net notices if it changes, and so Stage 1+ knows what it must fix
 * deliberately. They are not endorsements of the behaviour.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job } = require('../testing/fixtures');

let client;
let api;
const now = () => '2026-01-01T00:00:00.000Z';
// jobs.js stamps timestamps with the process clock via new Date().toISOString(),
// which the injectable clock cannot control -- assert the shape instead.
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test.before(async () => {
  client = await startTestServer({ clock: now });
});

test.after(async () => {
  await client.close();
});

test.beforeEach(async () => {
  client.fake.resetAll();
  // The fixture posts jobs as 'employer-1', which is also the authenticated
  // identity, so ownership checks pass for the legitimate employer workflow.
  api = await client.authed('employer-1');
});

test('GET /jobs returns every job with its document id merged in', async () => {
  client.seed('jobs', 'job-1', job({ title: 'One' }));
  client.seed('jobs', 'job-2', job({ title: 'Two' }));

  const res = await api.get('/jobs');

  assert.equal(res.status, 200);
  assert.equal(res.body.jobs.length, 2);
  assert.deepEqual(
    res.body.jobs.map((j) => j.id).sort(),
    ['job-1', 'job-2']
  );
});

test('GET /jobs returns an empty array when there are no jobs', async () => {
  const res = await api.get('/jobs');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { jobs: [] });
});

test('POST /jobs/create persists the full document and returns 201', async () => {
  const res = await api.post('/jobs/create', {
    body: {
      title: 'New job',
      description: 'desc',
      location: 'Abuja',
      jobType: 'cleaning',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 5000,
      postedBy: 'someone-else',
      negotiable: 'yes',
      skillsRequired: ['cleaning'],
      requirements: ['own supplies'],
      responsibilities: ['clean'],
    },
  });

  assert.equal(res.status, 201);
  assert.match(res.body.message, /Job posted successfully/);
  assert.ok(res.body.jobId);

  const stored = client.readDoc('jobs', res.body.jobId);
  assert.equal(stored.title, 'New job');
  // Stage 1: postedBy in the body is ignored; the author is the token holder.
  assert.equal(stored.postedBy, 'employer-1');
  assert.equal(stored.negotiable, 'yes');
  assert.match(stored.createdAt, ISO);
  // STAGE 5H: jobs were deliberately left on ISO strings while applications and
  // tasks moved onto serverTimestamp(), so the type is asserted explicitly rather
  // than only implied by the ISO regex. A later stage that migrates jobs onto
  // Timestamps has to change this line deliberately instead of quietly passing.
  assert.equal(typeof stored.createdAt, 'string', 'jobs.createdAt stays an ISO string');
});

test('POST /jobs/create applies defaults for omitted optional fields', async () => {
  const res = await api.post('/jobs/create', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 1,
      postedBy: 'e',
    },
  });

  const stored = client.readDoc('jobs', res.body.jobId);
  assert.equal(stored.status, 'open');
  assert.equal(stored.expectedEndDate, null);
  assert.deepEqual(stored.skillsRequired, []);
  assert.deepEqual(stored.requirements, []);
    assert.deepEqual(stored.responsibilities, []);
});

test('POST /jobs/create ignores a client-supplied status', async () => {
  // STAGE 5G: createJob destructured `status = 'open'`, so the default only
  // applied when the body omitted it -- posting `status: 'Filled'` created a job
  // that was already filled. A new job is now always open.
  for (const status of ['Filled', 'filled', 'closed', 'banana']) {
    const res = await api.post('/jobs/create', {
      body: {
        title: 'T',
        description: 'D',
        location: 'L',
        jobType: 'JT',
        applicationDeadline: '2026-11-01',
        jobStartDate: '2026-11-05',
        price: 1,
        postedBy: 'e',
        status,
      },
    });

    assert.equal(res.status, 201, `expected 201 for ${status}`);
    assert.equal(client.readDoc('jobs', res.body.jobId).status, 'open', `for ${status}`);
  }
});

test('POST /jobs/create writes no proposal counter', async () => {
  // STAGE 5E: createJob used to write a hardcoded `proposal: 0` that nothing
  // incremented and no consumer read, so the job advertised an applicant count
  // that was permanently zero. The field is gone rather than replaced.
  const res = await api.post('/jobs/create', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 1,
      postedBy: 'e',
      negotiable: 'no',
    },
  });

  const stored = client.readDoc('jobs', res.body.jobId);
  assert.equal('proposal' in stored, false, 'no proposal counter may be written');
  assert.equal('proposals' in stored, false);
  assert.equal('applicantCount' in stored, false, 'the count stays a read model, not a field');
});

test('GET /jobs/:jobId returns a job that carries no counter fields', async () => {
  // The read path must not reintroduce a count. A job document is returned as
  // stored, so a freshly created one has nothing count-shaped on it at all.
  const created = await api.post('/jobs/create', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 1,
      postedBy: 'employer-1',
      negotiable: 'no',
    },
  });

  const res = await api.get(`/jobs/${created.body.jobId}`);

  assert.equal(res.status, 200);
  assert.equal('proposal' in res.body.job, false);
  assert.equal('proposals' in res.body.job, false);
  assert.equal('applicantCount' in res.body.job, false);
});

test('GET /jobs/:jobId passes legacy counter fields through untouched', async () => {
  // Data compatibility: a document written before Stage 5E still carries
  // `proposal`/`proposals`. The read does not strip, rename or interpret them --
  // they are simply no longer used by any code path.
  client.seed('jobs', 'job-legacy', job({ proposal: 4, proposals: -2 }));

  const res = await api.get('/jobs/job-legacy');

  assert.equal(res.status, 200);
  assert.equal(res.body.job.proposal, 4);
  assert.equal(res.body.job.proposals, -2);
});

test('POST /jobs/create stores negotiable as a raw string', async () => {
  const res = await api.post('/jobs/create', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 1,
      postedBy: 'e',
      negotiable: 'no',
    },
  });

  // QUIRK (preserved): the client sends "yes"/"no" strings; they are persisted
  // verbatim and never coerced to boolean. Stage 5D made `negotiable` the
  // canonical name and did NOT change this value contract.
  const stored = client.readDoc('jobs', res.body.jobId);
  assert.equal(stored.negotiable, 'no');

  // Stage 5D: the canonical field is the only one written for this concept.
  assert.equal(stored.isNegotiable, undefined);
});

test('POST /jobs/create persists the canonical negotiable field on a negotiable job', async () => {
  const res = await api.post('/jobs/create', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 1,
      postedBy: 'e',
      negotiable: 'yes',
    },
  });

  // The string survives untouched, and no second spelling of the concept is
  // written alongside it.
  assert.equal(client.readDoc('jobs', res.body.jobId).negotiable, 'yes');
  assert.equal(client.readDoc('jobs', res.body.jobId).isNegotiable, undefined);
});

test('POST /jobs/create round-trips negotiable through the job read endpoint', async () => {
  // Stage 5D: the read path must hand the same field back, because that is the
  // document JobDetails.jsx now derives its proposed-price UI from.
  const created = await api.post('/jobs/create', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 1,
      postedBy: 'employer-1',
      negotiable: 'yes',
    },
  });

  const res = await api.get(`/jobs/${created.body.jobId}`);

  assert.equal(res.status, 200);
  assert.equal(res.body.job.negotiable, 'yes');
  assert.equal(res.body.job.isNegotiable, undefined);
});

test('POST /jobs/create rejects missing required fields', async () => {
  const base = {
    title: 'T',
    description: 'D',
    location: 'L',
    jobType: 'JT',
    applicationDeadline: '2026-11-01',
    jobStartDate: '2026-11-05',
    price: 1,
    postedBy: 'e',
  };

  for (const field of ['title', 'description', 'location', 'jobType']) {
    const body = { ...base };
    delete body[field];
    const res = await api.post('/jobs/create', { body });
    assert.equal(res.status, 400, `expected 400 when ${field} is missing`);
    assert.equal(res.body.message, 'Missing required fields');
  }
});

test('POST /jobs/create rejects a price of 0 (falsy check)', async () => {
  const res = await api.post('/jobs/create', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-11-01',
      jobStartDate: '2026-11-05',
      price: 0,
      postedBy: 'e',
    },
  });

  // QUIRK: `!price` is truthiness-based, so a legitimate 0 price is rejected
  // while the string "0" is accepted.
  assert.equal(res.status, 400);
});

test('GET /jobs/employer/:uid returns only that employer\'s jobs', async () => {
  client.seed('jobs', 'a1', job({ postedBy: 'employer-1' }));
  client.seed('jobs', 'a2', job({ postedBy: 'employer-1' }));
  client.seed('jobs', 'b1', job({ postedBy: 'employer-2' }));

  const res = await api.get('/jobs/employer/employer-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.jobs.length, 2);
  assert.ok(res.body.jobs.every((j) => j.postedBy === 'employer-1'));
});

test('GET /jobs/employer/:uid returns an empty array when the employer has no jobs', async () => {
  const nobody = await client.authed('nobody');
  const res = await nobody.get('/jobs/employer/nobody');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { jobs: [] });
});

test('GET /jobs/:jobId returns the raw document', async () => {
  client.seed('jobs', 'job-1', job({ title: 'Tap' }));

  const res = await api.get('/jobs/job-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.job.title, 'Tap');
});

test('GET /jobs/:jobId omits id and array defaults (dead duplicate route)', async () => {
  // A "legacy" document predating the skillsRequired/requirements/
  // responsibilities fields.
  client.seed('jobs', 'job-2', { title: 'Legacy job', postedBy: 'e' });

  const res = await api.get('/jobs/job-2');

  assert.equal(res.status, 200);
  // BUG: GET /:jobId is registered twice. Express uses the first
  // (jobController.getJob), which returns jobSnapshot.data() raw. The second
  // (jobController.getJobWithDefaults) -- the one that adds `id` and defaults
  // the arrays -- is unreachable dead code. JobDetails.jsx relies on both, so a
  // legacy job crashes the page. Removal is scheduled for Stage 7.
  assert.equal(res.body.job.id, undefined);
  assert.equal(res.body.job.skillsRequired, undefined);
  assert.equal(res.body.job.requirements, undefined);
  assert.equal(res.body.job.responsibilities, undefined);
});

test('GET /jobs/:jobId returns 404 for a missing job', async () => {
  const res = await api.get('/jobs/does-not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
});

test('PUT /jobs/edit/:jobId updates and coerces price to a number', async () => {
  client.seed('jobs', 'job-1', job());

  const res = await api.put('/jobs/edit/job-1', {
    body: {
      title: 'Updated title',
      description: 'Updated description',
      location: 'Ibadan',
      jobType: 'electrical',
      applicationDeadline: '2026-10-10',
      jobStartDate: '2026-10-12',
      price: '25000',
      negotiable: 'yes',
    },
  });

  assert.equal(res.status, 200);
  assert.match(res.body.message, /Job updated successfully/);

  const stored = client.readDoc('jobs', 'job-1');
  assert.equal(stored.title, 'Updated title');
  assert.equal(stored.price, 25000);
  assert.equal(typeof stored.price, 'number');
  assert.match(stored.updatedAt, ISO);
  // STAGE 5H: same deliberate exception as jobs.createdAt -- jobs keep ISO
  // strings this stage, so the type is pinned explicitly.
  assert.equal(typeof stored.updatedAt, 'string', 'jobs.updatedAt stays an ISO string');
  assert.ok(res.body.updatedFields.includes('title'));
});

test('PUT /jobs/edit/:jobId omits optional fields when falsy or not arrays', async () => {
  client.seed('jobs', 'job-1', job({ skillsRequired: ['plumbing'] }));

  const res = await api.put('/jobs/edit/job-1', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-10-10',
      jobStartDate: '2026-10-12',
      price: 100,
      skillsRequired: 'not-an-array',
      expectedEndDate: null,
    },
  });

  assert.equal(res.status, 200);
  const stored = client.readDoc('jobs', 'job-1');
  // QUIRK: skillsRequired is sent as a string, so the guard skips it and the
  // previous value survives; expectedEndDate is null so it is not cleared.
  assert.deepEqual(stored.skillsRequired, ['plumbing']);
  assert.equal(stored.expectedEndDate, '2026-10-06');
});

test('PUT /jobs/edit/:jobId returns 400 without required fields', async () => {
  client.seed('jobs', 'job-1', job());

  const res = await api.put('/jobs/edit/job-1', { body: { title: 'only title' } });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Required fields are missing.');
});

test('PUT /jobs/edit/:jobId returns 404 for a missing job', async () => {
  const res = await api.put('/jobs/edit/nope', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-10-10',
      jobStartDate: '2026-10-12',
      price: 100,
    },
  });

  assert.equal(res.status, 404);
});

test('PUT /jobs/edit/:jobId allows price 0 (uses `price === undefined`)', async () => {
  client.seed('jobs', 'job-1', job());

  const res = await api.put('/jobs/edit/job-1', {
    body: {
      title: 'T',
      description: 'D',
      location: 'L',
      jobType: 'JT',
      applicationDeadline: '2026-10-10',
      jobStartDate: '2026-10-12',
      price: 0,
    },
  });

  // QUIRK: create rejects price 0 but edit accepts it. The two validators
  // disagree.
  assert.equal(res.status, 200);
  assert.equal(client.readDoc('jobs', 'job-1').price, 0);
});

test('DELETE /jobs/:jobId removes the document', async () => {
  client.seed('jobs', 'job-1', job());

  const res = await api.delete('/jobs/job-1');

  assert.equal(res.status, 200);
  assert.match(res.body.message, /Job deleted successfully/);
  assert.equal(client.readDoc('jobs', 'job-1'), undefined);
});

test('DELETE /jobs/:jobId returns 404 for a missing job', async () => {
  const res = await api.delete('/jobs/nope');
  assert.equal(res.status, 404);
});

test('PUT /jobs/:jobId/status updates the status', async () => {
  client.seed('jobs', 'job-1', job({ status: 'open' }));

  const res = await api.put('/jobs/job-1/status', { body: { status: 'filled' } });

  assert.equal(res.status, 200);
  // Stage 5G: was the title-cased 'Filled' the client used to write.
  assert.equal(client.readDoc('jobs', 'job-1').status, 'filled');
});

test('PUT /jobs/:jobId/status accepts every canonical status', async () => {
  // Stage 5G: an allow-list, not a transition matrix. Each value is written from
  // an open job with no relation to the previous status.
  for (const status of ['open', 'filled', 'closed']) {
    client.seed('jobs', 'job-1', job({ status: 'open' }));

    const res = await api.put('/jobs/job-1/status', { body: { status } });

    assert.equal(res.status, 200, `expected 200 for ${status}`);
    assert.equal(client.readDoc('jobs', 'job-1').status, status);
  }
});

test('PUT /jobs/:jobId/status rejects a value outside the allow-list', async () => {
  client.seed('jobs', 'job-1', job({ status: 'open' }));

  // Stage 5G: `banana` used to be stored. `Filled` is the legacy spelling the
  // client wrote -- existing documents still hold it and are read as filled, but
  // it is no longer accepted on write. `paused` was a dashboard filter and badge
  // with no writer anywhere; no writer is being added, so it is rejected too.
  for (const status of ['banana', 'Filled', 'paused', 'Filled ', 'OPEN', 0, null, '']) {
    const res = await api.put('/jobs/job-1/status', { body: { status } });

    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(status)}`);
    assert.equal(res.body.message, 'Invalid status. Must be one of: open, filled, closed.');
    assert.equal(client.readDoc('jobs', 'job-1').status, 'open');
  }
});

test('PUT /jobs/:jobId/status returns 404 for a missing job', async () => {
  const res = await api.put('/jobs/nope/status', { body: { status: 'filled' } });

  // Stage 1: requireJobOwner now checks existence before the handler runs, so
  // this is a 404 instead of the 500 the un-guarded update used to produce.
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
});

test('PUT /jobs/:jobId/status with no body does not overwrite status', async () => {
  client.seed('jobs', 'job-1', job({ status: 'open' }));

  const res = await api.put('/jobs/job-1/status', { body: {} });

  // Stage 5G: this used to return 200 and write `undefined` over the previous
  // value. An absent status is not a valid status, so it is now a 400 and the
  // stored value survives.
  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Invalid status. Must be one of: open, filled, closed.');
  assert.equal(client.readDoc('jobs', 'job-1').status, 'open');
});

test('PUT /jobs/:jobId/status with an undefined status does not overwrite status', async () => {
  client.seed('jobs', 'job-1', job({ status: 'filled' }));

  const res = await api.put('/jobs/job-1/status', { body: { status: undefined } });

  assert.equal(res.status, 400);
  assert.equal(client.readDoc('jobs', 'job-1').status, 'filled');
});

test('GET /jobs leaves a legacy Filled status readable', async () => {
  client.seed('jobs', 'job-1', job({ status: 'Filled' }));

  // Stage 5G: legacy documents are not migrated, backfilled or cleaned up. The
  // stored value is returned untouched; it is the frontend that treats 'Filled'
  // as 'filled'.
  const res = await api.get('/jobs/job-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.job.status, 'Filled');
});
