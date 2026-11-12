import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import api, { completeEmployment, terminateEmployment, recordEmploymentSettlement, createDispute, submitDisputeEvidence, listDisputes, createReview } from '../api';
import { apiErrorMessage } from '../apiErrorMessage';
import { ArrowLeft, Briefcase, Calendar, MapPin, User, AlertCircle } from 'lucide-react';
import AppNavbar from '../components/AppNavbar';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import ConversationLauncher from '../components/ConversationLauncher';
// STAGE 10H.4.2: review actions reuse the employer's existing TaskReviewPanel,
// extracted from ViewJobApplications.jsx, so a submitted task is approved or sent back
// through the exact same control on both employer surfaces. SubmittedWork is no longer
// imported here directly -- TaskReviewPanel owns the one rendering of it.
import TaskReviewPanel from '../components/TaskReviewPanel';
// STAGE 1I.1: the milestones/payment panel for this employment's contract. It
// owns its own reads and the employer's Checkout / Refresh status actions; this
// page only places it.
import MilestonePaymentPanel from '../components/MilestonePaymentPanel';
// STAGE 1I.3: the contract workflow (employer creates, employee accepts) that
// must exist before any milestone can be paid.
import ContractSetupPanel from '../components/ContractSetupPanel';
import TaskCreateForm from '../components/TaskCreateForm';
import { dateLabel, employmentStatusLabel } from '../components/taskPresentation';
import { useUserQuery } from '../useUserQuery';
import { canReviewEmployment } from '../reviewEligibility';

/**
 * STAGE 10H.4.1. The employer's READ-ONLY workspace for ONE employment.
 *
 * WHAT THIS PAGE IS. The employer side of the per-employment view the employee
 * already has at /employee/hired-jobs/:employmentId (EmployeeJobTasks.jsx). It is
 * reached from a row of ManageEmployees.jsx (Stage 10H.3) and shows that one
 * hire: who was hired, on what job, since when, the work assigned to THIS
 * employment, the interviews recorded against the application it came from, and
 * the way into the conversation with that employee.
 *
 * STAGE 10H.4.2. The one write this page gained is task REVIEW: an employer may
 * approve a submitted task or send it back with a note, through the shared
 * components/TaskReviewPanel, and only for tasks in `submitted` -- the one status
 * taskService accepts a transition from. Task creation, employee submission,
 * interview changes and employment completion are still absent: every one of those
 * is a later stage, and this page never writes an employment, a task status or an
 * interview.
 *
 * THE ROUTE CANNOT COLLIDE WITH /employer/jobs/:jobId/employees/:jobTitle.
 *   That route is `employer / jobs / :jobId / employees / :jobTitle`. This one is
 *   `employer / jobs / :jobId / employments / :employmentId`. The two differ at
 *   the fourth segment -- static `employees` versus static `employments` -- so
 *   React Router ranks them apart and neither can shadow the other, exactly as
 *   the `applications` / `employees` pairing Stage 10H.3 documented.
 *
 * THE URL SELECTS A REQUEST. IT NEVER CONFERS ACCESS.
 *   `:employmentId` is treated as a question -- "is this an employment I am party
 *   to?" -- and the answer comes from the server, not from the path:
 *
 *     1. `protect` on the route requires a signed-in user.
 *     2. The employment is read with GET /employments/:employmentId, guarded
 *        server-side by requireEmploymentParty, which admits only that
 *        employment's own employer or employee. A stranger gets a 403 and a
 *        missing id a 404, both with no employment data in the body.
 *     3. The returned document must name the job in the path -- `jobId` from the
 *        URL is compared against `employment.jobId`, and a mismatch is treated as
 *        "not available" without issuing any further request. This is what stops
 *        a valid employment id being paired with an unrelated job id in the URL.
 *
 *   So editing the URL can at worst land on the "not available" state. It cannot
 *   show another employer's hire: the guard refuses the read before this page sees
 *   anything, and every subsequent request is built from the verified employment
 *   document rather than from a path segment.
 *
 * TASK ASSOCIATION IS STRICT, AND THAT IS DELIBERATE.
 *   The tasks shown are exactly those whose `employmentId` equals this
 *   employment's id. There is no fallback to `applicationId`, `employeeId` or
 *   `jobId`. A legacy task written before Stage 9B has no `employmentId` (it is
 *   null), and a job can hire more than one person, so neither the job nor even
 *   the employee uniquely identifies this hire. taskPresentation.groupTasksByEmployment
 *   -- which the employee views use -- deliberately falls back through
 *   applicationId and then jobId, so it is NOT used here: on the employer side a
 *   fallback could surface another employment's work. A task that cannot be
 *   associated by its own `employmentId` is omitted rather than guessed at.
 *
 * NO SERVER CHANGE. Every read here already exists and is already guarded:
 *   GET /employments/:employmentId            requireEmploymentParty
 *   GET /users/getUser/:userId                protect (public profile for others)
 *   GET /jobs/:jobId                          protect
 *   GET /tasks/job/:jobId                     requireJobOwner
 *   GET /interviews/application/:applicationId requireInterviewParty
 *   POST /conversations (via ConversationLauncher) requireConversationParticipant
 */

