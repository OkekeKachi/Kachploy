import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const read = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('the API exposes bank listing and account resolution for payout accounts', () => {
    const api = read('src/api.js');

    assert.ok(api.includes("api.get('/users/payout-account/banks')"));
    assert.ok(api.includes("api.post('/users/payout-account/resolve'"));
    assert.ok(api.includes('bankAccountNumber'));
    assert.ok(api.includes('bankCode'));
});

test('saving a payout account sends only the account number and chosen bank code', () => {
    const api = read('src/api.js');

    assert.match(
        api,
        /export const savePayoutAccount = async \(\{ bankAccountNumber, bankCode \}\) =>/
    );
    assert.match(
        api,
        /api\.put\('\/users\/payout-account', \{\s*bankAccountNumber,\s*bankCode,?\s*\}\)/s
    );
});

test('the payout form uses a searchable bank list instead of a free-text bank code', () => {
    const panel = read('src/components/ReleasePanel.jsx');

    assert.ok(panel.includes('fetchPayoutBanks'));
    assert.ok(panel.includes('type="search"'));
    assert.ok(panel.includes('<select'));
    assert.ok(panel.includes('visibleBanks.map'));
    assert.equal(panel.includes('Bank code\n'), false);
});

test('the resolved account name is read-only and cannot be submitted by the user', () => {
    const panel = read('src/components/ReleasePanel.jsx');

    assert.match(panel, /readOnly/);
    assert.match(panel, /verified account name/i);
    assert.match(
        panel,
        /placeholder="Verify to load the account name"/
    );
    assert.equal(panel.includes('accountName: event.target.value'), false);
});

test('save is gated on server-side verification, and verification uses the resolve endpoint', () => {
    const panel = read('src/components/ReleasePanel.jsx');

    assert.ok(panel.includes('resolvePayoutAccount'));
    assert.ok(panel.includes('handlePayoutVerify'));
    assert.match(panel, /disabled=\{payoutBusy \|\| !payoutVerified\}/);
    assert.ok(
        panel.includes("Verify the bank account before saving it.")
    );
    assert.equal(panel.includes('savePayoutAccount(payoutForm)'), false);
});
