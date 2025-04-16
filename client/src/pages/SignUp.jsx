import React, { useState } from 'react';
import { auth } from '../firebase';
import {
    createUserWithEmailAndPassword,
    sendEmailVerification,
    signInWithPopup,
} from 'firebase/auth';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import { provider } from '../firebase';

const SignUp = () => {
    const [formData, setFormData] = useState({
        email: '',
        password: '',
        fullName: '',
        phone: '',
        role: '', // Role field added
    });

    const navigate = useNavigate();

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const handleSignUp = async (e) => {
        e.preventDefault();

        try {
            const { email, password, fullName, phone, role } = formData;

            // Ensure role is selected
            if (!role) {
                alert("❌ Please select your role.");
                return;
            }

            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // Send verification email
            await sendEmailVerification(user, {
                url: 'http://localhost:5173/verify-email',
            });

            alert("✅ Verification email sent. Please check your inbox.");

            // Save user details in localStorage
            localStorage.setItem("register_user", JSON.stringify({
                token: await user.getIdToken(),
                fullName,
                phone,
                role,
            }));

            navigate('/verify-email');

        } catch (err) {
            alert(`❌ ${err.message}`);
        }
    };

    const handleGoogleSignIn = async () => {
        const { role } = formData;

        // Ensure role is selected
        if (!role) {
            alert("❌ Please select your role before signing in with Google.");
            return;
        }

        try {
            // Perform Google sign-in
            const result = await signInWithPopup(auth, provider);
            const user = result.user;
            const idToken = await user.getIdToken();

            // Register the user with the selected role
            await axios.post('http://localhost:3000/users/register', {
                fullName: user.displayName,
                phone: '', // You can allow the user to update this later
                role,
            }, {
                headers: {
                    Authorization: `Bearer ${idToken}`,
                },
            });

            alert(`✅ Welcome ${user.displayName}`);
            navigate('/dashboard');

        } catch (err) {
            alert('❌ Google Sign-In failed: ' + err.message);
        }
    };

    return (
        <form onSubmit={handleSignUp}>
            <input
                name="email"
                value={formData.email}
                onChange={handleChange}
                placeholder="Email"
                required
            />
            <input
                name="password"
                type="password"
                value={formData.password}
                onChange={handleChange}
                placeholder="Password"
                required
            />
            <input
                name="fullName"
                value={formData.fullName}
                onChange={handleChange}
                placeholder="Full Name"
                required
            />
            <input
                name="phone"
                value={formData.phone}
                onChange={handleChange}
                placeholder="Phone Number"
                required
            />

            {/* Role Selection */}
            <div>
                <label>
                    <input
                        type="radio"
                        name="role"
                        value="employer"
                        checked={formData.role === 'employer'}
                        onChange={handleChange}
                        required
                    />
                    Employer
                </label>

                <label>
                    <input
                        type="radio"
                        name="role"
                        value="employee"
                        checked={formData.role === 'employee'}
                        onChange={handleChange}
                        required
                    />
                    Employee
                </label>
            </div>

            {/* Sign Up Button */}
            <button type="submit">Sign Up</button>
            <p>Already have an account?</p><p onClick={() => setisSignup(false)}>Login</p>
            <h1>or</h1>
            {/* Google Sign-In Button */}
            <button type="button" onClick={handleGoogleSignIn}>Continue with Google</button>
        </form>
    );
};

export default SignUp;
