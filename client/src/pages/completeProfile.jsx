import React, { useState } from 'react';
import { auth } from '../firebase';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const CompleteProfile = () => {
    const [formData, setFormData] = useState({
        fullName: '',
        phone: '',
        location: '',
        serviceType: '',
        bio: ''
    });

    const [status, setStatus] = useState('');
    const navigate = useNavigate();

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setStatus('Submitting...');

        try {
            const user = auth.currentUser;
            if (!user) return setStatus('⚠️ Not logged in.');

            const token = await user.getIdToken();

            const res = await axios.post('http://localhost:3000/users/register-profile', formData, {
                headers: {
                    Authorization: `Bearer ${token}`
                }
            });

            setStatus('✅ Profile saved!');
            navigate('/dashboard');
        } catch (err) {
            setStatus(`❌ ${err.response?.data || err.message}`);
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            <h2>Complete Your Profile</h2>
            <input name="fullName" placeholder="Full Name" onChange={handleChange} required />
            <input name="phone" placeholder="Phone Number" onChange={handleChange} required />
            <input name="location" placeholder="Location" onChange={handleChange} required />
            <input name="serviceType" placeholder="Service Type (e.g. plumber)" onChange={handleChange} required />
            <textarea name="bio" placeholder="Short Bio" onChange={handleChange}></textarea>
            <button type="submit">Submit</button>
            <p>{status}</p>
        </form>
    );
};

export default CompleteProfile;
