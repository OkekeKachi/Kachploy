import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_PAYMENT_INITIALIZATION_ATTEMPTS,
    PAYMENT_STATUSES,
    PAYMENT_STATUS_BADGE_VARIANTS,
    PAYMENT_STATUS_LABELS,
    canInitiatePayment,
    canRefreshStatus,
    formatKoboAsNaira,
    isFullContract,
    isTrustedCheckoutUrl,
    makeContractPaymentIdempotencyKey,
    milestonePaymentIsConfirmed,
    paymentErrorMessage,
    paymentInitializationAttempts,
    paymentStatus,
    paymentStatusBadgeVariant,
    paymentStatusExplanation,
    paymentStatusLabel,
} from '../src/components/paymentPresentation.js';

// Every server status is enumerated once here so a test can assert each of the
// five is handled, rather than spot-checking two of them.
test('the five payment statuses are exactly the ones the backend owns', () => {
    assert.deepEqual(PAYMENT_STATUSES, ['created', 'pending', 'paid', 'failed', 'needs_review']);
});

test('each status renders its own label, and none reads as a success except paid', () => {
    assert.equal(paymentStatusLabel({ status: 'created' }), 'Not paid');
    assert.equal(paymentStatusLabel({ status: 'pending' }), 'Awaiting confirmation');
    assert.equal(paymentStatusLabel({ status: 'paid' }), 'Paid');
    assert.equal(paymentStatusLabel({ status: 'failed' }), 'Failed');
    assert.equal(paymentStatusLabel({ status: 'needs_review' }), 'Needs review');

    // Only `paid` may use the success wording.
    const successWords = ['paid'];
    for (const status of PAYMENT_STATUSES) {
        const label = PAYMENT_STATUS_LABELS[status];
        assert.ok(label, `status ${status} must have a label`);
        if (status !== 'paid') {
            assert.ok(
                !successWords.includes(label.toLowerCase()),
                `${status} must not read as success`
            );
        }
    }
});

test('only paid uses the success badge variant, and the variants are distinct', () => {
    assert.equal(paymentStatusBadgeVariant({ status: 'paid' }), 'success');
    assert.notEqual(paymentStatusBadgeVariant({ status: 'pending' }), 'success');
    assert.notEqual(paymentStatusBadgeVariant({ status: 'created' }), 'success');
    assert.notEqual(paymentStatusBadgeVariant({ status: 'failed' }), 'success');
    assert.notEqual(paymentStatusBadgeVariant({ status: 'needs_review' }), 'success');

    const variants = Object.values(PAYMENT_STATUS_BADGE_VARIANTS);
    assert.equal(new Set(variants).size, variants.length, 'variants must be visually distinct');
});

test('a missing record or an unknown stored status reads as not paid', () => {
    assert.equal(paymentStatus(null), 'created');
    assert.equal(paymentStatus(undefined), 'created');
    assert.equal(paymentStatus({}), 'created');
    assert.equal(paymentStatus({ status: 'provider_pending' }), 'created');
    assert.equal(paymentStatusLabel(null), 'Not paid');
    assert.equal(paymentStatusBadgeVariant(null), 'neutral');
});

test('milestonePaymentIsConfirmed is true only for an explicitly paid record', () => {
    assert.equal(milestonePaymentIsConfirmed({ status: 'paid' }), true);

    // Every other status is not confirmed funding.
    for (const status of ['created', 'pending', 'failed', 'needs_review']) {
        assert.equal(milestonePaymentIsConfirmed({ status }), false, `${status} is not confirmed`);
    }

    // Missing or unreadable data is fail-closed: not funded.
    assert.equal(milestonePaymentIsConfirmed(null), false);
    assert.equal(milestonePaymentIsConfirmed(undefined), false);
    assert.equal(milestonePaymentIsConfirmed({}), false);
    assert.equal(milestonePaymentIsConfirmed({ status: '' }), false);
    assert.equal(milestonePaymentIsConfirmed({ status: 'provider_pending' }), false);
});

test('pending and failed are never presented as paid', () => {
    for (const status of ['created', 'pending', 'failed', 'needs_review']) {
        assert.notEqual(paymentStatusLabel({ status }), 'Paid');
        assert.notEqual(paymentStatusBadgeVariant({ status }), 'success');
    }
});

test('every status carries a non-empty, provider-free explanation', () => {
    for (const status of PAYMENT_STATUSES) {
        const explanation = paymentStatusExplanation({ status });
        assert.ok(explanation.length > 0, `status ${status} needs an explanation`);
        // No provider internals or secret-ish words leak into user copy.
        for (const banned of ['secret', 'sk_', 'paystack api', 'token']) {
            assert.ok(
                !explanation.toLowerCase().includes(banned),
                `explanation for ${status} must not mention "${banned}"`
            );
        }
    }
});

