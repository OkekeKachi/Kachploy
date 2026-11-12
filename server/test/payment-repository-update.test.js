'use strict';

/**
 * Stage 1D tests for paymentRepository.updatePaymentFields -- the partial-
 * update primitive the provider-verification stages will build on.
 *
 * This is a repository-level suite: it exercises the repository module
 * directly, against the in-memory Firestore double, with no HTTP surface, no
 * auth and no Paystack involved. The repository is required LAZILY, after
 * startTestServer has installed the fake in require.cache -- requiring it at
 * the top of the file would load the real config/firebase.js (the same reason
 * employments.test.js requires its repository inside a helper).
 *
 * What the fake can and cannot prove (fakeFirestore.js, DocRef.update):
 *   - update() writes only the supplied keys over the existing document, so
 *     "unspecified fields survive" is observable directly;
 *   - update() on a missing document throws NOT_FOUND (code 5) and creates
 *     nothing -- the real SDK's behaviour, mirrored;
 *   - every primitive is recorded in store.calls as { op, path }, so which
 *     primitive ran ('update' vs 'set') is auditable without touching the
 *     fake or the repository.
 * It does NOT model transactions, server-side field paths or real network
 * failures; nothing here claims those.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { startTestServer } = require('../testing/testApp');
const { payment } = require('../testing/fixtures');

let client;
let paymentRepository;

test.before(async () => {
  client = await startTestServer();
  // After the fake is installed in require.cache, and only then.
  paymentRepository = require('../repositories/paymentRepository');
});

test.after(async () => {
  await client.close();
});

test.beforeEach(() => {
  client.fake.resetAll();
});

/** Seeds one payment document directly, bypassing the API. */
const seedPayment = (id, overrides = {}) => client.seed('payments', id, payment(overrides));

/** The stored payment document, or undefined when absent. */
const storedPayment = (id) => client.readDoc('payments', id);

/** Every recorded write/read op against the payments collection. */
const paymentCalls = () => client.fake.store.calls.filter((c) => c.path.startsWith('payments/'));

test('updating one field leaves every other existing field untouched', async () => {
  seedPayment('milestone-1');
  const before = storedPayment('milestone-1');

  await paymentRepository.updatePaymentFields('milestone-1', { status: 'pending' });

  const after = storedPayment('milestone-1');
  assert.equal(after.status, 'pending');
  // Every other field -- the full 15-key P2 document minus status -- is byte-
  // for-byte what was seeded.
  assert.deepEqual({ ...after, status: 'created' }, before);
  assert.equal(Object.keys(after).length, Object.keys(before).length, 'no key added, none dropped');
});

test('updating multiple fields changes only the requested fields', async () => {
  seedPayment('milestone-1');
  const before = storedPayment('milestone-1');

  await paymentRepository.updatePaymentFields('milestone-1', {
    status: 'pending',
    providerReference: 'paystack-ref-1',
    verifyAttempts: 1,
  });

  const after = storedPayment('milestone-1');
  assert.equal(after.status, 'pending');
  assert.equal(after.providerReference, 'paystack-ref-1');
  assert.equal(after.verifyAttempts, 1);
  // The nine untouched fields are still exactly the seeded values.
  for (const key of ['milestoneId', 'contractId', 'employmentId', 'taskId', 'employerId', 'employeeId', 'amountMinor', 'currency', 'commissionBps', 'commissionAmountMinor', 'idempotencyKey', 'initiatedBy', 'createdAt']) {
    assert.deepEqual(after[key], before[key], `field ${key} must be untouched`);
  }
  // Two new keys (providerReference, verifyAttempts) on top of the original
  // document; status was overwritten in place, not added.
  assert.equal(Object.keys(after).length, Object.keys(before).length + 2);
});

