import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import axios from 'axios';

const EmployerDashboard = () => {
    const [profilePic, setProfilePic] = useState(null);
    const [name, setName] = useState('');
    const [jobs, setJobs] = useState([]);
    const navigate = useNavigate();

    useEffect(() => {
        const fetchProfileAndJobs = async () => {
            const user = auth.currentUser;
            if (!user) {
                navigate('/login');
                return;
            }

            try {
                // Fetch user info
                const res = await axios.get(`http://localhost:3000/users/getUser/${user.uid}`);
                const userData = res.data.user;
                setProfilePic(userData.profilePic);
                setName(userData.fullName);

                if (!userData.profileComplete) {
                    navigate('/complete-profile');
                    return;
                }

                // Fetch posted jobs
                const jobsRes = await axios.get(`http://localhost:3000/jobs/employer/${user.uid}`);
                const jobList = jobsRes.data.jobs || [];

                // Add applicant count to each job
                const jobsWithApplicants = await Promise.all(
                    jobList.map(async (job) => {
                        try {
                            const appRes = await axios.get(`http://localhost:3000/applications/job/${job.id}`);
                            return {
                                ...job,
                                applicantCount: appRes.data.applications?.length || 0,
                            };
                        } catch (err) {
                            console.error(`Error fetching applications for job ${job.id}`, err);
                            return { ...job, applicantCount: 0 };
                        }
                    })
                );

                setJobs(jobsWithApplicants);
            } catch (err) {
                console.error('Error:', err);
            }
        };

        fetchProfileAndJobs();
    }, [navigate]);

    const handleDeleteJob = async (jobId) => {
        try {
            const response = await axios.delete(`http://localhost:3000/jobs/${jobId}`);
            if (response.status === 200) {
                setJobs(jobs.filter((job) => job.id !== jobId));
            } else {
                console.error('Failed to delete job');
            }
        } catch (err) {
            console.error('Error deleting job:', err);
        }
    };

    return (
        <div style={{ padding: '20px' }}>
            <h1>Employer Dashboard</h1>

            {profilePic && (
                <div style={{ width: '100px', height: '100px', overflow: 'hidden', borderRadius: '50%' }}>
                    <img
                        src={profilePic}
                        alt="Profile"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                </div>
            )}

            <h3>Welcome {name}</h3>
            <Link to="/post-job">Post a New Job</Link>

            <h4 style={{ marginTop: '30px' }}>Your Posted Jobs</h4>

            {jobs.length === 0 ? (
                <p>You haven't posted any jobs yet.</p>
            ) : (
                <ul style={{ listStyle: 'none', padding: 0 }}>
                    {jobs.map((job) => (
                        <li
                            key={job.id}
                            style={{
                                border: '1px solid #ccc',
                                borderRadius: '10px',
                                marginBottom: '10px',
                                padding: '15px',
                            }}
                        >
                            <h5>{job.title}</h5>
                            <p><strong>Location:</strong> {job.location}</p>
                            <p><strong>Type:</strong> {job.jobType}</p>
                            <p><strong>Posted:</strong> {new Date(job.createdAt).toLocaleDateString()}</p>
                            <p><strong>Price:</strong> ₦{job.price}</p>
                            <p><strong>Status:</strong> {job.status}</p>
                            <p><strong>Applicants:</strong> {job.applicantCount}</p>
                            <p>{job.description}</p>

                            <Link to={`/edit-job/${job.id}`}>
                                <button
                                    disabled={job.applicantCount > 0}
                                    style={{
                                        backgroundColor: job.applicantCount > 0 ? '#ccc' : '#007bff',
                                        color: 'white',
                                        border: 'none',
                                        padding: '5px 10px',
                                        borderRadius: '5px',
                                        marginRight: '5px',
                                        cursor: job.applicantCount > 0 ? 'not-allowed' : 'pointer',
                                    }}
                                >
                                    Edit
                                </button>
                            </Link>

                            <button
                                onClick={() => handleDeleteJob(job.id)}
                                disabled={job.applicantCount > 0}
                                style={{
                                    backgroundColor: job.applicantCount > 0 ? '#ccc' : 'red',
                                    color: 'white',
                                    border: 'none',
                                    padding: '5px 10px',
                                    borderRadius: '5px',
                                    marginRight: '5px',
                                    cursor: job.applicantCount > 0 ? 'not-allowed' : 'pointer',
                                }}
                            >
                                Delete Job
                            </button>

                            {job.status === 'open' ? (
                                <Link to={`/employer/jobs/${job.id}/applications/${job.title}`}>
                                    <button>View Applications</button>
                                </Link>
                            ) : (
                                <button disabled style={{ backgroundColor: '#ccc', color: '#666', padding: '5px 10px', borderRadius: '5px' }}>
                                    View Applications (Closed)
                                </button>
                            )}

                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};

export default EmployerDashboard;
