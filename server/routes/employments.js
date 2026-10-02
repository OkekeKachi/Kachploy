const express = require('express');
const router = express.Router();
const employmentController = require('../controllers/employmentController');
const { protect, requireSelfParam } = require('../middleware/auth');

// STAGE 7A: the employments resource, mounted at /employments in app.js.
//
// Two read endpoints and no create endpoint. An employment is created as a
// consequence of a hire, inside applicationService, so a client cannot post one;
// there is deliberately no POST here and no route that would let a caller choose
// employerId, employeeId or startDate.
//
// Both reads reuse requireSelfParam('uid'), the guard already used the same way
// by GET /applications/employee/:uid and GET /tasks/employee/:uid: the path
// parameter is compared against the verified token and a mismatch is a 403 with
// no data in the body. That is what stops an employee reading another employee's
// employments and an employer reading another employer's, and it is why the
// service performs no ownership check of its own.
//
// The two paths differ in their first segment, so neither can shadow the other.
router.get('/employee/:uid', protect, requireSelfParam('uid'), employmentController.listEmploymentsForEmployee);
router.get('/employer/:uid', protect, requireSelfParam('uid'), employmentController.listEmploymentsForEmployer);

module.exports = router;