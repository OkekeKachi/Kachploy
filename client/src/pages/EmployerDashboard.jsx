import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../firebase';
import api from '../api';
import { Plus, Users, MapPin, Calendar, DollarSign, Edit3, Trash2, Eye, Building2, Search, Briefcase, TrendingUp, AlertCircle } from 'lucide-react';
import AppNavbar from '../components/AppNavbar';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { PageLoader } from '../components/ui/Spinner';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { Input, Select } from '../components/ui/Field';
import { useUserQuery } from '../useUserQuery';
import { useEmployerJobsQuery, useApplicationCountsQuery, useEmployerEmploymentsQuery } from '../useEmployerQueries';
import queryKeys from '../queryKeys';

const EmployerDashboard = () => {
    const [profilePic, setProfilePic] = useState('');
    const [name, setName] = useState('User');
    const [user, setUser] = useState({})
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const navigate = useNavigate();
    const queryClient = useQueryClient();

    // Phases 1-2 of the data-fetching audit: the identity half of the old chain
    // below is the shared identity query, keyed by uid (see useUserQuery). On
    // /dashboard RoleBasedDashboard warms the same cache entry before this page
    // mounts, so the duplicate GET /users/getUser/:uid that used to follow is
    // gone; standalone visits still read the document once and reuse it.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);

    // The missing-session redirect, kept as its own effect exactly as the old
    // chain's first check did.
    useEffect(() => {
        if (!auth.currentUser) {
            navigate('/login');
        }
    }, [navigate]);

    // Identity-derived state and the profile-completion redirect -- steps 1 of
    // the old sequential chain. Stage 6R's condition (!profileComplete) and
    // destination (/complete-profile) are unchanged.
    useEffect(() => {
        const userData = userQuery.data;
        if (!userData) return;

        setProfilePic(userData.profilePic);
        setName(userData.fullName);
        setUser(userData);

        if (!userData.profileComplete) {
            navigate('/complete-profile');
        }
    }, [userQuery.data, navigate]);

    // The posted-jobs chain, gated on the identity read having settled AND the
    // profile being complete -- the same sequencing the old sequential awaits
    // had: jobs were never requested before the identity read returned, nor for
    // an incomplete profile. A failed identity read leaves the gate shut and
    // the loader up, exactly as the old catch-and-log path left it.
    const identityReady =
        userQuery.isSuccess && Boolean(userQuery.data && userQuery.data.profileComplete);

    // Phase 3 of the data-fetching audit: the three reads the old effect
    // chained are shared queries now (see useEmployerQueries). They stay gated
    // on identityReady, so nothing under this page fetches before the
    // identity/profile check, and MyJobs observes the same cache entries when
    // this page is visited first.
    const jobsQuery = useEmployerJobsQuery(uid, { enabled: identityReady });
    const countsQuery = useApplicationCountsQuery(uid, { enabled: identityReady });
    const employmentsQuery = useEmployerEmploymentsQuery(uid, { enabled: identityReady });

    const handleDeleteJob = async (jobId) => {
        try {
            const response = await api.delete(`/jobs/${jobId}`);
            if (response.status === 200) {
                // The list is query data now, so the row is removed from the
                // cache directly -- the same immediate local removal the old
                // setJobs/setFilteredJobs filter did, with no refetch. The
                // counts and employments entries are left alone, exactly as
                // the old local filter left the other two arrays.
                queryClient.setQueryData(queryKeys.employerJobs(uid), (prev) =>
                    (prev || []).filter((job) => job.id !== jobId)
                );
            } else {
                console.error('Failed to delete job');
            }
        } catch (err) {
            console.error('Error deleting job:', err);
        }
    };

    const handlePostJob = () => {
        navigate("/post-job")
    };

    const handleEditJob = (jobId) => {
        navigate(`/edit-job/${jobId}`)
    };

    const handleViewApplications = (jobId, jobTitle) => {
        // STAGE 6F. Navigates to the route ViewJobApplications is registered on.
        // The title is encoded because it is a path segment: job titles contain
        // spaces and may contain '/', '?' or '#', any of which would otherwise
        // truncate or break the path. React Router decodes params on the way back
        // out, so ViewJobApplications' useParams() still receives the exact title.
        navigate(`/employer/jobs/${jobId}/applications/${encodeURIComponent(jobTitle)}`);
    };

    // STAGE 10H.3. Opens the employee list for one job -- the sibling of
    // handleViewApplications above, on the same route shape with `employees` in
    // place of `applications`.
    const handleManageEmployees = (jobId, jobTitle) => {
        navigate(`/employer/jobs/${jobId}/employees/${encodeURIComponent(jobTitle)}`);
    };

    // STAGE 5G. The canonical job statuses are `open`, `filled` and `closed`.
    // The hire flow used to write the title-cased `Filled`, which none of the
    // comparisons in this file matched, so a filled job counted as neither open
    // nor closed and fell through every filter and the badge to the grey default.
    // `Filled` is what existing documents hold, so it is still read as filled.
    const isJobFilled = (status) => status === 'filled' || status === 'Filled';

    const JOB_STATUS_LABEL = {
        open: 'Open',
        filled: 'Filled',
        closed: 'Closed',
    };

    const jobStatusLabel = (status) => {
        if (isJobFilled(status)) return JOB_STATUS_LABEL.filled;
        return JOB_STATUS_LABEL[status] || status;
    };

    // STAGE 11.2. Status -> shared Badge variant, replacing the local
    // getStatusBadge class-string helper so badge styling lives in one place.
    const jobStatusBadgeVariant = (status) => {
        if (isJobFilled(status)) return 'primary';
        if (status === 'open') return 'success';
        if (status === 'closed') return 'danger';
        return 'neutral';
    };

    // Phase 3: the posted-jobs list with the per-job counts merged in -- the
    // same mapping the old effect performed after its sequential chain, now a
    // render-time derivation over the query data. A counts or employments read
    // that failed (or has not landed) contributes 0, exactly as the old
    // catch-to-{} paths did.
    const jobList = jobsQuery.data || [];
    const counts = countsQuery.data || {};
    const employmentCounts = {};
    (employmentsQuery.data || []).forEach((employment) => {
        if (!employment.jobId) return;
        employmentCounts[employment.jobId] = (employmentCounts[employment.jobId] || 0) + 1;
    });
    const jobs = jobList.map((job) => ({
        ...job,
        applicantCount: counts[job.id] || 0,
        employeeCount: employmentCounts[job.id] || 0,
    }));

    // Filter jobs based on search and status -- the old effect's logic as a
    // derivation, so the visible list is current on the same render the query
    // data changes.
    let filteredJobs = jobs;
    if (searchTerm) {
        filteredJobs = filteredJobs.filter(job =>
            job.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
            job.location.toLowerCase().includes(searchTerm.toLowerCase())
        );
    }
    if (statusFilter !== 'all') {
        // Stage 5G: 'filled' must also match a legacy title-cased 'Filled',
        // which is what documents created by the old hire flow carry.
        filteredJobs = filteredJobs.filter(job =>
            statusFilter === 'filled' ? isJobFilled(job.status) : job.status === statusFilter
        );
    }

    const totalJobs = jobs.length;
    const openJobs = jobs.filter(job => job.status === 'open').length;
    const totalApplicants = jobs.reduce((sum, job) => sum + job.applicantCount, 0);

    const summaryStats = [
        { label: 'Total jobs', value: totalJobs, icon: Briefcase },
        { label: 'Active jobs', value: openJobs, icon: TrendingUp, valueClass: 'text-success' },
        { label: 'Total applications', value: totalApplicants, icon: Users, valueClass: 'text-accent' },
    ];

    // A jobs failure with no cached list gets an explicit error screen instead
    // of the loader the old chain left up for good. A failure on top of cached
    // data (a background revalidation that failed) keeps the list visible, as
    // react-query keeps the last successful data.
    const jobsFailed = identityReady && jobsQuery.isError && !jobsQuery.data;

    if (jobsFailed) {
        return (
            <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
                <div className="w-full max-w-md">
                    <EmptyState
                        icon={AlertCircle}
                        title="Your dashboard could not be loaded"
                        description="We could not load your job postings just now. Please try again."
                        action={
                            <Button
                                onClick={() => {
                                    jobsQuery.refetch();
                                    countsQuery.refetch();
                                    employmentsQuery.refetch();
                                }}
                            >
                                Try again
                            </Button>
                        }
                    />
                </div>
            </div>
        );
    }

    // The old isLoading released only after identity AND the whole jobs/counts/
    // employments chain had settled, with counts/employments failures settling
    // through their inner catches. Same rule: the loader releases once none of
    // the three queries is still waiting for a first result.
    const employerDataPending =
        !identityReady || jobsQuery.isPending || countsQuery.isPending || employmentsQuery.isPending;

    if (employerDataPending) {
        return <PageLoader label="Loading your dashboard…" />;
    }

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={user} />

            <PageContainer className="space-y-8 py-8">
                {/* Header */}
                <PageHeader
                    title="Dashboard"
                    description="Manage your job postings and applications."
                    actions={
                        <div className="flex items-center gap-3">
                            <div className="hidden items-center gap-2 sm:flex">
                                {profilePic ? (
                                    <img
                                        src={profilePic}
                                        alt=""
                                        className="h-9 w-9 rounded-full object-cover"
                                    />
                                ) : (
                                    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-subtle text-accent-subtle-foreground">
                                        <Building2 className="h-4 w-4" aria-hidden="true" />
                                    </span>
                                )}
                                <span className="max-w-[12rem] truncate text-sm font-medium text-foreground">
                                    {name}
                                </span>
                            </div>
                            <Button onClick={handlePostJob}>
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                Post a job
                            </Button>
                        </div>
                    }
                />

                {/* Summary cards */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                    {summaryStats.map((stat) => {
                        const Icon = stat.icon;
                        return (
                            <Card key={stat.label} className="flex items-center justify-between p-5">
                                <div>
                                    <p className="text-sm font-medium text-foreground-muted">{stat.label}</p>
                                    <p className={`mt-1 text-3xl font-semibold ${stat.valueClass || 'text-foreground'}`}>
                                        {stat.value}
                                    </p>
                                </div>
                                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted text-foreground-muted">
                                    <Icon className="h-5 w-5" aria-hidden="true" />
                                </span>
                            </Card>
                        );
                    })}
                </div>

                {/* Search and status filter */}
                <Card className="p-4 sm:p-5">
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <div className="relative flex-1">
                            <Search
                                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle"
                                aria-hidden="true"
                            />
                            <Input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder="Search jobs by title or location"
                                aria-label="Search jobs by title or location"
                                className="pl-9"
                            />
                        </div>
                        <div className="sm:w-48">
                            <Select
                                value={statusFilter}
                                onChange={(e) => setStatusFilter(e.target.value)}
                                aria-label="Filter jobs by status"
                            >
                                <option value="all">All statuses</option>
                                <option value="open">Open</option>
                                <option value="filled">Filled</option>
                                <option value="closed">Closed</option>
                            </Select>
                        </div>
                    </div>
                </Card>

                {/* Job postings */}
                <section className="space-y-4">
                    <div className="flex items-baseline justify-between gap-4">
                        <h2 className="text-lg font-semibold text-foreground">Your job postings</h2>
                        <span className="text-sm text-foreground-subtle">
                            {filteredJobs.length} of {jobs.length}
                        </span>
                    </div>

                    {filteredJobs.length === 0 ? (
                        jobs.length === 0 ? (
                            <EmptyState
                                icon={Briefcase}
                                title="No jobs posted yet"
                                description="Post your first job to start receiving applications from candidates."
                                action={
                                    <Button onClick={handlePostJob}>
                                        <Plus className="h-4 w-4" aria-hidden="true" />
                                        Post your first job
                                    </Button>
                                }
                            />
                        ) : (
                            <EmptyState
                                icon={Search}
                                title="No jobs match your filters"
                                description="Try a different search term or status, or clear the filters to see all of your postings."
                                action={
                                    <Button
                                        variant="secondary"
                                        onClick={() => {
                                            setSearchTerm('');
                                            setStatusFilter('all');
                                        }}
                                    >
                                        Clear filters
                                    </Button>
                                }
                            />
                        )
                    ) : (
                        <ul className="space-y-4">
                            {filteredJobs.map((job) => (
                                <Card as="li" key={job.id} className="p-5 sm:p-6">
                                    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                                        <div className="min-w-0 flex-1 space-y-3">
                                            <div className="flex flex-wrap items-center gap-2">
                                                <h3 className="text-lg font-semibold text-foreground">{job.title}</h3>
                                                <Badge variant={jobStatusBadgeVariant(job.status)}>
                                                    {jobStatusLabel(job.status)}
                                                </Badge>
                                            </div>

                                            <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm text-foreground-muted sm:grid-cols-2">
                                                <div className="flex items-center gap-2">
                                                    <MapPin className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                    <span>{job.location}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Calendar className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                    <span>{new Date(job.createdAt).toLocaleDateString()}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <DollarSign className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                    <span className="font-medium text-foreground">₦{job.price?.toLocaleString()}</span>
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <Users className="h-4 w-4 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                                    <span>
                                                        {job.applicantCount} applicant{job.applicantCount !== 1 ? 's' : ''}
                                                    </span>
                                                </div>
                                            </div>

                                            <p className="line-clamp-2 text-sm text-foreground-muted">{job.description}</p>

                                            <div className="flex flex-wrap items-center gap-2">
                                                {job.jobType && <Badge variant="neutral">{job.jobType}</Badge>}
                                                {job.employeeCount > 0 && (
                                                    <Badge variant="info">
                                                        {job.employeeCount} hired
                                                    </Badge>
                                                )}
                                            </div>
                                        </div>

                                        {/* Actions */}
                                        <div className="flex flex-wrap gap-2 lg:w-52 lg:shrink-0 lg:flex-col">
                                            <Button
                                                variant="secondary"
                                                size="sm"
                                                onClick={() => handleEditJob(job.id)}
                                                disabled={job.applicantCount > 0}
                                                className="flex-1 lg:w-full"
                                            >
                                                <Edit3 className="h-4 w-4" aria-hidden="true" />
                                                Edit
                                            </Button>

                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                onClick={() => handleDeleteJob(job.id)}
                                                disabled={job.applicantCount > 0}
                                                className="flex-1 lg:w-full"
                                            >
                                                <Trash2 className="h-4 w-4" aria-hidden="true" />
                                                Delete
                                            </Button>

                                            {/* STAGE 5G/10C: a filled job's control navigates
                                                to its applicants (where the hired applicant and
                                                task assignment live) rather than being disabled;
                                                a closed job remains disabled. */}
                                            {job.status === 'open' ? (
                                                <Button
                                                    size="sm"
                                                    onClick={() => handleViewApplications(job.id, job.title)}
                                                    className="min-w-fit flex-1 whitespace-nowrap lg:w-full"
                                                >
                                                    <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                    View applications
                                                </Button>
                                            ) : isJobFilled(job.status) ? (
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => handleViewApplications(job.id, job.title)}
                                                    className="min-w-fit flex-1 whitespace-nowrap lg:w-full"
                                                >
                                                    <Eye className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                    View applicants
                                                </Button>
                                            ) : (
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    disabled
                                                    className="flex-1 lg:w-full"
                                                >
                                                    <Eye className="h-4 w-4" aria-hidden="true" />
                                                    Closed
                                                </Button>
                                            )}

                                            {/* STAGE 10H.3: a second, additive action, shown only
                                                when the job has already hired someone. */}
                                            {job.employeeCount > 0 && (
                                                <Button
                                                    variant="secondary"
                                                    size="sm"
                                                    onClick={() => handleManageEmployees(job.id, job.title)}
                                                    className="min-w-fit flex-1 whitespace-nowrap lg:w-full"
                                                >
                                                    <Users className="h-4 w-4 shrink-0" aria-hidden="true" />
                                                    Manage employees ({job.employeeCount})
                                                </Button>
                                            )}
                                        </div>
                                    </div>
                                </Card>
                            ))}
                        </ul>
                    )}
                </section>
            </PageContainer>
        </div>
    );
};

export default EmployerDashboard;
