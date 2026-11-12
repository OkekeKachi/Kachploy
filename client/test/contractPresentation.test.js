import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CONTRACT_PAYMENT_MODES,
    CONTRACT_STATUSES,
    MAX_AMOUNT_MINOR,
    buildContractPayload,
    contractErrorMessage,
    contractStatus,
    contractStatusBadgeVariant,
    contractStatusLabel,
    formatKoboAsNaira,
    isActiveContract,
    isPendingAcceptance,
    parseNairaToKobo,
} from '../src/components/contractPresentation.js';

// ---------------------------------------------------------------------------
// Status handling. Only the two contractService values are recognised.
// ---------------------------------------------------------------------------

test('the two contract statuses are exactly the ones the backend writes', () => {
    assert.deepEqual(CONTRACT_STATUSES, ['pending_acceptance', 'active']);
});

test('a recognised status renders its label and variant', () => {
    assert.equal(contractStatusLabel({ status: 'pending_acceptance' }), 'Pending acceptance');
    assert.equal(contractStatusLabel({ status: 'active' }), 'Active');

    assert.equal(contractStatusBadgeVariant({ status: 'pending_acceptance' }), 'info');
    assert.equal(contractStatusBadgeVariant({ status: 'active' }), 'success');
});

test('a missing or unrecognised status is not guessed', () => {
    assert.equal(contractStatus(null), '');
    assert.equal(contractStatus({}), '');
    assert.equal(contractStatus({ status: 'draft' }), '');
    assert.equal(contractStatusLabel({ status: 'cancelled' }), 'No status available');
    assert.equal(contractStatusBadgeVariant({ status: 'cancelled' }), 'neutral');

    // No accidental success.
    assert.notEqual(contractStatusBadgeVariant({ status: 'draft' }), 'success');
});

test('pending and active predicates are mutually exclusive', () => {
    assert.equal(isPendingAcceptance({ status: 'pending_acceptance' }), true);
    assert.equal(isActiveContract({ status: 'pending_acceptance' }), false);
    assert.equal(isActiveContract({ status: 'active' }), true);
    assert.equal(isPendingAcceptance({ status: 'active' }), false);
    assert.equal(isActiveContract(null), false);
    assert.equal(isPendingAcceptance(null), false);
});

// ---------------------------------------------------------------------------
// Naira -> kobo parsing. The request is kobo; people type naira.
// ---------------------------------------------------------------------------

test('a whole and a decimal naira amount convert to the correct kobo', () => {
    assert.equal(parseNairaToKobo('5000'), 500000);
    assert.equal(parseNairaToKobo('5000.50'), 500050);
    assert.equal(parseNairaToKobo('0.01'), 1);
    assert.equal(parseNairaToKobo(' 1500 '), 150000);
    assert.equal(parseNairaToKobo('100'), 10000);
});

test('a number input is accepted and converted', () => {
    assert.equal(parseNairaToKobo(25), 2500);
    assert.equal(parseNairaToKobo(25.5), 2550);
});

test('malformed, zero, negative and over-bound amounts are refused', () => {
    assert.equal(parseNairaToKobo(''), null);
    assert.equal(parseNairaToKobo('   '), null);
    assert.equal(parseNairaToKobo('abc'), null);
    assert.equal(parseNairaToKobo('0'), null);
    assert.equal(parseNairaToKobo('-5'), null);
    assert.equal(parseNairaToKobo('5.555'), null); // no third decimal
    assert.equal(parseNairaToKobo('1,000'), null);
    assert.equal(parseNairaToKobo('5e3'), null);
    assert.equal(parseNairaToKobo(null), null);
    assert.equal(parseNairaToKobo(undefined), null);
    assert.equal(parseNairaToKobo(NaN), null);
    assert.equal(parseNairaToKobo(Infinity), null);
});

test('an amount over the server bound is refused rather than sent', () => {
    // MAX_AMOUNT_MINOR kobo = 10,000,000,000 naira.
    const overNaira = (MAX_AMOUNT_MINOR / 100 + 1).toString();
    assert.equal(parseNairaToKobo(overNaira), null);
});

// ---------------------------------------------------------------------------
// Payload building. Only backend fields; no identities, commission or status.
// ---------------------------------------------------------------------------

