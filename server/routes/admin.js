const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { protect, requireAdmin } = require('../middleware/auth');

// STAGE 1. Every admin route is protected by BOTH guards, in this order: protect
// verifies the ID token and attaches its claims, requireAdmin then insists on the
// `admin === true` custom claim. No route here reads a stored role, and there is no
// bootstrap route that would let a caller grant itself the claim.
router.get('/disputes', protect, requireAdmin, adminController.listDisputes);
router.get('/reviews', protect, requireAdmin, adminController.listReviews);
router.get('/reviews/:taskId', protect, requireAdmin, adminController.getReview);
router.post('/reviews/:taskId/decision', protect, requireAdmin, adminController.decide);

module.exports = router;
