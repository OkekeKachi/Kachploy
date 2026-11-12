import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import api, { completeEmployment, terminateEmployment, recordEmploymentSettlement, createReview } from '../api';
import { apiErrorMessage } from '../apiErrorMessage';
import { Users, MapPin, Calendar, ArrowLeft, Briefcase, AlertCircle } from 'lucide-react';
import AppNavbar from '../components/AppNavbar';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { PageLoader } from '../components/ui/Spinner';
import { dateLabel, employmentStatusLabel } from '../components/taskPresentation';
import { useUserQuery } from '../useUserQuery';
import { isEmployerReviewEligible } from '../reviewEligibility';

/**
 * STAGE 10H.3. The employer's employee list for ONE job.
 *
 * WHAT THIS PAGE IS. The recruitment side of a job -- who applied, who was
 * cleared, who was hired or rejected -- stays on ViewJobApplications.jsx. This
 * page is the other half, deliberately separate: it lists the people who were
 * actually HIRED for the job, one row per employment, and nothing about
 * applicants. A job can have more than one employee, so the list is a list; it is
 * never written as if there were exactly one.
 *
 * WHERE THE ROWS COME FROM. GET /employments/job/:jobId -- the Stage 10H.1 read,
 * guarded server-side by requireJobOwner, which answers only for the employer who
 * posted the job. The page adds no endpoint and does no filtering of its own: the
 * server has already decided which employments this reader may see. The response
 * is `{ employments: [{ id, ...document }] }`, and the document carries exactly the
 * fields this page renders -- employeeId, status, startDate, endDate. There is no
 * job title in an employment, so the title comes from the route param, the same way
 * ViewJobApplications takes it.
 *
 * EMPLOYEE IDENTITY. An employment stores `employeeId`, a uid, not a name. The only
 * cross-user read the client may make is GET /users/getUser/:userId, which is
 * protect-only and projects a public profile (fullName, profilePic, location,
 * ...). So the name and picture are fetched once PER DISTINCT employee -- not once
 * per row -- exactly the deduplicated lookup HiredJobs.jsx uses for employer names.
 * A profile that cannot be read leaves the row showing the uid as its identity
 * rather than dropping the employee, and the page says some names were unavailable.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. No task assignment, no messaging, no ending an
 * employment, no applicant data. Those are other stages; adding them here would be
 * building on a page whose job is to show who was hired.
 */

/**
 * Oldest hire first, then by document id.
 *
 * The server query is a bare `where('jobId', '==', jobId)` with no orderBy, so the
 * order it returns carries no meaning to a reader. `startDate` reaches the client in
 * either of its two shapes -- the job's own ISO string, or a serverTimestamp()
 * Timestamp when the job had no start date -- so both are decoded here. A missing or
 * unreadable date sorts last, so a damaged record cannot push the real hires down.
 */
const startDateSortValue = (employment) => {
    const value = employment.startDate;
    let millis;

    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        millis = value._seconds * 1000;
    } else if (typeof value === 'string' && value) {
        millis = new Date(value).getTime();
    }

    return typeof millis === 'number' && !Number.isNaN(millis) ? millis : Number.MAX_SAFE_INTEGER;
};

const sortEmployments = (list) =>
    [...list].sort((a, b) => {
        const difference = startDateSortValue(a) - startDateSortValue(b);

        if (difference !== 0) return difference;

        return String(a.id || '').localeCompare(String(b.id || ''));
    });

const getInitials = (fullName) => {
    if (!fullName) return '?';

    const names = fullName.trim().split(/\s+/);
    const first = names[0]?.charAt(0) || '';
    const last = names.length > 1 ? names[names.length - 1].charAt(0) : '';

    return (first + last).toUpperCase() || '?';
};

// STAGE 11.11: employment status -> shared Badge variant
const employmentStatusBadgeVariant = (employment) => {
    const status = employment && typeof employment.status === 'string' ? employment.status : '';
    if (status === 'active') return 'success';
    if (status === 'completed') return 'info';
    if (status === 'terminated') return 'warning';
    if (status === 'ended') return 'neutral';
    return 'neutral';
};

/*
    A <Link> styled as a Button, matching HiredJobs.jsx. The back link is a
    destination, so it keeps its anchor semantics (middle-click / open-in-new-tab)
    rather than becoming a <button>.
*/
const ActionLink = ({ to, variant = 'secondary', className = '', children }) => {
    const variants = {
        primary: 'border-transparent bg-accent text-foreground-inverse hover:bg-accent-hover',
        secondary: 'border-border-strong bg-surface text-foreground hover:bg-surface-muted',
    };

    return (
        <Link
            to={to}
            className={`inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${variants[variant]} ${className}`}
        >
            {children}
        </Link>
    );
};

