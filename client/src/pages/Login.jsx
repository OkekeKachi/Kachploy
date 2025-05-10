import React, { useState } from 'react';
import { auth, provider } from '../firebase'; // Ensure googleProvider is imported
import { useNavigate } from 'react-router-dom';
import { signInWithEmailAndPassword, sendPasswordResetEmail, signInWithPopup } from 'firebase/auth';
import '../css/login.css';

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
        <div className="container center-align login-container">
            <div className="logo-container">
                <img src="./image.png" alt="Logo" className="logo" />
                <span className="logo-text">KachPloy</span>
            </div>
            <h5><strong style={{ fontWeight: "900" }} >Get Started now</strong></h5>
            <p>Create an account or log in to hire and get hired</p>

            <div className="tab-buttons">
                {/* <button className="btn-flat active-tab" >Log In</button> */}
                <button className="btn-flat active-tab" onClick={() => setisSignup(false)}>Log In</button>
                <button className="btn-flat " onClick={() => setisSignup(true)}>Sign Up</button>
            </div>

            <form onSubmit={handleLogin} className="login-form">
                <div className="input-field">
                    <input
                        type="email"
                        id="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                    />
                    <label htmlFor="email">Email</label>
                </div>

                <div className="input-field">
                    <input
                        type="password"
                        id="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                    />
                    <label htmlFor="password">Password</label>
                </div>

                <div className="remember-forgot">
                    <label>
                        <input type="checkbox" />
                        <span>Remember me</span>
                    </label>
                    <span className="forgot-link" onClick={handleForgotPassword}>Forgot Password?</span>
                </div>

                <button type="submit" className="btn blue darken-1 login-btn">Log In</button>
            </form>

            <div className="divider"></div>
            <p style={{display: 'inline-block'}}>OR</p><div className="divider"></div>
            <button className="btn google-sign-in" onClick={handleGoogleSignIn}>
                <img src="./Google.png" style={{width:"40px"}}/>
                Sign In with Google
            </button>
        </div>
    );
};

export default Login;

