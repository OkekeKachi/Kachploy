import React, { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { auth } from '../firebase';
import api from '../api';
import { uploadResume } from '../resumeUpload';
import { MapPin, Briefcase, Clock, CheckCircle, AlertCircle, Users, Calendar, Star, Send, FileText } from 'lucide-react';
import AppNavbar from '../components/AppNavbar';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import { Field, Input, Textarea } from '../components/ui/Field';
import { useUserQuery } from '../useUserQuery';
import { useApplicationCountsQuery } from '../useEmployerQueries';
import { useJobQuery } from '../useAppQueries';
import queryKeys from '../queryKeys';
import { useQueryClient } from '@tanstack/react-query';

/*
  STAGE 11.6: presentation-only redesign.

  Every request, field, state transition, validation rule and navigation below is
  unchanged from the pre-11.6 version:
    - the same GET /jobs/:jobId + GET /users/getUser/:uid load, the same GET
      /applications/counts fallback-to-0, and the same loading/error branches;
    - the same `negotiable === 'yes'` flag (STAGE 5D) and the same applied/apply
      flow in handleApply (STAGE 5G), including the 2s delay, the exact validation
      messages, the conditional `employeePrice`, and the same POST payload;
    - the same explicit loading, error and not-found branches.

  The Material Icons hero, the gradients and the hardcoded gray/blue class strings
  are replaced with the shared PageContainer/PageHeader/Card/Badge/Button/EmptyState
  primitives, the Field/Input/Textarea controls and the index.css tokens. No field
  was added, removed or renamed, and no new data is rendered.
*/

// STAGE 12.9: the job document carries applicationDeadline, jobStartDate and
// expectedEndDate (jobService writes all three; the first two are required on
// create), but this page never showed any of them. The deadline is the single
// thing a job seeker most needs before applying -- whether there is still time.
// These helpers format those dates and turn the deadline into a plain urgency
// label. Display-only: nothing here reads or changes application eligibility.
const formatJobDate = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
};

// Whole days from now to the END of the deadline day (so the deadline day itself
// reads as "Closes today", not "Closed"). Negative once it has passed; null when
// the value is unusable.
const daysUntilDeadline = (applicationDeadline) => {
    if (!applicationDeadline) return null;
    const date = new Date(applicationDeadline);
    if (Number.isNaN(date.getTime())) return null;
    date.setHours(23, 59, 59, 999);
    return Math.ceil((date.getTime() - Date.now()) / 86400000);
};

// STAGE 12.13. The application-requirement levels and defaults, mirrored from
// jobService (REQUIREMENT_LEVELS / DEFAULT_APPLICATION_REQUIREMENTS) so this form
// and the server cannot disagree about what a job without the field requires.
// `not_needed` hides the control and omits the value; `optional` collects it when
// the applicant supplies it; `required` blocks submission until it is supplied.
const REQUIREMENT_LEVELS = ['not_needed', 'optional', 'required'];
const DEFAULT_APPLICATION_REQUIREMENTS = {
    resume: 'not_needed',
    coverLetter: 'optional',
    portfolio: 'not_needed',
};
const normalizeApplicationRequirements = (value) => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = {};
    for (const key of Object.keys(DEFAULT_APPLICATION_REQUIREMENTS)) {
        normalized[key] = REQUIREMENT_LEVELS.includes(source[key])
            ? source[key]
            : DEFAULT_APPLICATION_REQUIREMENTS[key];
    }
    return normalized;
};