// ---------------------------------------------------------------------------
// Full-contract presentation. A contract is paid as one amount, so the panel
// must distinguish it from a milestone schedule without treating a missing
// record as an error.
// ---------------------------------------------------------------------------

test('only an explicit full paymentMode is treated as a full contract', () => {
    assert.equal(isFullContract({ paymentMode: 'full' }), true);
    assert.equal(isFullContract({ paymentMode: 'milestones' }), false);
    assert.equal(isFullContract({}), false);
    assert.equal(isFullContract(null), false);
    assert.equal(isFullContract(undefined), false);
});

test('a full-contract idempotency key is namespaced and capped at 128 characters', () => {
    assert.equal(
        makeContractPaymentIdempotencyKey('emp-1', 'unique-1'),
        'kp-contract-emp-1-unique-1'
    );
    assert.equal(
        makeContractPaymentIdempotencyKey(' emp-1 ', ' unique-1 '),
        'kp-contract-emp-1-unique-1'
    );

    const longKey = makeContractPaymentIdempotencyKey('emp-1', 'x'.repeat(200));
    assert.equal(longKey.length, 128);
    assert.ok(longKey.startsWith('kp-contract-emp-1-'));

    assert.equal(makeContractPaymentIdempotencyKey('', 'unique-1'), '');
    assert.equal(makeContractPaymentIdempotencyKey('emp-1', ''), '');
    assert.equal(makeContractPaymentIdempotencyKey(null, 'unique-1'), '');
    assert.equal(makeContractPaymentIdempotencyKey('emp-1', null), '');
});

test('no payment record is described as not started rather than as an error', () => {
    assert.equal(paymentStatusExplanation(null), 'No payment has been started yet.');
    assert.equal(paymentStatusExplanation(undefined), 'No payment has been started yet.');
});

// ---------------------------------------------------------------------------
// Eligibility: which controls are offered. This is UI-only (the backend
// re-checks), but it must still be correct so a guaranteed-to-fail button is
// never drawn.
// ---------------------------------------------------------------------------

test('Checkout is offered to the employer for created and retryable failed records', () => {
    assert.equal(canInitiatePayment(null, true), true);
    assert.equal(canInitiatePayment({ status: 'created' }, true), true);

    // A confirmed failure may retry; each retry uses a NEW server-side
    // reference, so historical attempt/reference fields do not block it.
    assert.equal(canInitiatePayment({ status: 'failed' }, true), true);
    assert.equal(canInitiatePayment({ status: 'failed', verifyAttempts: 1 }, true), true);
    assert.equal(canInitiatePayment({ status: 'failed', verifyAttempts: 2 }, true), true);
    assert.equal(
        canInitiatePayment({ status: 'failed', verifyAttempts: 1, providerReference: 'kp_ms-1' }, true),
        true,
        'a failed payment with an old provider transaction can start a new attempt'
    );
    assert.equal(
        canInitiatePayment({ status: 'created', providerReference: 'kp_ms-1' }, true),
        true,
        'a created record is still eligible'
    );
    assert.equal(
        canInitiatePayment(
            { status: 'failed', verifyAttempts: MAX_PAYMENT_INITIALIZATION_ATTEMPTS },
            true
        ),
        true,
        'the legacy permanent cap no longer blocks the action'
    );

    assert.equal(canInitiatePayment({ status: 'pending' }, true), false);
    assert.equal(canInitiatePayment({ status: 'paid' }, true), false);
    assert.equal(canInitiatePayment({ status: 'needs_review' }, true), false);

    // A non-employer never gets the control, whatever the status.
    assert.equal(canInitiatePayment(null, false), false);
    assert.equal(canInitiatePayment({ status: 'created' }, false), false);
    assert.equal(canInitiatePayment({ status: 'pending' }, false), false);
    assert.equal(canInitiatePayment({ status: 'failed', verifyAttempts: 1 }, false), false);
});

test('failed retry copy is safe regardless of legacy reference or attempt fields', () => {
    assert.equal(MAX_PAYMENT_INITIALIZATION_ATTEMPTS, 3);
    assert.equal(paymentInitializationAttempts(null), 0);
    assert.equal(paymentInitializationAttempts({}), 0);
    assert.equal(paymentInitializationAttempts({ verifyAttempts: -1 }), 0);
    assert.equal(paymentInitializationAttempts({ verifyAttempts: 1.5 }), 0);
    assert.equal(paymentInitializationAttempts({ verifyAttempts: 2 }), 2);

    assert.match(
        paymentStatusExplanation({ status: 'failed', verifyAttempts: 1 }),
        /start a new checkout attempt safely/
    );
    assert.match(
        paymentStatusExplanation({
            status: 'failed',
            verifyAttempts: 1,
            providerReference: 'kp_ms-1',
        }),
        /start a new checkout attempt safely/
    );
    assert.match(
        paymentStatusExplanation({ status: 'failed', verifyAttempts: 3 }),
        /start a new checkout attempt safely/
    );
    assert.doesNotMatch(
        paymentStatusExplanation({ status: 'failed', verifyAttempts: 3 }),
        /cannot be restarted|maximum number of initialization attempts/
    );
});

