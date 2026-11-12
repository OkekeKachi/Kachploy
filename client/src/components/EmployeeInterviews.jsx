import React, { useRef, useState } from 'react';
import api from '../api';
import Button from './ui/Button';

/**
 * STAGE 7F: the applicant-side interview section for one application.
 *
 * READ-ONLY UNTIL STAGE 10A, WHICH ADDED EXACTLY ONE WRITE
 *   Stage 7C's requireInterviewOwner was a deliberately single-authority guard, and
 *   its route comment recorded that "there is deliberately no applicant path: an
 *   applicant may read an interview but never modify one". So this component used to
 *   render no accept, decline, reschedule, cancel or complete control, and issued no
 *   POST or PUT.
 *
 *   STAGE 10A adds one applicant write, on its own route and its own guard
 *   (PUT /interviews/:interviewId/response, behind requireInterviewRespondent):
 *   answering the invitation with `accepted` or `declined`. Every other control above
 *   is still absent, because every other write in this resource is still
 *   employer-only -- so the "read-only" half of that rule is unchanged, and this is
 *   not a readOnly InterviewPanel with two buttons bolted on.
 *
 * WHY THE ANSWER IS NOT PART OF THE INTERVIEW STATUS
 *   It is tempting to make declining a status, so it would join the dropdown the
 *   employer already has. It is deliberately a separate field, for two reasons.
 *   First, the two are written by different people with different authority: the
 *   employer owns `status` and the applicant owns `response`, and a single field would
 *   mean one of them could overwrite the other's. Second, a status answers "what has
 *   happened to this interview?" while the response answers "does this applicant want
 *   it?" -- so an accepted interview is still `scheduled`, and declining one does not
 *   cancel it for the employer to discover later. This is the same reasoning Stage 7C
 *   used to keep the interview out of APPLICATION_STATUSES.
 *
 * WHY THIS IS NOT InterviewPanel WITH A readOnly PROP
 *   InterviewPanel is employer-side and writes on every interaction it exposes; the
 *   only thing it shares with this view is presentation. Gating it on a prop would
 *   mean threading `readOnly` through its form state, its submit handler, its
 *   scheduling button and its empty state, and would put the shipped Stage 7E
 *   behaviour at risk for a view that shares no logic with it. The two views also
 *   read different data: the employer gets one job-wide request grouped by the
 *   parent, whereas the applicant has only the per-application endpoint.
 *
 * WHY THE STATUS, TYPE AND RESPONSE LABELS ARE REPEATED RATHER THAN IMPORTED
 *   MyApplications.jsx already documents at the top that this page keeps its own
 *   copy of the status label maps and that "there is deliberately no shared status
 *   module"; the employer page has its own third copy. Following that convention
 *   here is consistent, and keeps a read-only applicant view from importing a
 *   write-capable component to borrow two lookup tables. A shared presentation
 *   module is the right eventual answer for all four, and is not this stage's job.
 */

/**
 * Decodes the shapes `scheduledAt` can arrive in, and renders in the reader's own
 * local time.
 *
 * Stage 7E writes `scheduledAt` as an ISO string, so interviews created by the
 * employer panel come back as strings. A record written by another client could be
 * a Firestore Timestamp, which arrives as `{_seconds, _nanoseconds}` -- the same
 * wire shape `dateLabel` in HiredJobs.jsx and `appliedOnLabel` in
 * ViewJobApplications.jsx already decode. Every input, including undefined, yields
 * a value rather than throwing, because one malformed date must not take down the
 * whole application list.
 *
 * `toLocaleString()` with no argument renders in the browser's own time zone and
 * locale, which is what an applicant wants: the stored value is a UTC instant, and
 * "10:00" is meaningless without knowing where the reader is. The time zone name
 * is appended so a cross-zone reader can see the offset rather than having to infer
 * it.
 */
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

// The two canonical types the Stage 7C service accepts. Kept as literals, as in
// InterviewPanel: INTERVIEW_TYPES is a server constant exposed over no endpoint.
const TYPE_LABEL = { online: 'Online', in_person: 'In person' };

// The four canonical statuses Stage 7C writes.
const STATUS_LABEL = {
    scheduled: 'Scheduled',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'No show',
};

// STAGE 10A. The two answers interviewService.INTERVIEW_RESPONSES accepts. `pending` is
// not in this map on purpose: it is not a stored value, it is the absence of one, and
// responseLabel below words that case directly. Anything unexpected falls through to
// the raw value, exactly as the status and type labels above do, so a document written
// by some future writer is shown rather than mislabelled.
const RESPONSE_LABEL = {
    accepted: 'Accepted',
    declined: 'Declined',
};

// Mirrors interviewService.RESPONDABLE_INTERVIEW_STATUSES. This is a display gate
// only -- it decides whether the buttons are offered, never whether a response is
// legal, which is the server's decision and the reason every one of these calls can
// still come back 400. Offering no control on a completed interview is a courtesy to
// the applicant; it is not the rule.
const RESPONDABLE_STATUSES = ['scheduled'];

