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
const { job, application, employment, contract, milestone, task } = require('../testing/fixtures');

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
  assert.equal(record.startDate, '2099-10-05');
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
  // still succeeds. The duplicate guard is the query on the collection, which finds
  // the employment this application already has and records no second one.
  const res = await hire();

  assert.equal(res.status, 200);
  assert.equal(employments().length, 1);
});

// ---------------------------------------------------------------------------
// STAGE 7H-2: one employment per application.
//
// The 7G-1 tests above cover the paths the employer UI actually walks. These cover
// the duplicate the `previousStatus` inference could not see: an application that
// reaches `accepted` with a previousStatus other than `accepted`, so the inference
// passed it straight through and a second employment was written for a single
// hire. The guard is now a query on the collection instead.
//
// STAGE 10H.2: the original walkthrough drove this through `rejected`
// (hire -> reject -> clear -> hire). Rejecting an application whose employment is
// active is now refused, so that route is closed; the reachable route to a
// non-`accepted` previousStatus is the direct `interviewed` write the status
// allow-list permits. The duplicate is exercised the same way either way.
// ---------------------------------------------------------------------------

test('a first hire records exactly one employment', async () => {
  seedInterviewedApplication();

  const res = await hire();

  assert.equal(res.status, 200);
  assert.equal(employments().length, 1);
  assert.equal(employments()[0].applicationId, 'app-1');
  assert.equal(employments()[0].status, 'active');
});

test('hiring again after the application is cleared again records no second employment', async () => {
  // The regression this stage exists for. The second hire arrives with previousStatus
  // `interviewed`, so the old previousStatus inference passed it through -- only a
  // query on the collection stands between this path and a duplicate.
  //
  // STAGE 10H.2: this test used to reach `interviewed` by hiring, rejecting, then
  // clearing. Rejecting a hired applicant is now refused while the employment is
  // active, so the clear is driven directly: `accepted -> interviewed` is a write the
  // status allow-list permits (the client gates the visible clear action; the server
  // does not forbid the value). The second hire then sees exactly the previousStatus
  // the old inference could not catch.
  seedInterviewedApplication();
  await hire();
  assert.equal(employments().length, 1);

  const cleared = await hire('interviewed');
  assert.equal(cleared.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'interviewed');

  const rehired = await hire();
  assert.equal(rehired.status, 200);

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
// 4b. A failed employment write is recoverable by retry.
//
// updateApplicationStatus now performs the status write, employment, proposal
// consumption, contract and milestones in ONE Firestore transaction (Stage
// 3C.1.3). A failure in any staged write aborts the whole transaction, so the
// application, employment, proposal, contract and milestones are left exactly as
// they were. These tests pin that all-or-nothing behaviour and the fact that a
// retry then records the hire exactly once.
// ---------------------------------------------------------------------------

// The repository is required lazily, after startTestServer has installed the
// fake Firestore in require.cache, for the same reason the service-level tests at
// the end of this file are: requiring it at the top of the file would load the
// real config/firebase.js. runTransaction is swapped on the shared module object
// the running app already holds, and restored by the returned function.
function failNextDbRunTransaction() {
  const firebase = require('../config/firebase');
  const original = firebase.db.runTransaction;
  let remaining = 1;

  firebase.db.runTransaction = async (...args) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new Error('transient transaction failure');
    }
    return original.apply(firebase.db, args);
  };

  return () => {
    firebase.db.runTransaction = original;
  };
}

// STAGE 3C.1.3. Fail a STAGED WRITE inside the real transaction, after some
// writes have been buffered. This is stronger than failNextDbRunTransaction
// (which throws before the callback): it proves the transaction's own rollback,
// not merely that a thrown callback wrote nothing.
function failNextTransactionSet() {
  const firebase = require('../config/firebase');
  const original = firebase.db.runTransaction;
  let remaining = 1;

  firebase.db.runTransaction = async (callback) => original.call(firebase.db, async (tx) => {
    let sets = 0;
    const wrapped = {
      get: (ref) => tx.get(ref),
      update: (ref, data) => tx.update(ref, data),
      create: (ref, data) => tx.create(ref, data),
      set: (ref, data) => {
        sets += 1;
        if (remaining > 0 && sets === 2) {
          remaining -= 1;
          throw new Error('simulated staged-write failure');
        }
        return tx.set(ref, data);
      },
    };
    return callback(wrapped);
  });

  return () => {
    firebase.db.runTransaction = original;
  };
}

