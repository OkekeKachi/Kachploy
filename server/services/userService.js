// userService.js
//
// Business and data layer for the users resource (new in Stage 3D). It owned
// every Firestore read/write and every Firebase Auth call that used to live
// inline in controllers/userController.js, including the phone formatting, the
// profile allow-list and the two registration document shapes.
//
// Stage 3D is a structural extraction only. The controller is now HTTP-focused:
// it takes identity from req.user, calls exactly one service function, and
// translates the outcome into the status code and body this API has always
// returned. Nothing observable changes, so the defects below are preserved
// deliberately and stay pinned by test/users.test.js:
//
//   * GET /getUser/:userId is guarded by `protect` only, so any authenticated
//     user can read any other user's profile (uid, email, role, phone)
//   * /register and /register-profile write different document shapes to the
//     same collection, and disagree about where fullName/phone are stored
//   * `createdAt`/`updatedAt` are serverTimestamp() here, an ISO string in
//     jobService and a raw Date in taskService
//   * profilePic (Auth) and the Firestore update are two unsynchronised writes
//     across two services; a transaction cannot span them, and none is
//     attempted -- that is deliberately left for a later stage
//   * the allow-list uses hasOwnProperty, so an explicitly-undefined field still
//     overwrites the stored value
//
// Closed in Stage 5F: the two profile-completion fields. `profileComplete` is now
// the only one written or read, registration always writes it as `false` rather
// than trusting the body, and `isProfileComplete` has been dropped from the
// allow-list. Documents that still carry it are left exactly as they are -- no
// migration, no cleanup job, and the key is inert.
// Stage 4D moved the `users` Firestore I/O out to repositories/userRepository.js.
// What stays here is the business layer -- the allow-list, the phone formatting,
// the two document shapes, the exists/alreadyExists/no-fields-to-write branches
// and the UserNotFoundError decisions.
//
// Stage 4E moved the two Firebase Auth mutations out to
// repositories/authRepository.js, still in the same position relative to the
// Firestore writes: the Auth update happens first, the Firestore write second,
// and neither is rolled back if the other fails. Which attributes are written
// stays here. Token verification remains in middleware/auth.js.
//
// Stage 5C closed the GET /getUser/:userId gap listed above. The route is still
// `protect`-only -- cross-user lookups stay reachable, because JobSplitView.jsx
// needs the job poster's name, avatar, location, join date, rating and bio --
// but getUser now takes the caller's uid and returns PUBLIC_PROFILE_FIELDS for
// anyone other than the subject. See the two lists at the top of this file.
//
// No shared error system is introduced: the single error class below
// exists only so the controller can reproduce the existing 404 body.

const { admin } = require('../config/firebase');
const userRepository = require('../repositories/userRepository');
const authRepository = require('../repositories/authRepository');

// Fields a caller is allowed to change on their own profile. Anything not on
// this list is ignored, so a user cannot escalate their own role or overwrite
// their uid. Lives here from Stage 3D.
//
// STAGE 5F: `isProfileComplete` was on this list and has been removed. Two fields
// represented profile completion; only `profileComplete` was ever read, and the
// client's own completion path (PUT /users/update/:uid) writes it. A retired key
// on this allow-list is not harmless -- being able to write either name is what
// let the two disagree in the first place. The list is now 12 entries.
const ALLOWED_PROFILE_FIELDS = [
  'fullName',
  'phone',
  'profileComplete',
  'skills',
  'address',
  'location',
  'serviceType',
  'bio',
  'yearsOfExperience',
  'availability',
  'companyName',
  'jobTypes',
];

/**
 * The referenced user document does not exist. Surfaces as a 404.
 *
 * Both call sites use the same wording, "User not found", so the message is
 * carried on the instance rather than hard-coded here.
 */
class UserNotFoundError extends Error {}

// Fields readable on someone else's profile, added in Stage 5C.
//
// This is an ALLOW-list, not a deny-list, for the same reason ALLOWED_PROFILE_FIELDS
// is: a field added to the `users` collection later is withheld by default until
// somebody deliberately adds it here, rather than being published until somebody
// remembers to remove it.
//
// Every entry is justified by a field JobSplitView.jsx actually reads off the
// job poster's profile (`response.data.user`, held in `clientInfo`). That is the
// one cross-user caller in the client: the other seven `/users/getUser/:userId`
// call sites all pass the caller's own uid.
//
//   fullName     "About the client" -> clientInfo.fullName      (JobSplitView:416)
//   profilePic   avatar <img src>                               (JobSplitView:404)
//   location     subtitle under the name                        (JobSplitView:417)
//   createdAt    "Member since {date}"                          (JobSplitView:424)
//   rating       reputation block, rendered only when truthy    (JobSplitView:428)
//   reviewCount  "... of 5 stars ({n} reviews)"                 (JobSplitView:432)
//   bio          short self-description under the reputation    (JobSplitView:437)
//
// Deliberately NOT exposed cross-user, though present on the document:
//   uid, email, phone, role, profileComplete, address,
//   companyName, skills, yearsOfExperience, availability, serviceType, jobTypes,
//   updatedAt, and any other field a future write adds.
//
// `location` is the coarse city-level string the job cards already publish
// (`job.location` is served by GET /jobs to every authenticated caller) and is
// distinct from `address`, which is withheld. `createdAt` is reduced to an
// "account age" signal by the consumer itself, which only formats it as a date.
const PUBLIC_PROFILE_FIELDS = [
  'fullName',
  'profilePic',
  'location',
  'createdAt',
  'rating',
  'reviewCount',
  'bio',
];

