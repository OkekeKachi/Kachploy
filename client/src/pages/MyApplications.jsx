import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import api, { respondToContractProposal } from '../api';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Briefcase, MapPin, Calendar, DollarSign, MessageSquare, CheckCircle2, FileText, Download, Link2, AlertCircle } from 'lucide-react';
import { downloadResume } from '../resumeUpload';
import EmployeeInterviews from '../components/EmployeeInterviews';
import ConversationLauncher from '../components/ConversationLauncher';
import AppNavbar from '../components/AppNavbar';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import { Field, Textarea } from '../components/ui/Field';
import { useContractProposalsQuery, useEmployeeApplicationsQuery } from '../useAppQueries';
import queryKeys from '../queryKeys';
import {
    PROPOSAL_ACCEPTED,
    PROPOSAL_PENDING,
    formatProposalAmount,
    proposalStatusBadgeVariant,
    proposalStatusLabel,
} from '../components/proposalPresentation';

// STAGE 5G: the canonical application status is `accepted`, not the title-cased
// `Employed` this page has always compared against. Documents written before the
// server started validating the field still hold `Employed` / `Not Hired`, and
// there is no migration, so both spellings are mapped here. Local to this
// component -- the employer-facing page has its own copy of the same two
// functions, and there is deliberately no shared status module.
const ACCEPTED = 'accepted';

const canonicalAppStatus = (status) => {
    if (status === 'Employed') return ACCEPTED;
    if (status === 'Not Hired') return 'rejected';
    return status;
};

// The labels are the wording this page already used, so legacy and canonical
// documents are indistinguishable to the applicant. A raw stored value is never
// shown to the user.
const APP_STATUS_LABEL = {
    pending: 'Pending',
    // STAGE 7G-3: `interviewed` is the state an employer puts an application in when
    // they clear the applicant for hiring (Stage 7G-2 added the action). Labelled
    // "Cleared for hiring" to match the employer page word for word, so the applicant
    // and the employer are looking at the same words for the same state.
    //
    // This is display-only. The applicant cannot reach this state, cannot change it,
    // and cannot leave it: withdrawal below is still the only action on this page, and
    // it is still shown because `interviewed` is simply not `ACCEPTED`. Only the
    // employer's own page writes it.
    interviewed: 'Cleared for hiring',
    [ACCEPTED]: 'Employed',
    rejected: 'Not Hired',
};

const appStatusLabel = (status) => APP_STATUS_LABEL[canonicalAppStatus(status)] || 'No status available';

// STAGE 11.8: canonical status -> shared Badge variant. Presentation only -- the
// canonicalisation and the label map above are untouched; this just lets the
// redesign render the existing status through the shared Badge primitive.
const APP_STATUS_BADGE_VARIANT = {
    pending: 'warning',
    interviewed: 'info',
    [ACCEPTED]: 'success',
    rejected: 'danger',
};

const appStatusBadgeVariant = (status) =>
    APP_STATUS_BADGE_VARIANT[canonicalAppStatus(status)] || 'neutral';

// STAGE 7F: surface the server's own message when a request fails. `err.response`
// exists only for a real HTTP error, so a network drop or a thrown TypeError
// falls back to the caller's generic text instead of throwing again while
// reporting.
const readErrorMessage = (err, fallback) =>
    (err && err.response && err.response.data && err.response.data.message) || fallback;

