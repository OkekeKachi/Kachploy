import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth, storage } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import api from '../api';

/**
 * STAGE 6D: the real destination behind the `/profile` links that Navbar.jsx has
 * always rendered (both the desktop link and the dropdown item). No route ever
 * matched that path, so every profile link in the employee navigation was a dead
 * link. This page is the profile editor behind it.
 *
 * IT ONLY EDITS FIELDS THE EXISTING ENDPOINT ALREADY SUPPORTS
 *   Everything below is sent to PUT /users/update/:uid, whose allow-list is
 *   server/services/userService.js ALLOWED_PROFILE_FIELDS. Nothing here adds a
 *   field, and `role` / `uid` are unreachable because the allow-list filters
 *   keys before anything is written -- so this page cannot be used to escalate a
 *   role or point the document at another user.
 *
 *   `profileComplete` is deliberately NOT editable here. It is on the allow-list,
 *   but it is the onboarding gate flag rather than profile content, and
 *   /complete-profile is the flow that owns setting it. Sending it from here
 *   would let a profile edit flip that gate. Omitting the key entirely preserves
 *   the stored value: updateUserProfile only writes an allow-listed field when it
 *   hasOwnProperty on the body, so an absent key is left alone.
 *
 * AUTHORIZATION IS UNCHANGED
 *   The uid is read from the verified auth session and is never taken from the
 *   URL or from a field, and the route's own requireSelfParam already rejects any
 *   :uid that is not req.user.uid. A user can therefore still only ever update
 *   their own profile.
 *
 * PROFILE PICTURE
 *   Already supported by the existing API and the existing UI: completeProfile.jsx
 *   uploads to `profilePics/${uid}` and posts the download URL as `profilePic`,
 *   which updateUserProfile writes to the Auth `photoURL`. This reuses that exact
 *   path and mechanism rather than introducing an upload system.
 *
 *   The avatar is read back from auth.currentUser.photoURL and NOT from the
 *   profile document: profilePic is stripped from the Firestore write, so
 *   GET /users/getUser never returns one, even though PUBLIC_PROFILE_FIELDS lists
 *   it.
 */

/** The fields this page is allowed to send. profileComplete is absent on purpose. */
const EDITABLE_FIELDS = [
    'fullName',
    'phone',
    'address',
    'bio',
    'skills',
    'yearsOfExperience',
    'availability',
    'serviceType',
    'location',
    'companyName',
    'jobTypes',
];

const emptyForm = () =>
    EDITABLE_FIELDS.reduce((acc, field) => ({ ...acc, [field]: '' }), {});

/**
 * Normalises a phone number to the E.164 form the Auth layer expects.
 *
 * This is deliberately a copy of the identical helper in completeProfile.jsx and
 * of the one in userService.registerUser. It is duplicated rather than shared
 * because extracting it would mean editing completeProfile.jsx, which is out of
 * scope for this stage. It is idempotent for a value already stored by
 * registration: `+2348012345678` reduces to 13 digits starting `234` and comes
 * back unchanged, so saving an untouched phone number does not corrupt it.
 */
const formatPhoneNumber = (phone) => {
    if (!phone) return phone;

    const digits = phone.replace(/\D/g, '');

    if (digits.length === 10) {
        return `+234${digits}`;
    } else if (digits.length === 11 && digits.startsWith('0')) {
        return `+234${digits.substring(1)}`;
    } else if (digits.length === 13 && digits.startsWith('234')) {
        return `+${digits}`;
    } else if (phone.startsWith('+')) {
        return phone;
    }

    return phone;
};

/**
 * Renders a stored field for an <input>.
 *
 * `skills` is stored as an array but edited as a comma-separated list, so it is
 * the one field that needs translating in both directions. A stored value that is
 * neither a string nor an array falls back to '' rather than rendering
 * `[object Object]`.
 */
const toInputValue = (value) => {
    if (Array.isArray(value)) return value.join(', ');
    if (value === null || value === undefined) return '';
    return String(value);
};

