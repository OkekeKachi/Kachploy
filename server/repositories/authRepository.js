// authRepository.js
//
// Gateway for the Firebase Authentication Admin SDK surface (new in Stage 4E).
// It owns the Auth mutations that used to be issued inline from userService.js.
//
// SCOPE -- the complete inventory of live Firebase Auth calls in the server:
//   * admin.auth().updateUser()   -- two call sites in userService (the
//     displayName/phoneNumber write in registerUser and the photoURL write in
//     updateUserProfile). Both are extracted here as one narrow operation.
//   * admin.auth().verifyIdToken() -- one call site, middleware/auth.js `protect`.
//     It is deliberately NOT here; see below.
// There are no createUser, deleteUser, getUser or setCustomUserClaims calls
// anywhere in the server, so none are invented here. The only other references
// to those methods are the test double in testing/fakeFirestore.js and the
// commented-out lines in controllers/userController.js, neither of which is
// live code.
//
// WHY verifyIdToken STAYS IN MIDDLEWARE: token verification is authentication
// infrastructure, not a profile mutation, and its single caller is `protect`,
// which owns three coupled concerns -- decoding the `Bearer` header, attaching
// the claims to req.user, and answering 401 `Unauthorized` / 401 `Invalid token`
// in plain text. Routing it through a repository would either push HTTP concerns
// down into the gateway or pull the `protect` boundary up into a data layer,
// without making either side clearer. Authorization itself also stays in
// middleware: the guards decide ownership from the verified uid, and nothing here
// is involved. A future stage can revisit the split if a second token consumer
// appears.
//
// This layer holds no business logic and no HTTP concerns. It knows nothing
// about requests, responses, status codes, profiles, roles, allow-lists or
// authorization, and it raises no error of its own: whatever the Auth SDK throws
// -- including auth/user-not-found, which surfaces as the existing 500 --
// propagates unchanged to the caller. Which attributes to write, and what a
// missing displayName means, stay decisions in userService.
//
// Sequencing is untouched. registerUser still writes Auth and then Firestore,
// updateUserProfile still writes Auth and then Firestore, both as two separate
// unsynchronised operations with no rollback, no retry and no compensation. The
// partial-failure window this leaves is intentionally preserved: no transaction
// can span the Auth surface and Firestore, and adding one is out of scope.

const { admin } = require('../config/firebase');

/**
 * Applies an attributes patch to an Auth user record.
 *
 * A plain delegation: the caller owns the payload and the ordering relative to
 * its Firestore write, and the SDK error is allowed through untouched.
 */
const updateAuthUser = (uid, attributes) => admin.auth().updateUser(uid, attributes);

module.exports = {
    updateAuthUser,
};
