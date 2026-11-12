import React, { useState } from 'react';
import { auth } from '../firebase';
import {
    createUserWithEmailAndPassword,
    sendEmailVerification,
} from 'firebase/auth';
import { useNavigate } from 'react-router-dom';
import Button from '../components/ui/Button';
import { Field, Input, Select } from '../components/ui/Field';

/*
    STAGE 11.17b: presentation-only redesign onto the shared design system.

    The full-page gradient background, white card, Kachploy logo and Log In / Sign Up
    tab row this component used to render now live in AuthPage.jsx; only the form body
    and a small switch line remain here (the switch line is what keeps the
    `setisSignup` prop in use).

    The handler is copied through unchanged, STAGE 5I-4 comment included: the account
    is created, the `register_user` payload is staged in localStorage BEFORE
    sendEmailVerification runs, the verification URL is the same literal
    ('http://localhost:5173/verify-email'), and both catch branches -- staged vs.
    never-created -- keep their exact messages and navigation. The empty-role guard
    still alerts "❌ Please select your role." There is no loading guard; the submit
    button behaves exactly as before.
*/
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
        // STAGE 5I-4: set once `register_user` is durably stored. The catch needs
        // it to tell "no account was ever created" apart from "the account exists
        // but the email did not send" -- only the second case may continue to the
        // verification page.
        let stagedInStorage = false;
        try {
            const { email, password, fullName, phone, role, profileComplete } = formData;

            if (!role) {
                alert("❌ Please select your role.");
                return;
            }

            const userCredential = await createUserWithEmailAndPassword(auth, email, password);
            const user = userCredential.user;

            // STAGE 5I-4: this used to run AFTER sendEmailVerification. A failed
            // email send therefore threw before the profile was ever stored, so
            // fullName / phone / role / profileComplete were lost permanently: the
            // Auth account existed but nothing could ever reconstruct
            // POST /users/register from it, and re-submitting the form failed with
            // email-already-in-use. Storing first means a temporary email failure
            // loses nothing -- the data is already here when the user resends.
            // The stored shape is unchanged, so VerifyEmail.jsx reads it exactly
            // as before.
            localStorage.setItem("register_user", JSON.stringify({
                token: await user.getIdToken(),
                fullName,
                phone,
                role,
                profileComplete,
            }));
            stagedInStorage = true;

            await sendEmailVerification(user, {
                url: 'http://localhost:5173/verify-email',
            });

            alert("✅ Verification email sent. Please check your inbox.");

            navigate('/verify-email');
        } catch (err) {
            // STAGE 5I-4: staging already succeeded, so the Auth account exists and
            // the profile data is safe. Re-submitting this form would fail with
            // email-already-in-use, so the message says what happened and the
            // verification page -- whose existing Resend button completes the flow
            // -- is where the user continues. The happy path's alert and navigation
            // are untouched, and a failure before staging still uses the original
            // single-line alert and stays on this form. The Auth account is
            // deliberately NOT deleted here.
            if (stagedInStorage) {
                alert(`❌ ${err.message}\n\nYour account was created and your details were saved, but the verification email could not be sent. Taking you to the verification page -- press Resend there to try again.`);
                navigate('/verify-email');
                return;
            }

            alert(`❌ ${err.message}`);
        }
    };

    return (
        <div>
            <form onSubmit={handleSignUp} className="space-y-4">
                <Field id="fullName" label="Full Name">
                    <Input
                        id="fullName"
                        name="fullName"
                        type="text"
                        value={formData.fullName}
                        onChange={handleChange}
                        required
                    />
                </Field>

                <Field id="phone" label="Phone Number">
                    <Input
                        id="phone"
                        name="phone"
                        type="tel"
                        value={formData.phone}
                        onChange={handleChange}
                        required
                    />
                </Field>

                <Field id="email" label="Email">
                    <Input
                        id="email"
                        name="email"
                        type="email"
                        value={formData.email}
                        onChange={handleChange}
                        required
                    />
                </Field>

                <Field id="password" label="Password">
                    <Input
                        id="password"
                        name="password"
                        type="password"
                        value={formData.password}
                        onChange={handleChange}
                        required
                    />
                </Field>

                <Field id="role" label="Role">
                    <Select
                        id="role"
                        name="role"
                        value={formData.role}
                        onChange={handleChange}
                        required
                    >
                        <option value="" disabled>Select Role</option>
                        <option value="employee">Employee</option>
                        <option value="employer">Employer</option>
                    </Select>
                </Field>

                <Button type="submit" size="lg" className="w-full">
                    Sign Up
                </Button>
            </form>

            <p className="mt-6 text-center text-sm text-foreground-muted">
                Already have an account?{' '}
                <button
                    type="button"
                    onClick={() => setisSignup(false)}
                    className="font-medium text-accent transition-colors hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                    Log In
                </button>
            </p>
        </div>
    );
};

export default SignUp;
