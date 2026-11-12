// taskService.js
//
// Business and data layer for the tasks resource (new in Stage 3C). It owns
// the required-field validation and the task payload construction that used to
// live inline in controllers/taskController.js.
//
// Stage 3C is a structural extraction only. The controller is now HTTP-focused:
// it reads the request, calls exactly one service function, and translates the
// outcome into the status code and body this API has always returned. Nothing
// observable changes, so the quirks below are preserved deliberately and stay
// pinned by test/tasks.test.js:
//
//   * `createdDate` used to be a raw Date read off the process clock, unlike the
//     serverTimestamp() users write. Stage 5H moved it onto serverTimestamp(), so
//     this quirk is gone; jobs still store ISO strings, which is tracked separately
//   * the endpoint is a create-only resource: there is no read, update or
//     delete for tasks anywhere in the API
//   * `employeeId` is taken from the request body rather than the token
//
// Stage 4C moved the one Firestore write out to repositories/taskRepository.js.
// The document shape, the timestamp and the `{ taskId }` return value all stay
// here, so the service still decides what is stored and what the caller sees.
//
// STAGE 9B adds three fields to the stored document -- `status`, `applicationId`
// and `employmentId` -- and changes no behaviour: no transition, no update, no new
// endpoint. The document is built by buildTaskDocument; Stage 3E adds the hire
// transaction as a second caller alongside createTask. The two reads gained one
// derived value, `status`, defaulted to `assigned` for documents written before this
// stage without rewriting them.
//
// STAGE 10G adds `submissionType` to the stored document and three fields to the
// submission side -- `submissionText`, `submissionUrl`, `submissionFile` -- for
// employer-chosen submission types `text`, `link` and `file`. The lifecycle is
// untouched: same four statuses, same transition table, same authorization. What
// changes is that a submission's PAYLOAD is now decided by the task's stored type
// rather than always being one free-text field:
//
//   * `submissionType` is required on create, so no new task can be ambiguous.
//   * A task stored before this stage has no `submissionType` and is read as `text`,
//     which is what it was: submitTask's only accepted payload was written text.
//     No migration, no backfill, no rewrite-on-read.
//   * A submission writes ONLY the field its type names. Nothing is written to the
//     other two, so `submissionUrl` on a task is proof the task was a link task.
//
// `submittedBody` is NOT written by anything in this file any more, and is NOT
// deleted: it stays the field every pre-10G submission lives in, and both readers
// fall back to it. Renaming it is what would break legacy tasks; leaving it on new
// writes is what would put two fields describing one submission on the document.
//
// WHAT THE BACKEND CANNOT DO. This service validates the reference a client sends for
// a `file` submission -- that it is an object, that its url is a Cloudinary raw-upload
// url, that its publicId names the task's own folder. It cannot verify that the asset
// exists or holds the bytes the client claims: the upload still goes from the
// employee's browser straight to the storage provider, and this API never sees it.
// What STAGE 10G.1 changed is that the browser cannot choose WHERE it uploads: that
// folder is signed by this server (signTaskSubmissionUpload) and Cloudinary rejects a
// signature that does not match the parameters it was given. The checks here are about
// not storing a reference that points at another task, or at something that is not a
// task upload at all.
//
// No shared error system is introduced: the single error class below exists only
// so the controller can reproduce the existing 400 body.

const crypto = require('crypto');
const { admin } = require('../config/firebase');
// STAGE 10G.1: signing a direct-to-Cloudinary upload. Required here rather than in
// the controller so that the folder a signature is minted for and the folder
// buildFileSubmission validates against come from the same function below -- one
// rule for where a task's files live, on both sides of the upload.
const { signUploadRequest, qualifyFolder } = require('../config/cloudinary');
const taskRepository = require('../repositories/taskRepository');
const taskEventRepository = require('../repositories/taskEventRepository');
const adminReviewRepository = require('../repositories/adminReviewRepository');
const contractRepository = require('../repositories/contractRepository');
const paymentRepository = require('../repositories/paymentRepository');
const clock = require('../config/clock');
const {
    TaskTransitionError,
    ASSIGNED_TASK_STATUS,
    TASK_STATUSES,
    REVIEW_WINDOW_DAYS,
    REVIEW_WINDOW_MS,
    resolveTransition,
    toMillis,
    deadlinePassed,
    taskStatus,
    submissionSnapshot,
} = require('./taskReviewState');

/**
 * A required field is missing. Surfaces as a 400 carrying this exact message,
 * which is why the wording lives on the throw site -- the service has no other
 * validation message, and the 400 text is asserted by the tests.
 */
class TaskValidationError extends Error {}

