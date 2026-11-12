import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Banknote, Calendar, MessageSquare, Users, FileText, Download, Link2 } from 'lucide-react';
import api, { createContractProposal, fetchContractProposalsForApplication, reviseContractProposal } from '../api';
import { downloadResume } from '../resumeUpload';
import { auth } from '../firebase';
import queryKeys from '../queryKeys';
import {
    PROPOSAL_ACCEPTED,
    PROPOSAL_CHANGES_REQUESTED,
    PROPOSAL_PENDING,
    buildProposalPayload,
    canCreateProposal,
    canFinalizeHire,
    employmentWorkspacePath,
    findHireEmployment,
    formatProposalAmount,
    proposalEditorMode,
    proposalFormValues,
    proposalStatusBadgeVariant,
    proposalStatusLabel,
    selectActiveProposal,
} from '../components/proposalPresentation';
import InterviewPanel from '../components/InterviewPanel';
import ConversationLauncher from '../components/ConversationLauncher';
import AppNavbar from '../components/AppNavbar';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import TaskCreateForm from '../components/TaskCreateForm';
import { Field, Input, Textarea, Select } from '../components/ui/Field';
// STAGE 10H.4.2: the employer's task-review panel moved to
// components/TaskReviewPanel.jsx so the per-employment workspace reviews work through
// the same component this page uses. It is now the one place that imports SubmittedWork
// from TaskCard.jsx, which is what keeps the employer's view of a delivery identical to
// the employee's.
import TaskReviewPanel from '../components/TaskReviewPanel';

// STAGE 5G: canonical application statuses. The canonical spellings are
// `accepted` and `rejected`; this component used to write the title-cased
// `Employed` and `Not Hired`, which the server accepted because nothing
// validated the value. It validates now, so only these two are written.
//
// Documents written before that change still hold `Employed` / `Not Hired`, and
// the server does not migrate them, so the read side has to understand both
// spellings. That mapping is local to this component and to MyApplications.jsx
// -- there is deliberately no shared status module.
const ACCEPTED = 'accepted';
const REJECTED = 'rejected';

// STAGE 7G-2: the lifecycle the server now enforces.
//   pending      applied, not yet cleared for hiring
//   interviewed  cleared for hiring; the employer may now hire
//   accepted     hired
//   rejected     not hired
//
// `interviewed` is written by the explicit "Clear for hiring" action below and by
// nothing else. In particular it is NOT set when an interview is marked completed:
// that dropdown belongs to the interview domain, and Stage 7C established that the
// two domains do not write to each other in either direction.
const PENDING = 'pending';
const INTERVIEWED = 'interviewed';

// Legacy stored values, mapped onto the canonical pair for display. Anything
// unrecognised is passed through unchanged so a hand-written value is still
// visible rather than silently rewritten.
const canonicalAppStatus = (status) => {
    if (status === 'Employed') return ACCEPTED;
    if (status === 'Not Hired') return REJECTED;
    return status;
};

// What the user sees. The canonical label for `accepted` is "Employed", which is
// the wording this page and the employee-facing page have always used, so the
// legacy documents display identically to the new ones.
// STAGE 7G-2: `interviewed` is labelled with the action it enables rather than
// with the interview that precedes it. "Cleared for hiring" is the phrase the
// button below uses, so the status line and the button an employer is being invited
// to press say the same thing. `Pending` is listed as a computed key so it stays
// tied to the PENDING constant above.
const APP_STATUS_LABEL = {
    [PENDING]: 'Pending',
    [INTERVIEWED]: 'Cleared for hiring',
    [ACCEPTED]: 'Employed',
    [REJECTED]: 'Not Hired',
};

const appStatusLabel = (status) => APP_STATUS_LABEL[canonicalAppStatus(status)] || 'No status available';

// STAGE 11.9: canonical status -> shared Badge variant. Presentation only -- the
// canonicalisation and label map above are untouched; this just renders the existing
// status through the shared Badge primitive, matching MyApplications.jsx.
const APP_STATUS_BADGE_VARIANT = {
    [PENDING]: 'warning',
    [INTERVIEWED]: 'info',
    [ACCEPTED]: 'success',
    [REJECTED]: 'danger',
};

const appStatusBadgeVariant = (status) =>
    APP_STATUS_BADGE_VARIANT[canonicalAppStatus(status)] || 'neutral';

// STAGE 11.9: initials for the applicant avatar. Presentation only -- derived from the
// existing `fullName` field, the same way AppNavbar derives its own.
const getInitials = (fullName) => {
    if (!fullName) return '';

    const names = fullName.split(' ');
    const firstInitial = names[0]?.charAt(0) || '';
    const lastInitial = names[1]?.charAt(0) || '';

    return (firstInitial + lastInitial).toUpperCase();
};

// STAGE 5H. This was `app.dateApplied._seconds * 1000`, which matched the
// Firestore Timestamp wire shape but dereferenced `dateApplied` unguarded, so an
// application without that field threw a TypeError and took the whole employer
// page down. The ISO-string branch is for any value that is not Timestamp-shaped;
// it renders the same date the Timestamp branch would.
const appliedOnLabel = (dateApplied) => {
    let date;

    if (dateApplied && typeof dateApplied === 'object' && typeof dateApplied._seconds === 'number') {
        date = new Date(dateApplied._seconds * 1000);
    } else if (typeof dateApplied === 'string' && dateApplied) {
        date = new Date(dateApplied);
    }

    return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString() : 'Date not available';
};

