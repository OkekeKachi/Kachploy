const express = require('express');
const router = express.Router();
const paystackWebhookController = require('../controllers/paystackWebhookController');
const { webhookRateLimiter } = require('../middleware/rateLimit');

// STAGE 1L: the Paystack webhook, mounted at /payments/webhook in app.js --
// deliberately BEFORE the token-protected /payments router, and beside it
// rather than inside it, because this route must NOT run `protect`.
//
// WHY NO BEARER TOKEN. The caller is Paystack's server, not a signed-in user;
// it has no Firebase token. Authentication here is the x-paystack-signature
// HMAC over the raw request body, verified in the controller before the body
// is interpreted. Adding `protect` would reject every genuine event with 401
// and defeat the endpoint's entire purpose.
//
// The route is a POST and only a POST. There is no GET/PUT/PATCH/DELETE
// surface: the webhook is a notification, not an editable resource. It performs
// no refund, transfer, payout or escrow action -- it reconciles an EXISTING
// payment record against the provider's verified transaction status and nothing
// else.
router.post('/', webhookRateLimiter, paystackWebhookController.handlePaystackWebhook);

module.exports = router;