const Profile = () => {
    const [role, setRole] = useState('');
    const [formData, setFormData] = useState(emptyForm);
    const [avatarUrl, setAvatarUrl] = useState('');
    const [profilePic, setProfilePic] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        const unsubscribe = onAuthStateChanged(auth, async (user) => {
            if (!user) {
                setLoading(false);
                return;
            }

            try {
                // getUser returns the whole document when the caller is reading
                // themselves, so this one call supplies every field below.
                const response = await api.get(`/users/getUser/${user.uid}`);
                const stored = response.data.user || {};

                setRole(stored.role || '');
                setFormData(
                    EDITABLE_FIELDS.reduce(
                        (acc, field) => ({ ...acc, [field]: toInputValue(stored[field]) }),
                        emptyForm()
                    )
                );
                // The avatar lives in Auth, not in this document.
                setAvatarUrl(user.photoURL || '');
                setError('');
            } catch (err) {
                console.error('Error loading profile:', err);
                setError('Your profile could not be loaded. Please reload the page to try again.');
            } finally {
                setLoading(false);
            }
        });

        return () => unsubscribe();
    }, []);

    const handleChange = (e) => {
        setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    };

    const handleFileChange = (e) => {
        setProfilePic(e.target.files[0]);
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        const user = auth.currentUser;

        if (!user) {
            setError('Your session has expired. Please sign in again.');
            return;
        }

        setSaving(true);
        setError('');
        setSuccess('');

        try {
            let imageUrl = '';

            if (profilePic) {
                setUploading(true);
                // Same storage path and API completeProfile.jsx already uses.
                const storageRef = ref(storage, `profilePics/${user.uid}`);
                await uploadBytes(storageRef, profilePic);
                imageUrl = await getDownloadURL(storageRef);
            }

            // skills round-trips as a comma-separated string in the form.
            const payload = {
                ...formData,
                phone: formatPhoneNumber(formData.phone),
            };

            payload.skills = payload.skills
                ? payload.skills.split(',').map((skill) => skill.trim()).filter(Boolean)
                : [];

            // profilePic is handled separately by the service, and is omitted when
            // no new file was chosen so the existing avatar is left alone.
            if (imageUrl) payload.profilePic = imageUrl;

            // Every editable field is always sent, including when it has been
            // cleared, so a user can empty a field rather than only overwrite it.
            // This is safe against updateUserProfile's hasOwnProperty quirk, which
            // copies an allow-listed field whenever the body has it *even when the
            // value is explicitly undefined*: every value here is a string produced
            // by a text or number input, never undefined.
            const body = EDITABLE_FIELDS.reduce(
                (acc, field) => ({ ...acc, [field]: payload[field] }),
                {}
            );

            await api.put(`/users/update/${user.uid}`, body);

            if (imageUrl) setAvatarUrl(imageUrl);
            setProfilePic(null);
            setSuccess('Profile updated successfully.');
        } catch (err) {
            console.error('Error updating profile:', err);
            setError('Your profile could not be saved. Please try again.');
        } finally {
            setUploading(false);
            setSaving(false);
        }
    };

    if (loading) return <p>Loading...</p>;

    return (
        <div style={{ padding: '20px' }}>
            <h2>My Profile ({role})</h2>

            <div style={{ marginBottom: '16px' }}>
                {avatarUrl ? (
                    <img
                        src={avatarUrl}
                        alt="Profile"
                        style={{ width: '80px', height: '80px', borderRadius: '50%', objectFit: 'cover' }}
                    />
                ) : (
                    <div
                        style={{
                            width: '80px',
                            height: '80px',
                            borderRadius: '50%',
                            background: '#e5e7eb',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                        }}
                    >
                        <span>No photo</span>
                    </div>
                )}
            </div>

            {error && (
                <p role="alert" style={{ color: '#dc2626', marginBottom: '12px' }}>
                    {error}
                </p>
            )}
            {success && (
                <p role="status" style={{ color: '#15803d', marginBottom: '12px' }}>
                    {success}
                </p>
            )}

            <form onSubmit={handleSubmit}>
                {/* Common fields */}
                <input
                    type="text"
                    name="fullName"
                    value={formData.fullName}
                    placeholder="Full Name"
                    onChange={handleChange}
                    required
                />
                <input
                    type="tel"
                    name="phone"
                    value={formData.phone}
                    placeholder="Phone Number (e.g. 08012345678)"
                    onChange={handleChange}
                    required
                />
                <input
                    type="text"
                    name="address"
                    value={formData.address}
                    placeholder="Address"
                    onChange={handleChange}
                />
                <input
                    type="text"
                    name="bio"
                    value={formData.bio}
                    placeholder="Bio"
                    onChange={handleChange}
                />
                <input type="file" accept="image/*" onChange={handleFileChange} />

                {/* Employee-specific fields, the same grouping completeProfile uses */}
                {role === 'employee' && (
                    <>
                        <input
                            type="text"
                            name="skills"
                            value={formData.skills}
                            placeholder="Skills (e.g. Plumbing, Painting)"
                            onChange={handleChange}
                        />
                        <input
                            type="number"
                            name="yearsOfExperience"
                            value={formData.yearsOfExperience}
                            placeholder="Years of Experience"
                            onChange={handleChange}
                        />
                        <input
                            type="text"
                            name="availability"
                            value={formData.availability}
                            placeholder="Availability (e.g. Weekdays, Weekends)"
                            onChange={handleChange}
                        />
                        <input
                            type="text"
                            name="serviceType"
                            value={formData.serviceType}
                            placeholder="Service Type"
                            onChange={handleChange}
                        />
                        <input
                            type="text"
                            name="location"
                            value={formData.location}
                            placeholder="Location"
                            onChange={handleChange}
                        />
                    </>
                )}

                {/* Employer-specific fields */}
                {role === 'employer' && (
                    <>
                        <input
                            type="text"
                            name="companyName"
                            value={formData.companyName}
                            placeholder="Company/Organization Name"
                            onChange={handleChange}
                        />
                        <input
                            type="text"
                            name="jobTypes"
                            value={formData.jobTypes}
                            placeholder="Types of Jobs Available"
                            onChange={handleChange}
                        />
                        <input
                            type="text"
                            name="location"
                            value={formData.location}
                            placeholder="Job Location"
                            onChange={handleChange}
                        />
                    </>
                )}

                <div style={{ marginTop: '12px', display: 'flex', gap: '12px' }}>
                    <button type="submit" disabled={saving || uploading}>
                        {uploading ? 'Uploading...' : saving ? 'Saving...' : 'Save changes'}
                    </button>
                    <button type="button" onClick={() => navigate('/dashboard')}>
                        Back to dashboard
                    </button>
                </div>
            </form>
        </div>
    );
};

export default Profile;