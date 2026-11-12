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

const crypto = require('crypto');
const { admin } = require('../config/firebase');
const userRepository = require('../repositories/userRepository');
const authRepository = require('../repositories/authRepository');
// Cloudinary signing for profile-photo uploads. `signUploadRequest` is the same
// one-shot signer task submissions use (config/cloudinary.js); the api secret is
// read and used inside that module and never returned here.
const {
    signUploadRequest,
    generateSignedDownloadUrl,
    verifyUploadedAsset,
    deleteUploadedAsset,
    qualifyFolder,
} = require('../config/cloudinary');

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
  // STAGE 12.11. Employees can store a private resume reference on their profile
  // for reuse on applications. The shape is `{ publicId, name, resourceType }`
  // and there is no `url` -- that keeps it unexposed and consistent with the
  // application-side resume reference.
  'resume',
  'savedJobs',
];

/**
 * The referenced user document does not exist. Surfaces as a 404.
 *
 * Both call sites use the same wording, "User not found", so the message is
 * carried on the instance rather than hard-coded here.
 */
class UserNotFoundError extends Error {}

/**
 * A supplied profile field failed its shape check. Surfaces as a 400.
 *
 * Stage 12.6 added the first such check: `savedJobs` must be an array of
 * non-empty strings. This is a distinct class from UserNotFoundError so the
 * controller can answer 400 rather than 404, mirroring how jobService raises
 * JobValidationError for a bad payload.
 */
