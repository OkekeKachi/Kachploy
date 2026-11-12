// conversationService.js
//
// Business and data layer for the chat resource (new in Stage 8B). A conversation
// is the message thread between the employer who posted a job and the applicant who
// applied to it.
//
// WHAT EXISTS HERE
//   * createOrGetConversation -- the idempotent create, reachable from
//     POST /conversations
//   * sendMessage -- the append, reachable from POST /conversations/:id/messages
//   * getConversation -- one thread's own document, GET /conversations/:id
//   * listConversationsForCaller -- the caller's own inbox with unread counts,
//     GET /conversations
//   * listMessages -- one thread, GET /conversations/:id/messages
//   * markConversationRead -- the per-participant read marker,
//     PUT /conversations/:id/read
//
// THE MODEL, AND WHY IT IS ANCHORED ON THE APPLICATION
// A conversation is stored under the id of the application it belongs to, and the
// create accepts no other context. This is the decision the whole resource rests on,
// so it is worth stating plainly:
//
//   * The application is the only object in this database that already names both
//     parties without ambiguity: `application.employeeId` is the applicant, and
//     `application.jobId` -> `job.postedBy` is the employer. Every authorization
//     precedent in this codebase already resolves through it -- requireInterviewParty
//     loads exactly these two documents.
//   * It therefore gives recruitment-to-employment continuity for free. A thread
//     opened while an application is `pending` is still the same thread after the
//     application becomes `accepted` and an employment exists, because nothing about
//     the conversation changed and nothing created a second one. No employment
//     redesign is needed or attempted, and no "post-hire chat" exists as a separate
//     thing that could drift from the pre-hire one.
//   * It gives idempotency for free. "The conversation for this application" is a
//     fact rather than an event, so it is stored under a derived document id (see
//     conversationRepository.createConversation) and cannot be duplicated.
//
// A job-level or employment-level conversation is deliberately NOT offered. A
// job-level one would be authorized by `job.postedBy`, which admits the employer to
// every applicant on that job at once -- so a single thread would have to either mix
// all those applicants together or grow a per-applicant rule that is really the
// application rule under a different name, while leaking the existence of one
// applicant's conversation to the others. Neither is a thing Stage 8B should ship.
//
// WHAT DELIBERATELY DOES NOT EXIST YET
//   * Read state arrived in Stage 10B and is described at the foot of this file, next
//     to the two marker fields it stores. What it deliberately did NOT bring with it is
//     a read receipt: nothing here records that one person has seen a particular
//     message, only that a participant has opened the thread. "Seen" and "delivered"
//     are still the same fact here, and they are the same fact everywhere else in this
//     codebase.
//   * No message edit and no message delete. No route exposes them, so there is no
//     update path to authorize and no deletion semantics to decide. See the note at
//     the foot of conversationRepository.js.
//   * No attachments, and no notification of any kind. Nothing here sends email,
//     pushes, or writes to any collection other than `conversations` and `messages`.
//     A reader learns of a new message by re-reading their inbox, exactly as they
//     learn of everything else in this API.
//   * No transaction, because Stage 8B does not permit one. See the write-ordering
//     note on sendMessage for the one place a transaction would eventually be wanted.
//
// AUTHORIZATION: as with employmentService and interviewService, the service
// performs no ownership check of its own. The two Stage 8B guards in
// middleware/auth.js answer "may this caller do this?" before any function here
// runs; this file answers "is this data valid?". Keeping the two apart is what lets
// the same createOrGetConversation be reached from a route today and from a future
// orchestration without re-deciding identity.

const { admin } = require('../config/firebase');
const applicationRepository = require('../repositories/applicationRepository');
const jobRepository = require('../repositories/jobRepository');
const conversationRepository = require('../repositories/conversationRepository');

/**
 * The request asks for something impossible. Surfaces as a 400.
 *
 * Exists so the controller can tell "you asked for something impossible" from an
 * unexpected Firestore failure, exactly as JobValidationError,
 * ApplicationValidationError, TaskValidationError, EmploymentValidationError and
 * InterviewValidationError do.
 */
class ConversationValidationError extends Error {}

