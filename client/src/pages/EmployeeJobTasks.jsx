import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api, { fetchPaymentForMilestone } from '../api';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { ArrowLeft, Briefcase, Calendar, MapPin, User, AlertCircle } from 'lucide-react';
import AppNavbar from '../components/AppNavbar';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import TaskCard, { TaskProgress } from '../components/TaskCard';
import ConversationLauncher from '../components/ConversationLauncher';
import ContractSetupPanel from '../components/ContractSetupPanel';
import MilestonePaymentPanel from '../components/MilestonePaymentPanel';
import { dateLabel, employmentStatusLabel, groupTasksByEmployment } from '../components/taskPresentation';

/**
 * STAGE 10F. The employee's task workspace for ONE hired job.
 *
 * My Jobs (HiredJobs.jsx) lists the employee's hires; this page is what a card there
 * opens. It shows one job and only the work assigned on that job, which is what the
 * employee came for, and it is the submit surface again -- Stage 10E had nested the
 * Stage 9D card inside the My Jobs card, and 10F gives it a page of its own so the
 * list stops being a wall of expanded tasks.
 *
 * The cards themselves are the Stage 9D component, imported from
 * components/TaskCard.jsx rather than reimplemented, so the draft state, the
 * double-click guard, the status rules and the submitted-work view are literally the
 * same code the pre-10E list ran. `refreshTask` below is the one piece this page
 * repeats from HiredJobs, deliberately and for now: both pages keep their own task
 * list in their own state, and a shared hook for that is a larger change than this
 * stage is allowed to make. It is the read-after-write step, not the submission --
 * no task lifecycle rule is restated here.
 *
 * THE URL SELECTS A REQUEST. IT NEVER CONFERS ACCESS.
 *   The path segment is an `employmentId`, and it is treated as a question, not an
 *   answer: "is this one of MY employments?" Every check below answers it against
 *   the caller's own data, and the caller is the verified auth session, never
 *   anything in the URL:
 *
 *     1. `protect` on the route requires a signed-in user.
 *     2. The uid comes from onAuthStateChanged, and the employment list is read with
 *        GET /employments/employee/:uid -- which the server restricts to the caller
 *        with requireSelfParam, so a hand-edited uid in the path 403s and returns
 *        nothing. The page cannot widen this by editing the URL.
 *     3. The param is then matched against THAT list. A param that names no
 *        employment of this employee is not a job of theirs, and the page stops
 *        there: it renders the "not one of your jobs" state and issues no further
 *        request. In particular it never asks for tasks by an id from the URL.
 *     4. The jobId used for the title is read from the EMPLOYMENT document, not from
 *        the URL, so there is no way to point this page at a job the employee was
 *        never hired for.
 *     5. The task list is the caller's own from GET /tasks/employee/:uid, filtered
 *        down to this employment with the same groupTasksByEmployment rules the My
 *        Jobs list uses. So even a param that somehow matched a row, the tasks
 *        shown are only ever the caller's own, and only those attached to the
 *        employment that row names.
 *     6. Submission still goes to POST /tasks/:taskId/submit, which requireTaskParty
 *        authorizes from the task's own employmentId and the employment document.
 *        Nothing this page decides is an input to that decision.
 *
 *   So editing the URL can, at worst, land on a not-found page. It cannot show
 *   another employee's job, another employee's tasks, or a job the employee applied
 *   to but was not hired for. There is no new backend endpoint and no new guard:
 *   every read used here is one My Jobs already made.
 *
 * STAGE 11.13: presentation-only redesign. The render tree below now uses the shared
 * design system (AppNavbar, PageContainer/PageHeader, Card, Badge, EmptyState,
 * PageLoader, tokens and Lucide icons) exactly as EmployeeWorkspace.jsx, HiredJobs.jsx
 * and ManageEmployees.jsx do. The authentication flow, the ownership check, every
 * request and its ordering, the soft-failure states, the task association rule and
 * `refreshTask` are all unchanged; only the layout and the visible surfaces changed.
 * The navbar identity is taken from the Firebase user the existing onAuthStateChanged
 * callback already delivers -- no new profile request is made.
 */

// STAGE 11.13: employment status -> shared Badge variant, mirroring
// EmployeeWorkspace.jsx, ManageEmployees.jsx and HiredJobs.jsx. Presentation only --
// the value and its label (employmentStatusLabel) are untouched.
const employmentStatusBadgeVariant = (status) => {
    if (status === 'active') return 'success';
    if (status === 'ended') return 'neutral';
    return 'neutral';
};

