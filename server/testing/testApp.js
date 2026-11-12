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
const clock = require('../config/clock');

const FIREBASE_MODULE = require.resolve('../config/firebase.js');
const APP_MODULE = require.resolve('../app.js');
const PAYSTACK_CLIENT_MODULE = require.resolve('../services/paystackClient.js');
const PAYSTACK_TRANSFER_CLIENT_MODULE = require.resolve('../services/paystackTransferClient.js');

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

/**
 * STAGE 1F/1G. A queue-driven double for services/paystackClient.js, installed
 * in require.cache exactly the way the Firestore double is installed -- BEFORE
 * app.js is required, so paymentService captures this instead of the real
 * module. No network, no credential, no possibility of reaching Paystack.
 *
 * Like fakeFirestore, it fails loudly when misused: an unqueued call throws
 * rather than inventing a response.
 *
 * Each operation has its OWN queue, so an initialize test and a verify test in
 * the same process cannot consume each other's queued responders:
 *   paystack.respondWith(fn)        -- queue the next initialize response;
 *   paystack.respondWithVerify(fn)  -- queue the next verify response.
 *
 * `paystack.sleep` is an injectable delay used by the verification retry
 * backoff: the default is a real timer, but a test sets it to a no-op so the
 * retry path can be exercised without real waiting.
 *
 * Tests control it through `client.paystack`:
 *   paystack.calls            -- every call, with its arguments, in order;
 *   paystack.respondWith(fn)  -- queue the next initialize response;
 *   paystack.respondWithVerify(fn) -- queue the next verify response;
 *   paystack.sleep            -- replaceable async (ms) => void;
 *   paystack.reset()          -- clear calls and both queues.
 */
function createFakePaystack() {
  const calls = [];
  const initializeQueue = [];
  const verifyQueue = [];
  const fake = {
    createPaystackClient,
    calls,
    sleep: undefined,
    respondWith(responder) {
      initializeQueue.push(responder);
    },
    respondWithVerify(responder) {
      verifyQueue.push(responder);
    },
    reset() {
      calls.length = 0;
      initializeQueue.length = 0;
      verifyQueue.length = 0;
    },
  };

  // The service constructs its client once at module load; the fake returns an
  // object whose `verifyTransaction` consults `fake.sleep` at CALL time, so a
  // test can still replace the backoff delay after startTestServer().
  function createPaystackClient() {
    return {
      async initializeTransaction(payload) {
        calls.push({ op: 'initializeTransaction', payload });
        const responder = initializeQueue.shift();
        if (!responder) {
          throw new Error(
            'fakePaystack: no queued response for initializeTransaction -- call paystack.respondWith() first'
          );
        }
        return responder(payload);
      },
      async verifyTransaction(reference) {
        calls.push({ op: 'verifyTransaction', reference });
        const responder = verifyQueue.shift();
        if (!responder) {
          throw new Error(
            'fakePaystack: no queued response for verifyTransaction -- call paystack.respondWithVerify() first'
          );
        }
        return responder(reference);
      },
      sleep: (ms) => (fake.sleep ? fake.sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  return fake;
}

function installFakePaystack(fakePaystack) {
  require.cache[PAYSTACK_CLIENT_MODULE] = {
    id: PAYSTACK_CLIENT_MODULE,
    filename: PAYSTACK_CLIENT_MODULE,
    loaded: true,
    children: [],
    paths: [],
    exports: { createPaystackClient: fakePaystack.createPaystackClient },
  };
}

/**
 * Queue-driven double for services/paystackTransferClient.js. It is installed
 * before app.js so paystackTransferService captures it; no test can reach
 * Paystack or spend Test Mode balance.
 *
 * Operations are queued independently:
 *   client.paystackTransfer.queue('listBanks', () => ({ data: [...] }))
 *   client.paystackTransfer.queue('resolveAccount', () => ({ data: { account_name: 'Ada' } }))
 */
function createFakePaystackTransfer() {
  const calls = [];
  const queues = {
    createRecipient: [],
    initiateTransfer: [],
    getTransfer: [],
    listBanks: [],
    resolveAccount: [],
  };

  const invoke = (operation, args) => {
    calls.push({ operation, args });
    const responder = queues[operation].shift();
    if (!responder) {
      throw new Error(
        `fakePaystackTransfer: no queued response for ${operation} -- call paystackTransfer.queue() first`
      );
    }
    return responder(...args);
  };

  return {
    calls,
    queues,
    queue(operation, responder) {
      if (!Object.prototype.hasOwnProperty.call(queues, operation)) {
        throw new Error(`fakePaystackTransfer: unknown operation ${operation}`);
      }
      queues[operation].push(responder);
    },
    respondWithBanks(banks) {
      queues.listBanks.push(() => ({ status: true, data: banks }));
    },
    respondWithAccountName(accountName) {
      queues.resolveAccount.push(() => ({
        status: true,
        data: { account_name: accountName },
      }));
    },
    reset() {
      calls.length = 0;
      Object.keys(queues).forEach((operation) => {
        queues[operation].length = 0;
      });
    },
    createPaystackTransferClient() {
      return {
        createRecipient: (...args) => invoke('createRecipient', args),
        initiateTransfer: (...args) => invoke('initiateTransfer', args),
        getTransfer: (...args) => invoke('getTransfer', args),
        listBanks: (...args) => invoke('listBanks', args),
        resolveAccount: (...args) => invoke('resolveAccount', args),
      };
    },
  };
}

function installFakePaystackTransfer(fakePaystackTransfer) {
  const real = require(PAYSTACK_TRANSFER_CLIENT_MODULE);
  require.cache[PAYSTACK_TRANSFER_CLIENT_MODULE] = {
    id: PAYSTACK_TRANSFER_CLIENT_MODULE,
    filename: PAYSTACK_TRANSFER_CLIENT_MODULE,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      ...real,
      createPaystackTransferClient: fakePaystackTransfer.createPaystackTransferClient,
    },
  };
}

/** Boots the app on an ephemeral port. Returns a client bound to that server. */
async function startTestServer(options = {}) {
  silenceMorgan();

  // STAGE 1: the review deadline is decided by server/config/clock.js. Giving it
  // the SAME clock the fake Firestore resolves serverTimestamp() against keeps
  // `submittedAt`, `reviewDeadlineAt` and the deadline comparison in one time
  // frame inside a test.
  clock.setClock(options.clock);

  const fake = createFakeFirebase(options);

  // Guard: if injection ever stops working, fail loudly rather than silently
  // initialising the real admin SDK against a real project.
  installFakeFirebase(fake);
  if (require.cache[FIREBASE_MODULE].exports.db !== fake.db) {
    throw new Error('Fake Firebase injection failed; refusing to run tests.');
  }

  // STAGE 1F: the Paystack client module is swapped the same way, before the
  // app chain loads paymentService, so no test process can reach Paystack.
  const paystack = createFakePaystack();
  installFakePaystack(paystack);
  if (require.cache[PAYSTACK_CLIENT_MODULE].exports.createPaystackClient !== paystack.createPaystackClient) {
    throw new Error('Fake Paystack injection failed; refusing to run tests.');
  }

  // Transfer operations (recipient creation, payout, bank directory) are a
  // separate client from checkout/verification and get their own queue.
  const paystackTransfer = createFakePaystackTransfer();
  installFakePaystackTransfer(paystackTransfer);

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
    app,
    fake,
    paystack,
    paystackTransfer,
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
      clock.resetClock();
    },
  };

  return client;
}

module.exports = { startTestServer };
