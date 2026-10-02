import React, { useEffect, useState } from 'react';
import api from '../api';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';

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

const MyApplications = () => {
    const [applications, setApplications] = useState([]);
    const [loading, setLoading] = useState(true);

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
                    {applications.map(app => (
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
                    ))}
                </ul>
            )}
        </div>
    );
};

export default MyApplications;
