// userController.js
//
// HTTP layer for the users resource. Every handler now does only three things:
// take identity and input from the request, call exactly one userService
// function, and translate the outcome into the status code and body this API
// has always returned.
//
// Stage 3D moved the data and business layer into services/userService.js,
// including ALLOWED_PROFILE_FIELDS. There is still no repository and no shared
// error system.
//
// Behaviour is deliberately unchanged, including the awkward parts:
//
//   - several responses are plain text via .send(), not JSON
//   - /register still returns one of two different 200 strings
//   - GET /getUser/:userId is still reachable by any authenticated caller, but
//     Stage 5C narrows what a cross-user caller receives
//   - the missing-field and no-op paths still log nothing
//   - the Auth and Firestore writes are still two unsynchronised calls

// The error class config/cloudinary raises when the three environment variables
// are absent. Required here so signProfilePhotoUpload can answer an unconfigured
// server with a 503 rather than a 500 -- the same choice taskController makes for
// task-file signing.
const { CloudinaryConfigurationError, generateSignedDownloadUrl } = require('../config/cloudinary');
const { isPaystackConfigured } = require('../config/paystack');
const userService = require('../services/userService');
const payoutAccountService = require('../services/payoutAccountService');

/**
 * Maps a service failure onto the existing HTTP response.
 *
 * Not-found failures skip the console.error: those paths previously returned
 * before the catch block, so they never logged.
 *
 * `notFoundAs` and `errorAs` exist because GET /getUser/:userId does not use the
 * JSON error bodies its sibling does. It answered with plain text via `.send()`:
 * `404 'User not found'` and `500 'Server error'`, where PUT /update/:uid used
 * `404 { message }` and `500 { message }`. Both shapes are preserved; the
 * defaults are the JSON forms, which is what updateUserProfile uses.
 */
const sendFailure = (res, err, { log, message, notFoundAs = 'json', errorAs = 'json' }) => {
  // STAGE 12.6: a rejected payload is the caller's fault, not the server's, so it
  // answers 400 -- never the generic 500. The body keeps the JSON { message }
  // shape this route already uses, and the message is the service's own.
  if (err instanceof userService.UserValidationError) {
    return res.status(400).json({ message: err.message });
  }

  if (err instanceof userService.UserNotFoundError) {
    if (notFoundAs === 'text') {
      return res.status(404).send(err.message);
    }

    return res.status(404).json({ message: err.message });
  }

  if (log) {
    console.error(log, err);
  }

  if (errorAs === 'text') {
    return res.status(500).send(message);
  }

  return res.status(500).json({ message });
};

/**
 * GET /users
 *
 * Leftover Express-generator stub. Unchanged, including the unused `next`
 * parameter, because a client may depend on the literal body.
 *
 * DEAD CODE: returns the string "responds with a resource" for every
 * authenticated caller. No client reads it. Scheduled for removal in Stage 7.
 *
 * This is the one handler with no userService function behind it, and that is
 * deliberate: it performs no Firestore or Auth access and has no business
 * rule, so its entire body is the HTTP response itself. Moving a constant
 * string into the service would make the service return something that only
 * makes sense as a response body.
 */
function listUsers(req, res, next) {
  res.send('responds with a resource');
}

/**
 * POST /users/register
 *
 * The two success paths are distinguished by the service's `alreadyExists`
 * flag, which is what the original early `return` inside the try used to do.
 *
 * QUIRK (preserved): the caller's `email` is destructured from req.user and
 * never used -- /register does not persist it to Firestore.
 */
const registerUser = async (req, res) => {
  const { uid, email } = req.user;

  try {
    const { alreadyExists } = await userService.registerUser(uid, req.body);

    if (alreadyExists) {
      return res.status(200).send("User already registered");
    }

    res.status(200).send("User registered successfully");
  } catch (err) {
    // STAGE 1: a rejected registration payload is the caller's fault. The
    // message names the rule, and 400 replaces the old blanket 500 so a client
    // can tell a bad role from a server fault.
    if (err instanceof userService.UserValidationError) {
      return res.status(400).json({ message: err.message });
    }

    console.error("Registration error:", err);
    return res.status(500).send("Error registering user");
  }
};

/**
 * POST /users/register-profile
 *
 * QUIRK (preserved): unlike /register, this one DOES persist `uid`, `email`
 * and `fullName` into Firestore and merges, so the two endpoints build
 * different shapes for the same collection.
 *
 * The catch here logs the bare error with no label, unlike every sibling.
 * Preserved verbatim; normalising it belongs to the error-handling stage.
 */
