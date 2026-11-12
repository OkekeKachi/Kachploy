'use strict';

/**
 * Stage 8B tests for the chat resource.
 *
 * A conversation is the message thread between the employer who posted a job and the
 * applicant who applied to it. It is stored under the id of its application, both
 * participants may read and write it, and it is deliberately unaffected by what
 * happens to the application afterwards.
 *
 * The suite covers what Stage 8B has to get right:
 *   1. creation: the stored document, the server-owned fields, the deterministic id,
 *      and that both participant uids come from the application and the job rather
 *      than from the body
 *   2. idempotency: that opening a conversation twice yields one conversation
 *   3. creation authorization: either party may open it, and no one else may
 *   4. the inbox: that a caller sees their own conversations and nobody else's
 *   5. messaging: that identity comes from the token, and the body's validation
 *   6. message authorization: both parties may post and read, no one else
 *   7. ordering: that a thread comes back oldest-first
 *   8. continuity: that a thread opened during recruitment survives the hire, and
 *      that neither chatting nor hiring disturbs the other's collections
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { job, application, conversation, message } = require('../testing/fixtures');

let client;
let employerApi;
let employeeApi;
const now = () => '2026-01-01T00:00:00.000Z';

/** The timestamp shape the fake produces for the injected clock. */
const STAMP = { _seconds: 1767225600, _nanoseconds: 0 };

/**
 * The service's message length cap, read LAZILY from inside the tests.
 *
 * Deliberately not a top-level require. server/testing/testApp.js substitutes
 * config/firebase.js in the require cache when startTestServer() runs, which happens
 * in test.before(); a top-level `require('../services/conversationService')` would
 * execute FIRST, pull in the real config/firebase.js, and bind the service to
 * production Firestore -- so the suite would query the live database for documents
 * the fake seeded, and get 404s for reasons that have nothing to do with the code
 * under test. It also defeats the harness's own guard, which exists to make it
 * impossible for a test to touch production data.
 *
 * By the time a test body runs, startTestServer has already required app.js, which
 * required this service with the fake in place, so the lazy require returns that
 * same cached module. This is the arrangement test/employments.test.js uses for
 * employmentService.
 */
const maxMessageLength = () =>
  require('../services/conversationService').MESSAGE_MAX_LENGTH;

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

/** Every conversation document currently stored, as an array. */
const conversations = () => Object.values(client.readAll('conversations'));

/** Every message document currently stored, as an array. */
const messages = () => Object.values(client.readAll('messages'));

/** Seeds employer-1's job and employee-1's application to it. */
function seedJobWithApplication(jobOverrides = {}, applicationOverrides = {}) {
  client.seed('jobs', 'job-1', job({ postedBy: 'employer-1', ...jobOverrides }));
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-1', employeeId: 'employee-1', status: 'pending', ...applicationOverrides })
  );
}

/**
 * Seeds the job, the application, AND an already-open conversation for it.
 *
 * A conversation's document id IS its application id, so the id passed to seed is
 * always 'app-1' -- that is the convention, not a coincidence.
 */
function seedConversation(jobOverrides = {}, applicationOverrides = {}) {
  seedJobWithApplication(jobOverrides, applicationOverrides);
  client.seed('conversations', 'app-1', conversation());
}

/** The create call under test. Defaults to the minimal valid body. */
const create = (body = { applicationId: 'app-1' }, api = employerApi) =>
  api.post('/conversations', { body });

/** The send call under test. Defaults to the minimal valid body. */
const send = (body = { body: 'Hello' }, api = employeeApi, conversationId = 'app-1') =>
  api.post(`/conversations/${conversationId}/messages`, { body });

// ---------------------------------------------------------------------------
// 1. Creation.
// ---------------------------------------------------------------------------

test('an employer can open a conversation for an applicant to their job', async () => {
  seedJobWithApplication();

  const res = await create();

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Conversation created successfully');
  assert.equal(res.body.created, true);

  assert.equal(conversations().length, 1);
  const [record] = conversations();
  assert.equal(record.applicationId, 'app-1');
  assert.equal(record.jobId, 'job-1');
  assert.equal(record.employerId, 'employer-1');
  assert.equal(record.employeeId, 'employee-1');
});

test('an applicant can open the conversation for their own application', async () => {
  seedJobWithApplication();

  const res = await create({ applicationId: 'app-1' }, employeeApi);

  assert.equal(res.status, 200);
  assert.equal(res.body.created, true);
  assert.equal(conversations().length, 1);
});

test('a conversation is stored under its application id as the document id', async () => {
  seedJobWithApplication();

  const res = await create();

  // The deterministic id is the whole idempotency mechanism, so the id the API
  // reports and the id the document is actually filed under must be the same thing.
  assert.equal(res.body.conversationId, 'app-1');
  assert.deepEqual(Object.keys(client.readAll('conversations')), ['app-1']);
});

test('both participant uids are copied from the application and the job, not the body', async () => {
  seedJobWithApplication();

  // A caller naming different participants in the body must not be able to move the
  // conversation onto themselves: these two fields are the authorization anchor for
  // every later read and write.
  await create({
    applicationId: 'app-1',
    employerId: 'attacker-9',
    employeeId: 'attacker-9',
  });

  const [record] = conversations();
  assert.equal(record.employerId, 'employer-1');
  assert.equal(record.employeeId, 'employee-1');
});

test('a new conversation is stamped with server timestamps', async () => {
  seedJobWithApplication();

  await create();

  const [record] = conversations();
  assert.deepEqual(record.createdAt, STAMP);
  assert.deepEqual(record.lastMessageAt, STAMP);
});