class UserValidationError extends Error {}

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

  // STAGE 1. Admin authority is a Firebase custom claim, never a document field.
  // Registration must not be able to mint an admin role even as inert profile
  // data, because a later feature reading `users.role` would inherit the lie.
  // Refused before the Auth update, so a rejected registration leaves no orphan.
  if (typeof role === 'string' && role.trim().toLowerCase() === 'admin') {
    throw new UserValidationError('The admin role cannot be self-assigned');
  }

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

  // Extract profilePic from userData so it can be written to both stores. The
  // public id is extracted alongside it (STAGE 12.14) so it is not swept up by the
  // allow-list loop below: unlike an ordinary field it is validated, and unlike
  // profilePic it is stored to Firestore only.
  const { profilePic, profilePicPublicId, ...rest } = userData;

  // STAGE 12.6: `savedJobs` is the one allow-listed field whose value the rest
  // of the app then trusts as identifiers -- JobSplitView.jsx builds a Set from
  // it and compares job ids. A malformed value (a bare string, a number, an
  // array holding non-strings or blanks) would either silently fail to match or
  // corrupt the stored list, so it is rejected here rather than written. The
  // allow-list still filters *which* keys are accepted; this checks the shape of
  // the one that carries semantics.
  if (Object.prototype.hasOwnProperty.call(rest, 'savedJobs')) {
    const savedJobs = rest.savedJobs;
    const isValidSavedJobs =
      Array.isArray(savedJobs) &&
      savedJobs.every((jobId) => typeof jobId === 'string' && jobId.trim().length > 0);

    if (!isValidSavedJobs) {
      throw new UserValidationError('savedJobs must be an array of non-empty string job IDs');
    }
  }

  // STAGE 12.11. Validate a profile-stored resume reference. When present, it
  // must be an object with { publicId, name, resourceType } and resourceType must
  // be 'raw'. The field is optional: absent leaves it alone. No `url` is accepted
  // or stored.
  if (Object.prototype.hasOwnProperty.call(rest, 'resume')) {
    const resumeVal = rest.resume;
    if (resumeVal !== null && resumeVal !== undefined) {
      const isValid =
        resumeVal &&
        typeof resumeVal === 'object' &&
        !Array.isArray(resumeVal) &&
        typeof resumeVal.publicId === 'string' &&
        resumeVal.publicId.trim().length > 0 &&
        typeof resumeVal.name === 'string' &&
        resumeVal.name.trim().length > 0 &&
        resumeVal.resourceType === 'raw';
      if (!isValid) {
        throw new UserValidationError('resume must be a valid private resume reference');
      }
      rest.resume = {
        publicId: resumeVal.publicId.trim(),
        name: resumeVal.name.trim(),
        resourceType: 'raw',
      };

      // STAGE 12.13. Shape is checked above; provenance is checked here. The
      // reference must name a file under the caller's own `resumes/{uid}/`
      // folder AND that file must exist in Cloudinary before it is stored. See
      // verifyOwnedResume below for why both are needed.
      await verifyOwnedResume(rest.resume, uid);
    }
    // If null is passed, allow-list will write null; preserving behavior.
  }

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
  //
  // STAGE 12.14. When the caller also supplies the Cloudinary public id of the
  // photo it just uploaded, it is stored beside the URL so a future replacement can
  // delete the asset this one supersedes without having to re-derive the id from
  // the URL. It is kept only when it names an asset under the caller's own
  // `profilePics/{uid}/` folder -- a malformed or foreign id is dropped rather than
  // stored, so no later cleanup can be pointed at an asset this account does not
  // own. The field is optional: an older client that sends only the URL still gets
  // its profilePic written, exactly as before.
  const incomingProfilePicPublicId =
    typeof profilePicPublicId === 'string' ? profilePicPublicId.trim() : '';

  const isLegitimateProfilePhotoUrl = (url, userId) => {
    if (typeof url !== 'string' || url.trim() === '') return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.hostname !== 'res.cloudinary.com') return false;
    const folder = profilePhotoFolder(userId);
    const marker = `/${folder}/`;
    const idx = parsed.pathname.indexOf(marker);
    if (idx === -1) return false;
    let candidate = parsed.pathname.slice(idx + 1);
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return false;
    }
    candidate = candidate.replace(/\.[^./]+$/, '');
    if (!candidate.startsWith(`${folder}/`) || candidate.includes('..')) return false;
    return true;
  };

  let newProfilePicPublicId = '';
  if (incomingProfilePicPublicId) {
    if (!isOwnedProfilePhoto(incomingProfilePicPublicId, uid)) {
      throw new UserValidationError('profilePicPublicId must reference an asset owned by this user');
    }
    newProfilePicPublicId = incomingProfilePicPublicId;
  }


  let profilePicValidationError = null;
  if (profilePic && !isLegitimateProfilePhotoUrl(profilePic, uid)) {
    profilePicValidationError = new UserValidationError('profilePic must be a legitimate uploaded profile photo for this user');
  }
  if (profilePicValidationError) {
    throw profilePicValidationError;
  }

  if (profilePic) {
    firestoreData.profilePic = profilePic;

    if (newProfilePicPublicId) {
      firestoreData.profilePicPublicId = newProfilePicPublicId;
    } else {
      const derived = deriveProfilePhotoPublicId(profilePic, uid);
      if (derived && isOwnedProfilePhoto(derived, uid)) {
        firestoreData.profilePicPublicId = derived;
      }
    }
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

  // STAGE 12.14. Only once BOTH writes have succeeded is the photo this update
  // replaced removed from Cloudinary. `userSnap` still holds the document as it was
  // read at the top, so the target is the previously stored value and never anything
  // from the request. Nothing here runs when no new photo was supplied, and the
  // delete logs and swallows its own failures, so a cleanup problem cannot fail an
  // update that has already been committed.
  if (profilePic) {
    await deleteReplacedProfilePhoto(uid, userSnap.data(), {
      url: profilePic,
      publicId: newProfilePicPublicId,
    });
  }
};

/**
 * The Cloudinary resource type a profile photo is uploaded as.
 *
 * `image`, not `raw`: a profile photo is a renderable picture, and the image
 * resource class is what makes Cloudinary reject a non-image (a text file posted
 * to the image endpoint fails) and what produces the delivery URL the avatar
 * components already render. The task-submission signer uses `raw` for the
 * opposite reason; the two must not be confused, which is why this constant is
 * named here rather than reused from taskService.
 *
 * Exported for the client, which names the same type when it builds the upload URL,
 * and returned by signProfilePhotoUpload so the client never has to guess it.
 */
const PROFILE_PHOTO_RESOURCE_TYPE = 'image';

