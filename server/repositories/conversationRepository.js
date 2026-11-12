// conversationRepository.js
//
// Data-access layer for the two collections introduced in Stage 8B: `conversations`
// and `messages`. It owns every direct Firestore call for them -- the deterministic
// conversation write, the single-document read the authorization guards need, the
// two single-field equality queries behind the caller's own inbox, the message add,
// the per-conversation message list, and the field-level patches that stamp a
// conversation's most recent activity and a participant's read marker.
//
// SCOPE: these two collections only. Nothing else in the codebase reaches them, so
// like `employments` (Stage 7A) and `interviews` (Stage 7C) they are served
// exclusively by this file from the moment they are created. middleware/auth.js
// reads `conversations` through getConversationById below -- to establish who is
// party to a conversation -- exactly as the Stage 7C guards read `jobs` and
// `applications` to establish who owns a job.
//
// This layer holds no business logic, as the six repositories that predate it do.
// It knows nothing about HTTP, status codes, controllers, Express, tokens or
// authorisation, and it raises no error of its own: reads hand back the raw
// snapshot so conversationService keeps ownership of the `exists` checks and of the
// ConversationNotFoundError / ConversationValidationError classes.
//
// WHY TWO TOP-LEVEL COLLECTIONS RATHER THAN A `messages` SUBCOLLECTION
// A subcollection under `conversations/{id}` is the shape Firestore is often
// documented with, and it was the shape the Stage 8A audit originally proposed. It
// is not the shape used here, and the reason is this repository's own convention
// rather than a Firestore limitation:
//
//   * Every collection that already exists in this database is top-level and carries
//     its foreign keys as fields: `tasks` has `jobId` + `employeeId`, `interviews`
//     has `applicationId` + `jobId` + `employerId` + `employeeId`, `employments`
//     has `applicationId` + `jobId` + `employerId` + `employeeId`. A subcollection
//     would make chat the only relationship in the database modelled structurally
//     rather than by field, and the Stage 8A audit's own reasoning for denormalising
//     participant uids onto the conversation applies just as well to the messages.
//   * The test double in testing/fakeFirestore.js is flat: `Store` buckets documents
//     by bare collection name and `DocRef` has no `.collection()` method, so a
//     subcollection write would either throw or silently land in an unrelated
//     bucket. Teaching the shared double about subcollections is a change to test
//     infrastructure every existing suite depends on, which is a larger and riskier
//     change than the one Stage 8B is for.
//   * `where('conversationId', '==', id)` is a single-field equality filter, so --
//     like every other query in this codebase -- it needs no composite index.
//
// The cost of the flat shape is that a conversation's messages are not deleted with
// it and cannot be listed without naming the conversation. Neither matters in v1:
// nothing deletes a conversation (see the note on the absence of a delete function
// below), and every read that wants messages knows which conversation it wants.
//
// Every query here is a single-field `==` filter, so no composite index is required
// -- the same reason applications and tasks can be listed by employee or job without
// one. Two queries rather than one for the inbox, because a conversation is reachable
// by two different owners of the truth: the employer who posted the job and the
// applicant it was sent to. Firestore has no OR operator, so the caller is found by
// the union of the two, which conversationService performs.
//
// No transactions and no batches. A message send is one add plus one field-level
// update, and conversationService documents -- rather than papers over -- the window
// between those two writes. Stage 8B does not require a transaction, and introducing
// one would change write ordering that no existing behaviour depends on.

const { db } = require('../config/firebase');

/**
 * Creates the conversation document for an application under a DETERMINISTIC id.
 *
 * The document id is the application id. That single decision is what makes
 * conversation creation idempotent without a query, a lock, or a transaction: there
 * is exactly one possible document per application, so a second call cannot produce
 * a second conversation even if two callers race.
 *
 * This is a deliberate departure from the four sibling resources. `tasks`,
 * `interviews`, `employments` and applications all use `.add()` and therefore accept
 * a Firestore-generated id, which is why Stage 7H had to add an existence query to
 * stop a second employment being created for one application. A conversation cannot
 * use that remedy, because a conversation is not something a caller is ever meant to
 * create twice -- "the conversation for this application" is a fact, not an event --
 * so the id is derived instead of generated and the duplicate is unrepresentable.
 *
 * `.set()` rather than `.add()`, matching jobRepository.createJob: there is no
 * `add` on a document reference. It is a non-merge `set`, so the caller owns the
 * payload in whole -- but conversationService only calls it when no conversation
 * exists yet, so in practice it never overwrites an established conversation's
 * `createdAt`.
 *
 * Returns the conversation id, which is the application id it was given.
 */
const createConversation = async (applicationId, data) => {
  await db.collection('conversations').doc(applicationId).set(data);
  return applicationId;
};

