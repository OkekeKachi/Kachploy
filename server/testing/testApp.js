'use strict';

/**
 * Test harness.
 *
 * Loads the REAL server/app.js (and therefore the real route handlers) but
 * substitutes server/config/firebase.js with the in-memory double BEFORE the
 * app is required. Because config/firebase.js never executes,
 * `admin.initializeApp()` is never called and no credential is read — tests
 * cannot touch the production Firestore database.
 */

const http = require('http');
const path = require('path');
const { createFakeFirebase } = require('./fakeFirestore');

const FIREBASE_MODULE = require.resolve('../config/firebase.js');
const APP_MODULE = require.resolve('../app.js');

// morgan('dev') writes a line per response; swallow just those so the test
// reporter output stays readable. app.js itself is left untouched.
// Output is ANSI-coloured and, under `node --test`, prefixed with "# ".
const ANSI = /\u001b\[[0-9;]*m/g;
const MORGAN_LINE = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+\d{3}/;

function silenceMorgan() {
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    const cleaned = text.replace(ANSI, '').replace(/^\s*#\s?/, '').trim();
    if (MORGAN_LINE.test(cleaned)) {
      const cb = typeof encoding === 'function' ? encoding : callback;
      if (typeof cb === 'function') cb();
      return true;
    }
    return original(chunk, encoding, callback);
  };
  return () => {
    process.stdout.write = original;
  };
}

function installFakeFirebase(fake) {
  require.cache[FIREBASE_MODULE] = {
    id: FIREBASE_MODULE,
    filename: FIREBASE_MODULE,
    loaded: true,
    children: [],
    paths: [],
    exports: { admin: fake.admin, db: fake.db },
  };
}

/** Boots the app on an ephemeral port. Returns a client bound to that server. */
async function startTestServer(options = {}) {
  silenceMorgan();

  const fake = createFakeFirebase(options);

  // Guard: if injection ever stops working, fail loudly rather than silently
  // initialising the real admin SDK against a real project.
  installFakeFirebase(fake);
  if (require.cache[FIREBASE_MODULE].exports.db !== fake.db) {
    throw new Error('Fake Firebase injection failed; refusing to run tests.');
  }

  const app = require(APP_MODULE);
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const baseUrl = `http://127.0.0.1:${port}`;

  /**
   * Issues a request against the running app.
   * Returns status, parsed JSON body when possible, and raw text.
   */
  async function request(method, urlPath, { token, body, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };

    if (token !== undefined) init.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(`${baseUrl}${urlPath}`, init);
    const text = await res.text();

    let json;
    try {
      json = text.length ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: json,
      text,
      contentType: res.headers.get('content-type') || '',
    };
  }

  const client = {
    baseUrl,
    fake,
    request,
    get: (p, o) => request('GET', p, o),
    post: (p, o) => request('POST', p, o),
    put: (p, o) => request('PUT', p, o),
    delete: (p, o) => request('DELETE', p, o),

    /** Seeds a Firestore document directly, bypassing the API. */
    seed: (collection, id, data) => fake.store.seed(collection, id, data),

    /**
     * Models the real signup flow: the browser creates the Firebase Auth user
     * via the client SDK first, then calls POST /users/register with that ID
     * token. Returns a valid bearer token.
     */
    async signUp(uid, props = {}) {
      await fake.auth.createUser({ uid, email: props.email || `${uid}@example.test`, ...props });
      return fake.auth.issueToken(uid, { email: props.email || `${uid}@example.test` });
    },

    /** Issues a token for a UID that has no Firebase Auth user record. */
    token: (uid, claims = {}) => fake.auth.issueToken(uid, claims),

    /**
     * Returns a request client that authenticates as `uid` on every call, with
     * the Firebase Auth user created so Auth-mutating routes work too.
     * Since Stage 1 every endpoint requires a token.
     */
    authed: async (uid, props = {}) => {
      const authToken = await client.signUp(uid, props);
      const withToken = (method) => (urlPath, opts = {}) =>
        request(method, urlPath, { ...opts, token: authToken });
      return {
        get: withToken('GET'),
        post: withToken('POST'),
        put: withToken('PUT'),
        delete: withToken('DELETE'),
        request: (method, urlPath, opts = {}) =>
          request(method, urlPath, { ...opts, token: authToken }),
        uid,
        token: authToken,
        raw: client,
      };
    },

    /** Reads a Firestore document directly (defensive copy). */
    readDoc: (collection, id) => fake.store.read(collection, id),

    /** All documents in a collection as { id, ...data }. */
    readAll: (collection) =>
      Object.fromEntries(fake.store.list(collection).map(([id, data]) => [id, data])),

    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };

  return client;
}

module.exports = { startTestServer };
