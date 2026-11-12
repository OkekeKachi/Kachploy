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
 *   - doc.create() on an existing doc -> throws (real SDK: code 6 ALREADY_EXISTS)
 *   - set(obj, { merge: true })   -> merge into existing
 *   - set(obj)                    -> replace existing entirely
 *   - FieldValue.increment(n)     -> applied against existing value (missing === 0)
 *   - FieldValue.serverTimestamp()-> resolved at write time
 *   - Date and serverTimestamp()  -> stored as a Timestamp (see timestampFrom)
 *   - runTransaction(fn)          -> optimistic read-decide-write with conflict
 *                                    detection and bounded retry (Stage 1K/3C.1.3)
 *   - data()/docs return defensive copies
 *
 * Anything NOT implemented throws loudly, so that a future route change which
 * starts using an un-stubbed API surfaces as a test failure rather than silently
 * passing against a fake.
 */

const INCREMENT = 'increment';
const SERVER_TIMESTAMP = 'serverTimestamp';

/**
 * STAGE 2G. Value returned by FieldPath.documentId() in this double. Ordering
 * by document id is the deterministic cursor the bounded backfill pages with.
 */
const DOCUMENT_ID_FIELD = '__name__';

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
 * STAGE 1K. The real SDK's code-6 conflict, raised by `doc().create()` when the
 * document already exists. Modelled so the atomic-create loser path in
 * paymentService is classified by code exactly as it would be in production.
 */