const EmployeeCard = ({ employment, profile, jobId, job }) => {
    const name = (profile && profile.fullName) || employment.employeeId || 'Employee name unavailable';
    const [msg, setMsg] = useState('');
    const [err, setErr] = useState('');

    // The whole card opens the read-only workspace for THIS employment (Stage
    // 10H.4.1). The link is keyed on the employment's own id, not the employee's,
    // because one person can hold several employments and each has its own page.
    return (
        <Card as="li" className="p-5 sm:p-6">
            <Link
                to={`/employer/jobs/${jobId}/employments/${employment.id}`}
                className="flex flex-col gap-4 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas sm:flex-row sm:items-center"
            >
            {profile && profile.profilePic ? (
                <img
                    src={profile.profilePic}
                    alt={profile.fullName || 'Employee'}
                    className="h-14 w-14 flex-shrink-0 rounded-full object-cover"
                />
            ) : (
                <div className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-full bg-accent">
                    <span className="font-semibold text-foreground-inverse">
                        {getInitials(profile && profile.fullName)}
                    </span>
                </div>
            )}

            <div className="min-w-0 flex-1">
                <div className="mb-2 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h3 className="truncate text-lg font-semibold text-foreground">{name}</h3>
                        {profile && profile.location && (
                            <p className="mt-1 flex items-center text-sm text-foreground-muted">
                                <MapPin className="mr-1 h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                {profile.location}
                            </p>
                        )}
                    </div>
                    <Badge variant={employmentStatusBadgeVariant(employment)}>
                        {employmentStatusLabel(employment)}
                    </Badge>
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-foreground-muted">
                    <span className="flex items-center">
                        <Calendar className="mr-2 h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                        Started {dateLabel(employment.startDate)}
                    </span>
                    {employment.endDate && (
                        <span className="flex items-center">
                            <Calendar className="mr-2 h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                            Ended {dateLabel(employment.endDate)}
                        </span>
                    )}
                </div>
            </div>
            </Link>
            {employment.status === 'active' && (
                <div className="mt-3 flex flex-wrap gap-2">
                    <Button className="h-8 px-2 text-xs" onClick={async (e) => { e.preventDefault(); setMsg(''); setErr(''); try { await completeEmployment(employment.id, {}); setMsg('Completed'); window.location.reload(); } catch (ex) { setErr(apiErrorMessage(ex, 'Failed')); } }}>Complete</Button>
                    <Button className="h-8 px-2 text-xs" onClick={async (e) => { e.preventDefault(); const reason = prompt('Termination reason'); if (!reason) return; setMsg(''); setErr(''); try { await terminateEmployment(employment.id, { reason }); setMsg('Terminated'); window.location.reload(); } catch (ex) { setErr(apiErrorMessage(ex, 'Failed')); } }}>Terminate</Button>
                    <Button className="h-8 px-2 text-xs" onClick={async (e) => { e.preventDefault(); try { await recordEmploymentSettlement(employment.id, {}); setMsg('Settlement recorded'); } catch (ex) { setErr(apiErrorMessage(ex, 'Failed')); } }}>Record Settlement</Button>
                </div>
            )}
            {isEmployerReviewEligible(employment, job) && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <input className="rounded-md border border-border px-2 py-1 text-xs" placeholder="Review comment" id={`rc-${employment.id}`} />
                    <select className="rounded-md border border-border px-2 py-1 text-xs" id={`rr-${employment.id}`} defaultValue="5">
                        {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                    <Button className="h-8 px-2 text-xs" onClick={async (e) => { e.preventDefault(); const c = document.getElementById(`rc-${employment.id}`).value; const r = Number(document.getElementById(`rr-${employment.id}`).value); setMsg(''); setErr(''); try { await createReview(employment.id, { revieweeId: employment.employeeId, rating: r, comment: c }); setMsg('Review submitted'); } catch (ex) { setErr(apiErrorMessage(ex, 'Failed')); } }}>Review Employee</Button>
                </div>
            )}
            {msg && <p className="mt-1 text-xs text-success">{msg}</p>}
            {err && <p className="mt-1 text-xs text-danger">{err}</p>}
        </Card>
    );
};

