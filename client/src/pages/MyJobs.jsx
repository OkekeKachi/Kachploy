import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import { onAuthStateChanged } from 'firebase/auth';
import api from '../api';
import {
    Plus,
    Users,
    MapPin,
    Calendar,
    DollarSign,
    Edit3,
    Trash2,
    Eye,
    Briefcase,
    Building2,
} from 'lucide-react';
import EmployerNavbar from '../components/EmployerNavbar';

/**
 * STAGE 6E: the employer's own posted-jobs list, at `/my-jobs`.
 *
 * WHO OWNS THE LIST
 *   The uid is read from the verified auth session and is never taken from the
 *   URL, a query string or a field. The route takes no parameter at all, so there
 *   is nothing to edit. The server then scopes the read independently:
 *   GET /jobs/employer/:uid is guarded by requireSelfParam('uid'), and
 *   jobRepository.listJobsByEmployer filters `where('postedBy', '==', uid)`. Two
 *   independent layers, and this page only ever requests its own uid.
 *
 * DATA
 *   GET /jobs/employer/:uid for the jobs, plus the count-only
 *   GET /applications/counts for per-job applicant totals. That is the Stage 5B
 *   arrangement EmployerDashboard already uses -- one count read instead of a
 *   per-job GET /applications/job/:jobId fan-out -- so this page makes the same
 *   two requests rather than inventing a third way to count. A counts failure
 *   degrades every job to 0 applicants, exactly as it does there.
 *
 * JOB STATUS
 *   `open`, `filled` and `closed` are the statuses that have writers. Legacy
 *   title-cased `Filled` is still read as filled, because documents written by the
 *   old hire flow carry it and there is no migration. This mirrors the Stage 5G
 *   helpers in EmployerDashboard.jsx; they are duplicated rather than imported
 *   because that file keeps them local, and extracting them would mean editing a
 *   page outside this stage's scope.
 *
 * WHY THERE IS NO SEARCH OR FILTER HERE
 *   EmployerDashboard has both, but as component-local state inside that file.
 *   There is no shared filter module to reuse, and pulling one out would mean
 *   refactoring a page this stage does not touch. `/my-jobs` is the plain list;
 *   the searchable view stays where it already is.
 */