/** Every document in a collection, as an array of `{ id, ...data }`. */
const documentsIn = (collection) =>
  Object.entries(client.readAll(collection)).map(([id, data]) => ({ id, ...data }));

/** Recursively asserts no stored value is `undefined` (Firestore rejects it). */
function assertNoUndefined(value, path = 'document') {
  assert.notEqual(value, undefined, `${path} must not be undefined`);
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(child, undefined, `${path}.${key} must not be undefined`);
    assertNoUndefined(child, `${path}.${key}`);
  }
}

/** An accepted proposal with a non-empty milestone schedule. */
function seedAcceptedMilestoneProposal(overrides = {}) {
  client.seed('contractProposals', 'prop-1', {
    applicationId: 'app-1',
    jobId: 'job-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    paymentMode: 'milestones',
    currency: 'NGN',
    totalAmountMinor: 900000,
    commissionBps: 500,
    commissionAmountMinor: 45000,
    milestones: [
      { label: 'Strip and sand', amountMinor: 300000, description: 'Prepare the surface' },
      { label: 'Prime and paint', amountMinor: 400000, description: 'Two coats' },
      { label: 'Final inspection', amountMinor: 200000, description: '' },
    ],
    status: 'accepted',
    acceptedAt: { _seconds: 1767225600, _nanoseconds: 0 },
    acceptedBy: 'employee-1',
    ...overrides,
  });
}

test('a hire whose employment write fails is aborted atomically', async () => {
  seedInterviewedApplication();
  const restore = failNextDbRunTransaction();
  const originalError = console.error;
  console.error = () => {};

  try {
    const res = await hire();

    // Atomic: transaction aborts, application reverted to previous state
    assert.notEqual(res.status, 200);
    assert.equal(client.readDoc('applications', 'app-1').status, 'interviewed');

    assert.deepEqual(employments(), []);
    assert.deepEqual(documentsIn('contracts'), []);
    assert.deepEqual(documentsIn('milestones'), []);
    assert.deepEqual(documentsIn('tasks'), []);
    const proposal = client.readDoc('contractProposals', 'prop-1');
    assert.equal(proposal.consumedByEmploymentId, undefined);
    assert.equal(proposal.consumedAt, undefined);
  } finally {
    console.error = originalError;
    restore();
  }
});

test('a failure during a staged transaction write leaves no partial hire state', async () => {
  seedInterviewedApplication();
  // Replace the full-payment proposal with a multi-milestone one so the staged
  // contract + milestone writes are part of the transaction when it fails.
  seedAcceptedMilestoneProposal();
  const restore = failNextTransactionSet();
  const originalError = console.error;
  console.error = () => {};

  try {
    const res = await hire();

    assert.notEqual(res.status, 200);
    assert.equal(client.readDoc('applications', 'app-1').status, 'interviewed');
    assert.deepEqual(employments(), []);
    assert.deepEqual(documentsIn('contracts'), []);
    assert.deepEqual(documentsIn('milestones'), []);
    assert.deepEqual(documentsIn('tasks'), [], 'generated tasks are rolled back with the schedule');

    const proposal = client.readDoc('contractProposals', 'prop-1');
    assert.equal(proposal.consumedByEmploymentId, undefined, 'proposal is not consumed');
    assert.equal(proposal.consumedAt, undefined, 'proposal is not stamped');
  } finally {
    console.error = originalError;
    restore();
  }
});