const JOB_BACKFALL = '/my-jobs';

const startDateSortValue = (value) => {
    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        return value._seconds * 1000;
    }

    if (typeof value === 'string' && value) {
        const millis = new Date(value).getTime();
        return Number.isNaN(millis) ? 0 : millis;
    }

    return 0;
};

const getInitials = (fullName) => {
    if (!fullName) return '?';

    const names = fullName.trim().split(/\s+/);
    const first = names[0]?.charAt(0) || '';
    const last = names.length > 1 ? names[names.length - 1].charAt(0) : '';

    return (first + last).toUpperCase() || '?';
};

// STAGE 11.12: employment status -> shared Badge variant, mirroring
// ManageEmployees.jsx and HiredJobs.jsx. Presentation only.
const employmentStatusBadgeVariant = (status) => {
    if (status === 'active') return 'success';
    if (status === 'completed') return 'info';
    if (status === 'terminated') return 'warning';
    if (status === 'ended') return 'neutral';
    return 'neutral';
};

/*
    A <Link> styled as a Button, matching HiredJobs.jsx / ManageEmployees.jsx. The
    page's navigation actions are destinations, so they keep their anchor semantics
    (middle-click / open-in-new-tab) rather than becoming <button>.
*/
const ActionLink = ({ to, variant = 'secondary', className = '', children }) => {
    const variants = {
        primary: 'border-transparent bg-accent text-foreground-inverse hover:bg-accent-hover',
        secondary: 'border-border-strong bg-surface text-foreground hover:bg-surface-muted',
    };

    return (
        <Link
            to={to}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${variants[variant]} ${className}`}
        >
            {children}
        </Link>
    );
};

// Mirrors the local decoder EmployeeInterviews.jsx and ConversationPage.jsx keep:
// `scheduledAt` reaches the client as the ISO string InterviewPanel writes, or as a
// Firestore Timestamp from a record written elsewhere. Both are decoded, and a
// malformed value yields a sentence rather than throwing.
const toDate = (value) => {
    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        const fromTimestamp = new Date(value._seconds * 1000);
        return Number.isNaN(fromTimestamp.getTime()) ? null : fromTimestamp;
    }

    if (typeof value === 'string' && value) {
        const fromString = new Date(value);
        return Number.isNaN(fromString.getTime()) ? null : fromString;
    }

    return null;
};

const scheduledLabel = (value) => {
    const date = toDate(value);
    if (!date) return 'Date not available';

    return `${date.toLocaleString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`;
};

const INTERVIEW_TYPE_LABEL = { online: 'Online', in_person: 'In person' };
const INTERVIEW_STATUS_LABEL = {
    scheduled: 'Scheduled',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'No show',
};
const INTERVIEW_RESPONSE_LABEL = { accepted: 'Accepted', declined: 'Declined' };

// Mirrors the server's DISPUTE_CATEGORIES allow-list. Sending a value outside
// it is a 400, so the form only offers these.
const DISPUTE_CATEGORY_OPTIONS = [
    { value: 'payment', label: 'Payment' },
    { value: 'work_quality', label: 'Work quality' },
    { value: 'scope', label: 'Scope' },
    { value: 'non_payment', label: 'Non-payment' },
    { value: 'other', label: 'Other' },
];

const interviewTypeLabel = (type) => INTERVIEW_TYPE_LABEL[type] || type;
const interviewStatusLabel = (status) => INTERVIEW_STATUS_LABEL[status] || status;
const interviewResponseLabel = (interview) => {
    if (!interview.response) return 'Awaiting response';
    return INTERVIEW_RESPONSE_LABEL[interview.response] || interview.response;
};

const EmployeeWorkspace = () => {
    const { jobId, employmentId } = useParams();

    // Read for the navbar. Phase 5A of the data-fetching audit: this is the
    // shared identity query (useUserQuery.js) instead of a per-mount
    // GET /users/getUser issued inside the effect below; `user` is the same
    // document the old `setUser` held.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);
    const user = userQuery.data || {};
    const [employment, setEmployment] = useState(null);
    const [profile, setProfile] = useState(null);
    const [job, setJob] = useState(null);
    const [jobForJobId, setJobForJobId] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [interviews, setInterviews] = useState([]);

    // STAGE 1I.3: bumped when a contract is created or accepted, so the
    // Milestones & Payment panel re-reads the now-existing contract and its
    // schedule. The contract panel owns the write; this page only relays the
    // signal between the two panels.
    const [contractReloadToken, setContractReloadToken] = useState(0);
    const handleContractChanged = useCallback(() => {
        setContractReloadToken((token) => token + 1);
    }, []);

    // STAGE 1I.4: bumped when MilestonePaymentPanel refreshes or verifies a
    // payment elsewhere in this workspace, so an already-open TaskCreateForm
    // re-fetches the milestone payments it is displaying and stays in sync.
    const [paymentsKey, setPaymentsKey] = useState(0);
    const handlePaymentRefreshed = useCallback(() => {
        setPaymentsKey((key) => key + 1);
    }, []);

    const [loading, setLoading] = useState(true);
    // A refused/missing employment, or an employment whose jobId does not match the
    // path, is "this address is not one of your hires" rather than a page failure.
    const [unavailable, setUnavailable] = useState(false);
    const [error, setError] = useState('');

    // Enrichment failures, each reported beside the section it costs rather than
    // taking the page down: the employment header is already known by the time any
    // of these run.
    const [profileUnavailable, setProfileUnavailable] = useState(false);
    const [jobUnavailable, setJobUnavailable] = useState(false);
    const [tasksUnavailable, setTasksUnavailable] = useState(false);
    const [interviewsUnavailable, setInterviewsUnavailable] = useState(false);
    const [actionMsg, setActionMsg] = useState('');
    const [actionErr, setActionErr] = useState('');
    const [reason, setReason] = useState('');
    const [notes, setNotes] = useState('');
    const [settlementNotes, setSettlementNotes] = useState('');
    const [disputeCategory, setDisputeCategory] = useState('other');
    const [disputeReason, setDisputeReason] = useState('');
    const [disputeDetails, setDisputeDetails] = useState('');
    const [disputes, setDisputes] = useState([]);
    const [evidenceText, setEvidenceText] = useState({});
    const [reviewRating, setReviewRating] = useState(5);
    const [reviewComment, setReviewComment] = useState('');

    const loadDisputes = useCallback(async () => {
        if (!uid) return;
        try {
            const res = await listDisputes(uid);
            const list = res.disputes || [];
            setDisputes(list.filter(d => d.employmentId === employmentId));
        } catch {
            // ignore
        }
    }, [employmentId, uid]);

    useEffect(() => {
        if (employmentId) loadDisputes();
    }, [employmentId, loadDisputes]);

    const fetchTasksForJob = useCallback(async () => {
        if (!employment?.jobId) return false;
        try {
            const tasksRes = await api.get(`/tasks/job/${employment.jobId}`);
            setTasks(tasksRes.data.tasks || []);
            setTasksUnavailable(false);
            return true;
        } catch (err) {
            console.error('Error fetching tasks:', err);
            setTasksUnavailable(true);
            return false;
        }
    }, [employment?.jobId]);

    useEffect(() => {
        let cancelled = false;

        setEmployment(null);
        setProfile(null);
        setJob(null);
        setJobForJobId(null);
        setTasks([]);
        setInterviews([]);
        setLoading(true);
        setUnavailable(false);
        setError('');
        setProfileUnavailable(false);
        setJobUnavailable(false);
        setTasksUnavailable(false);
        setInterviewsUnavailable(false);

        const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
            if (!authUser) {
                // ProtectedRoute normally turns an anonymous visitor away, but the
                // session can still resolve empty after that render.
                if (!cancelled) setLoading(false);
                return;
            }

            let selected = null;

            try {
                const res = await api.get(`/employments/${employmentId}`);
                if (cancelled) return;

                selected = res.data.employment || null;
            } catch (err) {
                console.error('Error fetching employment:', err);
                if (cancelled) return;

                setLoading(false);

                const status = err && err.response && err.response.status;

                if (status === 403 || status === 404) {
                    setUnavailable(true);
                } else {
                    setError(
                        'This employee workspace could not be loaded. Please reload the page to try again.'
                    );
                }

                return;
            }

            // The one check the server cannot make for us: the employment must name
            // the job in the path. A mismatch means the URL pairs a real employment
            // with an unrelated job, and nothing further is requested.
            if (!selected || selected.jobId !== jobId) {
                if (!cancelled) {
                    setLoading(false);
                    setUnavailable(true);
                }
                return;
            }

            if (cancelled) return;

            setEmployment(selected);
            setLoading(false);

            // The employee's public profile. One cross-user read; a failure leaves the
            // header showing the employee id instead of a name, as ManageEmployees does.
            try {
                const profileRes = await api.get(`/users/getUser/${selected.employeeId}`);
                if (!cancelled) setProfile(profileRes.data.user || null);
            } catch (err) {
                console.error('Error fetching employee profile:', err);
                if (!cancelled) setProfileUnavailable(true);
            }

            if (cancelled) return;

            // The job title and location. Enrichment only: a failure leaves the header
            // without them and the page still works.
            try {
                const jobRes = await api.get(`/jobs/${selected.jobId}`);
                if (!cancelled) {
                    setJob(jobRes.data.job || null);
                    setJobForJobId(selected.jobId);
                }
            } catch (err) {
                console.error('Error fetching job details:', err);
                if (!cancelled) {
                    setJob(null);
                    setJobForJobId(selected.jobId);
                    setJobUnavailable(true);
                }
            }

            if (cancelled) return;

            // Every task on the job, then filtered to THIS employment by its own
            // employmentId. See the header note on why there is no fallback.
            try {
                const tasksRes = await api.get(`/tasks/job/${selected.jobId}`);
                if (!cancelled) setTasks(tasksRes.data.tasks || []);
            } catch (err) {
                console.error('Error fetching tasks:', err);
                if (!cancelled) setTasksUnavailable(true);
            }

            if (cancelled) return;

            // Interviews for the application this employment came from. An employment
            // written by createEmploymentFromHire always carries an applicationId;
            // if one is somehow absent, skip the read rather than request "undefined".
            if (!selected.applicationId) {
                if (!cancelled) setInterviewsUnavailable(true);
                return;
            }

            try {
                const interviewsRes = await api.get(
                    `/interviews/application/${selected.applicationId}`
                );
                if (!cancelled) setInterviews(interviewsRes.data.interviews || []);
            } catch (err) {
                console.error('Error fetching interviews:', err);
                if (!cancelled) setInterviewsUnavailable(true);
            }
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [employmentId, jobId]);

    // STAGE 10H.4.2: re-reads the one task a review just changed, through the
    // single-task endpoint Stage 9C added (GET /tasks/:taskId, requireTaskParty), the
    // same read ViewJobApplications.jsx uses. The refreshed document REPLACES the list
    // entry rather than being merged into it, so nothing the server did not just send
    // can be left behind. A failed refresh returns false; TaskReviewPanel reports that
    // separately from the review itself, which has already been recorded by then.
    const refreshTask = useCallback(async (taskId) => {
        try {
            const res = await api.get(`/tasks/${taskId}`);
            const refreshed = res.data.task;
            if (!refreshed) return false;

            setTasks((current) => current.map((task) => (task.id === taskId ? refreshed : task)));
            return true;
        } catch (err) {
            console.error('Error refreshing task:', err);
            return false;
        }
    }, []);

    if (loading) {
        return <PageLoader label="Loading employee workspace…" />;
    }

    if (error) {
        return (
            <div className="min-h-screen bg-canvas">
                <AppNavbar user={user} />
                <PageContainer className="py-8">
                    <div className="space-y-6">
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{error}</span>
                        </div>
                        <ActionLink to={JOB_BACKFALL} variant="secondary">
                            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                            Back to My Jobs
                        </ActionLink>
                    </div>
                </PageContainer>
            </div>
        );
    }

    if (unavailable || !employment) {
        return (
            <div className="min-h-screen bg-canvas">
                <AppNavbar user={user} />
                <PageContainer className="py-8">
                    <EmptyState
                        icon={Briefcase}
                        title="This employee workspace is not available"
                        description="This employment could not be found, it is not one of yours, or its address does not match this job."
                        action={
                            <ActionLink to={JOB_BACKFALL} variant="secondary">
                                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                                Back to My Jobs
                            </ActionLink>
                        }
                    />
                </PageContainer>
            </div>
        );
    }

    // Strict association: only tasks that name this exact employment. A legacy task
    // whose employmentId is null, or a task attached to another employment, is
    // omitted rather than matched by employee or job.
    const employmentTasks = tasks.filter(
        (task) => task && task.employmentId && task.employmentId === employment.id
    );

    const sortedInterviews = [...interviews].sort(
        (a, b) => startDateSortValue(a.scheduledAt) - startDateSortValue(b.scheduledAt)
    );

    const employeeName =
        (profile && profile.fullName) || employment.employeeId || 'Employee name unavailable';

    const backToEmployees = job && job.title
        ? `/employer/jobs/${jobId}/employees/${encodeURIComponent(job.title)}`
        : JOB_BACKFALL;

    const currentUid = (user && user.uid) || uid;
    const reviewerIsEmployer = employment.employerId === currentUid;
    const employmentMatchesRoute = employment.id === employmentId && employment.jobId === jobId;
    const currentJob = jobForJobId === employment.jobId ? job : null;
    const canReview = employmentMatchesRoute
        && canReviewEmployment(employment, currentJob, currentUid);

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={user} />

            <PageContainer className="py-8">
                <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center">
                    {profile && profile.profilePic ? (
                        <img
                            src={profile.profilePic}
                            alt={employeeName}
                            className="h-12 w-12 flex-shrink-0 rounded-full object-cover sm:h-16 sm:w-16"
                        />
                    ) : (
                        <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-accent sm:h-16 sm:w-16">
                            <span className="font-semibold text-foreground-inverse">
                                {getInitials(profile && profile.fullName)}
                            </span>
                        </div>
                    )}
                    <div className="min-w-0 flex-1">
                        <PageHeader
                            title={employeeName}
                            description={job ? `Hired for "${job.title}"` : 'Hired for this job'}
                            actions={
                                <Badge variant={employmentStatusBadgeVariant(employment.status)}>
                                    {employmentStatusLabel(employment)}
                                </Badge>
                            }
                        />
                    </div>
                </div>

                <ActionLink to={backToEmployees} variant="secondary" className="mb-6">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Back to employees
                </ActionLink>

                {/* Employment and employee details. Everything here is either a field
                    of the employment document or a public-profile field; nothing is
                    invented and no employment history is implied. */}
                <Card className="mb-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Employment</h2>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="flex items-start gap-3">
                            <User className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                            <div>
                                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Employee</p>
                                <p className="text-foreground">{employeeName}</p>
                                {profile && profile.location && (
                                    <p className="mt-1 flex items-center text-sm text-foreground-muted">
                                        <MapPin className="mr-1 h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                        {profile.location}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="flex items-start gap-3">
                            <Calendar className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                            <div>
                                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Started</p>
                                <p className="text-foreground">{dateLabel(employment.startDate)}</p>
                                {employment.endDate && (
                                    <p className="mt-1 text-sm text-foreground-muted">
                                        Ended {dateLabel(employment.endDate)}
                                    </p>
                                )}
                            </div>
                        </div>

                        <div className="flex items-start gap-3">
                            <Briefcase className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                            <div>
                                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Job</p>
                                {job && job.title ? (
                                    <Link
                                        to={`/jobs/${employment.jobId}`}
                                        className="text-accent hover:text-accent-hover"
                                    >
                                        {job.title}
                                    </Link>
                                ) : (
                                    <p className="text-foreground">Job details unavailable</p>
                                )}
                                {job && job.location && (
                                    <p className="mt-1 text-sm text-foreground-muted">{job.location}</p>
                                )}
                            </div>
                        </div>

                        <div className="flex items-start gap-3">
                            <User className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                            <div>
                                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Status</p>
                                <p className="text-foreground">{employmentStatusLabel(employment)}</p>
                            </div>
                        </div>
                    </div>

                    {profileUnavailable && (
                        <div
                            role="alert"
                            className="mt-4 flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>
                                The employee&apos;s profile could not be loaded, so their id is shown
                                instead of a name.
                            </span>
                        </div>
                    )}
                    {jobUnavailable && (
                        <div
                            role="alert"
                            className="mt-2 flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>
                                Job details could not be loaded, so this page is shown without the job
                                title.
                            </span>
                        </div>
                    )}
                </Card>

                {/* The way into the conversation for the application this employment
                    came from. ConversationLauncher makes sure the conversation exists
                    and navigates to its own screen; authorization stays server-side. */}
                <Card className="mb-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Conversation</h2>
                    {employment.applicationId ? (
                        <ConversationLauncher
                            applicationId={employment.applicationId}
                            counterpartRole="employer"
                        />
                    ) : (
                        <p className="text-foreground-muted">
                            This employment has no application to open a conversation from.
                        </p>
                    )}
                </Card>

                {/* Interviews, read-only, for the employment's application. */}
                <Card className="mb-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Interviews</h2>

                    {interviewsUnavailable ? (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>Interviews could not be loaded for this application.</span>
                        </div>
                    ) : sortedInterviews.length === 0 ? (
                        <p className="text-foreground-muted">
                            No interviews have been scheduled for this application.
                        </p>
                    ) : (
                        <ul className="list-none space-y-3 p-0">
                            {sortedInterviews.map((interview) => (
                                <li
                                    key={interview.id}
                                    className="rounded-lg border border-border p-4"
                                >
                                    <p className="mb-1 text-sm text-foreground-muted">
                                        <span className="font-semibold text-foreground">When:</span>{' '}
                                        {scheduledLabel(interview.scheduledAt)}
                                    </p>
                                    <p className="mb-1 text-sm text-foreground-muted">
                                        <span className="font-semibold text-foreground">Type:</span>{' '}
                                        {interviewTypeLabel(interview.type)}
                                    </p>
                                    <p className="mb-1 text-sm text-foreground-muted">
                                        <span className="font-semibold text-foreground">Status:</span>{' '}
                                        {interviewStatusLabel(interview.status)}
                                    </p>
                                    <p className="mb-1 text-sm text-foreground-muted">
                                        <span className="font-semibold text-foreground">
                                            Employee response:
                                        </span>{' '}
                                        {interviewResponseLabel(interview)}
                                    </p>
                                    {interview.duration != null && (
                                        <p className="mb-1 text-sm text-foreground-muted">
                                            <span className="font-semibold text-foreground">
                                                Duration:
                                            </span>{' '}
                                            {interview.duration} minutes
                                        </p>
                                    )}
                                    {interview.meetingLink && (
                                        <p className="mb-1 text-sm text-foreground-muted">
                                            <span className="font-semibold text-foreground">
                                                Meeting link:
                                            </span>{' '}
                                            {interview.meetingLink}
                                        </p>
                                    )}
                                    {interview.location && (
                                        <p className="text-sm text-foreground-muted">
                                            <span className="font-semibold text-foreground">
                                                Location:
                                            </span>{' '}
                                            {interview.location}
                                        </p>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>

                {/* STAGE 10H.4.2: the work assigned to THIS employment, now with the
                    employer's review actions. The list is still filtered strictly by
                    employmentId (see the header note), so the panel can only ever be
                    handed this hire's work -- it never falls back to applicationId or
                    jobId. Review actions come from the shared TaskReviewPanel, which
                    offers them only for `submitted` tasks, the one status taskService
                    allows a transition from. */}
                <Card className="p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">
                        Tasks ({employmentTasks.length})
                    </h2>

                    {tasksUnavailable ? (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>Tasks could not be loaded, so no work is shown for this employment.</span>
                        </div>
                    ) : employmentTasks.length === 0 ? (
                        <p className="text-foreground-muted">
                            No work is linked to this employment yet. A task appears here once it
                            is created for this hire.
                        </p>
                    ) : (
                        <TaskReviewPanel
                            tasks={employmentTasks}
                            refreshTask={refreshTask}
                            heading={null}
                        />
                    )}

                    <TaskCreateForm
                        jobId={employment.jobId}
                        employeeId={employment.employeeId}
                        employmentId={employment.id}
                        applicantName={employeeName}
                        onCreated={fetchTasksForJob}
                        paymentsKey={paymentsKey}
                    />
                </Card>

                {/* STAGE 1I.3: the contract workflow. The employer creates the
                    contract (one total, or milestones linked to this employment's
                    tasks); the employee accepts it; both then see it active. The
                    panel decides what to offer from the contract status and whether
                    the signed-in uid is the employment's employer or employee --
                    the server re-checks both. It passes the employment's own tasks
                    so a milestone can only reference work this hire owns. On any
                    change it bumps contractReloadToken, so the payment panel below
                    re-reads the schedule. No payment is started here. */}
                <ContractSetupPanel
                    employment={employment}
                    currentUid={uid}
                    onChanged={handleContractChanged}
                />

                {/* STAGE 1I.1: the milestones on this employment's contract and their
                    server-reported payment status. The panel loads its own data from
                    GET /contracts/employment/:id and GET /payments/milestone/:id, and
                    offers Checkout and Refresh status to the CONTRACT'S EMPLOYER only
                    (it compares contract.employerId with the signed-in uid). That
                    comparison only decides which controls are drawn; the backend
                    re-derives the employer from the verified token on every payment
                    request, so it is not a security boundary. The reloadToken makes it
                    re-read after a contract is created or accepted. */}
                <MilestonePaymentPanel
                    employment={employment}
                    currentUid={uid}
                    reloadToken={contractReloadToken}
                    onPaymentRefreshed={handlePaymentRefreshed}
                />

                {/* Employment lifecycle actions */}
                <Card className="mt-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Employment Lifecycle</h2>
                    {actionMsg && <p className="mb-2 text-sm text-success">{actionMsg}</p>}
                    {actionErr && <p className="mb-2 text-sm text-danger">{actionErr}</p>}
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div>
                            <p className="text-xs uppercase tracking-wide text-foreground-subtle">Complete</p>
                            <input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} />
                            <input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
                            <Button className="mt-2" disabled={employment.status !== 'active'} onClick={async () => {
                                setActionMsg(''); setActionErr('');
                                try {
                                    await completeEmployment(employment.id, { reason, notes });
                                    setActionMsg('Employment marked completed');
                                    window.location.reload();
                                } catch (e) {
                                    setActionErr(apiErrorMessage(e, 'Failed to complete'));
                                }
                            }}>Mark Completed</Button>
                        </div>
                        <div>
                            <p className="text-xs uppercase tracking-wide text-foreground-subtle">Terminate</p>
                            <input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
                            <input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
                            <Button className="mt-2" disabled={employment.status !== 'active'} onClick={async () => {
                                setActionMsg(''); setActionErr('');
                                try {
                                    await terminateEmployment(employment.id, { reason, notes });
                                    setActionMsg('Employment terminated');
                                    window.location.reload();
                                } catch (e) {
                                    setActionErr(apiErrorMessage(e, 'Failed to terminate'));
                                }
                            }}>Terminate</Button>
                        </div>
                    </div>
                    <div className="mt-4">
                        <p className="text-xs uppercase tracking-wide text-foreground-subtle">Settlement (record)</p>
                        <input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Notes (optional)" value={settlementNotes} onChange={(e) => setSettlementNotes(e.target.value)} />
                        <Button className="mt-2" onClick={async () => {
                            setActionMsg(''); setActionErr('');
                            try {
                                await recordEmploymentSettlement(employment.id, { notes: settlementNotes });
                                setActionMsg('Settlement recorded');
                            } catch (e) {
                                setActionErr(apiErrorMessage(e, 'Failed to record settlement'));
                            }
                        }}>Record Settlement</Button>
                    </div>
                </Card>

                {/* Disputes */}
                <Card className="mt-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Disputes</h2>
                    {actionErr && <p className="mb-2 text-sm text-danger">{actionErr}</p>}
                    <div className="mb-3">
                        <select className="w-full rounded-md border border-border px-3 py-2 text-sm" value={disputeCategory} onChange={(e) => setDisputeCategory(e.target.value)}>
                            {DISPUTE_CATEGORY_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        <input className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Reason (required)" value={disputeReason} onChange={(e) => setDisputeReason(e.target.value)} />
                        <textarea className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Details (optional)" value={disputeDetails} onChange={(e) => setDisputeDetails(e.target.value)} />
                        <Button className="mt-2" onClick={async () => {
                            setActionErr(''); setActionMsg('');
                            try {
                                await createDispute(employment.id, { category: disputeCategory, reason: disputeReason, description: disputeDetails });
                                setActionMsg('Dispute created');
                                setDisputeCategory('other'); setDisputeReason(''); setDisputeDetails('');
                                loadDisputes();
                            } catch (e) {
                                setActionErr(apiErrorMessage(e, 'Failed to create dispute'));
                            }
                        }}>Open Dispute</Button>
                    </div>
                    {disputes.length === 0 ? <p className="text-sm text-foreground-muted">No disputes</p> : (
                        <ul className="space-y-3">
                            {disputes.map(d => (
                                <li key={d.id} className="rounded-md border border-border p-3">
                                    <p className="text-sm font-medium">{d.reason} <Badge variant="neutral">{d.status}</Badge></p>
                                    {d.description && <p className="text-sm text-foreground-muted">{d.description}</p>}
                                    <div className="mt-2">
                                        <input className="w-full rounded-md border border-border px-2 py-1 text-sm" placeholder="Evidence text" value={evidenceText[d.id] || ''} onChange={(e) => setEvidenceText(v => ({...v, [d.id]: e.target.value}))} />
                                        <Button className="mt-1 h-8 px-2 text-xs" onClick={async () => {
                                            try {
                                                await submitDisputeEvidence(d.id, { evidenceType: 'text', content: evidenceText[d.id] || '' });
                                                setActionMsg('Evidence submitted');
                                                loadDisputes();
                                            } catch (e) {
                                                setActionErr(apiErrorMessage(e, 'Failed to submit evidence'));
                                            }
                                        }}>Submit Evidence</Button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </Card>

                {/* Reviews */}
                <Card className="mt-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Reviews</h2>
                    {actionMsg && <p className="mb-2 text-sm text-success">{actionMsg}</p>}
                    {actionErr && <p className="mb-2 text-sm text-danger">{actionErr}</p>}
                    {canReview ? (
                        <div className="mb-2">
                            <select className="rounded-md border border-border px-2 py-1 text-sm" value={reviewRating} onChange={(e) => setReviewRating(Number(e.target.value))}>
                                {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                            </select>
                            <textarea className="mt-1 w-full rounded-md border border-border px-3 py-2 text-sm" placeholder="Comment (optional)" value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} />
                            <Button className="mt-2" onClick={async () => {
                                setActionMsg(''); setActionErr('');
                                try {
                                    await createReview(employment.id, { revieweeId: reviewerIsEmployer ? employment.employeeId : employment.employerId, rating: reviewRating, comment: reviewComment });
                                    setActionMsg('Review submitted');
                                    setReviewComment('');
                                } catch (e) {
                                    setActionErr(apiErrorMessage(e, 'Failed to submit review'));
                                }
                            }}>Submit Review</Button>
                        </div>
                    ) : (
                        <p className="text-sm text-foreground-muted">
                            You can review this employee once the employment is completed or terminated, or the job is closed.
                        </p>
                    )}
                </Card>
            </PageContainer>
        </div>
    );
};

export default EmployeeWorkspace;