/**
 * The referenced conversation or application does not exist. Surfaces as a 404.
 *
 * In practice the routers' guards turn a missing conversation into a 404 before this
 * class is reached, the same way requireInterviewParty pre-empts
 * listInterviewsForApplication's not-found path. The class and the existence checks
 * stay because the service must be correct when called without those guards.
 */
class ConversationNotFoundError extends Error {}

/**
 * The longest message body this service will store, in characters.
 *
 * A NEW limit, and the first length cap anywhere in this codebase -- there is no
 * precedent to match, which is worth saying plainly rather than implying one.
 * `applicationService.applyToJob` stores its `message` (the applicant's cover
 * letter) as `message || ''` with no cap at all, and no other service validates a
 * length; both facts are a deliberate choice for a different resource and neither is
 * evidence that an uncapped chat body is safe.
 *
 * The reason a chat body needs one where a cover letter does not is volume and
 * blast radius. A cover letter is one field written once per application. A chat is
 * unbounded and written many times by two people, so without a cap a single client
 * can push an arbitrarily large string into a document that the other party is then
 * made to download and render, and Firestore's own 1 MiB document limit would
 * surface as an opaque 500 rather than a validation error the client can act on.
 *
 * 2000 characters is comfortably longer than a chat message needs to be useful and
 * comfortably shorter than that limit. It is a client-side UX concern as much as a
 * storage one: the UI should count down to it rather than discovering it as a 400.
 */
const MESSAGE_MAX_LENGTH = 2000;

/**
 * True for a body this service will store as a message.
 *
 * A string with at least one non-whitespace character, no longer than
 * MESSAGE_MAX_LENGTH. A number, an object, an array, `null` and `undefined` are all
 * rejected rather than coerced: JSON is untrusted input, and `String(body)` on an
 * object would store "[object Object]" as if a person had written it.
 *
 * The length check runs on the RAW string, before trimming, so that a body of 2000
 * spaces cannot be used to smuggle a longer payload past the cap. What is actually
 * stored is the trimmed value (see sendMessage), which can only be shorter.
 */
const isValidMessageBody = (value) => {
  if (typeof value !== 'string') return false;
  if (value.trim() === '') return false;
  return value.length <= MESSAGE_MAX_LENGTH;
};

/**
 * Normalises any stored timestamp to milliseconds, for ordering only.
 *
 * Stage 8B has to sort messages without an `orderBy` on the query, because the fake
 * Firestore in testing/ throws on `orderBy()` rather than modelling it, and because
 * ordering a chat thread is a requirement rather than a nicety. That means comparing
 * timestamps in JavaScript, and the values arriving here are not one type:
 *
 *   * `{ _seconds, _nanoseconds }` -- what `FieldValue.serverTimestamp()` resolves to.
 *     The admin SDK's Timestamp serialises to exactly those two own properties, which
 *     is also the wire shape the client receives (see the long note on timestampFrom
 *     in testing/fakeFirestore.js).
 *   * an ISO string -- what an injected test clock returns, and what a job document's
 *     own `createdAt` holds, since jobService still writes `new Date()`.
 *   * a number, or nothing at all -- a missing or malformed field must not throw.
 *
 * Anything unrecognised becomes 0 so it sorts first rather than making the sort
 * comparator throw on `NaN`. This is a display-order fallback, not validation: no
 * value stored by sendMessage can reach the unrecognised branch.
 */
const timestampMillis = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  if (typeof value === 'object') {
    if (typeof value._seconds === 'number') {
      return value._seconds * 1000 + (value._nanoseconds || 0) / 1e6;
    }
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    return 0;
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  return 0;
};

/**
 * Flattens a QuerySnapshot into `{ id, ...data }` objects.
 *
 * The same shape every list in this codebase produces (employments, tasks,
 * applications, interviews): the document id is added and no field is renamed,
 * dropped or reshaped, so a caller reads back the stored document byte for byte.
 */
const toPlainObjects = (snapshot) => {
  const records = [];

  snapshot.forEach((doc) => {
    records.push({ id: doc.id, ...doc.data() });
  });

  return records;
};