/*
    STAGE 12.13. The materials attached to one application: the private resume
    (reached only through the signed-download endpoint), the cover letter and the
    portfolio link. Self-contained, with its own download state, so one card's
    download cannot affect another's. Renders nothing when the application has
    none of the three, which is the case for every application filed before the
    requirements existed.
*/
const ApplicationMaterials = ({ applicationId, resume, coverLetter, portfolioUrl }) => {
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState('');
    const downloadInFlightRef = useRef(false);

    const hasResume = !!(resume && resume.publicId);
    const hasCoverLetter = typeof coverLetter === 'string' && coverLetter.trim() !== '';
    const hasPortfolio = typeof portfolioUrl === 'string' && portfolioUrl.trim() !== '';

    if (!hasResume && !hasCoverLetter && !hasPortfolio) return null;

    const handleDownload = async () => {
        if (downloadInFlightRef.current) return;
        downloadInFlightRef.current = true;
        setError('');
        setDownloading(true);
        try {
            await downloadResume({ applicationId });
        } catch (err) {
            console.error('Error downloading resume:', err);
            setError('Could not download your resume. Please try again.');
        } finally {
            downloadInFlightRef.current = false;
            setDownloading(false);
        }
    };

    return (
        <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
            {hasCoverLetter && (
                <div>
                    <p className="flex items-center gap-2 font-medium text-foreground">
                        <FileText className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                        Cover letter
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-foreground-muted">
                        {coverLetter}
                    </p>
                </div>
            )}

            {hasPortfolio && (
                <p className="flex items-center gap-2 text-foreground-muted">
                    <Link2 className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                    <a
                        href={portfolioUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-accent hover:underline"
                    >
                        {portfolioUrl}
                    </a>
                </p>
            )}

            {hasResume && (
                <div className="flex flex-wrap items-center gap-3">
                    <FileText className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-foreground-muted">
                        {resume.name || 'Resume.pdf'}
                    </span>
                    <Button variant="secondary" size="sm" onClick={handleDownload} disabled={downloading} aria-busy={downloading}>
                        <Download className="h-4 w-4" aria-hidden="true" />
                        {downloading ? 'Preparing…' : 'Download'}
                    </Button>
                </div>
            )}

            {error && <p className="text-xs font-medium text-danger">{error}</p>}
        </div>
    );
};

// One slot per application: `{ loading, interviews, error }`. Kept in a map keyed
// by application id rather than an array so a fetch that resolves out of order
// cannot land on the wrong card, and so one failing application cannot take the
// others' lists with it.
const initialInterviewState = { loading: true, interviews: [], error: null };

/*
    STAGE 11.8: presentation-only redesign.

    The auth gate, GET /applications/employee/:uid, the per-application interview
    reads and refreshInterviews, the status canonicalisation/labels, the withdraw
    DELETE and the /employee/hired-jobs destination are all unchanged. This stage
    replaces the inline-styled list with the shared AppNavbar/PageContainer/
    PageHeader/Card/Badge/Button/EmptyState/PageLoader shell and lucide-react icons.

    AppNavbar is mounted with a `navUser` built from the Firebase user the
    onAuthStateChanged callback already hands this page -- NOT a new
    GET /users/getUser/:uid read by this page. It therefore carries no `role`;
    AppNavbar resolves the role (and the display name) from its own single,
    session-cached read of that same document instead of guessing, so the
    employee entry set renders here exactly as it does on the dashboard.
    EmployeeInterviews and ConversationLauncher are
    mounted unchanged; they keep their own internal presentation.
*/
const MyApplications = () => {
    const [interviewState, setInterviewState] = useState({});
    const [navUser, setNavUser] = useState({});
    const [withdrawing, setWithdrawing] = useState({});
    const [actionError, setActionError] = useState('');
    const [actionNotice, setActionNotice] = useState('');
    const withdrawInFlightRef = useRef({});
    const queryClient = useQueryClient();
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const applicationsQuery = useEmployeeApplicationsQuery(uid);
    const applications = useMemo(
        () => applicationsQuery.data ?? [],
        [applicationsQuery.data]
    );
    const loading = Boolean(uid) && applicationsQuery.isPending;

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setNavUser(
                user
                    ? { fullName: user.displayName || '', email: user.email || '' }
                    : {}
            );
        });

        return () => unsubscribe();
    }, []);

    /*
        STAGE 7F: one read per application, issued in a single parallel batch.

        The employer page fetches one job-wide request and groups it locally, which
        is the cheaper shape, but it cannot be copied here: GET /interviews/job/:jobId
        is behind requireJobOwner, so an applicant is refused with a 403 for a job
        they applied to. That leaves GET /interviews/application/:applicationId --
        the only applicant-readable endpoint -- which is one request per application
        and is therefore an N+1 over the list. It is issued all at once rather than
        in sequence, so the wall-clock cost is one round trip instead of N, and the
        results are stored per application so re-renders never refetch.

        AUTHORIZATION IS NOT DECIDED HERE
        requireInterviewParty admits either the applicant or the owner of the job,
        so this read is the applicant reading their own application. A 403 or 404
        for anything else is an ordinary error, shown per card.

        STAGE 10A: this effect still only READS. The one write an applicant now has --
        answering an interview -- happens in EmployeeInterviews and comes back through
        refreshInterviews below, so the single reader for one application is this one
        function and both paths cannot drift apart in how they read or how they report
        a failure.
    */
    useEffect(() => {
        // Wait for the applications themselves: issuing interview reads before the
        // ids are known would fire them for an empty list.
        if (loading) return undefined;

        const ids = applications.map(app => app.id).filter(Boolean);
        if (ids.length === 0) {
            setInterviewState({});
            return undefined;
        }

        let cancelled = false;

        // Mark every slot loading up front, so the section renders a loading state
        // rather than an empty one on the first paint after the list arrives.
        setInterviewState(Object.fromEntries(ids.map(id => [id, initialInterviewState])));

        const loadInterviews = async () => {
            const settled = await Promise.all(ids.map(async (id) => {
                try {
                    const res = await api.get(`/interviews/application/${id}`);
                    return [id, { loading: false, interviews: res.data.interviews || [], error: null }];
                } catch (err) {
                    console.error(`Error fetching interviews for application ${id}:`, err);
                    // Isolated per application: one failure reports itself on its own
                    // card and leaves the rest of the page intact.
                    return [id, {
                        loading: false,
                        interviews: [],
                        error: readErrorMessage(err, 'Failed to load interviews for this application'),
                    }];
                }
            }));

            if (cancelled) return;
            setInterviewState(Object.fromEntries(settled));
        };

        loadInterviews();

        return () => { cancelled = true; };
    }, [applications, loading]);

    /*
        STAGE 10A. Re-reads ONE application's interviews, after that application has
        been answered.

        Scoped to a single application rather than refetching the whole list, for the
        same N+1 reason the initial load is batched: an answer changes one interview on
        one card, and re-running every application's request would multiply one click
        by the size of the applicant's whole job list. The employer panel already works
        this way -- InterviewPanel asks its parent for a job-wide refresh -- so this is
        the same shape with a narrower blast radius.

        The other applications' slots are left untouched rather than reset, so answering
        an interview cannot blank out the interviews listed on every other card.

        Returns nothing and throws nothing: EmployeeInterviews has already reported the
        outcome of the write that led here, and a failed re-read must not replace a
        correct answer with a second error on the same card. Instead it puts the read's
        own failure in that slot, exactly as the batch above does, so a stale list is
        visibly marked rather than quietly kept.
    */
    const refreshInterviews = async (applicationId) => {
        try {
            const res = await api.get(`/interviews/application/${applicationId}`);
            setInterviewState((previous) => ({
                ...previous,
                [applicationId]: {
                    loading: false,
                    interviews: res.data.interviews || [],
                    error: null,
                },
            }));
        } catch (err) {
            console.error(`Error refreshing interviews for application ${applicationId}:`, err);
            setInterviewState((previous) => ({
                ...previous,
                [applicationId]: {
                    ...(previous[applicationId] || initialInterviewState),
                    loading: false,
                    error: readErrorMessage(err, 'Your response was saved, but these interviews could not be reloaded'),
                },
            }));
        }
    };

    const handleWithdraw = async (applicationId) => {
        if (withdrawInFlightRef.current[applicationId]) return;

        withdrawInFlightRef.current[applicationId] = true;
        setWithdrawing((previous) => ({ ...previous, [applicationId]: true }));
        setActionError('');
        setActionNotice('');

        try {
            await api.delete(`/applications/${applicationId}`);

            queryClient.setQueryData(
                queryKeys.employeeApplications(uid),
                (previous) =>
                    Array.isArray(previous)
                        ? previous.filter((app) => app.id !== applicationId)
                        : previous
            );

            await queryClient.invalidateQueries({
                queryKey: queryKeys.employeeApplications(uid),
            });
            await queryClient.invalidateQueries({
                queryKey: queryKeys.applicationCounts(uid),
            });

            setActionNotice('Application withdrawn.');
        } catch (err) {
            console.error('Error withdrawing application:', err);
            setActionError(
                readErrorMessage(err, 'Your application could not be withdrawn. Please try again.')
            );
        } finally {
            delete withdrawInFlightRef.current[applicationId];
            setWithdrawing((previous) => {
                const next = { ...previous };
                delete next[applicationId];
                return next;
            });
        }
    };

    if (loading) {
        return <PageLoader label="Loading your applications…" />;
    }

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <div className="space-y-6">
                    <PageHeader
                        title="My Applications"
                        description="Every job you have applied to."
                    />

                    {applicationsQuery.isError && (
                        <div
                            role="alert"
                            className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <span className="flex items-start gap-2">
                                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                <span>
                                    {applications.length > 0
                                        ? 'Your applications could not be refreshed. Showing the last loaded list.'
                                        : 'Your applications could not be loaded.'}
                                </span>
                            </span>
                            <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => applicationsQuery.refetch()}
                                disabled={applicationsQuery.isFetching}
                                aria-busy={applicationsQuery.isFetching}
                            >
                                {applicationsQuery.isFetching ? 'Retrying…' : 'Try again'}
                            </Button>
                        </div>
                    )}

                    {actionError && (
                        <p role="alert" className="rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground">
                            {actionError}
                        </p>
                    )}
                    {actionNotice && (
                        <p role="status" className="rounded-md bg-success-subtle px-4 py-3 text-sm text-success-subtle-foreground">
                            {actionNotice}
                        </p>
                    )}

                    {!applicationsQuery.isError && applications.length === 0 ? (
                        <EmptyState
                            icon={Briefcase}
                            title="No applications yet"
                            description="You haven’t applied to any jobs yet."
                        />
                    ) : applications.length > 0 ? (
                        <ul className="space-y-4">
                            {applications
                        .filter(app => canonicalAppStatus(app.status) !== ACCEPTED)
                        .map(app => {
                                // No slot for this id yet means the read has not been
                                // issued, which has to look like loading rather than like
                                // "no interviews": an empty array is also what a finished
                                // read returns for an application that genuinely has none,
                                // and asserting that before the request went out would be
                                // a statement nobody has established.
                                const ivState = interviewState[app.id];
                                const ivLoading = !ivState || ivState.loading;
                                const isAccepted = canonicalAppStatus(app.status) === ACCEPTED;

                                return (
                                <Card as="li" key={app.id} className="p-5 sm:p-6">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <h3 className="break-words text-lg font-semibold text-foreground">
                                            {app.job?.title || 'Job removed'}
                                        </h3>
                                        <Badge variant={appStatusBadgeVariant(app.status)}>
                                            {appStatusLabel(app.status)}
                                        </Badge>
                                    </div>

                                    <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm text-foreground-muted sm:grid-cols-2">
                                        <div className="flex items-center gap-2">
                                            <MapPin className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                            <span className="break-words">{app.job?.location}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Briefcase className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                            <span>{app.job?.jobType}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <Calendar className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                            <span>
                                                {app.dateApplied?._seconds
                                                    ? new Date(app.dateApplied._seconds * 1000).toLocaleDateString()
                                                    : 'Date not available'}
                                            </span>
                                        </div>
                                        {app.employeePrice && (
                                            <div className="flex items-center gap-2">
                                                <DollarSign className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                <span className="font-medium text-foreground">${app.employeePrice}</span>
                                            </div>
                                        )}
                                    </div>

                                    <div className="mt-3 flex items-start gap-2 text-sm text-foreground-muted">
                                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                        <span className="break-words">{app.message || 'No message'}</span>
                                    </div>

                                    {/* STAGE 12.13: the cover letter, portfolio and private
                                        resume this application carried, if any. */}
                                    <ApplicationMaterials
                                        applicationId={app.id}
                                        resume={app.resume}
                                        coverLetter={app.coverLetter}
                                        portfolioUrl={app.portfolioUrl}
                                    />

                                    {/*
                                        STAGE 7F: read-only. Placed with the other application
                                        details, above the hired/withdraw block, because it is
                                        information about this application rather than an action
                                        on it -- and because the withdraw button must not be
                                        pushed below the fold by a growing interview list.

                                        STAGE 10A: no longer entirely read-only. It still cannot
                                        schedule, reschedule, cancel or complete anything, but it
                                        can now answer an interview, so it re-reads the interviews
                                        for THIS application when it does. `onRespond` is this
                                        page's refreshInterviews, bound to this card's id -- the
                                        card already has that id in scope and the child must not
                                        have to be told which application it is looking at.

                                        BOUND, not passed straight through: the child knows the
                                        interview it acted on and reports that id, while
                                        refreshInterviews reads per APPLICATION. Handing it the
                                        raw function would re-read an application named after an
                                        interview and silently 404 into a red error on a card that
                                        was answered correctly. The wrapper also drops the unused
                                        argument rather than forwarding an id of the wrong kind.
                                    */}
                                    <EmployeeInterviews
                                        interviews={ivState ? ivState.interviews : []}
                                        loading={ivLoading}
                                        error={ivState ? ivState.error : null}
                                        onRespond={() => refreshInterviews(app.id)}
                                    />

                                    <div className="mt-4">
                                        {/*
                                            STAGE 8C: the applicant's way into the conversation with
                                            the employer for this application.

                                            PLACED AFTER THE INTERVIEW SECTION AND BEFORE THE HIRED /
                                            WITHDRAW BLOCK, deliberately. Chat and interviews are two
                                            independent facts about the same application, so neither
                                            enables nor disables the other, exactly as Stage 7E placed
                                            InterviewPanel after the hire buttons on the employer page.
                                            It sits above the withdraw button for the reason that
                                            section's comment gives: a growing thread must not push
                                            Withdraw Application below the fold.

                                            AVAILABLE AT EVERY STATUS, and that is the point of it. An
                                            applicant can open a thread while pending, while cleared
                                            for hiring, and after being hired -- the application stays
                                            in this list in all three cases, so this is also the
                                            post-hire entry point. It is rendered even for a rejected
                                            application because the backend permits it: Stage 8B
                                            deliberately retains the thread, and the applicant is one of
                                            its two recorded participants. Hiding the control here would
                                            be the UI disagreeing with the server rather than with a
                                            product decision this stage is entitled to make.

                                            STAGE 8F. The employer is now identified by NAME, not
                                            by job. `app.job.postedBy` is the uid that posted the
                                            job -- the same uid the conversation stores as
                                            `employerId`.
                                            STAGE 10B. That lookup has MOVED, and so has the job
                                            caption: both belonged to the thread this button used
                                            to render underneath the card, and the thread now has
                                            its own screen at /messages/:conversationId, which
                                            resolves the name and the job title for itself. Passing
                                            them here would have meant passing data that is lost on
                                            a refresh, on a shared link and on a back navigation --
                                            so the two props are gone and this button now only
                                            needs to know which application to open.
                                        */}
                                        <ConversationLauncher
                                            applicationId={app.id}
                                            counterpartRole="applicant"
                                        />
                                    </div>

                                    <div className="mt-4">
                                        <EmployeeProposalSection applicationId={app.id} />
                                    </div>

                                    {isAccepted ? (
                                        <div className="mt-4 rounded-md bg-success-subtle p-4 text-success-subtle-foreground">
                                            <p className="flex items-center gap-2 font-medium">
                                                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                Congratulations! You've been hired for this job.
                                            </p>
                                            <Link
                                                // STAGE 6C: was a raw `<a href>` to this
                                                // same path with the comment "Change this path
                                                // to wherever you want them to go". No route
                                                // matched it, so accepting an applicant was
                                                // congratulated and then sent to an empty
                                                // document. App.jsx now routes it, and <Link>
                                                // keeps the client-side navigation the rest of
                                                // the app uses.
                                                to="/employee/hired-jobs"
                                                className="mt-3 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-success px-4 text-sm font-medium text-foreground-inverse transition-colors hover:bg-success/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                                            >
                                                View your hired jobs
                                            </Link>
                                        </div>
                                    ) : (
                                        <div className="mt-4">
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                onClick={() => handleWithdraw(app.id)}
                                                disabled={Boolean(withdrawing[app.id])}
                                                aria-busy={Boolean(withdrawing[app.id])}
                                            >
                                                {withdrawing[app.id] ? 'Withdrawing…' : 'Withdraw application'}
                                            </Button>
                                        </div>
                                    )}
                                </Card>
                                );
                            })}
                        </ul>
                    ) : null}
                </div>
            </PageContainer>
        </div>
    );
};