test('re-sending accepted after a failed employment write records the missing employment', async () => {
  seedInterviewedApplication();
  const restore = failNextDbRunTransaction();
  const originalError = console.error;
  console.error = () => {};

  try {
    const failed = await hire();
    assert.notEqual(failed.status, 200);
    assert.deepEqual(employments(), [], 'the first employment write failed');
    assert.equal(client.readDoc('applications', 'app-1').status, 'interviewed');

    // Retry with fresh unconsumed accepted proposal
    client.seed('contractProposals', 'prop-2', {
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

    const repaired = await hire();
    assert.equal(repaired.status, 200);
    assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');

    assert.equal(employments().length, 1);
    const [record] = employments();
    assert.equal(record.employerId, 'employer-1');
    assert.equal(record.employeeId, 'employee-1');
    assert.equal(record.jobId, 'job-1');
    assert.equal(record.applicationId, 'app-1');
    assert.equal(record.status, 'active');

    const again = await hire();
    assert.equal(again.status, 200);
    assert.equal(employments().length, 1);
  } finally {
    console.error = originalError;
    restore();
  }
});

// ---------------------------------------------------------------------------
// 4c. The hire records the accepted proposal's contract terms.
// ---------------------------------------------------------------------------

test('a hire records the accepted milestone schedule under deterministic ids', async () => {
  seedInterviewedApplication();
  seedAcceptedMilestoneProposal();

  const res = await hire();
  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');

  assert.equal(employments().length, 1);
  assert.equal(documentsIn('employments')[0].id, 'app-1');

  const contracts = documentsIn('contracts');
  assert.equal(contracts.length, 1);
  const [storedContract] = contracts;
  assert.equal(storedContract.id, 'app-1');
  assert.equal(storedContract.employmentId, 'app-1');
  assert.equal(storedContract.applicationId, 'app-1');
  assert.equal(storedContract.currency, 'NGN');
  assert.equal(storedContract.paymentMode, 'milestones');
  assert.equal(storedContract.totalAmountMinor, 900000);
  assert.equal(storedContract.commissionBps, 500);
  assert.equal(storedContract.commissionAmountMinor, 45000);
  assert.equal(storedContract.status, 'active');
  assert.equal(storedContract.acceptedBy, 'employee-1');
  assert.equal(storedContract.fromProposalId, 'prop-1');

  const milestones = Object.entries(client.readAll('milestones'))
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(milestones.map((m) => m.id), [
    'app-1_milestone_00',
    'app-1_milestone_01',
    'app-1_milestone_02',
  ]);
  assert.deepEqual(milestones.map((m) => m.label), ['Strip and sand', 'Prime and paint', 'Final inspection']);
  assert.deepEqual(milestones.map((m) => m.amountMinor), [300000, 400000, 200000]);
  assert.deepEqual(milestones.map((m) => m.description), ['Prepare the surface', 'Two coats', '']);
  for (const stored of milestones) {
    assert.equal(stored.contractId, 'app-1');
    assert.equal(stored.employmentId, 'app-1');
    assert.equal(stored.status, 'pending_acceptance');
    assert.equal(stored.taskId, undefined, 'a milestone no longer invents a task');
  }

  assert.deepEqual(documentsIn('tasks'), [], 'a hire creates no tasks; work is assigned separately');

  const proposal = client.readDoc('contractProposals', 'prop-1');
  assert.equal(proposal.consumedByEmploymentId, 'app-1');
  assert.ok(proposal.consumedAt, 'proposal is stamped as consumed');

  for (const collection of ['employments', 'contracts', 'milestones', 'tasks', 'contractProposals']) {
    for (const document of documentsIn(collection)) {
      assertNoUndefined(document, `${collection}/${document.id}`);
    }
  }
});

test('a hire without a job start date still writes the schedule and no tasks', async () => {
  seedInterviewedApplication({ jobStartDate: undefined });
  seedAcceptedMilestoneProposal();

  const res = await hire();
  assert.equal(res.status, 200);

  assert.equal(documentsIn('milestones').length, 3);
  assert.deepEqual(documentsIn('tasks'), []);
  for (const document of documentsIn('milestones')) {
    assertNoUndefined(document, `milestones/${document.id}`);
  }
});

test('a matching existing contract and schedule are not duplicated by the hire', async () => {
  seedInterviewedApplication();
  seedAcceptedMilestoneProposal();
  client.seed('contracts', 'app-1', contract({
    employmentId: 'app-1',
    applicationId: 'app-1',
    paymentMode: 'milestones',
    totalAmountMinor: 900000,
    commissionBps: 500,
    commissionAmountMinor: 45000,
    status: 'active',
    createdAt: { _seconds: 111, _nanoseconds: 0 },
  }));
  const seededMilestones = [
    { id: 'app-1_milestone_00', label: 'Strip and sand', amountMinor: 300000, description: 'Prepare the surface' },
    { id: 'app-1_milestone_01', label: 'Prime and paint', amountMinor: 400000, description: 'Two coats' },
    { id: 'app-1_milestone_02', label: 'Final inspection', amountMinor: 200000, description: '' },
  ];
  for (const seeded of seededMilestones) {
    client.seed('milestones', seeded.id, milestone({
      contractId: 'app-1',
      employmentId: 'app-1',
      label: seeded.label,
      amountMinor: seeded.amountMinor,
      description: seeded.description,
    }));
  }

  const res = await hire();
  assert.equal(res.status, 200);

  assert.equal(documentsIn('contracts').length, 1);
  const [storedContract] = documentsIn('contracts');
  assert.deepEqual(storedContract.createdAt, { _seconds: 111, _nanoseconds: 0 }, 'contract is preserved, not rewritten');

  const milestones = Object.entries(client.readAll('milestones')).map(([id, data]) => ({ id, ...data }));
  assert.equal(milestones.length, 3, 'the schedule is not duplicated');
  assert.deepEqual(milestones.map((m) => m.id).sort(), seededMilestones.map((m) => m.id).sort());
  assert.deepEqual(documentsIn('tasks'), [], 'an existing schedule is not backfilled with tasks');

  assert.equal(employments().length, 1, 'the missing employment is still created');
  assert.equal(client.readDoc('contractProposals', 'prop-1').consumedByEmploymentId, 'app-1');
});

test('a hire refuses an accepted milestone with no label before writing anything', async () => {
  seedInterviewedApplication();
  seedAcceptedMilestoneProposal({
    totalAmountMinor: 500000,
    commissionAmountMinor: 25000,
    milestones: [{ label: '', amountMinor: 500000, description: 'Missing its task name' }],
  });

  const res = await hire();
  assert.equal(res.status, 400);
  assert.match(res.body.message, /no label/);

  assert.deepEqual(employments(), []);
  assert.deepEqual(documentsIn('contracts'), []);
  assert.deepEqual(documentsIn('milestones'), []);
  assert.deepEqual(documentsIn('tasks'), []);
  assert.equal(client.readDoc('applications', 'app-1').status, 'interviewed');
  assert.equal(client.readDoc('contractProposals', 'prop-1').consumedByEmploymentId, undefined);
});

test('a hire leaves existing tasks untouched and does not depend on their ids', async () => {
  seedInterviewedApplication();
  seedAcceptedMilestoneProposal();
  client.seed('tasks', 'app-1_milestone_00_task', task({
    jobId: 'job-1',
    employeeId: 'employee-1',
    taskName: 'Existing task',
    employmentId: 'app-1',
  }));

  const res = await hire();
  assert.equal(res.status, 200);

  assert.equal(client.readDoc('tasks', 'app-1_milestone_00_task').taskName, 'Existing task');
  assert.equal(Object.keys(client.readAll('tasks')).length, 1, 'no extra task is generated');
  assert.equal(employments().length, 1);
  assert.equal(documentsIn('contracts').length, 1);
  assert.equal(documentsIn('milestones').length, 3);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
  assert.equal(client.readDoc('contractProposals', 'prop-1').consumedByEmploymentId, 'app-1');
});

test('a hire whose existing contract disagrees with the proposal is rejected without consuming it', async () => {
  seedInterviewedApplication();
  seedAcceptedMilestoneProposal();
  client.seed('contracts', 'app-1', contract({
    employmentId: 'app-1',
    applicationId: 'app-1',
    paymentMode: 'milestones',
    totalAmountMinor: 800000,
    status: 'active',
    createdAt: { _seconds: 111, _nanoseconds: 0 },
  }));
  client.seed('milestones', 'app-1_milestone_00', milestone({
    contractId: 'app-1',
    employmentId: 'app-1',
    label: 'Strip and sand',
    amountMinor: 300000,
  }));

  const res = await hire();
  assert.equal(res.status, 400);
  assert.match(res.body.message, /Contract terms conflict with accepted proposal/);

  assert.equal(client.readDoc('applications', 'app-1').status, 'interviewed', 'application is unchanged');
  assert.deepEqual(employments(), [], 'no employment is created');
  assert.equal(documentsIn('contracts').length, 1);
  assert.equal(documentsIn('contracts')[0].totalAmountMinor, 800000, 'the existing contract is untouched');
  assert.equal(documentsIn('milestones').length, 1, 'the existing schedule is untouched');
  assert.deepEqual(documentsIn('tasks'), [], 'a rejected hire creates no tasks');

  const proposal = client.readDoc('contractProposals', 'prop-1');
  assert.equal(proposal.consumedByEmploymentId, undefined, 'proposal is not consumed');
  assert.equal(proposal.consumedAt, undefined, 'proposal is not stamped');
});

test('two concurrent hires produce exactly one employment and contract schedule', async () => {
  seedInterviewedApplication();
  seedAcceptedMilestoneProposal();

  const [first, second] = await Promise.all([hire(), hire()]);
  const statuses = [first.status, second.status];
  // A hire is idempotent: whichever request loses may observe the winner's
  // committed state and no-op with 200, or lose the transaction conflict and be
  // refused with 400. Either is correct; what matters is the invariant below.
  assert.ok(statuses.includes(200), 'at least one hire succeeds');
  assert.ok(statuses.every((status) => status === 200 || status === 400), 'no unexpected failure');

  assert.equal(employments().length, 1);
  assert.equal(documentsIn('contracts').length, 1);
  assert.equal(documentsIn('milestones').length, 3);
  assert.equal(documentsIn('tasks').length, 0, 'neither hire generates tasks');
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
  assert.equal(client.readDoc('contractProposals', 'prop-1').consumedByEmploymentId, 'app-1');
});

// ---------------------------------------------------------------------------
// 4d. The fake enforces the real transaction contract, so the tests above mean
// something against Firestore too.
// ---------------------------------------------------------------------------

test('the fake rejects a transaction that reads after it writes', async () => {
  client.seed('applications', 'app-rbw', { status: 'interviewed' });
  const db = client.fake.db;

  await assert.rejects(
    () => db.runTransaction(async (tx) => {
      const ref = db.collection('applications').doc('app-rbw');
      tx.update(ref, { status: 'accepted' });
      await tx.get(ref);
    }),
    /all reads to be executed before all writes/
  );

  assert.equal(client.readDoc('applications', 'app-rbw').status, 'interviewed');
});

test('the fake detects a concurrent write and retries, so one consumer wins', async () => {
  const db = client.fake.db;
  client.seed('contractProposals', 'prop-c', { applicationId: 'app-c', status: 'accepted' });

  let releaseFirst;
  const firstMayCommit = new Promise((resolve) => { releaseFirst = resolve; });
  let firstHasRead;
  const firstRead = new Promise((resolve) => { firstHasRead = resolve; });

  const first = db.runTransaction(async (tx) => {
    const ref = db.collection('contractProposals').doc('prop-c');
    const snapshot = await tx.get(ref);
    firstHasRead();
    await firstMayCommit;
    if (snapshot.data().consumedByEmploymentId) {
      throw new Error('already consumed');
    }
    tx.update(ref, { consumedByEmploymentId: 'first' });
    return 'first';
  });

  await firstRead;
  const winner = await db.runTransaction(async (tx) => {
    const ref = db.collection('contractProposals').doc('prop-c');
    await tx.get(ref);
    tx.update(ref, { consumedByEmploymentId: 'second' });
    return 'second';
  });
  assert.equal(winner, 'second');
  assert.equal(client.readDoc('contractProposals', 'prop-c').consumedByEmploymentId, 'second');

  releaseFirst();
  await assert.rejects(first, /already consumed/);
  assert.equal(
    client.readDoc('contractProposals', 'prop-c').consumedByEmploymentId,
    'second',
    'the retried transaction did not overwrite the winner'
  );
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
// 7. STAGE 10H.1: the employer-management reads.
//
//   GET /employments/job/:jobId    -- every employment on a job the caller owns
//   GET /employments/:employmentId -- one employment the caller is party to
//
// The first is guarded by requireJobOwner (authority from the job's postedBy);
// the second by requireEmploymentParty (authority from the employment's own
// stored employerId/employeeId). Both are seeded directly, because this resource
// still has no create endpoint.
// ---------------------------------------------------------------------------

/** Seeds job-1 (posted by employer-1) and one employment on it. */
function seedEmploymentOnJob(overrides = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('employments', 'emp-1', employment({ jobId: 'job-1', applicationId: 'app-1', ...overrides }));
}

test('the job owner reads every employment on the job', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('employments', 'emp-1', employment({ jobId: 'job-1', employeeId: 'employee-1', applicationId: 'app-1' }));
  client.seed('employments', 'emp-2', employment({ jobId: 'job-1', employeeId: 'employee-2', applicationId: 'app-2' }));

  const res = await employerApi.get('/employments/job/job-1');

  assert.equal(res.status, 200);
  // One job, two hires: both are returned, unlike the per-application read which
  // would answer with only one.
  assert.equal(res.body.employments.length, 2);
  assert.deepEqual(res.body.employments.map((e) => e.id).sort(), ['emp-1', 'emp-2']);
  assert.ok(res.body.employments.every((e) => e.jobId === 'job-1'));
});

test('the job read returns the stored documents unreshaped', async () => {
  seedEmploymentOnJob();

  const res = await employerApi.get('/employments/job/job-1');
  const stored = Object.entries(client.readAll('employments'))[0];

  // The same `{ id, ...document }` contract the self-scoped reads use, so a row
  // here and a row from GET /employments/employer/:uid agree field for field.
  assert.deepEqual(res.body.employments[0], { id: stored[0], ...stored[1] });
});

test('the job read is scoped to the one job in the path', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed('jobs', 'job-2', job({ postedBy: 'employer-1' }));
  client.seed('employments', 'emp-1', employment({ jobId: 'job-1', applicationId: 'app-1' }));
  client.seed('employments', 'emp-2', employment({ jobId: 'job-2', employeeId: 'employee-2', applicationId: 'app-2' }));

  const res = await employerApi.get('/employments/job/job-1');

  assert.equal(res.status, 200);
  // The employer owns both jobs, so this is the query filter under test, not the
  // guard: only job-1's employment is in the result.
  assert.deepEqual(res.body.employments.map((e) => e.id), ['emp-1']);
});

test('the job read returns an empty list, not a 404, when the job has no hires', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));

  const res = await employerApi.get('/employments/job/job-1');

  // The job exists and "nobody has been hired" is not a missing resource.
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.employments, []);
});