/**
 * STAGE 10B, THE READ MODEL. Two scalar fields on the conversation document, one per
 * participant, and nothing else.
 *
 * A conversation names exactly two people -- `employerId` and `employeeId`, both copied
 * from authoritative sources at create time and neither ever writable from a request --
 * so "whose read state is this?" has exactly two answers and a fixed field per answer
 * needs no map, no per-user subcollection and no query to read it back.
 *
 * THREE PROPERTIES, and each one rules out the obvious alternative:
 *
 *   1. Per participant, not per conversation. A single `lastReadAt` would need to mean
 *      "read by whom?" and would answer it wrongly: whichever of the two people opened
 *      the thread last would clear the other's unread messages too.
 *   2. A timestamp, not a boolean. A `read: true` flag has nowhere to say *how far* the
 *      reader got, so a message that arrived after they last looked would be
 *      indistinguishable from one they had already seen. Comparing message timestamps
 *      against the marker is what lets an unread count be derived rather than stored --
 *      and derived is the point, because a stored counter needs its own increment on
 *      every send and can drift from the messages it counts (see the note on
 *      LAST_MESSAGE_PREVIEW_LENGTH for the same instinct applied to the list payload).
 *   3. Written only by markConversationRead, which is the only route that touches them.
 *      Reading a conversation NEVER marks it read: GET /conversations lists the inbox
 *      and GET /conversations/:id/messages returns the thread, and neither may silently
 *      mutate state. That separation is the whole reason there is a separate
 *      mark-read route instead of marking on the message read itself -- a GET that
 *      writes cannot be cached, prefetched or retried safely, and a prefetch that marks
 *      read would be a real bug rather than a theoretical one.
 *
 * Neither field is initialised at create time. An absent marker means "this participant
 * has never opened the thread", which counts every message the OTHER one has sent as
 * unread -- the correct answer, and the one that avoids writing two timestamps for a
 * conversation whose first message is then deleted... which cannot happen, since nothing
 * deletes a message. The absence is kept anyway because a document that only ever holds
 * a marker after the first mark-read is one field smaller than one that pre-fills it.
 *
 * A conversation whose two participants are the same uid -- an employer applying to
 * their own job, which createOrGetConversation does not forbid -- is the one case where
 * "which side am I" has two answers. markConversationRead writes BOTH markers there, so
 * they can never disagree, and readMarkerField below may return either.
 */
const EMPLOYER_READ_MARKER = 'employerLastReadAt';
const EMPLOYEE_READ_MARKER = 'employeeLastReadAt';

/**
 * The field holding `uid`'s read marker, or undefined when they are not on it.
 *
 * Employer side is tested first, which is what makes the self-conversation case above
 * resolve to the employer field without either marker being wrong.
 */
const readMarkerField = (conversation, uid) => {
  if (conversation.employerId === uid) return EMPLOYER_READ_MARKER;
  if (conversation.employeeId === uid) return EMPLOYEE_READ_MARKER;
  return undefined;
};

/**
 * How long the inbox's last-message preview may be, in characters.
 *
 * A presentation cap that lives in the service, which is unusual for this codebase, and
 * the reason is that this response is not only for the inbox: it is also what the navbar
 * badge polls on a timer, and a badge needs a COUNT. Shipping whole 2000-character
 * message bodies on every tick, for every conversation, to render a row on a page the
 * reader may not open, is a cost no badge should pay. Truncating once here keeps the
 * polled payload small and the client's rendering trivial.
 *
 * The truncated body is prefixed with an ellipsis so a client cannot mistake a cut
 * message for a complete one.
 */
const LAST_MESSAGE_PREVIEW_LENGTH = 200;

/**
 * Every message in one conversation, oldest first.
 *
 * Shared by listMessages and by the inbox's unread pass, so the unread count and the
 * thread view are computed over the SAME ordering and can never disagree about which
 * message is last. The sort is the service's responsibility for the reason given on
 * listMessages: a chat thread that can render out of order is a broken thread.
 */
const loadSortedMessages = async (conversationId) => {
  const snapshot = await conversationRepository.listMessagesByConversation(conversationId);

  const messages = toPlainObjects(snapshot);

  messages.sort((a, b) => timestampMillis(a.createdAt) - timestampMillis(b.createdAt));

  return messages;
};