test('opening a conversation requires an applicationId', async () => {
  seedJobWithApplication();

  const res = await create({});

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Missing required fields');
  assert.equal(conversations().length, 0);
});

test('opening a conversation for an application that does not exist is a 404', async () => {
  seedJobWithApplication();

  const res = await create({ applicationId: 'app-missing' });

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Application not found');
  assert.equal(conversations().length, 0);
});

test('opening a conversation for an application whose job is gone is a 404', async () => {
  // The application outlives its job document here, which is the only way to reach
  // the second existence check.
  client.seed(
    'applications',
    'app-1',
    application({ jobId: 'job-missing', employeeId: 'employee-1', status: 'pending' })
  );

  const res = await create();

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
  assert.equal(conversations().length, 0);
});

// ---------------------------------------------------------------------------
// 2. Idempotency.
// ---------------------------------------------------------------------------

test('opening a conversation twice returns the same conversation', async () => {
  seedJobWithApplication();

  const first = await create();
  const second = await create();

  assert.equal(second.status, 200);
  assert.equal(second.body.conversationId, first.body.conversationId);
  assert.equal(conversations().length, 1);
});

test('a second open reports that it did not create the conversation', async () => {
  seedJobWithApplication();

  await create();
  const second = await create();

  assert.equal(second.body.created, false);
  assert.equal(second.body.message, 'Conversation already exists');
});

test('a second open does not disturb an established thread', async () => {
  seedJobWithApplication();
  await create();
  await send({ body: 'First' });

  const before = client.readDoc('conversations', 'app-1');
  await create();
  const after = client.readDoc('conversations', 'app-1');

  // The idempotent path must not rewrite the document, or re-opening a thread would
  // silently reset its ordering and its creation time.
  assert.deepEqual(after, before);
  assert.equal(messages().length, 1);
});

test('either party opening the same application gets one shared conversation', async () => {
  seedJobWithApplication();

  await create({ applicationId: 'app-1' }, employerApi);
  const res = await create({ applicationId: 'app-1' }, employeeApi);

  assert.equal(res.body.created, false);
  assert.equal(conversations().length, 1);
});

// ---------------------------------------------------------------------------
// 3. Creation authorization.
// ---------------------------------------------------------------------------

test('an unrelated user cannot open a conversation for an application', async () => {
  seedJobWithApplication();
  const strangerApi = await client.authed('stranger-1');

  const res = await create({ applicationId: 'app-1' }, strangerApi);

  assert.equal(res.status, 403);
  assert.equal(conversations().length, 0);
});

test('an employer cannot open a conversation on another employer job', async () => {
  // employee-1 applies to employer-2's job. employer-1 owns nothing here.
  client.seed('jobs', 'job-2', job({ postedBy: 'employer-2' }));
  client.seed(
    'applications',
    'app-2',
    application({ jobId: 'job-2', employeeId: 'employee-1', status: 'pending' })
  );

  const res = await create({ applicationId: 'app-2' }, employerApi);

  assert.equal(res.status, 403);
  assert.equal(conversations().length, 0);
});

test('a refusal to open a conversation carries no data about it', async () => {
  seedJobWithApplication();
  const strangerApi = await client.authed('stranger-1');

  const res = await create({ applicationId: 'app-1' }, strangerApi);

  assert.equal(res.status, 403);
  // Nothing that would tell a stranger who the parties are or that the application
  // exists at all.
  assert.deepEqual(Object.keys(res.body), ['message']);
  assert.ok(!JSON.stringify(res.body).includes('employee-1'));
});

// ---------------------------------------------------------------------------
// 4. The inbox.
// ---------------------------------------------------------------------------

test('an employer inbox lists the conversations they are party to', async () => {
  seedConversation();

  const res = await employerApi.get('/conversations');

  assert.equal(res.status, 200);
  assert.equal(res.body.conversations.length, 1);
  assert.equal(res.body.conversations[0].applicationId, 'app-1');
});

test('an applicant inbox lists the same conversation', async () => {
  seedConversation();

  const res = await employeeApi.get('/conversations');

  assert.equal(res.status, 200);
  assert.equal(res.body.conversations.length, 1);
});

test('an inbox excludes conversations the caller has nothing to do with', async () => {
  seedConversation();
  const strangerApi = await client.authed('stranger-1');

  const res = await strangerApi.get('/conversations');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.conversations, []);
});

test('an inbox never returns the same conversation twice', async () => {
  seedConversation();

  const res = await employerApi.get('/conversations');

  const ids = res.body.conversations.map((c) => c.id);
  assert.deepEqual(ids, ['app-1']);
});

test('an empty inbox is an empty list rather than a 404', async () => {
  const res = await employerApi.get('/conversations');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.conversations, []);
});

// ---------------------------------------------------------------------------
// 5. Messaging.
// ---------------------------------------------------------------------------

test('a participant can post a message', async () => {
  seedConversation();

  const res = await send({ body: 'Is the tap still dripping?' });

  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Message sent successfully');
  assert.ok(res.body.messageId);

  assert.equal(messages().length, 1);
  const [record] = messages();
  assert.equal(record.conversationId, 'app-1');
  assert.equal(record.senderId, 'employee-1');
  assert.equal(record.body, 'Is the tap still dripping?');
});

test('both parties can post in the same thread', async () => {
  seedConversation();

  await send({ body: 'From the applicant' }, employeeApi);
  await send({ body: 'From the employer' }, employerApi);

  assert.equal(messages().length, 2);
  assert.deepEqual(
    messages().map((m) => m.senderId).sort(),
    ['employee-1', 'employer-1']
  );
});