/**
 * STAGE 9E. Assigning work, as an explicit employer action.
 *
 * This replaces the placeholder task the hire used to create. Nothing about the task
 * lifecycle changed -- the document is still built by the same service, still starts
 * `assigned`, and still goes through the same POST /tasks. What changed is who decides a
 * task exists: the employer, here, by naming it. What STAGE 10G changed is what the
 * employee then owes on it -- the employer also picks one of the three submission types,
 * so `submissionType` joins the five required fields and cannot be left to a default.
 *
 * Rendered only for a hired applicant, and that is not only a UI convenience. The
 * POST /tasks guard is requireTaskAssignment, which resolves the assignment from an
 * ACCEPTED application, so a request naming an applicant who was not hired is refused
 * with 403 before it reaches the service. Hiding the control keeps the employer from
 * being offered something the server will not do; the guard is what actually enforces
 * it.
 *
 * `jobId` and `employeeId` are passed in rather than read from a form, so the task is
 * attached to the job this page is for and to the applicant this card is showing.
 * Neither is an editable field, and neither can drift from the card the form belongs
 * to.
 *
 * `onCreated` is `fetchTasks`, which re-reads the job's tasks and reports success as a
 * boolean. The new task then appears in the card's TaskReviewPanel without a reload,
 * and a failed refresh says so instead of being reported as a failed creation -- the
 * task exists by then.
 *
 * Fields are cleared only after the server accepts, so a rejected submission never
 * discards what the employer typed. The form stays open afterwards so a second task
 * can be added without reopening it.
 */
/**
 * STAGE 7G-2: the applicant's decision controls, as three mutually exclusive states.
 *
 * The server refuses `accepted` unless the application is `interviewed`, so an
 * enabled Hire button on a pending applicant offered an action guaranteed to fail.
 * The Hire button is still rendered in that case: an employer looking at a pending
 * applicant can see that hiring is a step that exists and is not yet available,
 * rather than wondering whether the page is broken.
 *
 * `isHiring` disables this card's own button while its hire runs. `isClearing` is
 * also honoured here because clearing and hiring are two writes to the same
 * application document, and letting an employer start one while the other is in
 * flight would race two statuses onto one application.
 */
const ApplicantDecisionButtons = ({ application, isHiring, isClearing, onHire, onClear, proposalState }) => {
    const appStatus = canonicalAppStatus(application.status);
    const proposals = proposalState?.proposals || [];
    const proposalLoading = !proposalState || proposalState.loading;
    const proposalError = proposalState?.error || '';
    const activeProposal = selectActiveProposal(proposals);
    const proposalAccepted = activeProposal?.status === PROPOSAL_ACCEPTED;

    // Unchanged Stage 5I behaviour: a hired applicant reads "Hired" and is offered
    // nothing further.
    if (appStatus === ACCEPTED) {
        return (
            <div className="mt-4">
                <Button type="button" variant="secondary" size="sm" disabled>
                    Hired
                </Button>
            </div>
        );
    }

    // STAGE 3D: the backend refuses a hire until the application is `interviewed`
    // AND an accepted contract proposal exists. Both conditions come from the same
    // pure gate the proposal panel uses, so the button and its explanation cannot
    // disagree with what the server will allow.
    const canHire = canFinalizeHire(appStatus, proposals) && !proposalLoading && !proposalError;

    // STAGE 7G-2 follow-up: `rejected` is clearable as well as `pending`. Rejection is
    // not a dead end -- an employer who rejects an applicant by some other route, or
    // who changes their mind, can bring them back to `interviewed` and hire them from
    // there. This does NOT let a rejected applicant be hired directly: hiring still
    // requires an accepted proposal, so `rejected` still has to pass through the clear
    // action first, which is the only thing on this page that writes `interviewed`.
    const canClearForHiring = appStatus === PENDING || appStatus === REJECTED;

    let hireHint = '';

    if (appStatus === INTERVIEWED) {
        if (proposalLoading) {
            hireHint = 'Checking the contract proposal status…';
        } else if (proposalError) {
            hireHint = 'The contract proposal could not be checked, so hiring is unavailable.';
        } else if (proposalAccepted) {
            hireHint = 'Terms are accepted. Finalize hiring to create the employment.';
        } else if (activeProposal?.status === PROPOSAL_PENDING) {
            hireHint = 'Hiring becomes available once the applicant accepts the contract proposal.';
        } else if (activeProposal?.status === PROPOSAL_CHANGES_REQUESTED) {
            hireHint = 'The applicant requested changes. Revise and resend the proposal before hiring.';
        } else {
            hireHint = 'Send a contract proposal and get it accepted before hiring.';
        }
    } else if (canClearForHiring) {
        hireHint = 'Hire becomes available once this applicant is cleared for hiring and accepts a contract proposal.';
    } else {
        hireHint = 'Hire is not available for this applicant.';
    }

    return (
        <div className="mt-4 space-y-2">
            <div className="flex flex-wrap gap-2">
                {canClearForHiring && (
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => onClear(application)}
                        disabled={isClearing || isHiring}
                    >
                        {isClearing ? 'Clearing...' : 'Clear for hiring'}
                    </Button>
                )}
                <Button
                    type="button"
                    size="sm"
                    onClick={() => onHire(application)}
                    disabled={isHiring || isClearing || !canHire}
                >
                    {proposalAccepted ? 'Finalize hire' : 'Hire'}
                </Button>
            </div>
            {!canHire && (
                <p className="text-sm text-foreground-muted">{hireHint}</p>
            )}
        </div>
    );
};

/*
    STAGE 8F added a decodeRouteTitle helper here, because `jobTitle` arrives from the route
    PERCENT-ENCODED: both places that link to this page build the path with
    encodeURIComponent (EmployerDashboard.jsx:186 and MyJobs.jsx:360) and React Router's
    useParams does not decode on the way back, so a title with a space arrives as
    "Senior%20Developer".

    STAGE 10B REMOVES IT, along with its one caller. It existed to decode the title for
    the conversation header, and the thread no longer renders here -- it has its own
    screen at /messages/:conversationId, which looks the job up by id. A helper kept
    for a caller that no longer exists is a helper that quietly stops being tested, so it
    goes with the call.

    The underlying oddity is NOT fixed here and remains pre-existing: the page heading at
    the bottom of this file still prints the ENCODED form, so an employer can see
    "Applications for Job \"Senior%20Developer\"". That is a heading bug, not a
    conversation one, and fixing it is outside this stage.
*/