/**
 * How many of `uid`'s messages in this conversation they have not read.
 *
 * Two rules, both of which the requirement states and both of which have a failure mode
 * worth naming:
 *
 *   * ONLY messages from the other participant count. `senderId !== uid` is what stops
 *     your own messages from making your own inbox unread, which is the obvious bug in
 *     this feature: a sender who opens the thread and sees their own message would
 *     otherwise be permanently one behind themselves.
 *   * Strictly newer than the marker, so a message that arrives between the reader
 *     loading the thread and the mark-read landing is counted read. That is the
 *     documented cost of marking with "now" rather than with the timestamp of the last
 *     message they were shown -- see markConversationRead.
 */
const countUnread = (conversation, uid, messages) => {
  const field = readMarkerField(conversation, uid);
  const marker = field ? timestampMillis(conversation[field]) : 0;

  return messages.filter(
    (message) => message.senderId !== uid && timestampMillis(message.createdAt) > marker
  ).length;
};

/**
 * The newest message, as a short preview, or null for a thread nobody has written in.
 *
 * Carries `senderId` alongside the body because the inbox has to say WHO wrote it, and
 * that is a fact the reader cannot derive from a row they may not have opened. The
 * body is truncated at LAST_MESSAGE_PREVIEW_LENGTH.
 */
const buildLastMessagePreview = (messages) => {
  if (messages.length === 0) return null;

  const newest = messages[messages.length - 1];
  const body = typeof newest.body === 'string' ? newest.body : '';
  const truncated = body.length > LAST_MESSAGE_PREVIEW_LENGTH;

  return {
    id: newest.id,
    senderId: newest.senderId,
    body: truncated ? `${body.slice(0, LAST_MESSAGE_PREVIEW_LENGTH)}...` : body,
    createdAt: newest.createdAt,
  };
};

/**
 * Returns the conversation for an application, creating it the first time.
 *
 * Idempotent by construction, and by two independent mechanisms, because the caller
 * is a button that two people may both press:
 *   * the document id is derived from the application id, so two concurrent creates
 *     target the same document and one conversation is the only possible outcome;
 *   * an existing conversation is returned as it stands and is NOT rewritten, so a
 *     second call cannot reset `createdAt` or `lastMessageAt` and reorder an
 *     established thread.
 *
 * AUTHORIZATION: performed by the router's requireConversationParticipant guard,
 * which has already established that the caller is either the application's
 * applicant or the owner of its job. The guard also handles the missing-document
 * cases, so the 404s below are a backstop for a call made without it.
 *
 * The application and the job are read HERE rather than taken from the guard's
 * `req.application` / `req.job`, which is the arrangement interviewService and
 * withdrawApplication already use: the guard's read answers "may this caller?", and
 * the service's read answers "does this application exist, and whose is it?".
 * Collapsing the two would make the service unusable without a populated request
 * object, and would let a future non-HTTP caller pass an employer it had not
 * verified. The cost is one extra read of a single document on a path that runs once
 * per application for the life of the product.
 *
 * Both participant uids are copied onto the conversation from authoritative sources
 * -- the applicant from the application document, the employer from the job's
 * `postedBy` -- and NEVER from the request body. A body field of either name is
 * ignored rather than rejected, matching how applyToJob silently discards an
 * `employeeId` and how createInterview reads its applicant. This is the single most
 * important property of the document: the two uids on it are what
 * requireConversationParty authorizes every later message read and write against,
 * so a client that could influence them could authorize itself onto someone else's
 * conversation.
 *
 * RETENTION: the conversation deliberately outlives its application.
 * `withdrawApplication` deletes the application document, and rejecting one only
 * changes its status -- neither is an ending of the conversation, and the two people
 * in it can still read what they said to each other. Because the participant uids are
 * copied onto the conversation rather than resolved through the application on every
 * read, that remains true even when the application document is gone: an orphaned
 * thread is still readable by exactly the two people who were in it, and by nobody
 * else. Whether an applicant should be able to keep reading a thread after
 * withdrawing is a product question this stage records rather than answers; see the
 * note on MESSAGE_MAX_LENGTH for the same style of recorded limit.
 *
 * Returns `{ conversationId, conversation, created }`. `created` is true only when
 * this call is the one that made it, so the controller can word the two cases
 * differently instead of reporting a creation that did not happen.
 */
