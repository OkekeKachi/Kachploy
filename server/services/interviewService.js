// interviewService.js
//
// Business and data layer for the interviews resource (new in Stage 7C). An
// interview belongs to an application: it records that the employer who posted the
// job has arranged to speak to the applicant, when, and in what form.
//
// WHAT EXISTS HERE
//   * createInterview -- the create, reachable from POST /interviews
//   * updateInterview -- the partial update behind PUT /interviews/:interviewId,
//     which is how every status change (completed / cancelled / no_show) is made
//   * respondToInterview -- the applicant's accept/decline behind
//     PUT /interviews/:interviewId/response (Stage 10A)
//   * listInterviewsForJob / listInterviewsForApplication -- the two reads
//
// WHAT DELIBERATELY DOES NOT EXIST YET
//   * No application status change. Stage 7C adds no `interviewing` / `interviewed`
//     application status and does not touch APPLICATION_STATUSES, so scheduling an
//     interview leaves the application exactly as pending as it was. The
//     recruitment lifecycle is not modelled on the application in this stage; the
//     interview is a separate fact about the application, not a new state of it.
//     STAGE 10A keeps that: an applicant's answer to an interview is a fact about
//     the interview, and answering it writes no application status either. Accepting
//     an interview is not being hired, and declining one is not being rejected.
//   * No employment. An interview never creates an Employment record. Employment
//     remains created in exactly one place -- the hire, i.e.
//     applicationService.updateApplicationStatus with `accepted` -- so no matter how
//     many interviews happen, an employment appears only when the applicant is
//     actually hired. Nothing in this file imports employmentService, and the
//     interview write path does not touch the applications collection at all.
//   * No video, chat, notifications or calendar integration. `meetingLink` and
//     `location` are stored strings; nothing generates, validates against a
//     provider, or acts on them. scheduledAt is a stored instant; nothing writes it
//     to a calendar.
//   * No transaction, because Stage 7C does not permit one. Create is one add and
//     update is one field-level update, so there is no multi-write step to make
//     atomic. (The one place where a transaction would eventually be wanted --
//     the hire, whose application-status write and employment add can still diverge
//     -- is Stage 7A's documented, unchanged gap.)
//
// AUTHORIZATION: as with employmentService, the service performs no ownership check
// of its own. The Stage 7C guards in middleware/auth.js -- plus Stage 10A's
// requireInterviewRespondent -- answer "may this caller do this?" before any function
// here runs; this file answers "is this data valid?". Keeping the two apart is what
// lets the same createInterview be reached from a route today and from a future
// orchestration without re-deciding identity.

const { admin } = require('../config/firebase');
const applicationRepository = require('../repositories/applicationRepository');
const interviewRepository = require('../repositories/interviewRepository');

/**
 * The interview does not describe a real arrangement. Surfaces as a 400.
 *
 * Exists so the controller can tell "you asked for something impossible" from an
 * unexpected Firestore failure, exactly as JobValidationError,
 * ApplicationValidationError, TaskValidationError and EmploymentValidationError do.
 */
class InterviewValidationError extends Error {}

/**
 * The referenced interview does not exist. Surfaces as a 404.
 *
 * In practice the router's requireInterviewOwner guard turns a missing interview
 * into a 404 before this class is reached, the same way requireApplicationOwner
 * pre-empts withdrawApplication's not-found path. The class and the existence check
 * stay because the service must be correct when called without that guard.
 */
class InterviewNotFoundError extends Error {}

/**
 * The canonical interview types.
 *
 * `online` implies a remote meeting and `in_person` a physical one. This is a value
 * allow-list, checked on create and on update for the same reason Stage 5G checked
 * application statuses: without it `jobService` once stored whatever string a client
 * sent, and nothing read it. There is deliberately no third type and no free-text
 * "other" -- the two above are the whole product decision.
 *
 * Neither is validated against its own companion field. `in_person` may be created
 * with no `location` and `online` with no `meetingLink`, because both are optional
 * in this stage's schema and the employer may legitimately supply the detail later
 * through updateInterview. Recording the gap here rather than enforcing a rule the
 * product has not asked for; see the schema note in the report.
 */
const INTERVIEW_TYPES = ['online', 'in_person'];

