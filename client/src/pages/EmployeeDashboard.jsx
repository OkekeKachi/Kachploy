import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase'; // Adjust path if needed
import api from '../api';
import JobSplitView from '../components/JobSplitView';
import ProfileSidebar from '../components/ProfileSideBar';
import { Search, Briefcase, AlertCircle, Pause, Play } from 'lucide-react';
import AppNavbar from '../components/AppNavbar';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import EmptyState from '../components/ui/EmptyState';
import Spinner from '../components/ui/Spinner';
import { PageContainer, PageHeader } from '../components/ui/PageContainer';
import { Input } from '../components/ui/Field';
import { useUserQuery } from '../useUserQuery';
import { useApplicationCountsQuery } from '../useEmployerQueries';
import { useEmployeeApplicationsQuery } from '../useAppQueries';

// STAGE 12.4: skill comparison is tolerant of case and whitespace. Both employee
// skills and job skills are free-text, so "React", "react" and "  React " denote
// the same skill. Normalization is used for comparison only; the stored and
// displayed strings are never rewritten. A non-string or nullish entry
// normalizes to '' and is ignored rather than throwing.
const normalizeSkill = (skill) => {
    if (typeof skill !== 'string') return '';
    return skill.trim().replace(/\s+/g, ' ').toLowerCase();
};

// A job overlaps when at least one required skill equals an employee skill after
// normalization. Equality is deliberate -- "React" must not match "React Native".
// Missing, empty or malformed arrays simply do not match; nothing is thrown.
const hasSkillOverlap = (jobSkills, userSkills) => {
    if (!Array.isArray(jobSkills) || !Array.isArray(userSkills)) return false;

    const normalizedUserSkills = userSkills.map(normalizeSkill).filter(Boolean);
    if (normalizedUserSkills.length === 0) return false;

    return jobSkills.some((skill) => {
        const normalized = normalizeSkill(skill);
        return normalized !== '' && normalizedUserSkills.includes(normalized);
    });
};