const createOrGetConversation = async (applicationId) => {
  if (!applicationId) {
    throw new ConversationValidationError('Missing required fields');
  }

  // The idempotency read. Because the document id is the application id, this one
  // read is the whole of the "has this already been made" question.
  const existing = await conversationRepository.getConversationById(applicationId);
  if (existing.exists) {
    const conversation = { id: existing.id, ...existing.data() };
    return { conversationId: conversation.id, conversation, created: false };
  }

  const applicationSnapshot = await applicationRepository.getApplicationById(applicationId);
  if (!applicationSnapshot.exists) {
    throw new ConversationNotFoundError('Application not found');
  }

  const application = applicationSnapshot.data();

  const jobSnapshot = await jobRepository.getJobById(application.jobId);
  if (!jobSnapshot.exists) {
    throw new ConversationNotFoundError('Job not found');
  }

  const job = jobSnapshot.data();

  const document = {
    applicationId,
    jobId: application.jobId,
    // The employer is the job's poster, not a caller-supplied value. See the note
    // above on why these two fields are the authorization anchor for the whole
    // resource.
    employerId: job.postedBy,
    employeeId: application.employeeId,
    // STAGE 8B. serverTimestamp(), not `new Date()`, for the reason Stage 5H gave
    // for users.createdAt and Stage 7C repeated for interviews: the value is
    // committed by Firestore, so it cannot be skewed by a drifting host clock.
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    // Stamped with the same instant as createdAt so an inbox that sorts on it has a
    // defined order for a thread nobody has written in yet.
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
  };

const conversationId = await conversationRepository.createConversation(applicationId, document);

    // Read the document back rather than echoing `document`. The pre-write payload
    // still holds the UNRESOLVED FieldValue.serverTimestamp() sentinels, so
    // returning it would serialise them straight onto the wire -- a client would
    // receive `{"__sentinel":"serverTimestamp"}` where a timestamp belongs, and in
    // production that is an internal Firestore artifact leaking through the API.
    // Re-reading costs one round trip on a path that runs once per application for
    // the life of the product, and it has the side benefit of making the created and
    // the already-existed branches return the same shape: in both cases the caller
    // gets the document as Firestore actually stored it.
    const written = await conversationRepository.getConversationById(conversationId);
    const conversation = { id: written.id, ...written.data() };

    return { conversationId, conversation, created: true };
};

/**
 * Appends one message to a conversation.
 *
 * AUTHORIZATION: performed by the router's requireConversationParty guard, which has
 * already established that the caller is one of the two uids stored on the
 * conversation. That guard authorizes on the CONVERSATION's own copy of the two
 * uids, not by re-resolving application -> job on every message -- so authorizing a
 * send costs one document read, and cannot widen if the job's owner changes later.
 * The conversation is re-read here for the existence check only, exactly as
 * updateInterview re-reads its interview.
 *
 * `senderId` is always the verified token's uid, passed in by the controller, and is
 * NEVER read from the body. A body `senderId` is ignored rather than rejected,
 * matching the treatment of a body `employeeId` elsewhere in this codebase. This is
 * the one field that decides who appears to have written a message, so allowing it
 * from the request would let any participant post as the other one.
 *
 * The body is trimmed before storage and validated before any write, so a message is
 * never stored as an empty or whitespace-only document.
 *
 * WRITE ORDERING, AND THE DOCUMENTED GAP. This is two writes -- the message add and
 * the conversation's `lastMessageAt` stamp -- and there is no transaction, for the
 * reason recorded at the top of conversationRepository.js. The message is written
 * FIRST, deliberately:
 *
 *   * If the add succeeds and the stamp fails, the message exists and is readable; the
 *     conversation is merely mis-ordered in the inbox by one position.
 *   * The reverse order would let a conversation advertise activity that never
 *     happened, which is a worse failure to debug than a stale ordering field.
 *
 * So the window is a denormalised convenience field that can lag, never a message
 * that can be lost. That is the same trade Stage 7A documents for the hire's
 * application-status write and employment add, and the honest fix is a transaction
 * -- which Stage 8B does not permit. The gap is recorded here rather than hidden; a
 * later stage that makes ordering load-bearing should revisit it.
 *
 * Returns `{ messageId }`, matching taskService.createTask's `{ taskId }` and
 * interviewService.createInterview's `{ interviewId }`.
 */
