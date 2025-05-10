import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';

const MyApplications = () => {
    const [applications, setApplications] = useState([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (user) {
                try {
                    const res = await axios.get(`http://localhost:3000/applications/employee/${user.uid}`);
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
            await axios.delete(`http://localhost:3000/applications/${applicationId}`);
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
                            <p><strong>Status:</strong> {app.status || 'No status available'}</p>
                            {app.employeePrice && (
                                <p><strong>Requested Price:</strong> ${app.employeePrice}</p>
                            )}

                            {app.status === 'Employed' && (
                                <div style={{ marginTop: '10px', backgroundColor: '#d4edda', padding: '10px', borderRadius: '5px', border: '1px solid #c3e6cb', color: '#155724' }}>
                                    <p>🎉 <strong>Congratulations!</strong> You've been hired for this job.</p>
                                    <a
                                        href="/employee/hired-jobs" // Change this path to wherever you want them to go
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
                                    </a>
                                </div>
                            )}
                            {app.status !== 'Employed' && (
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
