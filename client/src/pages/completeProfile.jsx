import React, { useEffect, useState } from 'react';
import { auth } from '../firebase';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { storage } from '../firebase';
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";

const CompleteProfile = () => {
    const [role, setRole] = useState('');
    const [formData, setFormData] = useState({});
    const [loading, setLoading] = useState(true);
    const [profilePic, setProfilePic] = useState(null);
    const [uploading, setUploading] = useState(false);
    const navigate = useNavigate();

    useEffect(() => {
        const fetchRole = async () => {
            const user = auth.currentUser;
            console.log(user);

            if (!user) {
                navigate('/login');
                return;
            }

            try {
                const response = await axios.get(`http://localhost:3000/users/getUser/${user.uid}`);
                setRole(response.data.user.role);

                // Get data from both Auth and Firestore
                setFormData({
                    fullName: user.displayName || '', // Get from Auth user
                    phone: user.phoneNumber || '', // Get from Auth user
                });
                setLoading(false);
            } catch (error) {
                console.error('Error fetching role:', error);
                setLoading(false);
            }
        };

        fetchRole();
    }, [navigate]);

    const handleChange = (e) => {
        setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    };

    const handleFileChange = (e) => {
        setProfilePic(e.target.files[0]);
    };

    // Format phone number to E.164 format for Firebase Auth
    const formatPhoneNumber = (phone) => {
        // Remove any non-digit characters
        const digits = phone.replace(/\D/g, '');

        // Add country code if missing (assuming Nigeria +234)
        if (digits.length === 10) {
            return `+234${digits}`;
        } else if (digits.length === 11 && digits.startsWith('0')) {
            return `+234${digits.substring(1)}`;
        } else if (digits.length === 13 && digits.startsWith('234')) {
            return `+${digits}`;
        } else if (phone.startsWith('+')) {
            return phone; // Already formatted
        }

        return phone; // Return as-is if can't format
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        let imageUrl = '';
        const user = auth.currentUser;

        try {
            if (profilePic) {
                setUploading(true);
                const storageRef = ref(storage, `profilePics/${user.uid}`);
                await uploadBytes(storageRef, profilePic);
                imageUrl = await getDownloadURL(storageRef);
                setUploading(false);
            }

            const formattedSkills = formData.skills
                ? formData.skills.split(',').map(skill => skill.trim())
                : [];

            const payload = {
                ...formData,
                fullName: formData.fullName, // Will update Auth displayName
                phone: formatPhoneNumber(formData.phone), // Will update Auth phoneNumber
                profilePic: imageUrl, // Will update Auth photoURL
                profileComplete: true,
            };

            if (formattedSkills && formattedSkills.length > 0) {
                payload.skills = formattedSkills;
            }

            await axios.put(`http://localhost:3000/users/update/${user.uid}`, payload);
            alert('Profile completed successfully!');
            navigate('/dashboard');
        } catch (err) {
            console.error('Profile update failed:', err);
            alert('Error updating profile');
        }
    };

    if (loading) return <p>Loading...</p>;

    return (
        <div>
            <h2>Complete Your Profile ({role})</h2>
            <form onSubmit={handleSubmit}>
                {/* Common Fields */}
                <input
                    type="text"
                    name="fullName"
                    value={formData.fullName || ''}
                    placeholder="Full Name"
                    onChange={handleChange}
                    required
                />
                <input
                    type="tel"
                    name="phone"
                    value={formData.phone || ''}
                    placeholder="Phone Number (e.g. 08012345678)"
                    onChange={handleChange}
                    required
                />
                <input
                    type="text"
                    name="address"
                    placeholder="Address"
                    onChange={handleChange}
                    required
                />
                <input type="file" accept="image/*" onChange={handleFileChange} />

                {/* Employee-specific fields */}
                {role === 'employee' && (
                    <>
                        <input
                            type="text"
                            name="skills"
                            placeholder="Skills (e.g. Plumbing, Painting)"
                            onChange={handleChange}
                            required
                        />
                        <input
                            type="number"
                            name="yearsOfExperience"
                            placeholder="Years of Experience"
                            onChange={handleChange}
                            required
                        />
                        <input
                            type="text"
                            name="availability"
                            placeholder="Availability (e.g. Weekdays, Weekends)"
                            onChange={handleChange}
                            required
                        />
                    </>
                )}

                {/* Employer-specific fields */}
                {role === 'employer' && (
                    <>
                        <input
                            type="text"
                            name="companyName"
                            placeholder="Company/Organization Name"
                            onChange={handleChange}
                            required
                        />
                        <input
                            type="text"
                            name="jobTypes"
                            placeholder="Types of Jobs Available"
                            onChange={handleChange}
                            required
                        />
                        <input
                            type="text"
                            name="location"
                            placeholder="Job Location"
                            onChange={handleChange}
                            required
                        />
                    </>
                )}

                <button type="submit" disabled={uploading}>
                    {uploading ? 'Uploading...' : 'Submit'}
                </button>
            </form>
        </div>
    );
};

export default CompleteProfile;