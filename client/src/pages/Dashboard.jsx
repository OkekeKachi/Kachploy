import React, { useEffect, useState } from 'react';
import { auth } from '../firebase';
import { useNavigate } from 'react-router-dom';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import axios from 'axios';
const Dashboard = () => {
    const [userData, setUserData] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        const fetchUserData = async () => {
            const currentUser = auth.currentUser;
            if (!currentUser) return navigate('/login');
            const token = await currentUser.getIdToken();

            try {
                const res = await axios.get('http://localhost:3000/users/profile', {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                });

                setUserData(res.data);
            } catch (err) {
                console.error("Failed to fetch user from backend", err.message);
                navigate('/login');
            }
        };

        fetchUserData();
    }, []);


    return (
        <div>
            <h1>Welcome to your Dashboard</h1>
            {userData && (
                <>
                    <p>Full Name: {userData.fullName}</p>
                    <p>Email: {userData.email}</p>
                    <p>Phone: {userData.phone || 'Not provided'}</p>
                </>
            )}

            <button onClick={() => auth.signOut().then(() => navigate('/login'))}>
                Logout
            </button>
            <button onClick={() => navigate('/complete-profile')}>
                Complete Profile
            </button>
        </div>
    );
};

export default Dashboard;
