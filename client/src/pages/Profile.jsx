import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { User, AlertCircle, CheckCircle2, FileText, Download } from 'lucide-react';
import { auth } from '../firebase';
import api from '../api';
import queryKeys from '../queryKeys';
import { uploadProfilePhoto } from '../profilePhotoUpload';
import { uploadResume, downloadResume } from '../resumeUpload';
import AppNavbar from '../components/AppNavbar';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import { Field, Input, Textarea } from '../components/ui/Field';
import { useUserQuery } from '../useUserQuery';

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
 *   Uploaded to Cloudinary through the dedicated signer endpoint
 *   POST /users/profile-photo/signature (see ../profilePhotoUpload.js): the server
 *   signs `profilePics/${uid}` from the verified token and the browser posts the
 *   file straight to Cloudinary, then this page persists the returned secure_url as
 *   `profilePic` through the same PUT /users/update/:uid call as every other field.
 *   updateUserProfile writes it to the Auth `photoURL` and, since Stage 6N, to the
 *   Firestore document as well, so both the self read and the cross-user public
 *   projection carry it.
 *
 * STAGE 11.4: this stage changes only presentation -- the render tree below. Every
 * request, field, payload, state transition and navigation above and in the effect
 * and submit handler is byte-for-byte the same as before. Placeholder-only fields
 * are now labelled through the shared Field/Label primitives, the sections are
 * grouped into Cards, and the page renders the shared AppNavbar + PageContainer
 * shell the other dashboard pages use. No field was added or removed.
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
    // The avatar lives in Auth, not in the Firestore document, so it is seeded
    // once from the session -- not from the identity query -- which keeps a
    // just-uploaded picture from being reverted by the post-save invalidation.
    const [avatarUrl, setAvatarUrl] = useState(() => auth.currentUser?.photoURL || '');
    const [profilePic, setProfilePic] = useState(null);
    // STAGE 12.13. The stored private resume reference and the file the user has
    // chosen to replace it with, held separately: the reference is what is
    // displayed (and what a save with no new file leaves untouched), the file is
    // uploaded only when a save actually happens.
    const [resume, setResume] = useState(null);
    const [resumeFile, setResumeFile] = useState(null);
    const [resumeUploading, setResumeUploading] = useState(false);
    const [resumeDownloading, setResumeDownloading] = useState(false);
    const [resumeError, setResumeError] = useState('');
    const [resumeNotice, setResumeNotice] = useState('');
    const [saving, setSaving] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const downloadInFlightRef = useRef(false);
    const saveInFlightRef = useRef(false);
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    // Phase 5A of the data-fetching audit: the whole-document self read is the
    // shared identity query (useUserQuery.js) instead of this page's own
    // GET /users/getUser effect. The editable form (and role/resume) is seeded
    // from the query's document in the effect below, mirroring the pattern
    // EmployeeDashboard uses after Phase 2, so a re-render never clobbers the
    // user's edits.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);

    useEffect(() => {
        // getUser returns the whole document when the caller is reading
        // themselves, so the shared query supplies every field below. This writes
        // only when the QUERY's document changes -- on arrival and on the
        // post-save invalidation -- not on every render.
        const stored = userQuery.data;
        if (!stored) return;

        setRole(stored.role || '');
        setFormData(
            EDITABLE_FIELDS.reduce(
                (acc, field) => ({ ...acc, [field]: toInputValue(stored[field]) }),
                emptyForm()
            )
        );
        // The stored resume is a private reference. A malformed or absent one is
        // simply "no resume", never rendered. The avatar is seeded from the
        // session above, not from this document.
        setResume(stored.resume && stored.resume.publicId ? stored.resume : null);
    }, [userQuery.data]);

    const handleChange = (e) => {
        setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
    };

    const handleFileChange = (e) => {
        setProfilePic(e.target.files[0]);
    };

    const handleResumeFileChange = (e) => {
        setResumeFile(e.target.files[0] || null);
        setResumeError('');
        setResumeNotice('');
    };

    /**
     * Downloads the stored resume through the signed-download endpoint. The asset
     * id is never sent -- the server reads it from the caller's own record -- so
     * this is the only way the file is reached. Failure leaves the stored resume
     * untouched and is reported in the resume card, not the page-level error.
     */
    const handleResumeDownload = async () => {
        if (downloadInFlightRef.current) return;

        downloadInFlightRef.current = true;
        setResumeError('');
        setResumeNotice('');
        setResumeDownloading(true);

        try {
            await downloadResume();
        } catch (err) {
            console.error('Error downloading resume:', err);
            setResumeError('Your resume could not be downloaded. Please try again.');
        } finally {
            downloadInFlightRef.current = false;
            setResumeDownloading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (saveInFlightRef.current) return;

        const user = auth.currentUser;

        if (!user) {
            setError('Your session has expired. Please sign in again.');
            return;
        }

        saveInFlightRef.current = true;
        setSaving(true);
        setError('');
        setSuccess('');

        // Tracked outside the try so the catch can tell a resume-upload failure
        // (the caller's to fix, reported in the resume card) from any other
        // failure (reported page-wide). Set only when uploadResume itself throws.
        let resumeUploadFailed = false;
        let newResume = null;

        try {
            setResumeError('');

            let imageUrl = '';
            let imagePublicId = '';

            if (profilePic) {
                setUploading(true);
                // Same Cloudinary flow completeProfile.jsx uses; see
                // ../profilePhotoUpload.js. Resolves only on a real upload, so a
                // failure here leaves the stored avatar untouched. The public id is
                // carried through so the server can delete the photo this replaces.
                const uploaded = await uploadProfilePhoto(profilePic);
                imageUrl = uploaded.url;
                imagePublicId = uploaded.publicId;
            }

            // STAGE 12.13. A newly chosen resume is uploaded first, then persisted
            // as a private reference through the same PUT. Resolves only on a real
            // upload, so a failure leaves the stored resume untouched.
            if (resumeFile) {
                setResumeUploading(true);
                try {
                    newResume = await uploadResume(resumeFile);
                } catch (uploadErr) {
                    resumeUploadFailed = true;
                    throw uploadErr;
                }
            }

            // skills round-trips as a comma-separated string in the form.
            const payload = {
                ...formData,
                phone: formatPhoneNumber(formData.phone),
            };

            payload.skills = payload.skills
                ? payload.skills.split(',').map((skill) => skill.trim()).filter(Boolean)
                : [];

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

            // profilePic is not an editable text field, so it is not covered by
            // the reduce above. Add it only when a new photo was uploaded
            // successfully, so an update with no new photo does not overwrite the
            // existing avatar with an empty value. The Cloudinary public id travels
            // with it so the server can delete the replaced photo once the update
            // succeeds.
            if (imageUrl) {
                body.profilePic = imageUrl;
                if (imagePublicId) body.profilePicPublicId = imagePublicId;
            }

            // The resume reference is added only when a new file was uploaded, so
            // a save with no new file never overwrites the stored one -- including
            // when the reference is `null` because none is stored.
            if (newResume) body.resume = newResume;

            await api.put(`/users/update/${user.uid}`, body);

            // Phases 1-2 of the data-fetching audit: the saved document replaces the
            // cached identity everywhere it is observed -- the navbar's chip and role,
            // and the dashboards' redirects -- without a reload. refetchType 'all'
            // awaits the refresh even though nothing is observing the key while this
            // page is open (the navbar's query is disabled here because this page
            // passes a role of its own), so navigating on cannot race a still-stale
            // cached document.
            await queryClient.invalidateQueries({
                queryKey: queryKeys.user(user.uid),
                refetchType: 'all',
            });

            if (imageUrl) setAvatarUrl(imageUrl);
            if (newResume) {
                setResume(newResume);
                setResumeFile(null);
                setResumeNotice('Resume updated.');
            }
            setProfilePic(null);
            setSuccess('Profile updated successfully.');
        } catch (err) {
            console.error('Error updating profile:', err);
            // STAGE 12.13. A resume upload failure is the caller's to fix (wrong
            // file type, too large) and is reported in the resume card; the rest
            // keeps the original page-level message.
            if (resumeUploadFailed) {
                setResumeError(
                    err && err.message
                        ? `Your resume could not be saved: ${err.message}`
                        : 'Your resume could not be saved. Please try again.'
                );
            } else {
                setError('Your profile could not be saved. Please try again.');
            }
        } finally {
            saveInFlightRef.current = false;
            setUploading(false);
            setResumeUploading(false);
            setSaving(false);
        }
    };

    if (Boolean(uid) && userQuery.isPending) return <PageLoader label="Loading your profile…" />;

    // A failed identity read is reported through the same page-level banner a
    // failed save uses; the local `error` state takes precedence once a save has
    // failed, and both are cleared by the next successful write.
    const loadError = userQuery.isError
        ? 'Your profile could not be loaded. Please reload the page to try again.'
        : '';

    // STAGE 11.4: the shared shell takes a whole `user` object. This page already
    // loads `role` and the name field, and email comes from the same auth session
    // the navbar's sign-out and dropdown already read, so no new request is made.
    const navUser = {
        fullName: formData.fullName,
        role,
        email: auth.currentUser?.email || '',
    };

    const busy = saving || uploading || resumeUploading;

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={navUser} />

            <PageContainer className="py-8">
                <form onSubmit={handleSubmit} className="space-y-6">
                    <PageHeader
                        title="My Profile"
                        description="Manage the details stored on your Kachploy account."
                    />

                    {/* Feedback for the existing load / save / upload states. */}
                    {(error || loadError) && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{error || loadError}</span>
                        </div>
                    )}
                    {success && (
                        <div
                            role="status"
                            className="flex items-start gap-2 rounded-md bg-success-subtle px-4 py-3 text-sm text-success-subtle-foreground"
                        >
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{success}</span>
                        </div>
                    )}

                    {/* Identity */}
                    <Card className="p-5 sm:p-6">
                        <h2 className="text-base font-semibold text-foreground">Profile</h2>

                        <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start">
                            {avatarUrl ? (
                                <img
                                    src={avatarUrl}
                                    alt="Profile"
                                    className="h-20 w-20 shrink-0 rounded-full object-cover"
                                />
                            ) : (
                                <div
                                    className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full bg-surface-muted text-foreground-subtle"
                                    aria-hidden="true"
                                >
                                    <User className="h-9 w-9" />
                                </div>
                            )}

                            <div className="min-w-0 flex-1 space-y-5">
                                <div className="grid gap-5 sm:grid-cols-2">
                                    <Field id="fullName" label="Full name" required>
                                        <Input
                                            id="fullName"
                                            type="text"
                                            name="fullName"
                                            value={formData.fullName}
                                            onChange={handleChange}
                                            required
                                        />
                                    </Field>

                                    <Field id="profilePic" label="Profile photo">
                                        <Input
                                            id="profilePic"
                                            type="file"
                                            accept="image/*"
                                            onChange={handleFileChange}
                                            className="file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
                                        />
                                    </Field>
                                </div>

                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-foreground">Role</span>
                                    <Badge variant="primary" className="capitalize">
                                        {role}
                                    </Badge>
                                </div>
                            </div>
                        </div>
                    </Card>

                    {/* Contact information */}
                    <Card className="p-5 sm:p-6">
                        <h2 className="text-base font-semibold text-foreground">Contact information</h2>

                        <div className="mt-4 grid gap-5 sm:grid-cols-2">
                            <Field id="phone" label="Phone number" hint="e.g. 08012345678" required>
                                <Input
                                    id="phone"
                                    type="tel"
                                    name="phone"
                                    value={formData.phone}
                                    onChange={handleChange}
                                    required
                                />
                            </Field>

                            <Field id="address" label="Address">
                                <Input
                                    id="address"
                                    type="text"
                                    name="address"
                                    value={formData.address}
                                    onChange={handleChange}
                                />
                            </Field>
                        </div>
                    </Card>

                    {/* Professional details (shared + role-specific) */}
                    <Card className="p-5 sm:p-6">
                        <h2 className="text-base font-semibold text-foreground">
                            {role === 'employer' ? 'Business details' : 'Professional details'}
                        </h2>

                        <div className="mt-4 space-y-5">
                            <Field id="bio" label="Bio">
                                <Textarea
                                    id="bio"
                                    name="bio"
                                    rows={4}
                                    value={formData.bio}
                                    onChange={handleChange}
                                />
                            </Field>

                            {/* Employee fields, the same grouping completeProfile uses */}
                            {role === 'employee' && (
                                <div className="grid gap-5 sm:grid-cols-2">
                                    <Field
                                        id="skills"
                                        label="Skills"
                                        hint="Separate each skill with a comma."
                                    >
                                        <Input
                                            id="skills"
                                            type="text"
                                            name="skills"
                                            value={formData.skills}
                                            onChange={handleChange}
                                        />
                                    </Field>

                                    <Field id="yearsOfExperience" label="Years of experience">
                                        <Input
                                            id="yearsOfExperience"
                                            type="number"
                                            name="yearsOfExperience"
                                            value={formData.yearsOfExperience}
                                            onChange={handleChange}
                                        />
                                    </Field>

                                    <Field id="availability" label="Availability" hint="e.g. Weekdays, Weekends">
                                        <Input
                                            id="availability"
                                            type="text"
                                            name="availability"
                                            value={formData.availability}
                                            onChange={handleChange}
                                        />
                                    </Field>

                                    <Field id="serviceType" label="Service type">
                                        <Input
                                            id="serviceType"
                                            type="text"
                                            name="serviceType"
                                            value={formData.serviceType}
                                            onChange={handleChange}
                                        />
                                    </Field>

                                    <Field id="location" label="Location" className="sm:col-span-2">
                                        <Input
                                            id="location"
                                            type="text"
                                            name="location"
                                            value={formData.location}
                                            onChange={handleChange}
                                        />
                                    </Field>
                                </div>
                            )}

                            {/* Employer fields */}
                            {role === 'employer' && (
                                <div className="grid gap-5 sm:grid-cols-2">
                                    <Field id="companyName" label="Company / organization">
                                        <Input
                                            id="companyName"
                                            type="text"
                                            name="companyName"
                                            value={formData.companyName}
                                            onChange={handleChange}
                                        />
                                    </Field>

                                    <Field id="jobTypes" label="Types of jobs available">
                                        <Input
                                            id="jobTypes"
                                            type="text"
                                            name="jobTypes"
                                            value={formData.jobTypes}
                                            onChange={handleChange}
                                        />
                                    </Field>

                                    <Field id="location" label="Location" className="sm:col-span-2">
                                        <Input
                                            id="location"
                                            type="text"
                                            name="location"
                                            value={formData.location}
                                            onChange={handleChange}
                                        />
                                    </Field>
                                </div>
                            )}
                        </div>
                    </Card>

                    {/* Resume (employees only) */}
                    {role === 'employee' && (
                        <Card className="p-5 sm:p-6">
                            <h2 className="text-base font-semibold text-foreground">Resume</h2>
                            <p className="mt-1 text-sm text-foreground-muted">
                                Upload a PDF resume to reuse when applying for jobs. It stays
                                private and is shared only with employers you apply to.
                            </p>

                            <div className="mt-4 space-y-4">
                                <div className="flex flex-wrap items-center gap-3 rounded-md border border-border-strong bg-surface-muted px-4 py-3">
                                    {resume ? (
                                        <>
                                            <FileText
                                                className="h-5 w-5 shrink-0 text-foreground-subtle"
                                                aria-hidden="true"
                                            />
                                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                                                {resume.name || 'Resume.pdf'}
                                            </span>
                                            <Button
                                                type="button"
                                                variant="secondary"
                                                size="sm"
                                                onClick={handleResumeDownload}
                                                disabled={resumeDownloading}
                                                aria-busy={resumeDownloading}
                                            >
                                                <Download className="h-4 w-4" aria-hidden="true" />
                                                {resumeDownloading ? 'Preparing…' : 'Download'}
                                            </Button>
                                        </>
                                    ) : (
                                        <span className="text-sm text-foreground-muted">
                                            No resume uploaded yet.
                                        </span>
                                    )}
                                </div>

                                <Field
                                    id="resume"
                                    label={resume ? 'Replace resume' : 'Upload resume'}
                                    hint="PDF only, up to 5 MB."
                                >
                                    <Input
                                        id="resume"
                                        type="file"
                                        accept="application/pdf,.pdf"
                                        onChange={handleResumeFileChange}
                                        className="file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
                                    />
                                </Field>

                                {resumeFile && (
                                    <p className="text-sm text-foreground-muted">
                                        Selected: {resumeFile.name} — save changes to upload it.
                                    </p>
                                )}

                                {resumeError && (
                                    <div
                                        role="alert"
                                        className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                                    >
                                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                        <span>{resumeError}</span>
                                    </div>
                                )}
                                {resumeNotice && (
                                    <div
                                        role="status"
                                        className="flex items-start gap-2 rounded-md bg-success-subtle px-4 py-3 text-sm text-success-subtle-foreground"
                                    >
                                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                        <span>{resumeNotice}</span>
                                    </div>
                                )}
                            </div>
                        </Card>
                    )}

                    {/* Actions */}
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <Button type="submit" size="lg" disabled={busy} aria-busy={busy}>
                            {resumeUploading ? 'Uploading resume…' : uploading ? 'Uploading…' : saving ? 'Saving…' : 'Save changes'}
                        </Button>
                        <Button
                            type="button"
                            variant="secondary"
                            size="lg"
                            onClick={() => navigate('/dashboard')}
                        >
                            Back to dashboard
                        </Button>
                    </div>
                </form>
            </PageContainer>
        </div>
    );
};

export default Profile;