/**
 * Narrows a user document to PUBLIC_PROFILE_FIELDS.
 *
 * Fields absent from the document stay absent rather than becoming
 * `key: undefined`, so a projected profile is a strict subset of the stored one
 * and the response contains no new keys.
 */
const toPublicProfile = (user) => {
  const publicProfile = {};

  for (const field of PUBLIC_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(user, field)) {
      publicProfile[field] = user[field];
    }
  }

  return publicProfile;
};

/**
 * Registers a user, or reports that they already exist.
 *
 * Returns `{ alreadyExists: true }` when the Firestore document was already
 * present, so the controller can pick between its two 200 bodies.
 *
 * QUIRK (preserved): the Firestore document is created with only `role`,
 * `profileComplete` and `createdAt`. `fullName` and `phone` are written to the
 * Firebase Auth record ONLY -- so the two stores disagree, and a Firestore
 * profile read (getUser) will not show the name that Auth has. The caller's
 * `email` is destructured by the controller and never used at all.
 *
 * STAGE 5F: `profileComplete` is no longer taken from the request body. It used
 * to be destructured from `payload` and written verbatim, which made the flag
 * client-authoritative: a caller could POST /users/register with
 * `profileComplete: true` and skip onboarding for good. Registration now always
 * writes `profileComplete: false`, because a brand-new account has by definition
 * not completed a profile. The profile-completion path
 * (PUT /users/update/:uid, and registerProfile below) is the only thing that may
 * set it to true.
 *
 * QUIRK (preserved): `fullName` is passed straight to the Auth update with no
 * validation, so a missing name clears the Auth displayName.
 *
 * QUIRK (preserved): the Auth update and the Firestore set are two separate
 * writes with no rollback. If the Auth update succeeds and the Firestore write
 * then fails, the Auth record holds a name the profile document does not.
 */
