import React, { useState } from 'react';
import { auth } from '../firebase';
import {
    createUserWithEmailAndPassword,
    sendEmailVerification,
} from 'firebase/auth';
import { useNavigate } from 'react-router-dom';

const SignUp = ({ setisSignup }) => {
    const [formData, setFormData] = useState({
        email: '',
        password: '',
        fullName: '',
        phone: '',
        role: '',
        profileComplete: false
    });

    const navigate = useNavigate();

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSignUp = async (e) => {
        e.preventDefault();
        try {
            const { email, password, fullName, phone, role, profileComplete } = formData;

            if (!role) {
                alert("❌ Please select your role.");
                return;
            }

            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            await sendEmailVerification(user, {
                url: 'http://localhost:5173/verify-email',
            });

            alert("✅ Verification email sent. Please check your inbox.");

            localStorage.setItem("register_user", JSON.stringify({
                token: await user.getIdToken(),
                fullName,
                phone,
                role,
                profileComplete,
            }));

            navigate('/verify-email');
        } catch (err) {
            alert(`❌ ${err.message}`);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center p-5 bg-gradient-to-l from-gray-100 to-white">
            <div className="w-full max-w-md bg-white p-6 md:p-8 lg:p-10 rounded-xl shadow-lg text-center mt-0 md:mt-15 lg:max-w-lg lg:mx-auto">
                {/* Logo Section */}
                <div className="flex items-center justify-center mb-6">
                    <img src="./image.png" alt="Logo" className="w-5 md:w-6 mr-2" />
                    <span className="text-lg md:text-xl font-bold text-gray-800">KachPloy</span>
                </div>

                {/* Header */}
                <h5 className="text-xl md:text-2xl font-black mb-2">Create an account</h5>
                <p className="text-sm text-gray-600 mb-5">Sign up to explore the find jobs or hire employees</p>

                {/* Tab Buttons */}
                <div className="flex justify-around mx-5 mb-6 p-2 bg-gray-100 rounded-2xl">
                    <button
                        className="text-xs md:text-sm font-bold px-5 md:px-12 py-2 text-gray-600 hover:bg-gray-50 rounded-xl transition-colors"
                        onClick={() => setisSignup(false)}
                    >
                        Log In
                    </button>
                    <button
                        className="text-xs md:text-sm font-bold px-5 md:px-12 py-2 bg-white rounded-xl shadow-sm"
                        onClick={() => setisSignup(true)}
                    >
                        Sign Up
                    </button>
                </div>

                {/* Sign Up Form */}
                <form onSubmit={handleSignUp} className="space-y-4">
                    <div className="relative">
                        <input
                            name="fullName"
                            value={formData.fullName}
                            onChange={handleChange}
                            type="text"
                            required
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent peer"
                            placeholder=" "
                        />
                        <label
                            htmlFor="fullName"
                            className="absolute left-4 top-3 text-gray-500 transition-all duration-200 peer-placeholder-shown:top-3 peer-placeholder-shown:text-base peer-focus:-top-2 peer-focus:left-2 peer-focus:text-xs peer-focus:text-blue-500 peer-focus:bg-white peer-focus:px-1 peer-valid:-top-2 peer-valid:left-2 peer-valid:text-xs peer-valid:text-blue-500 peer-valid:bg-white peer-valid:px-1"
                        >
                            Full Name
                        </label>
                    </div>

                    <div className="relative">
                        <input
                            name="phone"
                            value={formData.phone}
                            onChange={handleChange}
                            type="tel"
                            required
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent peer"
                            placeholder=" "
                        />
                        <label
                            htmlFor="phone"
                            className="absolute left-4 top-3 text-gray-500 transition-all duration-200 peer-placeholder-shown:top-3 peer-placeholder-shown:text-base peer-focus:-top-2 peer-focus:left-2 peer-focus:text-xs peer-focus:text-blue-500 peer-focus:bg-white peer-focus:px-1 peer-valid:-top-2 peer-valid:left-2 peer-valid:text-xs peer-valid:text-blue-500 peer-valid:bg-white peer-valid:px-1"
                        >
                            Phone Number
                        </label>
                    </div>

                    <div className="relative">
                        <input
                            name="email"
                            value={formData.email}
                            onChange={handleChange}
                            type="email"
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
                            name="password"
                            value={formData.password}
                            onChange={handleChange}
                            type="password"
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

                    <div className="relative">
                        <select
                            name="role"
                            value={formData.role}
                            onChange={handleChange}
                            required
                            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent appearance-none bg-white cursor-pointer"
                        >
                            <option value="" disabled className="text-gray-400">Select Role</option>
                            <option value="employee" className="text-gray-900">Employee</option>
                            <option value="employer" className="text-gray-900">Employer</option>
                        </select>
                        {/* Custom dropdown arrow */}
                        <div className="absolute inset-y-0 right-0 flex items-center px-2 pointer-events-none">
                            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path>
                            </svg>
                        </div>
                    </div>

                    <button
                        type="submit"
                        className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 rounded-lg transition-colors duration-200 mt-6"
                    >
                        Sign Up
                    </button>
                </form>
            </div>
        </div>
    );
};

export default SignUp;