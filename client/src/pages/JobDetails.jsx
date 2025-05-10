import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { auth } from '../firebase';
import axios from 'axios';

const JobDetails = () => {
    const { jobId } = useParams();

    const [job, setJob] = useState(null);
    const [user, setUser] = useState(null);
    const [message, setMessage] = useState('');
    const [applied, setApplied] = useState(false);
    const [employeePrice, setEmployeePrice] = useState('');  // Store employee price

    React.useEffect(() => {
        const fetchJobAndUser = async () => {
            const res = await axios.get(`http://localhost:3000/jobs/${jobId}`);
            const dbUser = await axios.get(`http://localhost:3000/users/getUser/${auth.currentUser.uid}`);
            setJob(res.data.job);
            setUser(dbUser);
        };
        fetchJobAndUser();
    }, [jobId]);

    const handleApply = async () => {
        if (!user) {
            alert('You must be logged in to apply');
            return;
        }

        try {
            // Post application with the employee's price if job is negotiable
            await axios.post('http://localhost:3000/applications/apply', {
                jobId,
                proposal: job.proposals,
                employeeId: auth.currentUser.uid,
                fullName: user.data.user.fullName || 'Anonymous',
                message,                
                employeePrice: job.isNegotiable ? employeePrice : null,  // Only send employeePrice if negotiable
                status: "pending"
            });
            setApplied(true);
        } catch (err) {
            console.error('Application failed', err);
        }
    };

    if (!job) return <p>Loading...</p>;

    return (
        <div style={{ padding: '20px' }}>
            <h2>{job.title}</h2>
            <p><strong>Location:</strong> {job.location}</p>
            <p><strong>Type:</strong> {job.jobType}</p>
            <p>{job.description}</p>
            <p><strong>Price: </strong>₦{job.price}</p>
            {/* If the job is negotiable, request the employee's price */}
            {job.isNegotiable ? (
                <div>
                    <label>
                        <strong>Request Your Price:</strong>
                        <input
                            type="number"
                            value={employeePrice}
                            onChange={e => setEmployeePrice(e.target.value)}
                            placeholder="Enter your price"
                            min="0"
                            required
                        />
                    </label>
                </div>
            ) : (
                <p><strong>This job has a fixed price. Negotiation is not allowed.</strong></p>
            )}

            {applied ? (
                <p style={{ color: 'green' }}>✅ Application submitted!</p>
            ) : (
                <div style={{ marginTop: '20px' }}>
                    <textarea
                        placeholder="Write a short message"
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        rows="4"
                        cols="50"
                    />
                    <br />
                    <button onClick={handleApply} style={{ marginTop: '10px' }}>Apply</button>
                </div>
            )}
        </div>
    );
};

export default JobDetails;
