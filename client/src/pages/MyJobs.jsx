import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import api from '../api';
import {
    Plus,
    Users,
    MapPin,
    Calendar,
    DollarSign,
    Edit3,
    Trash2,
    Eye,
    Briefcase,
    AlertCircle,
} from 'lucide-react';
import AppNavbar from '../components/AppNavbar';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import { useEmployerJobsQuery, useApplicationCountsQuery, useEmployerEmploymentsQuery } from '../useEmployerQueries';
import queryKeys from '../queryKeys';

/*
  STAGE 11.7: presentation-only redesign.

  The auth-scoped load (GET /users/getUser/:uid, GET /jobs/employer/:uid, the
  count-only GET /applications/counts and the employments read), the legacy
  `Filled` handling, the delete confirmation and every navigation destination are
  unchanged. This stage only replaces the gradient header, the local status/action
  class strings and the Material Icons with the shared AppNavbar/PageContainer/
  PageHeader/Card/Badge/Button/EmptyState/PageLoader primitives, the Field-free
  token palette and lucide-react icons.

  The Button primitive renders a real <button>, so the three navigation actions
  that must stay links (Details, View Apps / View Applicants, Manage Employees)
  keep their <Link> semantics (middle-click / open-in-new-tab) via ActionLink
  below, which reuses the same tokens rather than being migrated to a <button>.
*/

/*
  A <Link> styled as a Button. Used for the card actions that are destinations
  rather than events, so the anchor behaviour is preserved.
*/
const ActionLink = ({ to, variant = 'secondary', className = '', children }) => {
    const variants = {
        primary:
            'border-transparent bg-accent text-foreground-inverse hover:bg-accent-hover',
        secondary:
            'border-border-strong bg-surface text-foreground hover:bg-surface-muted',
        accent:
            'border-transparent bg-accent-subtle text-accent-subtle-foreground hover:bg-accent-subtle/70',
    };

    return (
        <Link
            to={to}
            className={`inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas lg:w-full ${variants[variant]} ${className}`}
        >
            {children}
        </Link>
    );
};

/**
 * STAGE 6E: the employer's own posted-jobs list, at `/my-jobs`.
 *
 * WHO OWNS THE LIST
 *   The uid is read from the verified auth session and is never taken from the
 *   URL, a query string or a field. The route takes no parameter at all, so there
 *   is nothing to edit. The server then scopes the read independently:
 *   GET /jobs/employer/:uid is guarded by requireSelfParam('uid'), and
 *   jobRepository.listJobsByEmployer filters `where('postedBy', '==', uid)`. Two
 *   independent layers, and this page only ever requests its own uid.
 *
 * DATA
 *   Phase 3 of the data-fetching audit: the three reads (GET /jobs/employer/:uid,
 *   the count-only GET /applications/counts for per-job applicant totals, and
 *   the self-scoped employments read for per-job employee counts) are the
 *   shared queries in useEmployerQueries, keyed by uid so a /dashboard ->
 *   /my-jobs round trip reuses what the dashboard just loaded. Endpoints,
 *   response fallbacks and the failure behaviour are unchanged: a counts
 *   failure degrades every job to 0 applicants, an employments failure to 0
 *   employees, and a jobs failure surfaces the error banner below.
 *
 * JOB STATUS
 *   `open`, `filled` and `closed` are the statuses that have writers. Legacy
 *   title-cased `Filled` is still read as filled, because documents written by the
 *   old hire flow carry it and there is no migration. This mirrors the Stage 5G
 *   helpers in EmployerDashboard.jsx; they are duplicated rather than imported
 *   because that file keeps them local, and extracting them would mean editing a
 *   page outside this stage's scope.
 *
 * WHY THERE IS NO SEARCH OR FILTER HERE
 *   EmployerDashboard has both, but as component-local state inside that file.
 *   There is no shared filter module to reuse, and pulling one out would mean
 *   refactoring a page this stage does not touch. `/my-jobs` is the plain list;
 *   the searchable view stays where it already is.
 */