test('a message records the sender from the token, ignoring a senderId in the body', async () => {
  seedConversation();

  // The impersonation case: a participant must not be able to post as the other one.
  await send({ body: 'Trust me, this is the employer speaking', senderId: 'employer-1' }, employeeApi);

  assert.equal(messages()[0].senderId, 'employee-1');
});

test('a message is stamped with a server timestamp', async () => {
  seedConversation();

  await send();

  assert.deepEqual(messages()[0].createdAt, STAMP);
});

test('a message body is stored trimmed', async () => {
  seedConversation();

  await send({ body: '   spaced out   ' });

  assert.equal(messages()[0].body, 'spaced out');
});

test('posting a message stamps the conversation lastMessageAt', async () => {
  seedConversation();

  await send();

  assert.deepEqual(client.readDoc('conversations', 'app-1').lastMessageAt, STAMP);
});

test('a message body is required', async () => {
  seedConversation();

  const res = await send({});

  assert.equal(res.status, 400);
  assert.equal(res.body.message, 'Missing required fields');
  assert.equal(messages().length, 0);
});

test('a whitespace-only message body is refused', async () => {
  seedConversation();

  const res = await send({ body: '   ' });

  assert.equal(res.status, 400);
  assert.equal(messages().length, 0);
});

test('a non-string message body is refused rather than coerced', async () => {
  seedConversation();

  // JSON is untrusted input; String(42) would store "42" and String({}) would store
  // "[object Object]" as though a person had typed it.
  for (const body of [42, true, { text: 'hi' }, ['hi'], null]) {
    const res = await send({ body });

    assert.equal(res.status, 400, `expected 400 for body ${JSON.stringify(body)}`);
  }
  assert.equal(messages().length, 0);
});

test('a message body over the length cap is refused', async () => {
  seedConversation();

  const res = await send({ body: 'x'.repeat((maxMessageLength() + 1)) });

  assert.equal(res.status, 400);
  assert.ok(res.body.message.includes(String(maxMessageLength())));
  assert.equal(messages().length, 0);
});

test('a message body exactly at the length cap is accepted', async () => {
  seedConversation();

  const res = await send({ body: 'x'.repeat(maxMessageLength()) });

  assert.equal(res.status, 200);
  assert.equal(messages().length, 1);
});

test('the length cap is measured before trimming, so padding cannot smuggle a longer body', async () => {
  seedConversation();

  const res = await send({ body: `${'x'.repeat(maxMessageLength())}   ` });

  assert.equal(res.status, 400);
  assert.equal(messages().length, 0);
});

test('posting to a conversation that does not exist is a 404', async () => {
  seedConversation();

  const res = await send({ body: 'Hello' }, employeeApi, 'app-missing');

  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Conversation not found');
  assert.equal(messages().length, 0);
});

// ---------------------------------------------------------------------------
// 6. Message authorization.
// ---------------------------------------------------------------------------

test('an unrelated user cannot read a conversation', async () => {
  seedConversation();
  const strangerApi = await client.authed('stranger-1');

  const res = await strangerApi.get('/conversations/app-1/messages');

  assert.equal(res.status, 403);
  assert.deepEqual(res.body.messages, undefined);
});

test('an unrelated user cannot post into a conversation', async () => {
  seedConversation();
  const strangerApi = await client.authed('stranger-1');

  const res = await strangerApi.post('/conversations/app-1/messages', { body: { body: 'Hello' } });

  assert.equal(res.status, 403);
  assert.equal(messages().length, 0);
});

test('an employer cannot read another employer conversation', async () => {
  client.seed('conversations', 'app-2', conversation({
    applicationId: 'app-2',
    employerId: 'employer-2',
    employeeId: 'employee-1',
  }));
  client.seed('messages', 'm-1', message({ conversationId: 'app-2' }));

  const res = await employerApi.get('/conversations/app-2/messages');

  assert.equal(res.status, 403);
  // Not merely refused: the refusal must not disclose that the thread exists or that
  // it has a message in it.
  assert.ok(!JSON.stringify(res.body).includes('Hello'));
});

test('a refusal to read a conversation carries no message data', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ body: 'a private remark' }));
  const strangerApi = await client.authed('stranger-1');

  const res = await strangerApi.get('/conversations/app-1/messages');

  assert.deepEqual(Object.keys(res.body), ['message']);
  assert.ok(!JSON.stringify(res.body).includes('a private remark'));
});

// ---------------------------------------------------------------------------
// 7. Ordering and isolation.
// ---------------------------------------------------------------------------

test('messages come back oldest first', async () => {
  seedConversation();
  // Seeded newest-first on purpose, so a correct sort has to reorder them and a
  // missing sort would be visible.
  client.seed('messages', 'm-late', message({ body: 'third', createdAt: { _seconds: 300, _nanoseconds: 0 } }));
  client.seed('messages', 'm-early', message({ body: 'first', createdAt: { _seconds: 100, _nanoseconds: 0 } }));
  client.seed('messages', 'm-mid', message({ body: 'second', createdAt: { _seconds: 200, _nanoseconds: 0 } }));

  const res = await employeeApi.get('/conversations/app-1/messages');

  assert.deepEqual(
    res.body.messages.map((m) => m.body),
    ['first', 'second', 'third']
  );
});

test('messages with equal timestamps keep the order they were sent in', async () => {
  seedConversation();
  // The sort has to be stable for two messages written in the same instant, which is
  // what the injected test clock produces for everything.
  client.seed('messages', 'm-1', message({ body: 'one' }));
  client.seed('messages', 'm-2', message({ body: 'two' }));
  client.seed('messages', 'm-3', message({ body: 'three' }));

  const res = await employeeApi.get('/conversations/app-1/messages');

  assert.deepEqual(
    res.body.messages.map((m) => m.body),
    ['one', 'two', 'three']
  );
});

