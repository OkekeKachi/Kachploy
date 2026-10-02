import React, { useEffect, useState } from 'react';
import api from '../api';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { Link } from 'react-router-dom';
import EmployeeInterviews from '../components/EmployeeInterviews';

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
    [ACCEPTED]: 'Employed',
    rejected: 'Not Hired',
};

const appStatusLabel = (status) => APP_STATUS_LABEL[canonicalAppStatus(status)] || 'No status available';

// STAGE 7F: surface the server's own message when a request fails. `err.response`
// exists only for a real HTTP error, so a network drop or a thrown TypeError
// falls back to the caller's generic text instead of throwing again while
// reporting.
const readErrorMessage = (err, fallback) =>
    (err && err.response && err.response.data && err.response.data.message) || fallback;

// One slot per application: `{ loading, interviews, error }`. Kept in a map keyed
// by application id rather than an array so a fetch that resolves out of order
// cannot land on the wrong card, and so one failing application cannot take the
// others' lists with it.
const initialInterviewState = { loading: true, interviews: [], error: null };

const MyApplications = () => {
    const [applications, setApplications] = useState([]);
    const [loading, setLoading] = useState(true);
    const [interviewState, setInterviewState] = useState({});

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                try {
                    const res = await api.get(`/applications/employee/${user.uid}`);
                    setApplications(res.data.applications || []);
                } catch (err) {
                    console.error('Error fetching applications:', err);
                }
            }
            setLoading(false);
        });

        return () => unsubscribe(); // Clean up listener
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

        READ-ONLY: nothing in this effect writes. There is no accept, decline or
        reschedule call, matching the single-authority rule the Stage 7C routes
        document for writes.
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

    const handleWithdraw = async (applicationId) => {
        try {
            await api.delete(`/applications/${applicationId}`);
            setApplications(applications.filter(app => app.id !== applicationId)); // Remove withdrawn application from state
            alert('Application withdrawn successfully');
        } catch (err) {
            console.error('Error withdrawing application:', err);
            alert('Failed to withdraw application');
        }
    };

    if (loading) {
        return <p>Loading...</p>;
    }

    return (
        <div style={{ padding: '20px' }}>
            <h2>My Applications</h2>
            {applications.length === 0 ? (
                <p>You haven’t applied to any jobs yet.</p>
            ) : (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                    {applications.map(app => {
                        // No slot for this id yet means the read has not been issued,
                        // which has to look like loading rather than like "no
                        // interviews": an empty array is also what a finished read
                        // returns for an application that genuinely has none, and
                        // asserting that before the request went out would be a
                        // statement nobody has established.
                        const ivState = interviewState[app.id];
                        const ivLoading = !ivState || ivState.loading;

                        return (
                        <li
                            key={app.id}
                            style={{
                                border: '1px solid #ccc',
                                borderRadius: '10px',
                                marginBottom: '10px',
                                padding: '15px',
                            }}
                        >
                            <h4>{app.job?.title || 'Job removed'}</h4>
                            <p><strong>Location:</strong> {app.job?.location}</p>
                            <p><strong>Type:</strong> {app.job?.jobType}</p>
                            <p>
                                <strong>Applied on:</strong>{' '}
                                {app.dateApplied?._seconds
                                    ? new Date(app.dateApplied._seconds * 1000).toLocaleDateString()
                                    : 'Date not available'}
                            </p>
                            <p><strong>Message:</strong> {app.message || 'No message'}</p>
                            {/* Stage 5G: was `{app.status || 'No status available'}`,
                                which rendered the raw stored value -- an applicant
                                applying today saw lowercase `pending` in the list. */}
                            <p><strong>Status:</strong> {appStatusLabel(app.status)}</p>
                            {app.employeePrice && (
                                <p><strong>Requested Price:</strong> ${app.employeePrice}</p>
                            )}

                            {/*
                                STAGE 7F: read-only. Placed with the other application
                                details, above the hired/withdraw block, because it is
                                information about this application rather than an action
                                on it -- and because the withdraw button must not be
                                pushed below the fold by a growing interview list.
                            */}
                            <EmployeeInterviews
                                interviews={ivState ? ivState.interviews : []}
                                loading={ivLoading}
                                error={ivState ? ivState.error : null}
                            />

                            {canonicalAppStatus(app.status) === ACCEPTED && (
                                <div style={{ marginTop: '10px', backgroundColor: '#d4edda', padding: '10px', borderRadius: '5px', border: '1px solid #c3e6cb', color: '#155724' }}>
                                    <p>🎉 <strong>Congratulations!</strong> You've been hired for this job.</p>
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
                                        style={{
                                            display: 'inline-block',
                                            marginTop: '5px',
                                            textDecoration: 'none',
                                            backgroundColor: '#28a745',
                                            color: 'white',
                                            padding: '8px 12px',
                                            borderRadius: '4px',
                                        }}
                                    >
                                        View Your Hired Jobs
                                    </Link>
                                </div>
                            )}
                            {canonicalAppStatus(app.status) !== ACCEPTED && (
                                <button onClick={() => handleWithdraw(app.id)} style={{ marginTop: '10px' }}>
                                    Withdraw Application
                                </button>
                            )}
                        </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
};

export default MyApplications;