const registerProfile = async (req, res) => {
  const { uid, email } = req.user;

  try {
    await userService.registerProfile(uid, email, req.body);

    res.status(200).send("✅ Profile saved!");
  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error saving profile");
  }
};

// router.get('/profile', async (req, res) => {
//   try {
//     const idToken = req.headers.authorization?.split(' ')[1];
//     const decodedToken = await admin.auth().verifyIdToken(idToken);
//     const uid = decodedToken.uid;

//     // Fetch from Firestore or your own DB
//     const userDoc = await db.collection('users').doc(uid).get();
//     if (!userDoc.exists) return res.status(404).send("User not found");

//     res.json(userDoc.data());
//   } catch (err) {
//     console.error(err);
//     res.status(401).send("Unauthorized");
//   }
// });
//
// Preserved verbatim from before Stage 3D and deliberately left inert: it is
// still commented out, still not routed, and still references `admin`/`db`,
// which this file no longer imports. Un-commenting it would need those handles
// re-imported here or a service function written for it.

/**
 * GET /users/getUser/:userId
 *
 * Stage 5C closed the cross-user privacy gap. This was guarded by `protect` only
 * and returned the whole Firestore document, so any authenticated caller could
 * read any other user's `uid`, `email`, `phone` and `role`.
 *
 * The route deliberately does NOT get requireSelfParam('userId'), because
 * JobSplitView.jsx legitimately reads the job poster's profile and a self-only
 * guard would break it with a 403. There is no allow/deny decision to move into
 * middleware here, so the route stays `protect`-only; what changed is the
 * response scope, and that is the service's call. The controller's only new job
 * is to pass the token-derived caller uid down so the service can tell a
 * self-read from a cross-user read -- the same role it plays for
 * updateUserProfile, where :uid is forwarded alongside the body.
 *
 * Response shape is unchanged: `{ user: ... }` in both cases, 200 either way.
 * The document is full when the caller asks about themselves and narrowed to
 * PUBLIC_PROFILE_FIELDS when they ask about someone else.
 *
 * Its 404 and 500 are plain text, not the JSON bodies PUT /update/:uid uses.
 * That asymmetry is preserved via notFoundAs/errorAs.
 */
const getUser = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await userService.getUser(userId, req.user.uid);

    res.json({ user: user });
  } catch (error) {
    sendFailure(res, error, {
      log: 'Error fetching user:',
      message: 'Server error',
      notFoundAs: 'text',
      errorAs: 'text',
    });
  }
};

/**
 * PUT /users/update/:uid
 *
 * Guarded by requireSelfParam('uid'), so :uid is always the caller. The
 * allow-list loop that stops a user writing `role` or `uid` now lives in
 * userService.
 *
 * QUIRK (preserved): profilePic and the Firestore update remain two separate
 * writes; if the Auth update succeeds and the Firestore update then fails the
 * two stores are left inconsistent.
 */
const updateUserProfile = async (req, res) => {
  const { uid } = req.params;
  // Only allowlisted fields are forwarded to Firestore; profilePic is handled
  // separately, in the service.
  const userData = req.body || {};

  try {
    await userService.updateUserProfile(uid, userData);

    res.status(200).json({ message: 'Profile updated successfully' });
  } catch (error) {
    sendFailure(res, error, {
      log: 'Error updating user:',
      message: 'Internal Server Error',
    });
  }
};

/**
 * POST /users/profile-photo/signature
 *
 * The first half of a profile-photo upload: a signed payload the browser uses to
 * send one image straight to Cloudinary, and nothing else. The upload goes
 * browser -> Cloudinary; the returned `secure_url` is then written back as
 * `profilePic` through the existing PUT /users/update/:uid flow, unchanged.
 *
 * NO IDENTITY FROM THE REQUEST. The route is guarded by `protect` only, and the
 * uid is taken from the verified token (req.user.uid) -- there is no :uid in the
 * path and no user id in the body, so a caller can only ever sign an upload for
 * their own `profilePics/{uid}` folder. The handler reads no request field at all;
 * service-level signing is what a user cannot forge without the api secret.
 *
 * Responds 200 with `{ cloudName, apiKey, timestamp, signature, folder, publicId,
 * resourceType, allowedFormats }` -- exactly what the browser needs, no more. The
 * api secret is used inside config/cloudinary and is not part of this body.
 *
 * 503 when Cloudinary is not configured, matching POST /tasks/:taskId/upload-signature:
 * the environment may legitimately be incomplete on a fresh deployment, and text and
 * link flows are unaffected. The message names no variable and no credential.
 */