test('a conversation lists only its own messages', async () => {
  seedConversation();
  client.seed('conversations', 'app-2', conversation({
    applicationId: 'app-2',
    employerId: 'employer-1',
    employeeId: 'employee-2',
  }));
  client.seed('messages', 'm-1', message({ conversationId: 'app-1', body: 'mine' }));
  client.seed('messages', 'm-2', message({ conversationId: 'app-2', body: 'theirs' }));

  const res = await employerApi.get('/conversations/app-1/messages');

  assert.deepEqual(
    res.body.messages.map((m) => m.body),
    ['mine']
  );
});

test('a conversation nobody has written in yet lists no messages', async () => {
  seedConversation();

  const res = await employeeApi.get('/conversations/app-1/messages');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.messages, []);
});

// ---------------------------------------------------------------------------
// 8. Continuity across the hire, and collection isolation.
// ---------------------------------------------------------------------------

test('a thread opened during recruitment is still readable after the applicant is hired', async () => {
  seedConversation();
  await send({ body: 'Are you available Saturday?' }, employeeApi);

  // The Stage 7G gate: interviewed, then accepted. The hire writes the employment.
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
  const cleared = await employerApi.put('/applications/app-1/status', { body: { status: 'interviewed' } });
  assert.equal(cleared.status, 200);
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
  const hired = await employerApi.put('/applications/app-1/status', { body: { status: 'accepted' } });
  assert.equal(hired.status, 200);
  assert.equal(client.readDoc('applications', 'app-1').status, 'accepted');

  // Same thread, same id, same history, readable by both -- and now by an employer
  // and an EMPLOYEE rather than an employer and an applicant.
  const asEmployee = await employeeApi.get('/conversations/app-1/messages');
  assert.equal(asEmployee.status, 200);
  assert.deepEqual(
    asEmployee.body.messages.map((m) => m.body),
    ['Are you available Saturday?']
  );

  const asEmployer = await employerApi.get('/conversations/app-1/messages');
  assert.deepEqual(
    asEmployer.body.messages.map((m) => m.body),
    ['Are you available Saturday?']
  );
});

test('the hire creates exactly one employment and does not touch conversations or messages', async () => {
  seedConversation();
  await send();

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
  await employerApi.put('/applications/app-1/status', { body: { status: 'interviewed' } });
  await employerApi.put('/applications/app-1/status', { body: { status: 'accepted' } });

  assert.equal(Object.keys(client.readAll('employments')).length, 1);
  assert.equal(conversations().length, 1);
  assert.equal(messages().length, 1);
});

test('sending a message does not change the application status', async () => {
  seedConversation();

  await send();

  // Chat is not a stage of recruitment: a message must not move pending to
  // interviewed, or make an application reviewable.
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
});

test('sending a message creates no employment and no interview', async () => {
  seedConversation();

  await send();

  assert.deepEqual(client.readAll('employments'), {});
  assert.deepEqual(client.readAll('interviews'), {});
});

test('a conversation survives the withdrawal of its application', async () => {
  // Withdrawing deletes the application document. The thread is retained, and stays
  // readable by exactly the two people who were in it.
  seedConversation();
  await send({ body: 'Still there?' });

  const withdrawn = await employeeApi.delete('/applications/app-1');
  assert.equal(withdrawn.status, 200);
  assert.equal(client.readDoc('applications', 'app-1'), undefined);

  const res = await employeeApi.get('/conversations/app-1/messages');
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.messages.map((m) => m.body),
    ['Still there?']
  );

  const strangerApi = await client.authed('stranger-1');
  const refused = await strangerApi.get('/conversations/app-1/messages');
  assert.equal(refused.status, 403);
});

// ---------------------------------------------------------------------------
// 9. STAGE 8E. Access across the application lifecycle.
//
// The matrix this section pins down, one status at a time, for all four entry
// points -- POST /conversations (the get-or-create), GET and POST on the thread,
// and the inbox:
//
//   pending     -- application present. Both parties, full access.
//   interviewed -- application present, status only. Same.
//   accepted    -- application present AND an employment now exists (the Stage 7G
//                  hire). Access must be identical: the thread is anchored on the
//                  APPLICATION, not the employment, so hiring must not move it.
//   rejected    -- application PRESENT, status only. Access RETAINED. This is the
//                  existing policy, recorded by Stage 8B's retention note and
//                  deliberately NOT changed here.
//   withdrawn   -- application DELETED. The thread is retained and stays usable by
//                  its two participants. This is the one status where the
//                  authorization path is asymmetric, and the tests below are what
//                  pin the fix.
//
// The distinction that matters throughout: `rejected` is a status change and
// `withdrawn` is a document deletion. Every guard that resolves participants
// through application -> job therefore survives the first and not the second,
// while the guards that read the conversation's own stored uids are unaffected by
// both. That difference is the whole subject of this section.
// ---------------------------------------------------------------------------

/** Drives an application to `status` through the real route, not by seeding. */
const moveTo = async (status, api = employerApi) =>
  api.put('/applications/app-1/status', { body: { status } });

/**
 * Asserts that both parties retain full access to the thread at the current status.
 *
 * One helper rather than four assertions repeated per status, so that "what does
 * full access mean" is stated exactly once: the get-or-create succeeds and reports
 * that nothing was created, both parties read the existing history, both parties can
 * append to it, and the appended message is attributed to the token's uid.
 */