/**
 * The canonical interview statuses.
 *
 * `scheduled` is the only value a create writes. `completed`, `cancelled` and
 * `no_show` are reached only through updateInterview.
 *
 * An allow-list, NOT a transition matrix -- deliberately, and for the same reason
 * APPLICATION_STATUSES is one (Stage 5G): this stage specifies which values exist,
 * not which order they may occur in. So an employer may complete an interview and
 * then mark it cancelled, or mark it a no-show and then complete it, and may write
 * the same value repeatedly. Encoding a legal-order table here would invent product
 * policy that was not specified, and would make a genuine correction (a no-show
 * recorded against the wrong person) impossible without a separate repair path.
 * Whether an interview's lifecycle should become a transition matrix is a decision
 * for the stage that gives the domain a UI, not this one.
 *
 * `no_show` is the employer's judgement about the applicant and, like the other
 * three, only the employer who owns the job may write it. Nothing in this stage
 * writes anything about the outcome to the applicant beyond the status they can
 * already read for themselves.
 */
const INTERVIEW_STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'];

/** The status every interview is created with. The client cannot supply one. */
const SCHEDULED_INTERVIEW_STATUS = 'scheduled';

/**
 * STAGE 10A. The two answers an applicant may give to an interview.
 *
 * An allow-list, for the same reason INTERVIEW_TYPES and INTERVIEW_STATUSES are
 * allow-lists: without one, `interviewService` stores whatever string a client sent
 * and nothing reads it. `pending` is deliberately NOT in this list -- it is what an
 * unanswered interview *means*, not a value anybody writes. The field is simply absent
 * from the document until an answer is given, exactly as the optional fields on create
 * are, so "has not answered" is represented by the absence of the key rather than by a
 * third value. The clients derive the `pending` label from that absence.
 *
 * `accepted` and `declined` describe the applicant's answer to the invitation only. They
 * are deliberately NOT application statuses: an applicant who accepts an interview has
 * not been hired, and one who declines has not been rejected. Nothing in this file
 * writes to the applications collection.
 */
const INTERVIEW_RESPONSES = ['accepted', 'declined'];

/**
 * STAGE 10A. The statuses an interview may still be answered in.
 *
 * `scheduled` is the only one, which is the whole actionability rule. An interview the
 * employer has already completed, cancelled or marked a no-show is a finished fact
 * about a conversation that did or did not happen, and re-recording an answer onto it
 * would contradict the record rather than update it.
 *
 * This is a *narrowing* of INTERVIEW_STATUSES, and it is deliberately narrower than
 * that list is checked. INTERVIEW_STATUSES says which values may be written; it is an
 * allow-list and not a transition matrix, so an employer may legally write `scheduled`
 * back onto a completed interview as a correction. An applicant's answer does not get
 * the same freedom, because an answer is about the applicant's own availability for a
 * meeting: letting them answer an interview the employer has already cancelled would
 * store "accepted" against something that is not going to happen. Correcting that is
 * the employer's existing status control, exactly as it was before this field existed.
 *
 * Note this is a *status* rule and not a response rule: it says nothing about whether
 * the interview is still in the future. Whether to answer is recorded here as the
 * employer left it, so `scheduled` is answerable even if the time has passed -- the
 * same reasoning isScheduledInstant records for not holding an interview to a client
 * clock.
 */
const RESPONDABLE_INTERVIEW_STATUSES = ['scheduled'];

/**
 * The fields an employer may change after creation.
 *
 * An allow-list, not a denylist, so a new field cannot become writable by accident
 * when someone adds it to the document shape later. It is the interview analogue of
 * userService's ALLOWED_PROFILE_FIELDS (Stage 5C), which drops unknown keys the same
 * way rather than rejecting them.
 *
 * `status` is in this list, which is what makes one update endpoint serve the
 * complete/cancel/no-show cases the stage requires instead of three more routes.
 *
 * Deliberately ABSENT, because these identify the interview and must never change
 * after it exists: `applicationId`, `jobId`, `employerId`, `employeeId`,
 * `createdAt`. Moving an interview to a different application or job would silently
 * re-point it at a different employer and a different applicant, and there is no
 * route that can do that. `updatedAt` is absent too -- it is server-owned, so a
 * client value is ignored rather than written, and the service always sets it.
 *
 * `response` is absent as well, and that is NOT an oversight to be tidied away by a
 * later reader: it is a writable field that belongs to the other write path.
 * respondToInterview writes it for the applicant through its own route and guard, and
 * adding it here would let the employer answer on the applicant's behalf as well. Its
 * own comment explains the separation in full.
 */
