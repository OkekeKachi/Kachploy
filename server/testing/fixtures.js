'use strict';

/** Shared data builders for characterization tests. */

function job(overrides = {}) {
  return {
    title: 'Fix the leaking tap',
    description: 'Kitchen tap drips constantly',
    location: 'Lagos, Nigeria',
    jobType: 'plumbing',
    applicationDeadline: '2026-10-01',
    jobStartDate: '2026-10-05',
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
 */
function task(overrides = {}) {
  return {
    jobId: 'job-1',
    employeeId: 'employee-1',
    taskName: 'Replace washer',
    taskDescription: 'Fit a new washer on the cold tap',
    dueDate: '2026-10-01T00:00:00.000Z',
    createdDate: { _seconds: 1767225600, _nanoseconds: 0 },
    ...overrides,
  };
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

module.exports = { job, user, application, task, employment, interview };
