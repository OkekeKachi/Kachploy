import React, { useState } from 'react';
import { auth, provider } from '../firebase';
import { useNavigate } from 'react-router-dom';
import { signInWithEmailAndPassword, sendPasswordResetEmail, signInWithPopup } from 'firebase/auth';

const Login = ({ setisSignup }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const navigate = useNavigate();

    const handleLogin = async (e) => {
        e.preventDefault();
        try {
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;
            await user.reload();
            if (user.emailVerified) {
                navigate('/dashboard');
            } else {
                navigate('/verify-email');
            }
        } catch (err) {
            alert('Login failed: ' + err.message);
        }
    };

    const handleForgotPassword = async () => {
        if (!email) {
            alert('Enter your email to reset password.');
            return;
        }
        try {
            await sendPasswordResetEmail(auth, email);
            alert('🔐 Password reset link sent to your email.');
        } catch (err) {
            alert('Reset failed: ' + err.message);
        }
    };

    const handleGoogleSignIn = async () => {
        try {
            const result = await signInWithPopup(auth, provider);
            const user = result.user;
            if (user.emailVerified) {
                navigate('/dashboard');
            } else {
                navigate('/verify-email');
            }
        } catch (err) {
            alert('Google sign-in failed: ' + err.message);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-5 bg-gradient-to-l from-gray-100 to-white">
            <div className="w-full max-w-md bg-white p-4 md:p-8 lg:p-10 rounded-xl shadow-lg text-center mt-0 md:mt-15 lg:max-w-lg lg:mx-auto">
                {/* Logo Section */}
                <div className="flex items-center justify-center mb-6">
                    <img src="./image.png" alt="Logo" className="w-5 md:w-6 mr-2" />
                    <span className="text-lg md:text-xl font-bold text-gray-800">KachPloy</span>
                </div>

                {/* Header */}
                <h5 className="text-xl md:text-2xl font-black mb-2">Get Started now</h5>
                <p className="text-sm text-gray-600 mb-5">Create an account or log in to hire and get hired</p>

                {/* Tab Buttons */}
                <div className="flex justify-around mx-5 mb-6 p-2 bg-gray-100 rounded-2xl">
                    <button
                        className="text-xs md:text-sm font-bold px-5 md:px-12 py-2 bg-white rounded-xl shadow-sm"
                        onClick={() => setisSignup(false)}
                    >
                        Log In
                    </button>
                    <button
                        className="text-xs md:text-sm font-bold px-5 md:px-12 py-2 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors"
                        onClick={() => setisSignup(true)}
                    >
                        Sign Up
                    </button>
                </div>

                {/* Login Form */}
                <form onSubmit={handleLogin} className="space-y-4">
                    <div className="relative">
                        <input
                            type="email"
                            id="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            required
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent peer"
                            placeholder=" "
                        />
                        <label
                            htmlFor="email"
                            className="absolute left-4 top-3 text-gray-500 transition-all duration-200 peer-placeholder-shown:top-3 peer-placeholder-shown:text-base peer-focus:-top-2 peer-focus:left-2 peer-focus:text-xs peer-focus:text-blue-500 peer-focus:bg-white peer-focus:px-1 peer-valid:-top-2 peer-valid:left-2 peer-valid:text-xs peer-valid:text-blue-500 peer-valid:bg-white peer-valid:px-1"
                        >
                            Email
                        </label>
                    </div>

                    <div className="relative">
                        <input
                            type="password"
                            id="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent peer"
                            placeholder=" "
                        />
                        <label
                            htmlFor="password"
                            className="absolute left-4 top-3 text-gray-500 transition-all duration-200 peer-placeholder-shown:top-3 peer-placeholder-shown:text-base peer-focus:-top-2 peer-focus:left-2 peer-focus:text-xs peer-focus:text-blue-500 peer-focus:bg-white peer-focus:px-1 peer-valid:-top-2 peer-valid:left-2 peer-valid:text-xs peer-valid:text-blue-500 peer-valid:bg-white peer-valid:px-1"
                        >
                            Password
                        </label>
                    </div>

                    {/* Remember & Forgot */}
                    <div className="flex justify-between items-center my-4">
                        <label className="flex items-center text-xs">
                            <input type="checkbox" className="mr-2 rounded" />
                            <span>Remember me</span>
                        </label>
                        <span
                            className="text-xs text-blue-600 cursor-pointer hover:text-blue-800 transition-colors"
                            onClick={handleForgotPassword}
                        >
                            Forgot Password?
                        </span>
                    </div>

                    <button
                        type="submit"
                        className="w-full bg-blue-500 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg transition-colors duration-200"
                    >
                        Log In
                    </button>
                </form>

                {/* Divider */}
                <div className="flex items-center my-6">
                    <div className="flex-1 border-t border-gray-300"></div>
                    <span className="px-4 text-sm text-gray-500">OR</span>
                    <div className="flex-1 border-t border-gray-300"></div>
                </div>

                {/* Google Sign In */}
                <button
                    className="w-full bg-gray-100 hover:bg-green-300 text-black font-bold text-xs md:text-sm py-3 rounded-lg transition-colors duration-200 flex items-center justify-center space-x-2 mb-5"
                    onClick={handleGoogleSignIn}
                >
                    <img src="./Google.png" className="w-8 h-5" alt="Google" />
                    <span>Sign In with Google</span>
                </button>
            </div>
        </div>
    );
};

export default Login;