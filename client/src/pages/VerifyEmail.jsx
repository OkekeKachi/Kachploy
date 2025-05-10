import React, { useEffect, useState } from 'react';
import { auth } from '../firebase';
import { sendEmailVerification, onAuthStateChanged, reload } from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import '../css/verify-email.css';  // Import the styles

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
                    // if (!data) return;
                    if (!data){navigate("/login")};

                    try {
                        await axios.post('http://localhost:3000/users/register', {
                            fullName: data.fullName,
                            phone: data.phone,
                            role: data.role,
                            profileComplete: data.profileComplete
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
        }, 3000); // Check every 7 seconds

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
        <div className="verify-container">
            <div className="verify-card">
                <div className="logo-container">
                    <img src="./image.png" alt="Logo" className="logo" />
                    <span className="logo-text">KachPloy</span>
                </div>
                <h5><strong>Verify Your Email</strong></h5>
                <p>Please verify your email address: <span className="email-text">{user?.email}</span></p>
                <button className="btn blue darken-1 resend-btn" onClick={resendVerification}>Resend Verification Link</button>
                {status && <p className="status-text">{status}</p>}
            </div>
        </div>
    );
};

export default VerifyEmail;