/**
 * No task with that id. Surfaces as a 404.
 *
 * STAGE 9C. Separate from TaskValidationError so the controller can map the two to
 * different status codes, which is how applicationService already separates its
 * ApplicationValidationError from its ApplicationNotFoundError. In practice the
 * guard turns a missing task into the 404 before a service call is made; this class
 * exists so a direct service caller gets the same answer rather than a bare Error
 * that the controller would report as a 500.
 */
class TaskNotFoundError extends Error {}

/**
 * STAGE 1. The action is legal in principle but not yet in time -- currently only
 * an admin-review request before the seven-day window has elapsed. Surfaces as a
 * 409, like the dispute module's state errors: the caller may retry later, and
 * nothing about the request is malformed.
 */
class TaskDeadlineError extends Error {}

/**
 * STAGE 1. A concurrent request already claimed this resource (the per-submission
 * admin-review request id). Surfaces as a 409.
 */
class TaskReviewConflictError extends Error {}

/** The only persisted payment status that evidences a milestone was funded. */
const PAID_PAYMENT_STATUS = 'paid';

/**
 * STAGE 1. The review state machine lives in taskReviewState.js; the constants
 * and the resolver are re-exported below so existing callers and tests keep one
 * import. The transition table itself is deliberately not restated here: the
 * dispute and admin paths use the same resolver, and a second copy is a second
 * place for the rules to drift.
 */

/**
 * STAGE 10G. The submission types an employer can choose when creating a task, and
 * the one a task without the field is treated as.
 *
 * The order is the order the client offers them in and the order the three payload
 * branches below are written in. `text` is the default and comes first because it is
 * both the legacy meaning and the one every existing task is read as.
 *
 * Declared above buildTaskDocument, which validates a create against it, and below
 * resolveTransition because it is a different state machine: a task's STATUS moves
 * through the transition table above, while its submissionType is fixed at creation
 * and never moves. Nothing in this file can change a task's type after the fact --
 * there is no update endpoint for a task at all.
 */
const SUBMISSION_TYPES = ['text', 'link', 'file'];

/**
 * STAGE 10G. What a task with no `submissionType` means.
 *
 * Every task stored before this stage is a `text` task: submitTask accepted exactly
 * one field, `submittedBody`, and refused anything else. Reading them as anything
 * else would either hide the submit control for every task already in the database
 * or, worse, invite a link submission that no legacy task could be said to have
 * asked for.
 *
 * This is a read-time default, exactly like `assigned` above: no migration is run
 * and no document is rewritten.
 */
const DEFAULT_SUBMISSION_TYPE = 'text';

/**
 * STAGE 10G. Resolves a task's submission type for a WRITE.
 *
 * A missing value reads as the default, for the reason on DEFAULT_SUBMISSION_TYPE.
 * An unrecognised value is REFUSED rather than coerced, which is the same
 * fail-closed decision resolveTransition makes for an unknown status and for the same
 * reason: a value this API never wrote is either a document from a later stage or a
 * bug, and guessing `text` at it would let a submission through on the wrong rules.
 */
const resolveSubmissionType = (task) => {
    const stored = task && task.submissionType;

    if (stored == null) return DEFAULT_SUBMISSION_TYPE;

    if (typeof stored !== 'string' || !SUBMISSION_TYPES.includes(stored)) {
        throw new TaskValidationError(`Cannot submit a task with an unknown submissionType '${stored}'`);
    }

    return stored;
};

/**
 * STAGE 10G. Is this a URL this API is willing to store and hand to a browser?
 *
 * Both readers render a submitted link as an anchor, so `javascript:` and `data:`
 * are the inputs that matter: `new URL()` parses both happily, and only the protocol
 * check rejects them. http and https are the only two schemes accepted, so a
 * `mailto:` or `ftp:` submission is refused as firmly as `javascript:` -- neither is
 * a deliverable work link.
 *
 * `new URL()` also rejects a bare `not a url`, and an empty or whitespace-only string
 * never reaches it. Returns false for every non-string, so a caller does not have to
 * type-check first.
 */
const isValidHttpUrl = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return false;

    let parsed;

    try {
        parsed = new URL(value.trim());
    } catch {
        return false;
    }

    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
};

/**
 * STAGE 10G.1. The resource type a task submission file is uploaded as.
 *
 * `raw`, not `image`: a task's deliverable is an arbitrary file or document, and
 * Cloudinary stores `image`/`video`/`pdf` under transformations that assume a
 * renderable asset. `raw` is the storage class for everything else, and it is also
 * part of the delivery path -- `/raw/upload/` in the URL -- which buildFileSubmission
 * uses to confirm a submitted url really is one of these.
 *
 * Exported because the client must name the same resource type when it uploads, and
 * because the validation below refuses any other value: one constant, used to sign,
 * to upload and to check.
 */
const TASK_FILE_RESOURCE_TYPE = 'raw';