const sendMessage = async (conversationId, payload, senderId) => {
  if (!senderId) {
    throw new ConversationValidationError('Missing required fields');
  }

  const body = payload ? payload.body : undefined;

  if (!isValidMessageBody(body)) {
    if (typeof body !== 'string' || body.trim() === '') {
      // Same wording applicationService.applyToJob uses for a wholly absent value,
      // so a client that omits `body` gets the answer it already gets elsewhere.
      throw new ConversationValidationError('Missing required fields');
    }
    throw new ConversationValidationError(
      `Message body must be a non-empty string of at most ${MESSAGE_MAX_LENGTH} characters`
    );
  }

  const conversationSnapshot = await conversationRepository.getConversationById(conversationId);
  if (!conversationSnapshot.exists) {
    throw new ConversationNotFoundError('Conversation not found');
  }

  const messageId = await conversationRepository.addMessage({
    conversationId,
    senderId,
    body: body.trim(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Best-effort, and deliberately after the add. See the write-ordering note above.
  await conversationRepository.updateConversationFields(conversationId, {
    lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { messageId };
};

/**
 * Every conversation the caller is party to, with their unread state.
 *
 * The union of two single-field equality queries, because Firestore has no OR
 * operator and a conversation is reachable by two different owners of the truth: the
 * employer who posted the job, and the applicant it was sent to. One query cannot
 * express "employerId == uid OR employeeId == uid", so this issues both and merges.
 *
 * This is the only place in the resource that needs a two-query read, and it is the
 * cost of not having a separate per-user conversation index. It is the same shape of
 * cost the Stage 4 N+1 note describes, accepted here for a different reason: the
 * inbox is one query per party, not one per record, so it does not grow with the
 * number of conversations.
 *
 * Deduplication is defensive rather than decorative. A caller cannot be both the
 * employer and the employee of one conversation, because createOrGetConversation
 * copies the two uids from an application and a job whose poster and applicant are
 * different people -- so the two result sets are disjoint in practice. Merging on id
 * anyway means that if that ever stops being true, an inbox shows one row rather than
 * two identical ones, instead of the client having to cope.
 *
 * THE UNREAD PASS, AND ITS COST. Stage 10B adds one message query PER CONVERSATION
 * rather than one per inbox. That is an N+1, and unlike the two-query union above it
 * genuinely does grow with the number of rows -- an employer with forty applicants has
 * forty conversations and pays forty message reads for this one call. It buys exactness:
 * `unreadCount` is counted from the messages against the caller's own marker, so it is
 * the number of messages actually unread rather than a counter that can drift away
 * from them.
 *
 * The alternatives were considered and rejected rather than overlooked:
 *
 *   * A stored per-participant counter, incremented on send. O(1) to read, but the
 *     increment is a second write with no transaction -- the exact gap already
 *     documented on sendMessage for `lastMessageAt`, except that a stale ordering field
 *     only misplaces a row in the list while a stale counter is simply the wrong number
 *     shown to a person.
 *   * Querying messages newer than the marker directly. Firestore allows one inequality
 *     field per query and no `!=` at all, so "this conversation AND sender != me AND
 *     createdAt > my marker" cannot be expressed; it would need a composite index and
 *     still could not exclude the sender.
 *
 * The cost is therefore paid here, once per inbox load, and NOT on the message read
 * that a thread does every five seconds -- which is the path whose latency a person is
 * actually waiting on. It is also why the navbar badge polls on a longer interval than
 * the thread (see MessagesNavLink.jsx): every tick of that badge is one of these calls.
 *
 * READS NEVER MARK READ. Nothing on this path writes, so opening the inbox does not
 * clear an unread count; only PUT /conversations/:id/read does. That is what lets a
 * navbar badge poll this endpoint continuously without a single message ever being
 * silently marked read by the act of looking at a list.
 *
 * Unordered, like every other list endpoint in this API (tasks, applications,
 * employments and interviews all return documents in whatever order the query
 * produced). `lastMessageAt` is denormalised onto each document precisely so the
 * Stage 8C client can order its inbox without a second round trip or a server-side
 * sort; this service does not sort, and adding a sort here later would change the
 * order of results no test currently asserts on.
 *
 * An empty inbox is `{ conversations: [], totalUnread: 0 }`, not a 404: a user who has
 * never been in a conversation is not a missing resource.
 *
 * Returns `{ conversations, totalUnread }` rather than a bare array. The total is the
 * whole reason it is not an array: the navbar badge needs ONE number, and making the
 * client sum the rows to get it would put the only arithmetic in this endpoint's
 * consumers, in a component that has no other reason to understand the rows.
 */
const listConversationsForCaller = async (uid) => {
  const [employerSnapshot, employeeSnapshot] = await Promise.all([
    conversationRepository.listConversationsByEmployer(uid),
    conversationRepository.listConversationsByEmployee(uid),
  ]);

  const byId = new Map();

  for (const snapshot of [employerSnapshot, employeeSnapshot]) {
    for (const record of toPlainObjects(snapshot)) {
      byId.set(record.id, record);
    }
  }

  // STAGE 10B. Concurrent rather than sequential, so the whole inbox costs one round
  // trip of latency instead of N. The same reason MyApplications batches its interview
  // reads; the cost is still N queries, only not N round trips.
  const rows = await Promise.all(
    [...byId.values()].map(async (conversation) => {
      const messages = await loadSortedMessages(conversation.id);

      return {
        ...conversation,
        unreadCount: countUnread(conversation, uid, messages),
        lastMessage: buildLastMessagePreview(messages),
      };
    })
  );

  const totalUnread = rows.reduce((total, row) => total + row.unreadCount, 0);

  return { conversations: rows, totalUnread };
};

/**
 * One conversation's own document, with its id folded in.
 *
 * STAGE 10B. Added for the dedicated thread screen, which has to name the other
 * participant and caption the job before it can render a header, and both facts live
 * only on the conversation document: `employerId`/`employeeId` and `jobId`. The message
 * list carries neither, and the inbox carries every row the caller has rather than the
 * one they asked for, so before this there was no endpoint that could answer "who am I
 * talking to about what?" for a single conversation.
 *
 * It is deliberately NOT the inbox with a filter. Reading one row through
 * GET /conversations would cost the caller the whole inbox -- two queries plus one
 * message query per conversation -- to display one thread, which is the N+1 documented
 * on listConversationsForCaller spent on a page that needs none of it.
 *
 * The `unreadCount` the inbox attaches is NOT repeated here, for the same reason: this
 * screen's job is to mark the conversation read, and it learns it did so from the
 * mark-read response rather than from a second join.
 *
 * AUTHORIZATION: performed by the router's requireConversationParty guard, which has
 * already established that the caller is one of the two uids on the document, so the
 * 404 below is a backstop for a call made without it -- the same arrangement
 * sendMessage and listMessages use.
 */
const getConversation = async (conversationId) => {
  const snapshot = await conversationRepository.getConversationById(conversationId);

  if (!snapshot.exists) {
    throw new ConversationNotFoundError('Conversation not found');
  }

  return { id: snapshot.id, ...snapshot.data() };
};

/**
 * Marks the conversation read for the calling participant, and for them only.
 *
 * Writes `employerLastReadAt` or `employeeLastReadAt` -- whichever side of the
 * conversation the caller is on -- to `serverTimestamp()`. Nothing else on the document
 * is touched: `lastMessageAt` moves only when a message is written, because opening a
 * thread is not activity in it.
 *
 * AUTHORIZATION: performed by the router's requireConversationParty guard. It is reused
 * unchanged rather than given a stricter sibling, and correctly so: marking read is
 * something both participants may do for themselves, and neither may do it for the
 * other. There is no route on which one participant can set the other's marker -- the
 * uid comes from the verified token and the field is chosen from it -- so this is
 * membership, which is exactly what the existing guard answers.
 *
 * "NOW" RATHER THAN THE TIMESTAMP OF THE LAST MESSAGE SHOWN, which is the one judgement
 * call in the read model. The marker is the server's current instant, so a message that
 * arrives in the window between the client loading the thread and this write landing is
 * counted as read even though the reader had not seen it. The alternative -- stamping
 * the newest message the reader was shown -- closes that window but makes the marker
 * depend on a value the client sends, and a client that sent a FUTURE one would make
 * its unread messages permanently invisible. A server-owned clock that may mark one
 * message slightly early is the safer of the two, and the thread re-reads itself every
 * five seconds, so the message is on screen within one poll interval either way.
 *
 * Idempotent, and repeated calls are free of consequence: the marker only ever moves
 * forward in practice, and a second call rewrites the same field with a later instant.
 *
 * Returns `{ conversationId }`. Deliberately NOT an `unreadCount`: computing one would
 * mean re-reading every message in the thread (the same pass the inbox pays for), to
 * return a number that a message arriving a millisecond later would invalidate. The
 * client knows the conversation is read because this call said so.
 */
const markConversationRead = async (conversationId, uid) => {
  if (!uid) {
    throw new ConversationValidationError('Missing required fields');
  }

  const conversationSnapshot = await conversationRepository.getConversationById(conversationId);
  if (!conversationSnapshot.exists) {
    throw new ConversationNotFoundError('Conversation not found');
  }

  const conversation = { id: conversationSnapshot.id, ...conversationSnapshot.data() };

  const mark = admin.firestore.FieldValue.serverTimestamp();
  const patch = {};

  // Both branches rather than one, so the self-conversation case -- where the two
  // stored uids are the same person -- writes both markers and leaves no field behind
  // that disagrees with the other.
  if (conversation.employerId === uid) patch[EMPLOYER_READ_MARKER] = mark;
  if (conversation.employeeId === uid) patch[EMPLOYEE_READ_MARKER] = mark;

  /*
      Unreachable through the router, which has already refused a non-participant with a
      403, and present so that a direct caller who is not on the conversation gets a
      stated failure rather than an empty patch. An empty `.update({})` is rejected by
      the real SDK, so without this the function would surface as a 500 on a request
      that should never have got here.
  */
  if (Object.keys(patch).length === 0) {
    throw new ConversationValidationError('Caller is not a participant in this conversation');
  }

  // One field-level patch on an existing document, the same call sendMessage makes.
  await conversationRepository.updateConversationFields(conversationId, patch);

  return { conversationId };
};

/**
 * Every message in one conversation, oldest first.
 *
 * AUTHORIZATION: the router's requireConversationParty guard has already established
 * that the caller is one of the two participants, and refuses everyone else with a
 * 403 carrying no message data.
 *
 * Sorted here rather than by an `orderBy` on the query, which is the one place this
 * resource departs from the "let the client order it" convention the other lists
 * follow. The reason is that a chat thread is not a list of independent records: if
 * two messages can be returned in either order then the thread reads wrong, and
 * unlike an inbox's ordering this is load-bearing rather than cosmetic. So the sort
 * is the service's responsibility.
 *
 * `Array.prototype.sort` is stable, so messages whose timestamps compare equal keep
 * the order the query returned them in -- which for both the fake store and a real
 * single-field Firestore query is document insertion order, i.e. the order they were
 * sent. In production the timestamps are distinct and this tiebreak never engages.
 *
 * KNOWN LIMIT: the sort happens in memory after the query returns, so a thread is
 * fully materialised before the first byte reaches the client. That is proportionate
 * to a recruitment conversation and is the price of not needing a composite index on
 * (`conversationId`, `createdAt`). A stage that gives chat a real history should move
 * the ordering into the query and add that index; this is recorded rather than
 * pretended away, in the same style as the Stage 7A hire race and the Stage 7C
 * meetingLink gap.
 *
 * A conversation nobody has written in yet is an empty list, not a 404 -- the same
 * rule the tasks and interviews lists follow.
 *
 * STAGE 10B: the body of this function moved into loadSortedMessages, above, because
 * the inbox's unread pass needs the same query and the same sort and must not be able to
 * disagree with the thread view about which message is newest. The contract here is
 * unchanged.
 */
const listMessages = async (conversationId) => loadSortedMessages(conversationId);

module.exports = {
  ConversationValidationError,
  ConversationNotFoundError,
  MESSAGE_MAX_LENGTH,
  LAST_MESSAGE_PREVIEW_LENGTH,
  createOrGetConversation,
  sendMessage,
  getConversation,
  listConversationsForCaller,
  listMessages,
  markConversationRead,
};