async function assertBothPartiesHaveFullAccess(expectCreated) {
  const created = await create();
  assert.equal(created.status, 200);
  assert.equal(created.body.created, expectCreated);
  assert.equal(created.body.conversationId, 'app-1');

  const asEmployer = await employerApi.get('/conversations/app-1/messages');
  assert.equal(asEmployer.status, 200);

  const asEmployee = await employeeApi.get('/conversations/app-1/messages');
  assert.equal(asEmployee.status, 200);
  assert.deepEqual(
    asEmployee.body.messages.map((m) => m.body),
    asEmployer.body.messages.map((m) => m.body),
    'both parties must read the same thread'
  );

  const employerSend = await send({ body: 'From the employer' }, employerApi);
  assert.equal(employerSend.status, 200);

  const employeeSend = await send({ body: 'From the applicant' }, employeeApi);
  assert.equal(employeeSend.status, 200);

  // Identity comes from the token, so the two appended messages must not be
  // attributable to each other's author.
  const after = await employerApi.get('/conversations/app-1/messages');
  const authors = Object.fromEntries(
    after.body.messages.map((m) => [m.body, m.senderId])
  );
  assert.equal(authors['From the employer'], 'employer-1');
  assert.equal(authors['From the applicant'], 'employee-1');
}

test('pending: both parties have full access', async () => {
  seedConversation();
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');
  await assertBothPartiesHaveFullAccess(false);
});

test('interviewed: a status change alone does not disturb access', async () => {
  seedConversation();
  assert.equal((await moveTo('interviewed')).status, 200);
  await assertBothPartiesHaveFullAccess(false);
});

test('accepted: hiring does not break access to the existing conversation', async () => {
  seedConversation();
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

  // The real Stage 7G path, so the employment genuinely exists rather than being
  // asserted about: interviewed, then accepted, which is what writes the employment.
  assert.equal((await moveTo('interviewed')).status, 200);
  assert.equal((await moveTo('accepted')).status, 200);
  assert.equal(Object.keys(client.readAll('employments')).length, 1);

  // Same document id, same history, same two parties -- the employer and now an
  // employee rather than an applicant.
  await assertBothPartiesHaveFullAccess(false);
  assert.equal(conversations().length, 1, 'the hire must not fork a second thread');
});

test('rejected: both parties RETAIN access, which is the existing policy', async () => {
  seedConversation();
  assert.equal((await moveTo('rejected')).status, 200);

  // Asserted, not changed. Stage 8B recorded this as a product question it declined
  // to answer, and Stage 8E is explicitly not the stage that answers it: the
  // application document still exists, so nothing in the authorization path has
  // changed and there is no defect to fix here.
  await assertBothPartiesHaveFullAccess(false);
});

test('withdrawn: both parties keep full access to a conversation that already exists', async () => {
  seedConversation();
  await send({ body: 'Before the withdrawal' });

  // Withdrawing DELETES the application document.
  assert.equal((await employeeApi.delete('/applications/app-1')).status, 200);
  assert.equal(client.readDoc('applications', 'app-1'), undefined);

  // The regression this section exists for. The get-or-create is documented as
  // idempotent and conversationService.createOrGetConversation checks for an
  // existing conversation BEFORE it looks the application up, so this call has
  // everything it needs to answer 200 with `created: false`. But the route's guard
  // resolves participants through application -> job and 404s on the missing
  // application before the service is ever reached.
  //
  // Before the fix this asserts 404 'Application not found'.
  const reopened = await create();
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.created, false, 'an existing thread must not be recreated');
  assert.equal(reopened.body.message, 'Conversation already exists');
  assert.equal(reopened.body.conversationId, 'app-1');
  assert.equal(reopened.body.conversation.employeeId, 'employee-1');

  // And the thread itself is fully usable, in both directions.
  await assertBothPartiesHaveFullAccess(false);

  const history = await employeeApi.get('/conversations/app-1/messages');
  assert.equal(history.body.messages[0].body, 'Before the withdrawal');
  assert.equal(conversations().length, 1, 'the withdrawal must not fork a second thread');
});

test('withdrawn: the fallback authorises only the two recorded participants', async () => {
  seedConversation();
  assert.equal((await employeeApi.delete('/applications/app-1')).status, 200);

  // The point of the fallback above. Authorizing from the conversation's stored uids
  // must be exactly as narrow as the application -> job chain it replaces, and must
  // not become a way to open a thread by guessing an application id.
  const strangerApi = await client.authed('stranger-1');

  const strangerReopen = await create({ applicationId: 'app-1' }, strangerApi);
  assert.equal(strangerReopen.status, 403);
  assert.equal(strangerReopen.body.message,
    'You do not have permission to access conversations for this application');

  const strangerRead = await strangerApi.get('/conversations/app-1/messages');
  assert.equal(strangerRead.status, 403);

  const strangerSend = await send({ body: 'Should not land' }, strangerApi);
  assert.equal(strangerSend.status, 403);

  // ...and the refusal must not have leaked the participant uids.
  assert.equal(JSON.stringify(strangerReopen.body).includes('employee-1'), false);

  // Both real parties still get in, so the fallback is a fallback and not a lockout.
  assert.equal((await create()).status, 200);
  assert.equal((await create(undefined, employeeApi)).status, 200);
});

test('withdrawn: a missing application with no conversation is still a 404', async () => {
  // The guard must not have been loosened into "no application means no check".
  seedJobWithApplication();
  assert.equal((await employeeApi.delete('/applications/app-1')).status, 200);

  // Never opened a conversation, so there is nothing to authorize against and
  // nothing to return.
  const res = await create();
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Application not found');
  assert.equal(conversations().length, 0);
});

