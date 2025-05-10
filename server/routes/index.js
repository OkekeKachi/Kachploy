var express = require('express');
var router = express.Router();
const { admin, db } = require("../config/firebase");

router.get('/', function (req, res, next) {
    res.send('respond with a resource');
});




module.exports = router;
