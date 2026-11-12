import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Briefcase, Calendar, ClipboardList, MapPin, User } from 'lucide-react';
import { useQueries } from '@tanstack/react-query';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import TaskCard, { TaskProgress } from '../components/TaskCard';
import ConversationLauncher from '../components/ConversationLauncher';
import { dateLabel, employmentStatusLabel, groupTasksByEmployment } from '../components/taskPresentation';
import AppNavbar from '../components/AppNavbar';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import {
    fetchPublicUser,
    useEmployeeApplicationsQuery,
    useEmployeeEmploymentsQuery,
    useEmployeeTasksQuery,
} from '../useAppQueries';
import queryKeys from '../queryKeys';
import { createReview, fetchPaymentForMilestone } from '../api';
import { apiErrorMessage } from '../apiErrorMessage';

/**
 * The employee's My Jobs list: one card per job they have been hired for.
 *
 * HISTORY OF THIS PAGE
 *   STAGE 6C: it was the real destination behind MyApplications.jsx's "View Your
 *   Hired Jobs" call to action, which had pointed at a path no route matched.
 *   STAGE 6B added the task read endpoint it was built on, and STAGE 9D turned it
 *   into the delivery side of the work-delivery loop: a flat list of the
 *   employee's tasks, each with the submit workflow.
 *   STAGE 10E: the spine became GET /employments/employee/:uid, so the page became
 *   a list of HIRES rather than a list of tasks, with each hire's tasks nested in
 *   its card and a progress summary above them.
 *   STAGE 10F: the nesting is gone. A My Jobs card is now a link into the per-job
 *   workspace at /employee/hired-jobs/:employmentId, and the tasks live there. This
 *   page is a list of jobs and nothing else -- requirement, not preference: with
 *   every task expanded, an employee with several hires had to scroll past all of
 *   their work to reach the job they came for.
 *
 * WHY THIS PAGE CANNOT SHOW ANOTHER EMPLOYEE'S JOBS OR TASKS
 *   The route takes no identifier at all. There is no `:uid`, no query string and
 *   no prop -- the employee is read from the verified auth session, so there is
 *   nothing in the URL for a caller to edit. Three further layers back that up:
 *     * `protect` on the route in App.jsx requires a signed-in user
 *     * GET /employments/employee/:uid is guarded server-side by
 *       requireSelfParam, which 403s unless the path uid equals req.user.uid from
 *       the verified token -- so no client-supplied employee id is trusted, and
 *       the identity used here is the one on the auth session, not anything this
 *       page decides
 *     * GET /tasks/employee/:uid and GET /applications/employee/:uid carry the
 *       same guard, so the tasks and job titles cannot be widened either
 *   Every request on this page is the caller's own data or a public profile of
 *   the employer who hired them (GET /users/getUser/:userId, which is
 *   `protect`-only and returns fullName among its public fields -- the same
 *   cross-user read JobSplitView.jsx has always made for a job poster's name).
 *
 * Stage 10F adds no endpoint of any kind; every read it needs already existed.
 */

/**
 * STAGE 10E. Reduces the employment response to one card per hire.
 *
 * Firestore documents are already unique by id, so the id pass is the ordinary case
 * and exists only to make the intent explicit rather than to fix a known duplicate.
 *
 * The second pass is the one that matters. Stage 7H-2 makes at most one employment
 * per application authoritative at write time, but that guard rejects a second add
 * rather than repairing documents already written, and this list is the first page
 * that would show a duplicate twice. Collapsing on `applicationId` means one
 * application -- one hire -- is one card, whichever side of a legacy pair it lands
 * on. The survivor is the first in the incoming order, which is why the caller sorts
 * before calling this: the choice is then oldest-first and repeatable instead of
 * depending on Firestore's key order.
 *
 * Two employments for the same JOB are deliberately not collapsed. Nothing prevents
 * an employee applying to the same job twice and being hired off two applications,
 * and those are two separate hires with their own tasks -- merging them would hide
 * work and misreport progress. They also get two workspace links, which is the
 * honest outcome: two hires, two task lists.
 */