/*
    STAGE 12.13. The materials attached to one application, shown to the employer
    who owns the job: the private resume (reached only through the signed-download
    endpoint, which requireResumeAccess admits for this job's owner), the cover
    letter and the portfolio link. Self-contained, so one applicant's download
    state cannot affect another's. Renders nothing when the application has none,
    which is every application filed before the requirements existed.
*/
const ApplicantMaterials = ({ applicationId, resume, coverLetter, portfolioUrl }) => {
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState('');

    const hasResume = !!(resume && resume.publicId);
    const hasCoverLetter = typeof coverLetter === 'string' && coverLetter.trim() !== '';
    const hasPortfolio = typeof portfolioUrl === 'string' && portfolioUrl.trim() !== '';

    if (!hasResume && !hasCoverLetter && !hasPortfolio) return null;

    const handleDownload = async () => {
        setError('');
        setDownloading(true);
        try {
            await downloadResume({ applicationId });
        } catch (err) {
            console.error('Error downloading applicant resume:', err);
            setError("Could not download this applicant's resume. Please try again.");
        } finally {
            setDownloading(false);
        }
    };

    return (
        <div className="mt-3 space-y-3 border-t border-border pt-3 text-sm">
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
                    <Button variant="secondary" size="sm" onClick={handleDownload} disabled={downloading}>
                        <Download className="h-4 w-4" aria-hidden="true" />
                        {downloading ? 'Preparing…' : 'Download resume'}
                    </Button>
                </div>
            )}

            {error && <p className="text-xs font-medium text-danger">{error}</p>}
        </div>
    );
};