const EmployeeDashboard = () => {
    // Stage 6R: isProfileComplete, isMobileMenuOpen and isDropdownOpen are gone.
    // All three were write-only state -- their setters were called, but the values
    // were never read anywhere, including the JSX, so none of them could influence
    // what this component renders. They are residue from when this page owned its
    // own navbar, profile dropdown and mobile menu, all of which were replaced by
    // the <AppNavbar/> this page now renders.
    //
    // The profile-completion redirect in the effect below does NOT depend on this
    // state: it tests the local profileStatus read straight from the API response.
    // That redirect is therefore unaffected and is preserved exactly as it was.
    const [jobs, setJobs] = useState([]);
    const [user, setUser] = useState({});
    const [activeSlide, setActiveSlide] = useState(0);
    const [carouselPaused, setCarouselPaused] = useState(false);
    // STAGE 12.1B: the search box is now controlled. `searchTerm` is what the
    // reader types; `debouncedQuery` is its trimmed value, published a moment
    // later so typing does not fire a request per keystroke.
    const [searchTerm, setSearchTerm] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    // STAGE 12.2B: feedback state for the jobs read. `jobsLoading` starts true
    // because the effect below fires on mount; `jobsError` is null unless the jobs
    // request itself failed. `jobsReload` is a retry token: bumping it re-runs the
    // existing effect, so no second fetching path is introduced.
    const [jobsLoading, setJobsLoading] = useState(true);
    const [jobsError, setJobsError] = useState(null);
    const [jobsReload, setJobsReload] = useState(0);
    const navigate = useNavigate();

    // Phases 1-2 of the data-fetching audit: the identity half of the old
    // Promise.all below is the shared identity query, keyed by uid. On /dashboard
    // RoleBasedDashboard has already warmed this same cache entry before this page
    // mounts, so the document arrives without a second request; standalone visits
    // still read it once and reuse it across later navigations.
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);

    // Phase 5A of the data-fetching audit: the count-only read
    // (GET /applications/counts) is the shared useApplicationCountsQuery, the
    // same cache entry JobDetails and the employer pages observe, instead of a
    // request issued from the jobs effect below. Each job's applicantCount is
    // merged at render (see jobsWithApplicants) with the same fallback-to-0 the
    // old read used, so a missing, pending or failed count still renders 0.
    const countsQuery = useApplicationCountsQuery(uid);
    const applicationsQuery = useEmployeeApplicationsQuery(uid);

    useEffect(() => {
        if (carouselPaused) return undefined;

        const interval = setInterval(() => {
            setActiveSlide(prev => (prev + 1) % 3);
        }, 2500);

        return () => clearInterval(interval);
    }, [carouselPaused]);

    // The local `user` object is seeded -- and later re-seeded -- from the shared
    // identity query. JobSplitView's save/unsave still updates `user` locally
    // through onSavedJobsChange exactly as before; this effect only writes when
    // the QUERY's document changes, which it does on arrival and on invalidation
    // (a profile save), not on the optimistic local update.
    useEffect(() => {
        if (userQuery.data) {
            setUser(userQuery.data);
        }
    }, [userQuery.data]);

    // Stage 6R: the profile-completion redirect, driven by the identity query's
    // document instead of the response the old Promise.all held. Same condition
    // (!profileComplete), same destination (/complete-profile).
    useEffect(() => {
        const doc = userQuery.data;
        if (doc && !doc.profileComplete) {
            navigate('/complete-profile');
        }
    }, [userQuery.data, navigate]);

    // STAGE 12.1B: publish the trimmed search text a moment after typing stops, so
    // the fetch below runs once per pause rather than once per keystroke. A plain
    // setTimeout -- no new dependency. Whitespace-only input trims to '', which the
    // jobs effect treats as "no filter", matching the previous behaviour.
    useEffect(() => {
        const handle = setTimeout(() => {
            setDebouncedQuery(searchTerm.trim());
        }, 300);

        return () => clearTimeout(handle);
    }, [searchTerm]);

    // STAGE 12.1B: the jobs list is re-read whenever the debounced query changes.
    // An empty query keeps the original unfiltered GET /jobs; a non-empty one adds
    // the backend `q` parameter through axios' own params handling (no hand-built or
    // hand-encoded URL). Eligibility filtering (applied / filled / deadline /
    // recommendation) is unchanged -- it still runs over whatever this stores.
    //
    // STAGE 12.2B: this effect now also owns the read's loading and error state. Both
    // are reset at the top of every run, so an in-flight request or a failure from a
    // previous query cannot leave the page stuck, and the `cancelled` flag drops any
    // response -- success or failure -- that a newer query or an unmount has
    // superseded. The jobs request is the only one that can drive the error state;
    // the count-only read is the shared query declared above, and its absence still
    // degrades every job to 0 applicants rather than failing the page.
    useEffect(() => {
        const currentUser = auth.currentUser;
        if (!currentUser) {
            return;
        }

        let cancelled = false;

        setJobsLoading(true);
        setJobsError(null);

        const fetchJobs = async () => {
            // Stage 5B: the count-only read replaced the per-job
            // GET /applications/job/:jobId fan-out that used to run purely to
            // read `.length`, which returned every applicant's details to this
            // employee-facing page. Phase 5A: that read is now the shared
            // useApplicationCountsQuery declared above, merged into each job at
            // render; this effect owns only the jobs read. The request shape is
            // unchanged (no params for an empty query, `q` through axios' params
            // for a non-empty one), and a count failure still degrades to 0.
            const jobsRes = debouncedQuery
                ? await api.get('/jobs', { params: { q: debouncedQuery } })
                : await api.get('/jobs');

            if (cancelled) return;

            setJobs(jobsRes.data.jobs || []);
        };

        fetchJobs()
            .catch((error) => {
                if (cancelled) return;
                console.error('Error fetching jobs:', error);
                // A failed read is an error, never an empty result: the render gives
                // this error state precedence over every empty state.
                setJobsError('We could not load recommended jobs just now. Please try again.');
            })
            .finally(() => {
                if (cancelled) return;
                setJobsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [debouncedQuery, jobsReload]);

    // STAGE 12.2B: retry re-runs the jobs effect by bumping its token. It touches no
    // other state, so the existing query, cancellation and error-reset behaviour all
    // still apply to the retried read.
    const handleRetryJobs = () => {
        setJobsReload((n) => n + 1);
    };

    // STAGE 12.2B: clearing the box is immediate for the reader. Publishing
    // `debouncedQuery` here (rather than waiting out the 300 ms debounce) is safe --
    // the debounce effect will later set the same '' again, which is a no-op.
    const handleClearSearch = () => {
        setSearchTerm('');
        setDebouncedQuery('');
    };

    // Stage 6R: applyToJob, handleLogout, toggleMobileMenu and toggleDropdown are
    // all removed. Each was defined and never referenced. Sign-out for this page is
    // owned by AppNavbar's handleSignOut.

    // Phase 5A: the shared counts entry is merged into each job here, at render,
    // so the displayed applicantCount is the same value the old effect stored --
    // `counts[job.id] || 0` -- while the jobs state itself stays the raw response.
    const counts = countsQuery.data || {};
    const applications = applicationsQuery.data || [];
    const jobsWithApplicants = jobs.map((job) => ({ ...job, applicantCount: counts[job.id] || 0 }));

    // The first-load block waits for both reads to settle, exactly as the old
    // Promise.all did before it stored the jobs; nothing else is gated on counts.
    const jobsPending = jobsLoading || (Boolean(uid) && countsQuery.isPending);

    const filteredJobs = jobsWithApplicants.filter(job => {
        const hasApplied = applications.some(app => app.jobId === job.id);
        // Stage 5G: was `job.status === 'Filled'` against the title-cased value
        // the old hire flow wrote. The canonical spelling is lowercase 'filled';
        // documents that already hold 'Filled' are still recognised so a filled
        // job does not reappear in suggestions.
        const isFilled = job.status === 'filled' || job.status === 'Filled';
        const currentDate = new Date();
        const applicationDeadline = new Date(job.applicationDeadline);
        const isDeadlinePassed = applicationDeadline < currentDate;

        return !hasApplied && !isFilled && !isDeadlinePassed;
    });

    // STAGE 12.4: matching is case-insensitive and whitespace-tolerant (see
    // hasSkillOverlap above). The eligibility rule is unchanged -- a job is
    // recommended when at least one required skill matches at least one employee
    // skill -- and jobs without required skills stay hidden.
    const suggestedJobs = filteredJobs.filter(job =>
        hasSkillOverlap(job.skillsRequired, user.skills)
    );

    // STAGE 12.6: the saved ids are kept in one place so both the render branch
    // below and the JobSplitView props read the same value, and a full profile
    // without the field is normalised to an empty list rather than `undefined`.
    const savedJobs = Array.isArray(user.savedJobs) ? user.savedJobs : [];

    // STAGE 12.7: search results and recommendations are two different candidate
    // sets. `filteredJobs` is every eligible job for the current query (skills
    // ignored); `suggestedJobs` is the skill-matched subset. When a query is
    // active the server has already narrowed `jobs` to that query, so the
    // eligible list IS the search result set -- and it must be shown without the
    // recommendation skill filter. `isSearching` is passed down so JobSplitView
    // picks the right candidate list per tab.
    const isSearching = Boolean(debouncedQuery);

    // STAGE 11.2: the three slides are kept exactly as before (same titles, copy and
    // image paths); only their background colours were retargeted from ad-hoc blues
    // to the design-system accent so the banner matches the rest of the product.
    const slides = [
        {
            bgColor: "bg-accent",
            title: "Upskill Now",
            content: "Enroll in relevant courses to boost your qualifications.",
            image: "/rocket.png"
        },
        {
            bgColor: "bg-foreground",
            title: `Welcome back, ${user.fullName || 'User'}!`,
            content: "Here are some job opportunities waiting for you.",
            image: "/learn.png"
        },
        {
            bgColor: "bg-accent-hover",
            title: "Boost your profile",
            content: "Add more skills to increase your chances.",
            image: "/fly.png"
        }
    ];

    return (
        <div className="min-h-screen bg-canvas">
            <AppNavbar user={user} />

            <PageContainer className="space-y-8 py-8">
                {/* Page introduction */}
                <PageHeader
                    title="Find work"
                    description="Browse jobs that match the skills on your profile."
                />

                {/* Carousel -- retained from the previous design, restyled. */}
                <Card className="relative hidden h-56 overflow-hidden sm:block">
                    <button
                        type="button"
                        onClick={() => setCarouselPaused((paused) => !paused)}
                        aria-label={carouselPaused ? 'Play carousel' : 'Pause carousel'}
                        className="absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full bg-black/30 text-white transition-colors hover:bg-black/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/30"
                    >
                        {carouselPaused ? (
                            <Play className="h-4 w-4" aria-hidden="true" />
                        ) : (
                            <Pause className="h-4 w-4" aria-hidden="true" />
                        )}
                    </button>

                    {slides.map((slide, index) => (
                        <div
                            key={index}
                            className={`absolute inset-0 flex items-center transition-opacity duration-500 ease-in-out ${index === activeSlide ? 'opacity-100' : 'opacity-0 pointer-events-none'
                                } ${slide.bgColor}`}
                        >
                            <div className="flex w-full items-center justify-between gap-6 px-8">
                                <div className="max-w-md text-white">
                                    <p className="text-xl font-semibold">{slide.title}</p>
                                    <p className="mt-1 text-sm text-white/80">{slide.content}</p>
                                </div>
                                <img
                                    src={slide.image}
                                    alt=""
                                    className="h-40 w-auto object-contain"
                                />
                            </div>
                        </div>
                    ))}

                    {/* Carousel indicators */}
                    <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-1">
                        {slides.map((_, index) => (
                            <button
                                key={index}
                                type="button"
                                onClick={() => setActiveSlide(index)}
                                aria-label={`Show slide ${index + 1} of ${slides.length}`}
                                aria-current={index === activeSlide}
                                className="group flex h-6 w-6 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-black/30"
                            >
                                <span
                                    aria-hidden="true"
                                    className={`h-2 w-2 rounded-full transition-colors ${index === activeSlide ? 'bg-white' : 'bg-white/50 group-hover:bg-white/70'}`}
                                />
                            </button>
                        ))}
                    </div>
                </Card>

                {/* Content + profile sidebar */}
                <div className="grid grid-cols-1 gap-8 lg:grid-cols-4">
                    {/* Main column */}
                    <div className="min-w-0 space-y-6 lg:col-span-3">
                        {/* Search */}
                        <div className="relative">
                            <Search
                                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle"
                                aria-hidden="true"
                            />
                            <Input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder="Search for jobs"
                                aria-label="Search for jobs"
                                className="pl-9"
                            />
                        </div>

                        <div className="flex items-baseline justify-between gap-4">
                            <h2 className="text-lg font-semibold text-foreground">Recommended jobs</h2>
                            {jobsPending ? (
                                <Spinner size="sm" className="text-accent" label="Loading jobs" />
                            ) : jobsError ? null : (
                                <span className="text-sm text-foreground-subtle">
                                    {isSearching ? filteredJobs.length : suggestedJobs.length} available
                                </span>
                            )}
                        </div>

                        {applicationsQuery.isError && (
                            <p role="alert" className="rounded-md border border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground">
                                We could not check your existing applications, so some jobs you have already applied for may appear here.
                            </p>
                        )}

                        {/* STAGE 11.3: the mobile overflow workaround (overflow-x-auto
                            + min-w-[720px]) is removed. JobSplitView now switches to a
                            single-column list/details view below `lg`, so no minimum
                            width is forced and the page cannot scroll horizontally.

                            STAGE 12.2B: the branches below distinguish a failed read
                            (error), a read still in flight with nothing to show yet
                            (loading), real results, a non-empty search that matched
                            nothing, and the no-search, no-recommendation case. The
                            error branch is first, so a failure is never reported as a
                            successful empty result. While a read is in flight the
                            previous results (if any) stay on screen and the header
                            spinner signals progress; only the very first load, with
                            nothing to show, uses the loading block. */}
                        {jobsError ? (
                            <EmptyState
                                icon={AlertCircle}
                                title="Could not load jobs"
                                description={jobsError}
                                action={
                                    <Button variant="secondary" onClick={handleRetryJobs}>
                                        Try again
                                    </Button>
                                }
                            />
                        ) : jobsPending && suggestedJobs.length === 0 && filteredJobs.length === 0 ? (
                            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center">
                                <Spinner size="lg" className="text-accent" label="Loading jobs" />
                                <p className="mt-4 text-sm font-medium text-foreground-muted">
                                    Loading recommended jobs…
                                </p>
                            </div>
                        ) : suggestedJobs.length > 0 || savedJobs.length > 0 || (isSearching && filteredJobs.length > 0) ? (
                            <JobSplitView
                                suggestedJobs={suggestedJobs}
                                eligibleJobs={filteredJobs}
                                isSearching={isSearching}
                                userSkills={user.skills}
                                allJobs={jobsWithApplicants}
                                savedJobs={savedJobs}
                                currentUser={user}
                                onSavedJobsChange={(nextSavedJobs) => setUser((prev) => ({ ...prev, savedJobs: nextSavedJobs }))}
                            />
                        ) : debouncedQuery ? (
                            <EmptyState
                                icon={Search}
                                title="No jobs match your search"
                                description={`No jobs match “${debouncedQuery}”. Jobs you have already applied for, filled roles and expired postings are not shown here.`}
                                action={
                                    <Button variant="secondary" onClick={handleClearSearch}>
                                        Clear search
                                    </Button>
                                }
                            />
                        ) : (
                            <EmptyState
                                icon={Briefcase}
                                title="No recommended jobs yet"
                                description="Add skills to your profile to see jobs that match. Jobs you have already applied for, filled roles and expired postings are not shown here."
                            />
                        )}
                    </div>

                    {/* Profile sidebar */}
                    <aside aria-label="Profile" className="min-w-0 lg:col-span-1">
                        <div className="lg:sticky lg:top-20">
                            <ProfileSidebar user={user} />
                        </div>
                    </aside>
                </div>
            </PageContainer>
        </div>
    );
};

export default EmployeeDashboard;
