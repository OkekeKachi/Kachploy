import React, { useRef, useState } from 'react';
import api from '../api';

/**
 * STAGE 7E: the employer-side interview section for one applicant.
 *
 * This is the first UI over the Stage 7C interviews API. It consumes the four
 * existing endpoints and adds no new ones:
 *
 *   POST   /interviews                create   (requireInterviewAuthor)
 *   PUT    /interviews/:interviewId   update   (requireInterviewOwner)
 *   GET    /interviews/job/:jobId     read     (requireJobOwner)
 *   GET    /interviews/application/:applicationId  (requireInterviewParty)
 *
 * STAGE 10A added a fifth endpoint, PUT /interviews/:interviewId/response, which this
 * panel neither calls nor could: `response` is the applicant's to write, behind
 * requireInterviewRespondent, and an employer sending it is refused with a 400. What
 * Stage 10A adds here is one line of display -- the applicant's answer -- read off the
 * job-wide GET above, so it costs no additional request.
 *
 * WHY THE PANEL IS GIVEN ITS INTERVIEWS RATHER THAN FETCHING THEM
 *   ViewJobApplications.jsx fetches the job-wide list once and groups it by
 *   applicationId, then hands each applicant card its own slice. Fetching
 *   per-applicant from here would issue one request per applicant on a page that
 *   routinely lists many, which is the N+1 pattern Stage 4 documented for
 *   listApplicationsForEmployee.
 *
 * AUTHORIZATION IS NOT DECIDED HERE
 *   This component has no idea whether the signed-in user may create or change an
 *   interview. Every decision is server-side, in the three Stage 7C guards, and a
 *   403 arrives here as an ordinary error to be displayed. The `Put /applications/
 *   :id/status` hire button on the parent page is untouched by this stage: an
 *   interview is not a hire and writes no application status.
 *
 * WHAT IS DELIBERATELY ABSENT
 *   * No notes field. The Stage 7C schema has none -- UPDATABLE_INTERVIEW_FIELDS is
 *     scheduledAt / duration / type / meetingLink / location / status -- and
 *     interviewService drops unknown body keys silently, so a notes box here would
 *     appear to save and quietly discard the text.
 *   * No chat, notifications, video calling or calendar integration.
 *   * No applicant-facing mode. Reads are shared by both parties server-side, but
 *     every write in this panel is an employer write, and the one applicant write that
 *     now exists (the accept/decline added in Stage 10A) is only ever displayed here.
 */

/**
 * Decodes the shapes `scheduledAt` can arrive in.
 *
 * This panel writes `scheduledAt` as an ISO string (`new Date(local).toISOString()`),
 * so its own records come back as strings. A record written by another client, or by
 * a future server-side default, could be a Firestore Timestamp, which arrives as
 * `{_seconds, _nanoseconds}` -- the same wire shape `appliedOnLabel` in
 * ViewJobApplications.jsx and `dateLabel` in HiredJobs.jsx already decode. Mirrors
 * those two: every input, including undefined, yields a value rather than throwing,
 * because one malformed date must not take the applicant list down with it.
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
    return date ? date.toLocaleString() : 'Date not available';
};

/**
 * A Date -> the `YYYY-MM-DDTHH:mm` string `<input type="datetime-local">` expects.
 *
 * Deliberately built from the LOCAL getters rather than by slicing an ISO string.
 * `toISOString().slice(0, 16)` yields UTC components, which on a browser west of
 * Greenwich silently shifts every prefilled time by the offset -- an interview
 * rescheduled "at 10:00" would be saved at 09:00. Composing from getFullYear() /
 * getHours() keeps the value the employer is looking at, and the inverse conversion
 * in `toIsoInstant` puts it back.
 */
const toDateTimeLocalValue = (value) => {
    const date = toDate(value);
    if (!date) return '';

    const pad = (n) => String(n).padStart(2, '0');

    return [
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
        `T${pad(date.getHours())}:${pad(date.getMinutes())}`,
    ].join('');
};

/**
 * A `datetime-local` value -> the ISO instant sent to the server.
 *
 * `new Date('2026-10-02T10:00')` is parsed as LOCAL time, so the instant sent is the
 * one the employer picked, expressed in UTC. The server's isScheduledInstant accepts
 * any parseable string, and an ISO string is the least ambiguous of them.
 */
