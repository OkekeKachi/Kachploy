import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    MapPin,
    Wallet,
    FileText,
    Star,
    ArrowLeft,
    Heart,
    X,
    MoreVertical,
    Share2,
    User,
    Clock,
    Briefcase,
    AlertCircle,
} from 'lucide-react';
import api from '../api';
import { usePublicUserQuery } from '../useAppQueries';
import Card from './ui/Card';
import Badge from './ui/Badge';
import Button from './ui/Button';
import Spinner from './ui/Spinner';
import EmptyState from './ui/EmptyState';

// STAGE 5H: decodes the two shapes a persisted timestamp can arrive in, and only
// then formats it.
//
// `users.createdAt` is written with FieldValue.serverTimestamp(), and the admin
// SDK's Timestamp has no toJSON() -- its only own properties are _seconds and
// _nanoseconds, so res.json() emits {"_seconds":N,"_nanoseconds":M}. This used to
// be `new Date(clientInfo.createdAt)`, which handed the Date constructor an
// object, produced Invalid Date, and rendered "Member since Invalid Date" in
// production while passing in tests (the fake used to hand back an ISO string).
//
// An ISO string is still accepted, because documents written before the value
// was ever a Timestamp keep that shape and nothing here migrates them. Returning
// null for anything unusable is what lets the caller fall back to "Unknown"
// instead of printing "Invalid Date".
const formatPersistedDate = (value) => {
    let date;

    if (value && typeof value === 'object' && typeof value._seconds === 'number') {
        date = new Date(value._seconds * 1000);
    } else if (typeof value === 'string' && value) {
        date = new Date(value);
    }

    // Guards a Timestamp-shaped object that is out of range, and any string that
    // does not parse: both make the Date constructor produce NaN.
    return date && !Number.isNaN(date.getTime()) ? date : null;
};

/** "Member since <local date>", or "Member since Unknown" for anything unusable. */
const formatMemberSince = (createdAt) => {
    const date = formatPersistedDate(createdAt);
    return date ? date.toLocaleDateString() : 'Unknown';
};

// STAGE 12.3A: the sort key for the "Most Recent" tab. Jobs carry `createdAt` as
// an ISO string (jobService writes new Date().toISOString()), but a document
// written elsewhere may hold a Timestamp-shaped object ({_seconds}), a number, or
// nothing at all. Returns epoch milliseconds for a usable value and null
// otherwise -- so an unusable value is ranked explicitly here rather than fed to
// Date, which would yield NaN and leave the sort order undefined.
const jobCreatedAtTime = (createdAt) => {
    if (createdAt && typeof createdAt === 'object' && typeof createdAt._seconds === 'number') {
        return createdAt._seconds * 1000;
    }

    if (typeof createdAt === 'string' || typeof createdAt === 'number') {
        const time = new Date(createdAt).getTime();
        return Number.isNaN(time) ? null : time;
    }

    return null;
};

