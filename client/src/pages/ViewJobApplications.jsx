import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import axios from 'axios';

const ViewJobApplications = () => {
    const { jobId, jobTitle } = useParams();
    const [applications, setApplications] = useState([]);

    useEffect(() => {
        const fetchApplications = async () => {
            try {
                const res = await axios.get(`http://localhost:3000/applications/job/${jobId}`);
                setApplications(res.data.applications || []);
            } catch (err) {
                console.error('Error fetching applications:', err);
            }
        };

        fetchApplications();
    }, [jobId]);

    const changeStatus = async (id, hiredApplicant) => {
        try {
            // 1. Update status for all applicants
            await Promise.all(
                applications.map(async (app) => {
                    await axios.put(`http://localhost:3000/applications/${app.id}/status`, {
                        status: app.id === hiredApplicant.id ? 'Employed' : 'Not Hired',
                    });
                })
            );

            // 2. Create a task for the hired applicant
            await axios.post('http://localhost:3000/tasks', {
                jobId,
                employeeId: hiredApplicant.employeeId,
                taskName: `Task for ${hiredApplicant.fullName}`,
                taskDescription: `Initial task for the hired employee: ${hiredApplicant.fullName}`,
                dueDate: new Date().toISOString(),
            });

            // 3. Change the job status to "Filled"
            await axios.put(`http://localhost:3000/jobs/${jobId}/status`, {
                status: 'Filled',
            });

            // 4. Update UI
            setApplications(applications.map(app =>
                app.id === hiredApplicant.id
                    ? { ...app, status: 'Employed' }
                    : { ...app, status: 'Not Hired' }
            ));

        } catch (err) {
            console.error('Error changing status or creating task:', err);
        }
    };

    return (
        <div style={{ padding: '20px' }}>
            <h2>Applications for Job "{jobTitle}"</h2>
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
                            <p><strong>Status:</strong> {app.status || 'Pending'}</p>
                            {app.employeePrice != null && (
                                <p><strong>Requested price:</strong> ₦{app.employeePrice}</p>
                            )}
                            <p><strong>Applied on:</strong> {new Date(app.dateApplied._seconds * 1000).toLocaleDateString()}</p>
                            <button
                                onClick={() => changeStatus(app.id, app)}
                                style={{ marginTop: '10px' }}
                                disabled={app.status === 'Employed'}
                            >
                                {app.status === 'Employed' ? 'Hired' : 'Hire'}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default ViewJobApplications;
