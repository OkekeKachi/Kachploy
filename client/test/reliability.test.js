import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldClearSessionCache } from '../src/sessionCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('the session cache is not cleared before the first auth callback', () => {
    assert.equal(shouldClearSessionCache(undefined, ''), false);
    assert.equal(shouldClearSessionCache(undefined, 'user-1'), false);
});

test('the session cache survives rerenders for the same account', () => {
    assert.equal(shouldClearSessionCache('user-1', 'user-1'), false);
    assert.equal(shouldClearSessionCache('', ''), false);
});

test('signing out and switching accounts both clear user-specific cache entries', () => {
    assert.equal(shouldClearSessionCache('user-1', ''), true);
    assert.equal(shouldClearSessionCache('user-1', 'user-2'), true);
    assert.equal(shouldClearSessionCache('', 'user-2'), true);
});

test('the app mounts the session cache boundary inside the query provider', () => {
    const appSrc = readSource('src/App.jsx');
    assert.match(appSrc, /import SessionCacheBoundary from '\.\/components\/SessionCacheBoundary'/);
    assert.match(appSrc, /<QueryClientProvider[\s\S]*?<SessionCacheBoundary>[\s\S]*?<Router>/);
});

test('the cache boundary listens to Firebase auth and clears the query client on identity changes', () => {
    const boundarySrc = readSource('src/components/SessionCacheBoundary.jsx');
    assert.match(boundarySrc, /auth\.onAuthStateChanged/);
    assert.match(boundarySrc, /shouldClearSessionCache/);
    assert.match(boundarySrc, /queryClient\.clear\(\)/);
});

test('JobDetails uses the job query, guards duplicate apply attempts and refreshes list caches', () => {
    const pageSrc = readSource('src/pages/JobDetails.jsx');
    assert.match(pageSrc, /useJobQuery\(jobId\)/);
    assert.match(pageSrc, /applyInFlightRef/);
    assert.match(pageSrc, /queryKeys\.employeeApplications\(uid\)/);
    assert.match(pageSrc, /jobQuery\.refetch\(\)/);
    assert.doesNotMatch(pageSrc, /window\.location\.reload\(\)/);
    assert.doesNotMatch(pageSrc, /setLoading\(false\)/);
});