const isRespondable = (interview) => RESPONDABLE_STATUSES.includes(interview.status);

/**
 * What this applicant has said about the invitation.
 *
 * An absent `response` is worded as a pending invitation rather than shown as a blank,
 * because "no answer yet" is the single most useful thing on this card: it is what
 * tells the applicant there is something here for them to do.
 */
const responseLabel = (interview) => {
    if (!interview.response) return 'Awaiting your response';

    return RESPONSE_LABEL[interview.response] || interview.response;
};

/**
 * STAGE 10A. Surfaces the server's own explanation for a refused response.
 *
 * Every failure on this route answers `{ message }` -- interviewController's
 * sendFailure uses that key exclusively -- so it is usually specific and actionable
 * ("This interview can no longer be answered. Its status is: completed."). The
 * fallback covers a 500 from the controller's generic text and a network failure,
 * where there is no response at all. Local to this file, as readErrorMessage is local
 * to MyApplications.jsx and errorMessage to InterviewPanel.jsx.
 */
const readErrorMessage = (err, fallback) =>
    (err && err.response && err.response.data && err.response.data.message) || fallback;

// Hoisted so they are not re-created on every render, and so the two early-return
// branches below stay visually identical to the loaded branch.
const SECTION = { marginTop: '12px', borderTop: '1px solid #e5e7eb', paddingTop: '10px' };
const HEADING = { margin: '0 0 8px' };
const LINE = { margin: '0 0 4px' };
const LIST = { listStyle: 'none', padding: 0, margin: 0 };
const CARD = { border: '1px solid #ccc', borderRadius: '8px', padding: '10px', marginBottom: '8px' };
const ACTIONS = { marginTop: '6px' };

