import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('TaskCreateForm is extracted and used by both employer surfaces', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const appPath = path.resolve(__dirname, '../src/pages/ViewJobApplications.jsx');
    const wsPath = path.resolve(__dirname, '../src/pages/EmployeeWorkspace.jsx');
    assert.ok(fs.existsSync(formPath), 'TaskCreateForm component exists');
    const appSrc = fs.readFileSync(appPath, 'utf8');
    const wsSrc = fs.readFileSync(wsPath, 'utf8');
    assert.ok(appSrc.includes('TaskCreateForm'), 'ViewJobApplications imports/uses TaskCreateForm');
    assert.ok(wsSrc.includes('TaskCreateForm'), 'EmployeeWorkspace imports/uses TaskCreateForm');
});

test('EmployeeWorkspace passes jobId, employeeId, employmentId and applicantName to TaskCreateForm', () => {
    const wsPath = path.resolve(__dirname, '../src/pages/EmployeeWorkspace.jsx');
    const wsSrc = fs.readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('jobId={employment.jobId}'), 'passes employment.jobId');
    assert.ok(wsSrc.includes('employeeId={employment.employeeId}'), 'passes employment.employeeId');
    assert.ok(wsSrc.includes('employmentId={employment.id}'), 'passes employment.id for milestone loading');
    assert.ok(wsSrc.includes('applicantName={employeeName}'), 'passes applicantName as employeeName');
    assert.ok(wsSrc.includes('onCreated={fetchTasksForJob}'), 'refreshes via fetchTasksForJob after creation');
});

test('EmployeeWorkspace filters tasks strictly by employmentId', () => {
    const wsPath = path.resolve(__dirname, '../src/pages/EmployeeWorkspace.jsx');
    const wsSrc = fs.readFileSync(wsPath, 'utf8');
    assert.ok(wsSrc.includes('task.employmentId && task.employmentId === employment.id'), 'strict employmentId filter present');
});

test('TaskCreateForm posts to /tasks with required fields', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(formSrc.includes("api.post('/tasks'"), 'posts to /tasks');
    assert.ok(formSrc.includes('jobId'), 'includes jobId');
    assert.ok(formSrc.includes('employeeId'), 'includes employeeId');
    assert.ok(formSrc.includes('taskName'), 'includes taskName');
    assert.ok(formSrc.includes('taskDescription'), 'includes taskDescription');
    assert.ok(formSrc.includes('dueDate'), 'includes dueDate');
    assert.ok(formSrc.includes('submissionType'), 'includes submissionType');
});

test('TaskCreateForm can load and send an optional milestone association', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(formSrc.includes('fetchContractForEmployment'), 'loads the employment contract');
    assert.ok(formSrc.includes('milestoneId'), 'selects a milestone');
    assert.ok(formSrc.includes('...(milestoneId ? { milestoneId } : {})'), 'sends the association only when chosen');
});

test('TaskCreateForm accepts a paymentsKey prop used to re-sync payment status', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(formSrc.includes('paymentsKey = 0'), 'declares the paymentsKey prop');
    assert.ok(formSrc.includes('useEffect'), 'sets up a re-sync effect');
    assert.ok(formSrc.includes('fetchPaymentForMilestone(id)'), 're-fetches milestone payments on refresh');
    assert.ok(formSrc.includes('milestonesRef.current'), 'tracks the milestones currently shown');
});

test('TaskCreateForm only re-syncs on an explicit refresh signal, not on every render', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(
        formSrc.includes('}, [paymentsKey, employmentId]);'),
        'the re-sync effect depends on paymentsKey only, so it does not poll'
    );
});

test('TaskCreateForm fail-closes task creation when the chosen milestone is not paid', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(
        formSrc.includes('!milestonePaymentIsConfirmed(milestonePayments[milestoneId])'),
        'guards creation on a confirmed payment'
    );
    assert.ok(
        formSrc.includes('Confirm the payment first, or leave the milestone unlinked.'),
        'explains the requirement and offers the unlinked fallback'
    );
});

test('TaskCreateForm marks unpaid milestones unavailable and explains why', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(formSrc.includes('disabled={!paid}'), 'unpaid milestone options are disabled');
    assert.ok(
        formSrc.includes('Work can only begin on a milestone once its payment is confirmed as Paid.'),
        'hint explains the funding requirement'
    );
});

