import React, { useEffect, useState } from 'react';
import { auth } from '../firebase';
import { sendEmailVerification, onAuthStateChanged, reload } from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

const VerifyEmail = () => {
    const [user, setUser] = useState(null);
    const [status, setStatus] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (usr) => {
            if (usr) {
                await reload(usr); // Ensure fresh emailVerified status
                setUser(usr);
            }
        });

        return () => unsubscribe();
    }, []);

    useEffect(() => {
        const interval = setInterval(async () => {
            if (auth.currentUser) {
                await auth.currentUser.getIdToken(true); // force token refresh
                await reload(auth.currentUser);
                if (auth.currentUser.emailVerified) {

                    const data = JSON.parse(localStorage.getItem('register_user'));
                    console.log(data);
                    if (!data) return;

                    try {
                        await axios.post('http://localhost:3000/users/register', {
                            fullName: data.fullName,
                            phone: data.phone,
                            role: data.role
                        }, {
                            headers: {
                                Authorization: `Bearer ${data.token}`,
                            },
                        });

                        console.log("✅ User registered to backend");
                        
                        
                        navigate('/dashboard');

                        // Clear after successful registration
                        localStorage.removeItem("register_user");
                    } catch (err) {
                        console.error("❌ Backend registration failed", err.message);
                    }

                    
                }
            }
        }, 7000); // Check every second

        return () => clearInterval(interval);
    }, [navigate]);

    const resendVerification = async () => {
        if (!user) return setStatus('⚠️ Not logged in.');
        if (user.emailVerified) return setStatus('✅ Already verified.');

        try {
            await sendEmailVerification(user, {
                url: 'http://localhost:5173/dashboard', // Or your deployed URL
            });
            setStatus('📧 Verification email sent!');
        } catch (err) {
            setStatus(`❌ ${err.message}`);
        }
    };

    return (
        <div>
            <h2>Please verify your email</h2>
            <p>{user?.email}</p>
            <button onClick={resendVerification}>Resend Verification Link</button>
            {status && <p>{status}</p>}
        </div>
    );
};

export default VerifyEmail;
