'use strict';

/** Shared data builders for characterization tests. */

function job(overrides = {}) {
  return {
    title: 'Fix the leaking tap',
    description: 'Kitchen tap drips constantly',
    location: 'Lagos, Nigeria',
    jobType: 'plumbing',
    applicationDeadline: '2099-10-01',
    jobStartDate: '2099-10-05',
    expectedEndDate: '2026-10-06',
    price: 15000,
    negotiable: 'no',
    status: 'open',
    postedBy: 'employer-1',
    // STAGE 5E: no code writes or reads a job counter any more. This key is kept
    // deliberately so the fixtures model a real pre-Stage-5E document, and the
    // tests that use it prove the legacy fields are left untouched.
    proposal: 0,
    skillsRequired: ['plumbing'],
    requirements: ['own tools'],
    responsibilities: ['diagnose the leak'],
    createdAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

function user(overrides = {}) {
  return {
    uid: 'user-1',
    email: 'user@example.test',
    fullName: 'Test User',
    phone: '+2348012345678',
    role: 'employee',
    ...overrides,
  };
}

function application(overrides = {}) {
  return {
    jobId: 'job-1',
    employeeId: 'employee-1',
    fullName: 'Test User',
    message: 'I can do this',
    employeePrice: null,
    dateApplied: new Date('2026-09-02T10:00:00.000Z'),
    status: 'pending',
    // STAGE 5E: applyToJob no longer writes a `proposals` field. Present here to
    // model a pre-Stage-5E application document.
    proposals: 0,
    ...overrides,
  };
}

/**
 * A stored task document, modelling exactly what POST /tasks persists.
 *
 * STAGE 6B. `createdDate` is seeded as a Timestamp stand-in of the same shape the
 * fake produces for serverTimestamp(), because that is what the read endpoints
 * put on the wire.
 *
 * STAGE 9B. `status`/`applicationId`/`employmentId` are the fields both create
 * paths now write. The ids default to the job-1/employee-1/app-1/emp-1 set the rest
 * of the suite uses, so a seeded task and one made through the API describe the
 * same relationship. See legacyTask() for the shape that predates them.
 *
 * STAGE 10G. `submissionType` is the sixth field POST /tasks requires, and 'text' is
 * seeded because it is both the first name in the accept-list and what every task
 * that predates the field is read as -- so a seeded task and one created through the
 * API describe the same relationship here too. Tests that need a link or file task
 * pass `submissionType` as an override rather than editing this builder, the same way
 * they pass `status` to seed a submitted task.
 */
function task(overrides = {}) {
  return {
    jobId: 'job-1',
    employeeId: 'employee-1',
    taskName: 'Replace washer',
    taskDescription: 'Fit a new washer on the cold tap',
    dueDate: '2026-10-01T00:00:00.000Z',
    createdDate: { _seconds: 1767225600, _nanoseconds: 0 },
    status: 'assigned',
    applicationId: 'app-1',
    employmentId: 'emp-1',
    submissionType: 'text',
    ...overrides,
  };
}

/**
 * A task document as it was written before Stage 9B: no status, no application,
 * no employment.
 *
 * STAGE 9B. Kept so the read tests can prove a pre-9B task is still readable and
 * still reports itself as `assigned`, and that reading it changes nothing on disk.
 * It is a separate builder rather than `task({ status: undefined })` because that
 * would leave the key present with an undefined value, which is not what Firestore
 * stores for an absent field.
 *
 * STAGE 10G adds `submissionType` to the stripped set, so this is now the shape of a
 * task written before EITHER stage: no status, no application, no employment, no
 * submission type. That is the document the "reads as text" and "reads as assigned"
 * derivations exist for, and stripping it here means no test has to build that shape
 * by hand. The destructure keeps growing rather than adding a second builder, because
 * there is still only one kind of legacy task: the oldest kind this API supports.
 */
function legacyTask(overrides = {}) {
  const { status, applicationId, employmentId, submissionType, ...rest } = task(overrides);
  return rest;
}

/**
 * A stored employment document, modelling exactly what a successful hire writes.
 *
 * STAGE 7A. Seeding through the API is not possible for this resource -- there is
 * no create endpoint -- so the read tests seed this builder while the hire tests
 * assert against the document the hire itself produced. `startDate` is the ISO
 * string taken from the job's `jobStartDate`, which is what
 * employmentService.resolveStartDate stores when the job has one; the fallback to
 * a serverTimestamp() Timestamp is asserted separately in test/employments.test.js
 * and is deliberately not modelled here.
 */
function employment(overrides = {}) {
  return {
    employerId: 'employer-1',
    employeeId: 'employee-1',
    jobId: 'job-1',
    applicationId: 'app-1',
    startDate: '2026-10-05',
    endDate: null,
    status: 'active',
    ...overrides,
  };
}

/**
 * A stored interview document, modelling exactly what a successful create writes.
 *
 * STAGE 7C. Seeded directly rather than created through the API, because the read
 * tests need interviews on several applications at once and a create is
 * employer-scoped per application. `createdAt`/`updatedAt` are Timestamp stand-ins
 * of the same shape the fake produces for serverTimestamp(), which is what the read
 * endpoints put on the wire; an optional field that was never supplied is absent
 * here too, because createInterview does not write keys it was not given.
 */
function interview(overrides = {}) {
  return {
    applicationId: 'app-1',
    jobId: 'job-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    scheduledAt: '2026-10-02T10:00:00.000Z',
    type: 'online',
    status: 'scheduled',
    createdAt: { _seconds: 1767225600, _nanoseconds: 0 },
    updatedAt: { _seconds: 1767225600, _nanoseconds: 0 },
    ...overrides,
  };
}

/**
 * A stored conversation document (Stage 8B).
 *
 * Note the document id convention this resource uses: a conversation is stored under
 * the id of its application, not a Firestore-generated one, which is what makes
 * creation idempotent without a query. So in every seed below the id passed to
 * `client.seed('conversations', ...)` is the application id, and the `applicationId`
 * field inside the document repeats it.
 *
 * Seeded directly rather than created through the API in the read tests, for the
 * reason the employment fixture gives: seeding several conversations at once is
 * cheaper than creating them one at a time, and the create path has its own tests.
 * `createdAt`/`lastMessageAt` are Timestamp stand-ins of the same shape the fake
 * produces for serverTimestamp(), which is what the read endpoints put on the wire.
 */
function conversation(overrides = {}) {
  return {
    applicationId: 'app-1',
    jobId: 'job-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    createdAt: { _seconds: 1767225600, _nanoseconds: 0 },
    lastMessageAt: { _seconds: 1767225600, _nanoseconds: 0 },
    ...overrides,
  };
}

/**
 * A stored message document (Stage 8B).
 *
 * Messages are a TOP-LEVEL collection carrying a `conversationId` field, not a
 * subcollection -- see the note at the top of repositories/conversationRepository.js
 * for why. So every message seed names its conversation by field, and the tests seed
 * the conversation document separately.
 *
 * `createdAt` is a Timestamp stand-in rather than an ISO string, and each message in
 * a multi-message test is given a DIFFERENT one. conversationService.listMessages
 * sorts on this value in JavaScript (the fake Firestore throws on `orderBy()`), so a
 * test that seeded identical timestamps could not tell a correct sort from a
 * no-op one.
 */
function message(overrides = {}) {
  return {
    conversationId: 'app-1',
    senderId: 'employee-1',
    body: 'I can do this',
    createdAt: { _seconds: 1767225600, _nanoseconds: 0 },
    ...overrides,
  };
}

/**
 * A stored contract document (Stage P1), modelling what POST /contracts writes.
 *
 * Note the document id convention this resource uses: a contract is stored under
 * the id of its EMPLOYMENT, not a Firestore-generated one, which is what makes
 * "at most one contract per employment" a property of the key space rather than
 * of a query-then-write race. So in every seed below the id passed to
 * `client.seed('contracts', ...)` is the employment id, and the `employmentId`
 * field inside the document repeats it.
 *
 * Seeded directly rather than created through the API in the read and accept
 * tests, for the reason the employment fixture gives: a test that needs a
 * contract in a particular status should not have to perform two HTTP calls
 * (create, then accept) to get there, and the create path has its own tests.
 * `createdAt`/`acceptedAt` are Timestamp stand-ins of the same shape the fake
 * produces for serverTimestamp(), which is what the read endpoints put on the
 * wire. `acceptedAt`/`acceptedBy` are absent from the default builder -- a
 * pending contract has no acceptance -- exactly as a freshly created document.
 *
 * Amounts are in kobo (the NGN minor unit): 1500000 is NGN 15,000.00, the
 * major-unit 15000 the job fixture carries. The 5% commission of that total
 * is 75000 kobo (NGN 750.00).
 */
function contract(overrides = {}) {
  return {
    employmentId: 'emp-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    jobId: 'job-1',
    applicationId: 'app-1',
    currency: 'NGN',
    paymentMode: 'full',
    totalAmountMinor: 1500000,
    commissionBps: 500,
    commissionAmountMinor: 75000,
    status: 'pending_acceptance',
    createdAt: { _seconds: 1767225600, _nanoseconds: 0 },
    ...overrides,
  };
}

/**
 * A stored milestone document (Stage P1).
 *
 * Milestones are a TOP-LEVEL collection carrying `contractId` as a field, not a
 * subcollection -- the fake Firestore has no subcollection support and every
 * other many-to-one relationship in this codebase is modelled the same way. So
 * every milestone seed names its contract by field, and the tests seed the
 * contract document separately. `contractId` repeats the employment id, because
 * the contract's own document id IS the employment id.
 *
 * `status` is seeded as 'pending_acceptance', the only milestone status P1
 * writes; nothing in this stage transitions it.
 */
function milestone(overrides = {}) {
  return {
    contractId: 'emp-1',
    employmentId: 'emp-1',
    taskId: 'task-1',
    label: 'Replace washer',
    amountMinor: 500000,
    status: 'pending_acceptance',
    createdAt: { _seconds: 1767225600, _nanoseconds: 0 },
    ...overrides,
  };
}

/**
 * A stored payment record (Stage P2).
 *
 * Note the document id convention this resource uses: a payment is stored under
 * the id of its MILESTONE, not a Firestore-generated one, which is what makes
 * "at most one payment record per milestone" a property of the key space rather
 * than of a query-then-write race. So in every seed below the id passed to
 * `client.seed('payments', ...)` is the milestone id, and the `milestoneId`
 * field inside the document repeats it.
 *
 * Seeded directly rather than created through the API in the read tests, for
 * the reason the employment fixture gives: a test that needs a record in place
 * to READ should not have to perform two HTTP calls (create a contract, then
 * initiate) to get there, and the create path has its own tests. `createdAt`
 * is a Timestamp stand-in of the same shape the fake produces for
 * serverTimestamp(), which is what the read endpoint puts on the wire.
 *
 * 'created' is the only status Stage P2 writes: it means Kachploy stored the
 * employer's payment REQUEST, and nothing more -- no provider was contacted,
 * no employer was charged, no employee was paid. Amounts are in kobo: the
 * default 500000 is the milestone fixture's amount, and its 5% commission is
 * 25000 kobo.
 */
function payment(overrides = {}) {
  return {
    milestoneId: 'ms-1',
    contractId: 'emp-1',
    employmentId: 'emp-1',
    taskId: 'task-1',
    employerId: 'employer-1',
    employeeId: 'employee-1',
    amountMinor: 500000,
    currency: 'NGN',
    commissionBps: 500,
    commissionAmountMinor: 25000,
    status: 'created',
    idempotencyKey: 'client-key-1',
    initiatedBy: 'employer-1',
    createdAt: { _seconds: 1767225600, _nanoseconds: 0 },
    ...overrides,
  };
}

module.exports = { job, user, application, task, legacyTask, employment, interview, conversation, message, contract, milestone, payment };
