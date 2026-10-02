import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

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
const APP_STATUS_LABEL = {
    pending: 'Pending',
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
    }, [fetchApplications]);

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
                            <button
                                onClick={() => changeStatus(app)}
                                style={{ marginTop: '10px' }}
                                disabled={isHiring || canonicalAppStatus(app.status) === ACCEPTED}
                            >
                                {canonicalAppStatus(app.status) === ACCEPTED ? 'Hired' : 'Hire'}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default ViewJobApplications;