const UPDATABLE_INTERVIEW_FIELDS = [
    'scheduledAt',
    'duration',
    'type',
    'meetingLink',
    'location',
    'status',
];

/**
 * The required create fields, checked before anything is read or written.
 *
 * `applicationId` and `jobId` identify what the interview is for; `scheduledAt` and
 * `type` are the two facts that make it an interview at all. `duration`,
 * `meetingLink` and `location` are optional by this stage's schema.
 *
 * `employeeId` and `employerId` are NOT here, and that is the point: they are never
 * accepted from the request. The applicant is read from the application document
 * and the employer from the verified token, so a body field of either name cannot
 * put the wrong person in the record.
 */
const REQUIRED_CREATE_FIELDS = ['applicationId', 'jobId', 'scheduledAt', 'type'];

/**
 * True for a value that can be stored as the moment an interview happens.
 *
 * A parseable, non-blank string is the normal case -- `<input type="datetime-local">`
 * in a client form yields a string, and ViewJobApplications.jsx already sends
 * `new Date().toISOString()` as a task dueDate. A `Date` is accepted for a caller
 * holding one programmatically; Firestore converts it to a Timestamp on write, in
 * the fake and in production alike.
 *
 * A bare number is deliberately REJECTED. An epoch number would be a third stored
 * type for the same field with no way to tell it from a duration, and no caller in
 * this codebase has one to send.
 *
 * Nothing here checks that the instant is in the future. Rescheduling an interview
 * into the past is how a correction gets made, and a client clock is not a
 * trustworthy thing to hold an interview hostage to.
 */
const isScheduledInstant = (value) => {
    if (value instanceof Date) return !Number.isNaN(value.getTime());
    if (typeof value === 'string') return value.trim() !== '' && !Number.isNaN(Date.parse(value));
    return false;
};

/**
 * True for a duration this service will store.
 *
 * Minutes, as a positive finite number. A numeric string is rejected rather than
 * coerced: this codebase already has a recorded defect where `price` is stored as a
 * string on create and a number on edit (ENDPOINTS.md, "Types"), and silently
 * normalising here would plant the same inconsistency in a new field. Rejecting with
 * a clear message is the cheaper mistake.
 */
const isValidDuration = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Optional free-text detail: a non-empty string, or null to clear it.
 *
 * `null` is accepted rather than rejected so an employer can remove a meeting link
 * or a location they previously supplied, by sending an explicit JSON null. JSON
 * cannot express `undefined`, so `null` is unambiguous here -- there is no way for
 * a client to send "absent" and have it read as "clear it".
 */
const isValidOptionalText = (value) => value === null || (typeof value === 'string' && value.trim() !== '');

/**
 * Validates one optional field and returns the value to store, or throws.
 *
 * Shared by create and update so a field means the same thing on both paths -- the
 * alternative, a copy per path, is exactly how two endpoints drift into accepting
 * different values for one field.
 */
const resolveOptionalField = (field, value) => {
    switch (field) {
        case 'scheduledAt':
            if (!isScheduledInstant(value)) {
                throw new InterviewValidationError('Invalid scheduledAt. It must be a parseable date or time string.');
            }
            return value;
        case 'duration':
            if (!isValidDuration(value)) {
                throw new InterviewValidationError('Invalid duration. It must be a positive number of minutes.');
            }
            return value;
        case 'type':
            if (!INTERVIEW_TYPES.includes(value)) {
                throw new InterviewValidationError(`Invalid type. Must be one of: ${INTERVIEW_TYPES.join(', ')}.`);
            }
            return value;
        case 'status':
            if (!INTERVIEW_STATUSES.includes(value)) {
                throw new InterviewValidationError(`Invalid status. Must be one of: ${INTERVIEW_STATUSES.join(', ')}.`);
            }
            return value;
        case 'meetingLink':
        case 'location':
            if (!isValidOptionalText(value)) {
                throw new InterviewValidationError(`Invalid ${field}. It must be a non-empty string or null.`);
            }
            return value;
        default:
            return undefined;
    }
};