const ViewJobApplications = () => {
    const { jobId, jobTitle } = useParams();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [applications, setApplications] = useState([]);
    const [employments, setEmployments] = useState([]);
    // STAGE 3D: per-application proposal state, reported up by the ProposalSection
    // that already loads it. Keeping it here lets the hire button be gated on the
    // SAME accepted proposal the panel displays, without a second proposal read or
    // an N+1 across every applicant card.
    const [proposalStates, setProposalStates] = useState({});
    // STAGE 3D: a hire that committed but whose employment record could not be
    // located for the workspace link. The hire itself is complete; this only
    // affects where the employer is sent next.
    const [hireSuccess, setHireSuccess] = useState(null);
    const handleProposalStateChange = useCallback((applicationId, nextState) => {
        setProposalStates((current) => {
            const previous = current[applicationId];

            if (previous
                && previous.loading === nextState.loading
                && previous.proposals === nextState.proposals
                && previous.error === nextState.error) {
                return current;
            }

            return { ...current, [applicationId]: nextState };
        });
    }, []);
    // STAGE 5I-1: the user-visible failure message. The workflow used to report
    // failures only to the console, so a hire that failed halfway was
    // indistinguishable from one that had never started.
    const [error, setError] = useState('');
    const [isHiring, setIsHiring] = useState(false);
    // STAGE 5I-1: `isHiring` on its own cannot stop a double click. Two clicks
    // dispatched in the same tick both read the pre-update render, because React
    // has not rerendered yet, so both would enter the workflow and both would
    // reach the status writes. This ref is checked and set synchronously, before the
    // first await, so the second click returns immediately.
    const hiringInFlightRef = useRef(false);

    // STAGE 7G-2: the same guard for the "Clear for hiring" action, for the same
    // reason. `isClearing` alone cannot stop a double click, because two clicks in
    // one tick both read the pre-update render; the ref is checked and set
    // synchronously before the first await. Separate from `hiringInFlightRef` so the
    // two actions cannot suppress each other, and both are cleared in `finally` so
    // neither a failed action nor a failed refresh can leave a button stuck.
    const clearingInFlightRef = useRef(false);
    const [isClearing, setIsClearing] = useState(false);

    // STAGE 7E: the employer-side interview section.
    //
    // `interviews` is every interview on THIS JOB, fetched once and grouped by
    // applicationId below, rather than one request per applicant card. The page
    // already holds the whole applicant list, so a per-card fetch would be an N+1
    // over a list that is routinely long -- the same pattern Stage 4 documented for
    // listApplicationsForEmployee.
    //
    // GET /interviews/job/:jobId is guarded by the existing requireJobOwner, and this
    // page is already the employer's own job (the applications read below is
    // guarded by the same guard), so no new authorization decision is made here. A
    // failure is reported on the page rather than only logged, matching Stage 5I-1.
    const [interviews, setInterviews] = useState([]);
    const [interviewsError, setInterviewsError] = useState('');
    const [isLoadingInterviews, setIsLoadingInterviews] = useState(true);

    // STAGE 9D. The tasks created on this job, one read for the whole page rather
    // than one per applicant card, for the same N+1 reason the interview read above
    // documents.
    //
    // GET /tasks/job/:jobId is guarded by the existing requireJobOwner, and this page
    // is already the employer's own job -- the applications read below is guarded by
    // the same guard -- so no new authorization decision is made here either.
    //
    // This read is separate from the interview read because the two fail
    // independently: an employer can still review, approve or hire with the tasks
    // request broken, and can still schedule with the interviews request broken.
    const [tasks, setTasks] = useState([]);
    const [tasksError, setTasksError] = useState('');

    /*
        STAGE 11.9: identification for the shared AppNavbar.

        This page was never rendering a navbar at all. It now mounts the shared
        AppNavbar, which needs a `user` to show the profile chip and to decide which
        role's destination set to render (its `roleKnown` gate). Taking that identity
        from the already-authenticated session -- which ProtectedRoute has guaranteed
        by the time this element mounts -- keeps this a presentation-only change: no
        user-document read and no new request is added BY THIS PAGE. The navbar
        itself resolves the missing `role` from its own single, session-cached read
        of that same document, so the employer's full entry set renders here too;
        see the stage report.
    */
    const [navUser] = useState(() => ({
        fullName: auth.currentUser?.displayName || '',
        email: auth.currentUser?.email || '',
    }));

    // STAGE 11.9: gates the first paint so the redesign shows a loader instead of
    // flashing the empty state before the applications read resolves. The three reads
    // themselves are unchanged and still run independently.
    const [isInitialLoading, setIsInitialLoading] = useState(true);

    const fetchInterviews = useCallback(async () => {
        try {
            const res = await api.get(`/interviews/job/${jobId}`);
            setInterviews(res.data.interviews || []);
            setInterviewsError('');
            return true;
        } catch (err) {
            console.error('Error fetching interviews:', err);
            setInterviewsError(
                'Interviews could not be loaded. Scheduling is unavailable until they are.'
            );
            return false;
        } finally {
            setIsLoadingInterviews(false);
        }
    }, [jobId]);

    // applicationId -> the interviews recorded against it. `useMemo` so the object
    // identity is stable across renders: it is passed to every card, and rebuilding
    // it on each render would give each panel a new `interviews` prop every time.
    const interviewsByApplication = useMemo(() => {
        const grouped = {};

        interviews.forEach((interview) => {
            if (!interview.applicationId) return;
            if (!grouped[interview.applicationId]) grouped[interview.applicationId] = [];
            grouped[interview.applicationId].push(interview);
        });

        return grouped;
    }, [interviews]);

    // STAGE 5I-1: hoisted out of the effect below so changeStatus can reuse the
    // identical request and state update after a partial failure. It reports
    // success as a boolean instead of throwing, so a failed refresh cannot mask
    // the hiring failure that prompted it.
    const fetchApplications = useCallback(async () => {
        try {
            const res = await api.get(`/applications/job/${jobId}`);
            setApplications(res.data.applications || []);
            return true;
        } catch (err) {
            console.error('Error fetching applications:', err);
            return false;
        }
    }, [jobId]);

    // STAGE 9D. Reports success as a boolean and never throws, for the same reason
    // as `fetchApplications` above: a failed refresh after a successful review must
    // not be reported as a failed review.
    const fetchTasks = useCallback(async () => {
        try {
            const res = await api.get(`/tasks/job/${jobId}`);
            setTasks(res.data.tasks || []);
            setTasksError('');
            return true;
        } catch (err) {
            console.error('Error fetching tasks:', err);
            setTasksError('Tasks could not be loaded. Reviewing them is unavailable until they are.');
            return false;
        }
    }, [jobId]);

    const fetchEmployments = useCallback(async () => {
        try {
            const res = await api.get(`/employments/job/${jobId}`);
            setEmployments(res.data.employments || []);
            return true;
        } catch (err) {
            console.error('Error fetching employments:', err);
            return false;
        }
    }, [jobId]);

    // STAGE 9D: re-reads the one task a review just changed, through the single-task
    // endpoint Stage 9C added. The refreshed document replaces the list entry rather
    // than being merged into it, because the endpoint returns the complete document,
    // so nothing the server did not just send can be left behind.
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

    // STAGE 9D: tasks grouped by the employee they were assigned to, so each
    // applicant card can show only the work that is theirs. A job can hire more than
    // one employee, so this is not a single task list for the page.
    //
    // `useMemo` so the object identity is stable across renders: it is passed to
    // every card, and rebuilding it on each render would give every panel a new
    // `tasks` prop every time, remounting their textarea state.
    const tasksByEmployee = useMemo(() => {
        const grouped = {};

        tasks.forEach((task) => {
            if (!task.employeeId) return;
            if (!grouped[task.employeeId]) grouped[task.employeeId] = [];
            grouped[task.employeeId].push(task);
        });

        return grouped;
    }, [tasks]);

    const employmentIdByApplication = useMemo(() => {
        const byApplication = {};

        employments.forEach((employment) => {
            if (!employment || !employment.id) return;
            byApplication[employment.applicationId || employment.id] = employment.id;
        });

        return byApplication;
    }, [employments]);

    useEffect(() => {
        // STAGE 11.9: release the first-paint loader when the applications read lands.
        // `fetchApplications` reports success as a boolean and never throws, and the
        // other two reads are left exactly as they were.
        setIsInitialLoading(true);
        fetchApplications().finally(() => setIsInitialLoading(false));
        fetchInterviews();
        fetchTasks();
        fetchEmployments();
    }, [fetchApplications, fetchEmployments, fetchInterviews, fetchTasks]);

    /**
     * STAGE 7G-2: clears a pending applicant for hiring.
     *
     * One PUT of `interviewed`, then a refresh. This is the ONLY thing on this page
     * that writes `interviewed`, and it is deliberately a separate, explicit action
     * rather than a side effect of anything else:
     *
     *   * Not of marking an interview completed. The interview status dropdown in
     *     InterviewPanel is the interview domain's business, and Stage 7C fixed the
     *     rule that the two domains do not write to each other. An employer who
     *     marks an interview `completed` still has to clear the applicant here.
     *   * Not of the hire. `changeStatus` below is unchanged and still performs its
     *     three calls; it simply now starts from `interviewed` instead of `pending`.
     *
     * The list is refetched rather than patched in place, because the server is the
     * authority on the status and a stale card would offer a Hire button the server
     * would refuse. `fetchApplications` returns a boolean rather than throwing, so a
     * failed refresh cannot be mistaken for a failed clear.
     *
     * The same page-level error is used as the hire's, since it is the same failure
     * surface for the employer: `err.message` is the server's text, which for this
     * endpoint includes the gate's message when the applicant is not in a state that
     * can be cleared.
     */
    const clearForHiring = async (applicant) => {
        if (clearingInFlightRef.current) return;
        clearingInFlightRef.current = true;
        setIsClearing(true);
        setError('');

        try {
            await api.put(`/applications/${applicant.id}/status`, {
                status: INTERVIEWED,
            });

            await fetchApplications();
        } catch (err) {
            console.error('Error clearing application for hiring:', err);

            setError(
                `This applicant could not be cleared for hiring: ${err.message || 'the request failed'}.`
            );
        } finally {
            clearingInFlightRef.current = false;
            setIsClearing(false);
        }
    };

    const changeStatus = async (hiredApplicant) => {
        // STAGE 5I-1: the synchronous guard, before any await, so two clicks in
        // one tick cannot both start the workflow.
        if (hiringInFlightRef.current) return;
        hiringInFlightRef.current = true;
        setIsHiring(true);
        setError('');
        setHireSuccess(null);

        // Phase 4 follow-up: tracks whether step 1 committed, so the catch can
        // tell a hire that failed before any write (no employment can exist)
        // from one whose employment write already landed on the server.
        let hireCommitted = false;

        try {
            // 1. Hire the chosen applicant.
            // STAGE 10H.2: this used to restatus EVERY applicant -- the chosen one
            // accepted and all the others rejected -- so hiring a second applicant
            // also rejected the first, who was already hired. A hire is now exactly
            // one write, for the chosen applicant alone; every other applicant keeps
            // the status they already had. The server enforces the same invariant (an
            // application with an active employment cannot be rejected), so this is
            // the client half of a rule that holds for any other caller too.
            //
            // STAGE 9E: this was step 1 of 3, and step 2 created a placeholder task
            // named `Task for <applicant>` whose description repeated the same two
            // sentences and whose due date was the moment the hire happened. It asked
            // the employer for nothing and described nothing, so every hire put a
            // task in the employee's Hired Jobs list that nobody chose and no page
            // could rename or remove -- there is no task edit or delete endpoint, by
            // design. Assigning work is now an explicit action taken from the hired
            // applicant's card, so the two steps are separate decisions.
            await api.put(`/applications/${hiredApplicant.id}/status`, {
                status: ACCEPTED,
            });

            // The server records this hire's employment as part of the same
            // write (applicationService.updateApplicationStatus ->
            // employmentService), so from here on the employments cache entry
            // is stale even if step 2 fails -- see the catch below.
            hireCommitted = true;

            // 2. Change the job status to filled.
            // Stage 5G: was the title-cased 'Filled', which the dashboards did not
            // recognise -- an employer saw their own filled job labelled
            // "Closed". The canonical spelling is lowercase.
            //
            // STAGE 10H.2: this stays. It is a separate decision about the job, not
            // about the other applicants, and it is what the dashboards read to move
            // the job out of the open list. Leaving it out is not required for
            // correctness -- nothing in the server refuses a later hire because a job
            // is filled -- so removing it would change unrelated job-status behavior
            // for no reason.
            await api.put(`/jobs/${jobId}/status`, {
                status: 'filled',
            });

            // Phase 4 of the data-fetching audit: the hire's two writes changed
            // two employer documents the shared cache holds. Step 1 accepted the
            // application, which the server records as an employment as well
            // (applicationService.updateApplicationStatus -> employmentService),
            // so the employments entry is stale; step 2 set the job's status to
            // `filled`, which the job cards and the status filter render, so the
            // jobs entry is stale. The counts entry is deliberately NOT
            // invalidated: GET /applications/counts counts every application
            // document regardless of status, and a hire adds or removes none.
            // Awaiting is cheap here -- no observer of these keys is mounted on
            // this page, so nothing refetches on this page; the dashboard and
            // My Jobs revalidate on their next mount.
            if (auth.currentUser) {
                await Promise.all([
                    queryClient.invalidateQueries({ queryKey: queryKeys.employerJobs(auth.currentUser.uid) }),
                    queryClient.invalidateQueries({ queryKey: queryKeys.employerEmployments(auth.currentUser.uid) }),
                ]);
            }

            // 3. Re-read the authoritative list. The local patch is only a fallback
            // for a failed refresh, so the page does not keep offering a hire the
            // server has already completed.
            const refreshed = await fetchApplications();
            if (!refreshed) {
                setApplications((current) => current.map((app) =>
                    app.id === hiredApplicant.id
                        ? { ...app, status: ACCEPTED }
                        : app
                ));
            }

            // 4. Open the employment this hire created. The hire response is still
            // the existing `{ message }` body, so the id is read from the job's own
            // employment records rather than invented here; findHireEmployment also
            // matches the deterministic application-id document created by the
            // transactional hire. A lookup failure does not mean the hire failed --
            // it only leaves the success panel to link to the employee list instead.
            let employmentId = null;
            try {
                const res = await api.get(`/employments/job/${jobId}`);
                setEmployments(res.data.employments || []);
                const employment = findHireEmployment(res.data.employments, hiredApplicant.id);
                employmentId = employment?.id || null;
            } catch (lookupErr) {
                console.error('Error locating the employment created by the hire:', lookupErr);
            }

            if (employmentId) {
                navigate(employmentWorkspacePath(jobId, employmentId));
            } else {
                setHireSuccess({ applicationId: hiredApplicant.id, employmentId: null });
            }

        } catch (err) {
            // STAGE 5I-1: the diagnostic log is kept, but it is no longer the only
            // report. The list on screen can be stale -- a failure at step 2 leaves
            // step 1 committed -- so it is refetched and the employer is told what
            // happened. Nothing is retried and no request is replayed: re-running the
            // workflow would write the same one status again, and since Stage 9E there
            // is no second task to create either.
            //
            // STAGE 9E: the task list is deliberately NOT refreshed here. The hire no
            // longer touches tasks at all, so a task read could not reveal anything
            // about how far this workflow got.
            console.error('Error changing application or job status:', err);

            // Phase 4 follow-up: if step 1 committed, the server has already
            // created this hire's employment even though the workflow failed at
            // step 2, so the employments cache entry is invalidated here. The
            // jobs entry is deliberately NOT invalidated: the step 2 job-status
            // write is exactly what failed, so the job document did not change.
            // If step 1 itself failed, hireCommitted is still false and nothing
            // is invalidated -- no employment can exist. Awaiting is cheap here
            // (no observer of this key is mounted on this page) and cannot mask
            // the original hire error: a failure in the invalidation is logged,
            // never rethrown, so the message below is still the hire's.
            if (hireCommitted && auth.currentUser) {
                try {
                    await queryClient.invalidateQueries({
                        queryKey: queryKeys.employerEmployments(auth.currentUser.uid),
                    });
                } catch (invalidateErr) {
                    console.error('Error invalidating employments after a partially committed hire:', invalidateErr);
                }
            }

            const refreshed = await fetchApplications();

            setError(
                `The hire did not complete: ${err.message || 'the request failed'}. `
                + 'Some application statuses may already have been saved. '
                + (refreshed
                    ? 'The list below has been refreshed to show the actual state -- please review it before retrying.'
                    : 'The list could not be refreshed either, so reload the page before making any further changes.')
            );
        } finally {
            // STAGE 5I-1: released in finally, so neither a failed hire nor a
            // failed refresh can leave the buttons permanently disabled.
            hiringInFlightRef.current = false;
            setIsHiring(false);
        }
    };

    if (isInitialLoading) {
        return <PageLoader label="Loading applications…" />;
    }

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <div className="space-y-6">
                    <PageHeader
                        title={`Applications for Job "${jobTitle}"`}
                        description="Review the people who applied to this job."
                    />

                    {/* STAGE 5I-1: rendered above the list so the message stays next to the
                        refreshed statuses it describes, and so it survives the rerender the
                        refresh triggers. */}
                    {error && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle p-4 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">{error}</p>
                        </div>
                    )}
                    {/* STAGE 7E: an interview-read failure is reported separately from the
                        applications read above, because the two are independent: the applicant
                        list is still usable and the hire button still works when only the
                        interviews request failed. */}
                    {interviewsError && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle p-4 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">{interviewsError}</p>
                        </div>
                    )}
                    {/* STAGE 9D: reported independently of the two reads above, because all
                        three fail independently. The applicant list is still usable and the
                        hire button still works when only the tasks request failed; what is
                        lost is the ability to review work. */}
                    {tasksError && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-subtle p-4 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">{tasksError}</p>
                        </div>
                    )}

                    {/* STAGE 3D: this panel is only reached when the hire committed
                        but the employment workspace could not be selected from the
                        job's employment records. The hire is complete; the fallback
                        is the employee list rather than a retry that would hire twice. */}
                    {hireSuccess && (
                        <div
                            role="status"
                            className="rounded-md border border-success/30 bg-success-subtle p-4 text-sm text-success-subtle-foreground"
                        >
                            <p className="font-medium">Hire complete.</p>
                            <p className="mt-1">
                                The employment was created, but its workspace could not be opened
                                automatically. The employee is listed with the job&apos;s employees.
                            </p>
                            <Link
                                to={`/employer/jobs/${jobId}/employees/${jobTitle || 'job'}`}
                                className="mt-3 inline-flex h-9 items-center justify-center rounded-md bg-success px-4 text-sm font-medium text-foreground-inverse transition-colors hover:bg-success/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                            >
                                View employees for this job
                            </Link>
                        </div>
                    )}

                    {(() => {
                        const hasAccepted = applications.some(app => canonicalAppStatus(app.status) === ACCEPTED);
                        if (applications.length === 0) {
                            return (
                                <EmptyState
                                    icon={Users}
                                    title="No applications yet"
                                    description="No applications found for this job."
                                />
                            );
                        }
                        const visibleApplications = hasAccepted
                            ? applications.filter(app => canonicalAppStatus(app.status) === ACCEPTED)
                            : applications;
                        return (
                        <>
                            {hasAccepted && (
                                <div className="mb-4 rounded-md border border-border bg-surface-muted px-4 py-3 text-sm text-foreground-muted">
                                    This job has been filled. Only the hired applicant is shown.
                                </div>
                            )}
                        <ul className="space-y-4">
                            {visibleApplications.map(app => (
                                <Card as="li" key={app.id} className="p-5 sm:p-6">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex min-w-0 items-center gap-3">
                                            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-sm font-semibold text-accent-subtle-foreground">
                                                {getInitials(app.fullName)}
                                            </span>
                                            <h3 className="min-w-0 truncate text-lg font-semibold text-foreground">
                                                {app.fullName || 'N/A'}
                                            </h3>
                                        </div>
                                        {/* Stage 5G: was `app.status || 'Pending'`, which rendered a
                                            real pending application as the raw lowercase `pending`
                                            and reserved `Pending` for a missing value. Every stored
                                            value now has a label. */}
                                        <Badge variant={appStatusBadgeVariant(app.status)}>
                                            {appStatusLabel(app.status)}
                                        </Badge>
                                    </div>

                                    <div className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm text-foreground-muted sm:grid-cols-2">
                                        {/* Stage 5H: was an unguarded `app.dateApplied._seconds`. */}
                                        <div className="flex items-center gap-2">
                                            <Calendar className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                            <span>Applied on: {appliedOnLabel(app.dateApplied)}</span>
                                        </div>
                                        {app.employeePrice != null && (
                                            <div className="flex items-center gap-2">
                                                <Banknote className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                <span className="font-medium text-foreground">
                                                    Requested price: ₦{app.employeePrice}
                                                </span>
                                            </div>
                                        )}
                                    </div>

                                    <div className="mt-3 flex items-start gap-2 text-sm text-foreground-muted">
                                        <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                        <span className="whitespace-pre-wrap break-words">
                                            {app.message || 'No message provided'}
                                        </span>
                                    </div>

                                    {/* STAGE 12.13: the resume, cover letter and portfolio this
                                        applicant attached, if the job collected them. */}
                                    <ApplicantMaterials
                                        applicationId={app.id}
                                        resume={app.resume}
                                        coverLetter={app.coverLetter}
                                        portfolioUrl={app.portfolioUrl}
                                    />

                                    {/* STAGE 7G-2: see ApplicantDecisionButtons above. */}
                                    <ApplicantDecisionButtons
                                        application={app}
                                        isHiring={isHiring}
                                        isClearing={isClearing}
                                        onHire={changeStatus}
                                        onClear={clearForHiring}
                                        proposalState={proposalStates[app.id]}
                                    />

                                    {/* STAGE 7E. Deliberately placed after the hire button and
                                        independent of it: an interview is not a hire. This
                                        writes no application status, changes nothing on
                                        `app.status`, and does not enable or disable the Hire
                                        button -- Stage 7C models the interview as a separate
                                        fact about the application, not a new state of it. */}
                                    <div className="mt-4">
                                        <InterviewPanel
                                            applicationId={app.id}
                                            jobId={jobId}
                                            interviews={interviewsByApplication[app.id] || []}
                                            isLoading={isLoadingInterviews}
                                            onChanged={fetchInterviews}
                                        />
                                    </div>

                                    {/* STAGE 8C: the employer's way into the conversation with
                                        this applicant. Placed after InterviewPanel and last in
                                        the card, for the same reason InterviewPanel sits after
                                        the hire buttons: chat is a third independent fact about
                                        this application, so it neither enables nor disables
                                        anything above it and is not displaced by it.

                                        Rendered for every applicant at every status, which is
                                        deliberate. The Stage 8B backend admits either participant
                                        on the conversation and does not gate on application
                                        status, so restricting this control to pending or
                                        interviewed applicants would hide the thread from the two
                                        people who are in it precisely when it is still open -- and
                                        would break the post-hire conversation that Stage 8B exists
                                        to provide.

                                        STAGE 8F. `application.fullName` is written by
                                        the applicant at apply time, so this page already HELD
                                        the counterpart's name on every card and passed it
                                        straight through -- no lookup and no extra request.
                                        STAGE 10B. That pass-through is DELETED, and
                                        `decodedJobTitle` with it. Both named things the thread
                                        that used to render underneath this card; the thread now
                                        has its own screen at /messages/:conversationId, which
                                        looks the name up itself from GET /users/getUser/:id. A
                                        name resolved before navigating is a name that is lost
                                        on refresh, on a shared link and on a back navigation,
                                        and the applicant side has always had to survive that by
                                        looking it up at the destination -- so both sides now do
                                        the same thing instead of this one being the exception
                                        that happens to be convenient. */}
                                    <div className="mt-4">
                                        <ConversationLauncher
                                            applicationId={app.id}
                                            counterpartRole="employer"
                                        />
                                    </div>

                                    {/* STAGE 9D: the work this employee was hired to deliver,
                                        and the employer's review of it. Placed after the
                                        conversation for the same reason: reviewing submitted
                                        work is a third fact about the application that
                                        neither enables nor disables anything above it.

                                        Grouped by `app.employeeId`, so a card only ever shows
                                        this applicant's own work. The panel renders nothing
                                        when there is none, which is the case for every
                                        applicant who was not hired -- only an accepted
                                        applicant can be assigned a task at all. */}
                                    <div className="mt-4">
                                        <TaskReviewPanel
                                            tasks={tasksByEmployee[app.employeeId] || []}
                                            refreshTask={refreshTask}
                                        />
                                    </div>

                                    {/* STAGE 3B: application-linked contract proposals (pre-hire). */}
                                    <div className="mt-4">
                                        <Card className="border border-slate-200">
                                            <div className="flex items-center justify-between mb-2">
                                                <h4 className="text-sm font-semibold text-slate-900">Contract Proposal</h4>
                                                <Badge variant="neutral">Does not finalize hiring</Badge>
                                            </div>
                                            <p className="text-xs text-slate-600 mb-3">
                                                Propose terms to an interviewed applicant before creating an employment record. Acceptance means terms agreed, not hiring finalized: use Finalize hire above once the terms are accepted.
                                            </p>
                                            <ProposalSection app={app} onStateChange={handleProposalStateChange} />
                                        </Card>
                                    </div>

                                    {/* STAGE 9E: the explicit replacement for the placeholder
                                    the hire used to create. Offered only to a hired
                                    applicant -- `canonicalAppStatus` so a legacy
                                    `Employed` document counts as hired too, exactly as
                                    ApplicantDecisionButtons reads it -- because a task
                                    can only be assigned under an accepted application.

                                    Placed after the task list so the button sits below the
                                    work it adds to, and still renders when there are no
                                    tasks yet, which is the normal state immediately after
                                    a hire. */}
                                    {canonicalAppStatus(app.status) === ACCEPTED && (
                                        <TaskCreateForm
                                            jobId={jobId}
                                            employeeId={app.employeeId}
                                            employmentId={employmentIdByApplication[app.id]}
                                            applicantName={app.fullName}
                                            onCreated={fetchTasks}
                                        />
                                    )}
                                </Card>
                            ))}
                        </ul>
                        </>
                        );
                    })()}
                </div>
            </PageContainer>
        </div>
    );
};

