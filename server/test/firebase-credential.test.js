'use strict';

/**
 * Firebase credential‑loading tests.
 *
 * These tests verify:
 *  • Explicit FIREBASE_SERVICE_ACCOUNT_PATH is honoured.
 *  • Default fallback works when the variable is unset.
 *  • Missing configured path throws a clear error.
 *  • Empty/invalid path throws a clear error (no silent fallback).
 *  • The module still exports { app, db } in all cases.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const firebaseModPath = path.resolve(__dirname, '../config/firebase');
const admin = require('firebase-admin');

const withEnv = async (name, value, fn) => {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
};

// ---------------------------------------------------------------------
// Global setup – clear any leftover Firebase Admin app before each test
// and clear the module cache so each test starts fresh.
// ---------------------------------------------------------------------
test.beforeEach(async () => {
  // Delete any default Firebase app that may have been initialised during a previous test.
  // Use admin.apps array to avoid throwing when no app exists.
  const apps = admin.apps || [];
  for (const app of apps) {
    await app.delete();
  }
  // Clear the module cache so the next require runs the module freshly.
  delete require.cache[require.resolve(firebaseModPath)];
});

// ---------------------------------------------------------------------
// 1. Explicit credential path
// ---------------------------------------------------------------------
test('FIREBASE_SERVICE_ACCOUNT_PATH explicit path loads credential', async () => {
  await withEnv('FIREBASE_SERVICE_ACCOUNT_PATH', path.resolve(__dirname, '../../server/config/pet-idea-firebase-adminsdk-gc05a-d562d86349.json'), async () => {
    const { app: a, db: d } = require(firebaseModPath);
    assert.ok(a, 'app should be initialized');
    assert.ok(d, 'db should be exported');
  });
});

// ---------------------------------------------------------------------
// 2. Default fallback (unset variable)
// ---------------------------------------------------------------------
test('default fallback when FIREBASE_SERVICE_ACCOUNT_PATH is unset', async () => {
  await withEnv('FIREBASE_SERVICE_ACCOUNT_PATH', undefined, async () => {
    const { app: a, db: d } = require(firebaseModPath);
    assert.ok(a, 'app should be initialized via fallback');
    assert.ok(d, 'db should be exported via fallback');
  });
});

// ---------------------------------------------------------------------
// 3. Missing configured credential
// ---------------------------------------------------------------------
test('missing configured credential throws clear error', async () => {
  await withEnv('FIREBASE_SERVICE_ACCOUNT_PATH', path.resolve(__dirname, '../../nonexistent.json'), async () => {
    let threw = false;
    try {
      const { app: a, db: d } = require(firebaseModPath);
      threw = false;
    } catch (e) {
      threw = true;
      assert.ok(e.message.includes('not found'), 'error must mention file not found');
    }
    assert.strictEqual(threw, true, 'module must throw when path missing');
  });
});

// ---------------------------------------------------------------------
// 4. Invalid/empty path
// ---------------------------------------------------------------------
test('empty/invalid path throws clear error (no silent fallback)', async () => {
  await withEnv('FIREBASE_SERVICE_ACCOUNT_PATH', '', async () => {
    let threw = false;
    try {
      const { app: a, db: d } = require(firebaseModPath);
      threw = false;
    } catch (e) {
      threw = true;
      assert.ok(
        e.message.includes('must not be empty') ||
        e.message.includes('not found') ||
        e.message.includes('invalid'),
        'error must indicate an empty or invalid path'
      );
    }
    assert.strictEqual(threw, true, 'module must throw for empty path');
  });
});

// ---------------------------------------------------------------------
// 5. Existing Firebase initialization/export behaviour unchanged
// ---------------------------------------------------------------------
test('module still exports app, db after changes', async () => {
  // Clear module cache so the latest code is used (redundant after beforeEach, but kept for explicitness).
  delete require.cache[require.resolve(firebaseModPath)];
  const { app: a, db: d } = require(firebaseModPath);
  assert.ok(a, 'app export present');
  assert.ok(d, 'db export present');
});