test('withdrawn: an application id that never existed is still a 404', async () => {
  seedJobWithApplication();

  const res = await create({ applicationId: 'app-does-not-exist' });
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Application not found');
});

test('the inbox still lists a retained thread after withdrawal', async () => {
  seedConversation();
  await send({ body: 'Still here?' });
  assert.equal((await employeeApi.delete('/applications/app-1')).status, 200);

  const asEmployer = await employerApi.get('/conversations');
  assert.equal(asEmployer.status, 200);
  assert.deepEqual(asEmployer.body.conversations.map((c) => c.id), ['app-1']);

  const asEmployee = await employeeApi.get('/conversations');
  assert.deepEqual(asEmployee.body.conversations.map((c) => c.id), ['app-1']);

  const strangerApi = await client.authed('stranger-1');
  assert.deepEqual((await strangerApi.get('/conversations')).body.conversations, []);
});

test('a deleted job does not break the get-or-create for an existing thread', async () => {
  // The other end of the same chain. `deleteJob` removes the document outright, so an
  // employer can delete a job that already has a conversation on it. Probed in Stage
  // 8E: before the fix this returned 404 'Job not found' while the thread itself still
  // read and posted fine, which is the same defect withdrawal produced.
  seedConversation();
  await send({ body: 'Before the job was deleted' });
  assert.equal((await create()).status, 200);

  assert.equal((await employerApi.delete('/jobs/job-1')).status, 200);
  assert.equal(client.readDoc('jobs', 'job-1'), undefined);
  assert.equal(client.readDoc('applications', 'app-1').status, 'pending');

  const reopened = await create();
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.created, false);
  assert.equal(reopened.body.conversationId, 'app-1');

  await assertBothPartiesHaveFullAccess(false);
});

test('a deleted job with no conversation is still a 404 naming the job', async () => {
  seedJobWithApplication();
  assert.equal((await employerApi.delete('/jobs/job-1')).status, 200);

  // Never opened, so there is nothing to fall back to and the original wording stands.
  const res = await create();
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Job not found');
  assert.equal(conversations().length, 0);
});

test('a deleted job does not let a stranger onto the existing thread', async () => {
  seedConversation();
  assert.equal((await employerApi.delete('/jobs/job-1')).status, 200);

  const strangerApi = await client.authed('stranger-1');
  const res = await create({ applicationId: 'app-1' }, strangerApi);
  assert.equal(res.status, 403);
  assert.equal(res.body.message,
    'You do not have permission to access conversations for this application');

  // The real parties are unaffected -- a fallback, not a lockout.
  assert.equal((await create()).status, 200);
  assert.equal((await create(undefined, employeeApi)).status, 200);
});

// ---------------------------------------------------------------------------
// 10. STAGE 10B. Read state, unread counts, and the single-conversation read.
// ---------------------------------------------------------------------------

/**
 * A stored timestamp `offsetSeconds` from the instant the injected clock returns.
 *
 * The whole suite runs on ONE fixed clock, so "before the marker" and "after the
 * marker" cannot be produced by waiting. Instead every message in this section is
 * SEEDED at an explicit offset from that instant, and the marker written by
 * PUT /:conversationId/read lands exactly ON it (it is a serverTimestamp()).
 *
 * So `at(-60)` is a message the reader had already seen when they marked the thread
 * read, and `at(60)` is one that arrived afterwards. That is the only distinction the
 * unread rule turns on, and it is why these tests seed rather than POST: a message sent
 * through the API in this suite is stamped with the fixed clock, which is the same
 * instant as the marker, and `createdAt > marker` would then be false for it -- a true
 * answer for the fixed clock, but one that could not tell a working rule from a
 * coincidence.
 */
const at = (offsetSeconds) => ({ _seconds: 1767225600 + offsetSeconds, _nanoseconds: 0 });

/** The conversation document, as stored. */
const stored = (conversationId = 'app-1') => client.readDoc('conversations', conversationId);

/** The caller's inbox, as returned by GET /conversations. */
const inbox = async (api = employerApi) => {
  const res = await api.get('/conversations');
  assert.equal(res.status, 200);
  return res.body;
};

/** The one row of the caller's inbox for the seeded conversation. */
const inboxRow = async (api = employerApi) => {
  const { conversations } = await inbox(api);
  return conversations.find((c) => c.id === 'app-1');
};

/** The mark-read call under test. */
const markRead = (api = employeeApi, conversationId = 'app-1') =>
  api.put(`/conversations/${conversationId}/read`);

/**
 * The inbox preview cap, read lazily for the reason maxMessageLength is: see the note
 * on that helper.
 */
const previewLength = () =>
  require('../services/conversationService').LAST_MESSAGE_PREVIEW_LENGTH;

// --- 10a. Reading one conversation. ----------------------------------------

test('a participant can read their own conversation', async () => {
  seedConversation();

  const asEmployer = await employerApi.get('/conversations/app-1');
  assert.equal(asEmployer.status, 200);
  assert.equal(asEmployer.body.conversation.id, 'app-1');
  assert.equal(asEmployer.body.conversation.employerId, 'employer-1');
  assert.equal(asEmployer.body.conversation.employeeId, 'employee-1');

  // The same document for the other participant -- neither side is preferred.
  const asEmployee = await employeeApi.get('/conversations/app-1');
  assert.equal(asEmployee.status, 200);
  assert.equal(asEmployee.body.conversation.id, 'app-1');
});

test('the single-conversation read carries no unread count of its own', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));

  // Deliberate: the thread screen marks read instead of counting, so counting here
  // would mean the per-conversation message pass the inbox already pays for.
  const res = await employeeApi.get('/conversations/app-1');
  assert.equal(res.status, 200);
  assert.equal('unreadCount' in res.body.conversation, false);
});

