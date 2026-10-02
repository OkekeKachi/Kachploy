import React, { useEffect, useState } from 'react';
import { auth } from '../firebase';
import { sendEmailVerification, onAuthStateChanged, reload } from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
import api from '../api';

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
                    // STAGE 5I-2: this branch used to navigate and then fall
                    // through, because the `return` was missing -- a commented-out
                    // `if (!data) return;` sat above it, so the intent was recorded
                    // but never executed. `data` is null at this point, so falling
                    // through threw a TypeError on `data.fullName` inside the try
                    // below; the inner catch swallowed it to the console, so the
                    // registration was silently never sent and the account was left
                    // in Auth with no users/{uid} document. Returning here exits the
                    // interval callback, so neither the dereference nor the POST can
                    // run without the staged data.
                    if (!data) {
                        navigate("/login");
                        return;
                    }
                    try {
                        // The shared instance attaches the caller's ID token,
                        // so no manual Authorization header is needed here.
                        await api.post('/users/register', {
                            fullName: data.fullName,
                            phone: data.phone,
                            role: data.role,
                            profileComplete: data.profileComplete
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
        }, 3000); // Check every 3 seconds
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
        <div className="flex justify-center items-center h-screen p-5 bg-white font-sans">
            <div className="bg-white p-8 md:p-10 rounded-xl text-center shadow-lg w-full max-w-sm">
                {/* Logo Container */}
                <div className="flex justify-center items-center mb-5">
                    <img
                        src="./image.png"
                        alt="Logo"
                        className="w-5 mr-2 md:w-7"
                    />
                    <span className="text-xl font-medium text-gray-800 antialiased md:text-2xl">
                        KachPloy
                    </span>
                </div>

                {/* Title */}
                <h5 className="text-xl font-medium text-gray-800 mb-4 antialiased md:text-2xl">
                    Verify Your Email
                </h5>

                {/* Description */}
                <p className="text-gray-600 mb-5 font-light antialiased">
                    Please verify your email address:{' '}
                    <span className="font-medium text-blue-700">
                        {user?.email}
                    </span>
                </p>

                {/* Resend Button */}
                <button
                    className="w-full bg-blue-700 hover:bg-blue-800 text-white font-normal py-3 px-4 rounded-lg mt-5 transition-colors antialiased"
                    onClick={resendVerification}
                >
                    Resend Verification Link
                </button>

                {/* Status Message */}
                {status && (
                    <p className="text-sm text-blue-700 mt-4 font-light antialiased">
                        {status}
                    </p>
                )}
            </div>
        </div>
    );
};

export default VerifyEmail;