/**
 * STAGE 10G.1. The folder every file for one task is uploaded into.
 *
 * `taskSubmissions/{taskId}` -- the path Stage 10G wrote directly to Firebase Storage,
 * kept unchanged so the folder a signer is minted for and the folder a submitted
 * reference is checked against cannot drift apart: both are built from this one
 * function, and neither place spells the prefix out again.
 *
 * The task id is the authorization. An employee may hold a signature for their own
 * task's folder and for no other, because the signature covers this string -- which is
 * derived from the task the guard already confirmed the caller is party to, never
 * from anything the request supplied.
 */
const submissionFolder = (taskId) => qualifyFolder(`taskSubmissions/${taskId}`);

/**
 * STAGE 10G.1. Mints the signed payload the browser needs to upload one file for one
 * task, after the caller has established that the caller may submit it.
 *
 * Called from the controller behind requireTaskParty({ mutation: true, role:
 * 'employee' }) -- the SAME guard as POST /:taskId/submit, so a caller who cannot
 * submit the task cannot obtain a signature for it either. This function itself does
 * no authorization: it is handed the task the guard already loaded, which is what
 * keeps "who may sign" in one place instead of two.
 *
 * WHY THE PUBLIC ID IS MINTED HERE. The client sends no path, folder or id of its
 * own: the folder comes from submissionFolder(task.id) and the name under it is a
 * timestamp plus random bytes generated in this process. So there is nothing for a
 * client to supply that could point the upload at another task, another folder, or
 * another user's files -- the only variation it gets is the file bytes themselves.
 *
 * The random suffix is what keeps a resubmission after a revision from colliding with
 * the attempt it replaces. Stage 10G made the same point with a client-side timestamp;
 * moving the minting server-side keeps that property without trusting the client's
 * clock, and Cloudinary's default `overwrite: false` means a duplicate public id would
 * be refused rather than silently replacing the delivery the employer is reviewing.
 *
 * Returns exactly the six values the browser needs and no more: the cloud and key to
 * address, the timestamp and signature that make the request acceptable, the folder
 * and public id that were signed, and the resource type that selects the upload
 * endpoint. The api secret never leaves config/cloudinary.
 *
 * Throws CloudinaryConfigurationError when the environment is incomplete; the
 * controller turns that into a 503.
 */
const signTaskSubmissionUpload = (task) => {
    const folder = submissionFolder(task.id);
    const publicId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

    const signed = signUploadRequest({ folder, public_id: publicId });

    return {
        cloudName: signed.cloudName,
        apiKey: signed.apiKey,
        timestamp: signed.timestamp,
        signature: signed.signature,
        folder,
        publicId,
        resourceType: TASK_FILE_RESOURCE_TYPE,
    };
};

/**
 * STAGE 10G. Validates the file reference a `file` submission carries and returns
 * the four fields to store: `{ url, publicId, name, resourceType }`.
 *
 * THE SHAPE CHANGED IN STAGE 10G.1, from the Firebase Storage reference Stage 10G
 * wrote (`url`, `path`, `name`) to the Cloudinary one (`url`, `publicId`, `name`,
 * `resourceType`). The old shape is refused rather than read as a fallback: a
 * document holding a `path` was uploaded by code that no longer exists, so accepting
 * it would mean accepting a reference nothing in this deployment can have produced
 * since. Reads are unaffected -- `SubmittedWork` renders `url` and `name`, which both
 * shapes carry -- so only a new submission meets this check.
 *
 * THREE CHECKS, IN ORDER OF WHAT THEY ARE FOR:
 *
 *   1. `publicId` starts with `taskSubmissions/{taskId}/`. This is the authorization
 *      check and the only one that matters for it: an employee may deliver a file for
 *      task-1 and for nothing else, so a reference naming another task's folder is
 *      refused. The `..` test is what makes the prefix meaningful -- without it,
 *      `taskSubmissions/task-1/../task-2/x` starts with the expected prefix while
 *      naming a different task's folder, and `startsWith` alone would pass it.
 *
 *   2. `resourceType` is `raw` and the url carries `/raw/upload/`. These are one
 *      property stated twice: a reference that claims `raw` but points at an
 *      image-transform url (or the reverse) is a reference assembled by hand rather
 *      than returned by an upload.
 *
 *   3. The url contains the publicId. The url and the id arrive in one response from
 *      Cloudinary and travel together; checking that they agree means a submitted
 *      url cannot be swapped for some other asset's delivery url while keeping the
 *      publicId that passed check 1.
 *
 * This does NOT prove the asset exists, and does not claim to -- the bytes went from
 * the employee's browser to Cloudinary and never passed through here. What is new
 * since Stage 10G.1 is that the folder was signed by this server before the upload,
 * so an honest client cannot have uploaded anywhere else; what remains is a client
 * that submits a reference it never uploaded, which the checks above narrow to "a
 * well-formed url for a non-existent asset in this task's own folder".
 *
 * Trimmed for the emptiness tests and stored as trimmed, matching the link branch:
 * these are ids and urls, not someone's writing.
 */
