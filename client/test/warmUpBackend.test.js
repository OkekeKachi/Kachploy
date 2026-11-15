import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHealthUrl, createWarmUpBackend } from '../src/warmUpBackend.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('buildHealthUrl targets the public health endpoint and normalises the base URL', () => {
    assert.equal(buildHealthUrl('https://api.example.com'), 'https://api.example.com/health');
    assert.equal(buildHealthUrl('https://api.example.com/'), 'https://api.example.com/health');
    assert.equal(buildHealthUrl('https://api.example.com///'), 'https://api.example.com/health');
    assert.equal(buildHealthUrl('  https://api.example.com  '), 'https://api.example.com/health');
    assert.equal(buildHealthUrl(''), null);
    assert.equal(buildHealthUrl('   '), null);
    assert.equal(buildHealthUrl(undefined), null);
    assert.equal(buildHealthUrl(null), null);
});

test('warm-up sends one unauthenticated GET to /health and never waits for the response', () => {
    const calls = [];
    let resolveFetch;
    const pending = new Promise((resolve) => {
        resolveFetch = resolve;
    });

    const warmUp = createWarmUpBackend({
        apiUrl: 'https://api.example.com/',
        fetchImpl: (url, options) => {
            calls.push({ url, options });
            return pending;
        },
    });

    assert.equal(warmUp(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example.com/health');
    assert.equal(calls[0].options.method, 'GET');
    assert.equal(calls[0].options.mode, 'cors');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.headers.Accept, 'application/json');
    assert.equal(calls[0].options.headers.Authorization, undefined);

    resolveFetch({ ok: true });
});

test('warm-up is memoised so React renders and navigation cannot repeat the request', () => {
    let count = 0;
    const warmUp = createWarmUpBackend({
        apiUrl: 'https://api.example.com',
        fetchImpl: () => {
            count += 1;
            return Promise.resolve({ ok: true });
        },
    });

    assert.equal(warmUp(), true);
    assert.equal(warmUp(), false);
    assert.equal(warmUp(), false);
    assert.equal(count, 1);
});

test('warm-up swallows network failures silently', async () => {
    const warmUp = createWarmUpBackend({
        apiUrl: 'https://api.example.com',
        fetchImpl: () => Promise.reject(new Error('backend asleep')),
    });

    assert.doesNotThrow(() => warmUp());
    await new Promise((resolve) => setTimeout(resolve, 0));
});

test('warm-up does nothing when the URL or fetch implementation is unavailable', () => {
    const fetchImpl = () => {
        throw new Error('fetch must not be called');
    };

    assert.equal(createWarmUpBackend({ apiUrl: '', fetchImpl })(), false);
    assert.equal(createWarmUpBackend({ apiUrl: 'https://api.example.com', fetchImpl: null })(), false);
});

test('the application starts the warm-up only after rendering, without awaiting it', () => {
    const mainSource = readSource('src/main.jsx');

    assert.match(mainSource, /import \{ warmUpBackend \} from '\.\/warmUpBackend\.js'/);

    const renderIndex = mainSource.indexOf('.render(');
    const warmUpIndex = mainSource.indexOf('warmUpBackend()');

    assert.ok(renderIndex >= 0, 'main.jsx must render the application');
    assert.ok(warmUpIndex > renderIndex, 'warm-up must start after render is scheduled');
    assert.doesNotMatch(mainSource, /await\s+warmUpBackend/);
});