test('an unrelated user cannot read a single conversation', async () => {
  seedConversation();
  const strangerApi = await client.authed('stranger-1');

  const res = await strangerApi.get('/conversations/app-1');
  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to access this conversation');
  assert.equal('conversation' in res.body, false);
});

test('reading a conversation that does not exist is a 404', async () => {
  seedConversation();

  const res = await employerApi.get('/conversations/app-nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Conversation not found');
});

// --- 10b. Counting what the caller has not read. -----------------------------

test('the inbox counts the messages the caller has not read', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', body: 'First', createdAt: at(-120) }));
  client.seed('messages', 'm-2', message({ senderId: 'employer-1', body: 'Second', createdAt: at(-60) }));

  const row = await inboxRow(employeeApi);
  assert.equal(row.unreadCount, 2);
  assert.equal((await inbox(employeeApi)).totalUnread, 2);
});

test('the inbox never counts the caller\'s own messages as unread', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employee-1', body: 'Mine', createdAt: at(-120) }));
  client.seed('messages', 'm-2', message({ senderId: 'employer-1', body: 'Theirs', createdAt: at(-60) }));

  // One each way: the employee is one behind the employer and not two.
  assert.equal((await inboxRow(employeeApi)).unreadCount, 1);
  assert.equal((await inboxRow(employerApi)).unreadCount, 1);
});

test('a thread nobody has written in is not unread', async () => {
  seedConversation();

  const row = await inboxRow(employeeApi);
  assert.equal(row.unreadCount, 0);
  assert.equal(row.lastMessage, null);
  assert.equal((await inbox(employeeApi)).totalUnread, 0);
});

test('the inbox previews the newest message, and who sent it', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', body: 'Older', createdAt: at(-120) }));
  client.seed('messages', 'm-2', message({ senderId: 'employee-1', body: 'Newest', createdAt: at(-60) }));

  const row = await inboxRow(employerApi);
  assert.equal(row.lastMessage.body, 'Newest');
  assert.equal(row.lastMessage.senderId, 'employee-1');
  assert.equal(row.lastMessage.createdAt._seconds, 1767225540);
});

test('the inbox truncates an over-long preview rather than shipping the whole body', async () => {
  seedConversation();
  const cap = previewLength();
  client.seed(
    'messages',
    'm-1',
    message({ senderId: 'employer-1', body: 'x'.repeat(cap + 50), createdAt: at(-60) })
  );

  const row = await inboxRow(employeeApi);
  assert.equal(row.lastMessage.body.length, cap + 3);
  assert.ok(row.lastMessage.body.endsWith('...'));
  // The stored message is untouched -- only the list projection is shortened.
  assert.equal(client.readDoc('messages', 'm-1').body.length, cap + 50);
});

test('totalUnread sums every conversation in the inbox', async () => {
  seedConversation();
  // Both messages are written BY the applicant, so they are the employer's unread ones.
  client.seed('messages', 'm-1', message({ senderId: 'employee-1', createdAt: at(-120) }));
  client.seed('messages', 'm-2', message({ senderId: 'employee-1', createdAt: at(-60) }));

  // A second applicant on the same job, so the employer is party to two conversations.
  client.seed('applications', 'app-2', application({ jobId: 'job-1', employeeId: 'employee-2' }));
  client.seed('conversations', 'app-2', conversation({
    applicationId: 'app-2', employerId: 'employer-1', employeeId: 'employee-2',
  }));
  client.seed('messages', 'm-3', message({
    conversationId: 'app-2', senderId: 'employee-2', createdAt: at(-60),
  }));

  const body = await inbox(employerApi);
  assert.equal(body.conversations.length, 2);
  assert.equal(body.totalUnread, 3);
  // Per row, so the inbox can badge one conversation without summing again.
  assert.equal(body.conversations.find((c) => c.id === 'app-1').unreadCount, 2);
  assert.equal(body.conversations.find((c) => c.id === 'app-2').unreadCount, 1);

  // The other side of each conversation. The applicant wrote both of app-1's messages,
  // so their own inbox has nothing unread in it at all -- the count is per participant,
  // not a property of the conversation.
  assert.equal((await inbox(employeeApi)).totalUnread, 0);
  assert.equal((await inbox(await client.authed('employee-2'))).totalUnread, 0);
});

// --- 10c. Reading is not marking. -------------------------------------------

test('listing the inbox marks nothing read', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));

  const before = stored();
  await inbox(employeeApi);
  await inbox(employeeApi);
  await inbox(employerApi);

  assert.deepEqual(stored(), before);
  assert.equal('employeeLastReadAt' in stored(), false);
  assert.equal('employerLastReadAt' in stored(), false);
});

test('reading the messages marks nothing read', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));

  await employeeApi.get('/conversations/app-1/messages');

  assert.equal('employeeLastReadAt' in stored(), false);
  assert.equal((await inboxRow(employeeApi)).unreadCount, 1);
});

// --- 10d. Marking read. ----------------------------------------------------

test('opening a conversation marks it read for the caller only', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));
  client.seed('messages', 'm-2', message({ senderId: 'employee-1', createdAt: at(-30) }));

  assert.equal((await inboxRow(employeeApi)).unreadCount, 1);
  assert.equal((await inboxRow(employerApi)).unreadCount, 1);

  const res = await markRead(employeeApi);
  assert.equal(res.status, 200);
  assert.equal(res.body.message, 'Conversation marked as read');
  assert.equal(res.body.conversationId, 'app-1');

  assert.deepEqual(stored().employeeLastReadAt, STAMP);
  assert.equal('employerLastReadAt' in stored(), false);

  // The other side still has its own unread message, which is the whole point of a
  // per-participant marker rather than one flag on the conversation.
  assert.equal((await inboxRow(employeeApi)).unreadCount, 0);
  assert.equal((await inboxRow(employerApi)).unreadCount, 1);
});

