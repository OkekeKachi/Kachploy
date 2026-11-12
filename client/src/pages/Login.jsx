import React, { useState } from 'react';
import { auth, provider } from '../firebase';
import { useNavigate } from 'react-router-dom';
import { signInWithEmailAndPassword, sendPasswordResetEmail, signInWithPopup } from 'firebase/auth';
import Button from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';

/*
    STAGE 11.17b: presentation-only redesign onto the shared design system.

    This used to render its own full-page gradient background, white card, Kachploy
    logo and Log In / Sign Up tab row. That shared chrome now lives in AuthPage.jsx,
    so this component renders only the login form body and a small switch line -- the
    latter exists so the `setisSignup` prop AuthPage passes is still used, exactly as
    before.

    Behaviour is unchanged and deliberately so: signInWithEmailAndPassword is
    followed by user.reload() and the same emailVerified branch, signInWithPopup uses
    the same provider and branch, sendPasswordResetEmail keeps its empty-email guard,
    and every alert string is identical. The submit button is still NOT disabled while
    isLoading -- isLoading only swaps the label/opacity, as it did before. The
    "Remember me" checkbox is untouched and still holds no state.
*/
const Login = ({ setisSignup }) => {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const navigate = useNavigate();
    const [isLoading, setIsLoading] = useState(false);

    const handleLogin = async (e) => {
        e.preventDefault();
        setIsLoading(true);
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
        } finally {
            setIsLoading(false);
        }
    }

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
        <div>
            <form onSubmit={handleLogin} className="space-y-4">
                <Field id="email" label="Email">
                    <Input
                        id="email"
                        type="email"
                        name="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                    />
                </Field>

                <Field id="password" label="Password">
                    <Input
                        id="password"
                        type="password"
                        name="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                    />
                </Field>

                {/* Remember & Forgot */}
                <div className="flex items-center justify-between gap-3">
                    <label className="flex items-center gap-2 text-sm text-foreground-muted">
                        <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-border-strong text-accent focus:ring-accent"
                        />
                        <span>Remember me</span>
                    </label>
                    <button
                        type="button"
                        onClick={handleForgotPassword}
                        className="text-sm font-medium text-accent transition-colors hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                    >
                        Forgot Password?
                    </button>
                </div>

                <Button
                    type="submit"
                    size="lg"
                    className={`w-full ${isLoading ? 'cursor-not-allowed opacity-60' : ''}`}
                >
                    {isLoading ? 'Logging in…' : 'Log In'}
                </Button>
            </form>

            {/* Divider */}
            <div className="my-6 flex items-center">
                <div className="h-px flex-1 bg-border" />
                <span className="px-4 text-xs uppercase tracking-wide text-foreground-subtle">or</span>
                <div className="h-px flex-1 bg-border" />
            </div>

            {/* Google Sign In */}
            <Button
                variant="secondary"
                size="lg"
                className="w-full"
                onClick={handleGoogleSignIn}
            >
                <img src="/Google.png" alt="" aria-hidden="true" className="h-5 w-5 object-contain" />
                <span>Sign In with Google</span>
            </Button>

            <p className="mt-6 text-center text-sm text-foreground-muted">
                New to Kachploy?{' '}
                <button
                    type="button"
                    onClick={() => setisSignup(true)}
                    className="font-medium text-accent transition-colors hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                    Create an account
                </button>
            </p>
        </div>
    );
};

export default Login;
