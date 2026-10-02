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

const userService = require('../services/userService');

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
    console.error("Registration error:", err);
    res.status(500).send("Error registering user");
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

module.exports = {
  listUsers,
  registerUser,
  registerProfile,
  getUser,
  updateUserProfile,
};
