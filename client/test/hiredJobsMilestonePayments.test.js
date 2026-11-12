import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { milestonePaymentIsConfirmed } from '../src/components/paymentPresentation.js';

/**
 * Phase 3: milestone payment visibility on the Hired Jobs page.
 *
 * The client test setup has no jsdom or React testing library, so HiredJobs
 * cannot be mounted. These tests verify the source wiring and the shared
 * fail-closed helper. They do not claim rendered component behaviour.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

const hiredJobsSrc = () => readSource('src/pages/HiredJobs.jsx');

test('HiredJobs reuses the shared fetchPaymentForMilestone helper and makes no direct GET', () => {
    const src = hiredJobsSrc();
    assert.match(src, /fetchPaymentForMilestone/);
    assert.match(src, /import \{[^}]*fetchPaymentForMilestone[^}]*\} from '\.\.\/api'/);
    assert.doesNotMatch(src, /api\.get\(/);
});

test('HiredJobs maintains a milestonePayments map keyed by milestone id', () => {
    const src = hiredJobsSrc();
    assert.match(src, /const \[milestonePayments, setMilestonePayments\] = useState\(\{\}\);/);
});

test('HiredJobs derives the milestone ids from the employee task list', () => {
    const src = hiredJobsSrc();
    assert.match(src, /task\.milestoneId/);
    assert.match(src, /new Set\(/);
    assert.match(src, /const taskMilestoneIds = useMemo\(/);
});

test('HiredJobs fetches each milestone payment independently', () => {
    const src = hiredJobsSrc();
    assert.match(src, /Promise\.all\(/);
    assert.match(src, /taskMilestoneIds\.map\(async \(milestoneId\) =>/);
    assert.match(src, /const \{ payment \} = await fetchPaymentForMilestone\(milestoneId\);/);
});

test('HiredJobs stores failed or missing records as null so display fails closed', () => {
    const src = hiredJobsSrc();
    assert.match(src, /payments\[milestoneId\] = payment \|\| null;/);
    assert.match(src, /catch \{/);
    assert.match(src, /payments\[milestoneId\] = null;/);
});

test('HiredJobs guards against stale responses after cleanup or a task-list change', () => {
    const src = hiredJobsSrc();
    assert.match(src, /let cancelled = false;/);
    assert.match(src, /if \(!cancelled\)/);
    assert.match(src, /cancelled = true;/);
    assert.match(src, /\}, \[taskMilestoneIds\]\);/);
});

test('HiredJobs skips fetching when no task carries a milestone', () => {
    const src = hiredJobsSrc();
    assert.match(src, /if \(taskMilestoneIds\.length === 0\) \{/);
    assert.match(src, /setMilestonePayments\(\{\}\);/);
});

test('HiredJobs passes the payment map to the rendered TaskCard', () => {
    const src = hiredJobsSrc();
    assert.match(src, /milestonePayments=\{milestonePayments\}/);
});

test('HiredJobs still renders tasks without a milestone unchanged', () => {
    const src = hiredJobsSrc();
    // The card is always rendered; milestone/payment detail is gated inside
    // TaskCard on the presence of task.milestoneId, not here.
    assert.match(src, /<TaskCard/);
    assert.doesNotMatch(src, /task\.milestoneId &&[\s\S]{0,80}<TaskCard/);
});

test('an absent payment record is never treated as confirmed', () => {
    assert.equal(milestonePaymentIsConfirmed(null), false);
    assert.equal(milestonePaymentIsConfirmed(undefined), false);
    assert.equal(milestonePaymentIsConfirmed({}), false);
    assert.equal(milestonePaymentIsConfirmed({ status: 'pending' }), false);
    assert.equal(milestonePaymentIsConfirmed({ status: 'paid' }), true);
});