const ManageEmployees = () => {
    const { jobId, jobTitle } = useParams();

    // Phase 5A of the data-fetching audit: the signed-in employer read for the
    // navbar is the shared identity query (useUserQuery.js) instead of a
    // per-mount GET /users/getUser issued inside the effect below. `user` is the
    // same document the old `setUser` held, so the navbar is unchanged.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);
    const user = userQuery.data || {};
    const [employments, setEmployments] = useState([]);
    const [job, setJob] = useState(null);
    const [jobForJobId, setJobForJobId] = useState(null);
    // employeeId -> public profile. One entry per distinct employee, never per row.
    const [employeeProfiles, setEmployeeProfiles] = useState({});
    const [profilesUnavailable, setProfilesUnavailable] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    // A refusal or a missing job is not a page failure -- it is "this address is
    // not one of your jobs". The server answers 403 for a job the caller did not
    // post and 404 for a job that does not exist; both are handled here as one
    // graceful state rather than a raw error.
    const [unavailable, setUnavailable] = useState(false);

    useEffect(() => {
        let cancelled = false;

        setEmployments([]);
        setJob(null);
        setJobForJobId(null);
        setEmployeeProfiles({});
        setProfilesUnavailable(false);
        setIsLoading(true);
        setError('');
        setUnavailable(false);

        const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
            if (!authUser) {
                // ProtectedRoute normally turns an anonymous visitor away, but the
                // session can still resolve empty after that render.
                if (!cancelled) setIsLoading(false);
                return;
            }

            // The spine: the employees hired for this job. `loading` is released as
            // soon as it lands, so the rows appear before the name lookups below
            // finish -- the same progressive shape HiredJobs.jsx uses.
            let rows = [];

            try {
                const res = await api.get(`/employments/job/${jobId}`);
                if (cancelled) return;
                rows = res.data.employments || [];
                setEmployments(rows);
                setError('');
            } catch (err) {
                console.error('Error fetching employments for job:', err);
                if (cancelled) return;

                const status = err.response && err.response.status;

                if (status === 403 || status === 404) {
                    setUnavailable(true);
                } else {
                    setError('The employees for this job could not be loaded. Please reload the page to try again.');
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }

            try {
                const jobRes = await api.get(`/jobs/${jobId}`);
                if (!cancelled) {
                    setJob(jobRes.data.job || null);
                    setJobForJobId(jobId);
                }
            } catch (err) {
                console.error('Error fetching job for review eligibility:', err);
                if (!cancelled) {
                    setJob(null);
                    setJobForJobId(jobId);
                }
            }

            if (cancelled || rows.length === 0) return;

            // Employee names, one request per DISTINCT employee. Each lookup carries
            // its own try/catch so one unreadable profile leaves every other row with
            // a name.
            const employeeIds = [...new Set(rows.map((row) => row.employeeId).filter(Boolean))];

            const lookups = await Promise.all(
                employeeIds.map(async (employeeId) => {
                    try {
                        const res = await api.get(`/users/getUser/${employeeId}`);
                        return { employeeId, profile: res.data.user || {}, failed: false };
                    } catch (err) {
                        console.error('Error fetching employee profile:', err);
                        return { employeeId, profile: {}, failed: true };
                    }
                })
            );

            if (cancelled) return;

            const profiles = {};
            lookups.forEach((lookup) => {
                profiles[lookup.employeeId] = lookup.profile;
            });

            setEmployeeProfiles(profiles);
            // Only a failed READ is reported; a profile with no fullName is not an
            // error, the row simply falls back to the employee's id.
            setProfilesUnavailable(lookups.some((lookup) => lookup.failed));
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, [jobId]);

    if (isLoading) {
        return <PageLoader label="Loading employees…" />;
    }

    const sorted = sortEmployments(employments);

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={user} />

            <PageContainer className="py-8">
                <div className="space-y-6">
                    <PageHeader
                        title="Employees"
                        description={jobTitle ? `Hired for "${jobTitle}"` : 'Hired for this job'}
                    />

                    <ActionLink to="/my-jobs" variant="secondary">
                        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                        Back to My Jobs
                    </ActionLink>

                    {error && (
                        <div
                            role="alert"
                            className="flex items-start gap-2 rounded-md bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                        >
                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <span>{error}</span>
                        </div>
                    )}

                    {unavailable ? (
                        <EmptyState
                            icon={Briefcase}
                            title="These employees are not available"
                            description="This job could not be found, or it is not one you posted. Its employees cannot be shown."
                        />
                    ) : sorted.length === 0 ? (
                        <EmptyState
                            icon={Users}
                            title="No employees hired yet"
                            description="Nobody has been hired for this job. Once you hire an applicant, they will appear here."
                        />
                    ) : (
                        <div className="space-y-4">
                            <h2 className="text-lg font-semibold text-foreground">
                                Employees ({sorted.length})
                            </h2>

                            {profilesUnavailable && (
                                <div
                                    role="alert"
                                    className="flex items-start gap-2 rounded-md bg-warning-subtle px-4 py-3 text-sm text-warning-subtle-foreground"
                                >
                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                    <span>
                                        Some employee names could not be loaded, so those rows show the
                                        employee&apos;s id instead.
                                    </span>
                                </div>
                            )}

                            <ul className="space-y-4 list-none p-0">
                                {sorted.map((employment) => (
                                    <EmployeeCard
                                        key={employment.id || employment.applicationId || employment.employeeId}
                                        employment={employment}
                                        profile={employeeProfiles[employment.employeeId]}
                                        jobId={jobId}
                                        job={jobForJobId === jobId ? job : null}
                                    />
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </PageContainer>
        </div>
    );
};

export default ManageEmployees;