test('Refresh status is offered only to the employer, and only once an attempt exists', () => {
    // Nothing to verify before a record exists.
    assert.equal(canRefreshStatus(null, true), false);
    assert.equal(canRefreshStatus({ status: 'created' }, true), false);

    assert.equal(canRefreshStatus({ status: 'pending' }, true), true);
    assert.equal(canRefreshStatus({ status: 'paid' }, true), true);
    assert.equal(canRefreshStatus({ status: 'failed' }, true), true);
    assert.equal(canRefreshStatus({ status: 'needs_review' }, true), true);

    assert.equal(canRefreshStatus({ status: 'pending' }, false), false);
    assert.equal(canRefreshStatus({ status: 'paid' }, false), false);
});

// ---------------------------------------------------------------------------
// Checkout URL validation. The exact-host rule is what refuses lookalikes.
// ---------------------------------------------------------------------------

test('only an exact https checkout.paystack.com URL is trusted', () => {
    assert.equal(isTrustedCheckoutUrl('https://checkout.paystack.com/abc123'), true);
    assert.equal(isTrustedCheckoutUrl('https://checkout.paystack.com'), true);

    // Wrong scheme.
    assert.equal(isTrustedCheckoutUrl('http://checkout.paystack.com/abc'), false);

    // Lookalike / suffix / prefix attacks.
    assert.equal(isTrustedCheckoutUrl('https://checkout.paystack.com.evil.example/abc'), false);
    assert.equal(isTrustedCheckoutUrl('https://evil-checkout.paystack.com/abc'), false);
    assert.equal(isTrustedCheckoutUrl('https://checkout.paystack.com.evil.example'), false);
    assert.equal(isTrustedCheckoutUrl('https://paystack.com/checkout'), false);
    assert.equal(isTrustedCheckoutUrl('https://notcheckout.paystack.com/abc'), false);

    // Embedded userinfo trick.
    assert.equal(isTrustedCheckoutUrl('https://checkout.paystack.com@evil.example/abc'), false);

    // Non-strings and empties.
    assert.equal(isTrustedCheckoutUrl(''), false);
    assert.equal(isTrustedCheckoutUrl('   '), false);
    assert.equal(isTrustedCheckoutUrl(null), false);
    assert.equal(isTrustedCheckoutUrl(undefined), false);
    assert.equal(isTrustedCheckoutUrl(123), false);
    assert.equal(isTrustedCheckoutUrl('not a url'), false);
});

// ---------------------------------------------------------------------------
// Money formatting is display-only and never fabricates a figure.
// ---------------------------------------------------------------------------

test('kobo is shown as naira for display, dividing by 100', () => {
    assert.equal(formatKoboAsNaira(263959), '₦2,639.59');
    assert.equal(formatKoboAsNaira(0), '₦0.00');
    assert.equal(formatKoboAsNaira(100), '₦1.00');
});

test('a missing or non-numeric amount renders an em dash, never a made-up number', () => {
    assert.equal(formatKoboAsNaira(null), '—');
    assert.equal(formatKoboAsNaira(undefined), '—');
    assert.equal(formatKoboAsNaira('500000'), '—');
    assert.equal(formatKoboAsNaira(NaN), '—');
    assert.equal(formatKoboAsNaira(Infinity), '—');
});

// ---------------------------------------------------------------------------
// Error surfacing: safe server sentences only, a special 503, and no provider body.
// ---------------------------------------------------------------------------

test('the server message is surfaced, and 503 gets its own sentence', () => {
    assert.equal(
        paymentErrorMessage({ response: { status: 400, data: { message: 'Milestone not found' } } }),
        'Milestone not found'
    );
    assert.equal(
        paymentErrorMessage({ response: { status: 503, data: { message: 'raw' } } }),
        'Payments are not available on this server right now. Please try again later.'
    );
});

test('a failure with no server message falls back to a generic, safe sentence', () => {
    assert.equal(
        paymentErrorMessage({ response: { status: 500 } }),
        'Something went wrong while contacting the payment service. Please try again.'
    );
    assert.equal(
        paymentErrorMessage(new Error('boom')),
        'Something went wrong while contacting the payment service. Please try again.'
    );
    assert.equal(
        paymentErrorMessage(undefined),
        'Something went wrong while contacting the payment service. Please try again.'
    );
});