const ProposalForm = ({ applicationId, proposal, onSaved }) => {
    const [form, setForm] = useState(() => proposalFormValues(proposal));
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const submitInFlightRef = useRef(false);
    const formId = useId();
    const paymentModeId = `${formId}-payment-mode`;
    const totalAmountId = `${formId}-total-amount`;
    const revising = Boolean(proposal);

    const setField = (field, value) => {
        setForm((current) => ({ ...current, [field]: value }));
    };

    const addMilestone = () => {
        setForm((current) => ({
            ...current,
            milestones: [...current.milestones, { label: '', amountMinor: '', description: '' }],
        }));
    };

    const updateMilestone = (idx, field, value) => {
        setForm((current) => {
            const milestones = [...current.milestones];
            milestones[idx] = { ...milestones[idx], [field]: value };
            return { ...current, milestones };
        });
    };

    const removeMilestone = (idx) => {
        setForm((current) => {
            if (current.milestones.length <= 1) return current;

            return {
                ...current,
                milestones: current.milestones.filter((_, index) => index !== idx),
            };
        });
    };

    const handleSubmit = async (event) => {
        event.preventDefault();
        setError('');

        const { ok, payload, error: buildError } = buildProposalPayload(applicationId, form);

        if (!ok) {
            setError(buildError);
            return;
        }

        if (submitInFlightRef.current) return;

        submitInFlightRef.current = true;
        setSubmitting(true);

        try {
            if (revising) {
                await reviseContractProposal(proposal.id, payload);
            } else {
                await createContractProposal(payload);
            }

            await onSaved();
        } catch (err) {
            setError(
                err.response?.data?.message
                || (revising ? 'Failed to revise proposal' : 'Failed to create proposal')
            );
        } finally {
            submitInFlightRef.current = false;
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-2">
            {error && <p role="alert" className="text-xs font-medium text-red-600">{error}</p>}
            <Field id={paymentModeId} label="Payment Mode">
                <Select
                    id={paymentModeId}
                    value={form.paymentMode}
                    onChange={(e) => setField('paymentMode', e.target.value)}
                    disabled={submitting}
                >
                    <option value="full">full</option>
                    <option value="milestones">milestones</option>
                </Select>
            </Field>
            {form.paymentMode === 'full' && (
                <Field id={totalAmountId} label="Total Amount (naira)">
                    <Input
                        id={totalAmountId}
                        type="number"
                        value={form.totalAmount}
                        onChange={(e) => setField('totalAmount', e.target.value)}
                        required
                        disabled={submitting}
                    />
                </Field>
            )}
            {form.paymentMode === 'milestones' && (
                <div className="space-y-2">
                    {form.milestones.map((milestone, idx) => {
                        const milestonePrefix = `${formId}-milestone-${idx}`;

                        return (
                            <div key={idx} className="border rounded p-2 space-y-1">
                                <Field id={`${milestonePrefix}-label`} label="Label">
                                    <Input
                                        id={`${milestonePrefix}-label`}
                                        value={milestone.label}
                                        onChange={(e) => updateMilestone(idx, 'label', e.target.value)}
                                        required
                                        disabled={submitting}
                                    />
                                </Field>
                                <Field id={`${milestonePrefix}-amount`} label="Amount (naira)">
                                    <Input
                                        id={`${milestonePrefix}-amount`}
                                        type="number"
                                        value={milestone.amountMinor}
                                        onChange={(e) => updateMilestone(idx, 'amountMinor', e.target.value)}
                                        required
                                        disabled={submitting}
                                    />
                                </Field>
                                <Field id={`${milestonePrefix}-description`} label="Description">
                                    <Input
                                        id={`${milestonePrefix}-description`}
                                        value={milestone.description}
                                        onChange={(e) => updateMilestone(idx, 'description', e.target.value)}
                                        disabled={submitting}
                                    />
                                </Field>
                                {form.milestones.length > 1 && (
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => removeMilestone(idx)}
                                        disabled={submitting}
                                    >
                                        Remove
                                    </Button>
                                )}
                            </div>
                        );
                    })}
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={addMilestone}
                        disabled={submitting}
                    >
                        Add Milestone
                    </Button>
                </div>
            )}
            <Button type="submit" size="sm" disabled={submitting}>
                {submitting
                    ? 'Sending...'
                    : revising ? 'Send revised terms' : 'Send proposal'}
            </Button>
        </form>
    );
};

