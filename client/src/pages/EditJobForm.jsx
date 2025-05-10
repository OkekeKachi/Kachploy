import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import axios from 'axios';

const EditJobForm = () => {
    const navigate = useNavigate();
    const { jobId } = useParams();  // Get job ID from URL

    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [location, setLocation] = useState('');
    const [jobType, setJobType] = useState('');
    const [applicationDeadline, setApplicationDeadline] = useState('');
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [price, setPrice] = useState('');
    const [isNegotiable, setIsNegotiable] = useState(false);
    const [error, setError] = useState('');

    // Fetch the job data to pre-fill the form
    useEffect(() => {
        const fetchJobData = async () => {
            try {
                const response = await axios.get(`http://localhost:3000/jobs/${jobId}`);
                const job = response.data.job;
                setTitle(job.title);
                setDescription(job.description);
                setLocation(job.location);
                setJobType(job.jobType);
                setApplicationDeadline(job.applicationDeadline);
                setStartDate(job.startDate);
                setEndDate(job.endDate);
                setPrice(job.price);
                setIsNegotiable(job.isNegotiable);
            } catch (err) {
                console.error('Error fetching job data:', err);
                setError('Failed to fetch job details.');
            }
        };

        fetchJobData();
    }, [jobId]);

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!title || !description || !location || !jobType || !applicationDeadline || !startDate || !endDate || !price) {
            setError('All fields are required.');
            return;
        }

        const updatedJob = {
            title,
            description,
            location,
            jobType,
            applicationDeadline,
            startDate,
            endDate,
            price,
            isNegotiable
        };

        try {
            const response = await axios.put(`http://localhost:3000/jobs/edit/${jobId}`, updatedJob);
            if (response.status === 200) {
                alert('Job updated successfully');
                navigate('/dashboard');  // Redirect to dashboard
            }
        } catch (err) {
            console.error('Error updating job:', err);
            setError('Failed to update job. Please try again later.');
        }
    };

    return (
        <div className="container" style={{ padding: '20px' }}>
            <h1>Edit Job</h1>
            {error && <p style={{ color: 'red' }}>{error}</p>}
            <form onSubmit={handleSubmit}>
                <div>
                    <label>Job Title:</label>
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>Job Description:</label>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>Location:</label>
                    <input
                        type="text"
                        value={location}
                        onChange={(e) => setLocation(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>Job Type:</label>
                    <input
                        type="text"
                        value={jobType}
                        onChange={(e) => setJobType(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>Application Deadline:</label>
                    <input
                        type="date"
                        value={applicationDeadline}
                        onChange={(e) => setApplicationDeadline(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>Start Date:</label>
                    <input
                        type="date"
                        value={startDate}
                        onChange={(e) => setStartDate(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>End Date:</label>
                    <input
                        type="date"
                        value={endDate}
                        onChange={(e) => setEndDate(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>Price:</label>
                    <input
                        type="number"
                        value={price}
                        onChange={(e) => setPrice(e.target.value)}
                        required
                    />
                </div>
                <div>
                    <label>
                        <input
                            type="checkbox"
                            checked={isNegotiable}
                            onChange={(e) => setIsNegotiable(e.target.checked)}
                        />
                        Is Negotiable
                    </label>
                </div>
                <button type="submit">Update Job</button>
            </form>
        </div>
    );
};

export default EditJobForm;
