'use strict';

// accountingBackfillService.js
//
// STAGE 2G. Bounded, idempotent backfill of collection journals for
// historical PAID payments.
//
// WHY BOUNDED. There is deliberately no "backfill everything" pass here. The
// service pages through `paymentRepository.listPaidPaymentsPage`, a
// status-filtered, document-id-ordered query, one bounded page at a time. Each
// page replays the SAME ensure path the live verification flow uses
// (`accountingLifecycleService.ensureCollectionForPayment`): post-commit,
// deterministic journal ids, create-only persistence. Replaying a page is
// therefore a reported no-op, not a duplicate posting, and a crash between
// pages loses nothing -- the next run continues from cursor `nextAfterId`.
//
// ELIGIBILITY. A paid payment does not blindly justify a journal: the record's
// amountMinor must be a positive safe integer of kobo and its currency must be
// the ledger currency. A record that fails that check is REPORTED (skipped
// with a reason), never guessed, and it does not stop the rest of the page.
//
// NO ROUTE, NO SCHEDULER. This is a trusted internal caller's tool only. It
// moves no money and contacts no provider: verification of a payment's paid
// status is the payment domain's verdict, which the status field carries.

const { isPositiveSafeMinorAmount } = require('../config/commission');
const { ACCOUNTING_CURRENCY } = require('../config/accounting');
const paymentRepository = require('../repositories/paymentRepository');
const accountingLifecycleService = require('./accountingLifecycleService');

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/**
 * Backfills collection journals for one bounded page of paid payments.
 *
 * STAGE 2H.1. Cursor advances past successes/skips; if any item fails to post,
 * the cursor stops BEFORE the first failed item so a retry resumes from the
 * point of failure rather than skipping over it. Skips are not failures.
 *
 * @param {object} [options]
 * @param {number} [options.pageSize]       1..MAX_PAGE_SIZE (default 100)
 * @param {string} [options.afterId]        resume strictly after this payment id
 * @param {boolean} [options.dryRun]        report without posting anything
 * @returns {object} summary with scanned/posted/duplicates/skipped/failed
 *   counts, the `nextAfterId` cursor for the next page (`null` when done),
 *   and a per-payment `results` list
 */
const backfillPaidCollections = async ({
    pageSize = DEFAULT_PAGE_SIZE,
    afterId,
    dryRun = false,
} = {}) => {
    if (
        !Number.isSafeInteger(pageSize)
        || pageSize < 1
        || pageSize > MAX_PAGE_SIZE
    ) {
        throw new TypeError(
            `pageSize must be a safe integer between 1 and ${MAX_PAGE_SIZE}`
        );
    }
    if (
        afterId !== undefined
        && afterId !== null
        && (typeof afterId !== 'string' || !afterId.trim())
    ) {
        throw new TypeError(
            'afterId must be a non-empty document id string when supplied'
        );
    }
    if (typeof dryRun !== 'boolean') {
        throw new TypeError('dryRun must be a boolean when supplied');
    }

    const snapshot = await paymentRepository.listPaidPaymentsPage({
        limit: pageSize,
        afterId,
    });
    const page = (snapshot.docs || []).map((doc) => ({
        id: doc.id,
        ...doc.data(),
    }));

    const results = [];
    let posted = 0;
    let duplicates = 0;
    let skipped = 0;
    let failed = 0;
    let firstFailureIndex = -1;

    for (let i = 0; i < page.length; i += 1) {
        const payment = page[i];
        if (
            !isPositiveSafeMinorAmount(payment.amountMinor)
            || payment.currency !== ACCOUNTING_CURRENCY
        ) {
            skipped += 1;
            results.push({
                paymentId: payment.id,
                status: payment.status,
                posted: false,
                skipped: true,
                reason: 'ACCOUNTING_INVALID_AMOUNT',
            });
            continue;
        }

        if (dryRun) {
            results.push({
                paymentId: payment.id,
                status: payment.status,
                posted: false,
                dryRun: true,
                wouldPost: true,
            });
            continue;
        }

        const outcome =
            await accountingLifecycleService.ensureCollectionForPayment(
                payment.id
            );
        if (outcome.posted) {
            posted += 1;
            results.push({
                paymentId: payment.id,
                status: payment.status,
                ...outcome,
                failed: false,
            });
            continue;
        }
        if (outcome.duplicate) {
            duplicates += 1;
            results.push({
                paymentId: payment.id,
                status: payment.status,
                ...outcome,
                failed: false,
            });
            continue;
        }
        failed += 1;
        if (firstFailureIndex === -1) {
            firstFailureIndex = i;
        }
        results.push({
            paymentId: payment.id,
            status: payment.status,
            ...outcome,
            failed: true,
        });
    }

    const done = page.length < pageSize;
    let nextAfterId = null;
    if (firstFailureIndex !== -1) {
        if (firstFailureIndex === 0) {
            nextAfterId =
                afterId === undefined || afterId === null ? null : afterId;
        } else {
            nextAfterId = page[firstFailureIndex - 1].id;
        }
        return {
            pageSize,
            afterId: afterId === undefined || afterId === null ? null : afterId,
            dryRun: Boolean(dryRun),
            scanned: page.length,
            posted,
            duplicates,
            skipped,
            failed,
            done: false,
            nextAfterId,
            results,
        };
    }

    return {
        pageSize,
        afterId: afterId === undefined || afterId === null ? null : afterId,
        dryRun: Boolean(dryRun),
        scanned: page.length,
        posted,
        duplicates,
        skipped,
        failed,
        done,
        nextAfterId: done || page.length === 0 ? null : page[page.length - 1].id,
        results,
    };
};

module.exports = {
    backfillPaidCollections,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
};
