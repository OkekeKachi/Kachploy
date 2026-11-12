import React, { useEffect, useRef, useState } from 'react';
import { auth } from '../firebase';
import api from '../api';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import queryKeys from '../queryKeys';
import { useUserQuery } from '../useUserQuery';
import { uploadProfilePhoto } from '../profilePhotoUpload';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import { Field, Input } from '../components/ui/Field';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';

const CompleteProfile = () => {
    // Phase 5A of the data-fetching audit: the role in this document is read
    // through the shared identity query (useUserQuery.js) instead of this page's
    // own GET /users/getUser. `role` is the same value the old `setRole` held, so
    // the role-specific sections below are unchanged. The seeded fullName/phone
    // still come from the Auth session, exactly as before.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);
    const role = userQuery.data ? userQuery.data.role : '';
    const [formData, setFormData] = useState(() => {
        const user = auth.currentUser;
        return {
            fullName: user?.displayName || '',
            phone: user?.phoneNumber || '',
        };
    });
    const [profilePic, setProfilePic] = useState(null);
    const [uploading, setUploading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState('');
    const saveInFlightRef = useRef(false);
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    useEffect(() => {
        // The auth boundary the old fetchRole kept: no session, back to sign-in.
        // ProtectedRoute normally turns an anonymous visitor away, but the
        // session can still resolve empty after that render.
        if (!auth.currentUser) {
            navigate('/login');
        }
    }, [navigate]);

    const handleChange = (e) => {
        setFormData(prev => ({ ...prev, [e.target.name]: e.target.value }));
    };

    const handleFileChange = (e) => {
        setProfilePic(e.target.files[0]);
    };

    // Format phone number to E.164 format for Firebase Auth
    const formatPhoneNumber = (phone) => {
        // Remove any non-digit characters
        const digits = phone.replace(/\D/g, '');

        // Add country code if missing (assuming Nigeria +234)
        if (digits.length === 10) {
            return `+234${digits}`;
        } else if (digits.length === 11 && digits.startsWith('0')) {
            return `+234${digits.substring(1)}`;
        } else if (digits.length === 13 && digits.startsWith('234')) {
            return `+${digits}`;
        } else if (phone.startsWith('+')) {
            return phone; // Already formatted
        }

        return phone; // Return as-is if can't format
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (saveInFlightRef.current) return;

        let imageUrl = '';
        let imagePublicId = '';
        const user = auth.currentUser;

        if (!user) {
            navigate('/login');
            return;
        }

        saveInFlightRef.current = true;
        setSaving(true);
        setSaveError('');

        try {
            if (profilePic) {
                setUploading(true);
                const uploaded = await uploadProfilePhoto(profilePic);
                imageUrl = uploaded.url;
                imagePublicId = uploaded.publicId;
            }

            const formattedSkills = formData.skills
                ? formData.skills.split(',').map(skill => skill.trim())
                : [];

            const payload = {
                ...formData,
                fullName: formData.fullName, // Will update Auth displayName
                phone: formatPhoneNumber(formData.phone), // Will update Auth phoneNumber
                profilePic: imageUrl, // Will update Auth photoURL
                profileComplete: true,
            };

            // The Cloudinary public id of the new photo, when one was uploaded, is
            // sent so the server can delete any photo this replaces. Optional: the
            // server derives it from the URL when it is absent.
            if (imagePublicId) {
                payload.profilePicPublicId = imagePublicId;
            }

            if (formattedSkills && formattedSkills.length > 0) {
                payload.skills = formattedSkills;
            }

            await api.put(`/users/update/${user.uid}`, payload);

            // Phases 1-2 of the data-fetching audit: profileComplete has just been
            // written, so the cached identity document is refreshed BEFORE navigating
            // on. refetchType 'all' awaits it even though nothing is observing the key
            // on this page, which is what keeps /dashboard from reading a cached
            // profileComplete: false and bouncing straight back here.
            await queryClient.invalidateQueries({
                queryKey: queryKeys.user(user.uid),
                refetchType: 'all',
            });

            navigate('/dashboard');
        } catch (err) {
            console.error('Profile update failed:', err);
            setSaveError(
                (err && err.response && err.response.data && err.response.data.message)
                    || 'Your profile could not be saved. Please try again.'
            );
        } finally {
            saveInFlightRef.current = false;
            setUploading(false);
            setSaving(false);
        }
    };

    if (Boolean(uid) && userQuery.isPending) {
        return <PageLoader label="Loading your profile." />;
    }

    /*
        STAGE 11.17a: presentation-only redesign onto the shared design system
        (PageContainer/PageHeader, Card sections, Field/Input, Button, PageLoader),
        following Profile.jsx. Every field name, the `required` flags, the controlled
        fullName/phone values, handleChange/handleFileChange, formatPhoneNumber, the
        uploadProfilePhoto call and the PUT payload are unchanged; only the markup and
        the visible surfaces changed.
    */
    return (
        <div className="min-h-screen bg-canvas">
            <PageContainer className="py-8">
                <div className="mx-auto max-w-3xl space-y-6">
                    <PageHeader
                        title="Complete your profile"
                        description={
                            role
                                ? `You're setting up your ${role} profile. Add the details below — you can update them later from your profile.`
                                : 'Add the details below to finish setting up your account. You can update them later from your profile.'
                        }
                    />

                    <form onSubmit={handleSubmit} className="space-y-6">
                        {/* Common fields */}
                        <Card className="p-5 sm:p-6">
                            <h2 className="text-base font-semibold text-foreground">Personal details</h2>

                            <div className="mt-4 grid gap-5 sm:grid-cols-2">
                                <Field id="fullName" label="Full name" required>
                                    <Input
                                        id="fullName"
                                        type="text"
                                        name="fullName"
                                        value={formData.fullName || ''}
                                        onChange={handleChange}
                                        required
                                    />
                                </Field>

                                <Field id="phone" label="Phone number" hint="e.g. 08012345678" required>
                                    <Input
                                        id="phone"
                                        type="tel"
                                        name="phone"
                                        value={formData.phone || ''}
                                        onChange={handleChange}
                                        required
                                    />
                                </Field>

                                <Field id="address" label="Address" required className="sm:col-span-2">
                                    <Input
                                        id="address"
                                        type="text"
                                        name="address"
                                        onChange={handleChange}
                                        required
                                    />
                                </Field>

                                <Field
                                    id="profilePic"
                                    label="Profile photo"
                                    hint="Optional. JPG or PNG."
                                    className="sm:col-span-2"
                                >
                                    <Input
                                        id="profilePic"
                                        type="file"
                                        accept="image/*"
                                        onChange={handleFileChange}
                                        className="file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
                                    />
                                </Field>
                            </div>
                        </Card>

                        {/* Employee-specific fields */}
                        {role === 'employee' && (
                            <Card className="p-5 sm:p-6">
                                <h2 className="text-base font-semibold text-foreground">Work details</h2>

                                <div className="mt-4 grid gap-5 sm:grid-cols-2">
                                    <Field
                                        id="skills"
                                        label="Skills"
                                        hint="e.g. Plumbing, Painting"
                                        required
                                        className="sm:col-span-2"
                                    >
                                        <Input
                                            id="skills"
                                            type="text"
                                            name="skills"
                                            onChange={handleChange}
                                            required
                                        />
                                    </Field>

                                    <Field id="yearsOfExperience" label="Years of experience" required>
                                        <Input
                                            id="yearsOfExperience"
                                            type="number"
                                            name="yearsOfExperience"
                                            onChange={handleChange}
                                            required
                                        />
                                    </Field>

                                    <Field
                                        id="availability"
                                        label="Availability"
                                        hint="e.g. Weekdays, Weekends"
                                        required
                                    >
                                        <Input
                                            id="availability"
                                            type="text"
                                            name="availability"
                                            onChange={handleChange}
                                            required
                                        />
                                    </Field>
                                </div>
                            </Card>
                        )}

                        {/* Employer-specific fields */}
                        {role === 'employer' && (
                            <Card className="p-5 sm:p-6">
                                <h2 className="text-base font-semibold text-foreground">Company details</h2>

                                <div className="mt-4 grid gap-5 sm:grid-cols-2">
                                    <Field
                                        id="companyName"
                                        label="Company / organization name"
                                        required
                                        className="sm:col-span-2"
                                    >
                                        <Input
                                            id="companyName"
                                            type="text"
                                            name="companyName"
                                            onChange={handleChange}
                                            required
                                        />
                                    </Field>

                                    <Field id="jobTypes" label="Types of jobs available" required>
                                        <Input
                                            id="jobTypes"
                                            type="text"
                                            name="jobTypes"
                                            onChange={handleChange}
                                            required
                                        />
                                    </Field>

                                    <Field id="location" label="Job location" required>
                                        <Input
                                            id="location"
                                            type="text"
                                            name="location"
                                            onChange={handleChange}
                                            required
                                        />
                                    </Field>
                                </div>
                            </Card>
                        )}

                        {(saveError || userQuery.isError) && (
                            <p
                                role="alert"
                                className="rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                            >
                                {saveError
                                    || 'Your profile could not be loaded. Please reload the page and try again.'}
                            </p>
                        )}

                        <div className="flex justify-end">
                            <Button
                                type="submit"
                                size="lg"
                                disabled={saving || uploading}
                                aria-busy={saving || uploading}
                                className="w-full sm:w-auto"
                            >
                                {uploading ? 'Uploading…' : saving ? 'Saving…' : 'Save and continue'}
                            </Button>
                        </div>
                    </form>
                </div>
            </PageContainer>
        </div>
    );
};

export default CompleteProfile;