function alreadyExists(path) {
  const err = new Error(`6 ALREADY_EXISTS: entity already exists: ${path}`);
  err.code = 6;
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

  /**
   * STAGE 1K. Atomic create: writes ONLY when no document exists at this id,
   * mirroring the real SDK's `doc().create()`. The real SDK rejects an existing
   * document with a code-6 ALREADY_EXISTS error; this throws the same shape so
   * the service's "already exists" branch is exercised exactly as in
   * production. The check and the write are synchronous (no await between them),
   * which is what makes two concurrent creates on one id resolve to ONE winner
   * and one ALREADY_EXISTS loser -- the store is single-threaded.
   */
  async create(data) {
    this._store.calls.push({ op: 'create', path: this.path });
    if (this._store.read(this._collection, this.id) !== undefined) {
      throw alreadyExists(this.path);
    }
    this._store.write(this._collection, this.id, resolveValue(data), false);
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

  /** STAGE 2G. Only FieldPath.documentId(), ascending, is implemented. */
  orderBy(field, direction = 'asc') {
    if (direction !== 'asc') {
      throw new Error('fakeFirestore: only ascending ordering is implemented.');
    }
    return new Query(this._store, this._collection, [
      ...this._constraints,
      { type: 'orderBy', field, direction },
    ]);
  }

  limit(count) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('fakeFirestore: limit() requires a positive safe integer.');
    }
    return new Query(this._store, this._collection, [
      ...this._constraints,
      { type: 'limit', count },
    ]);
  }

  /**
   * STAGE 2G. Exclusive cursor against the ordered value (a document id for
   * FieldPath.documentId() ordering). Mirrors the real SDK's exclusive
   * semantics: results strictly AFTER the cursor.
   */
  startAfter(value) {
    return new Query(this._store, this._collection, [
      ...this._constraints,
      { type: 'startAfter', value },
    ]);
  }

  async get() {
    this._store.calls.push({ op: 'query', path: this._collection, constraints: this._constraints });
    const orderBys = this._constraints.filter((c) => c.type === 'orderBy');
    if (orderBys.length > 1) {
      throw new Error('fakeFirestore: only a single orderBy() is implemented.');
    }
    if (orderBys[0] && orderBys[0].field !== DOCUMENT_ID_FIELD) {
      throw new Error(
        `fakeFirestore: only FieldPath.documentId() ordering is implemented, got "${orderBys[0].field}".`
      );
    }
    const startAfters = this._constraints.filter((c) => c.type === 'startAfter');
    if (startAfters.length > 1) {
      throw new Error('fakeFirestore: only a single startAfter() is implemented.');
    }
    if (startAfters[0] && !orderBys[0]) {
      throw new Error('fakeFirestore: startAfter() requires a prior orderBy().');
    }
    const limits = this._constraints.filter((c) => c.type === 'limit');
    if (limits.length > 1) {
      throw new Error('fakeFirestore: only a single limit() is implemented.');
    }

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

    if (orderBys[0]) {
      docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    if (startAfters[0]) {
      const cursor = startAfters[0].value;
      if (typeof cursor !== 'string') {
        throw new Error(
          'fakeFirestore: startAfter() on FieldPath.documentId() requires a document id string.'
        );
      }
      const first = docs.findIndex((d) => d.id > cursor);
      if (first === -1) docs.length = 0;
      else docs.splice(0, first);
    }
    if (limits[0]) {
      docs.length = Math.min(docs.length, limits[0].count);
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
    // Per-document commit counter. A transaction records the version it read
    // and refuses to commit if a later write changed it -- the property two
    // concurrent transactions depend on. Absent means version 0.
    this.versions = new Map();
  }

  versionKey(collection, id) {
    return `${collection}/${id}`;
  }

  versionOf(collection, id) {
    return this.versions.get(this.versionKey(collection, id)) || 0;
  }

  bumpVersion(collection, id) {
    const key = this.versionKey(collection, id);
    this.versions.set(key, (this.versions.get(key) || 0) + 1);
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
    this.bumpVersion(collection, id);
  }

  remove(collection, id) {
    this.bucket(collection).delete(id);
    this.bumpVersion(collection, id);
  }

  seed(collection, id, data) {
    // STAGE 5H: seeds go through resolveValue for the same reason writes do --
    // Firestore has no Date type, so a seeded document can never hold one. Without
    // this, `fixtures.application()`'s `dateApplied: new Date(...)` would reach
    // res.json() as an ISO string while a freshly applied application returned a
    // Timestamp object, and the two would disagree inside the same fake.
    this.bucket(collection).set(id, resolveValue(data));
    this.bumpVersion(collection, id);
  }

  /**
   * STAGE 1K, extended by STAGE 3C.1.3. Optimistic Firestore transaction with
   * the two properties the services rely on:
   *
   *   1. ALL READS BEFORE ALL WRITES. `tx.get` after the first `tx.set`/`update`
   *      throws FAILED_PRECONDITION (code 9), exactly as the real SDK does.
   *   2. CONFLICT DETECTION. Each `tx.get` records the document's commit version.
   *      At commit, if any read document has been written since, the transaction
   *      is retried (bounded), and after the bound it aborts with ABORTED (code
   *      10). This is what makes two genuinely concurrent transactions resolve
   *      to one winner and one loser instead of both committing.
   *
   * Writes are buffered and applied together at commit; nothing is written if
   * the callback throws or if commit validation fails, so a failed transaction
   * leaves no partial state. The callback must be retry-safe: it may run more
   * than once, so it must not perform external side effects.
   *
   * The real SDK is stronger than this (server-side snapshot isolation,
   * automatic retry with backoff); the fake models the observable contract the
   * tests depend on and says so rather than claiming to be Firestore.
   */
  async runTransaction(callback) {
    this.calls.push({ op: 'runTransaction' });
    const MAX_ATTEMPTS = 5;

    for (let attempt = 1; ; attempt += 1) {
      const reads = [];
      const pending = [];
      let writesStarted = false;

      const tx = {
        get: async (ref) => {
          if (!(ref instanceof DocRef)) {
            throw new Error('fakeFirestore: transaction.get only supports a document reference');
          }
          if (writesStarted) {
            const err = new Error(
              `9 FAILED_PRECONDITION: Firestore transactions require all reads to be executed before all writes: ${ref.path}`
            );
            err.code = 9;
            throw err;
          }
          reads.push({
            collection: ref._collection,
            id: ref.id,
            version: this.versionOf(ref._collection, ref.id),
          });
          return new DocSnapshot(ref.id, this.read(ref._collection, ref.id));
        },
        set: (ref, data) => {
          writesStarted = true;
          pending.push({ type: 'set', collection: ref._collection, id: ref.id, data: resolveValue(data) });
        },
        update: (ref, data) => {
          writesStarted = true;
          pending.push({ type: 'update', collection: ref._collection, id: ref.id, data });
        },
        create: (ref, data) => {
          writesStarted = true;
          pending.push({ type: 'create', collection: ref._collection, id: ref.id, data: resolveValue(data) });
        },
        delete: (ref) => {
          writesStarted = true;
          pending.push({ type: 'delete', collection: ref._collection, id: ref.id });
        },
      };

      const result = await callback(tx);

      // Contention: a document read by this transaction changed before commit.
      const conflicted = reads.some(
        (read) => this.versionOf(read.collection, read.id) !== read.version
      );
      if (conflicted) {
        if (attempt < MAX_ATTEMPTS) continue;
        const err = new Error('10 ABORTED: too much contention on these documents; please try again');
        err.code = 10;
        throw err;
      }

      // Commit. A create that now collides, or an update to a missing document,
      // throws BEFORE anything is written -- matching "all-or-nothing".
      const staged = pending.map((entry) => ({ ...entry, prior: this.read(entry.collection, entry.id) }));
      for (const entry of staged) {
        if (entry.type === 'set' || entry.type === 'delete') continue;
        if (entry.type === 'create' && entry.prior !== undefined) throw alreadyExists(`${entry.collection}/${entry.id}`);
        if (entry.type === 'update' && entry.prior === undefined) throw notFound(`${entry.collection}/${entry.id}`);
      }
      for (const entry of staged) {
        this.calls.push({ op: entry.type, path: `${entry.collection}/${entry.id}` });
        if (entry.type === 'delete') {
          this.remove(entry.collection, entry.id);
        } else if (entry.type === 'set' || entry.type === 'create') {
          this.write(entry.collection, entry.id, entry.data, false);
        } else {
          const resolved = resolveValue(entry.data);
          const next = { ...entry.prior };
          for (const key of Object.keys(resolved)) {
            const original = entry.data[key];
            if (original && original.__sentinel === INCREMENT) {
              const existing = typeof entry.prior[key] === 'number' ? entry.prior[key] : 0;
              next[key] = existing + original.n;
            } else {
              next[key] = resolved[key];
            }
          }
          this.write(entry.collection, entry.id, next, false);
        }
      }
      return result;
    }
  }

  collection(name) {
    return new CollectionRef(this, name);
  }

  reset() {
    this.collections = new Map();
    this.calls = [];
    this.versions = new Map();
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
  // STAGE 2G: FieldPath.documentId() for document-id-ordered backfill queries.
  firestoreFn.FieldPath = { documentId: () => DOCUMENT_ID_FIELD };

  // ---- Auth double -------------------------------------------------------
  const tokens = new Map(); // token -> decoded claims
  const authUsers = new Map(); // uid -> { uid, email, displayName, phoneNumber, photoURL }
  const authCalls = [];

  function issueToken(uid, claims = {}) {
    const token = `token-${uid}-${tokens.size + 1}`;
    // Real Firebase ID tokens always carry an `email_verified` claim (false until
    // the account is confirmed), so the double emits one too and defaults it to
    // verified -- the state every `client.authed()` caller models. A test that
    // needs an unverified caller passes `{ email_verified: false }` explicitly.
    tokens.set(token, { email_verified: true, uid, ...claims });
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