/**
 * Reads one conversation document.
 *
 * Returns the raw snapshot -- including `exists` and `id` -- so the caller decides
 * what a missing document means. No NotFound error is raised here. Used by the
 * service's existence checks, by the idempotency read in createOrGetConversation,
 * and by middleware/auth.js's requireConversationParty.
 */
const getConversationById = (conversationId) =>
  db.collection('conversations').doc(conversationId).get();

/**
 * Every conversation the given employer is party to.
 *
 * Single-field equality filter on `employerId`, mirroring
 * employmentRepository.listEmploymentsByEmployer. One of the two halves of the
 * caller's inbox; conversationService unions it with the employee half because
 * Firestore cannot express `employerId == uid || employeeId == uid` in one query.
 */
const listConversationsByEmployer = (employerId) =>
  db.collection('conversations').where('employerId', '==', employerId).get();

/**
 * Every conversation the given employee is party to.
 *
 * Single-field equality filter on `employeeId`, mirroring
 * employmentRepository.listEmploymentsByEmployee. The other half of the inbox.
 */
const listConversationsByEmployee = (employeeId) =>
  db.collection('conversations').where('employeeId', '==', employeeId).get();

/**
 * Creates a message document under a Firestore-generated id and returns that id.
 *
 * A plain `.add()`, matching taskRepository.addTask, interviewRepository.addInterview
 * and employmentRepository.addEmployment. A deterministic id is deliberately NOT
 * used here even though the conversation's id is: unlike "the conversation for this
 * application", "a message in this conversation" is genuinely a repeated event, and
 * two people may legitimately send identical text at the same moment. Generated ids
 * are what keep those two messages distinct.
 *
 * The caller owns the payload in whole, including the `createdAt` serverTimestamp()
 * -- the timestamp is domain behaviour, not persistence, so it is built in the
 * service.
 */
const addMessage = async (data) => {
  const messageRef = await db.collection('messages').add(data);
  return messageRef.id;
};

/**
 * Every message in one conversation.
 *
 * Single-field equality filter on `conversationId`. This is the only query the
 * message list needs, and it is the reason messages are a top-level collection: the
 * same filter would be impossible to express against a subcollection without
 * descending into it, which the flat test double cannot model (see the note at the
 * top of this file).
 *
 * Returned UNORDERED, and deliberately so. Ordering is done by conversationService
 * rather than by an `orderBy` on the query, for two reasons: the fake Firestore in
 * testing/ throws on `orderBy()` rather than modelling it, and a chat thread whose
 * messages can arrive out of order is a broken thread rather than a rough edge. See
 * the sort note in conversationService.listMessages.
 */
const listMessagesByConversation = (conversationId) =>
  db.collection('messages').where('conversationId', '==', conversationId).get();

/**
 * Applies a pre-built field-level patch to one conversation.
 *
 * A plain `.update()`, not a `set`, for the reason interviewRepository's
 * updateInterviewFields uses one: fields absent from the patch are left alone.
 *
 * Its callers are the two denormalised fields this document carries, and nothing else:
 *   * `lastMessageAt`, stamped by sendMessage on a successful send, so the Stage 8C
 *     inbox can be ordered without a second round trip.
 *   * `employerLastReadAt` / `employeeLastReadAt`, stamped by Stage 10B's
 *     markConversationRead for one participant only.
 *
 * Both are single top-level field names rather than dotted paths into a nested map, and
 * that is deliberate on two counts. It keeps this layer free of any knowledge of WHICH
 * marker field a caller means -- the service decides that -- and, because `.update()`
 * only touches the fields it is given, it means the two participants writing their own
 * markers concurrently cannot overwrite each other. A nested `readAt: { uid: ... }` map
 * would have needed a read-modify-write here (losing one side's update on a race) or a
 * dotted-path update, which the flat test double in testing/ does not model and would
 * therefore have been tested against behaviour production does not have.
 *
 * It is NOT a general conversation edit: no route exposes a patch of the caller's
 * choosing, the service decides what goes in it, and there is deliberately no way to
 * change a conversation's participants after it exists (see the absence of any
 * participant-update function here).
 *
 * No existence read is performed here; it throws NOT_FOUND on a missing document,
 * exactly as the real SDK does. The service's existence check runs first, so that is a
 * backstop rather than the 404 path clients see.
 */
const updateConversationFields = (conversationId, patch) =>
  db.collection('conversations').doc(conversationId).update(patch);

// There is deliberately NO delete function. A conversation outlives the application
// it is anchored to -- see the retention note on createOrGetConversation -- and
// nothing in Stage 8B removes one, so exposing a delete would be an unaudited way
// to destroy a message history. Removal, if the product ever asks for it, needs its
// own stage and its own decision about the messages.

module.exports = {
  createConversation,
  getConversationById,
  listConversationsByEmployer,
  listConversationsByEmployee,
  addMessage,
  listMessagesByConversation,
  updateConversationFields,
};