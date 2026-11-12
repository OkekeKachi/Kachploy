'use strict';

// paymentHistoryService.js
//
// Read-only payment history for the signed-in employer or employee.
//
// The authority is the `payments` collection, never a task or milestone
// reconstructed client-side. Ownership comes from the verified uid, and the
// repository returns only records whose copied `employerId` or `employeeId`
// matches it. The union of those two equality queries is de-duplicated by
// document id before anything is counted or returned.
//
// Pagination and filtering happen on the server. The application currently has
// a single-field-only query harness, so the authorised set is sorted and sliced
// here rather than by Firestore `orderBy`/`limit`. No payment collection is sent
// to the browser wholesale.
//
// The projection deliberately contains only display fields. Provider payloads,
// access codes, secrets, raw errors and status reasons stay on the server.

const paymentRepository = require('../repositories/paymentRepository');
const contractRepository = require('../repositories/contractRepository');
const jobRepository = require('../repositories/jobRepository');
const { PAYMENT_STATUSES } = require('./paymentService');

const REFERENCE_PREFIX = 'kp_';
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 50;
const MAX_SEARCH_LENGTH = 120;
const CURRENCY = 'NGN';

const PAYMENT_TYPES = ['milestone', 'full_contract'];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

class PaymentHistoryValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PaymentHistoryValidationError';
    }
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

const timestampMillis = (value) => {
    if (value == null) return null;

    if (value instanceof Date) {
        const millis = value.getTime();
        return Number.isNaN(millis) ? null : millis;
    }

    if (typeof value.toMillis === 'function') {
        const millis = value.toMillis();
        return Number.isFinite(millis) ? millis : null;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
        const millis = Date.parse(value);
        return Number.isNaN(millis) ? null : millis;
    }

    if (typeof value._seconds === 'number') {
        return value._seconds * 1000;
    }

    if (typeof value.seconds === 'number') {
        return value.seconds * 1000;
    }

    return null;
};

const timestampIso = (value) => {
    const millis = timestampMillis(value);
    return millis === null ? null : new Date(millis).toISOString();
};

const readQueryString = (value, field) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string') {
        throw new PaymentHistoryValidationError(`${field} must be a single value`);
    }
    return value;
};

const parsePositiveInteger = (raw, field, fallback, max) => {
    if (raw === '') return fallback;
    if (!/^\d+$/.test(raw)) {
        throw new PaymentHistoryValidationError(`${field} must be a positive integer`);
    }

    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new PaymentHistoryValidationError(`${field} must be a positive integer`);
    }
    if (max !== undefined && value > max) {
        throw new PaymentHistoryValidationError(`${field} cannot exceed ${max}`);
    }

    return value;
};

const parseDateBoundary = (raw, field, endOfDay) => {
    if (raw === '') return null;
    if (!DATE_PATTERN.test(raw)) {
        throw new PaymentHistoryValidationError(`${field} must use YYYY-MM-DD`);
    }

    const start = Date.parse(`${raw}T00:00:00.000Z`);
    if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== raw) {
        throw new PaymentHistoryValidationError(`${field} must be a valid date`);
    }

    return endOfDay ? start + 24 * 60 * 60 * 1000 - 1 : start;
};