const buildFileSubmission = (task, submissionFile) => {
    if (!submissionFile || typeof submissionFile !== 'object' || Array.isArray(submissionFile)) {
        throw new TaskValidationError('A file reference is required for this task');
    }

    const url = typeof submissionFile.url === 'string' ? submissionFile.url.trim() : '';
    const publicId = typeof submissionFile.publicId === 'string' ? submissionFile.publicId.trim() : '';
    const name = typeof submissionFile.name === 'string' ? submissionFile.name.trim() : '';
    const resourceType = typeof submissionFile.resourceType === 'string' ? submissionFile.resourceType.trim() : '';

    if (!url || !publicId || !name || !resourceType) {
        throw new TaskValidationError('A file reference must include url, publicId, name and resourceType');
    }

    if (!isValidHttpUrl(url)) {
        throw new TaskValidationError('A file reference url must be a valid http or https URL');
    }

    if (resourceType !== TASK_FILE_RESOURCE_TYPE) {
        throw new TaskValidationError(`A file reference resourceType must be ${TASK_FILE_RESOURCE_TYPE}`);
    }

    const expectedPrefix = `${submissionFolder(task.id)}/`;

    if (!publicId.startsWith(expectedPrefix) || publicId.length === expectedPrefix.length || publicId.includes('..')) {
        throw new TaskValidationError(`A file reference publicId must be under ${expectedPrefix}`);
    }

    if (!url.includes('/raw/upload/')) {
        throw new TaskValidationError('A file reference url must be a Cloudinary raw upload URL');
    }

    if (!url.includes(publicId)) {
        throw new TaskValidationError('A file reference url does not match its publicId');
    }

    return { url, publicId, name, resourceType };
};

/**
 * STAGE 10G. Turns a submission request into the fields that get written, for the
 * task's own submission type.
 *
 * THE TYPE IS AUTHORITATIVE, NOT THE PAYLOAD. The client does not say what it is
 * submitting; the stored `submissionType` says what the task accepts, and the body is
 * read against that alone. A text task given `submissionUrl` is refused for having no
 * text, and a link task given `submissionText` is refused for having no url -- not
 * because the extra field is illegal, but because the field the task asked for is
 * absent. Nothing here inspects or stores the other two fields, so one submission can
 * never land in two of them.
 *
 * `text` keeps the Stage 9C rule on emptiness: trimmed for the test, stored exactly
 * as supplied, because trimming what someone typed would edit their submission.
 */
const buildSubmission = (task, payload = {}, submittedAt = clock.now()) => {
    const type = resolveSubmissionType(task);

    if (type === 'link') {
        if (!isValidHttpUrl(payload.submissionUrl)) {
            throw new TaskValidationError('A valid http or https submissionUrl is required for this task');
        }

        return { submittedAt, submissionUrl: payload.submissionUrl.trim() };
    }

    if (type === 'file') {
        return { submittedAt, submissionFile: buildFileSubmission(task, payload.submissionFile) };
    }

    if (typeof payload.submissionText !== 'string' || payload.submissionText.trim() === '') {
        throw new TaskValidationError('Missing required fields');
    }

    return { submittedAt, submissionText: payload.submissionText };
};

const reviewEvent = ({
    task,
    action,
    next,
    actorId = null,
    actorRole = null,
    detail = null,
}) => ({
    taskId: task.id,
    type: action,
    actorId,
    actorRole,
    fromStatus: taskStatus(task),
    toStatus: next,
    detail,
});

/**
 * Shared body of the task transitions.
 *
 * STAGE 1 moves the status check INSIDE the write transaction. The Stage 9C
 * version read the document, decided, and then updated it, so two concurrent
 * requests could both observe `submitted` and both write -- a race the review
 * workflow makes reachable (approve vs dispute, two admins deciding one case).
 * `taskRepository.applyTaskTransition` now re-reads and re-checks on every
 * retry; `decide` is called there, not here.
 *
 * `fields` may still be a function of the task, because a submission is shaped by
 * the task's stored `submissionType`. It is called before `resolveTransition` so a
 * malformed body is still reported as a malformed body, preserving the Stage 10G
 * ordering.
 *
 * Every transition appends a `taskReviewEvents` row in the same transaction. The
 * event carries the from/to status, the actor and -- for a submission -- both the
 * new snapshot and the one it replaced, so a resubmission cannot erase what was
 * submitted before.
 */
