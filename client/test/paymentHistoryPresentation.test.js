import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildPaymentHistoryParams,
    hasPaymentHistoryFilters,
    paymentHistoryAmount,
    paymentHistoryContext,
    paymentHistoryDate,
    paymentHistoryStatus,
    paymentHistoryStatusLabel,
    paymentHistoryStatusVariant,
    paymentHistorySummaryCards,
    paymentHistoryTypeLabel,
    paymentHistoryViewerLabel,
} from '../src/components/paymentHistoryPresentation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('known statuses are shown with the existing safe labels and variants', () => {
    assert.equal(paymentHistoryStatus({ status: 'paid' }), 'paid');
    assert.equal(paymentHistoryStatusLabel({ status: 'paid' }), 'Paid');
    assert.equal(paymentHistoryStatusVariant({ status: 'paid' }), 'success');

    assert.equal(paymentHistoryStatusLabel({ status: 'pending' }), 'Awaiting confirmation');
    assert.notEqual(paymentHistoryStatusVariant({ status: 'pending' }), 'success');
    assert.equal(paymentHistoryStatusLabel({ status: 'needs_review' }), 'Needs review');
});

test('an unknown or missing status is never presented as success', () => {
    assert.equal(paymentHistoryStatus({ status: 'provider_something' }), '');
    assert.equal(paymentHistoryStatusLabel({ status: 'provider_something' }), 'Status unavailable');
    assert.equal(paymentHistoryStatusVariant({ status: 'provider_something' }), 'neutral');
    assert.equal(paymentHistoryStatusLabel(null), 'Status unavailable');
});

test('payment types, viewer wording and context fall back safely', () => {
    assert.equal(paymentHistoryTypeLabel('milestone'), 'Milestone payment');
    assert.equal(paymentHistoryTypeLabel('full_contract'), 'Full contract');
    assert.equal(paymentHistoryTypeLabel('unknown'), 'Payment');

    assert.equal(paymentHistoryViewerLabel('employer'), 'You paid');
    assert.equal(paymentHistoryViewerLabel('employee'), 'You received');
    assert.equal(paymentHistoryViewerLabel('both'), 'Your payment');
    assert.equal(paymentHistoryViewerLabel(''), 'Payment');

    assert.equal(paymentHistoryContext({ jobTitle: 'Logo design' }), 'Logo design');
    assert.equal(paymentHistoryContext({ milestoneLabel: 'Wireframes' }), 'Wireframes');
    assert.equal(paymentHistoryContext({ type: 'full_contract' }), 'Full contract');
    assert.equal(paymentHistoryContext(null), 'Payment');
});

test('invalid dates are labelled unavailable rather than invented', () => {
    assert.equal(paymentHistoryDate('not-a-date'), 'Date unavailable');
    assert.equal(paymentHistoryDate(''), 'Date unavailable');
    assert.equal(paymentHistoryDate(null), 'Date unavailable');
    assert.notEqual(paymentHistoryDate('2026-10-26T09:00:00.000Z'), 'Date unavailable');
});

test('history params trim filters, omit blanks and always carry pagination', () => {
    assert.deepEqual(
        buildPaymentHistoryParams(
            { status: ' paid ', type: '', q: '  acme  ', from: '', to: '2026-10-26' },
            2,
            10
        ),
        { page: 2, pageSize: 10, status: 'paid', q: 'acme', to: '2026-10-26' }
    );

    assert.deepEqual(buildPaymentHistoryParams({}, 1, 10), { page: 1, pageSize: 10 });
    assert.equal(hasPaymentHistoryFilters({ q: '   ' }), false);
    assert.equal(hasPaymentHistoryFilters({ status: 'paid' }), true);
});

test('the all-time summary presents all four required buckets and labels amounts', () => {
    const cards = paymentHistorySummaryCards({
        paid: { count: 2, amountMinor: 250000 },
        pending: { count: 1, amountMinor: 50000 },
        failed: { count: 1, amountMinor: 25000 },
        needsReview: { count: 1, amountMinor: 10000 },
        other: { count: 0, amountMinor: 0 },
    });

    assert.deepEqual(
        cards.map((card) => card.key),
        ['paid', 'pending', 'failed', 'needsReview']
    );
    assert.equal(cards[0].countLabel, '2 payments');
    assert.equal(cards[0].amountMinor, 250000);
    assert.equal(cards[1].countLabel, '1 payment');
    assert.match(cards[1].description, /not yet confirmed/i);

    for (const card of cards) {
        assert.ok(card.amountLabel.length > 0);
    }
});

test('an unrecognised bucket is surfaced only when it has records', () => {
    const withoutOther = paymentHistorySummaryCards({ other: { count: 0, amountMinor: 0 } });
    assert.equal(withoutOther.some((card) => card.key === 'other'), false);

    const withOther = paymentHistorySummaryCards({ other: { count: 3, amountMinor: 900 } });
    const otherCard = withOther.find((card) => card.key === 'other');
    assert.ok(otherCard);
    assert.match(otherCard.description, /could not classify/i);
});

test('summary cards tolerate a missing summary without fabricating amounts', () => {
    const cards = paymentHistorySummaryCards(undefined);
    assert.equal(cards.length, 4);
    for (const card of cards) {
        assert.equal(card.count, 0);
        assert.equal(card.amountMinor, 0);
    }
    assert.equal(paymentHistoryAmount(undefined), paymentHistoryAmount(null));
});

test('the page is registered as a protected route and uses only the server history query', () => {
    const appSrc = readSource('src/App.jsx');
    assert.match(appSrc, /import PaymentHistory from '\.\/pages\/PaymentHistory'/);
    assert.match(
        appSrc,
        /path="\/payments"[\s\S]*?<ProtectedRoute>[\s\S]*?<PaymentHistory \/>/
    );

    const pageSrc = readSource('src/pages/PaymentHistory.jsx');
    assert.match(pageSrc, /usePaymentHistoryQuery\(uid, params/);
    assert.match(pageSrc, /buildPaymentHistoryParams\(filters, page/);
    assert.doesNotMatch(pageSrc, /api\.get\(/);
    assert.doesNotMatch(pageSrc, /fetchPaymentHistory\(/);
    assert.doesNotMatch(pageSrc, /statusReason|providerPayload|accessCode|idempotency/i);
    assert.match(pageSrc, /All-time summary/);
    assert.match(pageSrc, /Test Mode/);
});

test('the navbar exposes Payments to both roles', () => {
    const navbarSrc = readSource('src/components/AppNavbar.jsx');
    assert.match(navbarSrc, /name: 'Payments', href: '\/payments'/);
    assert.match(navbarSrc, /CreditCard/);
});

test('the API helper targets the protected history route and sends no uid', () => {
    const apiSrc = readSource('src/api.js');
    assert.match(apiSrc, /export const fetchPaymentHistory = async \(params = \{\}\)/);
    assert.match(apiSrc, /api\.get\('\/payments\/history', \{ params \}\)/);
    assert.doesNotMatch(apiSrc, /payments\/history\/:uid/);
});