/**
 * The image formats a profile photo may be uploaded as.
 *
 * Signed into the upload request, so Cloudinary enforces it server-side: a file
 * whose format is not on this list is refused before it is stored, even though the
 * bytes travel straight from the browser and never through this API. Kept to the
 * three common web image formats rather than an open list. The value is returned to
 * the client because a signed parameter must be echoed back unchanged or Cloudinary
 * rejects the signature.
 */
const PROFILE_PHOTO_FORMATS = 'jpg,jpeg,png,webp';

/**
 * The image formats a resume may be uploaded as.
 * Resumes must be PDF files initially.
 */
const RESUME_FORMATS = 'pdf';

/**
 * The resource type for resume uploads. A resume is a document, so `raw` is the
 * appropriate class and avoids public image transformations.
 */
const RESUME_RESOURCE_TYPE = 'raw';

/**
 * The folder one user's profile photos are uploaded into.
 *
 * `profilePics/{uid}` -- the same prefix the Firebase Storage upload used, kept so
 * an operator inspecting the media library sees the same layout the code used to
 * write. Built from the caller's token-derived uid and never from the request, so
 * the signature covers "this user's folder" and no client can point its upload at
 * another account. See signProfilePhotoUpload.
 */
const profilePhotoFolder = (uid) => qualifyFolder(`profilePics/${uid}`);

/**
 * STAGE 12.14. Recovers the Cloudinary public id from a stored profile-photo URL,
 * but ONLY when it can be read back safely.
 *
 * The profile document has always stored a `profilePic` delivery URL and, before
 * this stage, never the public id that URL addresses. A Cloudinary image URL has
 * the shape `https://res.cloudinary.com/{cloud}/image/upload/{publicId}.{ext}`
 * (optionally with transformation segments before the id), so the id can be
 * recovered from the path -- but only when every check passes:
 *
 *   * the host is `res.cloudinary.com`, so the URL is one of ours to delete
 *   * the path contains the caller's own `/profilePics/{uid}/` folder, so this can
 *     never derive another user's asset
 *   * the candidate keeps that folder as a real prefix and holds no `..` segment
 *
 * Returns the public id (folder + name, extension stripped) or null when any check
 * fails. Callers must treat null as "not safely identifiable" and delete nothing:
 * a profile such as the fixtures' `https://example.test/p.png`, or any URL from a
 * different host, is left alone rather than guessed at.
 */
const deriveProfilePhotoPublicId = (url, uid) => {
  if (typeof url !== 'string' || url.trim() === '') return null;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== 'res.cloudinary.com') return null;

  const folder = profilePhotoFolder(uid);
  const marker = `/${folder}/`;
  const index = parsed.pathname.indexOf(marker);
  if (index === -1) return null;

  let candidate = parsed.pathname.slice(index + 1);
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return null;
  }

  // A delivery URL carries a format extension; a public id does not.
  candidate = candidate.replace(/\.[^./]+$/, '');

  if (!candidate.startsWith(`${folder}/`)) return null;
  if (candidate.includes('..')) return null;

  return candidate;
};

/**
 * STAGE 12.14. True when a public id names an asset under the caller's own
 * `profilePics/{uid}/` folder. Shared by the write validation and the cleanup
 * path so the ownership string checks live in one place.
 */
const isOwnedProfilePhoto = (publicId, uid) => {
  if (typeof publicId !== 'string' || publicId.trim() === '') return false;

  const folder = profilePhotoFolder(uid);
  return publicId.startsWith(`${folder}/`) && !publicId.includes('..');
};

/**
 * STAGE 12.14. Deletes the profile photo a user has just replaced.
 *
 * Called by updateUserProfile AFTER both the Auth and Firestore writes have
 * succeeded, so a failed profile update never removes the current avatar. The
 * target is always the PREVIOUSLY stored value -- never anything from the request
 * -- and the delete is skipped (removing nothing) whenever it cannot be proven to
 * be this user's own asset:
 *
 *   * there is no previous photo to delete
 *   * the previous photo is the one being written (the same image was re-chosen,
 *     so there is nothing to clean up)
 *   * the previous value is not a Cloudinary URL under `profilePics/{uid}/`,
 *     including a legacy URL from another host
 *
 * A failure from Cloudinary is swallowed and logged: the profile update has
 * already been committed, and a failed cleanup must not turn a success into the
 * error message the user sees. See deleteUploadedAsset for why the delete itself
 * is server-side and never driven by a client-supplied id.
 */