/** True for an absolute http: or https: URL, matching the server's check. */
const isValidHttpUrl = (value) => {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const JobDetails = () => {
    const { jobId } = useParams();
    const [message] = useState('');
    const [applied, setApplied] = useState(false);
    const [employeePrice, setEmployeePrice] = useState('');
    const [applying, setApplying] = useState(false);
    const [error, setError] = useState('');
    const applyInFlightRef = useRef(false);
    const queryClient = useQueryClient();

    // Phase 5A of the data-fetching audit: this page's own identity read
    // (GET /users/getUser/:uid) and count-only read (GET /applications/counts)
    // are now the shared queries instead of two requests issued from the effect
    // below. `user` is the identity document the old `setUser` state held -- the
    // same value, so the saved-resume lookup, the apply payload, the navbar and
    // the logged-in guard are all unchanged. `applicantCount` is derived per job
    // from the shared counts entry with the same fallback-to-0, so a missing,
    // pending or failed count still renders 0.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const jobQuery = useJobQuery(jobId);
    const job = jobQuery.data ?? null;
    const userQuery = useUserQuery(uid);
    const user = userQuery.data ?? null;
    const countsQuery = useApplicationCountsQuery(uid);
    const applicantCount = (countsQuery.data || {})[jobId] || 0;

    // STAGE 12.13. The three required/optional application inputs. `resumeMode`
    // is which source the applicant chose ('saved' reuses the profile resume,
    // 'upload' takes a file); `resumeFile` is that file; `coverLetter` and
    // `portfolioUrl` are the other two collected values. `resumeError` is local
    // to the resume control so a bad file does not blank the whole form.
    const [resumeMode, setResumeMode] = useState('saved');
    const [resumeFile, setResumeFile] = useState(null);
    const [coverLetter, setCoverLetter] = useState('');
    const [portfolioUrl, setPortfolioUrl] = useState('');
    const [resumeError, setResumeError] = useState('');

    // STAGE 5D: `negotiable` is the canonical field on the job document and is
    // the string "yes"/"no", not a boolean. It must be compared against "yes"
    // explicitly -- `job.negotiable` on its own is truthy for "no" as well. This
    // one derived flag replaces four separate checks that used to read
    // `job.isNegotiable`, a field no write path has ever persisted, so all four
    // were always falsy and the proposed-price UI never appeared.
    const isNegotiable = job?.negotiable === 'yes';

    // STAGE 12.13. The job's application requirements (normalised so a job that
    // predates the field behaves exactly as a new job with the defaults), the
    // applicant's own saved resume if any, and the source the resume control
    // should actually use -- 'saved' only when there is a saved resume.
    const requirements = normalizeApplicationRequirements(job?.applicationRequirements);
    const savedResume = user?.resume && user.resume.publicId ? user.resume : null;
    const effectiveResumeMode = savedResume ? resumeMode : 'upload';

    // STAGE 12.9: timeline values shown in the meta card below.
    const daysLeft = daysUntilDeadline(job?.applicationDeadline);
    const deadlineDate = formatJobDate(job?.applicationDeadline);
    const startDate = formatJobDate(job?.jobStartDate);
    const endDate = formatJobDate(job?.expectedEndDate);
    const deadlineBadge =
        daysLeft === null
            ? null
            : daysLeft < 0
                ? 'Closed'
                : daysLeft === 0
                    ? 'Closes today'
                    : daysLeft === 1
                        ? 'Closes tomorrow'
                        : daysLeft <= 7
                            ? `Closes in ${daysLeft} days`
                            : null;
    const deadlineVariant = daysLeft !== null && daysLeft < 0 ? 'danger' : 'warning';

    const handleApply = async () => {
        if (applyInFlightRef.current) return;

        if (!user) {
            setError('You must be logged in to apply for this job.');
            return;
        }

        // ── Front‑end eligibility guard ───────────────────────────────────────
        if (!isJobOpen) {
            if (isJobFilled) {
                setError('This job is filled and no longer accepts applications.');
            } else if (isJobClosed) {
                setError('Applications for this job are closed.');
            } else {
                setError('This job is no longer accepting applications.');
            }
            return;
        }
        if (isDeadlinePassed) {
            setError('The application deadline for this job has passed.');
            return;
        }

        // Cover message removed; cover letter is only required if employer enables it.

        if (isNegotiable && !employeePrice) {
            setError('Please enter your proposed price for this negotiable job.');
            return;
        }

        if (isNegotiable && Number(employeePrice) <= 0) {
            setError('Please enter a valid price amount.');
            return;
        }

        // STAGE 12.13. Enforce the job's requirements in the form before any
        // upload or request. These mirror the server's own checks, so the
        // applicant is told here rather than by a 400 after the file has already
        // travelled to Cloudinary.
        //
        // `includeResume` gates every resume decision on the job actually
        // collecting one -- a `not_needed` job must never receive it. `useSaved`
        // and `useUpload` are the two ways one can be supplied, and either being
        // true is what satisfies a `required` resume.
        const includeResume = requirements.resume !== 'not_needed';
        const useSaved = includeResume && effectiveResumeMode === 'saved' && savedResume;
        const useUpload = includeResume && effectiveResumeMode === 'upload';
        const resumeProvided = useSaved || (useUpload && resumeFile);

        if (requirements.resume === 'required' && !resumeProvided) {
            setResumeError('Please attach a resume (use your saved one or upload a PDF).');
            setError('This job requires a resume.');
            return;
        }

        if (requirements.coverLetter === 'required' && !coverLetter.trim()) {
            setError('This job requires a cover letter.');
            return;
        }

        if (requirements.portfolio === 'required' && !isValidHttpUrl(portfolioUrl.trim())) {
            setError('This job requires a portfolio URL (starting with http:// or https://).');
            return;
        }

        applyInFlightRef.current = true;
        setApplying(true);
        setError('');
        setResumeError('');

        try {
            // A newly chosen resume is uploaded first so only a real, stored
            // asset is referenced. Skipped entirely when the applicant reuses
            // their saved resume or the job does not collect one.
            let resumeRef = useSaved ? savedResume : null;

            if (useUpload && resumeFile) {
                try {
                    resumeRef = await uploadResume(resumeFile);
                } catch (uploadErr) {
                    setResumeError(
                        uploadErr && uploadErr.message
                            ? uploadErr.message
                            : 'Your resume could not be uploaded. Please try again.'
                    );
                    setError('Your resume could not be uploaded.');
                    return;
                }
            }

            // Simulate API call
            await new Promise(resolve => setTimeout(resolve, 2000));

            const payload = {
                jobId,
                employeeId: auth.currentUser.uid,
                fullName: user.fullName || 'Anonymous',
                message: message || '',
                employeePrice: isNegotiable ? employeePrice : null,  // Only send employeePrice if negotiable
                // Stage 5G: `status` is no longer sent. The server owns it and
                // always stores `pending`; the value used to be discarded here
                // anyway, so sending it only implied a write that never happened.
            };

            // Each optional field is sent ONLY when the job collects it. A
            // `not_needed` field must be absent or the server rejects it as
            // "not required for this job".
            if (requirements.resume !== 'not_needed' && resumeRef) {
                payload.resume = resumeRef;
            }
            if (requirements.coverLetter !== 'not_needed' && coverLetter.trim()) {
                payload.coverLetter = coverLetter.trim();
            }
            if (requirements.portfolio !== 'not_needed' && portfolioUrl.trim()) {
                payload.portfolioUrl = portfolioUrl.trim();
            }

            await api.post('/applications/apply', payload);

            // Phase 5A: the application just created changes the underlying count
            // data, so the shared counts entry for this job is now stale. Invalidate
            // it and await the refetch -- this page observes the same key, so the
            // rendered applicantCount (and any other observer) updates to the
            // incremented value. Same await-before-success pattern as PostJobForm
            // and EditJobForm.
            await queryClient.invalidateQueries({ queryKey: queryKeys.applicationCounts(uid) });
            await queryClient.invalidateQueries({ queryKey: queryKeys.employeeApplications(uid) });

            setApplied(true);
        } catch (err) {
            setError('Failed to submit application. Please try again.');
            console.error('Application failed:', err);
        } finally {
            applyInFlightRef.current = false;
            setApplying(false);
        }
    };

    if (jobQuery.isPending) {
        return <PageLoader label="Loading job details…" />;
    }

    if (jobQuery.isError) {
        return (
            <div className="min-h-screen bg-canvas">
                <PageContainer className="py-16">
                    <div className="mx-auto max-w-md">
                        <EmptyState
                            icon={AlertCircle}
                            title="Unable to load job"
                            description="This job could not be loaded. It may have been removed, or the connection may have failed."
                            action={
                                <Button
                                    onClick={() => jobQuery.refetch()}
                                    disabled={jobQuery.isFetching}
                                    aria-busy={jobQuery.isFetching}
                                >
                                    {jobQuery.isFetching ? 'Trying again…' : 'Try again'}
                                </Button>
                            }
                        />
                    </div>
                </PageContainer>
            </div>
        );
    }

    if (!job) {
        return (
            <div className="min-h-screen bg-canvas">
                <PageContainer className="py-16">
                    <div className="mx-auto max-w-md">
                        <EmptyState
                            icon={AlertCircle}
                            title="Job not found"
                            description="This job is no longer available."
                        />
                    </div>
                </PageContainer>
            </div>
        );
    }

    // Only derive job-dependent flags after the loading, error and missing-job
    // branches have returned, so an absent `job` can never be dereferenced.
    const isJobOpen   = job?.status === 'open';
    const isJobFilled = job?.status === 'filled' || job?.status === 'Filled';
    const isJobClosed = job?.status === 'closed' || job?.status === 'Closed';
    const isDeadlinePassed = daysLeft !== null && daysLeft < 0;

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={user} />

            <PageContainer className="py-8">
                <div className="space-y-6">
                    <PageHeader
                        title={job.title}
                        description={job.company}
                        actions={
                            <div className="text-left sm:text-right">
                                <p className="text-xl font-semibold text-foreground">
                                    <span className="text-success">₦</span> {job.price?.toLocaleString()}
                                </p>
                                <Badge
                                    variant={isNegotiable ? 'success' : 'neutral'}
                                    className="mt-1"
                                >
                                    {isNegotiable ? (
                                        <CheckCircle className="h-3.5 w-3.5" aria-hidden="true" />
                                    ) : (
                                        <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                                    )}
                                    {isNegotiable ? 'Negotiable' : 'Fixed price'}
                                </Badge>
                            </div>
                        }
                    />

                    {/* Job meta */}
                    <Card className="p-5 sm:p-6">
                        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-foreground-muted">
                            <span className="inline-flex items-center gap-2">
                                <MapPin className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                {job.location}
                            </span>
                            <span className="inline-flex items-center gap-2">
                                <Briefcase className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                <span className="capitalize">{job.jobType}</span>
                            </span>
                            <span className="inline-flex items-center gap-2">
                                <Users className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                {applicantCount} applicant{applicantCount !== 1 ? 's' : ''}
                            </span>
                            <span className="inline-flex items-center gap-2">
                                <Star className="h-4 w-4 text-warning" aria-hidden="true" />
                                {job.rating} rating
                            </span>
                        </div>

                        {(deadlineDate || startDate || endDate) && (
                            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-4 text-sm text-foreground-muted">
                                {deadlineDate && (
                                    <span className="inline-flex items-center gap-2">
                                        <Calendar className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                        <span>
                                            Apply by <span className="font-medium text-foreground">{deadlineDate}</span>
                                        </span>
                                        {deadlineBadge && (
                                            <Badge variant={deadlineVariant}>{deadlineBadge}</Badge>
                                        )}
                                    </span>
                                )}
                                {startDate && (
                                    <span className="inline-flex items-center gap-2">
                                        <Clock className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                        Starts {startDate}
                                    </span>
                                )}
                                {endDate && (
                                    <span className="inline-flex items-center gap-2">
                                        <Calendar className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                        Ends {endDate}
                                    </span>
                                )}
                            </div>
                        )}
                    </Card>

                    <div className="grid gap-6 lg:grid-cols-3">
                        {/* Left content */}
                        <div className="space-y-6 lg:col-span-2">
                            {/* Job Description */}
                            <Card as="section" className="p-5 sm:p-6">
                                <h2 className="text-base font-semibold text-foreground">
                                    Job description
                                </h2>
                                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground-muted">
                                    {job.description}
                                </p>
                            </Card>

                            {/* Skills Required */}
                            <Card as="section" className="p-5 sm:p-6">
                                <h2 className="text-base font-semibold text-foreground">
                                    Skills required
                                </h2>
                                <div className="mt-3 flex flex-wrap gap-1.5">
                                    {job.skillsRequired.map((req, index) => (
                                        <Badge key={index} variant="neutral">{req}</Badge>
                                    ))}
                                </div>
                            </Card>

                            {/* Basic Requirements */}
                            <Card as="section" className="p-5 sm:p-6">
                                <h2 className="text-base font-semibold text-foreground">
                                    Basic requirements
                                </h2>
                                <ul className="mt-3 space-y-2">
                                    {job.requirements.map((benefit, index) => (
                                        <li key={index} className="flex items-start gap-3">
                                            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                                            <span className="text-sm text-foreground-muted">{benefit}</span>
                                        </li>
                                    ))}
                                </ul>
                            </Card>

                            {/* Responsibilities */}
                            <Card as="section" className="p-5 sm:p-6">
                                <h2 className="text-base font-semibold text-foreground">
                                    Responsibilities
                                </h2>
                                <ul className="mt-3 space-y-2">
                                    {job.responsibilities.map((benefit, index) => (
                                        <li key={index} className="flex items-start gap-3">
                                            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
                                            <span className="text-sm text-foreground-muted">{benefit}</span>
                                        </li>
                                    ))}
                                </ul>
                            </Card>
                        </div>

                        {/* Application Sidebar */}
                        <aside className="lg:col-span-1">
                            <div className="lg:sticky lg:top-8">
                                <Card className="p-5 sm:p-6">
                                    {applied ? (
                                        <div className="text-center">
                                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-success-subtle text-success-subtle-foreground">
                                                <CheckCircle className="h-7 w-7" aria-hidden="true" />
                                            </div>
                                            <h2 className="text-base font-semibold text-foreground">
                                                Application submitted
                                            </h2>
                                            <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                                                Your application has been sent successfully. The employer will review it and get back to you soon.
                                            </p>
                                            <p className="mt-4 inline-flex items-center gap-2 rounded-md bg-accent-subtle px-3 py-2 text-xs text-accent-subtle-foreground">
                                                <Calendar className="h-4 w-4" aria-hidden="true" />
                                                Applied on {new Date().toLocaleDateString()}
                                            </p>
                                        </div>
                                    ) : (
                                        <>
                                            <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
                                                <Send className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                                Apply now
                                            </h2>

                                            { ( !isJobOpen || isDeadlinePassed ) && !applied && (
                                                <p className="text-sm text-foreground-muted mt-2">
                                                    {!isJobOpen
                                                        ? ( isJobFilled
                                                              ? 'This job is filled and no longer accepts applications.'
                                                              : isJobClosed
                                                                    ? 'Applications for this job are closed.'
                                                                    : '')
                                                        : isDeadlinePassed
                                                            ? 'The application deadline for this job has passed.'
                                                            : ''}
                                                </p>
                                            )}

                                            {error && (
                                                <div
                                                    role="alert"
                                                    className="mt-4 flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                                                >
                                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                                    <span>{error}</span>
                                                </div>
                                            )}

                                            <div className="mt-4 space-y-5">
                                                {isNegotiable && (
                                                    <Field
                                                        id="employeePrice"
                                                        label="Your proposed price"
                                                        hint="This job allows price negotiation. Enter your competitive rate."
                                                        required
                                                    >
                                                        <div className="relative">
                                                            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-foreground-subtle">
                                                                ₦
                                                            </span>
                                                            <Input
                                                                id="employeePrice"
                                                                type="number"
                                                                value={employeePrice}
                                                                onChange={(e) => setEmployeePrice(e.target.value)}
                                                                placeholder="Enter your price"
                                                                min="0"
                                                                className="pl-8"
                                                                required
                                                            />
                                                        </div>
                                                    </Field>
                                                )}

                                                {/* Cover message removed; cover letter is controlled by employer via applicationRequirements.coverLetter. */}

                                                {/* STAGE 12.13. Job-specific requirements. Each control
                                                    appears only when the job collects it; `required` marks
                                                    the ones the server refuses to do without, and handleApply
                                                    enforces them before the upload or the request. */}
                                                {requirements.resume !== 'not_needed' && (
                                                    <fieldset className="min-w-0 space-y-1.5">
                                                        <legend className="block text-sm font-medium text-foreground">
                                                            Resume
                                                            {requirements.resume === 'required' && (
                                                                <span className="ml-0.5 text-danger" aria-hidden="true">*</span>
                                                            )}
                                                        </legend>

                                                        <div className="space-y-3">
                                                            {savedResume && (
                                                                <label className="flex items-start gap-2 text-sm text-foreground">
                                                                    <input
                                                                        type="radio"
                                                                        name="resumeMode"
                                                                        className="mt-0.5"
                                                                        checked={effectiveResumeMode === 'saved'}
                                                                        onChange={() => {
                                                                            setResumeMode('saved');
                                                                            setResumeError('');
                                                                        }}
                                                                    />
                                                                    <span>
                                                                        Use my saved resume
                                                                        <span className="ml-1 text-foreground-muted">
                                                                            ({savedResume.name || 'resume.pdf'})
                                                                        </span>
                                                                    </span>
                                                                </label>
                                                            )}

                                                            <label className="flex items-start gap-2 text-sm text-foreground">
                                                                <input
                                                                    type="radio"
                                                                    name="resumeMode"
                                                                    className="mt-0.5"
                                                                    checked={effectiveResumeMode === 'upload'}
                                                                    onChange={() => {
                                                                        setResumeMode('upload');
                                                                        setResumeError('');
                                                                    }}
                                                                />
                                                                <span>Upload a new resume</span>
                                                            </label>

                                                            {effectiveResumeMode === 'upload' && (
                                                                <Input
                                                                    id="resume"
                                                                    type="file"
                                                                    accept="application/pdf,.pdf"
                                                                    aria-label="Choose resume PDF to upload"
                                                                    aria-invalid={resumeError ? 'true' : undefined}
                                                                    aria-describedby={resumeError ? 'resume-error' : 'resume-help'}
                                                                    onChange={(e) => {
                                                                        setResumeFile(e.target.files[0] || null);
                                                                        setResumeError('');
                                                                    }}
                                                                    className="file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
                                                                />
                                                            )}
                                                        </div>

                                                        {resumeError ? (
                                                            <p id="resume-error" role="alert" className="text-xs font-medium text-danger">{resumeError}</p>
                                                        ) : (
                                                            <p id="resume-help" className="text-xs text-foreground-subtle">
                                                                {requirements.resume === 'required'
                                                                    ? 'This job requires a resume (PDF).'
                                                                    : 'PDF, up to 5 MB. Optional.'}
                                                            </p>
                                                        )}
                                                    </fieldset>
                                                )}

                                                {requirements.coverLetter !== 'not_needed' && (
                                                    <Field
                                                        id="coverLetter"
                                                        label="Cover letter"
                                                        required={requirements.coverLetter === 'required'}
                                                        hint="A letter to the employer about your fit for this job."
                                                    >
                                                        <Textarea
                                                            id="coverLetter"
                                                            value={coverLetter}
                                                            onChange={(e) => setCoverLetter(e.target.value)}
                                                            placeholder="Introduce yourself and explain why you are a good fit…"
                                                            rows={5}
                                                            maxLength={3000}
                                                        />
                                                    </Field>
                                                )}

                                                {requirements.portfolio !== 'not_needed' && (
                                                    <Field
                                                        id="portfolioUrl"
                                                        label="Portfolio URL"
                                                        required={requirements.portfolio === 'required'}
                                                        hint="A link to your portfolio or relevant work (http:// or https://)."
                                                    >
                                                        <Input
                                                            id="portfolioUrl"
                                                            type="url"
                                                            value={portfolioUrl}
                                                            onChange={(e) => setPortfolioUrl(e.target.value)}
                                                            placeholder="https://example.com/portfolio"
                                                        />
                                                    </Field>
                                                )}

                                                <Button
                                                    type="button"
                                                    size="lg"
                                                    className="w-full"
                                                    onClick={handleApply}
                                                    disabled={applying || !user || !isJobOpen || isDeadlinePassed}
                                                    aria-busy={applying}
                                                >
                                                    {applying ? (
                                                        <>
                                                            <Clock className="h-4 w-4 animate-spin" aria-hidden="true" />
                                                            Submitting…
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Send className="h-4 w-4" aria-hidden="true" />
                                                            Submit application
                                                        </>
                                                    )}
                                                </Button>

                                                {!user && (
                                                    <p className="rounded-md border border-warning-subtle bg-warning-subtle px-3 py-2 text-center text-xs font-medium text-warning-subtle-foreground">
                                                        You must be logged in to apply for jobs.
                                                    </p>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </Card>
                            </div>
                        </aside>
                    </div>
                </div>
            </PageContainer>
        </div>
    );
};

export default JobDetails;