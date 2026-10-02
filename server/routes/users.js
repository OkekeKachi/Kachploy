var express = require('express');
var router = express.Router();

const userController = require('../controllers/userController');
const { protect, requireSelfParam } = require("../middleware/auth");

/* GET users listing. */
router.get('/', protect, userController.listUsers);

router.post("/register", protect, userController.registerUser);

router.post('/register-profile', protect, userController.registerProfile);

// STAGE 5C: `protect` only, and that is now deliberate rather than an oversight.
// Adding requireSelfParam('userId') here would close the cross-user IDOR, but it
// would 403 JobSplitView.jsx, which legitimately looks up `/users/getUser/${job.postedBy}`
// to render the "About the client" panel. So the route stays reachable by any
// authenticated caller and the *response* is scoped instead: userService.getUser
// takes the caller's uid and returns the full document for a self-read, or
// PUBLIC_PROFILE_FIELDS for anyone else. No middleware change is needed because
// there is no new allow/deny decision to express here.
router.get('/getUser/:userId', protect, userController.getUser);

router.put('/update/:uid', protect, requireSelfParam('uid'), userController.updateUserProfile);


module.exports = router;
