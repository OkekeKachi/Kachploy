var express = require('express');
var router = express.Router();

const userController = require('../controllers/userController');
const { protect, protectAllowUnverified, requireSelfParam } = require("../middleware/auth");
const { authRateLimiter, uploadRateLimiter } = require('../middleware/rateLimit');

/* GET users listing. */
router.get('/', protect, userController.listUsers);

// STAGE 13 (H2). The one route reachable while the email is still unverified:
// it completes registration and is called by the client immediately after the
// verification link is clicked, when the forced-refresh token may not yet carry
// `email_verified`. Every other route uses `protect`, which now requires the
// claim. See the protectAllowUnverified doc comment in middleware/auth.js.
router.post("/register", authRateLimiter, protectAllowUnverified, userController.registerUser);

router.post('/register-profile', authRateLimiter, protect, userController.registerProfile);

// Profile-photo upload signing. `protect` only, deliberately: the caller's uid --
// the only identity the signature needs -- comes from the verified token, so there
// is no :uid to guard against and no body to validate. The service builds
// `profilePics/{uid}` from req.user.uid, so the signed upload can only land in the
// caller's own folder. Mirrors POST /tasks/:taskId/upload-signature; see
// userController.signProfilePhotoUpload and userService.signProfilePhotoUpload.
router.post('/profile-photo/signature', uploadRateLimiter, protect, userController.signProfilePhotoUpload);

// STAGE 12.12. Resume upload signing for the authenticated caller.
router.post('/resume/signature', uploadRateLimiter, protect, userController.signResumeUpload);

// STAGE 12.12.1. Private resume delivery for the caller's own profile. `protect`
// only: the uid comes from the verified token and selects the profile record, so
// there is no request-supplied id to guard against.
router.get('/resume/download', protect, userController.downloadResume);

// STAGE 5C: `protect` only, and that is now deliberate rather than an oversight.
// Adding requireSelfParam('userId') here would close the cross-user IDOR, but it
// would 403 JobSplitView.jsx, which legitimately looks up `/users/getUser/${job.postedBy}`
// to render the "About the client" panel. So the route stays reachable by any
// authenticated caller and the *response* is scoped instead: userService.getUser
// takes the caller's uid and returns the full document for a self-read, or
// PUBLIC_PROFILE_FIELDS for anyone else. No middleware change is needed because
// there is no new allow/deny decision to express here.
router.get('/payout-account', protect, userController.getPayoutAccount);
router.get('/payout-account/banks', protect, userController.getPayoutBanks);
router.post('/payout-account/resolve', protect, userController.resolvePayoutAccount);
router.put('/payout-account', protect, userController.updatePayoutAccount);

router.get('/getUser/:userId', protect, userController.getUser);

router.put('/update/:uid', protect, requireSelfParam('uid'), userController.updateUserProfile);


module.exports = router;
