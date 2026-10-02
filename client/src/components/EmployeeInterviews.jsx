import React from 'react';

/**
 * STAGE 7F: the applicant-side interview section for one application.
 *
 * READ-ONLY BY DESIGN
 *   An applicant may read an interview; every write is employer-only. Stage 7C's
 *   requireInterviewOwner is deliberately a single-authority guard -- the comment
 *   in server/routes/interviews.js records that "there is deliberately no applicant
 *   path: an applicant may read an interview but never modify one". So this
 *   component renders no accept, decline, reschedule, cancel or complete control,
 *   and issues no POST or PUT. Those controls would be refused with a 403 by the
 *   server regardless of what the UI offered.
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
 * WHY THE STATUS AND TYPE LABELS ARE REPEATED RATHER THAN IMPORTED
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

// Hoisted so they are not re-created on every render, and so the two early-return
// branches below stay visually identical to the loaded branch.
const SECTION = { marginTop: '12px', borderTop: '1px solid #e5e7eb', paddingTop: '10px' };
const HEADING = { margin: '0 0 8px' };
const LINE = { margin: '0 0 4px' };
const LIST = { listStyle: 'none', padding: 0, margin: 0 };
const CARD = { border: '1px solid #ccc', borderRadius: '8px', padding: '10px', marginBottom: '8px' };

const EmployeeInterviews = ({ interviews, loading, error }) => {
    const list = Array.isArray(interviews) ? interviews : [];

    /*
        While the read is in flight this must not claim the applicant has no
        interviews -- an empty array is also what a finished read returns for an
        application that genuinely has none, so showing that sentence during the
        load would assert a fact nobody has established. This is the same reason
        InterviewPanel withholds its scheduling button while loading.
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
                    {list.map((interview) => (
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
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default EmployeeInterviews;