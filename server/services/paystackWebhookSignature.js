'use strict';

// paystackWebhookSignature.js (STAGE 1L)
//
// The one piece of the webhook that must be right before anything else runs:
// proving that a request claiming to come from Paystack really was signed with
// the configured Paystack secret key. This module is pure and I/O-free -- it
// takes the raw request bytes, the signature header, and the secret, and
// answers a boolean. It reads no environment and contacts no provider; the
// caller supplies the secret from config/paystack.
//
// WHY HMAC SHA-512 OVER THE RAW BYTES. Paystack signs each webhook by computing
// an HMAC-SHA512 digest of the EXACT request body using the account's secret
// key, and sends the hex digest in the `x-paystack-signature` header. The
// server must compute the same digest over the same bytes. It must NOT hash a
// re-serialized copy of the parsed JSON: JSON.stringify can reorder keys, drop
// or change whitespace, and render numbers differently, so the bytes would
// differ from what the provider signed and every genuine webhook would fail --
// or, worse, a hand-folded comparison could be made to match. The raw body is
// therefore captured untouched by the JSON parser (see app.js) and passed here.
//
// WHY TIMING-SAFE. A byte-by-byte `===` on secrets or signatures leaks, through
// response timing, how many leading bytes of a guessed digest were correct --
// enough to forge a digest one byte at a time. crypto.timingSafeEqual compares
// every byte regardless of where the first mismatch is. It also throws unless
// both buffers are the same length, so the lengths are checked first; that
// length check leaks only the length, which is fixed and public (a SHA-512 hex
// digest is always 128 characters), not the contents.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO.
//   * It never logs, returns or interpolates the secret, the signature, or the
//     body. Its one failure mode is `return false`.
//   * It never parses or interprets the body. Parsing is the controller's job,
//     and it happens only after this returns true.
//   * It has no Live/Test branch: the same HMAC applies to both, and which key
//     is in use is config/paystack's decision, already enforced before the
//     secret reaches here.

const crypto = require('crypto');

/** The header Paystack sends the hex HMAC-SHA512 digest in, lower-cased. */
const SIGNATURE_HEADER = 'x-paystack-signature';

/**
 * Is `signature` the HMAC-SHA512 hex digest of `rawBody` under `secret`?
 *
 * Returns a boolean and never throws for malformed input: a missing/empty
 * body, a missing/blank/non-string signature, or a missing secret all answer
 * `false` (the request is simply not proven authentic). The comparison is
 * timing-safe and only runs when the supplied signature is exactly as long as
 * a hex SHA-512 digest, so no length-varying work is done before the constant-
 * time compare.
 *
 * @param {Buffer|string|undefined|null} rawBody the exact request bytes
 * @param {string|undefined|null} signature the `x-paystack-signature` value
 * @param {string} secret the configured Paystack secret key (never logged)
 * @returns {boolean}
 */
const verifyWebhookSignature = (rawBody, signature, secret) => {
    if (typeof signature !== 'string' || signature === '') {
        return false;
    }
    if (typeof secret !== 'string' || secret === '') {
        return false;
    }

    let bodyBuffer;
    if (Buffer.isBuffer(rawBody)) {
        bodyBuffer = rawBody;
    } else if (typeof rawBody === 'string') {
        bodyBuffer = Buffer.from(rawBody, 'utf8');
    } else {
        return false;
    }

    const expectedHex = crypto.createHmac('sha512', secret).update(bodyBuffer).digest('hex');

    // Lower-case both sides: HTTP header values are case-insensitive by spec
    // but a hex digest is conventionally lower-case; normalising avoids a
    // spurious mismatch on case alone without weakening the comparison.
    const provided = signature.trim().toLowerCase();
    const expected = expectedHex.toLowerCase();

    const providedBuffer = Buffer.from(provided, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    // timingSafeEqual throws on a length mismatch, so equal length is required
    // first. A SHA-512 hex digest is always 128 characters; anything else is
    // not even a candidate and is rejected as a length-only check.
    if (providedBuffer.length !== expectedBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
};

module.exports = {
    SIGNATURE_HEADER,
    verifyWebhookSignature,
};