// STAGE 12.8: a compact "posted age" for the job cards. The cards previously
// rendered `job.posted`, a field no write path persists (jobService stores
// `createdAt`), so posting age never actually appeared. Derived from the same
// `createdAt` the Most Recent sort already reads, and returns null for an
// unusable value so the caller omits the item rather than printing "Invalid".
const postedAge = (createdAt) => {
    const time = jobCreatedAtTime(createdAt);
    if (time === null) return null;

    const minutes = Math.floor((Date.now() - time) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;

    const weeks = Math.floor(days / 7);
    if (weeks < 5) return `${weeks}w ago`;

    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;

    return `${Math.floor(days / 365)}y ago`;
};

// Newest first. A missing or invalid date ranks after every usable one; because
// Array.prototype.sort is stable, such jobs keep their incoming relative order.
const byNewestFirst = (a, b) => {
    const aTime = jobCreatedAtTime(a.createdAt);
    const bTime = jobCreatedAtTime(b.createdAt);

    if (aTime === null && bTime === null) return 0;
    if (aTime === null) return 1;
    if (bTime === null) return -1;
    return bTime - aTime;
};

// STAGE 12.5: normalize a single skill for comparison only. Mirrors the dashboard's
// Stage 12.4 rule -- trim, collapse repeated internal whitespace, case-fold -- and
// is duplicated here rather than imported so ranking stays self-contained and the
// dashboard's eligibility code is left untouched. Non-string/nullish -> ''.
const normalizeSkill = (skill) => {
    if (typeof skill !== 'string') return '';
    return skill.trim().replace(/\s+/g, ' ').toLowerCase();
};

// STAGE 12.5: how well one job's required skills match the employee's skills.
//
// Both sides are reduced to SETS of normalized valid skills, so duplicates and
// non-string/empty entries cannot inflate either side of the ratio. Equality is on
// the whole normalized value (a Set lookup), never a substring: "React" does not
// match "React Native". A job with no valid required skill scores 0 (it cannot
// reach this list anyway -- the dashboard already excludes it).
const skillMatchStats = (jobSkills, userSkills) => {
    if (!Array.isArray(jobSkills)) return { ratio: 0, matched: 0 };

    const userSet = new Set(
        (Array.isArray(userSkills) ? userSkills : []).map(normalizeSkill).filter(Boolean)
    );
    const requiredSet = new Set(jobSkills.map(normalizeSkill).filter(Boolean));

    if (requiredSet.size === 0) return { ratio: 0, matched: 0 };

    let matched = 0;
    for (const skill of requiredSet) {
        if (userSet.has(skill)) matched += 1;
    }

    return { ratio: matched / requiredSet.size, matched };
};

// STAGE 12.5: Best Matches order -- highest match ratio, then highest matched
// count, then the original incoming order (stable via the recorded index). The
// input array and its job objects are never mutated: jobs are decorated into a new
// array, which is what gets sorted and unwrapped.
const rankBySkillMatch = (jobs, userSkills) =>
    jobs
        .map((job, index) => ({
            job,
            index,
            ...skillMatchStats(job.skillsRequired, userSkills),
        }))
        .sort((a, b) => {
            if (b.ratio !== a.ratio) return b.ratio - a.ratio;
            if (b.matched !== a.matched) return b.matched - a.matched;
            return a.index - b.index;
        })
        .map((entry) => entry.job);

// STAGE 11.3: the tabs are restyled into the shared segmented control.
// STAGE 12.3A: `activeTab` now also chooses the ordering of the list below --
// 'recent' sorts by `createdAt`, newest first (see displayedJobs); the other tabs
// still only drive the selected styling. No filtering was added or removed.
const TABS = [
    { id: 'best', label: 'Best Matches' },
    { id: 'recent', label: 'Most Recent' },
    { id: 'saved', label: 'Saved Jobs' },
];

/*
  STAGE 11.3: responsive redesign.

  Behaviour is unchanged from the pre-11.3 version:
    - the same `suggestedJobs` prop and the same first-job auto-selection;
    - the same GET /users/getUser/:postedBy client lookup and its loading/error
      branches (including formatMemberSince above);
    - the same selection, save/dismiss console handlers and the same
      `applyToJob` navigation to /jobs/:jobId.

  What changed is presentation:
    - the previous fixed `flex-row` two-pane layout (which was cramped and had to
      be forced wide by the dashboard) is now `flex-col` below `lg` and `flex-row`
      at `lg` and up;
    - on mobile a small `mobileView` flag switches between the job list and the
      job details, with a "Back to jobs" control -- so each pane is full width
      instead of two half-width panes, and no external min-width is needed;
    - three hardcoded sample job cards and the fabricated fallback literals
      ("Need a Website Designer Urgently", "United States", "$25", "5 stars",
      "17 minutes ago", the fixed "Nigeria" location, etc.) were removed because
      they invented job data that does not come from the API. Real values are now
      rendered only when present. See the Stage 11.3 report.
    - Material Icons were replaced with lucide-react, and the panel now uses the
      shared Card / Badge / Button / Spinner / EmptyState primitives and the
      index.css design tokens.
*/
const JobSplitView = ({ suggestedJobs, eligibleJobs = [], isSearching = false, userSkills = [], allJobs = [], savedJobs = [], currentUser, onSavedJobsChange }) => {
    const [selectedJob, setSelectedJob] = useState(null);
    const [activeTab, setActiveTab] = useState('best');
    const [mobileView, setMobileView] = useState('list');
    const [saveError, setSaveError] = useState('');
    const navigate = useNavigate();
    const clientInfoQuery = usePublicUserQuery(selectedJob?.postedBy);
    const clientInfo = selectedJob?.postedBy ? clientInfoQuery.data ?? null : null;
    const isLoadingClient = Boolean(selectedJob?.postedBy) && clientInfoQuery.isPending;

    // STAGE 12.7: one source of truth for every tab's candidate list. Search
    // results and recommendations are DIFFERENT sets:
    //   - Best Matches: the skill-matched recommendation list, unless a query is
    //     active -- then it ranks the eligible search results WITHOUT filtering
    //     them by skill, so a React developer searching for babysitting still
    //     sees babysitting jobs (ranked, not hidden).
    //   - Most Recent: ALL eligible jobs sorted newest-first, independent of skill
    //     matching. When a query is active the eligible list is already the search
    //     result set, so search stays skill-agnostic here too.
    //   - Saved Jobs: the saved-id intersection (unchanged).
    // Selection (below) and display both read this function, so the two can never
    // diverge and search results are never put back through the skill filter.
    const candidateJobsForTab = useCallback((tab) => {
        if (tab === 'saved') {
            const savedSet = new Set(Array.isArray(savedJobs) ? savedJobs : []);
            return (Array.isArray(allJobs) ? allJobs : []).filter((job) => job && savedSet.has(job.id));
        }

        if (tab === 'recent') {
            // STAGE 12.7.1: every eligible job, newest-first -- never gated on
            // skill match. `eligibleJobs` is all eligible jobs when there is no
            // query, and the eligible search results when there is one.
            const base = Array.isArray(eligibleJobs) ? eligibleJobs : [];
            return [...base].sort(byNewestFirst);
        }

        const base = isSearching
            ? (Array.isArray(eligibleJobs) ? eligibleJobs : [])
            : suggestedJobs;
        return rankBySkillMatch(Array.isArray(base) ? base : [], userSkills);
    }, [savedJobs, allJobs, eligibleJobs, suggestedJobs, isSearching, userSkills]);

    useEffect(() => {
        // STAGE 12.7: synchronise selection against the active tab's ACTUAL
        // candidate list -- the same function the render uses -- never against the
        // recommendation set directly, which is what reapplied the skill filter to
        // search results. Do not override a manual selection if it is still in the
        // active list; clear it when the list becomes empty.
        const candidateList = candidateJobsForTab(activeTab);

        const selectedStillValid = selectedJob
            ? candidateList.some((j) => j && j.id === selectedJob.id)
            : false;

        if (!selectedJob || !selectedStillValid) {
            setSelectedJob(candidateList[0] || null);
        }
    }, [activeTab, selectedJob, candidateJobsForTab]);

    const handleTabClick = (tab) => {
        setActiveTab(tab);
    };

    const handleJobSelect = (job) => {
        setSelectedJob(job);
        // STAGE 11.3: on mobile this reveals the details pane. On desktop the
        // flag is ignored because both panes are always shown at `lg`.
        setMobileView('details');
    };

    // STAGE 12.6: save/unsave update the local list first so the heart and the
    // Saved Jobs tab react immediately (no page refresh). If the write then
    // fails, the optimistic change is rolled back to the value it replaced and
    // the user is told -- the UI must never keep showing a change the server
    // rejected.
    const handleSaveJob = (e, jobId) => {
        e.stopPropagation();
        const currentSaved = Array.isArray(savedJobs) ? savedJobs : [];
        if (currentSaved.includes(jobId)) return;
        const previous = currentSaved;
        const updated = [...currentSaved, jobId];
        setSaveError('');
        if (onSavedJobsChange) {
            onSavedJobsChange(updated);
        }
        if (currentUser?.uid) {
            api.put(`/users/update/${currentUser.uid}`, { savedJobs: updated }).catch((err) => {
                console.error('Failed to save job:', err);
                if (onSavedJobsChange) {
                    onSavedJobsChange(previous);
                }
                setSaveError('We could not save that job. Please try again.');
            });
        }
    };

    const handleCloseJob = (e, jobId) => {
        e.stopPropagation();
        const currentSaved = Array.isArray(savedJobs) ? savedJobs : [];
        const previous = currentSaved;
        const updated = currentSaved.filter((id) => id !== jobId);
        setSaveError('');
        if (onSavedJobsChange) {
            onSavedJobsChange(updated);
        }
        if (currentUser?.uid) {
            api.put(`/users/update/${currentUser.uid}`, { savedJobs: updated }).catch((err) => {
                console.error('Failed to unsave job:', err);
                if (onSavedJobsChange) {
                    onSavedJobsChange(previous);
                }
                setSaveError('We could not unsave that job. Please try again.');
            });
        }
    };

    const applyToJob = (jobId) => {
        navigate(`/jobs/${jobId}`);
    };

    // STAGE 12.6: the Saved Jobs candidate list comes from candidateJobsForTab
    // above (the tab's actual list), so display and selection stay in step. This
    // block only derives the unavailable-job notice.
    const savedSetForDisplay = new Set(Array.isArray(savedJobs) ? savedJobs : []);
    const allJobsList = Array.isArray(allJobs) ? allJobs : [];
    // saved ids whose job is not in the fetched list (deleted, filtered out by a
    // search, or otherwise unavailable). Counted and surfaced, never dropped from
    // `savedJobs` -- unsaving is the user's call.
    const unavailableSavedCount = (Array.isArray(savedJobs) ? savedJobs : [])
        .filter((id) => !allJobsList.some((job) => job && job.id === id)).length;
    const displayedJobs = candidateJobsForTab(activeTab);

    return (
        <Card className="overflow-hidden">
            {saveError && (
                <div
                    role="alert"
                    className="flex items-start justify-between gap-3 border-b border-danger/30 bg-danger-subtle px-4 py-3 text-sm text-danger-subtle-foreground"
                >
                    <div className="flex min-w-0 items-start gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                        <p className="min-w-0">{saveError}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => setSaveError('')}
                        aria-label="Dismiss saved-job error"
                        className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
            )}
            <div className="flex flex-col lg:h-[40rem] lg:flex-row">
                {/* Left Panel - Job List */}
                <div
                    className={`flex w-full flex-col lg:w-1/2 lg:border-r lg:border-border ${
                        mobileView === 'details' ? 'hidden lg:flex' : 'flex'
                    }`}
                >
                    {/* Top Tabs */}
                    <div className="border-b border-border p-4 sm:p-5">
                        <h2 className="text-base font-semibold text-foreground">
                            Jobs you might like
                        </h2>
                        <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Job sort options">
                            {TABS.map((tab) => (
                                <Button
                                    key={tab.id}
                                    role="tab"
                                    aria-selected={activeTab === tab.id}
                                    variant={activeTab === tab.id ? 'primary' : 'secondary'}
                                    size="sm"
                                    className="rounded-full"
                                    onClick={() => handleTabClick(tab.id)}
                                >
                                    {tab.label}
                                </Button>
                            ))}
                        </div>
                    </div>

                    {/* Job List */}
                    <div className="lg:flex-1 lg:overflow-y-auto">
                        {activeTab === 'saved' && unavailableSavedCount > 0 && (
                            <p className="border-b border-border bg-surface-muted px-4 py-2 text-xs text-foreground-subtle sm:px-5">
                                {unavailableSavedCount} saved {unavailableSavedCount === 1 ? 'job is' : 'jobs are'} no longer available.
                            </p>
                        )}
                        {displayedJobs.length === 0 ? (
                            activeTab === 'saved' ? (
                                <EmptyState
                                    icon={Heart}
                                    title="No saved jobs yet."
                                    description="Save jobs you're interested in to see them here."
                                    action={
                                        <Button variant="secondary" onClick={() => handleTabClick('best')}>
                                            Browse jobs
                                        </Button>
                                    }
                                />
                            ) : (
                                <EmptyState
                                    icon={Briefcase}
                                    title={isSearching ? 'No jobs match your search.' : 'No suggested jobs available.'}
                                />
                            )
                        ) : displayedJobs.map((job, index) => {
                            const isSelected = selectedJob && selectedJob.id === job.id;
                            const isSaved = savedSetForDisplay.has(job.id);
                            // STAGE 12.8: posting age from the persisted date, not
                            // the `job.posted` field no write path sets.
                            const posted = postedAge(job.createdAt);
                            // A non-open status (filled/closed) is surfaced where the
                            // API provides it -- most visibly on a saved job that has
                            // since been taken down. Eligible recommendation/recent
                            // cards are already filtered to open jobs.
                            const statusLabel =
                                typeof job.status === 'string' &&
                                job.status.trim() !== '' &&
                                job.status.toLowerCase() !== 'open'
                                    ? job.status
                                    : null;

                            return (
                                <div
                                    key={job.id || index}
                                    onClick={() => handleJobSelect(job)}
                                    aria-current={isSelected ? 'true' : undefined}
                                    className={`cursor-pointer border-b border-border p-4 transition-colors last:border-b-0 sm:p-5 ${
                                        isSelected ? 'bg-accent-subtle' : 'bg-surface hover:bg-surface-muted'
                                    }`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                                            <h3 className="min-w-0 break-words font-medium text-foreground">
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        handleJobSelect(job);
                                                    }}
                                                    aria-current={isSelected ? 'true' : undefined}
                                                    className="break-words rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                                                >
                                                    {job.title}
                                                </button>
                                            </h3>
                                            {statusLabel && (
                                                <Badge variant={statusLabel.toLowerCase() === 'filled' ? 'danger' : 'neutral'}>
                                                    {statusLabel}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex shrink-0 items-center">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={isSaved ? 'Unsave job' : 'Save job'}
                                                        onClick={(e) => {
                                                            if (isSaved) {
                                                                handleCloseJob(e, job.id);
                                                            } else {
                                                                handleSaveJob(e, job.id);
                                                            }
                                                        }}
                                                        className="h-8 w-8 shrink-0"
                                                    >
                                                        <Heart className={`h-4 w-4 ${isSaved ? 'fill-current text-red-500' : 'text-foreground-subtle'}`} />
                                                    </Button>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                aria-label="Dismiss job"
                                                onClick={(e) => handleCloseJob(e, job.id)}
                                            >
                                                <X className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </div>

                                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-foreground-muted sm:text-sm">
                                        {job.price != null && job.price !== '' && (
                                            <span className="inline-flex items-center gap-1">
                                                <Wallet className="h-3.5 w-3.5 text-foreground-subtle" aria-hidden="true" />
                                                <span className="font-medium text-foreground">${job.price}</span>
                                            </span>
                                        )}
                                        {job.jobType && (
                                            <span className="inline-flex items-center gap-1">
                                                <Briefcase className="h-3.5 w-3.5 text-foreground-subtle" aria-hidden="true" />
                                                {job.jobType}
                                            </span>
                                        )}
                                        <span className="inline-flex items-center gap-1">
                                            <FileText className="h-3.5 w-3.5 text-foreground-subtle" aria-hidden="true" />
                                            Proposals: {job.applicantCount ?? 0}
                                        </span>
                                        {job.location && (
                                            <span className="inline-flex items-center gap-1">
                                                <MapPin className="h-3.5 w-3.5 text-foreground-subtle" aria-hidden="true" />
                                                {job.location}
                                            </span>
                                        )}
                                        {job.rating != null && job.rating !== '' && (
                                            <span className="inline-flex items-center gap-1">
                                                <Star className="h-3.5 w-3.5 text-warning" aria-hidden="true" />
                                                {job.rating}
                                            </span>
                                        )}
                                        {posted && (
                                            <span className="inline-flex items-center gap-1">
                                                <Clock className="h-3.5 w-3.5 text-foreground-subtle" aria-hidden="true" />
                                                {posted}
                                            </span>
                                        )}
                                    </div>

                                    {job.skillsRequired?.length > 0 && (
                                        <div className="mt-3 flex flex-wrap gap-1.5">
                                            {job.skillsRequired.map((skill, i) => (
                                                <Badge key={i} variant="neutral">{skill}</Badge>
                                            ))}
                                            {job.skills && job.skills.length > 3 && (
                                                <Badge variant="neutral">
                                                    +{job.skills.length - 3}
                                                </Badge>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Right Panel - Job Details */}
                <div
                    className={`flex w-full flex-col lg:w-1/2 ${
                        mobileView === 'list' ? 'hidden lg:flex' : 'flex'
                    }`}
                >
                    {selectedJob && (
                        <>
                            {/* Back to jobs -- mobile only */}
                            <div className="border-b border-border p-2 lg:hidden">
                                <Button variant="ghost" size="sm" onClick={() => setMobileView('list')}>
                                    <ArrowLeft className="h-4 w-4" />
                                    Back to jobs
                                </Button>
                            </div>

                            <div className="min-w-0 flex-1 space-y-6 p-4 sm:p-6 lg:overflow-y-auto">
                                <div>
                                    <h2 className="break-words text-lg font-semibold text-foreground sm:text-xl">
                                        {selectedJob.title}
                                    </h2>
                                    {selectedJob.posted && (
                                        <p className="mt-1 text-sm text-foreground-subtle">
                                            Posted {selectedJob.posted}
                                        </p>
                                    )}
                                    {selectedJob.description && (
                                        <p className="mt-4 whitespace-pre-line break-words text-sm leading-relaxed text-foreground-muted">
                                            {selectedJob.description}
                                        </p>
                                    )}
                                </div>

                                <div className="space-y-4">
                                    {selectedJob.location && (
                                        <div className="flex items-start gap-3">
                                            <MapPin className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                            <div className="min-w-0">
                                                <p className="font-medium text-foreground">{selectedJob.location}</p>
                                                <p className="text-sm text-foreground-subtle">Application is free with Kachploy</p>
                                            </div>
                                        </div>
                                    )}

                                    {selectedJob.price != null && selectedJob.price !== '' && (
                                        <div className="flex items-start gap-3">
                                            <Wallet className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                            <div className="min-w-0">
                                                <p className="font-medium text-foreground">${selectedJob.price}</p>
                                                <p className="text-sm text-foreground-subtle">Fixed-price</p>
                                            </div>
                                        </div>
                                    )}

                                    {selectedJob.experienceLevel && (
                                        <div className="flex items-start gap-3">
                                            <Star className="mt-0.5 h-5 w-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
                                            <div className="min-w-0">
                                                <p className="font-medium text-foreground">{selectedJob.experienceLevel}</p>
                                                <p className="text-sm text-foreground-subtle">Experience level</p>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {selectedJob.jobType && (
                                    <div className="font-medium text-foreground">
                                        Project Type: <span className="font-normal text-foreground-muted">{selectedJob.jobType}</span>
                                    </div>
                                )}

                                {selectedJob.skillsRequired?.length > 0 && (
                                    <div>
                                        <h3 className="text-sm font-semibold text-foreground">
                                            Skills and Expertise Needed
                                        </h3>
                                        <div className="mt-3 flex flex-wrap gap-1.5">
                                            {selectedJob.skillsRequired.map((skill, i) => (
                                                <Badge key={i} variant="neutral">{skill}</Badge>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <div className="border-t border-border pt-5">
                                    <h3 className="text-base font-semibold text-foreground">About the client</h3>

                                    {isLoadingClient ? (
                                        <div className="mt-3 flex items-center gap-2 text-sm text-foreground-muted">
                                            <Spinner size="sm" className="text-accent" />
                                            Loading client information…
                                        </div>
                                    ) : clientInfo ? (
                                        <div className="mt-4 space-y-3">
                                            <div className="flex items-center gap-3">
                                                {clientInfo.profilePic ? (
                                                    <img
                                                        src={clientInfo.profilePic}
                                                        alt=""
                                                        className="h-10 w-10 shrink-0 rounded-full object-cover"
                                                    />
                                                ) : (
                                                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-foreground-subtle" aria-hidden="true">
                                                        <User className="h-5 w-5" />
                                                    </div>
                                                )}
                                                <div className="min-w-0">
                                                    <p className="truncate font-medium text-foreground">
                                                        {clientInfo.fullName || 'Anonymous'}
                                                    </p>
                                                    {clientInfo.location && (
                                                        <p className="truncate text-sm text-foreground-muted">
                                                            {clientInfo.location}
                                                        </p>
                                                    )}
                                                </div>
                                            </div>

                                            <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
                                                <Clock className="h-4 w-4 text-foreground-subtle" aria-hidden="true" />
                                                Member since {formatMemberSince(clientInfo.createdAt)}
                                            </p>

                                            {clientInfo.rating && (
                                                <p className="flex items-center gap-1.5 text-sm text-foreground-muted">
                                                    <Star className="h-4 w-4 text-warning" aria-hidden="true" />
                                                    {clientInfo.rating} of 5 stars ({clientInfo.reviewCount || 0} reviews)
                                                </p>
                                            )}

                                            {clientInfo.bio && (
                                                <p className="break-words text-sm text-foreground-muted">
                                                    {clientInfo.bio}
                                                </p>
                                            )}
                                        </div>
                                    ) : (
                                        <p className="mt-3 text-sm text-foreground-muted">Client information unavailable</p>
                                    )}
                                </div>
                            </div>

                            {/* Detail actions */}
                            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border p-4">
                                <div className="flex items-center">
                                    <Button variant="ghost" size="icon" aria-label="More options">
                                        <MoreVertical className="h-4 w-4" />
                                    </Button>
                                    <Button variant="ghost" size="icon" aria-label="Share job">
                                        <Share2 className="h-4 w-4" />
                                    </Button>
                                </div>

                                <div className="flex flex-1 items-center justify-end gap-2 sm:flex-none">
                                    <Button
                                        variant="secondary"
                                        className="flex-1 sm:flex-none"
                                        onClick={(e) => {
                                            const isSaved = savedSetForDisplay.has(selectedJob.id);
                                            if (isSaved) {
                                                handleCloseJob(e, selectedJob.id);
                                            } else {
                                                handleSaveJob(e, selectedJob.id);
                                            }
                                        }}
                                    >
                                        <Heart className="h-4 w-4" />
                                        {savedSetForDisplay.has(selectedJob.id) ? 'Unsave' : 'Save job'}
                                    </Button>
                                    <Button
                                        variant="primary"
                                        className="flex-1 sm:flex-none"
                                        onClick={() => applyToJob(selectedJob.id)}
                                    >
                                        Apply
                                    </Button>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </Card>
    );
};

export default JobSplitView;