test('TaskCreateForm loads each milestone payment status and treats missing data as not funded', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(formSrc.includes('fetchPaymentForMilestone'), 'reads the payment record per milestone');
    assert.ok(
        formSrc.includes('unavailable payment data is not funded'),
        'fails closed when payment data is missing'
    );
});

test('TaskCreateForm preserves legacy creation without a milestone', () => {
    const formPath = path.resolve(__dirname, '../src/components/TaskCreateForm.jsx');
    const formSrc = fs.readFileSync(formPath, 'utf8');
    assert.ok(formSrc.includes("'No milestone'"), 'offers the no-milestone option');
    assert.ok(
        formSrc.includes('...(milestoneId ? { milestoneId } : {})'),
        'sends the association only when chosen'
    );
});

test('MilestonePaymentPanel notifies the parent workspace when a payment is refreshed', () => {
    const panelPath = path.resolve(__dirname, '../src/components/MilestonePaymentPanel.jsx');
    const panelSrc = fs.readFileSync(panelPath, 'utf8');
    assert.ok(panelSrc.includes('onPaymentRefreshed'), 'declares the refresh callback prop');
    assert.ok(
        panelSrc.includes('onPaymentRefreshed?.();'),
        'invokes the callback after updating the payment so an open form can re-sync'
    );
});

test('EmployeeWorkspace wires paymentsKey to TaskCreateForm and onPaymentRefreshed to MilestonePaymentPanel', () => {
    const wsPath = path.resolve(__dirname, '../src/pages/EmployeeWorkspace.jsx');
    const wsSrc = fs.readFileSync(wsPath, 'utf8');
    assert.ok(
        wsSrc.includes('const [paymentsKey, setPaymentsKey] = useState(0);'),
        'holds a payments refresh key in the workspace'
    );
    assert.ok(wsSrc.includes('paymentsKey={paymentsKey}'), 'passes paymentsKey to the task form');
    assert.ok(
        wsSrc.includes('onPaymentRefreshed={handlePaymentRefreshed}'),
        'passes the refresh callback to the payment panel'
    );
});

test('TaskCard shows milestone labels supplied by the employee workspace', () => {
    const cardPath = path.resolve(__dirname, '../src/components/TaskCard.jsx');
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const cardSrc = fs.readFileSync(cardPath, 'utf8');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(cardSrc.includes('milestoneLabelForTask'), 'resolves a milestone label');
    assert.ok(cardSrc.includes('milestones = []'), 'accepts the employment milestones');
    assert.ok(cardSrc.includes("milestoneLabel || 'Linked milestone'"), 'does not render the raw milestone id');
    assert.ok(pageSrc.includes('onContractLoaded={handleContractLoaded}'), 'shares the loaded contract');
    assert.ok(pageSrc.includes('milestones={milestones}'), 'passes milestone labels to each card');
});

test('ViewJobApplications still uses TaskCreateForm for applicants flow', () => {
    const appPath = path.resolve(__dirname, '../src/pages/ViewJobApplications.jsx');
    const appSrc = fs.readFileSync(appPath, 'utf8');
    assert.ok(appSrc.includes('<TaskCreateForm'), 'applicants page renders TaskCreateForm');
    assert.ok(appSrc.includes('onCreated={fetchTasks}'), 'applicants page refreshes via fetchTasks');
});

test('ViewJobApplications gives the hired applicant task form its employment milestone selector', () => {
    const appPath = path.resolve(__dirname, '../src/pages/ViewJobApplications.jsx');
    const appSrc = fs.readFileSync(appPath, 'utf8');
    assert.ok(appSrc.includes('fetchEmployments'), 'loads the job employments');
    assert.ok(appSrc.includes('employmentId={employmentIdByApplication[app.id]}'), 'passes the hire employment');
    assert.ok(
        appSrc.includes("applications.filter(app => canonicalAppStatus(app.status) === ACCEPTED)"),
        'keeps only the hired applicant visible'
    );
});

// ---------------------------------------------------------------------------
// Phase 2: employee-facing milestone payment transparency.
//
// The client test setup has no jsdom or React testing library, so components
// cannot be mounted. The display decision logic (paid vs. not paid, labels,
// badge variants, missing records) is unit-tested behaviourally in
// paymentPresentation.test.js; the assertions below cover the component wiring
// that connects that logic to the employee task card and workspace.
// ---------------------------------------------------------------------------