const toIsoInstant = (localValue) => {
    const date = new Date(localValue);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

// The two canonical types the Stage 7C service accepts. Kept as literals rather than
// fetched: INTERVIEW_TYPES is a server constant and not exposed over any endpoint, and
// a third value here would only produce a server-side 400.
const TYPE_LABEL = { online: 'Online', in_person: 'In person' };

// The four canonical statuses. `scheduled` is written by the create and is offered
// here because the endpoint is an allow-list rather than a transition matrix, so
// moving an interview back to scheduled is a legal correction the employer may make.
const STATUS_LABEL = {
    scheduled: 'Scheduled',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'No show',
};

// STAGE 10A. The two answers the applicant may give, which this panel only ever
// DISPLAYS. There is deliberately no control that writes them: `response` is not in
// UPDATABLE_INTERVIEW_FIELDS, and the one route that writes it belongs to the
// applicant, so an employer answering for them would be refused with a 400. Kept as
// literals for the same reason STATUS_LABEL is: INTERVIEW_RESPONSES is a server
// constant and not exposed over any endpoint.
const RESPONSE_LABEL = {
    accepted: 'Accepted',
    declined: 'Declined',
};

/**
 * STAGE 10A. The applicant's answer, as the employer sees it.
 *
 * An unanswered interview reads as "Awaiting response" rather than as a blank,
 * because for this panel an invitation with no answer is the thing worth noticing:
 * it is a scheduled meeting the applicant may not have seen.
 *
 * Anything unexpected falls through to the raw stored value, as TYPE_LABEL and
 * STATUS_LABEL above do, so a document written by some future writer is shown rather
 * than mislabelled as unanswered.
 */
const responseLabel = (interview) => {
    if (!interview.response) return 'Awaiting response';

    return RESPONSE_LABEL[interview.response] || interview.response;
};

const EMPTY_FORM = {
    type: 'online',
    scheduledAt: '',
    duration: '',
    meetingLink: '',
    location: '',
    // Only ever sent by an update. A create cannot choose a status: the server writes
    // `scheduled` itself and ignores a client value, so the control is not rendered
    // while scheduling and this stays empty.
    status: '',
};

/**
 * Pulls the server's own explanation out of a failed request.
 *
 * Every Stage 7C failure answers `{ message }` -- the controller's sendFailure uses
 * that key exclusively -- so the message is usually specific and actionable
 * ("Invalid duration. It must be a positive number of minutes."). The fallbacks cover
 * a 500 from the controller's generic text and a network failure where there is no
 * response at all.
 */
const errorMessage = (err, fallback) =>
    err?.response?.data?.message || err?.message || fallback;

const InterviewPanel = ({ applicationId, jobId, interviews = [], isLoading = false, onChanged }) => {
    const [isScheduling, setIsScheduling] = useState(false);
    const [editingId, setEditingId] = useState(null);
    const [form, setForm] = useState(EMPTY_FORM);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    // STAGE 5I-1 convention, which ViewJobApplications.jsx already uses for its hire
    // button: `isSaving` alone cannot stop a double click. Two clicks in one tick both
    // read the pre-update render, before React has rerendered, so both would enter
    // the workflow and both would POST a second interview. Checked and set
    // synchronously before the first await; released in finally.
    const saveInFlightRef = useRef(false);

    const resetForm = () => {
        setForm(EMPTY_FORM);
        setEditingId(null);
        setIsScheduling(false);
    };

    const updateField = (field) => (event) => {
        const { value } = event.target;
        setForm((previous) => {
            const next = { ...previous, [field]: value };

            // Switching type retires the field that no longer applies, so a stale
            // meeting link is not submitted against an in-person interview.
            if (field === 'type') {
                if (value === 'online') next.location = '';
                else next.meetingLink = '';
            }

            return next;
        });
    };

    /**
     * Turns the form into a request body.
     *
     * Two behaviours differ between create and update, and both are forced by the
     * Stage 7C service rather than by taste:
     *
     *   * `duration` is omitted when blank. interviewService rejects an empty string
     *     for it ("Invalid duration") -- unlike `meetingLink` and `location`, an
     *     absent optional number has no null to mean "not supplied" on a create.
     *   * On update, the field that no longer applies is sent as an explicit `null`,
     *     which is the only way to clear it: the update is partial, so omitting it
     *     would leave the old value stored. Blank `meetingLink` / `location` strings
     *     are rejected outright, so `null` -- not `''` -- is what "clear this" means.
     */
    const buildPayload = (values, isUpdate) => {
        const payload = {
            scheduledAt: toIsoInstant(values.scheduledAt),
            type: values.type,
        };

        if (values.duration.trim() !== '') {
            payload.duration = Number(values.duration);
        }

        if (values.type === 'online') {
            const link = values.meetingLink.trim();
            if (link) payload.meetingLink = link;
            else if (isUpdate) payload.meetingLink = null;
        } else {
            const place = values.location.trim();
            if (place) payload.location = place;
            else if (isUpdate) payload.location = null;
        }

        if (isUpdate && values.status) {
            payload.status = values.status;
        }

        return payload;
    };

    const startScheduling = () => {
        setSuccess('');
        setError('');
        setEditingId(null);
        setForm(EMPTY_FORM);
        setIsScheduling(true);
    };

    const startEditing = (interview) => {
        setSuccess('');
        setError('');
        setIsScheduling(false);
        setEditingId(interview.id);
        setForm({
            type: interview.type,
            scheduledAt: toDateTimeLocalValue(interview.scheduledAt),
            duration: interview.duration == null ? '' : String(interview.duration),
            meetingLink: interview.meetingLink || '',
            location: interview.location || '',
            status: interview.status || 'scheduled',
        });
    };

    const handleSubmit = async (event) => {
        event.preventDefault();

        if (saveInFlightRef.current) return;

        if (!form.scheduledAt) {
            setError('Please choose a date and time for the interview.');
            return;
        }

        const isUpdate = Boolean(editingId);

        // Checked here rather than left to the server's 400 because `Number('abc')` is
        // NaN, which JSON.stringify turns into `null` -- the request would then be
        // refused for a reason the employer did not cause. Zero and negatives are
        // rejected for the same reason: isValidDuration requires a positive number.
        if (form.duration.trim() !== '') {
            const minutes = Number(form.duration);
            if (!Number.isFinite(minutes) || minutes <= 0) {
                setError('Duration must be a positive number of minutes.');
                return;
            }
        }

        saveInFlightRef.current = true;
        setIsSaving(true);
        setError('');
        setSuccess('');

        try {
            if (isUpdate) {
                await api.put(`/interviews/${editingId}`, buildPayload(form, true));
                setSuccess('Interview updated.');
            } else {
                await api.post('/interviews', {
                    ...buildPayload(form, false),
                    applicationId,
                    jobId,
                });
                setSuccess('Interview scheduled.');
            }

            resetForm();
            // Re-read rather than patching the local array: the write rewrote
            // `updatedAt` and the create assigned an id the panel never saw.
            if (onChanged) await onChanged();
        } catch (err) {
            console.error('Error saving interview:', err);
            setError(errorMessage(err, isUpdate
                ? 'The interview could not be updated. Please try again.'
                : 'The interview could not be scheduled. Please try again.'));
        } finally {
            saveInFlightRef.current = false;
            setIsSaving(false);
        }
    };

    const isEditing = Boolean(editingId);

    return (
        <div style={{ marginTop: '12px', borderTop: '1px solid #e5e7eb', paddingTop: '10px' }}>
            <h5 style={{ margin: '0 0 8px' }}>Interviews</h5>

            {/*
                STAGE 7E: while the job-wide read is in flight the panel must not claim
                this applicant has no interviews -- an empty array is also what a
                finished read returns for an applicant who genuinely has none, and
                showing that sentence during the load would report a fact nobody has
                established yet. The scheduling button is withheld for the same reason:
                offering it before the list has loaded invites a second interview for
                an applicant who already has one.
            */}
            {isLoading ? (
                <p style={{ margin: '0 0 8px' }}>Loading interviews...</p>
            ) : interviews.length === 0 ? (
                <p style={{ margin: '0 0 8px' }}>No interviews scheduled for this applicant yet.</p>
            ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px' }}>
                    {interviews.map((interview) => (
                        <li
                            key={interview.id}
                            style={{ border: '1px solid #ccc', borderRadius: '8px', padding: '10px', marginBottom: '8px' }}
                        >
                            <p style={{ margin: '0 0 4px' }}>
                                <strong>When:</strong> {scheduledLabel(interview.scheduledAt)}
                            </p>
                            <p style={{ margin: '0 0 4px' }}>
                                <strong>Type:</strong> {TYPE_LABEL[interview.type] || interview.type}
                            </p>
                            <p style={{ margin: '0 0 4px' }}>
                                <strong>Status:</strong> {STATUS_LABEL[interview.status] || interview.status}
                            </p>
                            {/*
                                STAGE 10A: the applicant's answer, read from the same
                                job-wide GET as everything else on this card, so it costs no
                                additional request. Display only -- see RESPONSE_LABEL for why
                                there is no control here that writes it.
                            */}
                            <p style={{ margin: '0 0 4px' }}>
                                <strong>Applicant response:</strong> {responseLabel(interview)}
                            </p>
                            {interview.duration != null && (
                                <p style={{ margin: '0 0 4px' }}>
                                    <strong>Duration:</strong> {interview.duration} minutes
                                </p>
                            )}
                            {/* Both details are rendered whenever they are stored, not
                                only when they match the type: the service permits an
                                online interview with no link and an in-person one with
                                no location, and a record may predate a type change. */}
                            {interview.meetingLink && (
                                <p style={{ margin: '0 0 4px' }}>
                                    <strong>Meeting link:</strong> {interview.meetingLink}
                                </p>
                            )}
                            {interview.location && (
                                <p style={{ margin: '0 0 4px' }}>
                                    <strong>Location:</strong> {interview.location}
                                </p>
                            )}
                            <button
                                type="button"
                                onClick={() => startEditing(interview)}
                                disabled={isSaving}
                                style={{ marginTop: '6px' }}
                            >
                                Edit
                            </button>
                        </li>
                    ))}
                </ul>
            )}

            {error && (
                <p role="alert" style={{ color: '#dc2626', margin: '0 0 8px' }}>
                    {error}
                </p>
            )}
            {success && !isScheduling && !isEditing && (
                <p role="status" style={{ color: '#15803d', margin: '0 0 8px' }}>
                    {success}
                </p>
            )}

            {!isScheduling && !isEditing && !isLoading && (
                <button type="button" onClick={startScheduling}>
                    Schedule interview
                </button>
            )}

            {(isScheduling || isEditing) && (
                <form onSubmit={handleSubmit} style={{ marginTop: '10px' }}>
                    <p style={{ margin: '0 0 8px', fontWeight: 'bold' }}>
                        {isEditing ? 'Edit interview' : 'Schedule a new interview'}
                    </p>

                    <div style={{ marginBottom: '8px' }}>
                        <label htmlFor={`interview-type-${applicationId}`} style={{ display: 'block' }}>
                            <strong>Type:</strong>{' '}
                        </label>
                        <select
                            id={`interview-type-${applicationId}`}
                            value={form.type}
                            onChange={updateField('type')}
                            disabled={isSaving}
                        >
                            <option value="online">Online</option>
                            <option value="in_person">In person</option>
                        </select>
                    </div>

                    <div style={{ marginBottom: '8px' }}>
                        <label htmlFor={`interview-when-${applicationId}`} style={{ display: 'block' }}>
                            <strong>Date and time:</strong>{' '}
                        </label>
                        <input
                            id={`interview-when-${applicationId}`}
                            type="datetime-local"
                            value={form.scheduledAt}
                            onChange={updateField('scheduledAt')}
                            disabled={isSaving}
                            required
                        />
                    </div>

                    {form.type === 'online' ? (
                        <div style={{ marginBottom: '8px' }}>
                            <label htmlFor={`interview-link-${applicationId}`} style={{ display: 'block' }}>
                                <strong>Meeting link:</strong>{' '}
                            </label>
                            {/*
                            type="text" rather than type="url" on purpose. The service
                            validates this field with isValidOptionalText -- a non-empty
                            string -- so `type="url"` would add a stricter rule than the
                            API has and block submission with an opaque browser message
                            for input the server would have stored happily.
                        */}
                            <input
                                id={`interview-link-${applicationId}`}
                                type="text"
                                placeholder="https://..."
                                value={form.meetingLink}
                                onChange={updateField('meetingLink')}
                                disabled={isSaving}
                            />
                        </div>
                    ) : (
                        <div style={{ marginBottom: '8px' }}>
                            <label htmlFor={`interview-location-${applicationId}`} style={{ display: 'block' }}>
                                <strong>Location:</strong>{' '}
                            </label>
                            <input
                                id={`interview-location-${applicationId}`}
                                type="text"
                                placeholder="Office address or meeting point"
                                value={form.location}
                                onChange={updateField('location')}
                                disabled={isSaving}
                            />
                        </div>
                    )}

                    <div style={{ marginBottom: '8px' }}>
                        <label htmlFor={`interview-duration-${applicationId}`} style={{ display: 'block' }}>
                            <strong>Duration in minutes (optional):</strong>{' '}
                        </label>
                        <input
                            id={`interview-duration-${applicationId}`}
                            type="number"
                            min="1"
                            step="1"
                            value={form.duration}
                            onChange={updateField('duration')}
                            disabled={isSaving}
                        />
                    </div>

                    {isEditing && (
                        <div style={{ marginBottom: '8px' }}>
                            <label htmlFor={`interview-status-${applicationId}`} style={{ display: 'block' }}>
                                <strong>Status:</strong>{' '}
                            </label>
                            <select
                                id={`interview-status-${applicationId}`}
                                value={form.status || 'scheduled'}
                                onChange={updateField('status')}
                                disabled={isSaving}
                            >
                                {Object.entries(STATUS_LABEL).map(([value, label]) => (
                                    <option key={value} value={value}>{label}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    <button type="submit" disabled={isSaving}>
                        {isSaving ? 'Saving...' : (isEditing ? 'Save changes' : 'Schedule interview')}
                    </button>
                    {' '}
                    <button type="button" onClick={resetForm} disabled={isSaving}>
                        Cancel
                    </button>
                </form>
            )}
        </div>
    );
};

export default InterviewPanel;