/*
    STAGE 11.13: a <Link> styled as a Button, matching EmployeeWorkspace.jsx /
    HiredJobs.jsx / ManageEmployees.jsx. The page's navigation actions are destinations,
    so they keep their anchor semantics (middle-click / open-in-new-tab) rather than
    becoming <button>.
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

const EmployeeJobTasks = () => {
    // The only value the URL contributes. Read, matched against the caller's own
    // employments below, and never used to build a request path of its own.
    const { employmentId } = useParams();

    const [employment, setEmployment] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [milestones, setMilestones] = useState([]);
    const [milestonePayments, setMilestonePayments] = useState({});
    const [job, setJob] = useState(null);
    const [employerName, setEmployerName] = useState('');
    const [employerNameUnavailable, setEmployerNameUnavailable] = useState(false);
    const [jobsUnavailable, setJobsUnavailable] = useState(false);
    const [tasksUnavailable, setTasksUnavailable] = useState(false);
    // STAGE 5I-1 convention: the failure is shown to the user, not only logged.
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(true);
    // Distinguishes "still checking" from "checked, and it is not yours". Without it
    // the not-found state would flash on every load before the employment list
    // arrives, and a reader who follows a valid link would see a wrong answer first.
    const [checked, setChecked] = useState(false);
    // STAGE 11.13: identity for the shared AppNavbar, taken from the auth session the
    // onAuthStateChanged callback already delivers. Presentation only -- no user
    // document read is added by this page; AppNavbar resolves the missing `role`
    // from its own single, session-cached read, so the full role entry set still
    // renders there, exactly as MyApplications/HiredJobs do.
    const [navUser, setNavUser] = useState({});
    // The contract/payment panels need the signed-in uid to distinguish the
    // employee from the employer. It comes from the same auth callback below.
    const [currentUid, setCurrentUid] = useState('');
    // Bumped after the employee accepts a contract so the payment panel re-reads
    // the now-active contract and shows its payment state.
    const [contractReloadToken, setContractReloadToken] = useState(0);
    const handleContractChanged = useCallback(() => {
        setContractReloadToken((token) => token + 1);
    }, []);
    const handleContractLoaded = useCallback((loaded) => {
        setMilestones(Array.isArray(loaded?.milestones) ? loaded.milestones : []);
    }, []);

    useEffect(() => {
        setMilestones([]);
    }, [employmentId]);

    // Fetch payment records for each milestone independently. One failed
    // request does not prevent others from loading. Missing/unavailable
    // records are treated as not confirmed (fail closed).
    useEffect(() => {
        let cancelled = false;

        const fetchMilestonePayments = async () => {
            if (!milestones || milestones.length === 0) {
                if (!cancelled) setMilestonePayments({});
                return;
            }

            const payments = {};
            await Promise.all(
                milestones.map(async (milestone) => {
                    if (!milestone || !milestone.id) return;
                    try {
                        const { payment } = await fetchPaymentForMilestone(milestone.id);
                        if (!cancelled) {
                            payments[milestone.id] = payment || null;
                        }
                    } catch {
                        if (!cancelled) {
                            payments[milestone.id] = null;
                        }
                    }
                })
            );

            if (!cancelled) {
                setMilestonePayments(payments);
            }
        };

        fetchMilestonePayments();

        return () => {
            cancelled = true;
        };
    }, [milestones]);

    useEffect(() => {
        let cancelled = false;
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (!user) {
                // ProtectedRoute normally turns an anonymous visitor away, but the
                // session can still resolve empty after that render.
                if (!cancelled) {
                    setLoading(false);
                    setChecked(true);
                }
                return;
            }

            setNavUser({ fullName: user.displayName || '', email: user.email || '' });
            setCurrentUid(user.uid);

            let selected = null;

            try {
                const res = await api.get(`/employments/employee/${user.uid}`);
                if (cancelled) return;

                // The whole authorization decision on this page, in one place: the
                // param is looked up in the caller's OWN employments and nowhere
                // else. A miss is a normal outcome, not an error to report.
                selected = (res.data.employments || []).find((row) => row && row.id === employmentId) || null;
                setEmployment(selected);
                setError('');
            } catch (err) {
                console.error('Error fetching employments:', err);
                if (cancelled) return;
                setError('This job could not be loaded. Please reload the page to try again.');
            } finally {
                if (!cancelled) {
                    setLoading(false);
                    setChecked(true);
                }
            }

            if (cancelled) return;

            // Nothing below this line runs for a param that is not one of the
            // employee's own employments. No task request is made with an id from the
            // URL, and no job detail is requested for an unverified job.
            if (!selected) return;

            // The employee's own tasks, self-scoped by the server exactly as on the
            // My Jobs list, then filtered to this employment. A failure costs the
            // task list and the submit controls; the job header above is already
            // known, so it stays.
            try {
                const tasksRes = await api.get(`/tasks/employee/${user.uid}`);
                if (cancelled) return;

                setTasks(tasksRes.data.tasks || []);
            } catch (err) {
                console.error('Error fetching tasks:', err);
                if (!cancelled) setTasksUnavailable(true);
            }

            if (cancelled) return;

            // The job title, joined from the employee's own applications -- the same
            // call My Jobs makes. `jobId` comes from the employment document, not the
            // URL. Enrichment: a failure leaves the header without a title.
            try {
                const appsRes = await api.get(`/applications/employee/${user.uid}`);
                if (cancelled) return;

                const match = (appsRes.data.applications || []).find(
                    (app) => app && app.jobId === selected.jobId && app.job
                );

                setJob(match ? match.job : null);
            } catch (err) {
                console.error('Error fetching job details for this hire:', err);
                if (!cancelled) setJobsUnavailable(true);
            }

            if (cancelled) return;

            // The employer name, from the employer's public profile. One request, for
            // the one employer this hire names -- an id read from the employment
            // document, not from the address bar.
            try {
                const res = await api.get(`/users/getUser/${selected.employerId}`);
                if (cancelled) return;

                setEmployerName((res.data.user && res.data.user.fullName) || '');
            } catch (err) {
                console.error('Error fetching employer name:', err);
                if (!cancelled) setEmployerNameUnavailable(true);
            }
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
        // `employmentId` is a dependency because the component is reused by the
        // router when the reader moves between two of their own jobs, and the effect
        // must re-run the lookup for the new one rather than keep the old answer.
    }, [employmentId]);

    /**
     * STAGE 9D's read-after-write, repeated here because this page owns its own task
     * list. Re-reads exactly the one record that changed rather than the whole list,
     * and it is the only way to see the server's own status for it -- the submit
     * response carries the new status but not the rest of the record, and re-reading
     * also promotes a legacy task, whose stored document has no status, to a card
     * that shows its new state correctly.
     *
     * Returns a boolean rather than throwing, so the card can distinguish "the
     * refresh failed" from "the submission failed" -- the submission has already
     * succeeded by the time this runs, and the card says so either way.
     */
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
        return <PageLoader label="Loading your job…" />;
    }

    if (error) {
        return (
            <div className="min-h-screen bg-canvas">
                <AppNavbar user={navUser} />
                <PageContainer className="py-8">
                    <div className="max-w-2xl space-y-6">
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{error}</span>
                        </div>
                        <ActionLink to="/employee/hired-jobs" variant="secondary">
                            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                            Back to My Jobs
                        </ActionLink>
                    </div>
                </PageContainer>
            </div>
        );
    }

    /*
        Shown when the param names no employment of this employee -- which is also what a
        guessed or stale id produces. It says what happened without claiming the id is
        merely unknown: from this employee's point of view the two are the same case, and
        distinguishing them would leak whether some other employee's employment exists.
    */
    if (checked && !employment) {
        return (
            <div className="min-h-screen bg-canvas">
                <AppNavbar user={navUser} />
                <PageContainer className="py-8">
                    <EmptyState
                        icon={Briefcase}
                        title="Job not available"
                        description="This is not one of your hired jobs, so its tasks cannot be shown. It may have been a link from an old page, or the address may have been edited."
                        action={
                            <ActionLink to="/employee/hired-jobs" variant="secondary">
                                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                                Back to My Jobs
                            </ActionLink>
                        }
                    />
                </PageContainer>
            </div>
        );
    }

    // Only this employment's tasks. The grouping is the same one the My Jobs list
    // uses, over a one-element employment list, so a task attached by any of its
    // three links lands on the same card here as it would have there -- and nothing
    // attached to a different hire can land here at all.
    const { buckets } = groupTasksByEmployment([employment], tasks);
    const employmentTasks = buckets[employment.id] || [];

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <PageHeader
                    title={job ? job.title : 'Job details unavailable'}
                    description={employerName || 'Employer name unavailable'}
                    actions={
                        <>
                            <Badge variant={employmentStatusBadgeVariant(employment.status)}>
                                {employmentStatusLabel(employment)}
                            </Badge>
                            {job && (
                                <ActionLink to={`/jobs/${employment.jobId}`} variant="secondary">
                                    View job details
                                </ActionLink>
                            )}
                        </>
                    }
                    className="mb-6"
                />

                <ActionLink to="/employee/hired-jobs" variant="secondary" className="mb-6">
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Back to My Jobs
                </ActionLink>

                <Card className="mb-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Employment</h2>

                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        <div className="flex items-start gap-3">
                            <User className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                            <div>
                                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Employer</p>
                                <p className="text-foreground">{employerName || 'Employer name unavailable'}</p>
                            </div>
                        </div>

                        <div className="flex items-start gap-3">
                            <Calendar className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                            <div>
                                <p className="text-xs uppercase tracking-wide text-foreground-subtle">Started</p>
                                <p className="text-foreground">{dateLabel(employment.startDate)}</p>
                            </div>
                        </div>

                        {employment.endDate && (
                            <div className="flex items-start gap-3">
                                <Calendar className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                <div>
                                    <p className="text-xs uppercase tracking-wide text-foreground-subtle">Ended</p>
                                    <p className="text-foreground">{dateLabel(employment.endDate)}</p>
                                </div>
                            </div>
                        )}

                        {job && job.location && (
                            <div className="flex items-start gap-3">
                                <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                <div>
                                    <p className="text-xs uppercase tracking-wide text-foreground-subtle">Location</p>
                                    <p className="text-foreground">{job.location}</p>
                                </div>
                            </div>
                        )}

                        {job && job.jobType && (
                            <div className="flex items-start gap-3">
                                <Briefcase className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                <div>
                                    <p className="text-xs uppercase tracking-wide text-foreground-subtle">Type</p>
                                    <p className="text-foreground">{job.jobType}</p>
                                </div>
                            </div>
                        )}
                    </div>

                    {jobsUnavailable && (
                        <div
                            role="alert"
                            className="mt-4 flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>
                                Job details could not be loaded, so this page is shown without the
                                job&apos;s title.
                            </span>
                        </div>
                    )}
                    {employerNameUnavailable && (
                        <div
                            role="alert"
                            className="mt-2 flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>The employer&apos;s name could not be loaded.</span>
                        </div>
                    )}
                </Card>

                {/* The employee side of the contract workflow. A pending contract
                    is accepted here; an active one shows the agreed terms. The
                    employee cannot create a contract, and every request is still
                    authorized by the server. */}
                <ContractSetupPanel
                    employment={employment}
                    currentUid={currentUid}
                    onChanged={handleContractChanged}
                    onContractLoaded={handleContractLoaded}
                />

                {/* The employee's read-only payment view for this employment.
                    It loads the contract and its payment record itself. A full
                    contract shows the single agreed total; a milestone contract
                    keeps the existing per-milestone list. Employer-only Checkout
                    and Refresh controls stay hidden because currentUid is the
                    employee's. */}
                <MilestonePaymentPanel
                    employment={employment}
                    currentUid={currentUid}
                    reloadToken={contractReloadToken}
                />

                {/* STAGE 11.15: the conversation entry point for this hire, the
                    employee-side counterpart of the Conversation card
                    EmployeeWorkspace.jsx renders for the employer. The conversation is
                    anchored on the application, read from the employment document the
                    page already resolved (never from the URL), and the reader here is
                    the employee, so counterpartRole is 'applicant' and the button
                    reads "Message employer". ConversationLauncher is unchanged; like
                    EmployeeWorkspace.jsx, the control is offered only when the hire
                    carries an applicationId. Authorization stays server-side. */}
                <Card className="mb-6 p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Conversation</h2>
                    {employment.applicationId ? (
                        <ConversationLauncher
                            applicationId={employment.applicationId}
                            counterpartRole="applicant"
                        />
                    ) : (
                        <p className="text-foreground-muted">
                            This employment has no application to open a conversation from.
                        </p>
                    )}
                </Card>

                <Card className="p-6">
                    <h2 className="mb-4 text-lg font-semibold text-foreground">Tasks</h2>

                    <TaskProgress tasks={employmentTasks} tasksUnavailable={tasksUnavailable} />

                    {tasksUnavailable ? (
                        <div
                            role="alert"
                            className="mt-4 flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>Your tasks could not be loaded, so no work is shown for this job.</span>
                        </div>
                    ) : employmentTasks.length === 0 ? (
                        <p className="mt-4 text-foreground-muted">
                            No work has been assigned for this job yet. It appears here as soon as
                            the employer assigns it.
                        </p>
                    ) : (
                        <ul className="mt-4 list-none space-y-4 p-0">
                            {employmentTasks.map((task) => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    job={job}
                                    refreshTask={refreshTask}
                                    milestones={milestones}
                                    milestonePayments={milestonePayments}
                                />
                            ))}
                        </ul>
                    )}
                </Card>
            </PageContainer>
        </div>
    );
};

export default EmployeeJobTasks;