const parseFilters = (query = {}) => {
    const status = readQueryString(query.status, 'status').trim();
    const type = readQueryString(query.type, 'type').trim();
    const search = readQueryString(query.q, 'q').trim();
    const fromRaw = readQueryString(query.from, 'from').trim();
    const toRaw = readQueryString(query.to, 'to').trim();

    if (status && !PAYMENT_STATUSES.includes(status)) {
        throw new PaymentHistoryValidationError('status is not a recognised payment status');
    }
    if (type && !PAYMENT_TYPES.includes(type)) {
        throw new PaymentHistoryValidationError('type must be milestone or full_contract');
    }
    if (search.length > MAX_SEARCH_LENGTH) {
        throw new PaymentHistoryValidationError(`q cannot exceed ${MAX_SEARCH_LENGTH} characters`);
    }

    const from = parseDateBoundary(fromRaw, 'from', false);
    const to = parseDateBoundary(toRaw, 'to', true);

    if (from !== null && to !== null && from > to) {
        throw new PaymentHistoryValidationError('from cannot be after to');
    }

    return {
        status,
        type,
        search: search.toLowerCase(),
        searchRaw: search,
        from,
        to,
        fromRaw,
        toRaw,
        page: parsePositiveInteger(readQueryString(query.page, 'page'), 'page', 1),
        pageSize: parsePositiveInteger(
            readQueryString(query.pageSize, 'pageSize'),
            'pageSize',
            DEFAULT_PAGE_SIZE,
            MAX_PAGE_SIZE
        ),
    };
};

const emptyBucket = () => ({ count: 0, amountMinor: 0 });

const addToSummary = (bucket, record) => {
    bucket.count += 1;
    if (Number.isSafeInteger(record.amountMinor) && record.amountMinor >= 0) {
        bucket.amountMinor += record.amountMinor;
    }
};

const summarise = (records) => {
    const paid = emptyBucket();
    const pending = emptyBucket();
    const failed = emptyBucket();
    const needsReview = emptyBucket();
    const other = emptyBucket();

    for (const record of records) {
        if (record.status === 'paid') {
            addToSummary(paid, record);
        } else if (record.status === 'failed') {
            addToSummary(failed, record);
        } else if (record.status === 'needs_review') {
            addToSummary(needsReview, record);
        } else if (record.status === 'created' || record.status === 'pending') {
            addToSummary(pending, record);
        } else {
            addToSummary(other, record);
        }
    }

    return { paid, pending, failed, needsReview, other };
};

const listOwnedPayments = async (uid) => {
    const [asEmployer, asEmployee] = await Promise.all([
        paymentRepository.listPaymentsByEmployerId(uid),
        paymentRepository.listPaymentsByEmployeeId(uid),
    ]);

    const records = new Map();

    for (const snapshot of [asEmployer, asEmployee]) {
        for (const doc of snapshot.docs || []) {
            if (!records.has(doc.id)) {
                records.set(doc.id, { id: doc.id, ...doc.data() });
            }
        }
    }

    return [...records.values()];
};

const mapById = async (ids, read) => {
    const entries = await Promise.all(
        [...ids].map(async (id) => {
            const snapshot = await read(id);
            return [id, snapshot && snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null];
        })
    );

    return new Map(entries);
};

