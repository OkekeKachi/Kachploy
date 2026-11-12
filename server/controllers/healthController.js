'use strict';

// healthController.js (STAGE 1M)
//
// Two deliberately unauthenticated infrastructure endpoints. Every other
// controller in this codebase sits behind a Firebase bearer token and a party
// guard; these two do not, because a load balancer, container orchestrator or
// uptime monitor must be able to ask them without holding a user's token. That
// makes what they may RETURN the entire security question, so:
//
//   * they return only fixed status strings and booleans -- never a secret,
//     never a credential value, never a hostname, database id, project id,
//     user id, count or any other operational detail;
//   * they never make a network call. Readiness is derived from CONFIGURATION
//     PRESENCE (an env var is set to a valid shape) via the same probes the
//     rest of the server uses -- specifically NOT by contacting Paystack or
//     Cloudinary, so a health check can never be the thing that hammers a
//     provider or leaks that a provider is reachable.
//
// TWO ENDPOINTS, TWO QUESTIONS:
//
//   GET /health   LIVENESS. "Is this process up and serving?" It answers from
//                 constants alone and is always 200 while the process lives.
//                 A failing liveness probe should mean "restart me".
//
//   GET /ready    READINESS. "Is this process able to do its job?" It reports,
//                 as booleans, whether the required external configuration is
//                 present. A failing readiness probe should mean "do not send
//                 me traffic yet", NOT "restart me". It answers 200 when every
//                 check passes and 503 when one does not, so an orchestrator
//                 can act on the status code without parsing the body.

const { admin } = require('../config/firebase');
const { isConfigured: isCloudinaryConfigured } = require('../config/cloudinary');
const { isPaystackConfigured } = require('../config/paystack');

/**
 * GET /health
 *
 * Liveness only. Touches no dependency, reads no configuration, performs no
 * I/O: if this handler runs at all, the process is healthy enough to answer.
 * Always 200.
 */
const getHealth = (req, res) => {
    res.status(200).json({ status: 'ok' });
};

/**
 * GET /ready
 *
 * Readiness. Each check is a boolean derived from configuration presence, never
 * from a live call and never carrying a credential value:
 *
 *   database   -- the Firebase configuration module loaded. It runs at require
 *                 time and initializes the Admin SDK, so a process that reached
 *                 this handler necessarily loaded it without throwing; the
 *                 truthiness probe is a belt-and-braces confirmation, not a
 *                 network reachability test.
 *   cloudinary -- the three Cloudinary variables are present and non-blank
 *                 (config/cloudinary.isConfigured()).
 *   paystack   -- a Test Mode Paystack secret is present and valid
 *                 (config/paystack.isPaystackConfigured()). This is a
 *                 shape check ONLY; it does not contact Paystack.
 *
 * 200 when all three are true; 503 with the same body shape when any is false.
 * The body never distinguishes WHICH variable is wrong beyond the boolean the
 * operator already needs -- see the note in config/cloudinary about not naming
 * the missing variable to an unauthenticated caller.
 */
const getReady = (req, res) => {
    const checks = {
        database: Boolean(admin),
        cloudinary: isCloudinaryConfigured(),
        paystack: isPaystackConfigured(),
    };

    // Array.every is true for an empty list, but the object is always populated;
    // spelled out for clarity rather than relying on that.
    const ready = checks.database && checks.cloudinary && checks.paystack;

    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        checks,
    });
};

module.exports = {
    getHealth,
    getReady,
};