const MyJobs = () => {
    const [user, setUser] = useState({});
    const [jobs, setJobs] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');
    // Per-row delete progress, so one row's in-flight request cannot be mistaken
    // for another's.
    const [deletingId, setDeletingId] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        let cancelled = false;

        const unsubscribe = onAuthStateChanged(auth, async (authUser) => {
            if (!authUser) {
                if (!cancelled) setIsLoading(false);
                return;
            }

            try {
                const userRes = await api.get(`/users/getUser/${authUser.uid}`);
                if (cancelled) return;
                setUser(userRes.data.user || {});

                const jobsRes = await api.get(`/jobs/employer/${authUser.uid}`);
                if (cancelled) return;
                const jobList = jobsRes.data.jobs || [];

                // Same count-only read EmployerDashboard uses. A failure here is
                // logged and leaves every count at 0 rather than failing the page.
                let counts = {};
                try {
                    const countsRes = await api.get('/applications/counts');
                    counts = countsRes.data.counts || {};
                } catch (err) {
                    console.error('Error fetching application counts:', err);
                }

                if (cancelled) return;
                setJobs(jobList.map((job) => ({ ...job, applicantCount: counts[job.id] || 0 })));
                setError('');
            } catch (err) {
                console.error('Error loading jobs:', err);
                if (!cancelled) {
                    setError('Your jobs could not be loaded. Please reload the page to try again.');
                }
            } finally {
                if (!cancelled) setIsLoading(false);
            }
        });

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    // STAGE 5G. Legacy documents carry the title-cased `Filled`, which no plain
    // equality check matches, so it would fall through to the grey default badge.
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

    const getStatusBadge = (status) => {
        const baseClasses = 'px-3 py-1 rounded-full text-xs font-semibold';
        switch (status) {
            case 'open':
                return `${baseClasses} bg-green-100 text-green-800`;
            case 'closed':
                return `${baseClasses} bg-red-100 text-red-800`;
            case 'filled':
            case 'Filled':
                return `${baseClasses} bg-blue-100 text-blue-800`;
            default:
                return `${baseClasses} bg-gray-100 text-gray-800`;
        }
    };

    /** Price is optional in the job document, so it is rendered only when present. */
    const priceLabel = (price) => {
        if (price === null || price === undefined || price === '') return 'Not set';
        const amount = Number(price);
        return Number.isNaN(amount) ? String(price) : amount.toLocaleString();
    };

    const handleDeleteJob = async (job) => {
        // Destructive and immediate, so it is confirmed before it runs.
        const confirmed = window.confirm(
            `Delete "${job.title}"? This cannot be undone.`
        );
        if (!confirmed) return;

        setDeletingId(job.id);
        try {
            await api.delete(`/jobs/${job.id}`);
            // Removed locally rather than refetched, mirroring EmployerDashboard.
            setJobs((prev) => prev.filter((item) => item.id !== job.id));
            setError('');
        } catch (err) {
            console.error('Error deleting job:', err);
            setError(`"${job.title}" could not be deleted. Please try again.`);
        } finally {
            setDeletingId(null);
        }
    };

    if (isLoading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100 flex items-center justify-center">
                <div className="flex flex-col items-center space-y-4">
                    <div className="relative">
                        <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-200"></div>
                        <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-600 border-t-transparent absolute top-0 left-0"></div>
                    </div>
                    <div className="text-center">
                        <p className="text-gray-700 font-medium">Loading...</p>
                        <p className="text-gray-500 text-sm">Please wait while we get you going</p>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100">
            <EmployerNavbar user={user} />

            <div className="max-w-7xl mx-auto bg-gradient-to-br from-blue-600 to-indigo-900 shadow-sm border-b px-4 sm:px-6 lg:px-6 py-4 sm:py-6 rounded-b-lg">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
                        <div className="flex items-center space-x-3 sm:space-x-4">
                            <div className="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-blue-400 to-blue-600 rounded-full flex items-center justify-center flex-shrink-0">
                                <Building2 className="w-6 h-6 sm:w-8 sm:h-8 text-white" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <h1 className="text-lg sm:text-2xl font-bold text-white truncate">
                                    My Jobs
                                </h1>
                                <p className="text-sm sm:text-base text-blue-100 hidden sm:block">
                                    Every job you have posted
                                </p>
                            </div>
                        </div>

                        <div className="flex justify-end sm:justify-start">
                            <button
                                onClick={() => navigate('/post-job')}
                                className="bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white px-4 sm:px-6 py-2 sm:py-3 rounded-lg font-semibold flex items-center space-x-2 transition-all duration-200 shadow-lg hover:shadow-xl transform hover:-translate-y-0.5"
                            >
                                <Plus className="w-4 h-4 sm:w-5 sm:h-5" />
                                <span className="text-sm sm:text-base">Post New Job</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {error && (
                    <p role="alert" className="text-red-600 mb-6">
                        {error}
                    </p>
                )}

                <div className="space-y-6">
                    <h2 className="text-xl font-bold text-gray-900">
                        Your Job Postings ({jobs.length})
                    </h2>

                    {jobs.length === 0 ? (
                        <div className="bg-white rounded-xl shadow-lg p-12 text-center border border-gray-100">
                            <Briefcase className="w-16 h-16 text-gray-300 mx-auto mb-4" />
                            <h3 className="text-lg font-semibold text-gray-900 mb-2">
                                No jobs posted yet
                            </h3>
                            <p className="text-gray-600 mb-6">
                                Start by posting your first job to attract talented candidates.
                            </p>
                            <button
                                onClick={() => navigate('/post-job')}
                                className="inline-flex items-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold transition-colors duration-200"
                            >
                                <Plus className="w-5 h-5" />
                                <span>Post Your First Job</span>
                            </button>
                        </div>
                    ) : (
                        <div className="grid gap-6">
                            {jobs.map((job) => (
                                <div
                                    key={job.id}
                                    className="bg-white rounded-xl shadow-lg border border-gray-100 p-6 hover:shadow-xl transition-all duration-200 hover:-translate-y-1"
                                >
                                    <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                                        <div className="flex-1">
                                            <div className="flex items-start justify-between mb-3">
                                                <h3 className="text-xl font-bold text-gray-900 mb-2">
                                                    {job.title}
                                                </h3>
                                                <span className={getStatusBadge(job.status)}>
                                                    {jobStatusLabel(job.status)}
                                                </span>
                                            </div>

                                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
                                                <div className="flex items-center text-gray-600">
                                                    <MapPin className="w-4 h-4 mr-2 text-gray-400" />
                                                    <span className="text-sm">{job.location}</span>
                                                </div>
                                                <div className="flex items-center text-gray-600">
                                                    <Calendar className="w-4 h-4 mr-2 text-gray-400" />
                                                    {/* Jobs store ISO strings, so this is a
                                                        direct parse rather than the
                                                        Timestamp decode the task and
                                                        application lists need. */}
                                                    <span className="text-sm">
                                                        {job.createdAt
                                                            ? new Date(job.createdAt).toLocaleDateString()
                                                            : 'Date not available'}
                                                    </span>
                                                </div>
                                                <div className="flex items-center text-gray-600">
                                                    <DollarSign className="w-4 h-4 mr-2 text-gray-400" />
                                                    <span className="text-sm font-semibold">
                                                        {priceLabel(job.price)}
                                                    </span>
                                                </div>
                                                <div className="flex items-center text-gray-600">
                                                    <Users className="w-4 h-4 mr-2 text-gray-400" />
                                                    <span className="text-sm">
                                                        {job.applicantCount} applicant
                                                        {job.applicantCount !== 1 ? 's' : ''}
                                                    </span>
                                                </div>
                                            </div>

                                            {job.description && (
                                                <p className="text-gray-600 text-sm leading-relaxed mb-4">
                                                    {job.description}
                                                </p>
                                            )}

                                            <div className="flex items-center space-x-2 text-xs text-gray-500">
                                                {job.jobType && (
                                                    <span className="bg-gray-100 px-2 py-1 rounded-full">
                                                        {job.jobType}
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex flex-row lg:flex-col gap-2 lg:min-w-[200px]">
                                            {/* Existing flows only. `/jobs/:jobId` is the
                                                detail page, `/edit-job/:jobId` the edit form,
                                                and the applications route the one
                                                ViewJobApplications.jsx is registered on. */}
                                            <Link
                                                to={`/jobs/${job.id}`}
                                                className="flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 rounded-lg font-medium bg-gray-50 text-gray-700 hover:bg-gray-100 hover:shadow-md transition-all duration-200"
                                            >
                                                <Eye className="w-4 h-4" />
                                                <span>Details</span>
                                            </Link>

                                            <button
                                                onClick={() => navigate(`/edit-job/${job.id}`)}
                                                disabled={job.applicantCount > 0}
                                                className={`flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 rounded-lg font-medium transition-all duration-200 ${job.applicantCount > 0
                                                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                                    : 'bg-blue-50 text-blue-600 hover:bg-blue-100 hover:shadow-md'
                                                    }`}
                                            >
                                                <Edit3 className="w-4 h-4" />
                                                <span>Edit</span>
                                            </button>

                                            <button
                                                onClick={() => handleDeleteJob(job)}
                                                disabled={job.applicantCount > 0 || deletingId === job.id}
                                                className={`flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 rounded-lg font-medium transition-all duration-200 ${job.applicantCount > 0
                                                    ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                                    : 'bg-red-50 text-red-600 hover:bg-red-100 hover:shadow-md'
                                                    }`}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                <span>
                                                    {deletingId === job.id ? 'Deleting...' : 'Delete'}
                                                </span>
                                            </button>

                                            {/* Applications can only be reviewed while the job
                                                is open, matching EmployerDashboard. A filled
                                                job's applications are no longer reviewable there
                                                either. The title is encoded because it is part
                                                of the path and job titles contain spaces. */}
                                            {job.status === 'open' ? (
                                                <Link
                                                    to={`/employer/jobs/${job.id}/applications/${encodeURIComponent(job.title)}`}
                                                    className="flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 bg-gradient-to-r from-green-500 to-green-600 text-white rounded-lg font-medium hover:from-green-600 hover:to-green-700 transition-all duration-200 hover:shadow-md"
                                                >
                                                    <Eye className="w-4 h-4" />
                                                    <span>View Apps</span>
                                                </Link>
                                            ) : (
                                                <button
                                                    disabled
                                                    className={`flex-1 lg:flex-none w-full flex items-center justify-center space-x-2 px-4 py-2 rounded-lg font-medium cursor-not-allowed ${isJobFilled(job.status)
                                                        ? 'bg-blue-50 text-blue-400'
                                                        : 'bg-gray-100 text-gray-400'
                                                        }`}
                                                >
                                                    <Eye className="w-4 h-4" />
                                                    <span>
                                                        {isJobFilled(job.status) ? 'Filled' : 'Closed'}
                                                    </span>
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default MyJobs;