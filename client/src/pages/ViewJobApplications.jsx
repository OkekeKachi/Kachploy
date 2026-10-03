import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import InterviewPanel from '../components/InterviewPanel';

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
const ApplicantDecisionButtons = ({ application, isHiring, isClearing, onHire, onClear }) => {
    const appStatus = canonicalAppStatus(application.status);

    // Unchanged Stage 5I behaviour: a hired applicant reads "Hired" and is offered
    // nothing further.
    if (appStatus === ACCEPTED) {
        return (
            <button type="button" style={{ marginTop: '10px' }} disabled>
                Hired
            </button>
        );
    }

    const canHire = appStatus === INTERVIEWED;

    // STAGE 7G-2 follow-up: `rejected` is clearable as well as `pending`. Rejection is
    // not a dead end -- an employer who rejects an applicant by some other route, or
    // who changes their mind, can bring them back to `interviewed` and hire them from
    // there. This does NOT let a rejected applicant be hired directly: `canHire` above
    // is unchanged, so `rejected` still renders a disabled Hire button and still has
    // to pass through the clear action first, which is the only thing on this page
    // that writes `interviewed`.
    //
    // The button and the hint below are both driven off this one flag on purpose.
    // Spelling the status out in both places is how they drifted apart once already,
    // leaving rejected applicants with no way back and a hint that said hiring was
    // simply unavailable.
    const canClearForHiring = appStatus === PENDING || appStatus === REJECTED;

    return (
        <>
            {canClearForHiring && (
                <button
                    type="button"
                    onClick={() => onClear(application)}
                    style={{ marginTop: '10px', marginRight: '8px' }}
                    disabled={isClearing || isHiring}
                >
                    {isClearing ? 'Clearing...' : 'Clear for hiring'}
                </button>
            )}
            <button
                type="button"
                onClick={() => onHire(application)}
                style={{ marginTop: '10px' }}
                disabled={isHiring || isClearing || !canHire}
            >
                Hire
            </button>
            {!canHire && (
                <p style={{ margin: '6px 0 0', color: '#6b7280' }}>
                    {canClearForHiring
                        ? 'Hire becomes available once this applicant is cleared for hiring.'
                        : 'Hire is not available for this applicant.'}
                </p>
            )}
        </>
    );
};

const ViewJobApplications = () => {
    const { jobId, jobTitle } = useParams();
    const [applications, setApplications] = useState([]);
    // STAGE 5I-1: the user-visible failure message. The workflow used to report
    // failures only to the console, so a hire that failed halfway was
    // indistinguishable from one that had never started.
    const [error, setError] = useState('');
    const [isHiring, setIsHiring] = useState(false);
    // STAGE 5I-1: `isHiring` on its own cannot stop a double click. Two clicks
    // dispatched in the same tick both read the pre-update render, because React
    // has not rerendered yet, so both would enter the workflow and both would
    // reach POST /tasks. This ref is checked and set synchronously, before the
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

    useEffect(() => {
        fetchApplications();
        fetchInterviews();
    }, [fetchApplications, fetchInterviews]);

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

        try {
            // 1. Update status for all applicants.
            // Stage 5G: canonical values. The sequence itself is unchanged --
            // every applicant is still restatused, the hired one accepted and
            // the rest rejected -- and it is still three separate writes with no
            // transaction.
            await Promise.all(
                applications.map(async (app) => {
                    await api.put(`/applications/${app.id}/status`, {
                        status: app.id === hiredApplicant.id ? ACCEPTED : REJECTED,
                    });
                })
            );

            // 2. Create a task for the hired applicant
            await api.post('/tasks', {
                jobId,
                employeeId: hiredApplicant.employeeId,
                taskName: `Task for ${hiredApplicant.fullName}`,
                taskDescription: `Initial task for the hired employee: ${hiredApplicant.fullName}`,
                dueDate: new Date().toISOString(),
            });

            // 3. Change the job status to filled.
            // Stage 5G: was the title-cased 'Filled', which the dashboards did not
            // recognise -- an employer saw their own filled job labelled
            // "Closed". The canonical spelling is lowercase.
            await api.put(`/jobs/${jobId}/status`, {
                status: 'filled',
            });

            // 4. Update UI
            setApplications(applications.map(app =>
                app.id === hiredApplicant.id
                    ? { ...app, status: ACCEPTED }
                    : { ...app, status: REJECTED }
            ));

        } catch (err) {
            // STAGE 5I-1: the diagnostic log is kept, but it is no longer the only
            // report. Step 1 is a Promise.all over every applicant, so one
            // rejection can leave some applicants written and others not, and a
            // failure at step 2 or 3 leaves steps 1 to 2 committed. The list on
            // screen is then fiction, so it is refetched and the employer is told
            // what happened. Nothing is retried and no request is replayed:
            // re-running the workflow would restatus every applicant and create a
            // second task.
            console.error('Error changing status or creating task:', err);

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

    return (
        <div style={{ padding: '20px' }}>
            <h2>Applications for Job "{jobTitle}"</h2>
            {/* STAGE 5I-1: rendered above the list so the message stays next to the
                refreshed statuses it describes, and so it survives the rerender the
                refresh triggers. */}
            {error && (
                <p role="alert" style={{ color: '#dc2626', marginBottom: '12px' }}>
                    {error}
                </p>
            )}
            {/* STAGE 7E: an interview-read failure is reported separately from the
                applications read above, because the two are independent: the applicant
                list is still usable and the hire button still works when only the
                interviews request failed. */}
            {interviewsError && (
                <p role="alert" style={{ color: '#dc2626', marginBottom: '12px' }}>
                    {interviewsError}
                </p>
            )}
            {applications.length === 0 ? (
                <p>No applications found for this job.</p>
            ) : (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                    {applications.map(app => (
                        <li key={app.id} style={{
                            border: '1px solid #ccc',
                            borderRadius: '10px',
                            padding: '15px',
                            marginBottom: '10px'
                        }}>
                            <h4>Applicant: {app.fullName || 'N/A'}</h4>
                            <p><strong>Message:</strong> {app.message || 'No message provided'}</p>
                            {/* Stage 5G: was `app.status || 'Pending'`, which rendered a
                                real pending application as the raw lowercase `pending`
                                and reserved `Pending` for a missing value. Every stored
                                value now has a label. */}
                            <p><strong>Status:</strong> {appStatusLabel(app.status)}</p>
                            {app.employeePrice != null && (
                                <p><strong>Requested price:</strong> ₦{app.employeePrice}</p>
                            )}
                            {/* Stage 5H: was an unguarded `app.dateApplied._seconds`. */}
                            <p><strong>Applied on:</strong> {appliedOnLabel(app.dateApplied)}</p>
                            {/* STAGE 7G-2: see ApplicantDecisionButtons above. */}
                            <ApplicantDecisionButtons
                                application={app}
                                isHiring={isHiring}
                                isClearing={isClearing}
                                onHire={changeStatus}
                                onClear={clearForHiring}
                            />
                            {/* STAGE 7E. Deliberately placed after the hire button and
                                independent of it: an interview is not a hire. This
                                writes no application status, changes nothing on
                                `app.status`, and does not enable or disable the Hire
                                button -- Stage 7C models the interview as a separate
                                fact about the application, not a new state of it. */}
                            <InterviewPanel
                                applicationId={app.id}
                                jobId={jobId}
                                interviews={interviewsByApplication[app.id] || []}
                                isLoading={isLoadingInterviews}
                                onChanged={fetchInterviews}
                            />
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default ViewJobApplications;