const deleteReplacedProfilePhoto = async (uid, previous, next) => {
  const previousPublicId =
    (typeof previous.profilePicPublicId === 'string' && previous.profilePicPublicId.trim()) ||
    deriveProfilePhotoPublicId(previous.profilePic, uid);

  if (!previousPublicId) return;

  const nextPublicId =
    (typeof next.publicId === 'string' && next.publicId.trim()) ||
    deriveProfilePhotoPublicId(next.url, uid);

  // The user re-selected the same image: there is nothing to clean up.
  if (nextPublicId && nextPublicId === previousPublicId) return;

  // The target must be this user's own asset. Compared here rather than relying on
  // the caller, so a legacy or tampered document cannot point the delete elsewhere.
  if (!isOwnedProfilePhoto(previousPublicId, uid)) return;

  try {
    await deleteUploadedAsset(previousPublicId, { resourceType: PROFILE_PHOTO_RESOURCE_TYPE });
  } catch (error) {
    console.error('Failed to delete replaced profile photo from Cloudinary:', error);
  }
};

/**
 * The folder one user's resumes are uploaded into. Private by naming, and access
 * will be controlled by our download endpoint.
 */
const resumeFolder = (uid) => qualifyFolder(`resumes/${uid}`);

/**
 * Mints the signed payload the browser needs to upload one profile photo to
 * Cloudinary, after the caller has been authenticated.
 *
 * Called from the controller behind `protect` only. There is no ownership guard
 * because there is nothing to own on the request: the folder is derived from the
 * verified token's uid (req.user.uid), which is the whole authorization rule --
 * a user signs an upload for their own folder and for no other, because the
 * signature covers that string and cannot be rewritten without the api secret.
 * The endpoint therefore takes no body and reads no user id from the request.
 *
 * WHY THE PUBLIC ID IS MINTED HERE, like the task signer: the client supplies no
 * path, folder or name of its own, so there is nothing it could set to redirect the
 * upload at another user's folder or reuse the signature for a second target. The
 * random suffix keeps a replaced avatar from colliding with the one it replaces
 * (Cloudinary's default `overwrite: false` would otherwise refuse a reused id), and
 * it means the returned secure_url is unique per upload rather than a stable URL a
 * browser would serve from cache.
 *
 * Returns exactly what the browser needs: the cloud and key to address, the
 * timestamp and signature that make the request acceptable, the folder and public
 * id the signature covers, the resource type that selects the upload endpoint, and
 * the allowed formats that were signed in. The api secret never leaves
 * config/cloudinary and is not part of this object.
 *
 * Throws CloudinaryConfigurationError when the environment is incomplete; the
 * controller turns that into a 503.
 */
const signProfilePhotoUpload = (uid) => {
  const folder = profilePhotoFolder(uid);
  const publicId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

  const signed = signUploadRequest({
    folder,
    public_id: publicId,
    allowed_formats: PROFILE_PHOTO_FORMATS,
  });

  return {
    cloudName: signed.cloudName,
    apiKey: signed.apiKey,
    timestamp: signed.timestamp,
    signature: signed.signature,
    folder,
    publicId,
    resourceType: PROFILE_PHOTO_RESOURCE_TYPE,
    allowedFormats: PROFILE_PHOTO_FORMATS,
  };
};

/**
 * STAGE 12.12. Mints a signed upload payload for a private resume. The upload
 * must go to the caller's own resume folder, use resource type `raw`, and allow
 * only PDF. The signature covers folder, public_id and allowed_formats.
 */
