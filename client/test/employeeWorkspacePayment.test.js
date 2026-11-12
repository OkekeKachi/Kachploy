import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('the employee hired-job route renders EmployeeJobTasks', () => {
    const appSrc = readSource('src/App.jsx');
    const routeAt = appSrc.indexOf('path="/employee/hired-jobs/:employmentId"');

    assert.notEqual(routeAt, -1, 'employee hired-job route exists');

    const routeBlock = appSrc.slice(routeAt, routeAt + 500);
    assert.match(routeBlock, /<EmployeeJobTasks \/>/);
    assert.doesNotMatch(routeBlock, /<EmployeeWorkspace \/>/);
});

test('EmployeeJobTasks mounts the full-contract payment panel for the employee', () => {
    const pageSrc = readSource('src/pages/EmployeeJobTasks.jsx');

    assert.match(
        pageSrc,
        /import MilestonePaymentPanel from '\.\.\/components\/MilestonePaymentPanel'/
    );
    assert.match(
        pageSrc,
        /<MilestonePaymentPanel[\s\S]*?employment=\{employment\}[\s\S]*?currentUid=\{currentUid\}[\s\S]*?reloadToken=\{contractReloadToken\}[\s\S]*?\/>/
    );
    assert.match(
        pageSrc,
        /<ContractSetupPanel[\s\S]*?employment=\{employment\}[\s\S]*?currentUid=\{currentUid\}[\s\S]*?onChanged=\{handleContractChanged\}[\s\S]*?\/>/
    );
});

test('the payment panel keeps the full-contract branch and employer-only controls', () => {
    const panelSrc = readSource('src/components/MilestonePaymentPanel.jsx');

    assert.match(panelSrc, /const fullContract = isFullContract\(contract\)/);
    assert.match(panelSrc, /fullContract \? \(/);
    assert.match(panelSrc, /<ContractPaymentRow/);
    assert.match(panelSrc, /Agreed total:/);
    assert.match(panelSrc, /\{isEmployer && \(showCheckout \|\| showRefresh\) && \(/);
});

test('payment actions are withheld when the payment record could not be loaded', () => {
    const panelSrc = readSource('src/components/MilestonePaymentPanel.jsx');

    const checkoutGates =
        panelSrc.match(
            /const showCheckout = !readError && canInitiatePayment\(payment, isEmployer\);/g
        ) || [];
    const refreshGates =
        panelSrc.match(
            /const showRefresh = !readError && canRefreshStatus\(payment, isEmployer\);/g
        ) || [];

    assert.equal(checkoutGates.length, 2, 'both contract and milestone rows gate Checkout');
    assert.equal(refreshGates.length, 2, 'both contract and milestone rows gate Refresh');
});
