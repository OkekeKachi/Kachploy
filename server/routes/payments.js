const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const {
  protect,
  requireContractParty,
  requireContractPaymentEmployer,
  requireMilestoneEmployer,
  requireMilestoneParty,
} = require('../middleware/auth');
const { paymentRateLimiter } = require('../middleware/rateLimit');

// STAGE P2: the payments resource, mounted at /payments in app.js. This is
// the payment-RECORD foundation plus, since Stage 1F, Test Mode
// INITIALIZATION against Paystack and, since Stage 1G, verification of the
// initialized transaction.
//
// WHAT A 200 MEANS, PER ROUTE.
//   POST /               the employer's payment REQUEST is stored (status
//                        'created'). No provider was contacted.
//   POST /initialize     the stored record was sent to Paystack in Test Mode
//                        and a validated hosted-checkout URL came back. It is
//                        NOT proof of a charge -- verification is a later
//                        stage, and an ambiguous provider outcome answers 500
//                        with the record left 'pending'.
//   POST /verify         Paystack was asked to verify the deterministic
//                        reference and the one approved status transition was
//                        applied. An unconfirmed outcome (transport/timeout/
//                        5xx) answers 500 with the record left untouched; an
//                        already-paid record answers 200 with no provider call.
//   GET  /milestone/:id  the stored record, by either contract party.
//
// AUTHORIZATION: every route is party-scoped and all the decisions are made
//   in the guards rather than in the controller:
//   requireMilestoneEmployer  POST   only the employer on the milestone's
//                                    contract may initiate, initialize or
//                                    verify. Body-based (milestoneId), because
//                                    the milestone being paid is the subject
//                                    of the request. Also refuses a missing
//                                    milestone (404), a missing contract
//                                    (404) and anyone else (403).
//   requireMilestoneParty     GET    either party to the milestone's contract
//                                    may read the record.
//
// ELIGIBILITY IS THE SERVICE'S, NOT THE GUARD'S. Contract active, employment
// active and task approved are domain rules about the lifecycle of the
// resources, so they are 400s from paymentService, exactly as a contract's
// status check is a 400 from contractService rather than a guard 403.
//
// ROUTE ORDER. '/milestone/:milestoneId' is a two-segment path with a fixed
// first word; it is registered before any future '/:paymentId' pattern could
// exist, matching the contracts router's ordering. '/initialize' and '/verify'
// are likewise fixed single-segment paths -- they collide with nothing, and a
// payment document's id IS its milestone id, so a '/:paymentId' route would be
// the same lookup under a different name.
//
// NO CANCEL, NO REFUND, NO PUT/PATCH/DELETE. A stored payment request is not
// editable; those transitions are not implemented. Verification (POST /verify)
// and reconciliation (the separately mounted, signature-verified webhook) are
// present. The webhook is mounted before this router, outside `protect`.
// The caller's own payment history. No user id is accepted: ownership is read
// from the verified token and applied inside the service. Registered before the
// contract/milestone routes because it is a fixed one-segment path.
router.get('/history', protect, paymentController.getPaymentHistory);

router.post('/contract', paymentRateLimiter, protect, requireContractPaymentEmployer, paymentController.initiateContractPayment);
router.post('/contract/initialize', paymentRateLimiter, protect, requireContractPaymentEmployer, paymentController.initializeContractPayment);
router.post('/contract/verify', paymentRateLimiter, protect, requireContractPaymentEmployer, paymentController.verifyContractPayment);
router.get('/contract/:contractId', protect, requireContractParty, paymentController.getPaymentForContract);

router.post('/', paymentRateLimiter, protect, requireMilestoneEmployer, paymentController.initiatePayment);
router.post('/initialize', paymentRateLimiter, protect, requireMilestoneEmployer, paymentController.initializePayment);
router.post('/verify', paymentRateLimiter, protect, requireMilestoneEmployer, paymentController.verifyPayment);
router.get('/milestone/:milestoneId', protect, requireMilestoneParty, paymentController.getPaymentForMilestone);

module.exports = router;
