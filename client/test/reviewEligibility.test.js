import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    canReviewEmployment,
    isEmployerReviewEligible,
} from '../src/reviewEligibility.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

const employment = (overrides = {}) => ({
    employerId: 'employer-1',
    employeeId: 'employee-1',
    jobId: 'job-1',
    status: 'active',
    ...overrides,
});

const job = (overrides = {}) => ({
    postedBy: 'employer-1',
    status: 'open',
    ...overrides,
});

test('an employer may review a completed, terminated or ended employment', () => {
    for (const status of ['completed', 'terminated', 'ended']) {
        assert.equal(isEmployerReviewEligible(employment({ status }), null), true);
    }
});

test('an employer may review once the job is closed', () => {
    for (const status of ['closed', 'Closed']) {
        assert.equal(isEmployerReviewEligible(employment(), job({ status })), true);
    }
});

test('an active employment with an open or filled job is not reviewable by the employer', () => {
    for (const status of ['open', 'Open', 'filled', 'Filled']) {
        assert.equal(isEmployerReviewEligible(employment(), job({ status })), false);
    }
});

test('missing or inconsistent job data fails closed', () => {
    assert.equal(isEmployerReviewEligible(employment(), null), false);
    assert.equal(isEmployerReviewEligible(employment({ jobId: '' }), job({ status: 'closed' })), false);
    assert.equal(isEmployerReviewEligible(employment(), job({ status: 'closed', postedBy: 'someone-else' })), false);
    assert.equal(isEmployerReviewEligible(employment(), { postedBy: 'employer-1' }), false);
});

test('the route guard blocks active employments and allows employees to review the employer', () => {
    const activeOpen = canReviewEmployment(employment(), job(), 'employer-1');
    assert.equal(activeOpen, false);

    const activeFilled = canReviewEmployment(employment(), job({ status: 'filled' }), 'employer-1');
    assert.equal(activeFilled, false);

    const activeClosed = canReviewEmployment(employment(), job({ status: 'closed' }), 'employer-1');
    assert.equal(activeClosed, true);

    const completed = canReviewEmployment(employment({ status: 'completed' }), null, 'employer-1');
    assert.equal(completed, true);

    const terminatedOpen = canReviewEmployment(employment({ status: 'terminated' }), job(), 'employer-1');
    assert.equal(terminatedOpen, true);

    const employeeReview = canReviewEmployment(employment(), job(), 'employee-1');
    assert.equal(employeeReview, true);

    assert.equal(canReviewEmployment(employment(), job({ status: 'closed' }), ''), false);
});

test('review access updates when refreshed job data changes', () => {
    const active = employment();
    const filled = job({ status: 'filled' });

    assert.equal(canReviewEmployment(active, filled, 'employer-1'), false);
    assert.equal(canReviewEmployment(active, job({ status: 'closed' }), 'employer-1'), true);
    assert.equal(canReviewEmployment(active, job({ status: 'open' }), 'employer-1'), false);
});

test('the exact employer workspace route uses the shared review guard', () => {
    const appSrc = readSource('src/App.jsx');
    const workspaceSrc = readSource('src/pages/EmployeeWorkspace.jsx');

    assert.match(
        appSrc,
        /path="\/employer\/jobs\/:jobId\/employments\/:employmentId"[\s\S]*?<EmployeeWorkspace \/>/
    );
    assert.match(workspaceSrc, /employmentMatchesRoute/);
    assert.match(workspaceSrc, /jobForJobId === employment\.jobId \? job : null/);
    assert.match(workspaceSrc, /canReviewEmployment\(employment, currentJob, currentUid\)/);
    assert.match(workspaceSrc, /setJob\(null\)/);
    assert.match(workspaceSrc, /\{canReview \? \(/);
    assert.match(workspaceSrc, /createReview\(employment\.id/);
});

test('both review surfaces use the shared eligibility rule', () => {
    const manageSrc = readSource('src/pages/ManageEmployees.jsx');
    const workspaceSrc = readSource('src/pages/EmployeeWorkspace.jsx');

    assert.match(manageSrc, /isEmployerReviewEligible\(employment, job\)/);
    assert.match(manageSrc, /job=\{jobForJobId === jobId \? job : null\}/);
    assert.match(workspaceSrc, /canReviewEmployment/);
});