const signProfilePhotoUpload = async (req, res) => {
  try {
    res.status(200).json(userService.signProfilePhotoUpload(req.user.uid));
  } catch (error) {
    if (error instanceof CloudinaryConfigurationError) {
      return res.status(503).json({ message: 'Photo uploads are not configured on this server' });
    }

    console.error('Error signing profile photo upload:', error);
    return res.status(500).json({ message: 'Failed to sign upload request' });
  }
};

/**
 * STAGE 12.12. Signs a private resume upload for the caller.
 */
const signResumeUpload = async (req, res) => {
  try {
    res.status(200).json(userService.signResumeUpload(req.user.uid));
  } catch (error) {
    if (error instanceof CloudinaryConfigurationError) {
      return res.status(503).json({ message: 'File uploads are not configured on this server' });
    }

    console.error('Error signing resume upload:', error);
    return res.status(500).json({ message: 'Failed to sign upload request' });
  }
};

/**
 * STAGE 12.12.1. Serves a short-lived signed download URL for the caller's own
 * private resume. The asset id comes from the caller's profile record, never
 * from the request, so a caller can only download a resume they saved.
 *
 * 404 (via sendFailure) when the profile carries no resume, 503 when Cloudinary
 * is not configured -- matching GET /applications/:applicationId/resume/download
 * -- and 500 for anything else.
 */
const downloadResume = async (req, res) => {
  try {
    res.status(200).json(await userService.getProfileResumeDownloadUrl(req.user.uid));
  } catch (error) {
    if (error instanceof CloudinaryConfigurationError) {
      return res.status(503).json({ message: 'File downloads are not configured on this server' });
    }

    return sendFailure(res, error, {
      log: 'Error generating resume download:',
      message: 'Failed to generate resume download',
    });
  }
};

const PAYSTACK_NOT_CONFIGURED_MESSAGE =
  'Paystack is not configured on this server';

const sendPayoutAccountFailure = (res, error, fallbackMessage) => {
  if (error instanceof payoutAccountService.PayoutAccountValidationError) {
    return res.status(400).json({ message: error.message });
  }

  if (error instanceof payoutAccountService.PayoutAccountProviderError) {
    return res.status(502).json({
      message: error.providerMessage || fallbackMessage,
    });
  }

  console.error('Payout account error:', {
    name: error && error.name,
    code: error && error.code,
    statusCode: error && error.statusCode,
    operation: error && error.operation,
  });
  return res.status(500).json({ message: fallbackMessage });
};

const getPayoutBanks = async (req, res) => {
  if (!isPaystackConfigured()) {
    return res.status(503).json({ message: PAYSTACK_NOT_CONFIGURED_MESSAGE });
  }

  try {
    const banks = await payoutAccountService.getSupportedBanks();
    return res.status(200).json({ banks });
  } catch (error) {
    if (error instanceof payoutAccountService.PayoutAccountProviderError) {
      return res.status(502).json({
        message: error.providerMessage || 'Failed to fetch supported banks',
      });
    }
    console.error('Error fetching payout banks:', error);
    return res.status(500).json({ message: 'Failed to fetch supported banks' });
  }
};

const resolvePayoutAccount = async (req, res) => {
  if (!isPaystackConfigured()) {
    return res.status(503).json({ message: PAYSTACK_NOT_CONFIGURED_MESSAGE });
  }

  try {
    const payoutAccount = await payoutAccountService.resolvePayoutAccount(req.body || {});
    return res.status(200).json({ payoutAccount });
  } catch (error) {
    return sendPayoutAccountFailure(
      res,
      error,
      'Failed to verify payout account'
    );
  }
};

const getPayoutAccount = async (req, res) => {
  try {
    const payoutAccount = await payoutAccountService.getPayoutAccountSummary(req.user.uid);
    return res.status(200).json({ payoutAccount });
  } catch (error) {
    console.error('Error reading payout account:', error);
    return res.status(500).json({ message: 'Failed to read payout account' });
  }
};

const updatePayoutAccount = async (req, res) => {
  if (!isPaystackConfigured()) {
    return res.status(503).json({ message: PAYSTACK_NOT_CONFIGURED_MESSAGE });
  }

  try {
    const payoutAccount = await payoutAccountService.savePayoutAccount(req.user.uid, req.body || {});
    return res.status(200).json({ payoutAccount });
  } catch (error) {
    return sendPayoutAccountFailure(
      res,
      error,
      'Failed to save payout account'
    );
  }
};

module.exports = {
  listUsers,
  registerUser,
  registerProfile,
  getUser,
  updateUserProfile,
  signProfilePhotoUpload,
  signResumeUpload,
  downloadResume,
  getPayoutBanks,
  resolvePayoutAccount,
  getPayoutAccount,
  updatePayoutAccount,
};
