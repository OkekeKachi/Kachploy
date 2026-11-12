'use strict';

// paymentController.js
//
// HTTP layer for the payments resource (new in Stage P2). Express handlers,
// each doing only the three things every controller in this codebase does:
// read the request, call exactly one paymentService function, and translate
// the outcome into a status code and body.
//
// The handlers cover milestone and full-contract initiation, initialization
// (Stage 1F: send the stored record to Paystack in Test Mode and return the
// hosted checkout URL), verification (Stage 1G: ask Paystack to verify the
// current attempt's reference and apply the one approved status transition), the
// party-scoped payment reads, and the read-only payment history (whose owner is
// derived from the verified token inside its service). The payment-record
// handlers are party-authorised by a router guard before they run, so no
// handler here re-derives ownership, and no
// handler reads an identity, an amount, a currency or a commission figure from
// the request body: those are copied from stored documents in the service, and
// the acting uid reaches the service from req.user, which protect populated
// from the verified token.
//
// WHAT THIS CONTROLLER DELIBERATELY DOES NOT DO
//   * It has no cancel, refund, transfer or webhook handler, and no
//     PUT/PATCH/DELETE surface -- those provider-status transitions belong to
//     later stages. A 200 from initialize means the provider accepted the
//     initialization and the returned URL was validated; it is NOT proof that
//     the employer was charged or that the employee was paid. A 200 from
//     verify means the deterministic reference was checked against the
//     provider and a status was applied -- a 500 there means the outcome is
//     UNCONFIRMED, not that the payment failed.
//   * It never returns a provider error body, an access code, an
//     Authorization header or any secret -- only the whitelisted fields the
//     initialize handler assembles, or the static safe messages below.
//   * It does not touch contracts, milestones, tasks or employments. The
//     initiate path reads all four (through the guard and the service) and
//     writes to `payments` only -- one document, once.

const paymentService = require('../services/paymentService');
const paymentHistoryService = require('../services/paymentHistoryService');
const { PaystackConfigurationError } = require('../config/paystack');

/**
 * Maps a service failure onto the HTTP response.
 *
 * The same helper the other controllers use, extended for Stage 1F.
 * Validation failures are turned into a 400 and skip the console.error -- a
 * request the caller got wrong is not a server fault -- and not-found
 * failures into a 404, which for the read route is the normal "no payment
 * initiated yet" outcome as well as a backstop behind the router guard's own
 * 404s. A missing/invalid Test Mode key is a 503, exactly as an unconfigured
 * Cloudinary is in the upload controllers: the server is missing a
 * dependency, the request is fine. Every other failure -- including the
 * ambiguous provider outcomes PaymentProviderError represents -- is the
 * generic 500 with a static message; the underlying error (with its
 * non-enumerable cause) reaches the log line, never the client.
 */