/**
 * Creates an interview for an application.
 *
 * AUTHORIZATION: performed by the router's requireInterviewAuthor guard, which has
 * already established that the caller posted the job the application belongs to. It
 * also handles existence, so the 404s below are a backstop for a call made without
 * that guard rather than the path clients see.
 *
 * The employer is always passed in from the verified token by the controller and the
 * applicant is always read from the application document, so neither can be
 * redirected by the request body.
 *
 * The application is read HERE rather than taken from the guard's `req.application`,
 * which is the arrangement withdrawApplication already uses: the guard's read exists
 * to answer "may this caller?", and the service's read exists to answer "does this
 * application exist, and whose is it?". Collapsing the two would make the service
 * unusable without a populated request object, and would let a future non-HTTP caller
 * pass an applicant it had not verified. The cost is one extra read of a single
 * document on the create path, which is the same cost every other service here pays.
 *
 * REQUIRESMENT 9 -- an application belonging to a different job is refused. The body
 * must name the application and the job; if they disagree, the interview is refused
 * rather than stored, because a document whose `applicationId` and `jobId` point at
 * two different employers is unreadable by either side's own rules: the applicant
 * would see it only through the application query and the employer only through the
 * job query, and neither view would be complete. This is a 400 (bad data), not a
 * 403: the caller is the owner of BOTH documents in this branch, so nothing is being
 * withheld from them, the request is simply incoherent.
 *
 * Returns `{ interviewId }`, matching taskService.createTask's `{ taskId }` so the
 * controller has an id to hand back.
 */
