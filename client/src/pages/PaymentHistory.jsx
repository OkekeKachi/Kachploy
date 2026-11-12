import React, { useEffect, useMemo, useState } from 'react';
import {
    AlertCircle,
    ChevronLeft,
    ChevronRight,
    CreditCard,
    Search,
} from 'lucide-react';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { usePaymentHistoryQuery } from '../useAppQueries';
import { paymentErrorMessage } from '../components/paymentPresentation';
import {
    buildPaymentHistoryParams,
    hasPaymentHistoryFilters,
    paymentHistoryAmount,
    paymentHistoryContext,
    paymentHistoryDate,
    paymentHistoryStatusLabel,
    paymentHistoryStatusVariant,
    paymentHistorySummaryCards,
    paymentHistoryTypeLabel,
    paymentHistoryViewerLabel,
} from '../components/paymentHistoryPresentation';
import AppNavbar from '../components/AppNavbar';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import EmptyState from '../components/ui/EmptyState';
import Field, { Input, Select } from '../components/ui/Field';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import Spinner from '../components/ui/Spinner';

const PAGE_SIZE = 10;
const EMPTY_FILTERS = { status: '', type: '', q: '', from: '', to: '' };

const DetailItem = ({ label, children }) => (
    <div>
        <dt className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
            {label}
        </dt>
        <dd className="mt-1 break-words text-sm text-foreground">{children}</dd>
    </div>
);

const PaymentRow = ({ record }) => (
    <Card as="li" className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="primary">{paymentHistoryTypeLabel(record.type)}</Badge>
                    <span className="text-xs font-medium text-foreground-subtle">
                        {paymentHistoryViewerLabel(record.viewerRole)}
                    </span>
                </div>
                <h3 className="mt-2 break-words text-lg font-semibold text-foreground">
                    {paymentHistoryContext(record)}
                </h3>
                {record.jobTitle && record.milestoneLabel && (
                    <p className="mt-1 break-words text-sm text-foreground-muted">
                        {record.milestoneLabel}
                    </p>
                )}
            </div>

            <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                <Badge variant={paymentHistoryStatusVariant(record)}>
                    {paymentHistoryStatusLabel(record)}
                </Badge>
                <p className="text-xl font-semibold text-foreground">{record.amountLabel}</p>
                <p className="text-xs text-foreground-subtle">
                    {paymentHistoryDate(record.createdAt)}
                </p>
            </div>
        </div>

        <details className="mt-4 rounded-md border border-border bg-surface-muted/40 px-4 py-3">
            <summary className="cursor-pointer text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                Payment details
            </summary>
            <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <DetailItem label="Reference">
                    <code className="break-all font-mono text-xs">{record.reference}</code>
                </DetailItem>
                <DetailItem label="Contract">
                    <code className="break-all font-mono text-xs">
                        {record.contractId || 'Unavailable'}
                    </code>
                </DetailItem>
                <DetailItem label="Employment">
                    <code className="break-all font-mono text-xs">
                        {record.employmentId || 'Unavailable'}
                    </code>
                </DetailItem>
                {record.milestoneId && (
                    <DetailItem label="Milestone">
                        <code className="break-all font-mono text-xs">{record.milestoneId}</code>
                    </DetailItem>
                )}
                {record.jobId && (
                    <DetailItem label="Job">
                        <code className="break-all font-mono text-xs">{record.jobId}</code>
                    </DetailItem>
                )}
                <DetailItem label="Recorded">
                    {paymentHistoryDate(record.createdAt)}
                </DetailItem>
                {record.paidAt && (
                    <DetailItem label="Confirmed">
                        {paymentHistoryDate(record.paidAt)}
                    </DetailItem>
                )}
                <DetailItem label="Commission">
                    {record.commissionLabel || 'Not available'}
                </DetailItem>
            </dl>
        </details>
    </Card>
);