const sendFailure = (res, err, { log, message }) => {
    if (
        err instanceof paymentService.PaymentValidationError ||
        err instanceof paymentHistoryService.PaymentHistoryValidationError
    ) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof paymentService.PaymentNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (err instanceof PaystackConfigurationError) {
        return res.status(503).json({ message: 'Payment processing is not configured on this server' });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * POST /payments
 *
 * Guarded by requireMilestoneEmployer in the router, which has already loaded
 * the milestone named by body.milestoneId, refused a missing one with a 404,
 * refused a caller who is not the employer on that milestone's contract with
 * a 403, and attached both documents. So the milestone and contract this
 * handler hands to the service are proven to exist and to belong to the
 * caller as employer -- and every identity and money figure on the stored
 * record is copied from those documents, never from the body.
 *
 * Responds 200, matching every other create in this API. `{ message, payment }`
 * where payment is the stored record re-read (so createdAt is a real
 * Timestamp). An idempotent replay of the same key answers 200 with the SAME
 * stored record and the message 'Payment already recorded'. A 200 here is NOT
 * proof that money moved -- see the file header.
 */
const initiatePayment = async (req, res) => {
    try {
        const { payment, replayed } = await paymentService.initiatePayment({
            milestone: req.milestone,
            contract: req.contract,
            actorUid: req.user.uid,
            payload: req.body,
        });

        res.status(200).json({
            message: replayed ? 'Payment already recorded' : 'Payment record created successfully',
            payment,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating payment record:',
            message: 'Failed to create payment record',
        });
    }
};

/**
 * POST /payments/initialize
 *
 * STAGE 1F. Guarded by requireMilestoneEmployer exactly like initiate, so the
 * milestone and contract are proven and attached and the caller is the
 * employer. The service re-reads the payment record itself; the handler
 * passes through nothing from the body except what the service validates.
 *
 * Responds 200 with a strict whitelist -- { message, paymentId, reference,
 * status, amountMinor, feeMinor, chargeMinor, currency, checkoutUrl } -- and
 * nothing else: no access code, no authorization object, no raw provider
 * payload, no provider error text. A 500 here means the outcome is
 * UNCONFIRMED, not that the payment failed; the record is left 'pending' for
 * the verification stage.
 */
const initializePayment = async (req, res) => {
    try {
        const result = await paymentService.initializePaymentForMilestone({
            milestone: req.milestone,
            contract: req.contract,
            payload: req.body,
        });

        res.status(200).json({
            message: 'Payment initialization successful',
            ...result,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error initializing payment:',
            message: 'Failed to initialize payment',
        });
    }
};

/**
 * POST /payments/verify
 *
 * STAGE 1G. Guarded by requireMilestoneEmployer exactly like initialize, so
 * the milestone and contract are proven and attached and the caller is the
 * employer. The service re-reads the payment record, resolves the current
 * attempt's reference, asks Paystack to verify it, validates the response
 * against the trusted expectation, and applies the one approved transition.
 *
 * Responds 200 with a strict whitelist -- { message, verified, payment } where
 * payment is the safe record projection -- and nothing else: no access code,
 * no authorization object, no raw provider payload, no provider error text. An
 * already-paid record answers 200 without a provider call. A 500 means the
 * provider outcome is UNCONFIRMED (transport/timeout/5xx survived the
 * retries), not that the payment failed.
 */
const verifyPayment = async (req, res) => {
    try {
        const result = await paymentService.verifyPaymentForMilestone({
            milestone: req.milestone,
            contract: req.contract,
            payload: req.body,
        });

        res.status(200).json({
            message: 'Payment verification completed',
            ...result,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error verifying payment:',
            message: 'Failed to verify payment',
        });
    }
};

/**
 * GET /payments/milestone/:milestoneId
 *
 * Guarded by requireMilestoneParty, which has loaded the milestone and its
 * contract and refused anyone who is not one of the contract's two parties,
 * so this handler performs no authorization of its own. A valid milestone
 * that has no payment record yet answers 404 from the service -- "no payment
 * initiated yet" is the normal state before an employer initiates one and has
 * no partial body to represent.
 *
 * Responds `{ payment }`.
 */
const getPaymentForMilestone = async (req, res) => {
    try {
        const result = await paymentService.getPaymentForMilestone(req.params.milestoneId);

        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching payment for milestone:',
            message: 'Failed to fetch payment',
        });
    }
};

/** POST /payments/contract -- create the one payment record for a full contract. */
const initiateContractPayment = async (req, res) => {
    try {
        const { payment, replayed } = await paymentService.initiateContractPayment({
            contract: req.contract,
            actorUid: req.user.uid,
            payload: req.body,
        });

        res.status(200).json({
            message: replayed ? 'Payment already recorded' : 'Payment record created successfully',
            payment,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating contract payment record:',
            message: 'Failed to create payment record',
        });
    }
};

/** POST /payments/contract/initialize -- Test Mode checkout for a full contract. */
const initializeContractPayment = async (req, res) => {
    try {
        const result = await paymentService.initializePaymentForContract({
            contract: req.contract,
            payload: req.body,
        });

        res.status(200).json({
            message: 'Payment initialization successful',
            ...result,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error initializing contract payment:',
            message: 'Failed to initialize payment',
        });
    }
};

/** POST /payments/contract/verify -- verify and apply the provider outcome. */
const verifyContractPayment = async (req, res) => {
    try {
        const result = await paymentService.verifyPaymentForContract({
            contract: req.contract,
            payload: req.body,
        });

        res.status(200).json({
            message: 'Payment verification completed',
            ...result,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error verifying contract payment:',
            message: 'Failed to verify payment',
        });
    }
};

/** GET /payments/contract/:contractId -- either contract party may read. */
const getPaymentForContract = async (req, res) => {
    try {
        const result = await paymentService.getPaymentForContract(req.params.contractId);

        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching payment for contract:',
            message: 'Failed to fetch payment',
        });
    }
};

/**
 * GET /payments/history
 *
 * Protected by the verified token only: the caller's uid is the ownership
 * filter, so there is no client-supplied user id or role to authorize. The
 * service reads only records copied with that uid as employer or employee,
 * projects display-safe fields, and returns server-side pagination, filters and
 * an all-time status summary.
 */
const getPaymentHistory = async (req, res) => {
    try {
        const result = await paymentHistoryService.listPaymentHistory({
            uid: req.user.uid,
            query: req.query,
        });

        // Per-user financial data must not be retained by a shared HTTP cache,
        // and a cached page must never be replayed as a current payment status.
        res.set('Cache-Control', 'no-store');
        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching payment history:',
            message: 'Failed to fetch payment history',
        });
    }
};

module.exports = {
    initiatePayment,
    initializePayment,
    verifyPayment,
    getPaymentForMilestone,
    initiateContractPayment,
    initializeContractPayment,
    verifyContractPayment,
    getPaymentForContract,
    getPaymentHistory,
};