const dedupeEmployments = (list) => {
    const seenIds = new Set();
    const seenApplications = new Set();
    const unique = [];

    list.forEach((employment) => {
        if (!employment) return;

        if (employment.id) {
            if (seenIds.has(employment.id)) return;
            seenIds.add(employment.id);
        }

        if (employment.applicationId) {
            if (seenApplications.has(employment.applicationId)) return;
            seenApplications.add(employment.applicationId);
        }

        unique.push(employment);
    });

    return unique;
};

/**
 * STAGE 10E. Oldest hire first.
 *
 * The server query is a bare `where('employeeId', '==', uid)` with no orderBy, so
 * the order it returns is Firestore's key order and carries no meaning to a reader.
 * Sorting here is on `startDate` -- the same field dateLabel decodes, in either of
 * its two shapes -- with the document id as tie-break so two hires that started on
 * the same day keep a stable relative order across loads. A missing or unreadable
 * start date sorts last instead of first, so a damaged record does not push the
 * employee's real history off the top of the page.
 *
 * STAGE 10F: this ordering also decides where groupTasksByEmployment files a legacy
 * task when two employments share a jobId, so it is load-bearing beyond presentation.
 */
const startDateSortValue = (employment) => {
    const value = employment.startDate;
    let millis;

    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        millis = value._seconds * 1000;
    } else if (typeof value === 'string' && value) {
        millis = new Date(value).getTime();
    }

    return typeof millis === 'number' && !Number.isNaN(millis) ? millis : Number.MAX_SAFE_INTEGER;
};

const sortEmployments = (list) =>
    [...list].sort((a, b) => {
        const difference = startDateSortValue(a) - startDateSortValue(b);

        if (difference !== 0) return difference;

        return String(a.id || '').localeCompare(String(b.id || ''));
    });

/**
 * STAGE 10E, changed by 10F, tidied by 10F.1. One card per hire: the job, who
 * hired the employee, where the hire stands, and how far the work assigned inside
 * it has got.
 *
 * STAGE 10F.1: exactly ONE navigation action per card -- "View Tasks", into the
 * workspace at /employee/hired-jobs/:employmentId, which shows the job's title,
 * details and tasks together. The "View job details" link to /jobs/:jobId is gone
 * rather than kept beside it, for the reason Stage 6P gave when it dropped a
 * duplicate pair of entries here: two controls that go to the same information by
 * different routes is one of them left to rot, and the workspace already renders
 * everything the public job page would have shown here plus the work. No route was
 * added and no UI duplicated to make that true -- the workspace was built for
 * exactly this.
 *
 * The job title is therefore plain text and not a second link to the same
 * destination. It was a link in Stage 10F, and it was the duplicate Stage 6P
 * describes: the heading and the action below it both went to the workspace.
 */
// STAGE 11.10: employment status -> shared Badge variant
const employmentStatusBadgeVariant = (employment) => {
    const status = employment && typeof employment.status === 'string' ? employment.status : '';
    if (status === 'active') return 'success';
    if (status === 'completed') return 'info';
    if (status === 'terminated') return 'warning';
    if (status === 'ended') return 'neutral';
    return 'neutral';
};

