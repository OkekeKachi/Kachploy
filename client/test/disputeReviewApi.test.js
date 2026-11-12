import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

// These are drift guards. The server mounts disputes and reviews under an
// employment (`/employments/:employmentId/...`) and lists disputes per party.
// The failure mode this file exists to catch is a helper quietly going back to
// the flat `/disputes` and `/reviews` paths that the server does not mount.

test('dispute helpers address the employment-scoped and party-scoped routes', () => {
    const apiSrc = readSource('src/api.js');

    assert.match(
        apiSrc,
        /export const createDispute = async \(employmentId, payload = \{\}\) => \{/,
    );
    assert.match(
        apiSrc,
        /api\.post\(`\/employments\/\$\{employmentId\}\/disputes`, payload\)/,
    );
    assert.doesNotMatch(apiSrc, /api\.post\('\/disputes'/);

    assert.match(apiSrc, /export const listDisputes = async \(uid\) => \{/);
    assert.match(apiSrc, /api\.get\(`\/disputes\/party\/\$\{uid\}`\)/);
    assert.doesNotMatch(apiSrc, /api\.get\('\/disputes'/);

    assert.match(apiSrc, /api\.get\(`\/disputes\/\$\{disputeId\}`\)/);
    assert.match(
        apiSrc,
        /api\.post\(`\/disputes\/\$\{disputeId\}\/evidence`, payload\)/,
    );
});

test('review helpers address the employment-scoped route', () => {
    const apiSrc = readSource('src/api.js');

    assert.match(
        apiSrc,
        /export const createReview = async \(employmentId, payload = \{\}\) => \{/,
    );
    assert.match(
        apiSrc,
        /api\.post\(`\/employments\/\$\{employmentId\}\/reviews`, payload\)/,
    );
    assert.doesNotMatch(apiSrc, /api\.post\('\/reviews'/);
});

test('the workspace calls the helpers with the ids and payload fields the server validates', () => {
    const workspaceSrc = readSource('src/pages/EmployeeWorkspace.jsx');

    assert.match(workspaceSrc, /listDisputes\(uid\)/);
    assert.match(
        workspaceSrc,
        /createDispute\(employment\.id, \{ category: disputeCategory, reason: disputeReason, description: disputeDetails \}\)/,
    );
    assert.match(workspaceSrc, /evidenceType: 'text'/);
    assert.doesNotMatch(workspaceSrc, /\{ type: 'text'/);
    assert.doesNotMatch(workspaceSrc, /details: disputeDetails/);
    assert.match(
        workspaceSrc,
        /createReview\(employment\.id, \{ revieweeId:/,
    );
});

test('the employer and hired-job pages submit reviews through the employment route', () => {
    const manageSrc = readSource('src/pages/ManageEmployees.jsx');
    const hiredSrc = readSource('src/pages/HiredJobs.jsx');

    assert.match(
        manageSrc,
        /createReview\(employment\.id, \{ revieweeId: employment\.employeeId,/,
    );
    assert.match(
        hiredSrc,
        /createReview\(employment\.id, \{ revieweeId: employment\.employerId,/,
    );
    assert.doesNotMatch(hiredSrc, /api\.post\('\/reviews'/);
    assert.doesNotMatch(hiredSrc, /createReview\(\{ employmentId:/);
});

test('the dispute category choices stay aligned with the server allow-list', () => {
    const workspaceSrc = readSource('src/pages/EmployeeWorkspace.jsx');
    const serviceSrc = readSource('../server/services/disputeService.js');

    const serverList = serviceSrc.match(/DISPUTE_CATEGORIES = \[([^\]]+)\]/);
    assert.ok(serverList, 'server DISPUTE_CATEGORIES not found');
    const serverCategories = [...serverList[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    const clientBlock = workspaceSrc.match(/const DISPUTE_CATEGORY_OPTIONS = \[([\s\S]*?)\];/);
    assert.ok(clientBlock, 'client DISPUTE_CATEGORY_OPTIONS not found');
    const clientCategories = [...clientBlock[1].matchAll(/value: '([^']+)'/g)].map((m) => m[1]);

    assert.deepEqual(clientCategories, serverCategories);
});
