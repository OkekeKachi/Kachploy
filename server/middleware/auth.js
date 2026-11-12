'use strict';

/**
 * Authentication and authorization middleware.
 *
 * `protect` verifies the Firebase ID token, requires the `email_verified` claim,
 * and populates `req.user`. Every route in this API requires it, except the single
 * registration-completion route guarded by `protectAllowUnverified` (STAGE 13/H2).
 *
 * The authorization guards below load the resource named in the request and
 * compare its owner against `req.user.uid`. Identity is therefore always taken
 * from the verified token and never from the request body or from an
 * unverified path parameter.
 *
 * NOTE (Stage 4F): as of this stage these guards reach Firestore only through
 * the repositories -- jobRepository and applicationRepository. The ownership
 * rules themselves stay here, exactly where they were: the repository returns a
 * raw snapshot and this file decides what a missing document means, what the
 * caller is allowed to do with it, and which status code and message to send.
 * Token verification (`admin.auth().verifyIdToken`) also stays here, per the
 * Stage 4E boundary.
 *
 * NOTE (Stage 7C): the three interview guards added below read the `interviews`
 * collection the same way -- through interviewRepository, never directly -- so the
 * Stage 4F rule holds for the new resource too. Their ownership rule is also the
 * same one the application reviewer uses, resolved through the application to the
 * job that posted it.
 *
 * NOTE (Stage 8B): the two conversation guards below are the first pair here that
 * admit a caller on the strength of a value stored ON the resource itself rather
 * than on a parent chain, because the conversation carries both participant uids.
 * That is a deliberate departure from requireInterviewOwner and requireInterviewParty,
 * which both refuse to trust a stored `employerId` and re-derive the employer from
 * `job.postedBy`. The reasoning, and the policy consequences it commits to, are in
 * loadConversation's doc comment rather than here.
 */

const { admin } = require('../config/firebase');
const jobRepository = require('../repositories/jobRepository');
const applicationRepository = require('../repositories/applicationRepository');
const interviewRepository = require('../repositories/interviewRepository');
// STAGE 8B: the conversations resource. Reached only through
// conversationRepository, never directly, so the Stage 4F rule below holds for it
// too: this file decides what a missing document means and what the caller may do
// with it, and the repository hands back raw snapshots.
const conversationRepository = require('../repositories/conversationRepository');
// STAGE 9B: the employments resource, reached the same way -- through its
// repository, never directly -- so the Stage 4F rule holds for it too. Used by
// requireTaskAssignment to resolve the employment behind the accepted
// application it has just identified.
const employmentRepository = require('../repositories/employmentRepository');
// STAGE 9C: the tasks resource. Like every other read in this file, reached only
// through its repository -- Stage 4F -- so this file, not the repository, decides
// what a missing task means and what the caller may do with one.
const taskRepository = require('../repositories/taskRepository');
// STAGE P1: the contracts resource, reached the same way -- through its
// repository, never directly -- so the Stage 4F rule holds for it too. The three
// contract guards below are the first here that authorise against a document this
// API creates under a DETERMINISTIC id (the employment id); see each guard for
// what that changes.
const contractRepository = require('../repositories/contractRepository');
const releaseRepository = require('../repositories/releaseRepository');
const {
  RELEASE_TARGET_TYPES,
  isValidDocumentId,
} = require('../config/release');

// STAGE 6K. See the requireTaskAssignment doc comment for why this one literal
// is repeated here instead of imported from applicationService.
const HIRED_STATUS = 'accepted';

// STAGE 9C. Repeated from employmentService for the same reason HIRED_STATUS is,
// and deliberately NOT imported: requireTaskParty treats every value that is not
// this one as "not active", so an employment whose status is missing, misspelled or
// written by a future stage can only fail closed.
const ACTIVE_EMPLOYMENT_STATUS = 'active';

/**
 * STAGE 13 (H2). The exact body of the 403 returned when an ID token is valid but
 * its email address has not been verified. JSON, matching every other refusal
 * guard in this file rather than the plain-text 401s above, because this is an
 * authorization decision about an already-authenticated caller.
 */
const EMAIL_VERIFICATION_REQUIRED = 'Email verification required';

/**
 * Verifies the bearer token and attaches the decoded claims to `req.user`.
 * Responses are intentionally plain text to preserve the existing contract.
 *
 * STAGE 13 (H2). Verifying the token is no longer sufficient on its own: this is
 * now the authenticated-AND-verified guard. Firebase mints a valid ID token the
 * moment an account is created, before any verification link is clicked, so the
 * client's /verify-email gate is a UX affordance and not a control -- an
 * unverified account can present a genuine token to this API directly. The only
 * authority on whether the email is verified is the signed `email_verified`
 * claim, which the client cannot forge, so that is what is read here. The
 * caller's role is never consulted (nor is the request body read): an unverified
 * caller is refused whatever role they name, and a verified caller is admitted
 * whatever role they name.
 *
 * The comparison is `!== true` rather than a falsy check on purpose. Firebase sets
 * the claim explicitly to `false` for an unverified account, and a strict
 * comparison additionally refuses a token that somehow carries no claim at all, so
 * the check fails closed on an unexpected token shape instead of open.
 *
 * `POST /users/register` is the one route that must stay reachable while
 * unverified -- the client calls it to complete registration only after the email
 * is verified, but the freshly refreshed token can lag that moment by a round trip
 * -- so it is guarded by protectAllowUnverified below instead of this.
 */
async function protect(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Unauthorized');
  }

  const token = authHeader.split(' ')[1];

  let decodedToken;

  try {
    decodedToken = await admin.auth().verifyIdToken(token);
  } catch (err) {
    return res.status(401).send('Invalid token');
  }

  if (decodedToken.email_verified !== true) {
    return res.status(403).json({ message: EMAIL_VERIFICATION_REQUIRED });
  }

  req.user = decodedToken;
  return next();
}

/**
 * STAGE 13 (H2). The pre-Stage-13 `protect`: verifies the bearer token and
 * attaches the decoded claims to `req.user`, but does NOT require the email to be
 * verified. It exists for exactly one route, `POST /users/register`, which
 * completes registration and is called by the client immediately after the email
 * is confirmed -- a moment at which the freshly forced ID token can still be one
 * round trip away from carrying the claim. Blocking that call would strand a
 * verified account with no `users/{uid}` document, which is the "do not block the
 * endpoints needed to complete verification" requirement.
 *
 * It is deliberately NOT a general-purpose guard: every other route keeps
 * `protect`, so the only surface reachable while unverified is the registration
 * write itself. The 401s are byte-for-byte the ones `protect` sends.
 */
async function protectAllowUnverified(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).send('Unauthorized');
  }

  const token = authHeader.split(' ')[1];

  try {
    req.user = await admin.auth().verifyIdToken(token);
    return next();
  } catch (err) {
    return res.status(401).send('Invalid token');
  }
}

/**
 * STAGE 1. Admin-only routes are authorised ONLY by the Firebase custom claim
 * `admin === true`, read from the ID token protect already verified.
 *
 * The claim is provisioned out of band, and there is deliberately no endpoint that
 * grants it: a self-service bootstrap would make the claim worth nothing. The
 * stored `users.role` is never consulted -- registration accepts arbitrary role
 * strings for the ordinary product, so a Firestore field must not decide who can
 * resolve disputes.
 *
 * The check is strict. `"true"`, `1` and a role string are all refused; a token
 * without the claim is an ordinary authenticated caller and gets 403.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.admin !== true) {
    return res.status(403).json({ message: 'Admin access required' });
  }

  return next();
}

/** Guards a route where the caller must be the user named in a path parameter. */
function requireSelfParam(paramName) {
  return (req, res, next) => {
    if (req.params[paramName] !== req.user.uid) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    return next();
  };
}

