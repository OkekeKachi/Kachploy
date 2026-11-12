import React, { useState } from 'react';
import SignUp from './SignUp';
import Login from './Login';
import Card from '../components/ui/Card';

/*
    STAGE 11.17b: the shared authentication shell.

    Until this stage AuthPage was a bare <div> and each of Login.jsx and SignUp.jsx
    rendered its own full-page background, card, Kachploy logo, heading and Log In /
    Sign Up tab row -- the same chrome twice, kept in step by hand. This stage moves
    that chrome here: one page background, one card, one branding header and one
    segmented toggle, with the two forms rendering only their own fields below it.

    The state contract is deliberately unchanged: `isSignup` is still a local
    useState here, its setter is still spelled `setisSignup`, and the active form is
    still handed that setter, exactly as before. The /login route and the component
    that renders it (App.jsx) are untouched; no route is added.
*/
const AuthPage = () => {
    const [isSignup, setisSignup] = useState(false);

    // One class string per toggle state, so the two halves cannot drift apart.
    const toggleClasses = (active) =>
        `flex-1 rounded-md px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface ${
            active
                ? 'bg-surface text-foreground shadow-card'
                : 'text-foreground-muted hover:text-foreground'
        }`;

    return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
            <div className="w-full max-w-md">
                <Card className="p-6 sm:p-8">
                    {/* Branding */}
                    <div className="mb-6 text-center">
                        <div className="flex items-center justify-center gap-2">
                            <img src="/image.png" alt="" className="h-8 w-8 object-contain" />
                            <span className="text-2xl font-semibold tracking-tight text-foreground">
                                Kachploy
                            </span>
                        </div>
                        <p className="mt-2 text-sm text-foreground-muted">
                            Create an account or log in to hire and get hired
                        </p>
                    </div>

                    {/* Log In / Sign Up toggle. Same setisSignup behaviour as the
                        per-page tab rows this replaces. */}
                    <div
                        role="group"
                        aria-label="Choose log in or sign up"
                        className="mb-6 flex rounded-lg border border-border bg-surface-muted p-1"
                    >
                        <button
                            type="button"
                            aria-pressed={!isSignup}
                            onClick={() => setisSignup(false)}
                            className={toggleClasses(!isSignup)}
                        >
                            Log In
                        </button>
                        <button
                            type="button"
                            aria-pressed={isSignup}
                            onClick={() => setisSignup(true)}
                            className={toggleClasses(isSignup)}
                        >
                            Sign Up
                        </button>
                    </div>

                    {isSignup ? <SignUp setisSignup={setisSignup} /> : <Login setisSignup={setisSignup} />}
                </Card>
            </div>
        </div>
    );
};

export default AuthPage;
