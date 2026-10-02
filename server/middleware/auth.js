'use strict';

/**
 * Authentication and authorization middleware.
 *
 * `protect` verifies the Firebase ID token and populates `req.user`. Every
 * route in this API requires it.
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
 */

const { admin } = require('../config/firebase');
const jobRepository = require('../repositories/jobRepository');
const applicationRepository = require('../repositories/applicationRepository');
const interviewRepository = require('../repositories/interviewRepository');

// STAGE 6K. See the requireTaskAssignment doc comment for why this one literal
// is repeated here instead of imported from applicationService.
const HIRED_STATUS = 'accepted';

/**
 * Verifies the bearer token and attaches the decoded claims to `req.user`.
 * Responses are intentionally plain text to preserve the existing contract.
 */
async function protect(req, res, next) {
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

    const accepted = applications.some(
      (data) => data.employeeId === employeeId && data.status === HIRED_STATUS
    );

    if (!accepted) {
      return res
        .status(403)
        .json({ message: 'Tasks can only be assigned to an applicant whose application has been accepted' });
    }

    req.job = job;
    return next();
  } catch (err) {
    console.error('Error authorising task assignment:', err);
    return res.status(500).json({ message: 'Failed to authorise request' });
  }
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
 * an applicant may read the interviews on their own application but must not
 * modify them -- so an applicant is turned away here with the same 403 an unrelated
 * user would get, and never reaches interviewService.updateInterview. No check on
 * the caller's role is needed, or wanted: the ownership test below already excludes
 * every non-owner, whoever they are.
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

module.exports = {
  protect,
  requireSelfParam,
  requireJobOwner,
  JOB_OWNER_FORBIDDEN,
  JOB_APPLICANTS_FORBIDDEN,
  JOB_TASKS_FORBIDDEN,
  JOB_INTERVIEWS_FORBIDDEN,
  requireApplicationOwner,
  requireApplicationReviewer,
  requireTaskAssignment,
  requireInterviewAuthor,
  requireInterviewOwner,
  requireInterviewParty,
};