const createInterview = async (payload, employerId) => {
    const { applicationId, jobId } = payload;

    if (!employerId) {
        throw new InterviewValidationError('Missing required fields');
    }

    for (const field of REQUIRED_CREATE_FIELDS) {
        if (!payload[field]) {
            throw new InterviewValidationError('Missing required fields');
        }
    }

    const appSnapshot = await applicationRepository.getApplicationById(applicationId);
    if (!appSnapshot.exists) {
        throw new InterviewNotFoundError('Application not found');
    }

    const application = appSnapshot.data();

    if (application.jobId !== jobId) {
        throw new InterviewValidationError(
            'Interview jobId does not match the application\'s jobId'
        );
    }

    const document = {
        applicationId,
        jobId,
        employerId,
        // The applicant comes from the application, never from the request. A body
        // `employeeId` is ignored rather than rejected, matching how applyToJob
        // silently discards an employeeId in the apply body.
        employeeId: application.employeeId,
        status: SCHEDULED_INTERVIEW_STATUS,
        // STAGE 7C. serverTimestamp(), not `new Date()`: the value is committed by
        // Firestore, so it cannot be skewed by a drifting host clock. This is the same
        // choice Stage 5H made for users.createdAt, tasks.createdDate and
        // applications.dateApplied, and it is what jobService still does NOT do for
        // its own createdAt/updatedAt.
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    for (const field of ['scheduledAt', 'duration', 'type', 'meetingLink', 'location']) {
        // An absent optional field is simply not written, rather than written as
        // null. Firestore has no `undefined`, so this is what keeps the stored
        // document free of keys that were never supplied.
        if (payload[field] !== undefined) {
            document[field] = resolveOptionalField(field, payload[field]);
        }
    }

    const interviewId = await interviewRepository.addInterview(document);

    return { interviewId };
};

/**
 * Applies a partial update to one interview: reschedule it, correct a detail, or
 * move it to another status.
 *
 * AUTHORIZATION: the router's requireInterviewOwner guard has already established
 * that the caller posted the job the interview belongs to. Only the employer who
 * owns that job reaches this function -- an applicant is refused at the guard with
 * a 403 and never gets here, so there is no read-then-write path in which an
 * applicant could change an interview they are party to.
 *
 * A partial update rather than a replace: fields absent from `payload` are left
 * exactly as stored, which is what lets one endpoint serve a status change and a
 * reschedule without the service first reading the document back and merging it.
 * The fields that can be changed are UPDATABLE_INTERVIEW_FIELDS; anything else in
 * the body -- `employeeId`, `jobId`, `applicationId`, `employerId`, `createdAt` and
 * any other unknown key -- is dropped without comment, the same behaviour
 * userService's profile update has.
 *
 * A field that IS in the allow-list and IS present is validated, so `status: null`
 * and `type: null` are rejected by their allow-lists rather than silently clearing a
 * field the document is not meant to lose. Only the three genuinely optional details
 * (`duration`, `meetingLink`, `location`) accept null, and for them null means
 * "clear this".
 *
 * `updatedAt` is always rewritten, even when the only thing that changed was a
 * detail: an update that changed nothing detectable would otherwise leave a stale
 * timestamp and no trace. `createdAt` is never touched.
 *
 * An update with no updatable field at all is a 400 rather than a silent success,
 * matching updateApplicationStatus's 'Status is required' -- an empty PUT that
 * reports success is indistinguishable from a lost request.
 *
 * Returns nothing. The controller answers with a message, as
 * applicationController.updateApplicationStatus and jobController.updateJobStatus
 * do; no existing endpoint in this API returns the updated document.
 */
const updateInterview = async (interviewId, payload) => {
    const interviewSnapshot = await interviewRepository.getInterviewById(interviewId);
    if (!interviewSnapshot.exists) {
        throw new InterviewNotFoundError('Interview not found');
    }

    const patch = {};

    for (const field of UPDATABLE_INTERVIEW_FIELDS) {
        if (payload[field] === undefined) continue;
        patch[field] = resolveOptionalField(field, payload[field]);
    }

    if (Object.keys(patch).length === 0) {
        throw new InterviewValidationError('Missing fields to update');
    }

    patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await interviewRepository.updateInterviewFields(interviewId, patch);
};

/**
 * STAGE 10A. Records the applicant's answer to one interview: `accepted` or
 * `declined`. Reachable from PUT /interviews/:interviewId/response.
 *
 * WHY THIS IS NOT updateInterview WITH response ADDED TO THE ALLOW-LIST
 *   Two reasons, and the first is the important one.
 *
 *   1. The two writes have opposite authors. updateInterview is the employer's, and
 *      requireInterviewOwner admits nobody else -- it is deliberately a
 *      single-authority guard whose Stage 7C comment records that "there is
 *      deliberately no applicant path". Putting `response` in UPDATABLE_INTERVIEW_FIELDS
 *      would either hand applicants the whole update (reschedule, cancel, complete, and
 *      mark a no-show about themselves) or require a guard that admits two different
 *      bodies on one route, which is the ambiguity a separate route removes outright.
 *      The response gets its own route, its own guard and its own allow-list of exactly
 *      one writable field, so neither write can reach the other's fields.
 *   2. The actionability rule below applies to this write only. Making an interview's
 *      status non-scheduled stops the applicant answering it; it must not stop the
 *      employer recording a correction to it, which is what the shared allow-list
 *      would have done.
 *
 * AUTHORIZATION: performed by the router's requireInterviewRespondent guard, which has
 * already established that the caller is the employee on the interview's application.
 * That guard decides identity; this function decides whether the interview can still
 * be answered. The applicant's uid is passed in from the verified token by the
 * controller and is never read from the body, so a caller cannot answer somebody
 * else's interview by naming them -- they are refused at the guard, before this runs.
 *
 * The interview is read HERE rather than taken from the guard's `req.interview`, for
 * the same reason createInterview re-reads the application: the guard's read answers
 * "may this caller?" and this one answers "what is the current status?". The service
 * must stay correct when called without a populated request object.
 *
 * NO OVERWRITE PROTECTION. An interview that is still `scheduled` may be answered
 * again, so an applicant who accepts and then changes their mind can decline, and back
 * again, with no second endpoint and no way to be stranded on an answer they did not
 * mean. This is why RESPONDABLE_INTERVIEW_STATUSES is a status rule and not a
 * "has already answered" rule: once the employer has completed, cancelled or marked the
 * interview a no-show, the answer stops being writable, because at that point the
 * record of what happened is the employer's to correct and no longer a question about
 * the applicant's availability.
 *
 * `updatedAt` is rewritten, as on every other write in this file, so an answer is
 * visible in the document's own history. `createdAt` and every identifying field are
 * untouched, and no other field is in the patch -- the write is one field plus a
 * timestamp, which is why no transaction is needed here either.
 *
 * Returns nothing. The controller answers with a message, like every other write in
 * this API, and the client re-reads the interviews -- which it must do anyway to show
 * the answer it just gave.
 */
const respondToInterview = async (interviewId, employeeId, payload) => {
    if (!employeeId) {
        throw new InterviewValidationError('Missing required fields');
    }

    if (!INTERVIEW_RESPONSES.includes(payload.response)) {
        throw new InterviewValidationError(
            `Invalid response. Must be one of: ${INTERVIEW_RESPONSES.join(', ')}.`
        );
    }

    const interviewSnapshot = await interviewRepository.getInterviewById(interviewId);
    if (!interviewSnapshot.exists) {
        throw new InterviewNotFoundError('Interview not found');
    }

    // A 400 rather than a 403: the guard has already established this caller IS the
    // applicant on this interview, so nothing is being withheld from them. They are
    // asking to change something that is no longer changeable, which is the same
    // distinction createInterview makes for a jobId that disagrees with its application.
    if (!RESPONDABLE_INTERVIEW_STATUSES.includes(interviewSnapshot.data().status)) {
        throw new InterviewValidationError(
            `This interview can no longer be answered. Its status is: ${interviewSnapshot.data().status}.`
        );
    }

    await interviewRepository.updateInterviewFields(interviewId, {
        response: payload.response,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
};

/**
 * Flattens a QuerySnapshot into `{ id, ...data }` objects.
 *
 * The same shape every list in this codebase produces (employments, tasks,
 * applications): the document id is added and no field is renamed, dropped or
 * reshaped, so a caller reads back the stored document byte for byte.
 */
const toPlainObjects = (snapshot) => {
    const interviews = [];

    snapshot.forEach((doc) => {
        interviews.push({ id: doc.id, ...doc.data() });
    });

    return interviews;
};

/**
 * Every interview held for one job, as plain objects.
 *
 * AUTHORIZATION: the employer is established by the existing requireJobOwner guard
 * before the service runs, so a non-owner never reaches this query -- it is turned
 * away with a 403, or a 404 if the job does not exist, before the query is issued.
 *
 * The employer's view of one job's recruitment: it spans every applicant for that
 * job, which is why it is a job query and not an application one.
 *
 * An existing job with no interviews yet returns [] rather than a 404: a missing
 * *interview* is not a missing resource.
 *
 * There is deliberately no join to `jobs` or `applications` here. Every field needed
 * to render or act on an interview -- including both ids and both parties' uids --
 * is on the document itself, so a per-record read of another collection would repeat
 * the N+1 pattern Stage 4 documented in listApplicationsForEmployee for nothing.
 */
const listInterviewsForJob = async (jobId) => {
    const snapshot = await interviewRepository.listInterviewsByJob(jobId);

    return toPlainObjects(snapshot);
};

/**
 * Every interview belonging to one application, as plain objects.
 *
 * The applicant's view of their own recruitment, and also available to the employer
 * who owns the application -- a shared read, because both are parties to the same
 * fact. requireInterviewParty is the guard that admits them: it allows the
 * application's own employee OR the owner of its job, and refuses everyone else with
 * a 403 before the query runs.
 *
 * Same `{ id, ...data }` shape and the same "empty list, not 404" rule as
 * listInterviewsForJob. An application exists but has had no interview arranged yet,
 * so this returns [].
 */
const listInterviewsForApplication = async (applicationId) => {
    const snapshot = await interviewRepository.listInterviewsByApplication(applicationId);

    return toPlainObjects(snapshot);
};

module.exports = {
    InterviewValidationError,
    InterviewNotFoundError,
    INTERVIEW_TYPES,
    INTERVIEW_STATUSES,
    INTERVIEW_RESPONSES,
    RESPONDABLE_INTERVIEW_STATUSES,
    SCHEDULED_INTERVIEW_STATUS,
    UPDATABLE_INTERVIEW_FIELDS,
    REQUIRED_CREATE_FIELDS,
    createInterview,
    updateInterview,
    respondToInterview,
    listInterviewsForJob,
    listInterviewsForApplication,
};