import React, { useEffect, useState } from 'react';
import { auth } from '../firebase';
import { sendEmailVerification, onAuthStateChanged, reload } from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import Spinner from '../components/ui/Spinner';

/*
    STAGE 11.17c: presentation-only redesign onto the shared design system
    (Card, Button, Spinner, design tokens), matching the redesigned auth pages.

    Nothing about the verification flow changes. The `onAuthStateChanged` effect and
    its unsubscribe cleanup, the 3-second polling effect and its clearInterval
    cleanup, the getIdToken(true) -> reload() ordering, the
    `localStorage.register_user` contract and its null guard (which redirects to
    /login), the exact POST /users/register payload, the console.log/console.error
    calls, the navigate('/dashboard') completion, and the resend operation with its
    'http://localhost:5173/dashboard' URL are all copied through unchanged.

    The only functional addition is a local `isResending` flag that lets the resend
    button show a spinner and disable itself while the request is in flight; the
    request itself, its guard messages and its status strings are untouched.
*/
const VerifyEmail = () => {
    const [user, setUser] = useState(null);
    const [status, setStatus] = useState('');
    const [isResending, setIsResending] = useState(false);
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
        setIsResending(true);
        try {
            await sendEmailVerification(user, {
                url: 'http://localhost:5173/dashboard', // Or your deployed URL
            });
            setStatus('📧 Verification email sent!');
        } catch (err) {
            setStatus(`❌ ${err.message}`);
        } finally {
            setIsResending(false);
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
            <div className="w-full max-w-md">
                <Card className="p-6 text-center sm:p-8">
                    {/* Branding */}
                    <div className="flex items-center justify-center gap-2">
                        <img src="/image.png" alt="" className="h-8 w-8 object-contain" />
                        <span className="text-2xl font-semibold tracking-tight text-foreground">
                            Kachploy
                        </span>
                    </div>

                    {/* Explanation */}
                    <div className="mt-6 space-y-2">
                        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                            Verify your email
                        </h1>
                        <p className="text-sm text-foreground-muted">
                            {user?.email ? (
                                <>
                                    We sent a verification link to{' '}
                                    <span className="font-medium text-foreground">{user.email}</span>.
                                    Open the link to activate your account.
                                </>
                            ) : (
                                'We sent a verification link to your email address. Open the link to activate your account.'
                            )}
                        </p>
                    </div>

                    {/* Resend action */}
                    <div className="mt-6">
                        <Button
                            type="button"
                            size="lg"
                            className="w-full"
                            onClick={resendVerification}
                            disabled={isResending}
                        >
                            {isResending && <Spinner size="sm" label="Sending verification email" />}
                            {isResending ? 'Sending…' : 'Resend verification link'}
                        </Button>
                    </div>

                    {/* Status message: a polite live region so screen readers hear
                        the result of the resend / the guard messages. */}
                    <p
                        role="status"
                        aria-live="polite"
                        className="mt-4 min-h-[1.25rem] text-sm font-medium text-foreground-muted"
                    >
                        {status}
                    </p>

                    {/* Passive progress note for the automatic check */}
                    <div className="mt-6 flex items-center justify-center gap-2 text-xs text-foreground-subtle">
                        <Spinner size="sm" className="text-accent" label="Waiting for verification" />
                        <span>This page updates automatically once you're verified.</span>
                    </div>
                </Card>
            </div>
        </div>
    );
};

export default VerifyEmail;