test('full mode builds a payload with only employmentId, paymentMode and total', () => {
    const result = buildContractPayload({
        employmentId: 'emp-1',
        paymentMode: 'full',
        totalNaira: '5000',
        milestones: [],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, {
        employmentId: 'emp-1',
        paymentMode: 'full',
        totalAmountMinor: 500000,
    });
});

test('milestones mode builds milestones and derives nothing else', () => {
    const result = buildContractPayload({
        employmentId: 'emp-1',
        paymentMode: 'milestones',
        milestones: [
            { label: 'Demo', amountNaira: '1500' },
            { label: 'Build', amountNaira: '2500.50' },
        ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.payload, {
        employmentId: 'emp-1',
        paymentMode: 'milestones',
        milestones: [
            { label: 'Demo', amountMinor: 150000 },
            { label: 'Build', amountMinor: 250050 },
        ],
    });
});

test('the built payload never carries a forbidden field', () => {
    const result = buildContractPayload({
        employmentId: 'emp-1',
        paymentMode: 'full',
        totalNaira: '5000',
    });

    for (const forbidden of [
        'id',
        'employerId',
        'employeeId',
        'jobId',
        'applicationId',
        'commissionBps',
        'commissionAmountMinor',
        'status',
        'createdAt',
        'acceptedAt',
        'acceptedBy',
        'currency',
    ]) {
        assert.equal(Object.prototype.hasOwnProperty.call(result.payload, forbidden), false);
    }
});

test('full mode requires a valid total', () => {
    const result = buildContractPayload({ employmentId: 'e', paymentMode: 'full', totalNaira: '' });
    assert.equal(result.ok, false);
    assert.match(result.error, /total amount/i);
});

test('milestones mode requires at least one milestone', () => {
    const result = buildContractPayload({ employmentId: 'e', paymentMode: 'milestones', milestones: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /at least one milestone/i);
});

test('each milestone needs a label and a valid amount, not a task', () => {
    const noTask = buildContractPayload({
        employmentId: 'e',
        paymentMode: 'milestones',
        milestones: [{ label: 'x', amountNaira: '10' }],
    });
    assert.equal(noTask.ok, true);
    assert.deepEqual(noTask.payload.milestones, [{ label: 'x', amountMinor: 1000 }]);

    const noLabel = buildContractPayload({
        employmentId: 'e',
        paymentMode: 'milestones',
        milestones: [{ label: '', amountNaira: '10' }],
    });
    assert.equal(noLabel.ok, false);
    assert.match(noLabel.error, /label/i);

    const badAmount = buildContractPayload({
        employmentId: 'e',
        paymentMode: 'milestones',
        milestones: [{ label: 'x', amountNaira: '0' }],
    });
    assert.equal(badAmount.ok, false);
    assert.match(badAmount.error, /amount/i);
});

test('legacy taskId fields are not sent; tasks own the milestone association', () => {
    const result = buildContractPayload({
        employmentId: 'e',
        paymentMode: 'milestones',
        milestones: [
            { taskId: 't1', label: 'a', amountNaira: '10' },
            { taskId: 't2', label: 'b', amountNaira: '10' },
        ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(
        result.payload.milestones.map((milestone) => milestone.taskId),
        [undefined, undefined]
    );
});

test('an unknown payment mode and a missing employment are refused', () => {
    assert.equal(buildContractPayload({ employmentId: 'e', paymentMode: 'hourly' }).ok, false);
    assert.equal(buildContractPayload({ employmentId: '', paymentMode: 'full', totalNaira: '5' }).ok, false);
});

test('the payment modes match the backend allow-list', () => {
    assert.deepEqual(CONTRACT_PAYMENT_MODES, ['full', 'milestones']);
});

// ---------------------------------------------------------------------------
// Display + errors.
// ---------------------------------------------------------------------------

test('kobo renders as naira, and a missing amount as an em dash', () => {
    assert.equal(formatKoboAsNaira(500000), '₦5,000.00');
    assert.equal(formatKoboAsNaira(null), '—');
    assert.equal(formatKoboAsNaira(undefined), '—');
    assert.equal(formatKoboAsNaira('500000'), '—');
});

test('a failed request surfaces the server sentence, with safe fallbacks', () => {
    assert.equal(
        contractErrorMessage({ response: { status: 400, data: { message: 'milestones must be an array' } } }),
        'milestones must be an array'
    );
    assert.equal(
        contractErrorMessage({ response: { status: 403, data: {} } }),
        'You do not have permission to do that on this contract.'
    );
    assert.equal(
        contractErrorMessage({ response: { status: 404, data: {} } }),
        'This contract or employment could not be found.'
    );
    assert.equal(
        contractErrorMessage(new Error('boom')),
        'Something went wrong while contacting the server. Please try again.'
    );
});