const applyTransition = async (taskId, action, fields, {
    actorId = null,
    actorRole = null,
    detail = null,
} = {}) => {
    const now = clock.now();
    const eventId = taskEventRepository.newEventId();

    const result = await taskRepository.applyTaskTransition(taskId, {
        eventId,
        decide: (task) => {
            const contribution = typeof fields === 'function' ? fields(task, now) : fields;
            const next = resolveTransition(task, action);
            const event = reviewEvent({ task, action, next, actorId, actorRole, detail });

            if (action === 'submit') {
                event.submission = submissionSnapshot({ ...task, ...contribution });
                event.previousSubmission = submissionSnapshot(task);
            }

            return {
                status: next,
                fields: { ...contribution, status: next },
                event: { ...event, createdAt: now },
            };
        },
    });

    if (result.missing) {
        throw new TaskNotFoundError('Task not found');
    }

    return { taskId, status: result.status };
};

/**
 * STAGE 9C / STAGE 1. The employee submits their work.
 *
 * The required payload is whichever one the task's `submissionType` names. Each
 * submission now also stamps the server-computed review deadline (seven calendar
 * days), bumps `submissionVersion`, and appends a history event that keeps the
 * previous submission snapshot. The version is what makes an admin-review request
 * single-shot per submission: its document id includes this number.
 */
const submitTask = async (taskId, payload, actor = {}) =>
    applyTransition(
        taskId,
        'submit',
        (task, now) => ({
            ...buildSubmission(task, payload, now),
            reviewDeadlineAt: new Date(now.getTime() + REVIEW_WINDOW_MS),
            submissionVersion: (Number(task.submissionVersion) || 0) + 1,
        }),
        { actorId: actor.uid || null, actorRole: 'employee' }
    );

/**
 * STAGE 9C. The employer approves submitted work. Still terminal with respect to
 * submit/approve/request-revision; Stage 1 adds dispute as the one way an approved
 * task can be reopened before release.
 */