test('the document updated is the one named by the supplied identifier', async () => {
  seedPayment('milestone-1', { idempotencyKey: 'key-one', amountMinor: 500000 });
  seedPayment('milestone-2', { idempotencyKey: 'key-two', amountMinor: 750000 });
  const neighbour = storedPayment('milestone-1');

  await paymentRepository.updatePaymentFields('milestone-2', { status: 'pending' });

  assert.equal(storedPayment('milestone-2').status, 'pending');
  assert.deepEqual(storedPayment('milestone-1'), neighbour, 'the sibling document is untouched');
  // And the audit trail names exactly that document.
  assert.deepEqual(paymentCalls(), [{ op: 'update', path: 'payments/milestone-2' }]);
});

test('a missing document rejects with NOT_FOUND and creates nothing', async () => {
  seedPayment('milestone-1');

  await assert.rejects(
    () => paymentRepository.updatePaymentFields('milestone-missing', { status: 'pending' }),
    (error) => {
      assert.equal(error.code, 5, 'the SDK NOT_FOUND code propagates');
      assert.equal(error.message, '5 NOT_FOUND: no entity to update: payments/milestone-missing');
      return true;
    }
  );

  // The update did not silently create the document, and the only payment in
  // the store is the seeded one, unchanged.
  assert.equal(storedPayment('milestone-missing'), undefined);
  assert.deepEqual(Object.keys(client.readAll('payments')), ['milestone-1']);
  assert.equal(storedPayment('milestone-1').status, 'created');
  // The attempt itself is on the record, at the missing path.
  assert.deepEqual(paymentCalls(), [{ op: 'update', path: 'payments/milestone-missing' }]);
});

test('the SDK error propagates unwrapped -- the repository raises nothing of its own', async () => {
  seedPayment('milestone-1');

  // Convention across updateTaskFields/updateJobFields/updateInterviewFields:
  // no try/catch in the repository. The rejection is the SDK's own error,
  // carrying its own message and code, not a repository-shaped one.
  const error = await paymentRepository.updatePaymentFields('milestone-1', {}).then(
    () => null,
    (caught) => caught
  );

  // An empty patch on an EXISTING document is a successful no-op in the fake
  // (and harmless to assert here): it proves the happy path resolves rather
  // than throwing, so the rejection below really is about existence.
  assert.equal(error, null, 'an empty patch on an existing document resolves');

  const missing = await paymentRepository.updatePaymentFields('gone', { status: 'x' }).then(
    () => null,
    (caught) => caught
  );
  assert.ok(missing instanceof Error);
  assert.equal(missing.name, 'Error', 'not re-labelled into a repository error class');
  assert.equal(missing.code, 5);
  assert.equal(missing.message, '5 NOT_FOUND: no entity to update: payments/gone');
});

test('the operation uses the partial-update primitive, never a full-document set', async () => {
  seedPayment('milestone-1');

  await paymentRepository.updatePaymentFields('milestone-1', { status: 'pending' });

  // Direct primitive audit, exactly as payments.test.js audits the create
  // path: the fake records which call ran. One update on this document, and
  // not a single set() anywhere in the payments collection -- a set() would
  // either replace the whole document (tests above would fail) or, with a
  // merge flag, be a different primitive than the one this stage pins.
  assert.deepEqual(paymentCalls(), [{ op: 'update', path: 'payments/milestone-1' }]);
  assert.equal(paymentCalls().filter((c) => c.op === 'set').length, 0);
});

test('field names and values pass through verbatim -- nothing is normalised', async () => {
  seedPayment('milestone-1');

  const patch = {
    '  Status_': '  PENDING  ',
    nested: { array: [1, 'two', { three: true }] },
  };
  await paymentRepository.updatePaymentFields('milestone-1', patch);

  const after = storedPayment('milestone-1');
  // The odd key arrives with its spaces and case intact, the odd value too.
  assert.equal(Object.prototype.hasOwnProperty.call(after, '  Status_'), true);
  assert.equal(after['  Status_'], '  PENDING  ');
  assert.deepEqual(after.nested, patch.nested);
  // The pre-existing 'status' field was not the one written, and is unchanged.
  assert.equal(after.status, 'created');
});
