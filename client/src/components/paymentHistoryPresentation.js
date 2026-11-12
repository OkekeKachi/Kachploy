/**
 * Pure presentation helpers for the payment history page.
 *
 * No React, no network, no money calculations: the server owns statuses,
 * amounts, summaries, filtering and pagination. These helpers only format what
 * it returned and build the query object it accepts.
 */

import {
    PAYMENT_STATUS_BADGE_VARIANTS,
    PAYMENT_STATUS_LABELS,
    formatKoboAsNaira,
} from './paymentPresentation.js';

export const PAYMENT_TYPE_LABELS = {
    milestone: 'Milestone payment',
    full_contract: 'Full contract',
};

export const paymentHistoryTypeLabel = (type) =>
    PAYMENT_TYPE_LABELS[type] || 'Payment';

export const paymentHistoryStatus = (record) => {
    const status = record && typeof record.status === 'string' ? record.status : '';
    return Object.prototype.hasOwnProperty.call(PAYMENT_STATUS_LABELS, status) ? status : '';
};

export const paymentHistoryStatusLabel = (record) =>
    PAYMENT_STATUS_LABELS[paymentHistoryStatus(record)] || 'Status unavailable';

export const paymentHistoryStatusVariant = (record) =>
    PAYMENT_STATUS_BADGE_VARIANTS[paymentHistoryStatus(record)] || 'neutral';

export const paymentHistoryViewerLabel = (viewerRole) => {
    if (viewerRole === 'employer') return 'You paid';
    if (viewerRole === 'employee') return 'You received';
    if (viewerRole === 'both') return 'Your payment';
    return 'Payment';
};

export const paymentHistoryDate = (value) => {
    if (typeof value !== 'string' || !value) return 'Date unavailable';

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Date unavailable';

    return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    });
};

const summaryCard = (summary, key, label, description) => {
    const bucket = summary && summary[key] ? summary[key] : {};
    const count = Number.isSafeInteger(bucket.count) ? bucket.count : 0;
    const amountMinor = Number.isSafeInteger(bucket.amountMinor) ? bucket.amountMinor : 0;

    return {
        key,
        label,
        description,
        count,
        amountMinor,
        amountLabel: formatKoboAsNaira(amountMinor),
        countLabel: `${count} ${count === 1 ? 'payment' : 'payments'}`,
    };
};

export const paymentHistorySummaryCards = (summary) => {
    const cards = [
        summaryCard(
            summary,
            'paid',
            'Total successfully paid',
            'Confirmed successful by the server.'
        ),
        summaryCard(
            summary,
            'pending',
            'Pending',
            'Not yet confirmed. Includes payments not started and awaiting confirmation.'
        ),
        summaryCard(summary, 'failed', 'Failed', 'Recorded as failed; no automatic retry.'),
        summaryCard(
            summary,
            'needsReview',
            'Needs review',
            'Outcome is not confirmed and needs manual review.'
        ),
    ];

    if (summary && summary.other && summary.other.count > 0) {
        cards.push(
            summaryCard(
                summary,
                'other',
                'Other',
                'The server could not classify the status of these records.'
            )
        );
    }

    return cards;
};

export const buildPaymentHistoryParams = (filters = {}, page = 1, pageSize = 10) => {
    const params = { page, pageSize };
    const add = (key) => {
        const value = typeof filters[key] === 'string' ? filters[key].trim() : '';
        if (value) params[key] = value;
    };

    add('status');
    add('type');
    add('q');
    add('from');
    add('to');

    return params;
};

export const hasPaymentHistoryFilters = (filters = {}) =>
    ['status', 'type', 'q', 'from', 'to'].some(
        (key) => typeof filters[key] === 'string' && filters[key].trim() !== ''
    );

export const paymentHistoryContext = (record) => {
    if (!record) return 'Payment';
    if (record.jobTitle) return record.jobTitle;
    if (record.milestoneLabel) return record.milestoneLabel;
    return paymentHistoryTypeLabel(record.type);
};

export const paymentHistoryAmount = (amountMinor) => formatKoboAsNaira(amountMinor);