const approveTask = async (taskId, actor = {}) =>
    applyTransition(
        taskId,
        'approve',
        {
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { actorId: actor.uid || null, actorRole: 'employer' }
    );

/**
 * STAGE 9C. The employer sends submitted work back. As before, `revisionNote` is
 * required: the note is the whole content of the action.
 */
const requestTaskRevision = async (taskId, { revisionNote }, actor = {}) => {
    if (typeof revisionNote !== 'string' || revisionNote.trim() === '') {
        throw new TaskValidationError('Missing required fields');
    }

    return applyTransition(
        taskId,
        'request_revision',
        {
            revisionNote,
            reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { actorId: actor.uid || null, actorRole: 'employer' }
    );
};

/**
 * STAGE 1. The employee asks an admin to review a submitted task, after the
 * employer has had the full seven-day window and not acted.
 *
 * The deadline is enforced HERE, from the stored `reviewDeadlineAt`, not from
 * anything the client sends. A legacy submitted task with no deadline fails
 * closed with a 409 rather than being treated as instantly eligible: there is no
 * evidence the employer's window elapsed, and inventing one would let the
 * employee escalate work the employer may still be reviewing.
 *
 * The request id is `{taskId}_v{submissionVersion}`, so a second escalation for
 * the same submission is a 409 and a resubmission (which bumps the version) can
 * be escalated again. The request, the task status and the history event commit
 * together.
 */
const requestAdminReview = async (taskId, { reason } = {}, actor = {}) => {
    const now = clock.now();
    const eventId = taskEventRepository.newEventId();

    try {
        const result = await adminReviewRepository.createReviewRequestTransaction({
            taskId,
            eventId,
            decide: (task) => {
                const next = resolveTransition(task, 'request_admin_review');

                if (!deadlinePassed(task, now.getTime())) {
                    throw new TaskDeadlineError(
                        'The review window has not elapsed yet'
                    );
                }

                const submissionVersion = Number(task.submissionVersion) || 0;
                const requestId = adminReviewRepository.requestIdFor(task.id, submissionVersion);

                return {
                    status: next,
                    submissionVersion,
                    fields: {
                        status: next,
                        activeAdminReviewRequestId: requestId,
                        adminReviewRequestedAt: now,
                    },
                    request: {
                        taskId: task.id,
                        submissionVersion,
                        requestedBy: actor.uid || null,
                        reason: typeof reason === 'string' ? reason : '',
                        status: 'pending',
                        submission: submissionSnapshot(task),
                        createdAt: now,
                        updatedAt: now,
                    },
                    event: {
                        ...reviewEvent({
                            task,
                            action: 'request_admin_review',
                            next,
                            actorId: actor.uid || null,
                            actorRole: 'employee',
                            detail: { reason: typeof reason === 'string' ? reason : '' },
                        }),
                        createdAt: now,
                    },
                };
            },
        });

        if (result.missing) throw new TaskNotFoundError('Task not found');

        return { taskId, status: result.status, requestId: result.requestId };
    } catch (err) {
        if (err instanceof adminReviewRepository.ReviewRequestExistsError) {
            throw new TaskReviewConflictError(err.message);
        }
        if (err instanceof TaskTransitionError) {
            throw new TaskReviewConflictError(err.message);
        }
        throw err;
    }
};

/**
 * STAGE 1. The employee's reply to an admin `request_info` decision.
 *
 * This is the explicit follow-up transition `request_info` needs: it records the
 * employee's answer and leaves the review unresolved, so the deadline cannot be
 * used to drift into an approval and the case stays in the admin queue. It is
 * not a status change, which is why it appends a `review_response` event rather
 * than calling the transition table.
 */
const respondToAdminReview = async (taskId, { message } = {}, actor = {}) => {
    if (typeof message !== 'string' || message.trim() === '') {
        throw new TaskValidationError('A response message is required');
    }

    const snapshot = await taskRepository.getTaskById(taskId);
    if (!snapshot.exists) throw new TaskNotFoundError('Task not found');

    const task = { id: snapshot.id, ...snapshot.data() };
    if (!task.activeAdminReviewRequestId) {
        throw new TaskReviewConflictError('This task has no admin review awaiting a response');
    }

    const now = clock.now();
    await taskEventRepository.addEvent({
        taskId,
        type: 'review_response',
        actorId: actor.uid || null,
        actorRole: 'employee',
        fromStatus: taskStatus(task),
        toStatus: taskStatus(task),
        detail: { message: message.trim() },
        createdAt: now,
    });

    return { taskId, status: taskStatus(task) };
};

/** STAGE 1. The task's review history, oldest first, plus admin decisions. */
const listTaskHistory = async (taskId) => {
    const [eventsSnap, decisionsSnap] = await Promise.all([
        taskEventRepository.listEventsByTaskId(taskId),
        adminReviewRepository.listDecisionsForTask(taskId),
    ]);

    const rows = (snapshot) => {
        const out = [];
        snapshot.forEach((doc) => out.push({ id: doc.id, ...doc.data() }));
        return out;
    };

    const byDate = (a, b) => (toMillis(a.createdAt) || 0) - (toMillis(b.createdAt) || 0);

    return {
        events: rows(eventsSnap).sort(byDate),
        decisions: rows(decisionsSnap).sort(byDate),
    };
};

/**
 * One task, by id.
 *
 * STAGE 9C. Returns `{ id, ...document }` like both list endpoints, with the same
 * derived status for a document written before Stage 9B. Stage 1 adds three
 * response-only review fields: the window length, whether it has elapsed, and
 * whether the employee may now escalate. They are derived on read and never
 * written, so the stored document remains the single source of truth.
 */
const getTask = async (taskId) => {
    const snapshot = await taskRepository.getTaskById(taskId);

    if (!snapshot.exists) {
        throw new TaskNotFoundError('Task not found');
    }

    const derived = withDerivedFields({ id: snapshot.id, ...snapshot.data() });
    const passed = deadlinePassed(derived, clock.nowMs());

    return {
        ...derived,
        reviewWindowDays: REVIEW_WINDOW_DAYS,
        deadlinePassed: passed,
        canRequestAdminReview: taskStatus(derived) === 'submitted' && passed,
    };
};

/**
 * Builds the exact task document both create paths persist.
 *
 * STAGE 9B. This exists so the document shape is built in exactly one place,
 * rather than being restated at each call site that persists a task. Constructing
 * the payload in one place is the only way to guarantee it without a test asserting
 * it forever, and it puts the two Stage 9B fields next to the six they sit beside.
 *
 * Pure: it reads no collection and stamps no clock other than the
 * serverTimestamp() it hands to Firestore.
 *
 * `jobId` and `employeeId` stay on the document as denormalized copies rather than
 * being replaced by the employment id. listTasksByEmployee and listTasksByJob are
 * single-field equality filters that need no composite index; a task keyed only by
 * `employmentId` could not be listed by either without a new query, and an employer
 * would have no way to reach it at all.
 *
 * `applicationId`/`employmentId` come from requireTaskAssignment, which resolved
 * them from the accepted application. `employmentId` may be null there, which is
 * written through as null rather than omitted, so the field's presence still
 * distinguishes a post-Stage-9B task from a pre-Stage-9B one.
 */
const buildTaskDocument = (
  { jobId, employeeId, taskName, taskDescription, dueDate, submissionType, milestoneId },
  assignment = {}
) => ({
  jobId,
  employeeId,
  taskName,
  taskDescription,
  dueDate,
  ...(milestoneId ? { milestoneId } : {}),
  // STAGE 10G: how this task's work must be delivered. createTask has already
  // checked its value against SUBMISSION_TYPES. STAGE 3E reaches this builder
  // directly from the hire and passes DEFAULT_SUBMISSION_TYPE, itself a member of
  // that list. The builder does not validate; callers supply a valid type.
  submissionType,
  // STAGE 9B: a task starts life assigned to the employee, and says which
  // application -- and so which employment -- it was raised under.
  status: ASSIGNED_TASK_STATUS,
  applicationId: assignment.applicationId ?? null,
  employmentId: assignment.employmentId ?? null,
  // STAGE 5H: was `new Date()`. Firestore converts a Date to a Timestamp on
  // write, so the stored type was already a Timestamp and the field name
  // and API shape are unchanged -- what changed is whose clock decides. The
  // value is now committed by Firestore instead of being read off the Node
  // process clock, matching users.createdAt / applications.dateApplied.
  createdDate: admin.firestore.FieldValue.serverTimestamp(),
});

/**
 * Creates a task and returns its generated document id.
 *
 * POST /tasks -- the endpoint the client actually calls; ViewJobApplications.jsx
 * posts here.
 *
 * QUIRK (preserved): `employeeId` comes from the request payload, not from the
 * verified token. The router's requireTaskAssignment guard is what authorises
 * it -- it checks the caller may assign that employee to that job -- so
 * switching this to req.user.uid would change which assignments are accepted
 * for multi-employee jobs. Left exactly as it is.
 *
 * `assignment` is `req.taskAssignment`, resolved by that same guard. It is an
 * argument rather than something read off the service so this function stays
 * testable and keeps no knowledge of HTTP.
 *
 * STAGE 9F: this is now the only standalone task-creation path. The duplicate that
 * used to build its payload through buildTaskDocument above and then discarded the
 * generated id has been deleted along with its route.
 *
 * STAGE 3E: buildTaskDocument now has a second caller, the hire transaction in
 * applicationService, which creates one task per accepted milestone under its own
 * deterministic id. The builder remains shared so both paths persist the same
 * shape; the `taskId` this function returns is the auto-id for POST /tasks only.
 */
const resolveMilestoneAssociation = async (milestoneId, assignment = {}) => {
  if (milestoneId == null || milestoneId === '') return null;

  if (typeof milestoneId !== 'string') {
    throw new TaskValidationError('milestoneId must be a string');
  }

  const trimmed = milestoneId.trim();
  if (!trimmed) throw new TaskValidationError('milestoneId must not be empty');

  if (!assignment.employmentId) {
    throw new TaskValidationError(
      'A task without an employment cannot be linked to a milestone'
    );
  }

  const snapshot = await contractRepository.getMilestoneById(trimmed);
  if (!snapshot.exists) {
    throw new TaskValidationError('Milestone not found');
  }

  const milestone = snapshot.data();
  if (
    milestone.employmentId !== assignment.employmentId
    || milestone.contractId !== assignment.employmentId
  ) {
    throw new TaskValidationError('Milestone does not belong to this employment');
  }

  return trimmed;
};

const createTask = async (payload, assignment) => {
  const { jobId, employeeId, taskName, taskDescription, dueDate, submissionType } = payload;

  if (!jobId || !employeeId || !taskName || !taskDescription || !dueDate || !submissionType) {
    throw new TaskValidationError('Missing required fields');
  }

  // STAGE 10G: a sixth required field, and the only one of the six whose value is an
  // enum rather than free text. Checked separately so the answer says which of the two
  // things is wrong -- "Missing required fields" for no type at all, the list for a
  // type this API does not have -- because an employer who posts 'attachment' needs
  // to be told what the three names are, not that a field is missing.
  //
  // Required rather than defaulted: every task created from here on knows how its work
  // must arrive, so submitTask never has to guess. The default on
  // DEFAULT_SUBMISSION_TYPE is for documents that already exist, not for new ones.
  if (!SUBMISSION_TYPES.includes(submissionType)) {
    throw new TaskValidationError(`submissionType must be one of: ${SUBMISSION_TYPES.join(', ')}`);
  }

  const milestoneId = await resolveMilestoneAssociation(payload.milestoneId, assignment);

  // A task linked to a milestone may only be created once that specific
  // milestone's payment record exists and is persisted as 'paid'. The record
  // is read server-side from the milestone id -- never from the request body --
  // so a client cannot forge funding. Tasks without a milestone are unaffected.
  if (milestoneId) {
    const paymentSnapshot = await paymentRepository.getPaymentByMilestoneId(milestoneId);
    const payment = paymentSnapshot.exists ? paymentSnapshot.data() : null;
    if (!payment || payment.status !== PAID_PAYMENT_STATUS) {
      throw new TaskValidationError(
        'this milestone must be paid before a task can be created for it'
      );
    }
  }

  const taskId = await taskRepository.addTask(
    buildTaskDocument({ ...payload, milestoneId }, assignment)
  );

  return { taskId };
};

/**
 * Adds the V1 defaults to a task that predates them.
 *
 * STAGE 9B. Tasks written before this stage carry no `status`, and there is no
 * migration, no backfill and no rewrite-on-read: a document that comes back from
 * `addTask` is byte-for-byte what was written, and only the response is shaped.
 * A missing status reads as `assigned`, which is what those tasks in fact were --
 * assigned, never submitted, because nothing could submit them.
 *
 * Applied only when the field is absent (null or undefined). An unrecognised value
 * is forwarded untouched rather than coerced, matching the Stage 5G decision not
 * to rewrite legacy application statuses at read time.
 *
 * STAGE 10G adds the same treatment for `submissionType`, read as `text`: the single
 * payload submitTask accepted before this stage was written text. Both derivations
 * are response-only, so a document written before either stage still reads back
 * identically on disk -- which is what keeps "no migration" true.
 */
const withDerivedFields = (task) => {
    const derived = task.status == null ? { ...task, status: ASSIGNED_TASK_STATUS } : { ...task };

    if (derived.submissionType == null) {
        derived.submissionType = DEFAULT_SUBMISSION_TYPE;
    }

    return derived;
};

/**
 * Every task assigned to one employee, as plain objects.
 *
 * STAGE 6B. Added because a task had no read path at all: it could be written but
 * never read back by anyone, so the assignee could not see their own work.
 *
 * AUTHORIZATION: this function trusts its caller completely -- it performs no
 * ownership check. `uid` reaches it from the verified token via the existing
 * requireSelfParam('uid') guard in routes/tasks.js, which rejects any path
 * parameter that is not req.user.uid. That is the same arrangement
 * listApplicationsForEmployee already uses, and it is why no new guard is needed.
 *
 * The document is returned as `{ id, ...data }`, matching listApplicationsForJob:
 * no field is renamed, dropped or reshaped, so the task a UI reads back is byte
 * for byte the document that was stored. The single exception is the derived
 * status above, which is added only to documents written before Stage 9B and only
 * to the response. There is deliberately no per-task employer/employee join here;
 * the UI can use jobId and employeeId, and adding a read of another collection
 * would change nothing about this contract.
 *
 * An unknown uid returns an empty array rather than a 404: this is a list of the
 * caller's own tasks, and "you have none" is not a missing resource.
 */
const listTasksForEmployee = async (uid) => {
    const snapshot = await taskRepository.listTasksByEmployee(uid);

    const tasks = [];
    snapshot.forEach((doc) => {
      tasks.push(withDerivedFields({ id: doc.id, ...doc.data() }));
    });

    return tasks;
};

/**
 * Every task belonging to one job, as plain objects.
 *
 * STAGE 6B. The employer-side counterpart of listTasksForEmployee, and the reason
 * an employer can see the work they assigned.
 *
 * AUTHORIZATION: as above, this trusts its caller. `requireJobOwner` in
 * routes/tasks.js has already loaded the job and confirmed job.postedBy ===
 * req.user.uid, so a non-owner never reaches this function -- it is turned away
 * with a 403, or a 404 if the job does not exist, before the query runs.
 *
 * Same `{ id, ...data }` shape, the same derived status, and the same "empty list,
 * not 404" rule as listTasksForEmployee: a job that exists but has no tasks yet
 * returns [].
 *
 * Order is the query's own, unchanged. Nothing here sorts, and neither does the
 * repository: the fake Firestore throws on orderBy(), and no task has ever been
 * returned in a defined order.
 */
const listTasksForJob = async (jobId) => {
    const snapshot = await taskRepository.listTasksByJob(jobId);

    const tasks = [];
    snapshot.forEach((doc) => {
      tasks.push(withDerivedFields({ id: doc.id, ...doc.data() }));
    });

    return tasks;
};

module.exports = {
    TaskValidationError,
    TaskNotFoundError,
    TaskTransitionError,
    TaskDeadlineError,
    TaskReviewConflictError,
    ASSIGNED_TASK_STATUS,
    TASK_STATUSES,
    REVIEW_WINDOW_DAYS,
    REVIEW_WINDOW_MS,
    // STAGE 10G: exported so the accept-list has one definition. The three values are
    // also restated in the client's taskPresentation.js and in the employer's select,
    // and this is the one a test can assert all three against.
    SUBMISSION_TYPES,
    DEFAULT_SUBMISSION_TYPE,
    // STAGE 10G.1: the signing half of the file-upload flow, and the two constants
    // behind it. Exported so the router can reach the first without a controller
    // re-deriving anything, and so a test can assert the resource type the signature
    // promises is the one buildFileSubmission insists on.
    TASK_FILE_RESOURCE_TYPE,
    signTaskSubmissionUpload,
    buildTaskDocument,
    createTask,
    getTask,
    submitTask,
    approveTask,
    requestTaskRevision,
    requestAdminReview,
    respondToAdminReview,
    listTaskHistory,
    listTasksForEmployee,
    listTasksForJob,
};
