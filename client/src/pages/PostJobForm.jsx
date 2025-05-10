import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import skillSuggestions from '../data/skills'; // 👈 import skill list

const PostJobForm = () => {
    const [formData, setFormData] = useState({
        title: '',
        description: '',
        location: '',
        jobType: '',
        applicationDeadline: '',
        jobStartDate: '',
        expectedEndDate: '',
        
        price: '',
        negotiable: 'no',
        skillsRequired: [],
    });

    const [skillInput, setSkillInput] = useState('');
    const navigate = useNavigate();

    const handleChange = (e) => {
        setFormData(prev => ({
            ...prev,
            [e.target.name]: e.target.value,
        }));
    };

    const handleSkillInput = (e) => {
        setSkillInput(e.target.value);
    };

    const addSkill = (skill) => {
        if (!formData.skillsRequired.includes(skill)) {
            setFormData(prev => ({
                ...prev,
                skillsRequired: [...prev.skillsRequired, skill],
            }));
        }
        setSkillInput('');
    };

    const removeSkill = (skill) => {
        setFormData(prev => ({
            ...prev,
            skillsRequired: prev.skillsRequired.filter(s => s !== skill),
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        const user = auth.currentUser;
        if (!user) return alert('You must be logged in');

        try {
            await axios.post('http://localhost:3000/jobs/create', {
                ...formData,
                postedBy: user.uid,
            });

            alert('Job posted successfully!');
            navigate("/dashboard");
        } catch (err) {
            console.error('Error posting job:', err);
            alert('Failed to post job');
        }
    };

    const filteredSuggestions = skillInput.length > 0
        ? skillSuggestions.filter(s =>
            s.toLowerCase().includes(skillInput.toLowerCase()) &&
            !formData.skillsRequired.includes(s)
        )
        : [];

    return (
        <div>
            <h2>Post a Job</h2>
            <form onSubmit={handleSubmit}>
                <input name="title" placeholder="Job Title" onChange={handleChange} value={formData.title} required /> <br/><br/>
                <textarea name="description" placeholder="Job Description" onChange={handleChange} value={formData.description} required /> <br/><br/>
                <input name="location" placeholder="Location" onChange={handleChange} value={formData.location} required /> <br/><br/>
                <input name="jobType" placeholder="Job Type (e.g. Full-time)" onChange={handleChange} value={formData.jobType} required /> <br/><br/>
                <label htmlFor="applicationDeadline">Application Deadline: </label>
                <input name="applicationDeadline" type="date" onChange={handleChange} value={formData.applicationDeadline} required /> <br/><br/>
                <label htmlFor="jobsStartDate">Start Date: </label>
                <input name="jobStartDate" type="date" onChange={handleChange} value={formData.jobStartDate} required /> <br/><br/>
                <label htmlFor="expectedEndDate">Expected End Date: </label>
                <input name="expectedEndDate" type="date" onChange={handleChange} value={formData.expectedEndDate} /> <br/><br/>
                <input name="price" type="number" placeholder="Fixed Price" onChange={handleChange} value={formData.price} required /> <br/><br/>

                <select name="negotiable" onChange={handleChange} value={formData.negotiable}>
                    <option value="no">Price Not Negotiable</option>
                    <option value="yes">Negotiable</option>
                </select>
                <br /><br />
                {/* Skills Section */}
                <div>
                    <input
                        type="text"
                        placeholder="Enter a skill"
                        value={skillInput}
                        onChange={handleSkillInput}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                if (skillInput.trim()) addSkill(skillInput.trim());
                            }
                        }}
                    /> <br/><br/>
                    {filteredSuggestions.length > 0 && (
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0, border: '1px solid #ccc' }}>
                            {filteredSuggestions.map(skill => (
                                <li
                                    key={skill}
                                    onClick={() => addSkill(skill)}
                                    style={{ padding: '5px', margin:"2px", cursor: 'pointer', display: "inline-block", border: "1px blue solid" }}
                                >
                                    {skill}
                                </li>
                            ))}
                        </ul>
                    )}
                    <div style={{ marginTop: '10px' }}>
                        {formData.skillsRequired.map(skill => (
                            <span
                                key={skill}
                                style={{
                                    display: 'inline-block',
                                    background: '#eee',
                                    padding: '5px 10px',
                                    margin: '5px',
                                    borderRadius: '20px',
                                }}
                            >
                                {skill}
                                <button onClick={() => removeSkill(skill)} style={{ marginLeft: '5px' }}>x</button>
                            </span>
                        ))}
                    </div>
                </div>

                <button type="submit">Post Job</button>
            </form>
        </div>
    );
};

export default PostJobForm;
