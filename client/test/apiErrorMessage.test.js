import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiErrorMessage } from '../src/apiErrorMessage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readSource = (relativePath) =>
    fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

const FALLBACK = 'Something went wrong';

test('the server message shape used by employment, dispute and review routes is displayed', () => {
    assert.equal(
        apiErrorMessage({ response: { data: { message: 'An open dispute already exists' } } }, FALLBACK),
        'An open dispute already exists',
    );
});

test('the older error shape still works', () => {
    assert.equal(
        apiErrorMessage({ response: { data: { error: 'Not authorized' } } }, FALLBACK),
        'Not authorized',
    );
});

test('message wins when a body carries both shapes', () => {
    assert.equal(
        apiErrorMessage({ response: { data: { message: 'Current', error: 'Legacy' } } }, FALLBACK),
        'Current',
    );
});

test('a missing, blank or non-string value falls back instead of rendering junk', () => {
    assert.equal(apiErrorMessage(undefined, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({}, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({ response: {} }, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({ response: { data: null } }, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({ response: { data: 'plain text' } }, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({ response: { data: { message: '' } } }, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({ response: { data: { message: '   ' } } }, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({ response: { data: { message: { nested: true } } } }, FALLBACK), FALLBACK);
    assert.equal(apiErrorMessage({ response: { data: { error: 42 } } }, FALLBACK), FALLBACK);
});

test('a message with surrounding whitespace is kept as sent, not rewritten', () => {
    assert.equal(
        apiErrorMessage({ response: { data: { message: ' Server sentence ' } } }, FALLBACK),
        ' Server sentence ',
    );
});

test('pages that show server refusals use the shared extractor, not only data.error', () => {
    for (const page of [
        'src/pages/EmployeeWorkspace.jsx',
        'src/pages/ManageEmployees.jsx',
        'src/pages/HiredJobs.jsx',
    ]) {
        const src = readSource(page);
        assert.match(src, /apiErrorMessage\(/, `${page} does not import/use the extractor`);
        assert.doesNotMatch(src, /response\?\.data\?\.error/, `${page} still reads only data.error`);
    }
});