async function loadJob(req, res, jobId) {
  const snapshot = await jobRepository.getJobById(jobId);
  if (!snapshot.exists) {
    res.status(404).json({ message: 'Job not found' });
    return null;
  }
  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * The 403 body used when a caller is not the owner of the job. The default
 * describes a *write* rejection, which is accurate for the three mutating routes
 * guarded by requireJobOwner (PUT /jobs/edit/:jobId, DELETE /jobs/:jobId and
 * PUT /jobs/:jobId/status).
 */
const JOB_OWNER_FORBIDDEN = 'You do not have permission to modify this job';

/**
 * STAGE 6S. The same rejection on a *read* route. requireJobOwner is shared by
 * five routes -- two reads and three writes -- and it previously emitted this
 * "modify" wording for all five. A non-owner who merely tried to look at a job's
 * applicants was told they lacked permission to modify the job, which is both
 * untrue and unhelpful: it describes an action they never attempted, so a client
 * reading the message cannot tell that the failure was a read restriction.
 *
 * Only the message is parameterised. The status stays 403, the ownership test is
 * unchanged, the 404-for-missing-job and 500 paths are unchanged, and the three
 * write routes keep the original string byte-for-byte by way of the default.
 */
const JOB_APPLICANTS_FORBIDDEN =
  'You do not have permission to view applications for this job';

/**
 * STAGE 6T. The remaining read route's wording. GET /tasks/job/:jobId is guarded
 * by the same requireJobOwner and was the last route still reporting a read
 * refusal with the write-oriented "modify this job" text after Stage 6S corrected
 * the applicant read. Same reasoning, same remedy: the caller only asked to see
 * the job's tasks, so that is what the message says.
 *
 * This adds a constant only. The requireJobOwner factory is unchanged, the status
 * is still 403, the ownership comparison is still job.postedBy === req.user.uid,
 * and the three write routes still fall through to JOB_OWNER_FORBIDDEN.
 */
const JOB_TASKS_FORBIDDEN = 'You do not have permission to view tasks for this job';

/**
 * STAGE 7C. The same remedy for GET /interviews/job/:jobId, which is guarded by
 * requireJobOwner and asks for the interviews held on one job. Continuing the
 * sequence Stage 6S and 6T established: a read refusal describes a read, and the
 * three job write routes keep their original "modify this job" text via the
 * default parameter. Constant only -- no guard behaviour changes here.
 */
const JOB_INTERVIEWS_FORBIDDEN =
  'You do not have permission to view interviews for this job';

/**
 * STAGE 10H.1. The read-accurate wording for the employments read on a job.
 * GET /employments/job/:jobId reuses requireJobOwner, exactly as
 * GET /interviews/job/:jobId does, and this is the message a non-owner receives.
 * Constant only -- the guard's ownership test, its 404-for-missing-job and its 403
 * status are unchanged.
 */
const JOB_EMPLOYMENTS_FORBIDDEN =
  'You do not have permission to view employments for this job';

/**
 * Only the employer who posted a job may read its applicants or its tasks, edit
 * it, delete it, or change its status. Attaches the loaded job to `req.job` so the
 * handler does not have to read it again.
 *
 * `forbiddenMessage` selects the wording of the 403 only, and nothing else. Read
 * routes pass JOB_APPLICANTS_FORBIDDEN or JOB_TASKS_FORBIDDEN; the three write
 * routes omit it and therefore keep the original "modify this job" text via the
 * default parameter.
 */
function requireJobOwner(forbiddenMessage = JOB_OWNER_FORBIDDEN) {
  return async (req, res, next) => {
    try {
      const job = await loadJob(req, res, req.params.jobId);
      if (!job) return undefined;

      if (job.postedBy !== req.user.uid) {
        return res.status(403).json({ message: forbiddenMessage });
      }

      req.job = job;
      return next();
    } catch (err) {
      console.error('Error authorising job access:', err);
      return res.status(500).json({ message: 'Failed to authorise request' });
    }
  };
}

/** Loads an application and attaches it to `req.application`. */
async function loadApplication(req, res, applicationId) {
  const snapshot = await applicationRepository.getApplicationById(applicationId);
  if (!snapshot.exists) {
    res.status(404).json({ message: 'Application not found' });
    return null;
  }
  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * Only the applicant may withdraw their own application.
 */
async function requireApplicationOwner(req, res, next) {
  try {
    const application = await loadApplication(req, res, req.params.applicationId);
    if (!application) return undefined;

    if (application.employeeId !== req.user.uid) {
      return res.status(403).json({ message: 'You do not have permission to modify this application' });
    }

    req.application = application;
    return next();
  } catch (err) {
    console.error('Error authorising application access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * Only the employer who posted the job an application belongs to may accept or
 * reject that application.
 */
async function requireApplicationReviewer(req, res, next) {
  try {
    const application = await loadApplication(req, res, req.params.id);
    if (!application) return undefined;

    const job = await loadJob(req, res, application.jobId);
    if (!job) return undefined;

    if (job.postedBy !== req.user.uid) {
      return res.status(403).json({ message: 'You do not have permission to modify this application' });
    }

    req.application = application;
    req.job = job;
    return next();
  } catch (err) {
    console.error('Error authorising application review:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE 12.12.1. Only two callers may download the private resume an application
 * carries: the employee who owns it (the applicant named on the application),
 * and the employer who owns the job the application was made to.
 *
 * The resume reference itself is never read from the request. This guard loads
 * the application -- and, for the employer branch, its job -- from Firestore and
 * attaches `req.application` so the handler can mint the signed URL from the
 * stored reference. An unrelated authenticated caller gets the same 403 the
 * application reviewers receive and no resume detail in the body, so ids cannot
 * be enumerated by the shape of the failure.
 *
 * The employee check comes first and short-circuits, so an applicant downloads
 * their own resume without the extra job read. That ordering is also what keeps
 * a job that has since been deleted from locking the applicant out of their own
 * document.
 */
async function requireResumeAccess(req, res, next) {
  try {
    const application = await loadApplication(req, res, req.params.applicationId);
    if (!application) return undefined;

    if (application.employeeId === req.user.uid) {
      req.application = application;
      return next();
    }

    const job = await loadJob(req, res, application.jobId);
    if (!job) return undefined;

    if (job.postedBy !== req.user.uid) {
      return res.status(403).json({ message: 'You do not have permission to view this resume' });
    }

    req.application = application;
    req.job = job;
    return next();
  } catch (err) {
    console.error('Error authorising resume access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE 6K. The canonical application statuses live in
 * services/applicationService.js (`APPLICATION_STATUSES`), which owns every
 * status write and is not exported. Only the one value this guard needs is
 * reproduced here, and it is the same literal that list is built from, so the
 * two cannot drift apart in a way that matters: `updateApplicationStatus`
 * refuses to write any status outside `pending` / `accepted` / `rejected`, and
 * the title-cased legacy `Employed` / `Not Hired` are deliberately not accepted
 * on write and are not normalised anywhere server-side. So the only value a
 * server-written document can hold that means "hired" is `accepted`.
 *
 * Tasks may only be created by the employer who owns the target job, and only
 * assigned to someone who actually applied to that job.
 *
 * STAGE 6K: applied is no longer sufficient. The guard also requires that the
 * applicant's application status is `accepted`. It previously compared only
 * `employeeId`, so a task could be created for an applicant whose application
 * was `pending` or `rejected` -- which is exactly what the applicant's own
 * "Your Hired Jobs" page lists as work assigned to them. Found during the
 * Stage 6J end-to-end verification: a task was created for an applicant whose
 * application had just been set to `rejected`.
 *
 * The applicant query is unchanged: still a single-field equality filter on
 * `jobId`, so no composite index is needed, and still issued by this guard
 * rather than added to applicationRepository. Both reads are computed from the
 * one snapshot that was already being taken.
 *
 * The legacy title-cased `Employed` value is NOT treated as `accepted` here.
 * It is read as accepted by the frontend for display
 * (ViewJobApplications.jsx / MyApplications.jsx), so an application document
 * written before Stage 5G will now fail this check. That is consistent with the
 * service refusing to write the value in the first place, and rewriting stored
 * documents is outside this guard's remit.
 *
 * STAGE 9B. The guard now also resolves `req.taskAssignment`, the application and
 * employment a new task belongs to. It costs one extra read and no new query: the
 * accepted application was already being located in the snapshot already being
 * taken, so capturing its document id is free, and only the employment lookup
 * that follows is new. No authorization rule is added or relaxed -- the accepted
 * applicant may be assigned exactly as before, and pending, rejected and
 * non-applicants are still refused with the same two 403 bodies in the same order.
 */
async function requireTaskAssignment(req, res, next) {
  const { jobId, employeeId } = req.body;

  if (!jobId || !employeeId) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const job = await loadJob(req, res, jobId);
    if (!job) return undefined;

    if (job.postedBy !== req.user.uid) {
      return res.status(403).json({ message: 'You do not have permission to create tasks for this job' });
    }

    const snapshot = await applicationRepository.listApplicationsByJob(jobId);
    const applications = snapshot.docs.map((doc) => doc.data());

    const applicant = applications.some((data) => data.employeeId === employeeId);

    if (!applicant) {
      return res
        .status(403)
        .json({ message: 'Tasks can only be assigned to a user who applied to this job' });
    }

    // STAGE 9B. The accepted application is now identified rather than merely
    // counted, so the task can record which application -- and therefore which
    // employment -- it belongs to. `some` became a filter: the boolean result, and
    // with it both 403 bodies above and below, are unchanged for every case the
    // old code decided. The one thing that is new is that the guard now keeps the
    // matching document instead of discarding it.
    const hiredApplications = snapshot.docs.filter(
      (doc) => doc.data().employeeId === employeeId && doc.data().status === HIRED_STATUS
    );

    if (hiredApplications.length === 0) {
      return res
        .status(403)
        .json({ message: 'Tasks can only be assigned to an applicant whose application has been accepted' });
    }

    const hired = pickHiredApplication(hiredApplications);

    req.job = job;

    // STAGE 9B. The context the create path needs, resolved once here so the
    // document is built from the guard's own decision rather than from a second
    // lookup that could disagree with it. STAGE 9F: POST /tasks is the only
    // task-creation endpoint, since the duplicate that shared this context is
    // gone, so this is read on exactly one route.
    req.taskAssignment = {
      applicationId: hired.id,
      employmentId: await resolveEmploymentId(hired.id, { jobId, employeeId }),
    };

    return next();
  } catch (err) {
    console.error('Error authorising task assignment:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * Picks which accepted application a task should be attached to.
 *
 * STAGE 9B. `applyToJob` never blocked a second application for the same
 * (jobId, employeeId) pair, and Stage 7H-2 dedupes employments per
 * `applicationId` rather than per pair. So an employer who accepted the same
 * person twice for one job -- reachable through the API even though
 * ViewJobApplications.jsx only ever offers one hire per click -- holds two
 * employments, and "the accepted application" is ambiguous.
 *
 * Resolved deterministically instead of taking the first snapshot entry, which
 * would be ordered by document id under real Firestore and by insertion order
 * under the fake: the most recently applied accepted application wins, and the
 * document id breaks a tie between applications applied in the same instant. That
 * matches intent -- the most recent hire is the current engagement -- and it makes
 * the stored ids reproducible across runs and across both Firestore and the fake.
 *
 * The overwhelmingly common input is a single accepted application, which
 * returns unchanged.
 */
function pickHiredApplication(docs) {
  return docs.reduce((best, doc) => {
    const bestAt = appliedAtMillis(best.data());
    const nextAt = appliedAtMillis(doc.data());

    if (nextAt > bestAt) return doc;
    if (nextAt < bestAt) return best;
    return doc.id > best.id ? doc : best;
  });
}

/**
 * Milliseconds for an application's `dateApplied`, or -Infinity when it is absent
 * or in a shape this file cannot read.
 *
 * STAGE 9B. A tie-breaker only (see pickHiredApplication); it decides nothing
 * about authorization, so an unreadable value sorts last rather than raising.
 * Application writes go through applicationService, which stores
 * serverTimestamp(), so the two Timestamp shapes below are what a real document
 * and a seeded one respectively look like. The string and number cases exist only
 * for hand-written or pre-existing documents.
 */
function appliedAtMillis(data) {
  const value = data ? data.dateApplied : null;

  if (value == null) return -Infinity;
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  if (typeof value._seconds === 'number') return value._seconds * 1000;
  if (typeof value.seconds === 'number') return value.seconds * 1000;

  return -Infinity;
}

/**
 * The employment created for one application, or null when there is none.
 *
 * STAGE 9B. One read, reached through the repository per Stage 4F. Stage 7H-2
 * guarantees at most one employment per applicationId (its read-before-write
 * refuses a second add), so the first entry is the only one; `ended` documents are
 * included deliberately, because a task attached to a finished engagement is still
 * that engagement's task.
 *
 * The match is checked against the job and employee being authorized, not taken on
 * the strength of the `applicationId` field alone. createEmploymentFromHire builds
 * `jobId`, `employeeId` and `applicationId` from one context, so they always agree
 * in documents this API wrote, and the check costs nothing. It exists because
 * `employmentId` is going to be authoritative for the authorization Stage 9C adds:
 * a document that disagrees with the application it is filed under would hand that
 * check a different employer than the one who is hiring here. Nothing produces such
 * a document today -- only direct writes and corrupt data -- but a field this
 * load-bearing should not be resolved on a label alone.
 *
 * null, rather than a rejected request: the accepted application is what authorizes
 * the assignment, and an application can be `accepted` without an employment
 * document if that write failed or predates Stage 7A. Turning that into a 403 would
 * refuse task creation for a hire that otherwise worked, which is the working
 * behaviour this stage must preserve. A task with a null employmentId is still fully
 * described by its `jobId` and `employeeId`.
 */
async function resolveEmploymentId(applicationId, { jobId, employeeId }) {
  const snapshot = await employmentRepository.listEmploymentsByApplication(applicationId);

  if (snapshot.empty) return null;

  const employment = snapshot.docs[0];
  const data = employment.data();

  const matchesAssignment = data.jobId === jobId && data.employeeId === employeeId;

  return matchesAssignment ? employment.id : null;
}

/**
 * Loads an interview and attaches it to `req.interview`.
 *
 * STAGE 7C. The sixth resource to need a loader in this file, and the first one
 * that is not identified by something the caller supplied in a path parameter on a
 * single-document route. It reads the `interviews` collection through
 * interviewRepository, as Stage 4F requires of every read in this file.
 */
async function loadInterview(req, res, interviewId) {
  const snapshot = await interviewRepository.getInterviewById(interviewId);
  if (!snapshot.exists) {
    res.status(404).json({ message: 'Interview not found' });
    return null;
  }
  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * STAGE 7C. Only the employer who posted the job an application belongs to may
 * schedule an interview for it. Guards POST /interviews.
 *
 * Body-based, not path-based, because the application being interviewed is the
 * subject of the request rather than part of a route: this is the second guard in
 * this file to read its subject from the body, after requireTaskAssignment on
 * POST /tasks. The 400 for a missing applicationId is that guard's exact wording,
 * so a client that omits the field gets the same answer it already gets from
 * POST /tasks.
 *
 * The job is resolved from the APPLICATION document, not from a `jobId` in the
 * body, so ownership is decided by the one authoritative chain -- application ->
 * job -> postedBy. A caller cannot point this guard at a job they happen to own
 * while attaching an application belonging to someone else's.
 *
 * Whether the body's own `jobId` agrees with the application's is a data question,
 * not an authorization one, so it is left to interviewService.createInterview: the
 * caller owns both documents in the disagreement case, so a 400 is the honest answer
 * and a 403 would be withholding nothing.
 *
 * Attaches `req.application` and `req.job`. The service re-reads the application
 * itself; see the note on createInterview for why that duplication is deliberate.
 */
async function requireInterviewAuthor(req, res, next) {
  const { applicationId } = req.body;

  if (!applicationId) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const application = await loadApplication(req, res, applicationId);
    if (!application) return undefined;

    const job = await loadJob(req, res, application.jobId);
    if (!job) return undefined;

    if (job.postedBy !== req.user.uid) {
      return res.status(403).json({ message: 'You do not have permission to create interviews for this job' });
    }

    req.application = application;
    req.job = job;
    return next();
  } catch (err) {
    console.error('Error authorising interview creation:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE 7C. Only the employer who posted the job behind an interview may change
 * it: reschedule it, correct a detail, or mark it completed / cancelled /
 * no_show. Guards PUT /interviews/:interviewId.
 *
* There is deliberately NO applicant path in. The requirement is one-directional --
 * an applicant may read the interviews on their own application but must not modify
 * them through this guard -- so an applicant is turned away here with the same 403 an
 * unrelated user would get, and never reaches interviewService.updateInterview. No
 * check on the caller's role is needed, or wanted: the ownership test below already
 * excludes every non-owner, whoever they are.
 *
 * STAGE 10A, and this is the note that matters for anyone reading the paragraph above
 * later: the applicant still does not modify an interview through here. What changed is
 * that there is now one route -- PUT /:interviewId/response, behind
 * requireInterviewRespondent -- where the applicant may write one field of their own.
 * This guard was deliberately NOT widened to admit them, and should not be: doing so
 * would put reschedule, cancel, complete and mark-a-no-show within the applicant's
 * reach, which is precisely what the applicant write was separated to avoid.
 *
 * The chain is interview -> application -> job -> postedBy, which is
 * requireApplicationReviewer's chain with one hop added. It deliberately does NOT
 * authorize on the interview's own stored `employerId`: that is a value this
 * service wrote, and a stored value is not an authority. The job's postedBy is.
 * createInterview guarantees `interview.jobId === application.jobId`, so the two
 * agree on every document this API can produce.
 *
 * Both intermediate documents are loaded rather than assumed, so a missing
 * application or job is a 404 naming the thing that is actually missing instead of
 * a 500 from an undefined property.
 */
async function requireInterviewOwner(req, res, next) {
  try {
    const interview = await loadInterview(req, res, req.params.interviewId);
    if (!interview) return undefined;

    const application = await loadApplication(req, res, interview.applicationId);
    if (!application) return undefined;

    const job = await loadJob(req, res, application.jobId);
    if (!job) return undefined;

    if (job.postedBy !== req.user.uid) {
      return res.status(403).json({ message: 'You do not have permission to modify this interview' });
    }

    req.interview = interview;
    req.application = application;
    req.job = job;
    return next();
  } catch (err) {
    console.error('Error authorising interview access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE 7C. Either party to an application may read the interviews held on it: the
 * applicant whose recruitment it is, and the employer who owns its job. Guards
 * GET /interviews/application/:applicationId.
 *
 * This is the only guard in this file that admits two different kinds of caller, and
 * it is why it is a separate guard rather than a reuse of requireApplicationOwner
 * (which admits only the applicant) or requireJobOwner (which needs a jobId in the
 * path this route does not have). Both branches load the same two documents the
 * single-owner guards load; the difference is purely in the test applied to uid.
 *
 * The alternative -- two routes, one employer-only and one applicant-only -- would
 * have meant the same query and the same response behind two paths, and would have
 * made "the applicant may read their own interviews" a second thing to keep working
 * rather than a consequence of the same rule.
 *
 * Everyone else gets a 403 with no data in the body, so an unrelated authenticated
 * user cannot enumerate interviews belonging to other people's applications.
 */
async function requireInterviewParty(req, res, next) {
  try {
    const application = await loadApplication(req, res, req.params.applicationId);
    if (!application) return undefined;

    const job = await loadJob(req, res, application.jobId);
    if (!job) return undefined;

    const isApplicant = application.employeeId === req.user.uid;
    const isEmployer = job.postedBy === req.user.uid;

    if (!isApplicant && !isEmployer) {
      return res.status(403).json({ message: 'You do not have permission to view interviews for this application' });
    }

    req.application = application;
    req.job = job;
    return next();
  } catch (err) {
    console.error('Error authorising interview read:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE 10A. Only the applicant the interview is held for may answer it. Guards
 * PUT /interviews/:interviewId/response.
 *
 * This is the counterpart to requireInterviewOwner, and the two are deliberately
 * mirror images: that guard walks interview -> application -> job -> job.postedBy and
 * admits the employer; this one walks interview -> application -> application.employeeId
 * and admits the applicant. Each admits exactly one party, and the interviewer is not
 * automatically the interviewee -- a user who both posted the job and applied to it is
 * refused here for being the poster and refused by requireInterviewOwner for being the
 * applicant, which is the correct answer for a resource whose two parties are meant to
 * be different people.
 *
 * It is a separate guard rather than a branch inside requireInterviewOwner because
 * requireInterviewOwner is a single-authority guard on purpose: its Stage 7C comment
 * records that "there is deliberately no applicant path: an applicant may read an
 * interview but never modify one". Widening it would put the employer's whole
 * updateInterview -- reschedule, cancel, complete, mark a no-show -- one guard change
 * away from the applicant. A new guard keeps that boundary intact, and gives the
 * response route an author of its own.
 *
 * The chain stops at the application and does not load the job. The applicant's
 * authority is the application's own `employeeId`, which this API wrote from the
 * verified token on the apply path, so there is nothing further to resolve and the
 * guard costs two reads rather than three.
 *
 * It resolves on `application.employeeId`, NOT on the interview's stored `employeeId`,
 * which is the same rule requireInterviewOwner follows in refusing to trust a stored
 * `employerId`: a stored value is not an authority. The two agree on every document
 * this API can produce -- createInterview copies the applicant from the application --
 * so nothing changes for a valid interview, and an interview whose stored applicant
 * disagrees with its application no longer decides who may answer it.
 *
 * Whether the interview can still be ANSWERED is not decided here. This guard answers
 * only "is this the applicant"; interviewService.respondToInterview refuses a
 * completed, cancelled or no-show interview, because that is a question about the data
 * rather than about the caller. Splitting it this way is what keeps this guard free of
 * interview lifecycle policy.
 *
 * Everyone else gets a 403 with no interview data in the body, so an unrelated
 * authenticated user cannot answer or probe interviews belonging to other people's
 * applications.
 */
async function requireInterviewRespondent(req, res, next) {
  try {
    const interview = await loadInterview(req, res, req.params.interviewId);
    if (!interview) return undefined;

    const application = await loadApplication(req, res, interview.applicationId);
    if (!application) return undefined;

    if (application.employeeId !== req.user.uid) {
      return res.status(403).json({ message: 'You do not have permission to respond to this interview' });
    }

    req.interview = interview;
    req.application = application;
    return next();
  } catch (err) {
    console.error('Error authorising interview response:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * Loads a conversation and attaches it to `req.conversation`.
 *
 * The conversation is the only collection in this file that is read WITHOUT walking
 * a chain of parents to find an authority, and that is the point of the Stage 8B
 * design rather than an omission: createOrGetConversation copies both participants
 * onto the conversation itself, so the document already carries the answer to
 * "may this caller?" and resolving it again through application -> job would be two
 * extra reads to re-derive what is stored.
 *
 * The consequence is a real policy decision, not just a saving. Because the guard
 * reads the conversation's own copy of the two uids, an employer who is later removed
 * from a job keeps access to the thread they were part of, and a job transferred to
 * a new employer does NOT hand that new employer the old applicant's conversation.
 * Both are the intended reading for a conversation: the participants are the people
 * who were in it, not whoever currently owns the job. It is recorded here because it
 * is a consequence someone must be able to find later, and because the Stage 7C
 * guards by contrast deliberately refuse to trust a stored `employerId`.
 */
async function loadConversation(req, res, conversationId) {
  const snapshot = await conversationRepository.getConversationById(conversationId);
  if (!snapshot.exists) {
    res.status(404).json({ message: 'Conversation not found' });
    return null;
  }
  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * STAGE 8B. Either party to an application -- its applicant, or the employer who
 * posted its job -- may open the conversation for it. Guards POST /conversations.
 *
 * Body-based, not path-based, for the same reason requireInterviewAuthor and
 * requireTaskAssignment are: the application is the subject of the request rather
 * than part of the route, and a conversation for it may well not exist yet. That is
 * the whole reason this guard exists separately from requireConversationParty -- with
 * no conversation there is nothing for a conversation-scoped guard to authorize, so
 * the create path has to resolve participants the long way, through the application
 * to the job. The 400 for a missing applicationId is requireInterviewAuthor's exact
 * wording, so a client that omits the field gets the answer it already gets from
 * POST /interviews and POST /tasks.
 *
 * The chain is application -> job -> postedBy, with `application.employeeId` as the
 * other side, which is requireInterviewParty's chain and its two-party test verbatim.
 * The two parties are the same people here as they are for an interview: the same
 * employer and the same applicant on the same application.
 *
 * STAGE 8E, AND THE ONE CASE WHERE THAT CHAIN IS NOT AVAILABLE.
 * `withdrawApplication` DELETES the application document rather than marking it
 * withdrawn, while rejecting one only changes its status. So the chain above resolves
 * for `pending`, `interviewed`, `accepted` and `rejected`, and cannot resolve at all
 * once a conversation's application has been withdrawn -- even though the conversation
 * outlives its application by design, and holds both participants on its own document.
 * `deleteJob` deletes its document outright too, so the same gap opens from the other
 * end of the chain when an employer removes a job that already has a thread.
 *
 * That produced one real defect, in two shapes. The conversation's own thread routes
 * (GET/POST /conversations/:id/messages) authorize from the conversation's stored uids
 * and were never affected, but THIS guard 404'd before reaching the service, so
 * POST /conversations -- the documented get-or-create -- stopped being idempotent once
 * either source document was gone. A client that already had the thread could still
 * read and post to it, yet asking for that same thread by its application id returned
 * "Application not found" (or "Job not found"), for a conversation that demonstrably
 * existed. conversationService createOrGetConversation already checks for an existing
 * conversation BEFORE it looks the application up, so the service always intended to
 * answer this call; only the guard got in the way.
 *
 * So when either document needed by the chain is missing, this guard now falls back to
 * the conversation's stored uids -- exactly the comparison requireConversationParty
 * makes on every read and write already. That is not a widening of access: the
 * fallback fires only when a conversation document exists, and those uids were copied
 * from this same application -> job chain when it was created, never from a request.
 * It restores the guard to the authorization `requireConversationParty` already trusts
 * rather than inventing a second rule. When no conversation exists either, the 404
 * stands and names whichever document was actually missing, so an unknown application
 * id still cannot be used to open anything.
 *
 * The employer is still compared against `job.postedBy` and NOT against a stored
 * value whenever the application is present. This is the deliberate opposite of
 * requireConversationParty, and the reason is that at that moment no conversation has
 * been read to take a stored value from. A job's poster is an authority; a value this
 * API wrote is not. Once the conversation exists, requireConversationParty trusts the
 * stored uids precisely because they were established here, from the authoritative
 * chain, rather than accepted from a request.
 *
 * Attaches `req.application` and `req.job` on the application-present path, and
 * `req.conversation` on the fallback path. conversationService re-reads the
 * application and the job itself; see the note on createOrGetConversation for why that
 * duplication is deliberate.
 */
async function requireConversationParticipant(req, res, next) {
  const { applicationId } = req.body;

  if (!applicationId) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    /*
        STAGE 8E. The application and the job are read through the repositories
        directly rather than via `loadApplication` / `loadJob`, because those write a
        404 to the response as a side effect of returning null -- and whether a 404 is
        correct here depends on whether a conversation still exists, which is not known
        until it has been checked. Committing to the 404 at the first null would
        reintroduce the defect this guard is being fixed for. Every status code and
        message emitted below is the one `loadApplication` / `loadJob` would have
        emitted.
    */
    const applicationSnapshot = await applicationRepository.getApplicationById(applicationId);
    const application = applicationSnapshot.exists
      ? { id: applicationSnapshot.id, ...applicationSnapshot.data() }
      : null;

    const jobSnapshot = application
      ? await jobRepository.getJobById(application.jobId)
      : null;
    const job = jobSnapshot && jobSnapshot.exists
      ? { id: jobSnapshot.id, ...jobSnapshot.data() }
      : null;

    // The normal path: the whole chain resolves, so participants are established the
    // authoritative way, through the application to the job.
    if (application && job) {
      const isApplicant = application.employeeId === req.user.uid;
      const isEmployer = job.postedBy === req.user.uid;

      if (!isApplicant && !isEmployer) {
        return res.status(403).json({ message: 'You do not have permission to access conversations for this application' });
      }

      req.application = application;
      req.job = job;
      return next();
    }

    /*
        STAGE 8E. Either half of that chain is MISSING -- the application was withdrawn
        and deleted, or the job was deleted out from under it. Both are survivable for a
        conversation that already exists, because the conversation carries its own two
        participant uids. Authorize against those, on exactly the comparison
        requireConversationParty already makes for every read and write.

        This cannot widen access: it runs only when a conversation document exists, and
        those uids were copied from the chain above when it was created, never from a
        request. It restores this guard to the authorization the thread routes already
        trust, rather than adding a second rule.
    */
    const conversationSnapshot = await conversationRepository.getConversationById(applicationId);

    if (conversationSnapshot.exists) {
      const conversation = { id: conversationSnapshot.id, ...conversationSnapshot.data() };

      const isEmployer = conversation.employerId === req.user.uid;
      const isEmployee = conversation.employeeId === req.user.uid;

      if (!isEmployer && !isEmployee) {
        return res.status(403).json({ message: 'You do not have permission to access conversations for this application' });
      }

      req.conversation = conversation;
      return next();
    }

    // No conversation either, so there is nothing to authorize against and nothing to
    // create. The 404 names whichever document was actually missing, unchanged.
    return res.status(404).json({
      message: application ? 'Job not found' : 'Application not found',
    });
  } catch (err) {
    console.error('Error authorising conversation creation:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE 8B. Either party to a conversation -- the applicant or the employer named on
 * the document -- may read it and post to it. Guards both
 * GET /conversations/:conversationId/messages and
 * POST /conversations/:conversationId/messages.
 *
 * The second guard in this file to admit two kinds of caller, after
 * requireInterviewParty, and for the same structural reason: a conversation has
 * exactly two participants and both of them have to be able to use it, so one guard
 * admitting both is the rule rather than two single-owner guards. Its doc comment is
 * not repeated from requireInterviewParty -- the reasoning about why the two are not
 * one guard belongs there, and what differs here is the source of the participant
 * uids, which loadConversation explains.
 *
 * One document read, no chain. The comparison is against the conversation's own
 * `employerId` / `employeeId` rather than against `job.postedBy`, which is what makes
 * a message send cost the same single read as a message read, and what stops a
 * change of job ownership from retroactively granting or revoking access to a thread.
 *
 * A caller who is neither participant is refused with a 403 and no conversation or
 * message data in the body, so an unrelated authenticated user cannot enumerate
 * conversations by guessing ids, and cannot learn whether a guessed id exists from
 * the shape of the failure. A MISSING conversation is a 404 from loadConversation
 * rather than a 403, which does distinguish "no such conversation" from "not yours" --
 * the same trade every other guard in this file makes, since the id space is not
 * guessable in the first place.
 *
 * There is deliberately no separate read/write pair. Both operations are available
 * to both participants: an applicant may post in their own thread and an employer may
 * post in theirs, and there is no message operation in Stage 8B that one party may
 * perform and the other may not. If a later stage adds edit or delete, THAT is the
 * moment a one-directional rule is warranted -- and it will need a guard of its own,
 * because `requireConversationParty` answers membership, not authorship.
 */
async function requireConversationParty(req, res, next) {
  try {
    const conversation = await loadConversation(req, res, req.params.conversationId);
    if (!conversation) return undefined;

    const isEmployer = conversation.employerId === req.user.uid;
    const isEmployee = conversation.employeeId === req.user.uid;

    if (!isEmployer && !isEmployee) {
      return res.status(403).json({ message: 'You do not have permission to access this conversation' });
    }

    req.conversation = conversation;
    return next();
  } catch (err) {
    console.error('Error authorising conversation access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * Loads a task and attaches it to `req.task`.
 *
 * STAGE 9C. The seventh resource to need a loader here, and the first whose subject
 * is a document id with no other guard on it. Reads `tasks` through taskRepository
 * and `employments` through employmentRepository, per Stage 4F.
 *
 * The 404 is deliberately emitted before any authorization decision, so an
 * unauthenticated-looking "no such task" and "not yours" cannot be told apart by a
 * caller who guesses ids. That is the same trade loadConversation and loadInterview
 * already make: the id space is Firestore auto-ids and not guessable in practice,
 * and a 404 here is what keeps a missing task from surfacing later as the fake's
 * `5 NOT_FOUND: no entity to update` written straight to a 500.
 */
async function loadTask(req, res, taskId) {
  const snapshot = await taskRepository.getTaskById(taskId);

  if (!snapshot.exists) {
    res.status(404).json({ message: 'Task not found' });
    return null;
  }

  return { id: snapshot.id, ...snapshot.data() };
}

/**
 * STAGE 9C. Guards every task read and every task transition.
 *
 * The authority is the task's own `employmentId`, not the job it was raised under.
 * That is the whole reason Stage 9B stored it: `job.postedBy` is a *posting*
 * relationship and `task.employeeId` is an *assignment* relationship, and neither
 * one is who is party to the work. The employment is, because it is the record of
 * who was actually hired for it. Reading the employment is one document read, the
 * same cost requireConversationParty pays from the conversation's own participant
 * ids, and it means a deleted job cannot retroactively cut a task's parties off --
 * nor hand a task to whoever posts the job next.
 *
 * `mutation` and `role` select the policy, and they are the only differences
 * between the uses:
 *
 *   - READS (`requireTaskParty()`). An active or ended employment admits both of its
 *     parties. A task with no employment -- written before Stage 9B, or by the
 *     null-employmentId branch of Stage 9B -- falls back to the relationship the
 *     task's own fields already describe: its `employeeId`, or the owner of its
 *     `jobId`. That is the same rule the two list endpoints have always applied, so
 *     adding this route does not narrow who can see an old task.
 *
 *   - MUTATIONS (`mutation: true`). The fallback is refused outright. This is the
 *     one place in the file where a job relationship is deliberately NOT treated as
 *     authority, because it would be a substitute: `job.postedBy` can be read as
 *     "may review work on this job" only if nobody could ever be employed on a job
 *     they did not post, which is exactly what `employmentId` exists to stop
 *     assuming. A legacy task stays readable and stays frozen.
 *
 * `role` is the reason a single guard serves all four routes rather than two. Being
 * a party is not permission: both parties are admitted to the task, and only one of
 * them may perform a given action. Without this the employee could approve their own
 * work, which would make the approval step worth nothing -- and the employer could
 * submit on the employee's behalf, so the submission would never be a claim by
 * anyone that the work was actually done. Both refusals are ordinary 403s from
 * here, which is what makes them indistinguishable to a caller probing for a way
 * around the workflow.
 *
 * Role is named at the router rather than inferred from the URL, because the URL is
 * a string and this is a policy.
 *
 * An ENDED employment splits the same way: readable by both parties forever,
 * mutable by neither. Nothing here writes to the task, so a task cannot be closed,
 * reopened or otherwise disturbed by the employment ending -- and since nothing can
 * end an employment yet (Stage 7A writes `active` only), this is the rule written
 * ahead of the capability that will need it.
 *
 * Fail-closed on anything unexpected: an employment document with no `status`, or a
 * status this file does not recognise, is treated as ended, so an unreadable
 * employment can only ever remove permission and never grant it.
 */
function requireTaskParty({ mutation = false, role = null } = {}) {
  return async (req, res, next) => {
    try {
      const task = await loadTask(req, res, req.params.taskId);
      if (!task) return undefined;

      req.task = task;

      const employmentId = task.employmentId;

      if (!employmentId) {
        if (mutation) {
          return res.status(403).json({
            message:
              'This task is not linked to an employment, so its workflow cannot be changed',
          });
        }

        // Read fallback: the assignee, then the owner of the job. loadJob answers a
        // deleted job with its own 404, which is the right outcome -- there is no
        // employment to read and no job owner to check.
        if (task.employeeId === req.user.uid) return next();

        const job = await loadJob(req, res, task.jobId);
        if (!job) return undefined;

        if (job.postedBy !== req.user.uid) {
          return res
            .status(403)
            .json({ message: 'You do not have permission to access this task' });
        }

        return next();
      }

      const snapshot = await employmentRepository.getEmploymentById(employmentId);

      if (!snapshot.exists) {
        // Stage 9B only writes a non-null employmentId when the document existed
        // and named this job and this employee, so this is drift rather than a
        // normal state. Treated exactly like an unlinked task rather than trusted:
        // there is nothing here that could establish who the parties are.
        if (mutation) {
          return res.status(403).json({
            message:
              'The employment for this task could not be found, so its workflow cannot be changed',
          });
        }

        return res
          .status(403)
          .json({ message: 'You do not have permission to access this task' });
      }

      const employment = { id: snapshot.id, ...snapshot.data() };
      req.employment = employment;

      const isEmployee = employment.employeeId === req.user.uid;
      const isEmployer = employment.employerId === req.user.uid;

      if (!isEmployee && !isEmployer) {
        return res
          .status(403)
          .json({ message: 'You do not have permission to access this task' });
      }

      // The caller is a party; now check they are the right one for this action.
      const wrongRole =
        (role === 'employee' && !isEmployee) || (role === 'employer' && !isEmployer);

      if (wrongRole) {
        return res
          .status(403)
          .json({ message: 'You do not have permission to perform this action on the task' });
      }

      if (mutation && employment.status !== ACTIVE_EMPLOYMENT_STATUS) {
        return res.status(403).json({
          message: 'This employment has ended, so the task workflow is closed',
        });
      }

      return next();
    } catch (err) {
      console.error('Error authorising task access:', err);
      return res.status(500).json({ message: 'Failed to authorise request' });
    }
  };
}

/**
 * STAGE 10H.1. Only a party to an employment -- its employer or its employee --
 * may read it. Guards GET /employments/:employmentId.
 *
 * AUTHORITY FROM THE STORED DOCUMENT, following requireConversationParty rather
 * than the interview guards. An interview's authority is re-derived through
 * interview -> application -> job -> postedBy because the interview carries a
 * copied `employerId` this API wrote, and a stored copy is not treated as an
 * authority. The conversation guard departs from that and trusts the two uids on
 * the conversation itself, because createOrGetConversation copies them from the
 * authoritative application -> job chain at create time and a thread's
 * participants are the people who were in it. An employment is the same case as a
 * conversation and not the interview case: it is the record of a relationship
 * between two people, it carries both of them (`employerId` and `employeeId`,
 * both written by createEmploymentFromHire from the verified token and the loaded
 * application), and it outlives the job it was raised under -- so the parties are
 * resolved from the employment itself rather than from a parent chain that may
 * have been deleted or re-posted.
 *
 * ONE document read, no chain, so this costs the same single read
 * requireConversationParty pays from a conversation's own participant ids. The
 * 404 for a missing employment is emitted before any authorization decision, the
 * same trade loadConversation and loadTask make: the id space is Firestore
 * auto-ids and not guessable in practice.
 *
 * A stranger gets a 403 with no employment data in the body, so an unrelated
 * authenticated user cannot enumerate employments by guessing ids nor learn from
 * the failure's shape whether a guessed id exists.
 */
async function requireEmploymentParty(req, res, next) {
  try {
    const snapshot = await employmentRepository.getEmploymentById(req.params.employmentId);

    if (!snapshot.exists) {
      return res.status(404).json({ message: 'Employment not found' });
    }

    const employment = { id: snapshot.id, ...snapshot.data() };

    const isEmployer = employment.employerId === req.user.uid;
    const isEmployee = employment.employeeId === req.user.uid;

    if (!isEmployer && !isEmployee) {
      return res.status(403).json({ message: 'You do not have permission to view this employment' });
    }

    req.employment = employment;
    return next();
  } catch (err) {
    console.error('Error authorising employment access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE P1. Only the employer on an ACTIVE employment may create its contract.
 * Guards POST /contracts.
 *
 * Body-based, like requireInterviewAuthor: the employment being contracted is
 * the subject of the request rather than part of the route, so its id arrives
 * as body.employmentId. The four decisions, in order:
 *
 *   1. employmentId present -- a 400, the same "Missing required fields"
 *      wording requireInterviewAuthor uses for its applicationId.
 *   2. employment exists -- a 404 "Employment not found", the same trade
 *      requireEmploymentParty makes: the id space is Firestore auto-ids and
 *      not guessable in practice, and a 404 before any authorization decision
 *      keeps a stranger from learning anything from the failure's shape.
 *   3. caller is the employment's employer -- a 403. An employee on the
 *      employment, and any other authenticated user, gets the same refusal:
 *      contracts are created by the side that offers the work, and there is
 *      deliberately no employee-initiated contract path.
 *   4. employment is `active` -- a 403. An ended employment cannot receive a
 *      new contract, following requireTaskParty's reading of the same field
 *      ("This employment has ended..."): `active` is the only status this
 *      API writes and the only one that admits a mutation.
 *
 * The employment is attached as req.employment for the service, whose
 * createContract copies its four identity fields and never reads identities
 * from the body. Identity therefore comes from the verified token (step 3)
 * and from the stored employment (the copy), never from the client.
 */
async function requireContractEmployer(req, res, next) {
  const { employmentId } = req.body || {};

  if (!employmentId) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const snapshot = await employmentRepository.getEmploymentById(employmentId);

    if (!snapshot.exists) {
      return res.status(404).json({ message: 'Employment not found' });
    }

    const employment = { id: snapshot.id, ...snapshot.data() };

    if (employment.employerId !== req.user.uid) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to create a contract for this employment' });
    }

    if (employment.status !== ACTIVE_EMPLOYMENT_STATUS) {
      return res
        .status(403)
        .json({ message: 'This employment has ended, so a contract cannot be created for it' });
    }

    req.employment = employment;
    return next();
  } catch (err) {
    console.error('Error authorising contract creation:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE P1. Only the employee named on a contract may accept it.
 * Guards POST /contracts/:contractId/accept.
 *
 * Loads the contract by its deterministic id (the employment id) and admits
 * only employment.employeeId as recorded ON THE CONTRACT. The contract's
 * copied uids are treated as authoritative here, following
 * requireConversationParty and requireEmploymentParty rather than the
 * interview guards: a contract is the record of an agreement between two
 * named people, its identities were copied from an employment this API
 * wrote from verified tokens at create time, and it outlives the job it came
 * through. Re-deriving through employment -> application would be extra
 * reads to re-derive what the document already carries.
 *
 * The employer, and every other user, gets the same 403: acceptance is the
 * employee's act alone, and there is no platform-actor path. The contract's
 * STATUS is deliberately not checked here -- "is it still pending?" is a
 * domain rule about the resource's lifecycle, not a question about who the
 * caller is, and contractService.acceptContract owns it. A wrong-status
 * accept is therefore a 400 from the service, not a 403 from the guard.
 *
 * The contract is attached as req.contract for that service call.
 */
async function requireContractEmployee(req, res, next) {
  try {
    const snapshot = await contractRepository.getContractById(req.params.contractId);

    if (!snapshot.exists) {
      return res.status(404).json({ message: 'Contract not found' });
    }

    const contract = { id: snapshot.id, ...snapshot.data() };

    if (contract.employeeId !== req.user.uid) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to accept this contract' });
    }

    req.contract = contract;
    return next();
  } catch (err) {
    console.error('Error authorising contract acceptance:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE P1. Either party to a contract -- its employer or its employee -- may
 * read it. Guards GET /contracts/:contractId.
 *
 * Same policy and same reasoning as requireContractEmployee above: the two
 * uids on the contract document are the authority, one document read settles
 * it, a missing contract is a 404 emitted before any authorization decision,
 * and a stranger gets a 403 with no contract data in the body so a guessed
 * id reveals nothing. The contract is attached as req.contract; the read
 * service re-reads it so the response reflects the document as stored at
 * response time rather than as the guard saw it.
 *
 * The employment-scoped read (GET /contracts/employment/:employmentId) does
 * NOT use this guard -- it uses the existing requireEmploymentParty, because
 * what the path names is an employment and membership in it is exactly the
 * question that guard answers. The two guards admit the same two people by
 * construction (the contract copies its ids from the employment), so no
 * caller can pass one and fail the other for a reason that matters.
 */
async function requireContractParty(req, res, next) {
  try {
    const snapshot = await contractRepository.getContractById(req.params.contractId);

    if (!snapshot.exists) {
      return res.status(404).json({ message: 'Contract not found' });
    }

    const contract = { id: snapshot.id, ...snapshot.data() };

    const isEmployer = contract.employerId === req.user.uid;
    const isEmployee = contract.employeeId === req.user.uid;

    if (!isEmployer && !isEmployee) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to view this contract' });
    }

    req.contract = contract;
    return next();
  } catch (err) {
    console.error('Error authorising contract access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * Only the employer named on a contract may create, initialize or verify a
 * full-contract payment. Guards the body-based POST /payments/contract* routes.
 *
 * The contract id arrives as body.contractId (it is the subject of the
 * request), is type-checked before any repository call, and is then loaded so
 * the caller is authorized against the stored contract. Eligibility rules
 * (full mode, active contract, active employment, amount) stay in
 * paymentService; this guard answers only existence and identity.
 */
async function requireContractPaymentEmployer(req, res, next) {
  const { contractId } = req.body || {};

  if (typeof contractId !== 'string' || contractId.trim() === '') {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const snapshot = await contractRepository.getContractById(contractId);

    if (!snapshot.exists) {
      return res.status(404).json({ message: 'Contract not found' });
    }

    const contract = { id: snapshot.id, ...snapshot.data() };

    if (contract.employerId !== req.user.uid) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to pay this contract' });
    }

    req.contract = contract;
    return next();
  } catch (err) {
    console.error('Error authorising contract payment:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE P2. Only the employer on the contract a milestone belongs to may
 * initiate that milestone's payment record. Guards POST /payments.
 *
 * Body-based, like requireContractEmployer: the milestone being paid is the
 * subject of the request rather than part of the route, so its id arrives as
 * body.milestoneId. The four decisions, in order:
 *
 *   1. milestoneId present as a non-empty string -- a 400 'Missing required
 *      fields', the same wording requireContractEmployer uses for its
 *      employmentId. A blank or non-string value is refused here so it never
 *      reaches a Firestore document path.
 *   2. milestone exists -- a 404 'Milestone not found', the same trade the
 *      other guards make: 404 before any authorization decision, so a guessed
 *      id reveals nothing.
 *   3. the milestone's contract exists -- a 404 'Contract not found'. The
 *      contract is loaded BY milestone.contractId, so it cannot disagree with
 *      the milestone; what this settles is a milestone whose contract was
 *      never created (or no longer readable), which has no employer to name.
 *   4. caller is the CONTRACT's employerId -- a 403. The employee on the
 *      contract, and any other authenticated user, gets the same refusal:
 *      only the side that owes the money may initiate paying it, and there is
 *      deliberately no employee-initiated or platform-initiated path. The
 *      authority is the contract document's copied uid, following
 *      requireContractEmployee: a contract's identities were copied from an
 *      employment this API wrote from verified tokens, and they outlive the
 *      job they came through.
 *
 * Both documents are attached -- req.milestone and req.contract -- for
 * paymentService.initiatePayment, whose eligibility rules (contract active,
 * employment active, task approved) are domain rules and stay in the service,
 * exactly as a contract's status check stays out of requireContractEmployee.
 */
async function requireMilestoneEmployer(req, res, next) {
  const { milestoneId } = req.body || {};

  // STAGE P2 hardening. Ids are strings. A missing, blank or non-string body
  // value is the client's mistake and gets the same 400 the other body-based
  // guards give a missing id, BEFORE any repository call. Without the type
  // check a number or object would reach Firestore: the fake turns it into a
  // missing path (404) while the real Admin SDK rejects a non-string document
  // path by throwing (500), so the unvalidated form behaved differently in the
  // harness than it would in production.
  if (typeof milestoneId !== 'string' || milestoneId.trim() === '') {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const milestoneSnapshot = await contractRepository.getMilestoneById(milestoneId);

    if (!milestoneSnapshot.exists) {
      return res.status(404).json({ message: 'Milestone not found' });
    }

    const milestone = { id: milestoneSnapshot.id, ...milestoneSnapshot.data() };

    const contractSnapshot = await contractRepository.getContractById(milestone.contractId);

    if (!contractSnapshot.exists) {
      return res.status(404).json({ message: 'Contract not found' });
    }

    const contract = { id: contractSnapshot.id, ...contractSnapshot.data() };

    if (contract.employerId !== req.user.uid) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to initiate a payment for this milestone' });
    }

    req.milestone = milestone;
    req.contract = contract;
    return next();
  } catch (err) {
    console.error('Error authorising payment initiation:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

/**
 * STAGE P2. Either party to the contract a milestone belongs to may read that
 * milestone's payment record. Guards GET /payments/milestone/:milestoneId.
 *
 * Same policy and same reasoning as requireContractParty: the milestone names
 * its contract, the contract's two copied uids are the authority, a missing
 * milestone or contract is a 404 emitted before any authorization decision,
 * and a stranger gets a 403 with no data in the body. Both documents are
 * attached as req.milestone/req.contract; the read service re-reads the
 * payment record itself so the response reflects the document as stored at
 * response time rather than as the guard saw it. A valid milestone with no
 * payment record yet answers 404 from the SERVICE ('Payment not found') --
 * "no payment initiated yet" is the normal pre-initiation state.
 */
async function requireMilestoneParty(req, res, next) {
  try {
    const milestoneSnapshot = await contractRepository.getMilestoneById(req.params.milestoneId);

    if (!milestoneSnapshot.exists) {
      return res.status(404).json({ message: 'Milestone not found' });
    }

    const milestone = { id: milestoneSnapshot.id, ...milestoneSnapshot.data() };

    const contractSnapshot = await contractRepository.getContractById(milestone.contractId);

    if (!contractSnapshot.exists) {
      return res.status(404).json({ message: 'Contract not found' });
    }

    const contract = { id: contractSnapshot.id, ...contractSnapshot.data() };

    const isEmployer = contract.employerId === req.user.uid;
    const isEmployee = contract.employeeId === req.user.uid;

    if (!isEmployer && !isEmployee) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to view this milestone payment' });
    }

    req.milestone = milestone;
    req.contract = contract;
    return next();
  } catch (err) {
    console.error('Error authorising payment access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

async function loadReleaseForGuard(req, res, next, employerOnly) {
  try {
    const snapshot = await releaseRepository.getReleaseById(req.params.releaseId);

    if (!snapshot.exists) {
      return res.status(404).json({ message: 'Release not found' });
    }

    const release = { id: snapshot.id, ...snapshot.data() };

    if (employerOnly) {
      if (release.employerId !== req.user.uid) {
        return res
          .status(403)
          .json({ message: 'You do not have permission to manage this release' });
      }
    } else if (
      release.employerId !== req.user.uid
      && release.employeeId !== req.user.uid
    ) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to view this release' });
    }

    req.release = release;
    return next();
  } catch (err) {
    console.error('Error authorising release access:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

async function requireReleaseParty(req, res, next) {
  return loadReleaseForGuard(req, res, next, false);
}

async function requireReleaseEmployer(req, res, next) {
  return loadReleaseForGuard(req, res, next, true);
}

async function requireReleaseTargetEmployer(req, res, next) {
  const { targetType, targetId } = req.body || {};

  if (!RELEASE_TARGET_TYPES.includes(targetType) || !isValidDocumentId(targetId)) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    if (targetType === 'contract') {
      const contractSnapshot = await contractRepository.getContractById(targetId);
      if (!contractSnapshot.exists) {
        return res.status(404).json({ message: 'Contract not found' });
      }
      const contract = { id: contractSnapshot.id, ...contractSnapshot.data() };
      if (contract.employerId !== req.user.uid) {
        return res
          .status(403)
          .json({ message: 'You do not have permission to release this contract payment' });
      }
      req.releaseTarget = {
        targetType,
        targetId,
        employmentId: contract.employmentId || contract.id,
        contract,
      };
      return next();
    }

    const milestoneSnapshot = await contractRepository.getMilestoneById(targetId);
    if (!milestoneSnapshot.exists) {
      return res.status(404).json({ message: 'Milestone not found' });
    }
    const milestone = { id: milestoneSnapshot.id, ...milestoneSnapshot.data() };
    const contractSnapshot = await contractRepository.getContractById(milestone.contractId);
    if (!contractSnapshot.exists) {
      return res.status(404).json({ message: 'Contract not found' });
    }
    const contract = { id: contractSnapshot.id, ...contractSnapshot.data() };
    if (contract.employerId !== req.user.uid) {
      return res
        .status(403)
        .json({ message: 'You do not have permission to release this milestone payment' });
    }
    req.releaseTarget = {
      targetType,
      targetId,
      employmentId: contract.employmentId || contract.id,
      contract,
      milestone,
    };
    return next();
  } catch (err) {
    console.error('Error authorising release target:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
}

module.exports = {
  protect,
  requireAdmin,
  requireSelfParam,
  requireJobOwner,
  JOB_OWNER_FORBIDDEN,
  JOB_APPLICANTS_FORBIDDEN,
  JOB_TASKS_FORBIDDEN,
  JOB_INTERVIEWS_FORBIDDEN,
  JOB_EMPLOYMENTS_FORBIDDEN,
  requireApplicationOwner,
  requireApplicationReviewer,
  requireResumeAccess,
  requireTaskAssignment,
  requireTaskParty,
  requireInterviewAuthor,
  requireInterviewOwner,
  requireInterviewParty,
  requireInterviewRespondent,
  requireConversationParticipant,
  requireConversationParty,
  requireEmploymentParty,
  requireContractEmployer,
  requireContractEmployee,
  requireContractParty,
  requireContractPaymentEmployer,
  requireMilestoneEmployer,
  requireMilestoneParty,
  requireReleaseParty,
  requireReleaseEmployer,
  requireReleaseTargetEmployer,
  protectAllowUnverified,
};
