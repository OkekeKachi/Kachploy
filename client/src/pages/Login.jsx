import React, { useState } from 'react';
import { auth} from '../firebase';
import { useNavigate } from 'react-router-dom';
import {
    signInWithEmailAndPassword,
    sendPasswordResetEmail,
} from 'firebase/auth'
import axios from 'axios';

const Login = () => {
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


    return (
        <div>
            <form onSubmit={handleLogin}>
                <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                />
                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                />
                <button type="submit">Login</button>
            </form>


            
           

            <p>
                ❓Forgot password?{' '}
                <button onClick={handleForgotPassword}>Reset it</button>
                
            </p>
        </div>
    );
};

export default Login;
