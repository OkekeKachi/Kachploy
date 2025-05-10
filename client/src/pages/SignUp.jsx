import React, { useState } from 'react';
import { auth } from '../firebase';
import {
    createUserWithEmailAndPassword,
    sendEmailVerification,
    // signInWithPopup, // commented out
} from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
// import { provider } from '../firebase'; // commented out
import '../css/login.css'; // Reuse login styles for consistent UI

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

    // const handleGoogleSignIn = async () => {
    //     const { role } = formData;
    //     if (!role) {
    //         alert("❌ Please select your role before signing in with Google.");
    //         return;
    //     }

    //     try {
    //         const result = await signInWithPopup(auth, provider);
    //         const user = result.user;
    //         const idToken = await user.getIdToken();

    //         await axios.post('http://localhost:3000/users/register', {
    //             fullName: user.displayName,
    //             phone: '',
    //             role,
    //             profileComplete: false
    //         }, {
    //             headers: {
    //                 Authorization: `Bearer ${idToken}`,
    //             },
    //         });

    //         alert(`✅ Welcome ${user.displayName}`);
    //         navigate("/dashboard");

    //     } catch (err) {
    //         alert('❌ Google Sign-In failed: ' + err.message);
    //     }
    // };

    return (
        <div className="container center-align login-container">
            <div className="logo-container">
                <img src="./image.png" alt="Logo" className="logo" />
                <span className="logo-text">KachPloy</span>
            </div>
            <h5><strong style={{ fontWeight: "900" }} >Create an account</strong></h5>
            <p>Sign up to explore the find jobs or hire employees</p>

            <div className="tab-buttons">
                <button className="btn-flat" onClick={() => setisSignup(false)}>Log In</button>
                <button className="btn-flat active-tab" onClick={() => setisSignup(true)}>Sign Up</button>
            </div>

            <form onSubmit={handleSignUp} className="login-form">
                <div className="input-field">
                    <input
                        name="fullName"
                        value={formData.fullName}
                        onChange={handleChange}
                        type="text"
                        required
                    />
                    <label htmlFor="fullName">Full Name</label>
                </div>

                <div className="input-field">
                    <input
                        name="phone"
                        value={formData.phone}
                        onChange={handleChange}
                        type="text"
                        required
                    />
                    <label htmlFor="phone">Phone Number</label>
                </div>

                <div className="input-field">
                    <input
                        name="email"
                        value={formData.email}
                        onChange={handleChange}
                        type="email"
                        required
                    />
                    <label htmlFor="email">Email</label>
                </div>

                <div className="input-field">
                    <input
                        name="password"
                        value={formData.password}
                        onChange={handleChange}
                        type="password"
                        required
                    />
                    <label htmlFor="password">Password</label>
                </div>

                <div className="input-field">
                    <select
                        name="role"
                        value={formData.role}
                        onChange={handleChange}
                        className="browser-default"
                        required
                    >
                        <option value="">Select Role</option>
                        <option value="employee">Employee</option>
                        <option value="employer">Employer</option>
                    </select>
                </div>

                <button type="submit" className="btn blue darken-1 login-btn">Sign Up</button>
                
            </form>

            {/* <div className="divider"></div>
            <p style={{ display: 'inline-block' }}>OR</p>
            <div className="divider"></div>
            <button className="btn google-sign-in" onClick={handleGoogleSignIn}>
                <img src="./Google.png" style={{ width: "40px" }} />
                Sign Up with Google
            </button> */}
        </div>
    );
};

export default SignUp;