const enrichRecords = async (records, uid) => {
    const contractIds = new Set(records.map((record) => record.contractId).filter(isNonEmptyString));
    const milestoneIds = new Set(
        records
            .map((record) => {
                if (record.paymentTarget === 'contract') return null;
                return isNonEmptyString(record.milestoneId) ? record.milestoneId : record.id;
            })
            .filter(isNonEmptyString)
    );

    const contracts = await mapById(contractIds, (id) => contractRepository.getContractById(id));
    const milestones = await mapById(milestoneIds, (id) => contractRepository.getMilestoneById(id));
    const jobIds = new Set(
        [...contracts.values()]
            .map((contract) => contract && contract.jobId)
            .filter(isNonEmptyString)
    );
    const jobs = await mapById(jobIds, (id) => jobRepository.getJobById(id));

    return records.map((record) => {
        const isContract = record.paymentTarget === 'contract';
        const contract = isNonEmptyString(record.contractId)
            ? contracts.get(record.contractId) || null
            : null;
        const milestoneId = isContract
            ? null
            : isNonEmptyString(record.milestoneId)
                ? record.milestoneId
                : record.id;
        const milestone = milestoneId ? milestones.get(milestoneId) || null : null;
        const jobId = contract && isNonEmptyString(contract.jobId) ? contract.jobId : null;
        const job = jobId ? jobs.get(jobId) || null : null;
        const reference =
            isNonEmptyString(record.providerReference)
                ? record.providerReference
                : `${REFERENCE_PREFIX}${record.id}`;

        return {
            id: record.id,
            type: isContract ? 'full_contract' : 'milestone',
            status: record.status,
            amountMinor: record.amountMinor,
            ...(record.netPayableMinor !== undefined
                ? {
                      netPayableMinor: record.netPayableMinor,
                      commissionBps: record.commissionBps,
                  }
                : {}),
            currency: record.currency,
            commissionAmountMinor: record.commissionAmountMinor,
            createdAt: timestampIso(record.createdAt),
            paidAt: timestampIso(record.paidAt),
            reference,
            contractId: isNonEmptyString(record.contractId) ? record.contractId : null,
            employmentId: isNonEmptyString(record.employmentId) ? record.employmentId : null,
            milestoneId,
            jobId,
            jobTitle: job && isNonEmptyString(job.title) ? job.title : null,
            milestoneLabel:
                milestone && isNonEmptyString(milestone.label) ? milestone.label : null,
            viewerRole:
                record.employerId === uid && record.employeeId === uid
                    ? 'both'
                    : record.employerId === uid
                        ? 'employer'
                        : 'employee',
            createdAtMillis: timestampMillis(record.createdAt),
            searchText: [
                reference,
                record.id,
                record.contractId,
                record.employmentId,
                milestoneId,
                jobId,
                job && job.title,
                milestone && milestone.label,
            ]
                .filter(isNonEmptyString)
                .join(' ')
                .toLowerCase(),
        };
    });
};

const sortNewestFirst = (a, b) => {
    if (a.createdAtMillis === null && b.createdAtMillis === null) {
        return a.id.localeCompare(b.id);
    }
    if (a.createdAtMillis === null) return 1;
    if (b.createdAtMillis === null) return -1;

    const difference = b.createdAtMillis - a.createdAtMillis;
    if (difference !== 0) return difference;
    return a.id.localeCompare(b.id);
};

const matchesFilters = (record, filters) => {
    if (filters.status && record.status !== filters.status) return false;
    if (filters.type && record.type !== filters.type) return false;
    if (filters.search && !record.searchText.includes(filters.search)) return false;
    if (filters.from !== null) {
        if (record.createdAtMillis === null || record.createdAtMillis < filters.from) return false;
    }
    if (filters.to !== null) {
        if (record.createdAtMillis === null || record.createdAtMillis > filters.to) return false;
    }
    return true;
};

const projectForResponse = (record) => {
    const {
        createdAtMillis,
        searchText,
        ...projection
    } = record;
    return projection;
};

const listPaymentHistory = async ({ uid, query }) => {
    if (!isNonEmptyString(uid)) {
        throw new PaymentHistoryValidationError('Missing required fields');
    }

    const filters = parseFilters(query);
    const owned = await enrichRecords(await listOwnedPayments(uid), uid);
    const summary = summarise(owned);

    const matching = owned.filter((record) => matchesFilters(record, filters)).sort(sortNewestFirst);
    const total = matching.length;
    const totalPages = total === 0 ? 0 : Math.ceil(total / filters.pageSize);
    const start = (filters.page - 1) * filters.pageSize;
    const pageRecords = matching.slice(start, start + filters.pageSize);

    return {
        payments: pageRecords.map(projectForResponse),
        pagination: {
            page: filters.page,
            pageSize: filters.pageSize,
            total,
            totalPages,
            hasNextPage: filters.page < totalPages,
            hasPreviousPage: filters.page > 1 && total > 0,
        },
        summary: {
            scope: 'all',
            currency: CURRENCY,
            ...summary,
        },
        filters: {
            status: filters.status || null,
            type: filters.type || null,
            q: filters.searchRaw || null,
            from: filters.fromRaw || null,
            to: filters.toRaw || null,
        },
    };
};

module.exports = {
    PaymentHistoryValidationError,
    listPaymentHistory,
};
