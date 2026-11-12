'use strict';

// paystackWebhookController.js (STAGE 1L)
//
// HTTP layer for the Paystack webhook. One handler, and it is deliberately the
// odd one out among this server's controllers: every other route is
// authenticated by a Firebase bearer token and authorised by a party guard,
// but the webhook arrives from Paystack, not a browser, so it carries no token.
// Its authenticity is proven instead by an HMAC-SHA512 signature over the exact
// raw request body, checked here before anything is parsed or written.
//
// WHAT A 200 MEANS. A 200 says the event was accepted for processing:
//   * a non-actionable event was acknowledged and ignored (nothing to do), or
//   * the payment it named was reconciled (or found already settled).
// It NEVER means "a payment is paid" by itself -- that transition still has to
// pass the full provider re-verification in reconcilePaymentFromWebhook.
//
// WHAT A NON-200 MEANS.
//   * 401 -- the request was not proven to come from Paystack (missing,
//     malformed or wrong signature). Nothing is read from the body and nothing
//     is written. Paystack will retry, and a genuine event signed with the
//     right key will then succeed.
//   * 503 -- the server has no usable Test Mode secret, so it cannot verify ANY
//     signature and fail-closes. Nothing is written.
//   * 500 -- the event was authentic but reconciliation could not be completed
//     (an ambiguous provider outcome that survived its retries). The record is
//     left untouched and the non-2xx tells Paystack to retry. Answering 200
//     here would tell the provider a payment was reconciled when it was not,
//     which the implementation must never do.
//
// WHAT THIS CONTROLLER NEVER DOES. It never logs the secret, the signature or
// the payload; it never echoes the payload back; and it never exposes an
// internal error. A malformed body that somehow carries a valid signature (so,
// signed by Paystack) is still handled without leaking its contents.

const paymentService = require('../services/paymentService');
const transferService = require('../services/paystackTransferService');
const { createPaystackProvider } = require('../services/paystackProvider');
const { PaystackConfigurationError, getSecretKey } = require('../config/paystack');
const { SIGNATURE_HEADER, verifyWebhookSignature } = require('../services/paystackWebhookSignature');

/**
 * POST /payments/webhook
 *
 * ORDER, and why each step precedes the next:
 *   1. the secret is read and validated. An unconfigured server cannot verify a
 *      signature at all, so it refuses every event (503) rather than trusting
 *      one -- fail closed, exactly as the rest of the payment flow does;
 *   2. the signature is verified against the RAW body captured by the JSON
 *      parser. A missing, malformed or wrong signature is a 401 before the body
 *      is interpreted in any way;
 *   3. only now is the (already parsed) body handed to the service, which uses
 *      it to locate an EXISTING payment and then re-verifies with Paystack. The
 *      body is never the authority on the transaction's status;
 *   4. the outcome decides the status code: an ignored/already-settled event is
 *      a 200; an ambiguous provider failure is a 500 so Paystack retries.
 *
 * A timing-safe, length-checked HMAC comparison means an attacker cannot learn
 * the correct digest byte by byte; see paystackWebhookSignature.js.
 */
const handlePaystackWebhook = async (req, res) => {
    let secret;
    try {
        secret = getSecretKey();
    } catch (error) {
        if (error instanceof PaystackConfigurationError) {
            // Cannot authenticate ANY event without the key: fail closed.
            return res.status(503).json({ message: 'Payment processing is not configured on this server' });
        }
        console.error('Error reading Paystack configuration for webhook:', error);
        return res.status(500).json({ message: 'Failed to process webhook' });
    }

    const signature = req.headers[SIGNATURE_HEADER];
    const signatureOk = verifyWebhookSignature(req.rawBody, signature, secret);

    if (!signatureOk) {
        // No secret, signature or payload detail is logged or returned.
        return res.status(401).json({ message: 'Invalid webhook signature' });
    }

    try {
        // Paystack sends events with a top‑level `event` field describing the
        // kind of occurrence (e.g. 'transfer', 'payment').  We inspect it here
        // before any other processing so that transfer events are routed to the
        // dedicated transfer‑webhook handler while payment events keep the
        // existing path.
        const { event: kind } = req.body;
        if (kind === 'transfer' || (typeof kind === 'string' && kind.startsWith('transfer.'))) {
            const provider = req.app.locals.releaseProvider || createPaystackProvider();
            const result = await transferService.handlePaystackTransferWebhook(req.body, {
                provider,
            });
            return res.status(200).json({
                message: 'Transfer webhook acknowledged',
                outcome: result.outcome,
                reconciled: Boolean(result.reconciled),
            });
        }
        const result = await paymentService.reconcilePaymentFromWebhook(req.body);

        // A 200 acknowledges the event for processing. `reconciled` and
        // `applied` are reported for observability but are not claims about
        // money: only a fully provider-verified success sets reconciled=true.
        return res.status(200).json({
            message: result.applied ? 'Webhook processed' : 'Webhook acknowledged',
            reconciled: result.reconciled,
        });
    } catch (error) {
        if (error instanceof PaystackConfigurationError) {
            return res.status(503).json({ message: 'Payment/transfer processing is not configured on this server' });
        }
        // An authentic event whose reconciliation is UNCONFIRMED (an ambiguous
        // provider outcome). Leave a non-2xx so Paystack retries; never
        // acknowledge a failure as success.
        console.error('Error reconciling Paystack webhook:', error);
        return res.status(500).json({ message: 'Failed to process webhook' });
    }
};

module.exports = {
    handlePaystackWebhook,
};