const signResumeUpload = (uid) => {
  const folder = resumeFolder(uid);
  const publicId = `resume-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

  const signed = signUploadRequest({
    folder,
    public_id: publicId,
    allowed_formats: RESUME_FORMATS,
  });

  return {
    cloudName: signed.cloudName,
    apiKey: signed.apiKey,
    timestamp: signed.timestamp,
    signature: signed.signature,
    folder,
    publicId,
    resourceType: RESUME_RESOURCE_TYPE,
    allowedFormats: RESUME_FORMATS,
  };
};

/**
 * Build a private resume reference from stored values. No URL allowed.
 */
const buildPrivateResumeRef = (resume) => {
  if (!resume || typeof resume !== 'object' || Array.isArray(resume)) return null;
  const publicId = typeof resume.publicId === 'string' ? resume.publicId.trim() : '';
  const name = typeof resume.name === 'string' ? resume.name.trim() : '';
  const resourceType = typeof resume.resourceType === 'string' ? resume.resourceType.trim() : '';
  if (!publicId || !name || resourceType !== RESUME_RESOURCE_TYPE) return null;
  return { publicId, name, resourceType };
};

/**
 * STAGE 12.13. Confirms a profile resume reference names a real file the caller
 * owns before it is persisted. Mirrors applicationService.verifyOwnedResume; the
 * two live on their own services because each resource has its own error class
 * and its own validation wording.
 *
 * OWNERSHIP: an upload this server signed for the caller is stored under
 * `resumes/{uid}/` (resumeFolder below), so the public id the browser hands back
 * must begin with that string. A reference naming another folder -- including
 * one that only passes a naive prefix test via a `..` segment -- is rejected.
 * EXISTENCE: verifyUploadedAsset confirms Cloudinary actually holds the asset,
 * so a hand-made id cannot be stored to 404 on every later download.
 *
 * Throws UserValidationError (a 400) for either failure. An unconfigured server
 * (CloudinaryConfigurationError from verifyUploadedAsset) propagates as a 500:
 * it could not have signed the upload in the first place.
 */
const verifyOwnedResume = async (reference, uid) => {
  const prefix = `${resumeFolder(uid)}/`;

  if (!reference.publicId.startsWith(prefix) || reference.publicId.includes('..')) {
    throw new UserValidationError('Resume does not belong to you');
  }

  const exists = await verifyUploadedAsset(reference.publicId, { resourceType: RESUME_RESOURCE_TYPE });
  if (!exists) {
    throw new UserValidationError('Resume file could not be found');
  }
};

/**
 * Generate a short-lived signed download URL for a private resume reference.
 * Throws CloudinaryConfigurationError if not configured.
 */
const getResumeDownloadUrl = (resumeRef) => {
  const ref = buildPrivateResumeRef(resumeRef);
  if (!ref) throw new UserValidationError('Invalid resume reference');
  const url = generateSignedDownloadUrl(ref.publicId, { expiresInSeconds: 300 });
  return { url, name: ref.name };
};

/**
 * STAGE 12.12.1. Reads the caller's own stored resume reference and mints a
 * short-lived signed download URL for it.
 *
 * The asset id is never taken from the request: it is read from the caller's own
 * profile document, selected by the uid on the verified token, so an account can
 * only ever sign a download for a resume it saved. Throws UserNotFoundError
 * ('Resume not found') when the profile carries no valid resume, so the
 * controller answers 404 through the existing sendFailure path. A missing
 * profile is likewise a UserNotFoundError ('User not found'). Cloudinary's
 * CloudinaryConfigurationError is left to propagate for the controller's 503.
 */
const getProfileResumeDownloadUrl = async (uid) => {
  const userSnap = await userRepository.getUserById(uid);
  if (!userSnap.exists) {
    throw new UserNotFoundError('User not found');
  }

  const reference = buildPrivateResumeRef(userSnap.data().resume);
  if (!reference) {
    throw new UserNotFoundError('Resume not found');
  }

  const url = generateSignedDownloadUrl(reference.publicId, { expiresInSeconds: 300 });
  return { url, name: reference.name };
};

module.exports = {
  ALLOWED_PROFILE_FIELDS,
  PUBLIC_PROFILE_FIELDS,
  UserNotFoundError,
  UserValidationError,
  registerUser,
  registerProfile,
  getUser,
  updateUserProfile,
  signProfilePhotoUpload,
  signResumeUpload,
  buildPrivateResumeRef,
  getResumeDownloadUrl,
  getProfileResumeDownloadUrl,
  PROFILE_PHOTO_RESOURCE_TYPE,
  PROFILE_PHOTO_FORMATS,
  RESUME_RESOURCE_TYPE,
  RESUME_FORMATS,
};
