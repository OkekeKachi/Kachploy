'use strict';

/**
 * Stage 1L unit tests for the pure webhook-signature verifier. No server, no
 * harness: the function takes bytes, a signature and a secret and returns a
 * boolean. These pin the properties the webhook depends on:
 *   * the digest is HMAC-SHA512 hex over the EXACT bytes supplied;
 *   * a re-serialised body with different bytes does not verify;
 *   * comparison is length-guarded (timingSafeEqual needs equal lengths);
 *   * missing/malformed inputs and a missing secret all answer false, never
 *     throw, and never leak the secret.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  SIGNATURE_HEADER,
  verifyWebhookSignature,
} = require('../services/paystackWebhookSignature');

const SECRET = 'sk_test_000000000000FAKEKEYTAIL';

const sign = (body, secret = SECRET) =>
  crypto.createHmac('sha512', secret).update(body).digest('hex');

test('the signature header name is the documented Paystack header', () => {
  assert.equal(SIGNATURE_HEADER, 'x-paystack-signature');
});

test('a correct HMAC-SHA512 hex digest over the exact bytes verifies', () => {
  const body = Buffer.from('{"event":"charge.success"}', 'utf8');
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
});

test('a string body is treated as its UTF-8 bytes', () => {
  const text = '{"a":1}';
  assert.equal(verifyWebhookSignature(text, sign(Buffer.from(text, 'utf8')), SECRET), true);
});

test('a signature over different bytes than were passed is rejected', () => {
  const sent = Buffer.from('{"amount":100}', 'utf8');
  const other = Buffer.from('{"amount":1}', 'utf8');
  assert.equal(verifyWebhookSignature(sent, sign(other), SECRET), false);
});

test('re-serialising the same object in a different key order changes the bytes and fails', () => {
  const body = Buffer.from('{"a":1,"b":2}', 'utf8');
  const reserialised = Buffer.from('{"b":2,"a":1}', 'utf8');
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
  assert.equal(verifyWebhookSignature(body, sign(reserialised), SECRET), false);
});

test('a digest signed with a different secret is rejected', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifyWebhookSignature(body, sign(body, 'sk_test_other_key'), SECRET), false);
});

test('an upper-case hex signature still verifies (case-insensitive header value)', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifyWebhookSignature(body, sign(body).toUpperCase(), SECRET), true);
});

test('missing, malformed and wrong-length signatures answer false without throwing', () => {
  const body = Buffer.from('{}', 'utf8');
  for (const signature of [undefined, null, '', '   ', 'not-a-digest', 'abcd', 42, {}]) {
    assert.equal(verifyWebhookSignature(body, signature, SECRET), false, String(signature));
  }
});

test('a missing body or secret answers false without throwing', () => {
  const body = Buffer.from('{}', 'utf8');
  assert.equal(verifyWebhookSignature(undefined, sign(body), SECRET), false);
  assert.equal(verifyWebhookSignature(null, sign(body), SECRET), false);
  assert.equal(verifyWebhookSignature(42, sign(body), SECRET), false);
  assert.equal(verifyWebhookSignature(body, sign(body), undefined), false);
  assert.equal(verifyWebhookSignature(body, sign(body), ''), false);
});

test('the secret never appears in any observable output', () => {
  const body = Buffer.from('{"event":"charge.success"}', 'utf8');
  // The function returns only a boolean; nothing it produces can carry the key.
  const result = verifyWebhookSignature(body, 'wrong', SECRET);
  assert.equal(result, false);
  assert.equal(typeof result, 'boolean');
});