test('an unrelated employer cannot read a job\'s employments', async () => {
  seedEmploymentOnJob();
  const rival = await client.authed('employer-2');

  const res = await rival.get('/employments/job/job-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to view employments for this job');
  assert.equal(res.body.employments, undefined, 'no employment data may leak in a 403 body');
});

test('an unrelated employee cannot read a job\'s employments', async () => {
  seedEmploymentOnJob();
  const bystander = await client.authed('employee-9');

  const res = await bystander.get('/employments/job/job-1');

  // The job read is employer-scoped: being logged in as an employee confers no
  // access to a job someone else posted.
  assert.equal(res.status, 403);
  assert.equal(res.body.employments, undefined);
});

test('the employee on an employment still cannot read the job\'s employment list', async () => {
  seedEmploymentOnJob({ employeeId: 'employee-1' });

  // employee-1 is a party to the employment but NOT the job's poster, so the job
  // list -- an employer management view -- is still refused. The party read below
  // is the one that admits them.
  const res = await employeeApi.get('/employments/job/job-1');

  assert.equal(res.status, 403);
  assert.equal(res.body.employments, undefined);
});

test('the job read answers 404 for a job that does not exist', async () => {
  const res = await employerApi.get('/employments/job/job-missing');

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
  assert.equal(res.body.employments, undefined);
});

