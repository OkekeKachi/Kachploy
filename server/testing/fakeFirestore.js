'use strict';

/**
 * In-memory double for the Firebase Admin SDK surface used by server/routes/*.
 *
 * Purpose: allow characterization tests to exercise the real Express app and the
 * real route handlers without initializing firebase-admin, without network
 * access, and without any possibility of reading or writing production Firestore.
 *
 * Semantics deliberately mirrored from the real SDK (because route behaviour
 * depends on them):
 *   - doc.get() on a missing doc  -> exists === false, data() === undefined
 *   - doc.update() on a missing doc -> throws (real SDK: NOT_FOUND)
 *   - set(obj, { merge: true })   -> merge into existing
 *   - set(obj)                    -> replace existing entirely
 *   - FieldValue.increment(n)     -> applied against existing value (missing === 0)
 *   - FieldValue.serverTimestamp()-> resolved at write time
 *   - Date and serverTimestamp()  -> stored as a Timestamp (see timestampFrom)
 *   - data()/docs return defensive copies
 *
 * Anything NOT implemented throws loudly, so that a future route change which
 * starts using an un-stubbed API surfaces as a test failure rather than silently
 * passing against a fake.
 */

const INCREMENT = 'increment';
const SERVER_TIMESTAMP = 'serverTimestamp';