/*
    A <Link> styled as a Button. The card's one action is a destination, so it keeps
    its anchor semantics (middle-click / open-in-new-tab) rather than becoming a
    <button>. Reuses the shared Button tokens, matching MyJobs.jsx.
*/
const ActionLink = ({ to, variant = 'primary', className = '', children }) => {
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

const EmploymentCard = ({ employment, job, employerName, tasks, tasksUnavailable }) => {
    const [reviewRating, setReviewRating] = useState(5);
    const [reviewComment, setReviewComment] = useState('');
    const [msg, setMsg] = useState('');
    const [err, setErr] = useState('');
    return (
        <Card as="li" className="p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <h3 className="min-w-0 break-words text-lg font-semibold text-foreground">
                    {job ? job.title : 'Job details unavailable'}
                </h3>
                <Badge variant={employmentStatusBadgeVariant(employment)}>
                    {employmentStatusLabel(employment)}
                </Badge>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-sm text-foreground-muted sm:grid-cols-2">
                <div className="flex items-center gap-2">
                    <User className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                    <span className="break-words">{employerName || 'Employer name unavailable'}</span>
                </div>
                {job && job.location && (
                    <div className="flex items-center gap-2">
                        <MapPin className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                        <span className="break-words">{job.location}</span>
                    </div>
                )}
                {job && job.jobType && (
                    <div className="flex items-center gap-2">
                        <Briefcase className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                        <span>{job.jobType}</span>
                    </div>
                )}
                <div className="flex items-center gap-2">
                    <Calendar className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                    <span>Started: {dateLabel(employment.startDate)}</span>
                </div>
                {employment.endDate && (
                    <div className="flex items-center gap-2">
                        <Calendar className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                        <span>Ended: {dateLabel(employment.endDate)}</span>
                    </div>
                )}
            </div>

            <div className="mt-4">
                <TaskProgress tasks={tasks} tasksUnavailable={tasksUnavailable} />
            </div>

            {/* STAGE 10F.1: the card's action into the workspace. STAGE 11.15 adds the
                conversation entry point beside it. */}
            <div className="mt-4 flex flex-wrap items-center gap-3">
                <ActionLink to={`/employee/hired-jobs/${employment.id}`}>
                    <ClipboardList className="h-4 w-4" aria-hidden="true" />
                    Open Job
                </ActionLink>
                {employment.applicationId && (
                    <ConversationLauncher
                        applicationId={employment.applicationId}
                        counterpartRole="applicant"
                    />
                )}
            </div>

            {(employment.status === 'completed' || employment.status === 'terminated' || employment.status === 'ended') && (
                <div className="mt-4 rounded-md border border-border p-3">
                    <p className="text-sm font-medium text-foreground">Leave a review for the employer</p>
                    {msg && <p className="text-xs text-success">{msg}</p>}
                    {err && <p className="text-xs text-danger">{err}</p>}
                    <div className="mt-2 flex items-center gap-2">
                        <select className="rounded-md border border-border px-2 py-1 text-sm" value={reviewRating} onChange={(e) => setReviewRating(Number(e.target.value))}>
                            {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                        <input className="flex-1 rounded-md border border-border px-2 py-1 text-sm" placeholder="Comment (optional)" value={reviewComment} onChange={(e) => setReviewComment(e.target.value)} />
                        <Button className="h-8 px-2 text-xs" onClick={async () => {
                            setMsg(''); setErr('');
                            try {
                                await createReview(employment.id, { revieweeId: employment.employerId, rating: reviewRating, comment: reviewComment });
                                setMsg('Review submitted');
                            } catch (e) {
                                setErr(apiErrorMessage(e, 'Failed to submit review'));
                            }
                        }}>Submit</Button>
                    </div>
                </div>
            )}
        </Card>
    );
};

const HiredJobs = () => {
    // STAGE 11.10: identity for the shared AppNavbar, taken from the auth session.
    // Presentation only -- no user document read is added by this page; AppNavbar
    // resolves the missing `role` from its own single, session-cached read.
    const [navUser, setNavUser] = useState({});
    // Milestone payment records for the tasks on this page, keyed by milestone id.
    // An absent key means "not loaded"; a null value means "loaded, but no record".
    const [milestonePayments, setMilestonePayments] = useState({});
    const uid = auth.currentUser ? auth.currentUser.uid : '';

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, (user) => {
            setNavUser({ fullName: user?.displayName || '', email: user?.email || '' });
        });

        return unsubscribe;
    }, []);

    // The employment list is the spine: it decides whether there is a page at
    // all. The other reads are enrichment, so their failures degrade one part of
    // a card instead of replacing the list. Query caching also means returning to
    // this page no longer repeats every read from scratch.
    const employmentsQuery = useEmployeeEmploymentsQuery(uid, { staleTime: 0 });
    const applicationsQuery = useEmployeeApplicationsQuery(uid, { staleTime: 0 });
    const tasksQuery = useEmployeeTasksQuery(uid, { staleTime: 0 });

    const employments = useMemo(
        () => sortEmployments(dedupeEmployments(employmentsQuery.data || [])),
        [employmentsQuery.data]
    );

    const jobsById = useMemo(() => {
        const joined = {};

        (applicationsQuery.data || []).forEach((app) => {
            if (app.jobId && app.job) joined[app.jobId] = app.job;
        });

        return joined;
    }, [applicationsQuery.data]);

    // Memoised so the milestone-payment effect below keeps a stable dependency
    // while the tasks query is still resolving (an inline `|| []` would be a new
    // array on every render).
    const tasks = useMemo(() => tasksQuery.data || [], [tasksQuery.data]);

    // The milestone ids carried by the employee's own tasks. Any of these may be
    // rendered as a TaskCard, so their payment records are the ones worth reading.
    const taskMilestoneIds = useMemo(
        () => [...new Set(tasks.map((task) => task && task.milestoneId).filter(Boolean))],
        [tasks]
    );

    // Fetch payment records for each milestone independently. One failed request
    // does not stop the others, and a missing or unreadable record is stored as
    // null so TaskCard fails closed instead of implying a payment. The cancelled
    // flag stops a late response overwriting state after the list changes or the
    // page unmounts.
    useEffect(() => {
        let cancelled = false;

        const fetchMilestonePayments = async () => {
            if (taskMilestoneIds.length === 0) {
                if (!cancelled) setMilestonePayments({});
                return;
            }

            const payments = {};
            await Promise.all(
                taskMilestoneIds.map(async (milestoneId) => {
                    try {
                        const { payment } = await fetchPaymentForMilestone(milestoneId);
                        if (!cancelled) {
                            payments[milestoneId] = payment || null;
                        }
                    } catch {
                        if (!cancelled) {
                            payments[milestoneId] = null;
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
    }, [taskMilestoneIds]);

    // One request per DISTINCT employer, not per card. useQueries keeps each
    // profile read independently cacheable and retryable, so one unreadable
    // employer leaves every other card with a name.
    const employerIds = useMemo(
        () => [...new Set(employments.map((employment) => employment.employerId).filter(Boolean))],
        [employments]
    );

    const employerQueries = useQueries({
        queries: employerIds.map((employerId) => ({
            queryKey: queryKeys.publicUser(employerId),
            queryFn: () => fetchPublicUser(employerId),
            enabled: Boolean(employerId),
            retry: false,
        })),
    });

    const employerNames = {};

    employerQueries.forEach((query, index) => {
        const employerId = employerIds[index];
        const profile = query.data;

        if (employerId) {
            employerNames[employerId] = profile && profile.fullName ? profile.fullName : '';
        }
    });

    const loading = Boolean(uid) && employmentsQuery.isPending;
    // STAGE 5I-1 convention: the failure is shown to the user, not only logged.
    const error = employmentsQuery.isError
        ? 'Your jobs could not be loaded. Please try again.'
        : '';
    const jobsUnavailable = applicationsQuery.isError;
    const tasksUnavailable = tasksQuery.isError;
    const employerNamesUnavailable = employerQueries.some((query) => query.isError);

    if (loading) {
        return <PageLoader label="Loading your jobs…" />;
    }

    // STAGE 10E, kept by 10F: computed after the loading gate so the empty state
    // below is reached only when there are genuinely no employments. The buckets are
    // used for the per-card progress count and for the orphan section; the cards
    // themselves no longer render a task.
    const { buckets, unassigned } = groupTasksByEmployment(employments, tasks);

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <div className="space-y-6">
                    <PageHeader
                        title="My Jobs"
                        description="The jobs you have been hired for. Open one to see the work assigned to you on it."
                    />

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
                                onClick={() => employmentsQuery.refetch()}
                                disabled={employmentsQuery.isFetching}
                                aria-busy={employmentsQuery.isFetching}
                            >
                                {employmentsQuery.isFetching ? 'Trying…' : 'Try again'}
                            </Button>
                        </div>
                    )}

                    {/* Each of these degrades one part of a card and leaves the rest intact,
                        so they are reported separately rather than as one "something went
                        wrong": the reader can tell an untitled job from an unreadable count. */}
                    {jobsUnavailable && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle p-4 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">
                                Job details could not be loaded, so these jobs are listed without their
                                titles.
                            </p>
                        </div>
                    )}
                    {tasksUnavailable && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle p-4 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">
                                Your tasks could not be loaded, so no counts are shown for these jobs.
                            </p>
                        </div>
                    )}
                    {employerNamesUnavailable && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-subtle p-4 text-sm text-warning-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">Some employer names could not be loaded.</p>
                        </div>
                    )}

                    {employments.length === 0 ? (
                        <EmptyState
                            icon={Briefcase}
                            title="No jobs yet"
                            description="You have not been hired for any jobs yet. A job appears here once an employer hires you, and any work they assign to you appears when you open it."
                            action={
                                <ActionLink to="/my-applications" variant="secondary">
                                    Back to my applications
                                </ActionLink>
                            }
                        />
                    ) : (
                        <>
                            <ul className="space-y-4">
                                {employments.map((employment) => (
                                    <EmploymentCard
                                        // STAGE 10E: the document id is what makes this key
                                        // stable and unique. The fallbacks cover a record that
                                        // somehow arrived without one -- dedupeEmployments has
                                        // already collapsed any repeat on applicationId, so they
                                        // cannot collide with each other here.
                                        key={employment.id || employment.applicationId || employment.jobId}
                                        employment={employment}
                                        job={jobsById[employment.jobId]}
                                        employerName={employerNames[employment.employerId]}
                                        tasks={buckets[employment.id] || []}
                                        tasksUnavailable={tasksUnavailable}
                                    />
                                ))}
                            </ul>

                            {/* STAGE 10E-1, kept as-is by 10F. Reachable only when the
                                employment write for a completed hire failed, or for a task
                                written outside the API -- and it cannot move to the workspace,
                                because a workspace is addressed by employment and these tasks
                                have no employment to be addressed by. Still listed rather than
                                dropped, and still read-only: requireTaskParty answers a mutation
                                on a task with no employmentId -- or one whose employment is gone
                                -- with a 403, so the server refuses every submission here.
                                Offering the control would be a button whose request is
                                guaranteed to fail, which is the same bug Stage 7G-2 removed from
                                the hire control. */}
                            {unassigned.length > 0 && (
                                <section className="space-y-3">
                                    <h2 className="text-lg font-semibold text-foreground">Work not linked to a hire</h2>
                                    <p className="text-sm text-foreground-muted">
                                        This work is not linked to a hire on record, so it cannot be
                                        submitted from here. It is listed for reference -- contact the
                                        employer who assigned it if you need to deliver this work.
                                    </p>
                                    <ul className="space-y-4">
                                        {unassigned.map((task) => (
                                            <TaskCard
                                                key={task.id}
                                                task={task}
                                                job={jobsById[task.jobId]}
                                                readOnly
                                                milestonePayments={milestonePayments}
                                            />
                                        ))}
                                    </ul>
                                </section>
                            )}

                            <ActionLink to="/my-applications" variant="secondary">
                                Back to my applications
                            </ActionLink>
                        </>
                    )}
                </div>
            </PageContainer>
        </div>
    );
};

export default HiredJobs;