test('the employer on an employment can read it', async () => {
  seedEmploymentOnJob();

  const res = await employerApi.get('/employments/emp-1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.employment, { id: 'emp-1', ...client.readDoc('employments', 'emp-1') });
});

test('the employee on an employment can read it', async () => {
  seedEmploymentOnJob({ employeeId: 'employee-1' });

  const res = await employeeApi.get('/employments/emp-1');

  assert.equal(res.status, 200);
  assert.equal(res.body.employment.id, 'emp-1');
  assert.equal(res.body.employment.employeeId, 'employee-1');
  assert.equal(res.body.employment.status, 'active');
});

test('both parties read the same employment record', async () => {
  seedEmploymentOnJob();

  const byEmployer = await employerApi.get('/employments/emp-1');
  const byEmployee = await employeeApi.get('/employments/emp-1');

  assert.equal(byEmployer.status, 200);
  assert.equal(byEmployee.status, 200);
  assert.deepEqual(byEmployer.body.employment, byEmployee.body.employment);
});

test('an unrelated employer cannot read someone else\'s employment', async () => {
  client.seed('employments', 'emp-other', employment({ employerId: 'employer-2', employeeId: 'employee-2' }));
  // The record exists, so the refusal is about membership rather than the lookup.
  assert.equal(client.readDoc('employments', 'emp-other').employerId, 'employer-2');

  const res = await employerApi.get('/employments/emp-other');

  assert.equal(res.status, 403);
  assert.equal(res.body.employment, undefined, 'no employment data may leak in a 403 body');
});

test('an unrelated employee cannot read someone else\'s employment', async () => {
  client.seed('employments', 'emp-other', employment({ employerId: 'employer-2', employeeId: 'employee-2' }));

  const res = await employeeApi.get('/employments/emp-other');

  assert.equal(res.status, 403);
  assert.equal(res.body.employment, undefined);
});

test('the single read answers 404, not 403, for an employment that does not exist', async () => {
  const res = await employerApi.get('/employments/does-not-exist');

  // A missing document is a 404; a real document the caller is not party to is a
  // 403 (above). The two are distinguishable, which is what lets the guard avoid
  // disclosing an existence it then refuses.
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Employment not found');
});

test('the Stage 10H.1 reads require authentication', async () => {
  client.seed('jobs', 'job-1', job({ postedBy: 'victim' }));
  client.seed('employments', 'emp-1', employment({ jobId: 'job-1', employerId: 'victim', employeeId: 'victim' }));

  const byJob = await client.get('/employments/job/job-1');
  const byId = await client.get('/employments/emp-1');

  assert.equal(byJob.status, 401);
  assert.equal(byId.status, 401);
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

test('the employment status allow-list includes active/completed/ended/terminated and only active is written by hire', async () => {
  const employmentService = require('../services/employmentService');

  assert.deepEqual(employmentService.EMPLOYMENT_STATUSES.slice(0, 2), ['active', 'ended']);
  assert.ok(employmentService.EMPLOYMENT_STATUSES.includes('completed'));
  assert.ok(employmentService.EMPLOYMENT_STATUSES.includes('terminated'));
  assert.equal(employmentService.ACTIVE_EMPLOYMENT_STATUS, 'active');

  seedInterviewedApplication();
  await hire();

  assert.equal(employments()[0].status, employmentService.ACTIVE_EMPLOYMENT_STATUS);
});

// ---------------------------------------------------------------------------
// 8. STAGE 10H.2: a hire does not reject the applicants who came before it, and
//    an employed applicant cannot be rejected.
//
//    The employer UI used to restatus every applicant on a hire -- the chosen one
//    accepted and all the others rejected -- so hiring a second applicant marked
//    the first, already hired, as rejected. ViewJobApplications.jsx no longer does
//    that, but this is the server-side half: the rule holds for any caller, not
//    only for the client that currently obeys it.
// ---------------------------------------------------------------------------

const REJECTION_REFUSED =
  'Cannot reject an application whose employment is still active. '
  + 'An employed applicant cannot be marked as rejected.';

test('hiring a second applicant leaves the first applicant accepted and employed', async () => {
  // The multi-hire regression. Two applicants on one job, both cleared for hiring.
  // After both are hired, both are accepted and both employments are active: the
  // first hire is not undone by the second.
  seedInterviewedApplication();
  client.seed(
    'applications',
    'app-2',
    application({ jobId: 'job-1', employeeId: 'employee-2', status: 'interviewed' })
  );
  client.seed('contractProposals', 'prop-2', {
    applicationId: 'app-2',
    jobId: 'job-1',
    employerId: 'employer-1',
    employeeId: 'employee-2',
    paymentMode: 'full',
    currency: 'NGN',
    totalAmountMinor: 1000000,
    commissionBps: 500,
    commissionAmountMinor: 50000,
    milestones: [],
    status: 'accepted',
    acceptedAt: { _seconds: 1767225600, _nanoseconds: 0 },
    acceptedBy: 'employee-2',
  });

  const firstHire = await hire();
  assert.equal(firstHire.status, 200);
  assert.equal(employments().length, 1);

  // The write the old client made for every other applicant, then the real hire.
  const sweepReject = await hire('rejected');
  const secondHire = await hire('accepted', 'app-2');

  // The second applicant is hired...
  assert.equal(secondHire.status, 200);
  assert.equal(client.readDoc('applications', 'app-2').status, 'accepted');

  // ...while the sweep against the first is refused, and the first applicant is
  // exactly as it was.
  assert.equal(sweepReject.status, 400);
  assert.equal(sweepReject.body.message, REJECTION_REFUSED);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
  assert.deepEqual(
    employments().map((e) => e.applicationId).sort(),
    ['app-1', 'app-2']
  );
  assert.ok(employments().every((e) => e.status === 'active'));
});

test('an already-hired application cannot be rejected while its employment is active', async () => {
  seedInterviewedApplication();
  await hire();
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
  assert.equal(employments().length, 1);

  const res = await hire('rejected');

  assert.equal(res.status, 400);
  assert.equal(res.body.message, REJECTION_REFUSED);
  // The write has not run: application and employment are both untouched.
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');
  assert.equal(employments().length, 1);
  assert.equal(employments()[0].status, 'active');
});

test('an applicant who has not been hired can still be rejected', async () => {
  // The ordinary rejection: no employment exists, so the guard has nothing to
  // refuse and the write proceeds as it always has.
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1' }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'pending' })
  );

  const res = await hire('rejected');

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'rejected');
  assert.deepEqual(employments(), []);
});

test('an applicant whose employment has ended can be rejected', async () => {
  // The rule is scoped to an ACTIVE employment: `ended` does not hold the
  // application back. This follows requireTaskParty's reading, where a status the
  // code cannot recognise as active grants nothing, and it keeps the wording the
  // requirement states -- a rejection is refused only while the employment
  // "remains active". No code can write `ended` yet, so it is seeded directly.
  seedInterviewedApplication();
  client.seed(
    'employments',
    'emp-ended',
    employment({ applicationId: 'app-1', status: 'ended', endDate: '2026-10-06' })
  );

  const res = await hire('rejected');

  assert.equal(res.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'rejected');
});

test('hasActiveEmploymentForApplication is true only for an active employment', async () => {
  const employmentService = require('../services/employmentService');

  // No employment at all.
  assert.equal(await employmentService.hasActiveEmploymentForApplication('app-1'), false);

  // An employment that has ended.
  client.seed('employments', 'emp-ended', employment({ applicationId: 'app-1', status: 'ended' }));
  assert.equal(await employmentService.hasActiveEmploymentForApplication('app-1'), false);

  // An active one.
  client.seed('employments', 'emp-active', employment({ applicationId: 'app-1', status: 'active' }));
  assert.equal(await employmentService.hasActiveEmploymentForApplication('app-1'), true);

  // Scoped to the named application: another application's active employment is
  // not attributed to this one, and is found under its own id.
  client.seed('employments', 'emp-other', employment({ applicationId: 'app-2', status: 'active' }));
  assert.equal(await employmentService.hasActiveEmploymentForApplication('app-3'), false);
  assert.equal(await employmentService.hasActiveEmploymentForApplication('app-2'), true);
});
