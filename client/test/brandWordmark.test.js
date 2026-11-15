import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, '..');
const readSource = (relativePath) => fs.readFileSync(path.resolve(ROOT, relativePath), 'utf8');

const BRANDED_FILES = [
    'src/components/AppNavbar.jsx',
    'src/components/marketing/MarketingNavbar.jsx',
    'src/components/marketing/MarketingFooter.jsx',
    'src/pages/AuthPage.jsx',
    'src/pages/VerifyEmail.jsx',
];

test('the brand wordmark keeps Kachploy as one word with a highlighted K', () => {
    const source = readSource('src/components/BrandWordmark.jsx');

    assert.match(source, /font-brand/);
    assert.match(source, /font-bold text-accent">K<\/span>achploy/);
    assert.match(source, /tone = 'light'/);
    assert.match(source, /dark: 'text-white'/);
    assert.match(source, /whitespace-nowrap/);
});

test('the brand font is loaded separately from the UI font', () => {
    const html = readSource('index.html');
    const css = readSource('src/index.css');

    assert.match(html, /family=Space\+Grotesk:wght@500;600;700/);
    assert.match(html, /family=Inter:wght@400;500;600;700/);
    assert.match(css, /--font-brand: 'Space Grotesk'/);
});

test('every active brand location uses the shared wordmark instead of the old image', () => {
    for (const file of BRANDED_FILES) {
        const source = readSource(file);
        assert.match(source, /import BrandWordmark from/, `${file} must import BrandWordmark`);
        assert.match(source, /<BrandWordmark/, `${file} must render BrandWordmark`);
        assert.doesNotMatch(source, /\/image\.png/, `${file} must not render the old logo image`);
    }
});