const EmployeeInterviews = ({ interviews, loading, error, onRespond }) => {
    const list = Array.isArray(interviews) ? interviews : [];

    /*
        STAGE 10A. One slot per interview: `{ saving, error, message }`, keyed by
        interview id rather than held as single values, so two interviews on the same
        application -- which a job that reschedules will produce, and which the
        employer panel makes trivially easy to create -- can be answered independently
        without one card's error or spinner landing on the other.
    */
    const [respondState, setRespondState] = useState({});

    /*
        STAGE 5I-1 convention, which InterviewPanel.jsx already uses for its own submit
        and MyApplications.jsx uses for the hire button: a `saving` flag alone cannot
        stop a double click. Two clicks in one tick both read the pre-update render,
        before React has rerendered, so both would enter the workflow and both would
        PUT the same answer. This one is keyed by interview id, unlike the single
        boolean elsewhere, because the whole point of the per-interview state above is
        that these do not block each other.

        Synchronously set before the first await and released in finally.
    */
    const inFlightRef = useRef({});

    /**
     * Records one answer, then asks the parent to re-read.
     *
     * The write answers `{ message }` and no endpoint in this API returns the updated
     * document, so the card cannot show the new answer from the response body -- it
     * has to be re-read, which is what `onRespond` is for. Re-reading rather than
     * patching the prop matters for the same reason it does in InterviewPanel: the
     * write also rewrote `updatedAt`, and the parent owns the list.
     *
     * A failure leaves the stored answer untouched and reports the server's message in
     * place on that one card, so an interview the employer cancelled a second ago says
     * so instead of silently doing nothing.
     */
    const handleRespond = async (interviewId, response) => {
        if (inFlightRef.current[interviewId]) return;

        inFlightRef.current[interviewId] = true;
        setRespondState((previous) => ({
            ...previous,
            [interviewId]: { saving: true, error: null, message: null },
        }));

        try {
            // Flat payload, as api.post's callers send it. The `{ body: ... }` form
            // InterviewPanel uses is a test-harness convention, not an axios one.
            await api.put(`/interviews/${interviewId}/response`, { response });

            setRespondState((previous) => ({
                ...previous,
                [interviewId]: { saving: false, error: null, message: 'Response recorded.' },
            }));

            if (onRespond) await onRespond(interviewId);
        } catch (err) {
            console.error(`Error answering interview ${interviewId}:`, err);
            setRespondState((previous) => ({
                ...previous,
                [interviewId]: {
                    saving: false,
                    error: readErrorMessage(
                        err,
                        'Your response could not be recorded. Please try again.'
                    ),
                    message: null,
                },
            }));
        } finally {
            delete inFlightRef.current[interviewId];
        }
    };

    /*
        While the read is in flight this must not claim the applicant has no
        interviews -- an empty array is also what a finished read returns for an
        application that genuinely has none, so showing that sentence during the
        load would assert a fact nobody has established. This is the same reason
        InterviewPanel withholds its scheduling button while loading, and it is the
        reason the answer controls below are unreachable until the list exists: there
        is nothing to answer yet.
    */
    if (loading) {
        return (
            <div style={SECTION}>
                <h5 style={HEADING}>Interviews</h5>
                <p role="status" style={LINE}>Loading interviews...</p>
            </div>
        );
    }

    /*
        An error is shown in place of the section rather than beside it: the list
        below would be empty by default, so rendering both would state "no
        interviews scheduled" alongside "could not load interviews" and contradict
        itself. The applicant is told nothing about their own application status
        here either -- this reads interviews only.
    */
    if (error) {
        return (
            <div style={SECTION}>
                <h5 style={HEADING}>Interviews</h5>
                <p role="alert" style={{ ...LINE, color: '#dc2626' }}>{error}</p>
            </div>
        );
    }

    return (
        <div style={SECTION}>
            <h5 style={HEADING}>Interviews</h5>
            {list.length === 0 ? (
                <p style={LINE}>No interviews have been scheduled for this application yet.</p>
            ) : (
                <ul style={LIST}>
                    {list.map((interview) => {
                        const state = respondState[interview.id];
                        const isSaving = Boolean(state && state.saving);
                        const canRespond = isRespondable(interview);

                        return (
                        <li key={interview.id} style={CARD}>
                            <p style={LINE}>
                                <strong>When:</strong> {scheduledLabel(interview.scheduledAt)}
                            </p>
                            <p style={LINE}>
                                <strong>Type:</strong> {TYPE_LABEL[interview.type] || interview.type}
                            </p>
                            <p style={LINE}>
                                <strong>Status:</strong> {STATUS_LABEL[interview.status] || interview.status}
                            </p>
                            <p style={LINE}>
                                <strong>Your response:</strong> {responseLabel(interview)}
                            </p>
                            {interview.duration != null && (
                                <p style={LINE}>
                                    <strong>Duration:</strong> {interview.duration} minutes
                                </p>
                            )}
                            {/*
                                Each detail is rendered when it is stored, whichever type
                                the interview has, rather than only when it matches. The
                                service permits an online interview with no link and an
                                in-person one with no location, and Stage 7E clears the
                                irrelevant field on a type change -- but a record written
                                before that clearing, or directly through another client,
                                can still hold both. Type-gating would hide a detail that
                                is genuinely stored, so the same choice as InterviewPanel
                                is made here.
                            */}
                            {interview.meetingLink && (
                                <p style={LINE}>
                                    {/* A stored link is arbitrary text server-side (isValidOptionalText),
                                        so it is rendered as text and not as an anchor: an unknown
                                        or javascript: scheme would otherwise be made clickable in a
                                        page the applicant trusts. A real https:// link is still
                                        fully usable by selecting and copying it. */}
                                    <strong>Meeting link:</strong> {interview.meetingLink}
                                </p>
                            )}
                            {interview.location && (
                                <p style={LINE}>
                                    <strong>Location:</strong> {interview.location}
                                </p>
                            )}

                            {/*
                                STAGE 10A. The two answers, offered together rather than as
                                a single confirm: the service lets an applicant change a
                                scheduled interview's answer as often as they like, so a
                                second control to undo or replace the first is not needed and
                                hiding the buttons once answered would leave a change of mind
                                with nowhere to go. Which one is current is carried by the
                                "Your response" line above.

                                OFFERED ONLY WHILE `scheduled`. An interview the employer
                                has completed, cancelled or marked a no-show is refused by
                                respondToInterview with a 400, so the controls are withheld
                                rather than left to fail. Both are disabled together while a
                                request for THIS interview is in flight: they are two answers
                                to the same question, and issuing both would leave the
                                interview holding whichever landed last.
                            */}
                            {canRespond && (
                                <div style={ACTIONS}>
                                    <Button
                                        type="button"
                                        size="sm"
                                        onClick={() => handleRespond(interview.id, 'accepted')}
                                        disabled={isSaving}
                                        aria-busy={isSaving}
                                    >
                                        Accept
                                    </Button>
                                    {' '}
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="secondary"
                                        onClick={() => handleRespond(interview.id, 'declined')}
                                        disabled={isSaving}
                                        aria-busy={isSaving}
                                    >
                                        Decline
                                    </Button>
                                    {isSaving && (
                                        <span role="status" style={{ marginLeft: '8px' }}>
                                            Saving...
                                        </span>
                                    )}
                                </div>
                            )}

                            {/* Reported per card, beside the controls that failed, so a
                                refusal on one interview of several cannot be mistaken for a
                                failure of the whole section. */}
                            {state && state.error && (
                                <p role="alert" style={{ ...LINE, color: '#dc2626' }}>
                                    {state.error}
                                </p>
                            )}
                            {state && state.message && (
                                <p role="status" style={{ ...LINE, color: '#15803d' }}>
                                    {state.message}
                                </p>
                            )}
                        </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

export default EmployeeInterviews;