const AUTO_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function autoId() {
  let out = '';
  for (let i = 0; i < 20; i += 1) {
    out += AUTO_ID_ALPHABET[Math.floor(Math.random() * AUTO_ID_ALPHABET.length)];
  }
  return out;
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function notFound(path) {
  const err = new Error(`5 NOT_FOUND: no entity to update: ${path}`);
  err.code = 5;
  return err;
}

/**
 * Builds the value this fake stores for a Firestore Timestamp.
 *
 * STAGE 5H. This previously had no representation at all, which is why the fake
 * and production disagreed about timestamps in two *opposite* directions:
 *
 *   * `FieldValue.serverTimestamp()` resolved straight to the clock's ISO string,
 *     where production stores a Timestamp;
 *   * a `Date` was stored as a `Date` (explicitly, "standing in for Firestore
 *     Timestamps"), but Firestore converts a Date to a Timestamp on write
 *     (`serializer.js` accepts `Timestamp | Date`), so production does not store
 *     Dates -- and because `Date.prototype.toJSON` is an ISO string, a read-back
 *     Date reached res.json() as a string where production sends an object.
 *
 * The real admin SDK's Timestamp has no toJSON(), and its only own properties
 * are `_seconds` and `_nanoseconds`, so JSON.stringify -- and therefore res.json
 * -- emits {"_seconds":N,"_nanoseconds":M}. That is the wire shape the frontend
 * actually has to decode, so this reproduces it exactly with a plain object.
 *
 * A plain object is deliberate rather than a stand-in class: clone() below uses
 * structuredClone, which drops a custom prototype (losing a toDate() method) and
 * throws outright on an own function property (a toDate() stand-in). No service
 * in this codebase calls toDate(), and the client never sees a method because
 * Axios parses the response body as JSON, so the two plain properties are the
 * whole observable surface.
 *
 * `value` may be a Date or the ISO string the clock returns.
 */
function timestampFrom(value) {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  const seconds = Math.floor(ms / 1000);
  // Derived rather than `ms % 1000`, which is negative for pre-1970 instants.
  return { _seconds: seconds, _nanoseconds: (ms - seconds * 1000) * 1e6 };
}

/** Resolves sentinels/values in a write payload down to plain data. */
function resolveValue(value) {
  if (Array.isArray(value)) return value.map(resolveValue);
  // STAGE 5H: a Date becomes a Timestamp here, exactly as it does in production.
  if (value instanceof Date) return timestampFrom(value);
  if (value && typeof value === 'object') {
    if (value.__sentinel === INCREMENT) return value.n;
    if (value.__sentinel === SERVER_TIMESTAMP) return timestampFrom(value.clock());
    const out = {};
    for (const key of Object.keys(value)) out[key] = resolveValue(value[key]);
    return out;
  }
  return value;
}

class DocSnapshot {
  constructor(id, data) {
    this.id = id;
    this._data = data;
    this.exists = data !== undefined;
  }

  data() {
    return clone(this._data);
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }

  forEach(fn) {
    this.docs.forEach(fn);
  }
}

class DocRef {
  constructor(store, collectionName, id) {
    this._store = store;
    this._collection = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  async get() {
    this._store.calls.push({ op: 'get', path: this.path });
    return new DocSnapshot(this.id, this._store.read(this._collection, this.id));
  }

  async set(data, options = {}) {
    this._store.calls.push({ op: 'set', path: this.path, merge: Boolean(options.merge) });
    this._store.write(this._collection, this.id, resolveValue(data), Boolean(options.merge));
    return undefined;
  }

  async update(data) {
    this._store.calls.push({ op: 'update', path: this.path });
    const current = this._store.read(this._collection, this.id);
    if (current === undefined) throw notFound(this.path);

    const resolved = resolveValue(data);
    const next = { ...current };
    for (const key of Object.keys(resolved)) {
      const incoming = resolved[key];
      // increment() was resolved to a bare number above; re-apply increment
      // semantics by checking the sentinel on the ORIGINAL payload instead.
      const original = data[key];
      if (original && original.__sentinel === INCREMENT) {
        const existing = typeof current[key] === 'number' ? current[key] : 0;
        next[key] = existing + original.n;
      } else {
        next[key] = incoming;
      }
    }
    this._store.write(this._collection, this.id, next, true);
    return undefined;
  }

  async delete() {
    this._store.calls.push({ op: 'delete', path: this.path });
    this._store.remove(this._collection, this.id);
    return undefined;
  }
}

class Query {
  constructor(store, collectionName, constraints) {
    this._store = store;
    this._collection = collectionName;
    this._constraints = constraints;
  }

  where(field, operator, value) {
    if (operator !== '==') {
      throw new Error(
        `fakeFirestore: unsupported operator "${operator}". Only "==" is implemented.`
      );
    }
    return new Query(this._store, this._collection, [
      ...this._constraints,
      { type: 'where', field, operator, value },
    ]);
  }

  orderBy() {
    throw new Error('fakeFirestore: orderBy() is not implemented.');
  }

  limit() {
    throw new Error('fakeFirestore: limit() is not implemented.');
  }

  async get() {
    this._store.calls.push({ op: 'query', path: this._collection, constraints: this._constraints });
    const rows = this._store.list(this._collection);
    const docs = [];
    for (const [id, data] of rows) {
      let keep = true;
      for (const c of this._constraints) {
        if (c.type !== 'where') continue;
        if (data === undefined || data[c.field] !== c.value) {
          keep = false;
          break;
        }
      }
      if (keep) docs.push(new DocSnapshot(id, data));
    }
    return new QuerySnapshot(docs);
  }
}

class CollectionRef {
  constructor(store, name) {
    this._store = store;
    this._name = name;
    this.id = name;
  }

  doc(id) {
    return new DocRef(this._store, this._name, id || autoId());
  }

  async get() {
    this._store.calls.push({ op: 'collection.get', path: this._name });
    return new QuerySnapshot(this._store.list(this._name).map(([id, data]) => new DocSnapshot(id, data)));
  }

  async add(data) {
    const id = autoId();
    this._store.calls.push({ op: 'add', path: this._name });
    this._store.write(this._name, id, resolveValue(data), false);
    return new DocRef(this._store, this._name, id);
  }

  where(field, operator, value) {
    return new Query(this._store, this._name, []).where(field, operator, value);
  }
}

class Store {
  constructor(clock) {
    this.collections = new Map();
    this.calls = [];
    this.clock = clock;
  }

  bucket(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  read(collection, id) {
    const row = this.bucket(collection).get(id);
    return row === undefined ? undefined : clone(row);
  }

  list(collection) {
    return [...this.bucket(collection).entries()].map(([id, data]) => [id, clone(data)]);
  }

  write(collection, id, data, merge) {
    const bucket = this.bucket(collection);
    if (merge && bucket.has(id)) {
      bucket.set(id, { ...bucket.get(id), ...data });
    } else {
      bucket.set(id, clone(data));
    }
  }

  remove(collection, id) {
    this.bucket(collection).delete(id);
  }

  seed(collection, id, data) {
    // STAGE 5H: seeds go through resolveValue for the same reason writes do --
    // Firestore has no Date type, so a seeded document can never hold one. Without
    // this, `fixtures.application()`'s `dateApplied: new Date(...)` would reach
    // res.json() as an ISO string while a freshly applied application returned a
    // Timestamp object, and the two would disagree inside the same fake.
    this.bucket(collection).set(id, resolveValue(data));
  }

  collection(name) {
    return new CollectionRef(this, name);
  }

  reset() {
    this.collections = new Map();
    this.calls = [];
  }
}

/**
 * Builds a { admin, db } object matching the shape exported by
 * server/config/firebase.js. Injected in place of that module so that
 * `admin.initializeApp()` is never called.
 */
function createFakeFirebase(options = {}) {
  const clock = options.clock || (() => new Date().toISOString());

  const store = new Store(clock);

  const increment = (n) => ({ __sentinel: INCREMENT, n });
  const serverTimestamp = () => ({ __sentinel: SERVER_TIMESTAMP, clock });

  const firestoreFn = () => db;
  firestoreFn.FieldValue = { increment, serverTimestamp };

  // ---- Auth double -------------------------------------------------------
  const tokens = new Map(); // token -> decoded claims
  const authUsers = new Map(); // uid -> { uid, email, displayName, phoneNumber, photoURL }
  const authCalls = [];

  function issueToken(uid, claims = {}) {
    const token = `token-${uid}-${tokens.size + 1}`;
    tokens.set(token, { uid, ...claims });
    return token;
  }

  const auth = {
    async verifyIdToken(token) {
      authCalls.push({ op: 'verifyIdToken', token });
      const decoded = tokens.get(token);
      if (!decoded) {
        const err = new Error('Firebase ID token could not be verified');
        err.code = 'auth/invalid-id-token';
        throw err;
      }
      return { ...decoded };
    },
    async updateUser(uid, patch) {
      authCalls.push({ op: 'updateUser', uid, patch });
      const existing = authUsers.get(uid);
      if (!existing) {
        const err = new Error(`Failed to update user: ${uid}`);
        err.code = 'auth/user-not-found';
        throw err;
      }
      authUsers.set(uid, { ...existing, ...clone(patch) });
      return existing;
    },
    async createUser(props) {
      authCalls.push({ op: 'createUser', props });
      const uid = props.uid || `uid-${authUsers.size + 1}`;
      const record = { uid, ...clone(props) };
      authUsers.set(uid, record);
      return record;
    },
    async deleteUser(uid) {
      authUsers.delete(uid);
    },
  };

  const admin = {
    auth: () => auth,
    firestore: firestoreFn,
    // Present only so that accidental use is observable; initializeApp must
    // never be reached because config/firebase.js is never executed.
    initializeApp(...args) {
      store.calls.push({ op: 'initializeApp', args: args.length });
      return admin;
    },
  };

  const db = store;

  return {
    admin,
    db,
    store,
    auth: {
      issueToken,
      createUser: (...args) => auth.createUser(...args),
      users: authUsers,
      calls: authCalls,
    },
    reset() {
      store.reset();
      authCalls.length = 0;
    },
    resetAll() {
      tokens.clear();
      authUsers.clear();
      this.reset();
    },
  };
}

module.exports = { createFakeFirebase, timestampFrom };