test('the employer side writes the employer marker and not the employee one', async () => {
  seedConversation();

  assert.equal((await markRead(employerApi)).status, 200);

  assert.deepEqual(stored().employerLastReadAt, STAMP);
  assert.equal('employeeLastReadAt' in stored(), false);
});

test('both participants can mark the same conversation read independently', async () => {
  seedConversation();

  await markRead(employeeApi);
  await markRead(employerApi);

  const doc = stored();
  assert.deepEqual(doc.employerLastReadAt, STAMP);
  assert.deepEqual(doc.employeeLastReadAt, STAMP);

  assert.equal((await inbox()).totalUnread, 0);
  assert.equal((await inbox(employeeApi)).totalUnread, 0);
});

test('marking read touches nothing else on the conversation', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));

  const before = stored();
  await markRead(employeeApi);

  const after = stored();
  const { employeeLastReadAt, ...unchanged } = after;
  assert.ok(employeeLastReadAt);
  // `lastMessageAt` in particular must not move: opening a thread is not activity in it.
  assert.deepEqual(unchanged, before);
});

test('marking read may be repeated', async () => {
  seedConversation();

  assert.equal((await markRead(employeeApi)).status, 200);
  assert.equal((await markRead(employeeApi)).status, 200);
  assert.equal((await markRead(employeeApi)).status, 200);

  assert.deepEqual(stored().employeeLastReadAt, STAMP);
});

test('a message that arrives after a read shows up unread again', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));

  assert.equal((await inboxRow(employeeApi)).unreadCount, 1);
  await markRead(employeeApi);
  assert.equal((await inboxRow(employeeApi)).unreadCount, 0);

  // Newer than the marker, which is exactly what "unread" has to mean.
  client.seed('messages', 'm-2', message({ senderId: 'employer-1', body: 'Later', createdAt: at(60) }));

  assert.equal((await inboxRow(employeeApi)).unreadCount, 1);
  assert.equal((await inboxRow(employerApi)).unreadCount, 0);
});

test('a message from the caller after a read is still not unread to them', async () => {
  seedConversation();
  await markRead(employeeApi);

  client.seed('messages', 'm-1', message({ senderId: 'employee-1', createdAt: at(60) }));

  assert.equal((await inboxRow(employeeApi)).unreadCount, 0);
  assert.equal((await inboxRow(employerApi)).unreadCount, 1);
});

test('one participant marking read does not clear the other\'s unread messages', async () => {
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));
  client.seed('messages', 'm-2', message({ senderId: 'employee-1', createdAt: at(-30) }));

  assert.equal((await inboxRow(employeeApi)).unreadCount, 1);
  assert.equal((await inboxRow(employerApi)).unreadCount, 1);

  await markRead(employeeApi);

  assert.equal((await inboxRow(employeeApi)).unreadCount, 0);
  assert.equal((await inboxRow(employerApi)).unreadCount, 1);
});

test('marking a conversation that does not exist is a 404', async () => {
  seedConversation();

  const res = await markRead(employeeApi, 'app-nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.message, 'Conversation not found');
});

test('an unrelated user cannot mark a conversation read', async () => {
  seedConversation();
  const before = stored();

  const strangerApi = await client.authed('stranger-1');
  const res = await markRead(strangerApi);

  assert.equal(res.status, 403);
  assert.equal(res.body.message, 'You do not have permission to access this conversation');
  assert.deepEqual(stored(), before);
});

test('a stranger cannot mark a conversation read even by guessing its id', async () => {
  seedConversation();
  const strangerApi = await client.authed('stranger-1');

  // Ids are application ids, which are caller-visible on some routes, so the check has
  // to be membership rather than unguessability.
  assert.equal((await markRead(strangerApi)).status, 403);
  assert.equal('employeeLastReadAt' in stored(), false);
});

test('marking read survives the withdrawal of the application', async () => {
  // Stage 8E made a conversation outlive its application, so the guard's
  // application -> job chain is gone by the time this route is reached and it falls
  // back to the conversation's own uids. The read marker is stored on that same
  // document, so it has to keep working through the fallback.
  seedConversation();
  client.seed('messages', 'm-1', message({ senderId: 'employer-1', createdAt: at(-60) }));

  await markRead(employeeApi);
  await employeeApi.delete('/applications/app-1');

  assert.equal(client.readDoc('applications', 'app-1'), undefined);
  assert.equal((await markRead(employeeApi)).status, 200);
  assert.equal((await inboxRow(employeeApi)).unreadCount, 0);
});

test('a conversation whose two participants are the same uid marks both sides read', async () => {
  // Reachable in principle: createOrGetConversation copies the two uids from a job and
  // an application and does not forbid them being the same person. "Which marker is
  // mine" has two answers there, so both are written and neither can be stale.
  seedJobWithApplication();
  client.seed('conversations', 'app-1', conversation({ employerId: 'employee-1', employeeId: 'employee-1' }));

  const selfApi = await client.authed('employee-1');
  assert.equal((await selfApi.put('/conversations/app-1/read')).status, 200);

  const doc = stored();
  assert.deepEqual(doc.employerLastReadAt, STAMP);
  assert.deepEqual(doc.employeeLastReadAt, STAMP);
});