const ProposalSection = ({ app, onStateChange }) => {
    const [proposals, setProposals] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await fetchContractProposalsForApplication(app.id);
            setProposals(data.proposals || []);
            return true;
        } catch (err) {
            setError(err.response?.data?.message || 'Failed to load proposals');
            return false;
        } finally {
            setLoading(false);
        }
    }, [app.id]);

    useEffect(() => {
        load();
    }, [load]);

    // STAGE 3D: report the same proposal state the panel renders, so the hire
    // button is gated on an accepted proposal without a second read. The parent
    // memoises this callback, and the identity checks there keep a render from
    // being treated as a new state.
    useEffect(() => {
        onStateChange?.(app.id, { loading, proposals, error });
    }, [app.id, loading, proposals, error, onStateChange]);

    const activeProposal = selectActiveProposal(proposals);
    const mode = proposalEditorMode(proposals);
    const canCreate = canCreateProposal(app.status, proposals);

    if (loading) {
        return <p className="text-xs text-slate-500">Loading proposals...</p>;
    }

    return (
        <div className="space-y-3">
            {error && <p className="text-xs font-medium text-red-600">{error}</p>}

            {proposals.map((proposal) => (
                <div key={proposal.id} className="border rounded-md p-2 text-xs space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <Badge variant={proposalStatusBadgeVariant(proposal.status)}>
                            {proposalStatusLabel(proposal.status)}
                        </Badge>
                        <span>Mode: {proposal.paymentMode}</span>
                    </div>
                    {proposal.totalAmountMinor !== undefined && proposal.totalAmountMinor !== null && (
                        <div>Total: {formatProposalAmount(proposal.totalAmountMinor)}</div>
                    )}
                    {proposal.commissionAmountMinor !== undefined && proposal.commissionAmountMinor !== null && (
                        <div>Commission: {formatProposalAmount(proposal.commissionAmountMinor)}</div>
                    )}
                    {Array.isArray(proposal.milestones) && proposal.milestones.length > 0 && (
                        <div>
                            <div className="font-medium">Milestones:</div>
                            <ul className="list-disc ml-4 space-y-1">
                                {proposal.milestones.map((milestone, idx) => (
                                    <li key={idx}>
                                        <span className="font-medium">{milestone.label}</span> — {formatProposalAmount(milestone.amountMinor)}
                                        {milestone.description ? (
                                            <div className="text-slate-500">{milestone.description}</div>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    {proposal.responseMessage && (
                        <div className="text-slate-600">
                            <span className="font-medium">Employee message:</span> {proposal.responseMessage}
                        </div>
                    )}
                </div>
            ))}

            {mode === 'accepted' && (
                <p className="text-xs font-medium text-green-700">
                    Terms accepted. Use Finalize hire above to create the employment record.
                </p>
            )}

            {mode === 'pending' && (
                <p className="text-xs text-slate-600">
                    Awaiting the applicant&apos;s response. You can send revised terms after they request changes.
                </p>
            )}

            {mode === 'revise' && activeProposal && (
                <div className="space-y-2 border-t border-slate-200 pt-3">
                    <p className="text-xs font-medium text-slate-700">
                        The applicant requested changes. Revise the terms and resend them.
                    </p>
                    <ProposalForm
                        key={activeProposal.id}
                        applicationId={app.id}
                        proposal={activeProposal}
                        onSaved={load}
                    />
                </div>
            )}

            {mode === 'create' && canCreate && (
                <div className="space-y-2">
                    <p className="text-xs text-slate-600">
                        Send terms for the applicant to accept. Hiring is not final until you use Finalize hire.
                    </p>
                    <ProposalForm
                        key="new-proposal"
                        applicationId={app.id}
                        proposal={null}
                        onSaved={load}
                    />
                </div>
            )}

            {mode === 'create' && !canCreate && (
                <p className="text-xs text-slate-600">
                    Proposals can be sent once this applicant is cleared for hiring.
                </p>
            )}
        </div>
    );
};

export default ViewJobApplications;