test('TaskCard accepts a milestonePayments prop keyed by milestone id', () => {
    const cardPath = path.resolve(__dirname, '../src/components/TaskCard.jsx');
    const cardSrc = fs.readFileSync(cardPath, 'utf8');
    assert.ok(cardSrc.includes('milestonePayments = {}'), 'declares the milestonePayments prop');
    assert.ok(cardSrc.includes('milestonePayments[task.milestoneId]'), 'reads the payment by milestone id');
});

test('TaskCard reads payment presentation helpers for milestone status display', () => {
    const cardPath = path.resolve(__dirname, '../src/components/TaskCard.jsx');
    const cardSrc = fs.readFileSync(cardPath, 'utf8');
    assert.ok(cardSrc.includes('milestonePaymentIsConfirmed'), 'uses milestonePaymentIsConfirmed');
    assert.ok(cardSrc.includes('paymentStatusLabel'), 'uses paymentStatusLabel');
    assert.ok(cardSrc.includes('paymentStatusBadgeVariant'), 'uses paymentStatusBadgeVariant');
    assert.ok(cardSrc.includes('formatKoboAsNaira'), 'uses formatKoboAsNaira');
});

test('TaskCard shows an unavailable indication and not confirmed wording, never confirming a missing record', () => {
    const cardPath = path.resolve(__dirname, '../src/components/TaskCard.jsx');
    const cardSrc = fs.readFileSync(cardPath, 'utf8');
    assert.ok(cardSrc.includes('task.milestoneId &&'), 'gates milestone section on milestoneId');
    assert.ok(cardSrc.includes('hasMilestonePaymentData'), 'distinguishes loaded-but-missing from not loaded');
    assert.ok(cardSrc.includes('Payment status:'), 'renders an explicit payment status label');
    assert.ok(cardSrc.includes('Unavailable'), 'renders an unavailable indication when no record exists');
    assert.ok(cardSrc.includes('Payment not yet confirmed'), 'marks non-paid records as not confirmed');
    assert.ok(!cardSrc.includes('Payment confirmed'), 'never asserts confirmation');
});

test('EmployeeJobTasks fetches milestone payments using fetchPaymentForMilestone', () => {
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(pageSrc.includes('fetchPaymentForMilestone'), 'fetches milestone payments');
});

test('EmployeeJobTasks maintains a milestonePayments state map', () => {
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(pageSrc.includes('milestonePayments'), 'maintains milestonePayments state');
    assert.ok(pageSrc.includes('setMilestonePayments'), 'has setter for milestonePayments');
});

test('EmployeeJobTasks passes milestonePayments to each TaskCard', () => {
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(pageSrc.includes('milestonePayments={milestonePayments}'), 'passes milestonePayments to TaskCard');
});

test('EmployeeJobTasks fetches payments independently per milestone', () => {
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(pageSrc.includes('Promise.all'), 'fetches payments concurrently');
    assert.ok(pageSrc.includes('milestones.map'), 'iterates over each milestone');
});

test('EmployeeJobTasks handles failed milestone payment requests independently', () => {
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(pageSrc.includes('try {'), 'uses try/catch per milestone');
    assert.ok(pageSrc.includes('catch {'), 'catches failures per milestone');
    assert.ok(pageSrc.includes('payments[milestone.id] = null'), 'treats failures as null');
});

test('EmployeeJobTasks uses a cancelled flag to prevent stale state overwrites', () => {
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(pageSrc.includes('let cancelled = false;'), 'uses cancelled flag');
    assert.ok(pageSrc.includes('if (!cancelled)'), 'checks cancelled before setting state');
    assert.ok(pageSrc.includes('cancelled = true;'), 'sets cancelled on cleanup');
});

test('EmployeeJobTasks does not re-fetch payments when milestones are unchanged', () => {
    const pagePath = path.resolve(__dirname, '../src/pages/EmployeeJobTasks.jsx');
    const pageSrc = fs.readFileSync(pagePath, 'utf8');
    assert.ok(pageSrc.includes('}, [milestones]);'), 'effect depends only on milestones');
});