test('JobDetails handles pending, failed and missing jobs before reading job fields', () => {
    const pageSrc = readSource('src/pages/JobDetails.jsx');
    const lastHook = pageSrc.indexOf("const [resumeError, setResumeError] = useState('');");
    const pendingGuard = pageSrc.indexOf('if (jobQuery.isPending)');
    const errorGuard = pageSrc.indexOf('if (jobQuery.isError)');
    const missingGuard = pageSrc.indexOf('if (!job)');
    const statusRead = pageSrc.indexOf("const isJobOpen   = job?.status === 'open';");

    assert.ok(lastHook >= 0 && lastHook < pendingGuard, 'all hooks must run before any early return');
    assert.ok(pendingGuard >= 0 && pendingGuard < errorGuard, 'pending is handled before errors');
    assert.ok(errorGuard >= 0 && errorGuard < missingGuard, 'request errors are handled before empty data');
    assert.ok(missingGuard >= 0 && missingGuard < statusRead, 'job fields must not be read until a job exists');
    assert.match(pageSrc, /return <PageLoader label="Loading job details/);
    assert.match(pageSrc, /title="Unable to load job"/);
    assert.match(pageSrc, /title="Job not found"/);
});

test('MyApplications reads through the shared query and performs targeted invalidation', () => {
    const pageSrc = readSource('src/pages/MyApplications.jsx');
    assert.match(pageSrc, /useEmployeeApplicationsQuery\(uid\)/);
    assert.match(pageSrc, /useContractProposalsQuery\(applicationId\)/);
    assert.match(pageSrc, /queryKeys\.employeeApplications\(uid\)/);
    assert.match(pageSrc, /queryKeys\.applicationCounts\(uid\)/);
    assert.match(pageSrc, /queryKeys\.contractProposals\(applicationId\)/);
    assert.match(pageSrc, /withdrawInFlightRef/);
    assert.doesNotMatch(pageSrc, /alert\('Application withdrawn successfully'\)/);
});

test('HiredJobs reads through shared employee queries and caches public employer profiles', () => {
    const pageSrc = readSource('src/pages/HiredJobs.jsx');
    assert.match(pageSrc, /useEmployeeEmploymentsQuery\(uid(?:,|\))/);
    assert.match(pageSrc, /useEmployeeApplicationsQuery\(uid(?:,|\))/);
    assert.match(pageSrc, /useEmployeeTasksQuery\(uid(?:,|\))/);
    assert.match(pageSrc, /queryKeys\.publicUser\(employerId\)/);
    assert.match(pageSrc, /useQueries\(/);
    assert.match(pageSrc, /employmentsQuery\.refetch\(\)/);
    assert.doesNotMatch(pageSrc, /api\.get\(/);
});

test('task and interview actions use the shared focusable Button primitive', () => {
    assert.match(readSource('src/components/TaskCard.jsx'), /import Button from '\.\/ui\/Button'/);
    assert.match(readSource('src/components/TaskReviewPanel.jsx'), /import Button from '\.\/ui\/Button'/);
    assert.match(readSource('src/components/EmployeeInterviews.jsx'), /import Button from '\.\/ui\/Button'/);
});

test('profile saves and complete-profile saves guard synchronous duplicate submission', () => {
    assert.match(readSource('src/pages/Profile.jsx'), /saveInFlightRef/);
    assert.match(readSource('src/pages/completeProfile.jsx'), /saveInFlightRef/);
    assert.doesNotMatch(readSource('src/pages/completeProfile.jsx'), /alert\(/);
});

test('job create and edit forms guard duplicate submission and report failures inline', () => {
    const postSrc = readSource('src/pages/PostJobForm.jsx');
    const editSrc = readSource('src/pages/EditJobForm.jsx');
    assert.match(postSrc, /submitInFlightRef/);
    assert.match(editSrc, /submitInFlightRef/);
    assert.match(postSrc, /role="alert"/);
    assert.match(editSrc, /role="alert"/);
    assert.doesNotMatch(postSrc, /\balert\s*\(/);
    assert.doesNotMatch(editSrc, /\balert\s*\(/);
});

test('saved-job failures are reported in the page instead of a browser alert', () => {
    const source = readSource('src/components/JobSplitView.jsx');
    assert.match(source, /saveError/);
    assert.match(source, /role="alert"/);
    assert.doesNotMatch(source, /window\.alert/);
});

test('job cards have a keyboard-operable title and client details use the shared cache', () => {
    const source = readSource('src/components/JobSplitView.jsx');
    assert.match(source, /usePublicUserQuery\(selectedJob\?\.postedBy\)/);
    assert.match(source, /<button[\s\S]*?handleJobSelect\(job\)/);
    assert.match(source, /event\.stopPropagation\(\)/);
    assert.match(source, /aria-current=\{isSelected \? 'true' : undefined\}/);
    assert.doesNotMatch(source, /api\.get\(`\/users\/getUser\/\$\{selectedJob\.postedBy\}`\)/);
});

test('the employee dashboard shares the applications cache and reports a failed check', () => {
    const source = readSource('src/pages/EmployeeDashboard.jsx');
    assert.match(source, /useEmployeeApplicationsQuery\(uid\)/);
    assert.match(source, /applicationsQuery\.isError/);
    assert.match(source, /some jobs you have already applied for may appear here/);
    assert.doesNotMatch(source, /applications\/employee\/\$\{currentUser\.uid\}/);
});

test('proposal and response controls associate labels with their inputs', () => {
    const employerSource = readSource('src/pages/ViewJobApplications.jsx');
    const applicantSource = readSource('src/pages/MyApplications.jsx');

    assert.match(employerSource, /const paymentModeId = `\$\{formId\}-payment-mode`/);
    assert.match(employerSource, /<Field id=\{paymentModeId\} label="Payment Mode">/);
    assert.match(employerSource, /<Select\s+id=\{paymentModeId\}/);
    assert.match(employerSource, /const milestonePrefix = `\$\{formId\}-milestone-\$\{idx\}`/);
    assert.match(employerSource, /id=\{`\$\{milestonePrefix\}-label`\}/);
    assert.match(employerSource, /const submitInFlightRef = useRef\(false\)/);

    assert.match(applicantSource, /const messageId = useId\(\)/);
    assert.match(applicantSource, /id=\{`\$\{messageId\}-\$\{proposal\.id\}`\}/);
});

test('the resume control is grouped and the file input is named and described', () => {
    const source = readSource('src/pages/JobDetails.jsx');
    assert.match(source, /<fieldset className="min-w-0 space-y-1\.5">/);
    assert.match(source, /<legend className="block text-sm font-medium text-foreground">/);
    assert.match(source, /aria-label="Choose resume PDF to upload"/);
    assert.match(source, /aria-describedby=\{resumeError \? 'resume-error' : 'resume-help'\}/);
});

test('the dashboard carousel can be paused and its indicators meet the target size', () => {
    const source = readSource('src/pages/EmployeeDashboard.jsx');
    assert.match(source, /const \[carouselPaused, setCarouselPaused\] = useState\(false\)/);
    assert.match(source, /aria-label=\{carouselPaused \? 'Play carousel' : 'Pause carousel'\}/);
    assert.match(source, /if \(carouselPaused\) return undefined/);
    assert.match(source, /className="group flex h-6 w-6 items-center justify-center rounded-full/);
});

test('the navbar menus close on Escape and restore focus to their trigger', () => {
    const source = readSource('src/components/AppNavbar.jsx');
    assert.match(source, /profileButtonRef = useRef\(null\)/);
    assert.match(source, /mobileMenuButtonRef = useRef\(null\)/);
    assert.match(source, /event\.key !== 'Escape'/);
    assert.match(source, /profileButtonRef\.current\?\.focus\(\)/);
    assert.match(source, /mobileMenuButtonRef\.current\?\.focus\(\)/);
    assert.match(source, /aria-controls="account-menu"/);
    assert.match(source, /id="account-menu"/);
});

test('the unread message count is announced when it changes', () => {
    const source = readSource('src/components/MessagesNavLink.jsx');
    assert.match(source, /aria-live="polite"/);
    assert.match(source, /aria-atomic="true"/);
    assert.match(source, /unread messages/);
});

test('the conversation composer associates send errors and help with the textarea', () => {
    const source = readSource('src/components/ConversationThread.jsx');
    assert.match(source, /const sendErrorId = `composer-error-\$\{conversationId\}`/);
    assert.match(source, /aria-invalid=\{sendError \? 'true' : undefined\}/);
    assert.match(source, /aria-describedby=\{sendError \? sendErrorId : composerHelpId\}/);
    assert.match(source, /id=\{sendErrorId\}/);
    assert.match(source, /id=\{composerHelpId\}/);
});
