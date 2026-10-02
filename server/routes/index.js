var express = require('express');
var router = express.Router();
const { protect } = require('../middleware/auth');

router.get('/', protect, function (req, res, next) {
    res.send('respond with a resource');
});




module.exports = router;