const registerUser = async (uid, payload) => {
  const { fullName, phone, role } = payload;

  // Add the same formatting function as your frontend
  const formatPhoneNumber = (phone) => {
    if (!phone) return phone;

    const digits = phone.replace(/\D/g, '');

    if (digits.length === 10) {
      return `+234${digits}`;
    } else if (digits.length === 11 && digits.startsWith('0')) {
      return `+234${digits.substring(1)}`;
    } else if (digits.length === 13 && digits.startsWith('234')) {
      return `+${digits}`;
    } else if (phone.startsWith('+')) {
      return phone;
    }

    return phone;
  };

  const doc = await userRepository.getUserById(uid);

  if (!doc.exists) {
    await authRepository.updateAuthUser(uid, {
      displayName: fullName,
      phoneNumber: formatPhoneNumber(phone), // Format phone here too!
    });

    await userRepository.createUserDoc(uid, {
      role,
      // STAGE 5F: hardcoded, never read from the body. A new account always
      // starts incomplete; see the doc comment above.
      profileComplete: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log("✅ User registered and profile updated");

    return { alreadyExists: false };
  }

  console.log("👤 User already exists");
  return { alreadyExists: true };
};

/**
 * Saves a profile against an existing (or not yet existing) document.
 *
 * QUIRK (preserved): unlike registerUser, this one DOES persist `uid`, `email`
 * and `fullName` into Firestore and uses `merge: true`, so the two endpoints
 * build different shapes for the same collection. The two overlapping
 * registration paths are a merge candidate for a later stage.
 *
 * `merge: true` means this never removes fields, and a body field explicitly
 * set to undefined will still overwrite the stored value.
 *
 * Note the stored value type: `updatedAt` is a serverTimestamp(), whereas
 * taskService stores a raw Date as createdDate and jobService an ISO string.
 */
const registerProfile = async (uid, email, payload) => {
  const { fullName, phone, location, serviceType, bio } = payload;

    await userRepository.mergeUserDoc(uid, {
      email, uid, fullName, phone, location, serviceType, bio,
      // STAGE 5F: was `isProfileComplete: true`, a field nothing in the codebase
      // ever read. Every consumer -- EmployeeDashboard, EmployerDashboard and
      // yo.jsx -- reads `profileComplete`, so completing a profile through this
      // endpoint used to leave the account still treated as incomplete, bouncing
      // the user back to the onboarding form with no way out. `profileComplete`
      // is the one canonical field, and it is set from the server side here.
      //
      // `isProfileComplete` is no longer written. It is also not deleted from
      // documents that already carry it: no migration, no cleanup job. The key
      // stays inert on old documents and is ignored by every read path.
      profileComplete: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
};

/**
 * Reads one user profile by id.
 *
 * Stage 5C closed the cross-user half of this read. It used to be guarded by
 * `protect` alone and return the whole Firestore document, so any authenticated
 * caller could read any other user's `uid`, `email`, `phone` and `role` by
 * naming them in the path. The route cannot simply become self-only, because
 * JobSplitView.jsx legitimately looks up a job's poster.
 *
 * So the read is kept open and the *response* is scoped by who is asking:
 *
 *   caller === subject  -> the full document, unchanged from before
 *   caller !== subject  -> PUBLIC_PROFILE_FIELDS only
 *
 * `callerUid` is compared, never read from the request body, and the comparison
 * is a plain string match on the token-derived uid the controller passes in. The
 * service owns this because it is data shaping, the same reason it owns
 * ALLOWED_PROFILE_FIELDS.
 *
 * FAIL-CLOSED: a missing or undefined `callerUid` cannot match a path parameter,
 * so the request falls through to the projection rather than to the full
 * document.
 *
 * The 404 is unchanged: a cross-user lookup for a uid with no document still
 * answers `404 'User not found'` rather than being hidden behind a 403. That
 * leaves a user-existence oracle, but it is the documented contract of this
 * endpoint and changing it is out of scope for this stage.
 *
 * QUIRK (preserved): this used to read through `admin.firestore()` while every
 * other function here used the `db` handle. Both are the same handle by
 * construction, and the read now goes through userRepository.getUserById, which
 * uses `db`; the snapshot returned is identical. Left as-is rather than
 * otherwise reconciled.
 *
 * QUIRK (preserved): the `console.log(user)` below still logs whatever was read.
 * It is a pre-existing finding about logging and is not touched here.
 */
const getUser = async (userId, callerUid) => {
  // Fetch user from Firestore
  const doc = await userRepository.getUserById(userId);

  // Check if user exists
  if (!doc.exists) {
    throw new UserNotFoundError('User not found');
  }

  const user = doc.data();  // Get user data
  console.log(user);

  if (userId === callerUid) {
    return user;
  }

  return toPublicProfile(user);
};

/**
 * Applies a profile update for the caller.
 *
 * The allow-list loop is what stops a user from writing `role` or `uid`.
 *
 * QUIRK (preserved): the `hasOwnProperty` check means a field explicitly set to
 * undefined in the body still overwrites the stored value, because it is
 * present in the object. The allow-list filters *which keys* are accepted, not
 * whether their values are defined.
 *
 * QUIRK (preserved): the Auth update and the Firestore update are two separate
 * writes. If the Auth update succeeds and the Firestore update then fails, the
 * two stores are left inconsistent. A transaction cannot span both services, and
 * none is attempted here.
 *
 * STAGE 6N: profilePic now lives in BOTH stores, so an inconsistent outcome can
 * leave Auth `photoURL` and the Firestore `profilePic` disagreeing about the
 * avatar. The two writes are still ordered Auth-then-Firestore and still not
 * atomic; nothing about that is changed here.
 *
 * QUIRK (preserved): when the allow-list yields no fields and no profilePic is
 * supplied, no write happens at all and the caller still gets a 200.
 */
const updateUserProfile = async (uid, userData) => {
  const userSnap = await userRepository.getUserById(uid);

  if (!userSnap.exists) {
    throw new UserNotFoundError('User not found');
  }

  // Extract profilePic from userData so it can be written to both stores.
  const { profilePic, ...rest } = userData;

  const firestoreData = {};
  for (const field of ALLOWED_PROFILE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(rest, field)) {
      firestoreData[field] = rest[field];
    }
  }

  // STAGE 6N: profilePic is now persisted to Firestore as well as Auth.
  //
  // Before this stage it was written to Auth `photoURL` only and deliberately
  // excluded from the Firestore document ("since it's now in Auth"). But every
  // read path -- getUser, and therefore the cross-user public projection --
  // reads Firestore and never Auth, and no client can read another user's Auth
  // record. So `profilePic` was advertised by PUBLIC_PROFILE_FIELDS, consumed by
  // JobSplitView.jsx's "About the client" avatar, and structurally always
  // absent: the placeholder rendered every time. Persisting it here is what
  // makes the Stage 5C contract truthful; PUBLIC_PROFILE_FIELDS and this
  // allow-list are unchanged.
  //
  // The truthiness guard is deliberate and matches the Auth update below: an
  // absent, empty or undefined profilePic changes nothing, so an update that
  // does not mention profilePic behaves exactly as it did before this stage.
  if (profilePic) {
    firestoreData.profilePic = profilePic;
  }

  // Update Firebase Auth user profile if profilePic is provided
  if (profilePic) {
    await authRepository.updateAuthUser(uid, {
      photoURL: profilePic,
    });
  }

  // Update Firestore document (profilePic included when supplied)
  if (Object.keys(firestoreData).length > 0) {
    await userRepository.updateUserFields(uid, firestoreData);
  }
};

module.exports = {
  ALLOWED_PROFILE_FIELDS,
  PUBLIC_PROFILE_FIELDS,
  UserNotFoundError,
  registerUser,
  registerProfile,
  getUser,
  updateUserProfile,
};
