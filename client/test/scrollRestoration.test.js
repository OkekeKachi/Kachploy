import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('the router mounts one centralized scroll restoration component', () => {
    const appSrc = readSource('src/App.jsx');

    assert.match(appSrc, /import ScrollToTop from '\.\/components\/ScrollToTop';/);
    assert.match(appSrc, /<Router>\s*<ScrollToTop \/>/);
});

test('scroll restoration resets to the top on pathname changes but preserves hash navigation', () => {
    const source = readSource('src/components/ScrollToTop.jsx');

    assert.match(source, /useLocation\(\)/);
    assert.match(source, /if \(hash\) return;/);
    assert.match(source, /window\.scrollTo\(0, 0\)/);
    assert.match(source, /\[pathname, hash\]/);
});
