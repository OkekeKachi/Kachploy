// userRepository.js
//
// Data-access layer for the `users` collection (new in Stage 4D). It owns the
// direct Firestore calls for that one collection which used to sit inside
// userService.js: the existence read performed twice by the registration and
// profile-update paths, the two `set` writes and the profile `update`.
//
// SCOPE: the `users` collection only, and only the calls made by userService.
// Nothing outside this collection is reached from here: the Firestore reads
// middleware/auth.js performs against `jobs` and `applications` are unaffected,
// and the commented-out users read still sitting in userController is dead code
// that Stage 4D does not touch.
//
// Firebase Auth is NOT here. updateUser (profilePic, displayName, phoneNumber)
// is a separate persistence surface and moved to authRepository in Stage 4E;
// verifyIdToken belongs to middleware/auth.js `protect` and was never in
// userService. The two stores are also not synchronised here: registerUser
// and updateUserProfile still perform their Auth write and their Firestore write
// as two unsynchronised operations in the order they have always used, because
// no transaction can span the two surfaces and adding one would change the
// observable behaviour.
//
// This layer holds no business logic. It knows nothing about HTTP, status codes,
// controllers, Express, tokens or authorisation, and it raises no error of its
// own: reads hand back the raw DocumentSnapshot, including `exists`, so
// userService keeps ownership of every UserNotFoundError decision, of the
// `{ alreadyExists: true }` registration branch and of the "no fields to write"
// guard. The ALLOWED_PROFILE_FIELDS filter, the phone formatting, the two
// registration document shapes and the `console.log` calls are all service
// concerns and stay there. User data is never normalised on the way through:
// each payload arrives fully shaped by the service and is written as given.
//
// No transactions and no batches are used, because none were used before this
// extraction and adding any would change the write ordering.
//
// Timestamps are not generated here. userService decides what a created/updated
// value is, because the value type is users behaviour: serverTimestamp() here,
// an ISO string in jobService and a raw Date in taskService.

const { db } = require('../config/firebase');

/**
 * Reads one user document.
 *
 * Returns the raw snapshot -- including `exists` and `id` -- so the caller
 * decides what a missing document means. No NotFound error is raised here, and
 * the two `exists` checks that consume this (registerUser, updateUserProfile)
 * stay in the service.
 *
 * QUIRK (preserved): the profile read behind getUser was issued through the
 * `admin.firestore()` handle while every other user write used `db`. Those are
 * the same handle by construction -- config/firebase.js exports
 * `db = admin.firestore()` -- so the data and the returned snapshot are
 * identical; only the module-level handle differs, and consolidating on `db`
 * changes nothing observable.
 */
const getUserById = (userId) => db.collection('users').doc(userId).get();

/**
 * Creates a user document under the caller's uid and replaces any existing
 * content.
 *
 * A non-merge `.set()`, exactly as before: registerUser relies on this being a
 * full write, not an upsert. The document id is the uid rather than a
 * Firestore-generated one, which is why the uid is an argument here -- the
 * profile reads in getUser and the registration/registration-profile split all
 * look the document up by uid, so an auto-generated id would not be found.
 */
const createUserDoc = (uid, data) => db.collection('users').doc(uid).set(data);

/**
 * Writes a profile over an existing (or not yet existing) document.
 *
 * `merge: true` is preserved: this never removes fields, and a body field
 * explicitly set to undefined still overwrites the stored value.
 */
const mergeUserDoc = (uid, data) => db.collection('users').doc(uid).set(data, { merge: true });

/**
 * Applies a partial update to an existing user document.
 *
 * No existence read is performed here; callers that need one ask for the
 * document first via getUserById. The service's "nothing to write" guard is also
 * left there, so no update call is issued when the allow-list yields no fields.
 */
const updateUserFields = (uid, data) => db.collection('users').doc(uid).update(data);

module.exports = {
    getUserById,
    createUserDoc,
    mergeUserDoc,
    updateUserFields,
};