const EmployeeProposalSection = ({ applicationId }) => {
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const respondInFlightRef = useRef(false);
    const messageId = useId();
    const queryClient = useQueryClient();
    const proposalsQuery = useContractProposalsQuery(applicationId);
    const proposals = proposalsQuery.data ?? [];

    const handleRespond = async (proposalId, action) => {
        if (respondInFlightRef.current) return;

        respondInFlightRef.current = true;
        setSubmitting(true);
        setError('');

        try {
            await respondToContractProposal(proposalId, { action, message });
            setMessage('');
            await queryClient.invalidateQueries({
                queryKey: queryKeys.contractProposals(applicationId),
            });
        } catch (err) {
            setError(readErrorMessage(err, 'Your response could not be sent. Please try again.'));
        } finally {
            respondInFlightRef.current = false;
            setSubmitting(false);
        }
    };

    if (proposalsQuery.isPending) {
        return (
            <Card className="p-4">
                <p role="status" className="text-sm text-foreground-muted">Loading contract proposals...</p>
            </Card>
        );
    }

    if (proposalsQuery.isError && proposals.length === 0) {
        return (
            <Card className="space-y-3 p-4">
                <p role="alert" className="text-sm font-medium text-danger">
                    Contract proposals could not be loaded.
                </p>
                <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => proposalsQuery.refetch()}
                    disabled={proposalsQuery.isFetching}
                    aria-busy={proposalsQuery.isFetching}
                >
                    {proposalsQuery.isFetching ? 'Retrying…' : 'Try again'}
                </Button>
            </Card>
        );
    }

    if (proposals.length === 0) {
        return null;
    }

    return (
        <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-foreground">Contract Proposal</h4>
                <Badge variant="neutral">Does not finalize hiring</Badge>
            </div>
            <p className="text-xs text-foreground-muted">
                Review proposed terms. Accepting means terms agreed, not hiring finalized.
            </p>
            {proposalsQuery.isError && (
                <p role="alert" className="text-xs font-medium text-danger">
                    These proposals could not be refreshed. Showing the last loaded terms.
                </p>
            )}
            {error && <p role="alert" className="text-xs font-medium text-danger">{error}</p>}
            {proposals.map((proposal) => (
                <div key={proposal.id} className="border border-border rounded-md p-3 space-y-2 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge variant={proposalStatusBadgeVariant(proposal.status)}>
                            {proposalStatusLabel(proposal.status)}
                        </Badge>
                        <span>Payment mode: {proposal.paymentMode}</span>
                    </div>
                    {proposal.totalAmountMinor !== undefined && proposal.totalAmountMinor !== null && (
                        <div>Total amount: {formatProposalAmount(proposal.totalAmountMinor)}</div>
                    )}
                    {proposal.commissionAmountMinor !== undefined && proposal.commissionAmountMinor !== null && (
                        <div>Commission: {formatProposalAmount(proposal.commissionAmountMinor)}</div>
                    )}
                    {Array.isArray(proposal.milestones) && proposal.milestones.length > 0 && (
                        <div>
                            <div className="font-medium">Milestones</div>
                            <ul className="list-disc ml-5 space-y-1">
                                {proposal.milestones.map((m, idx) => (
                                    <li key={idx}>
                                        <span className="font-medium">{m.label}</span> — {formatProposalAmount(m.amountMinor)}
                                        {m.description ? <div className="text-xs text-foreground-muted">{m.description}</div> : null}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {proposal.responseMessage && (
                        <div className="text-xs text-foreground-muted">
                            <span className="font-medium">Response message:</span> {proposal.responseMessage}
                        </div>
                    )}
                    {proposal.status === PROPOSAL_PENDING && (
                        <div className="space-y-2 pt-1">
                            <Field id={`${messageId}-${proposal.id}`} label="Message (optional)">
                                <Textarea
                                    id={`${messageId}-${proposal.id}`}
                                    value={message}
                                    onChange={(e) => setMessage(e.target.value)}
                                    rows={2}
                                    disabled={submitting}
                                />
                            </Field>
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    size="sm"
                                    onClick={() => handleRespond(proposal.id, 'accept')}
                                    disabled={submitting}
                                    aria-busy={submitting}
                                >
                                    {submitting ? 'Sending...' : 'Accept terms (does not finalize hiring)'}
                                </Button>
                                <Button
                                    size="sm"
                                    variant="secondary"
                                    onClick={() => handleRespond(proposal.id, 'request_changes')}
                                    disabled={submitting}
                                    aria-busy={submitting}
                                >
                                    Request changes
                                </Button>
                            </div>
                        </div>
                    )}
                    {proposal.status === PROPOSAL_ACCEPTED && (
                        <div className="text-xs font-medium text-success">
                            Terms accepted. Waiting for the employer to finalize the hire.
                        </div>
                    )}
                    {proposal.status === 'changes_requested' && (
                        <div className="text-xs text-foreground-muted">
                            You requested changes. Waiting for the employer to send revised terms.
                        </div>
                    )}
                </div>
            ))}
        </Card>
    );
};

export default MyApplications;