const PaymentHistory = () => {
    const [navUser, setNavUser] = useState({});
    const [draftFilters, setDraftFilters] = useState(EMPTY_FILTERS);
    const [filters, setFilters] = useState(EMPTY_FILTERS);
    const [page, setPage] = useState(1);
    const uid = auth.currentUser ? auth.currentUser.uid : '';

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setNavUser({ fullName: user?.displayName || '', email: user?.email || '' });
        });

        return unsubscribe;
    }, []);

    const params = useMemo(
        () => buildPaymentHistoryParams(filters, page, PAGE_SIZE),
        [filters, page]
    );
    const query = usePaymentHistoryQuery(uid, params, { staleTime: 0 });
    const data = query.data;
    const payments = data?.payments || [];
    const pagination = data?.pagination;
    const summaryCards = paymentHistorySummaryCards(data?.summary);
    const filtersActive = hasPaymentHistoryFilters(filters);

    const loading = Boolean(uid) && query.isPending;
    const error = query.isError ? paymentErrorMessage(query.error) : '';

    const updateDraft = (field) => (event) => {
        setDraftFilters((current) => ({ ...current, [field]: event.target.value }));
    };

    const applyFilters = (event) => {
        event.preventDefault();
        setPage(1);
        setFilters({ ...draftFilters });
    };

    const clearFilters = () => {
        setDraftFilters(EMPTY_FILTERS);
        setFilters(EMPTY_FILTERS);
        setPage(1);
    };

    const start = pagination && pagination.total > 0
        ? (pagination.page - 1) * pagination.pageSize + 1
        : 0;
    const end = pagination ? Math.min(pagination.page * pagination.pageSize, pagination.total) : 0;

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <div className="space-y-6">
                    <PageHeader
                        title="Payments"
                        description="Your payment history for milestone and full-contract payments."
                        actions={
                            <Button
                                type="button"
                                variant="secondary"
                                onClick={() => query.refetch()}
                                disabled={!uid || query.isFetching}
                                aria-busy={query.isFetching}
                            >
                                {query.isFetching ? 'Refreshing' : 'Refresh'}
                            </Button>
                        }
                    />

                    <div
                        role="note"
                        className="flex items-start gap-2 rounded-md border border-info/30 bg-info-subtle p-4 text-sm text-info-subtle-foreground"
                    >
                        <CreditCard className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <p>
                            <span className="font-semibold">Test Mode.</span> Payments are
                            processed in Test Mode. No live funds are moved.
                        </p>
                    </div>

                    {error && (
                        <div
                            role="alert"
                            className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-danger/30 bg-danger-subtle p-4 text-sm text-danger-subtle-foreground"
                        >
                            <div className="flex min-w-0 items-start gap-2">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                <p className="min-w-0">{error}</p>
                            </div>
                            <Button
                                type="button"
                                variant="secondary"
                                className="h-8 shrink-0 px-3 text-xs"
                                onClick={() => query.refetch()}
                                disabled={query.isFetching}
                                aria-busy={query.isFetching}
                            >
                                {query.isFetching ? 'Trying' : 'Try again'}
                            </Button>
                        </div>
                    )}

                    {loading ? (
                        <Card className="flex items-center justify-center gap-3 p-10 text-foreground-muted">
                            <Spinner size="md" className="text-accent" label="Loading payments" />
                            <p className="text-sm font-medium">Loading your payments.</p>
                        </Card>
                    ) : (
                        <>
                            {data && (
                                <section aria-labelledby="payment-summary-heading">
                                    <div className="flex flex-wrap items-end justify-between gap-2">
                                        <div>
                                            <h2
                                                id="payment-summary-heading"
                                                className="text-lg font-semibold text-foreground"
                                            >
                                                All-time summary
                                            </h2>
                                            <p className="mt-1 text-sm text-foreground-muted">
                                                Calculated from your authoritative payment
                                                records.
                                            </p>
                                        </div>
                                        <p className="text-xs text-foreground-subtle">
                                            All amounts in NGN
                                        </p>
                                    </div>

                                    <ul className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                                        {summaryCards.map((card) => (
                                            <Card as="li" key={card.key} className="p-4">
                                                <p className="text-xs font-medium uppercase tracking-wide text-foreground-subtle">
                                                    {card.label}
                                                </p>
                                                <p
                                                    className={`mt-2 text-2xl font-semibold ${
                                                        card.key === 'paid'
                                                            ? 'text-success'
                                                            : 'text-foreground'
                                                    }`}
                                                >
                                                    {card.amountLabel}
                                                </p>
                                                <p className="mt-1 text-xs font-medium text-foreground-muted">
                                                    {card.countLabel}
                                                </p>
                                                <p className="mt-2 text-xs text-foreground-subtle">
                                                    {card.description}
                                                </p>
                                            </Card>
                                        ))}
                                    </ul>
                                    <p className="mt-2 text-xs text-foreground-subtle">
                                        Pending, failed and needs-review amounts are not confirmed
                                        received funds.
                                    </p>
                                </section>
                            )}

                            <Card className="p-4 sm:p-5">
                                <form
                                    role="search"
                                    aria-label="Filter payment history"
                                    onSubmit={applyFilters}
                                >
                                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                        <Field
                                            id="payment-history-search"
                                            label="Search"
                                            hint="Reference, job, employment, contract or milestone."
                                            className="sm:col-span-2 lg:col-span-1"
                                        >
                                            <div className="relative">
                                                <Search
                                                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle"
                                                    aria-hidden="true"
                                                />
                                                <Input
                                                    id="payment-history-search"
                                                    type="search"
                                                    value={draftFilters.q}
                                                    onChange={updateDraft('q')}
                                                    placeholder="Search payments"
                                                    className="pl-9"
                                                    maxLength={120}
                                                />
                                            </div>
                                        </Field>

                                        <Field id="payment-history-status" label="Status">
                                            <Select
                                                id="payment-history-status"
                                                value={draftFilters.status}
                                                onChange={updateDraft('status')}
                                            >
                                                <option value="">All statuses</option>
                                                <option value="created">Not paid</option>
                                                <option value="pending">Awaiting confirmation</option>
                                                <option value="paid">Paid</option>
                                                <option value="failed">Failed</option>
                                                <option value="needs_review">Needs review</option>
                                            </Select>
                                        </Field>

                                        <Field id="payment-history-type" label="Payment type">
                                            <Select
                                                id="payment-history-type"
                                                value={draftFilters.type}
                                                onChange={updateDraft('type')}
                                            >
                                                <option value="">All payment types</option>
                                                <option value="milestone">Milestone</option>
                                                <option value="full_contract">Full contract</option>
                                            </Select>
                                        </Field>

                                        <Field id="payment-history-from" label="From">
                                            <Input
                                                id="payment-history-from"
                                                type="date"
                                                value={draftFilters.from}
                                                onChange={updateDraft('from')}
                                            />
                                        </Field>

                                        <Field id="payment-history-to" label="To">
                                            <Input
                                                id="payment-history-to"
                                                type="date"
                                                value={draftFilters.to}
                                                onChange={updateDraft('to')}
                                            />
                                        </Field>
                                    </div>

                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        <Button
                                            type="submit"
                                            disabled={query.isFetching}
                                            aria-busy={query.isFetching}
                                        >
                                            Apply filters
                                        </Button>
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            onClick={clearFilters}
                                            disabled={
                                                !filtersActive &&
                                                !hasPaymentHistoryFilters(draftFilters)
                                            }
                                        >
                                            Clear filters
                                        </Button>
                                    </div>
                                </form>
                            </Card>

                            {!loading && data && payments.length === 0 && (
                                <EmptyState
                                    icon={CreditCard}
                                    title={
                                        filtersActive
                                            ? 'No payments match these filters'
                                            : 'No payments yet'
                                    }
                                    description={
                                        filtersActive
                                            ? 'Try clearing the filters or widening the date range.'
                                            : 'Payment records will appear here once a payment has been created for one of your contracts.'
                                    }
                                    action={
                                        filtersActive ? (
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                onClick={clearFilters}
                                            >
                                                Clear filters
                                            </Button>
                                        ) : undefined
                                    }
                                />
                            )}

                            {payments.length > 0 && (
                                <ul className="space-y-4">
                                    {payments.map((record) => (
                                        <PaymentRow
                                            key={record.id}
                                            record={{
                                                ...record,
                                                amountLabel: paymentHistoryAmount(
                                                    record.amountMinor
                                                ),
                                                commissionLabel: paymentHistoryAmount(
                                                    record.commissionAmountMinor
                                                ),
                                            }}
                                        />
                                    ))}
                                </ul>
                            )}

                            {pagination && pagination.total > 0 && (
                                <nav
                                    aria-label="Payment history pagination"
                                    className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between"
                                >
                                    <p className="text-sm text-foreground-muted" aria-live="polite">
                                        Showing {start}-{end} of {pagination.total}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => setPage((current) => current - 1)}
                                            disabled={!pagination.hasPreviousPage || query.isFetching}
                                        >
                                            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                                            Previous
                                        </Button>
                                        <span className="text-sm text-foreground-muted">
                                            Page {pagination.page} of {pagination.totalPages}
                                        </span>
                                        <Button
                                            type="button"
                                            variant="secondary"
                                            size="sm"
                                            onClick={() => setPage((current) => current + 1)}
                                            disabled={!pagination.hasNextPage || query.isFetching}
                                        >
                                            Next
                                            <ChevronRight className="h-4 w-4" aria-hidden="true" />
                                        </Button>
                                    </div>
                                </nav>
                            )}
                        </>
                    )}
                </div>
            </PageContainer>
        </div>
    );
};

export default PaymentHistory;