// The one load-failure message, shared by the identity read below and the
// jobs-query failure derived at render.
const JOB_LOAD_ERROR = 'Your jobs could not be loaded. Please reload the page to try again.';

const MyJobs = () => {
    const [user, setUser] = useState({});
    // The identity read's settlement, replacing the old isLoading flag for its
    // half of the load. The jobs/counts/employments half is settled by the
    // queries below.
    const [identitySettled, setIdentitySettled] = useState(false);
    const [error, setError] = useState('');
    // Per-row delete progress, so one row's in-flight request cannot be mistaken
    // for another's.
    const [deletingId, setDeletingId] = useState(null);
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    const uid = auth.currentUser ? auth.currentUser.uid : '';

    // Phase 3 of the data-fetching audit: the posted-jobs list, the counts and
    // the employments are shared queries (see useEmployerQueries). They are
    // keyed by uid, so /dashboard -> /my-jobs reuses the dashboard's cache
    // entries instead of re-requesting all three.
    const jobsQuery = useEmployerJobsQuery(uid);
    const countsQuery = useApplicationCountsQuery(uid);
    const employmentsQuery = useEmployerEmploymentsQuery(uid);

    // The identity half of the old load, kept as its own effect: this page has
    // no profile-completion redirect and never had one, and `user` feeds the
    // navbar's name/role only. The jobs/counts/employments reads that used to
    // hang off this listener are the queries above -- they are independent of
    // the identity document and do not wait for it, which is the one
    // sequencing divergence from the old sequential chain (on an identity
    // failure the old code showed the banner with an empty list; the list now
    // still renders if its own read succeeds).
    useEffect(() => {
        let cancelled = false;

        const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
            if (!authUser) {
                if (!cancelled) setIdentitySettled(true);
                return;
            }

            try {
                const userRes = await api.get(`/users/getUser/${authUser.uid}`);
                if (cancelled) return;
                setUser(userRes.data.user || {});
                setError('');
            } catch (err) {
                console.error('Error loading jobs:', err);
                if (!cancelled) {
                    setError(JOB_LOAD_ERROR);
                }
            } finally {
                if (!cancelled) setIdentitySettled(true);
            }
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    // STAGE 5G. Legacy documents carry the title-cased `Filled`, which no plain
    // equality check matches, so it would fall through to the grey default badge.
    const isJobFilled = (status) => status === 'filled' || status === 'Filled';

    const JOB_STATUS_LABEL = {
        open: 'Open',
        filled: 'Filled',
        closed: 'Closed',
    };

    const jobStatusLabel = (status) => {
        if (isJobFilled(status)) return JOB_STATUS_LABEL.filled;
        return JOB_STATUS_LABEL[status] || status;
    };

    // STAGE 11.7: status -> shared Badge variant, matching EmployerDashboard's
    // jobStatusBadgeVariant so the two employer views read the same way.
    const jobStatusBadgeVariant = (status) => {
        if (isJobFilled(status)) return 'primary';
        if (status === 'open') return 'success';
        if (status === 'closed') return 'danger';
        return 'neutral';
    };

    /** Price is optional in the job document, so it is rendered only when present. */
    const priceLabel = (price) => {
        if (price === null || price === undefined || price === '') return 'Not set';
        const amount = Number(price);
        return Number.isNaN(amount) ? String(price) : amount.toLocaleString();
    };

    const handleDeleteJob = async (job) => {
        // Destructive and immediate, so it is confirmed before it runs.
        const confirmed = window.confirm(
            `Delete "${job.title}"? This cannot be undone.`
        );
        if (!confirmed) return;

        setDeletingId(job.id);
        try {
            await api.delete(`/jobs/${job.id}`);
            // Removed from the cache directly rather than refetched, mirroring
            // EmployerDashboard: the same immediate local removal the old
            // setJobs filter did, with the counts and employments entries left
            // alone.
            queryClient.setQueryData(queryKeys.employerJobs(uid), (prev) =>
                (prev || []).filter((item) => item.id !== job.id)
            );
            setError('');
        } catch (err) {
            console.error('Error deleting job:', err);
            setError(`"${job.title}" could not be deleted. Please try again.`);
        } finally {
            setDeletingId(null);
        }
    };

    // Phase 3: the posted-jobs list with the per-job counts merged in -- the
    // same mapping the old effect performed after its sequential chain, now a
    // render-time derivation. A counts or employments read that failed (or has
    // not landed) contributes 0, exactly as the old catch-to-{} paths did.
    const jobList = jobsQuery.data || [];
    const counts = countsQuery.data || {};
    const employmentCounts = {};
    (employmentsQuery.data || []).forEach((employment) => {
        if (!employment.jobId) return;
        employmentCounts[employment.jobId] = (employmentCounts[employment.jobId] || 0) + 1;
    });
    const jobs = jobList.map((job) => ({
        ...job,
        applicantCount: counts[job.id] || 0,
        employeeCount: employmentCounts[job.id] || 0,
    }));

    // A jobs failure with no cached list drives the same banner the old
    // load-failure path showed; a failure on top of cached data (a background
    // revalidation that failed) keeps the list visible without the banner.
    const jobsLoadFailed = jobsQuery.isError && !jobsQuery.data;
    const bannerMessage = error || (jobsLoadFailed ? JOB_LOAD_ERROR : '');

    // The old isLoading released only after identity AND the jobs/counts/
    // employments chain had settled, counting as settled when there was no
    // session at all. Same rule here -- with the uid guard because a disabled
    // query stays in its pending state.
    const isLoading =
        !identitySettled ||
        (Boolean(uid) && (jobsQuery.isPending || countsQuery.isPending || employmentsQuery.isPending));

    if (isLoading) {
        return <PageLoader label="Loading your jobs…" />;
    }

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={user} />

            <PageContainer className="py-8">
                <div className="space-y-6">
                    <PageHeader
                        title="My Jobs"
                        description="Every job you have posted."
                        actions={
                            <Button onClick={() => navigate('/post-job')}>
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                Post new job
                            </Button>
                        }
                    />

                    {bannerMessage && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{bannerMessage}</span>
                        </div>
                    )}

                    <div className="space-y-4">
                        <h2 className="text-lg font-semibold text-foreground">
                            Your job postings ({jobs.length})
                        </h2>

                        {jobs.length === 0 ? (
                            <EmptyState
                                icon={Briefcase}
                                title="No jobs posted yet"
                                description="Start by posting your first job to attract talented candidates."
                                action={
                                    <Button onClick={() => navigate('/post-job')}>
                                        <Plus className="h-4 w-4" aria-hidden="true" />
                                        Post your first job
                                    </Button>
                                }
                            />
                        ) : (
                            <ul className="space-y-4">
                                {jobs.map((job) => (
                                    <Card as="li" key={job.id} className="p-5 sm:p-6">
                                        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                                            <div className="min-w-0 flex-1 space-y-3">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h3 className="break-words text-lg font-semibold text-foreground">
                                                        {job.title}
                                                    </h3>
                                                    <Badge variant={jobStatusBadgeVariant(job.status)}>
                                                        {jobStatusLabel(job.status)}
                                                    </Badge>
                                                </div>

                                                <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm text-foreground-muted sm:grid-cols-2">
                                                    <div className="flex items-center gap-2">
                                                        <MapPin className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                        <span className="break-words">{job.location}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <Calendar className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                        {/* Jobs store ISO strings, so this is a
                                                            direct parse rather than the
                                                            Timestamp decode the task and
                                                            application lists need. */}
                                                        <span>
                                                            {job.createdAt
                                                                ? new Date(job.createdAt).toLocaleDateString()
                                                                : 'Date not available'}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <DollarSign className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                        <span className="font-medium text-foreground">
                                                            {priceLabel(job.price)}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <Users className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                        <span>
                                                            {job.applicantCount} applicant
                                                            {job.applicantCount !== 1 ? 's' : ''}
                                                        </span>
                                                    </div>
                                                </div>

                                                {job.description && (
                                                    <p className="line-clamp-2 break-words text-sm text-foreground-muted">
                                                        {job.description}
                                                    </p>
                                                )}

                                                {job.jobType && (
                                                    <div className="flex flex-wrap items-center gap-2">
                                                        <Badge variant="neutral">{job.jobType}</Badge>
                                                    </div>
                                                )}
                                            </div>

                                            <div className="flex flex-wrap gap-2 lg:w-56 lg:shrink-0 lg:flex-col">
                                                {/* Existing flows only. `/jobs/:jobId` is the
                                                    detail page, `/edit-job/:jobId` the edit form,
                                                    and the applications route the one
                                                    ViewJobApplications.jsx is registered on. */}
                                                <ActionLink to={`/jobs/${job.id}`} variant="secondary">
                                                    <Eye className="h-4 w-4" aria-hidden="true" />
                                                    Details
                                                </ActionLink>

                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    className="flex-1 lg:w-full"
                                                    onClick={() => navigate(`/edit-job/${job.id}`)}
                                                    disabled={job.applicantCount > 0}
                                                >
                                                    <Edit3 className="h-4 w-4" aria-hidden="true" />
                                                    Edit
                                                </Button>

                                                <Button
                                                    variant="destructive"
                                                    size="sm"
                                                    className="flex-1 lg:w-full"
                                                    onClick={() => handleDeleteJob(job)}
                                                    disabled={job.applicantCount > 0 || deletingId === job.id}
                                                >
                                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                    {deletingId === job.id ? 'Deleting…' : 'Delete'}
                                                </Button>

                                                {/* STAGE 10C: applications are reviewable while the
                                                    job is open AND after it has been filled,
                                                    matching EmployerDashboard. Still gated for a
                                                    CLOSED job, which is a deliberate employer
                                                    decision to stop taking applications. The filled
                                                    branch keeps the distinction: the label changes
                                                    from "View Apps" to "View Applicants". The title
                                                    is encoded because it is part of the path and job
                                                    titles contain spaces. */}
                                                {job.status === 'open' ? (
                                                    <ActionLink
                                                        to={`/employer/jobs/${job.id}/applications/${encodeURIComponent(job.title)}`}
                                                        variant="primary"
                                                    >
                                                        <Eye className="h-4 w-4" aria-hidden="true" />
                                                        View apps
                                                    </ActionLink>
                                                ) : isJobFilled(job.status) ? (
                                                    <ActionLink
                                                        to={`/employer/jobs/${job.id}/applications/${encodeURIComponent(job.title)}`}
                                                        variant="accent"
                                                    >
                                                        <Eye className="h-4 w-4" aria-hidden="true" />
                                                        View applicants
                                                    </ActionLink>
                                                ) : (
                                                    <Button
                                                        variant="secondary"
                                                        size="sm"
                                                        className="flex-1 lg:w-full"
                                                        disabled
                                                    >
                                                        <Eye className="h-4 w-4" aria-hidden="true" />
                                                        Closed
                                                    </Button>
                                                )}

                                                {/* STAGE 10H.3. A SECOND, additive action, drawn
                                                    only once a job has at least one hire. The count
                                                    is the number of employment records for the job,
                                                    so a job that hired twice reads "Manage
                                                    employees (2)". The title is encoded for the
                                                    same reason the applications links above encode
                                                    it: it is a path segment and job titles contain
                                                    spaces. */}
                                                {job.employeeCount > 0 && (
                                                    <ActionLink
                                                        to={`/employer/jobs/${job.id}/employees/${encodeURIComponent(job.title)}`}
                                                        variant="secondary"
                                                    >
                                                        <Users className="h-4 w-4" aria-hidden="true" />
                                                        Manage employees ({job.employeeCount})
                                                    </ActionLink>
                                                )}
                                            </div>
                                        </div>
                                    </Card>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </PageContainer>
        </div>
    );
};

export default MyJobs;