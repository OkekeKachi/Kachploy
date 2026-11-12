'use strict';

// paymentService.js
//
// Business and data layer for the payments resource (new in Stage P2). P2 is
// the PAYMENT-RECORD FOUNDATION: it stores, for one milestone of an active
// contract on an active employment, a local record saying "the employer asked
// us to initiate a payment of this milestone's amount". That is all it does.
//
// WHAT A 'created' RECORD MEANS, EXACTLY: Kachploy has stored a payment
// request. It is NOT evidence that a payment provider was contacted, that the
// employer was charged, or that the employee was paid. No provider is named,
// called or configured anywhere in this resource yet; there is no
// authorization URL, no access code; and the only status this file WRITES is
// still 'created', so there is no local transition any endpoint could
// perform. Since Stage 1E the canonical vocabulary below names five statuses
// (created, pending, paid, failed, needs_review) so every stage shares one
// vocabulary, but the provider call itself, the mapping of provider states
// onto it, and every transition still belong to later stages and must be
// driven by server-side provider responses and verified webhooks, never by a
// client assertion. Until then this resource deliberately makes no escrow,
// split-settlement or payout claim of any kind.
//
// WHAT EXISTS HERE
//   * initiatePayment -- the only CREATION write path. Eligibility and
//     idempotency rules, then exactly ONE deterministic write
//     (payments/{milestoneId}). The milestone and contract are established by
//     the router's requireMilestoneEmployer guard before this runs;
//     everything here is payload validation, eligibility checks and the write.
//   * getPaymentForMilestone -- the party-scoped read (the read guard admits
//     the contract's two parties).
//   * initializePaymentForMilestone (Stage 1F) -- takes an EXISTING 'created'
//     record, or a definitive 'failed' record (retried with a NEW reference), to
//     Paystack in Test Mode and returns a validated checkout URL. It creates no
//     record (initiatePayment owns that), contacts the provider only after
//     every local check passes, and latches the record in-flight before the call
//     so an ambiguous outcome can never be retried blindly.
//     It is initialization ONLY: it never verifies and never maps provider
//     statuses.
//   * verifyPaymentForMilestone (Stage 1G) -- asks Paystack what became of an
//     already-initialized transaction, checks the response against the trusted
//     server-side expectation (reference, currency, amount), and applies the
//     ONE approved status transition the outcome justifies: paid, failed, or
//     needs_review. Retries transient provider failures at most twice (three
//     total attempts). It is verification ONLY: it never initializes, never
//     generates a new reference, never reinitializes after an ambiguous
//     initialization, and never downgrades a paid record.
//
// ELIGIBILITY (product rules, all enforced here):
//   * the milestone's contract must be active;
//   * the contract's employment must be active;
//   * the milestone's task must exist, belong to the contract's employment,
//     and be APPROVED -- approval never charges anyone (approveTask writes
//     only status/reviewedAt on the task document); payment is this separate,
//     later, employer-initiated request;
//   * full amount per milestone only: amountMinor is COPIED from the milestone
//     (whose amounts are immutable -- no edit path exists), so a partial
//     payment is not expressible and no second record for the same milestone
//     can exist (see the id-space note in paymentRepository). The stored amount
//     and the contract's currency are re-checked here as defense in depth --
//     contract creation already validated both, but this is the code that
//     turns stored data into a money-bearing record.
//
// COMMISSION: commissionBps is copied from the contract's create-time SNAPSHOT
// and the per-milestone commission is floor(amountMinor * commissionBps /
// 10000) via config/commission.js -- the same floor rule as the contract, but
// rate-bounded by the snapshot rather than the live constant, so an old
// contract keeps describing the rate it was created under. (Summing per-
// milestone commissions can undershoot the contract-level commission by up to
// 1 kobo per milestone; which figure reconciles against a future provider
// settlement is an open product question recorded in the stage report.)
//
// IDEMPOTENCY (decision, P2):
//   * the client MUST supply an idempotencyKey (trimmed, non-empty, <=128
//     chars). Re-sending the SAME key for the SAME milestone returns the stored
//     record with 200 and rewrites nothing -- an idempotent replay;
//   * the same key for a DIFFERENT milestone is a 400;
//   * a DIFFERENT key for a milestone that already has a record is a 400.
//
// CONCURRENCY LIMITATION, STATED HONESTLY: the harness has no transactions,
// so every check above is check-then-write. Two concurrent initiations with
// the same key against different milestones can both pass the key query and
// write two records sharing a key. No money moves off either (P2 contacts no
// provider), and a same-milestone race still lands on ONE document id, so the
// one-record-per-milestone invariant survives; but this is NOT transaction-
// level idempotency or race safety, and the provider stage must re-read and
// serialise per milestone before charging. The key query is also the only
// cross-document uniqueness mechanism available.
//
// AUTHORIZATION: none of these functions performs any. The identity and
// ownership decisions live in the router guards -- requireMilestoneEmployer
// (initiate) and requireMilestoneParty (read). By the time a call reaches
// this file the caller has already been proven to be the contract's employer
// or one of its two parties as the action requires, and the milestone and
// contract on the way in were loaded from the store, never from the body. The
// eligibility rules below are domain rules, not ownership rules.

const { admin } = require('../config/firebase');
const paymentRepository = require('../repositories/paymentRepository');
const paymentAttemptRepository = require('../repositories/paymentAttemptRepository');
const employmentRepository = require('../repositories/employmentRepository');
const userRepository = require('../repositories/userRepository');
const contractRepository = require('../repositories/contractRepository');
const {
    CONTRACT_CURRENCY,
    isPositiveSafeMinorAmount,
    calculateCommissionMinor,
} = require('../config/commission');
const {
    calculateCheckoutChargeMinor,
    calculateCheckoutFeeMinor,
} = require('../config/fees');
const {
    PaystackConfigurationError,
    getSecretKey,
    getPaystackMode,
} = require('../config/paystack');
const { createPaystackClient } = require('./paystackClient');
const accountingLifecycleService = require('./accountingLifecycleService');

// Constructed once at module load. Construction performs no I/O and reads no
// configuration (Stage 1C proved both); the secret key is read lazily on each
// call, so an unconfigured server fails at request time, not at boot. Under
// the test harness this module was swapped for the recording fake before this
// file was required (testing/testApp.js), so no test process can reach
// Paystack through this reference.
const paystackClient = createPaystackClient();

/**
 * A payment request cannot be described: a missing, malformed or disallowed
 * field, an idempotency key that collides or is malformed, a milestone whose
 * contract or employment is not active, a task that is missing, belongs to
 * another employment, or is not approved. Surfaces as a 400, exactly as every
 * other ValidationError in this codebase.
 */
class PaymentValidationError extends Error {}

/**
 * No payment record exists for the requested milestone. Surfaces as a 404.
 *
 * A backstop in the same sense ContractNotFoundError is: the router's
 * requireMilestoneParty guard turns a missing MILESTONE into its own 404
 * before this class is reached from a route, so it exists for direct service
 * calls and for the case of a valid milestone that simply has no payment
 * record yet -- which is the normal state before an employer initiates one,
 * and is a 404 rather than an empty object because there is no partial
 * resource to represent.
 */
class PaymentNotFoundError extends Error {}

/**
 * STAGE 1F. The provider call was made (or may have been made) and its
 * outcome cannot be reported as success. Surfaces as a 500 with a SAFE
 * message: the provider's own error text, body and any credential never
 * travel with it -- the underlying error rides along only as a non-
 * enumerable `cause` for the server-side log.
 *
 * Crucially this is NOT a claim that the payment failed. A transport error,
 * a timeout, an ambiguous 5xx, or a 2xx with a malformed body all leave the
 * record 'pending' (latched before the call), and the verification stage --
 * never this one -- is what may later resolve it. A definitive provider 4xx
 * is the one case where the transaction is known not to exist; the record is
 * rolled back to 'created' before this error is thrown, so a corrected retry
 * remains possible there.
 */
class PaymentProviderError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'PaymentProviderError';
    }
}

/**
 * The canonical payment statuses -- the ONLY five values a payment document's
 * `status` may ever hold.
 *
 * STAGE 1E. P2 wrote exactly one status; the Paystack integration needs five,
 * so the vocabulary is defined here before any of them can be written. What
 * each one means is deliberately not enforced at this layer, and no
 * transition rule is implemented yet -- this stage only defines the
 * vocabulary. The rules the provider stages MUST follow, recorded here so the
 * first writer of a status cannot redefine it:
 *   * only a transaction that passes every required verification check may
 *     become 'paid';
 *   * an explicitly verified provider 'failed' may become 'failed';
 *   * provider states pending/ongoing/processing/queued map to 'pending';
 *   * abandoned, reversed, unknown, malformed or contradictory results
 *     require 'needs_review';
 *   * a transport failure proves nothing about the transaction;
 *   * 'paid' is never silently downgraded to 'failed', and 'failed' never
 *     transitions directly to 'paid'.
 * There is deliberately no 'provider_pending' -- the in-flight state is
 * 'pending' -- and no refunded, cancelled, authorized or disputed value:
 * those are not part of the approved integration. The list stays exported so
 * the first writer of a sixth status cannot invent one silently.
 */
const PAYMENT_STATUSES = ['created', 'pending', 'paid', 'failed', 'needs_review'];

/** The status a newly created payment record is written with. */
const CREATED_STATUS = 'created';

/** The only contract status that admits a payment record. */
const ACTIVE_CONTRACT_STATUS = 'active';

/** The only employment status that admits a payment record. */
const ACTIVE_EMPLOYMENT_STATUS = 'active';

/** Bound on the client-supplied idempotency key, characters after trim. */
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/**
 * The request-body fields initiatePayment will not accept from a client, no
 * matter what else is valid.
 *
 * Every one of these is either copied from stored documents at initiation time
 * (the contract/task ids, the two identities, the amount, the currency, both
 * commission fields), computed server-side (nothing else), or owned by this
 * resource (status, initiatedBy, createdAt, idempotencyKey is required rather
 * than forbidden). `milestoneId` is deliberately NOT in this list: like
 * contracts' `employmentId`, it is REQUIRED from the body because it NAMES the
 * milestone, and the guard loads the record by it. A client that sends any
 * forbidden field gets a 400 naming the field rather than having it silently
 * dropped -- the same contract createContract makes, for the same reason:
 * silently dropping a money or identity field the client believes was applied
 * is how a client and a document come to disagree.
 *
 * STAGE 1E: the nine provider-integration fields below are forbidden for the
 * same reason, with the same 400. All are written exclusively by server-side
 * verification logic in later stages, never from a request body:
 *   * `chargeMinor` -- the GROSS amount charged to the customer, computed
 *     server-side from the fee calculator;
 *   * `feeMinor` -- the MODELED Kachploy fee (config/fees.js), subtracted
 *     from the gross;
 *   * `providerFeeMinor` -- the ACTUAL fee Paystack reports, when available.
 *     The three are deliberately distinct and must never be conflated with
 *     each other or with `amountMinor`, which remains the milestone's
 *     original amount payable to the recipient and is still copied at
 *     initiation;
 *   * `providerReference`, `providerEnvironment` -- the provider's identifier
 *     for the transaction and the Test/Live environment it ran in;
 *   * `statusReason` -- a short server-authored reason for a status, which
 *     must never carry a secret or a raw provider response body;
 *   * `verifyAttempts` -- a non-negative integer attempt counter maintained by
 *     server-side verification logic;
 *   * `verifiedAt`, `paidAt` -- timestamps that may be absent or null until
 *     the corresponding event occurs, matching this schema's conventions.
 */
const CLIENT_FORBIDDEN_PAYMENT_FIELDS = [
    'id',
    'paymentTarget',
    'contractId',
    'employmentId',
    'taskId',
    'taskIds',
    'employerId',
    'employeeId',
    'amountMinor',
    'currency',
    'commissionBps',
    'commissionAmountMinor',
    'netPayableMinor',
    'status',
    'initiatedBy',
    'createdAt',
    'chargeMinor',
    'feeMinor',
    'providerReference',
    'providerEnvironment',
    'providerFeeMinor',
    'statusReason',
    'verifyAttempts',
    'verifiedAt',
    'paidAt',
];

/**
 * The same server-owned-field contract for the contract-level endpoints.
 * `contractId` is the one exception: it NAMES the contract being paid and is
 * required from the body, exactly as milestoneId names a milestone. It is
 * still checked against the guard-attached contract, so it is not trusted as
 * authority. `milestoneId` is forbidden here so a client cannot blur the two
 * payment modes.
 */
const CLIENT_FORBIDDEN_CONTRACT_PAYMENT_FIELDS = [
    ...CLIENT_FORBIDDEN_PAYMENT_FIELDS.filter((field) => field !== 'contractId'),
    'milestoneId',
    'paymentMode',
    'totalAmountMinor',
    'jobId',
    'applicationId',
];

const PAYMENT_TARGET_CONTRACT = 'contract';
const PAYMENT_MODE_FULL = 'full';

/**
 * The commission snapshot and net payable amount stamped on a NEW payment.
 *
 * Both initiation paths (milestone and full-contract) go through this one
 * function so they cannot drift. `amountMinor` stays the agreed gross amount
 * the employer pays the platform; `netPayableMinor` is what the employee is
 * later released. The rate comes from the contract's create-time snapshot, not
 * the live constant, so an old contract keeps describing the deal it was
 * created under.
 *
 * A commission that consumes the whole amount is refused: a payment with no
 * positive net cannot release anything and is not a representable deal.
 */
const newPaymentCommissionFields = (grossAmountMinor, commissionBps) => {
    const commissionAmountMinor = calculateCommissionMinor(
        grossAmountMinor,
        commissionBps
    );
    const netPayableMinor = grossAmountMinor - commissionAmountMinor;

    if (!isPositiveSafeMinorAmount(netPayableMinor)) {
        throw new PaymentValidationError(
            'the commission leaves no positive amount payable to the employee'
        );
    }

    return {
        commissionBps,
        commissionAmountMinor,
        netPayableMinor,
    };
};

/**
 * Flattens a snapshot into the `{ id, ...data }` shape every read in this
 * codebase returns.
 */
const toPlainObject = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });

/**
 * Stores the employer's payment request for one milestone and returns the
 * stored record.
 *
 * `milestone` and `contract` arrive from requireMilestoneEmployer (loaded from
 * the store); `actorUid` is req.user.uid from the verified token; `payload`
 * is the raw body. Order of operations, all before the single write:
 *
 *   1. forbidden fields, then milestoneId and idempotencyKey shape;
 *   2. an existing record on this milestone: same key -> replay it unchanged
 *      (return, no write), different key -> 400;
 *   3. eligibility: contract active, employment active;
 *   4. the cross-milestone idempotency-key query;
 *   5. exactly one set() under payments/{milestoneId}, then a re-read so the
 *      response carries the document as stored (with the resolved Timestamp).
 *
 * A refused request reaches no write at all -- there is no partial-record
 * window, because the success path is a single document write.
 */

const initiatePayment = async ({ milestone, contract, actorUid, payload }) => {
    for (const field of CLIENT_FORBIDDEN_PAYMENT_FIELDS) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
            throw new PaymentValidationError(`${field} cannot be supplied`);
        }
    }

    const milestoneId = payload && payload.milestoneId;
    if (!milestoneId || typeof milestoneId !== 'string') {
        throw new PaymentValidationError('Missing required fields');
    }
    if (milestoneId !== milestone.id) {
        throw new PaymentValidationError(
            'milestoneId does not match the milestone being paid'
        );
    }

    const rawKey = payload.idempotencyKey;
    if (rawKey === undefined || rawKey === null || typeof rawKey !== 'string') {
        throw new PaymentValidationError(
            'idempotencyKey is required and must be a string'
        );
    }
    const idempotencyKey = rawKey.trim();
    if (!idempotencyKey) {
        throw new PaymentValidationError('idempotencyKey must not be empty');
    }
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new PaymentValidationError(
            `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
        );
    }

    // A record already exists for this milestone. Same key: the client is
    // retrying its own request -- hand back the stored record, rewrite nothing.
    // Different key: a second attempt at the same milestone, which full-
    // amount-per-milestone forbids outright.
    const existingSnapshot = await paymentRepository.getPaymentByMilestoneId(milestone.id);
    if (existingSnapshot.exists) {
        const existing = toPlainObject(existingSnapshot);
        if (existing.idempotencyKey === idempotencyKey) {
            return { payment: existing, replayed: true };
        }
        throw new PaymentValidationError(
            'a payment already exists for this milestone'
        );
    }

    // The contract must be agreed by both parties. A pending contract's
    // milestones are not payable, and this is a domain rule (the lifecycle
    // state of the resource), so it is a 400 here rather than a guard 403.
    if (contract.status !== ACTIVE_CONTRACT_STATUS) {
        throw new PaymentValidationError(
            'the contract must be active before a milestone payment can be created'
        );
    }

    // The employment the contract sits on must still be active. Re-read at
    // initiation time: an employment can end after the contract was accepted,
    // and work that is no longer being performed is not payable.
    const employmentSnapshot = await employmentRepository.getEmploymentById(
        contract.employmentId
    );
    if (!employmentSnapshot.exists) {
        throw new PaymentValidationError(
            'the employment for this contract no longer exists'
        );
    }
    if (employmentSnapshot.data().status !== ACTIVE_EMPLOYMENT_STATUS) {
        throw new PaymentValidationError(
            'this employment has ended, so a milestone payment cannot be created'
        );
    }

    // Stored-data integrity, checked before anything is written. Contract
    // creation already validated the schedule's amounts and the contract's
    // currency, and no endpoint edits either, so these normally cannot fail.
    // They are still checked here because THIS is the code that turns stored
    // data into a money-bearing record: a milestone or contract written out of
    // band (an admin edit, a future migration) must not become a payment
    // record with a zero, negative, fractional or over-bound amount, or with a
    // currency the platform does not settle. Rejection is an ordinary 400 and
    // leaves no record behind.
    if (!isPositiveSafeMinorAmount(milestone.amountMinor)) {
        throw new PaymentValidationError(
            'the milestone amount is not a valid positive kobo amount'
        );
    }
    if (contract.currency !== CONTRACT_CURRENCY) {
        throw new PaymentValidationError('the contract currency must be NGN');
    }

    // Cross-milestone uniqueness of the key (see the race note in the file
    // header: this is a query, not a constraint).
    const keyMatches = await paymentRepository.findPaymentsByIdempotencyKey(
        idempotencyKey
    );
    if (!keyMatches.empty) {
        throw new PaymentValidationError(
            'idempotencyKey has already been used for a different milestone'
        );
    }

    // Every identity below is copied from the stored milestone/contract; the
    // amount is the milestone's full amount (immutable, no partial payments);
    // the commission uses the contract's rate SNAPSHOT. Nothing here was
    // supplied by the client, and nothing here contacts a provider.
    const record = {
        milestoneId: milestone.id,
        contractId: contract.id,
        employmentId: contract.employmentId,
        ...(milestone.taskId ? { taskId: milestone.taskId } : {}),
        employerId: contract.employerId,
        employeeId: contract.employeeId,
        amountMinor: milestone.amountMinor,
        currency: contract.currency,
        ...newPaymentCommissionFields(
            milestone.amountMinor,
            contract.commissionBps
        ),
        commissionIncluded: true,
        providerEnvironment: getPaystackMode(),
        status: CREATED_STATUS,
        idempotencyKey,
        initiatedBy: actorUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // STAGE 1K. The write is an ATOMIC create, not a blind set. The up-front
    // get above handles the ordinary sequential case; this handles the race two
    // concurrent requests open between that get and this write. `.create()`
    // makes exactly one of them the winner; the loser is told a document is
    // already present and re-reads it to resolve replay-vs-conflict the same way
    // the sequential path does -- so a concurrent duplicate can never overwrite
    // the winner's idempotency key or money fields, and can never produce a
    // second document.
    const outcome = await paymentRepository.createPaymentWithIdempotencyGuard(
        milestone.id,
        record
    );

    if (!outcome.created) {
        if (outcome.reason === 'key-conflict') {
            throw new PaymentValidationError(
                'idempotencyKey has already been used for a different payment'
            );
        }

        // We lost the race. Re-read the document the winner stored and apply the
        // SAME decision the sequential pre-check applies: the same key replays
        // it unchanged; a different key is a second attempt this resource
        // forbids outright.
        const winnerSnapshot = await paymentRepository.getPaymentByMilestoneId(milestone.id);
        const winner = toPlainObject(winnerSnapshot);
        if (winner.idempotencyKey === idempotencyKey) {
            return { payment: winner, replayed: true };
        }
        throw new PaymentValidationError(
            'a payment already exists for this milestone'
        );
    }

    const written = await paymentRepository.getPaymentByMilestoneId(milestone.id);

    return { payment: toPlainObject(written), replayed: false };
};

/**
 * One payment record, by the milestone it pays for.
 *
 * The read guard has already admitted one of the contract's two parties, so
 * this only settles existence. A milestone with no payment record yet is the
 * normal pre-initiation state and answers 404 "Payment not found".
 */
const getPaymentForMilestone = async (milestoneId) => {
    const snapshot = await paymentRepository.getPaymentByMilestoneId(milestoneId);

    if (!snapshot.exists) {
        throw new PaymentNotFoundError('Payment not found');
    }

    return { payment: toPlainObject(snapshot) };
};

// ---------------------------------------------------------------------------
// Full-contract payments
// ---------------------------------------------------------------------------
//
// A full-mode contract is paid as ONE amount -- contract.totalAmountMinor --
// with no milestone or task behind it. The payment document id is
// `contract_<contractId>`, so the provider reference is
// `kp_contract_<contractId>` and the one-record-per-contract rule is enforced
// by the key space. Milestone records keep their existing ids and remain
// distinguishable by the absence of `paymentTarget`.

/** Stores the employer's one payment request for a full contract. */
const initiateContractPayment = async ({ contract, actorUid, payload }) => {
    for (const field of CLIENT_FORBIDDEN_CONTRACT_PAYMENT_FIELDS) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
            throw new PaymentValidationError(`${field} cannot be supplied`);
        }
    }

    const contractId = payload && payload.contractId;
    if (!contractId || typeof contractId !== 'string') {
        throw new PaymentValidationError('Missing required fields');
    }
    if (contractId !== contract.id) {
        throw new PaymentValidationError(
            'contractId does not match the contract being paid'
        );
    }

    const rawKey = payload.idempotencyKey;
    if (rawKey === undefined || rawKey === null || typeof rawKey !== 'string') {
        throw new PaymentValidationError(
            'idempotencyKey is required and must be a string'
        );
    }
    const idempotencyKey = rawKey.trim();
    if (!idempotencyKey) {
        throw new PaymentValidationError('idempotencyKey must not be empty');
    }
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
        throw new PaymentValidationError(
            `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`
        );
    }

    const existingSnapshot = await paymentRepository.getPaymentByContractId(contract.id);
    if (existingSnapshot.exists) {
        const existing = toPlainObject(existingSnapshot);
        if (existing.idempotencyKey === idempotencyKey) {
            return { payment: existing, replayed: true };
        }
        throw new PaymentValidationError(
            'a payment already exists for this contract'
        );
    }

    if (contract.paymentMode !== PAYMENT_MODE_FULL) {
        throw new PaymentValidationError(
            'this contract is paid by milestones, not as a full contract'
        );
    }
    if (contract.status !== ACTIVE_CONTRACT_STATUS) {
        throw new PaymentValidationError(
            'the contract must be active before a contract payment can be created'
        );
    }

    const employmentSnapshot = await employmentRepository.getEmploymentById(
        contract.employmentId
    );
    if (!employmentSnapshot.exists) {
        throw new PaymentValidationError(
            'the employment for this contract no longer exists'
        );
    }
    if (employmentSnapshot.data().status !== ACTIVE_EMPLOYMENT_STATUS) {
        throw new PaymentValidationError(
            'this employment has ended, so a contract payment cannot be created'
        );
    }

    if (!isPositiveSafeMinorAmount(contract.totalAmountMinor)) {
        throw new PaymentValidationError(
            'the contract total is not a valid positive kobo amount'
        );
    }
    if (contract.currency !== CONTRACT_CURRENCY) {
        throw new PaymentValidationError('the contract currency must be NGN');
    }

    const keyMatches = await paymentRepository.findPaymentsByIdempotencyKey(
        idempotencyKey
    );
    if (!keyMatches.empty) {
        throw new PaymentValidationError(
            'idempotencyKey has already been used for a different payment'
        );
    }

    const record = {
        paymentTarget: PAYMENT_TARGET_CONTRACT,
        contractId: contract.id,
        employmentId: contract.employmentId,
        employerId: contract.employerId,
        employeeId: contract.employeeId,
        amountMinor: contract.totalAmountMinor,
        currency: contract.currency,
        ...newPaymentCommissionFields(
            contract.totalAmountMinor,
            contract.commissionBps
        ),
        commissionIncluded: true,
        providerEnvironment: getPaystackMode(),
        status: CREATED_STATUS,
        idempotencyKey,
        initiatedBy: actorUid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const outcome = await paymentRepository.createContractPaymentIfAbsent(
        contract.id,
        record
    );

    if (!outcome.created) {
        if (outcome.reason === 'key-conflict') {
            throw new PaymentValidationError(
                'idempotencyKey has already been used for a different payment'
            );
        }

        const winnerSnapshot = await paymentRepository.getPaymentByContractId(contract.id);
        const winner = toPlainObject(winnerSnapshot);
        if (winner.idempotencyKey === idempotencyKey) {
            return { payment: winner, replayed: true };
        }
        throw new PaymentValidationError(
            'a payment already exists for this contract'
        );
    }

    const written = await paymentRepository.getPaymentByContractId(contract.id);
    return { payment: toPlainObject(written), replayed: false };
};

/** The one payment record for a full contract, if it has been created. */
const getPaymentForContract = async (contractId) => {
    const snapshot = await paymentRepository.getPaymentByContractId(contractId);

    if (!snapshot.exists) {
        throw new PaymentNotFoundError('Payment not found');
    }

    return { payment: toPlainObject(snapshot) };
};

// ---------------------------------------------------------------------------
// STAGE 1F -- initialization (Test Mode only)
// ---------------------------------------------------------------------------

/**
 * Reference prefix. Attempt 1 is kp_<paymentId>; later attempts append
 * _a<attemptNumber>, so no provider reference is ever reused.
 */
const REFERENCE_PREFIX = 'kp_';

/**
 * A milestone id is suitable as a payment reference suffix only if it is made
 * of characters that survive a URL path and a provider reference unaltered.
 * Firestore auto-ids ([A-Za-z0-9]) and this codebase's seeded ids ('ms-1')
 * both pass; anything with dots, slashes, spaces or unicode does not, and
 * rather than encode-and-hope the request is refused before any write or
 * provider call. No length cap is invented here: the provider's own limit, if
 * any, is unvalidated, and the identifier space is already bounded by
 * Firestore's id rules.
 */
const REFERENCE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The only checkout host a returned authorization URL may point at, over
 * https. An allowlist rather than a suffix check: 'checkout.paystack.com.evil
 * .test' must not pass a endsWith test. No subdomain wildcards -- the one
 * host the provider documents for hosted checkout is pinned outright.
 */
const TRUSTED_CHECKOUT_HOSTS = new Set(['checkout.paystack.com']);

const isTrustedCheckoutUrl = (value) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === 'https:' && TRUSTED_CHECKOUT_HOSTS.has(parsed.hostname);
    } catch {
        return false;
    }
};

/** The provider-verification fields this stage is allowed to write, by name. */
const PROVIDER_ENVIRONMENT_TEST = 'test';

/**
 * A payment record belongs to the Paystack environment it was created in.
 * Legacy records written before the tag existed are Test Mode by definition.
 * A record from another environment may not be initialized, verified or
 * reconciled under the current one: a Test Mode transaction must never be
 * mistaken for a Live charge, and a Live server must never try to settle a
 * Test Mode reference. The current mode is read lazily so a misconfigured
 * PAYSTACK_MODE fails as the same 503 as a missing key.
 */
const assertPaymentEnvironment = (record) => {
    const current = getPaystackMode();
    const stored = record.providerEnvironment || PROVIDER_ENVIRONMENT_TEST;

    if (stored !== current) {
        throw new PaymentValidationError(
            'this payment belongs to a different Paystack environment'
        );
    }

    return current;
};
const STATUS_REASON_REJECTED = 'provider rejected the initialization request';
const STATUS_REASON_UNKNOWN = 'initialization outcome unknown; verify before retrying';
const STATUS_REASON_UNUSABLE = 'unusable provider response; verify before retrying';

/** Statuses that are already terminal and must never be re-initialized. */
const PAID_STATUS = 'paid';
const FAILED_STATUS = 'failed';
const NEEDS_REVIEW_STATUS = 'needs_review';
const PENDING_STATUS = 'pending';

/**
 * Retries are throttled by a rolling server-side window rather than permanently
 * exhausted by the old three-attempt counter. A definitive provider rejection
 * created no transaction, so it is safe to try again with a NEW reference; a
 * burst of requests is still bounded. The durable attempt documents are the
 * source of truth for this window.
 */
const MAX_INITIALIZATION_ATTEMPTS_PER_WINDOW = 5;
const INITIALIZATION_ATTEMPT_WINDOW_MS = 60 * 1000;

const initializationAttempts = (record) =>
    record && Number.isInteger(record.verifyAttempts) && record.verifyAttempts >= 0
        ? record.verifyAttempts
        : 0;

const hasProviderReference = (record) =>
    Boolean(
        record &&
            typeof record.providerReference === 'string' &&
            record.providerReference.trim()
    );

const nextInitializationAttempts = (record) => initializationAttempts(record) + 1;

const timestampMillis = (value) => {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
        const millis = Date.parse(value);
        return Number.isNaN(millis) ? null : millis;
    }
    if (typeof value._seconds === 'number') return value._seconds * 1000;
    if (typeof value.seconds === 'number') return value.seconds * 1000;
    return null;
};

const assertInitializationThrottle = async (paymentId) => {
    const snapshot = await paymentAttemptRepository.listAttemptsByPaymentId(paymentId);
    const now = Date.now();
    const recent = (snapshot.docs || []).filter((doc) => {
        const millis = timestampMillis(doc.data().createdAt);
        return millis !== null && millis <= now && now - millis < INITIALIZATION_ATTEMPT_WINDOW_MS;
    });

    if (recent.length >= MAX_INITIALIZATION_ATTEMPTS_PER_WINDOW) {
        throw new PaymentValidationError(
            'too many payment attempts have been started recently; try again shortly'
        );
    }
};

const attemptPaymentTarget = (record) =>
    record.paymentTarget === PAYMENT_TARGET_CONTRACT ? PAYMENT_TARGET_CONTRACT : 'milestone';

const buildAttemptRecord = ({
    paymentId,
    record,
    attemptNumber,
    reference,
    chargeMinor,
    feeMinor,
}) => ({
    paymentId,
    paymentTarget: attemptPaymentTarget(record),
    contractId: record.contractId,
    ...(record.milestoneId
        ? { milestoneId: record.milestoneId }
        : record.paymentTarget === PAYMENT_TARGET_CONTRACT
          ? {}
          : { milestoneId: paymentId }),
    attemptNumber,
    reference,
    amountMinor: record.amountMinor,
    currency: record.currency,
    commissionAmountMinor: record.commissionAmountMinor,
    expectedChargeMinor: chargeMinor,
    expectedFeeMinor: feeMinor,
    status: PENDING_STATUS,
    providerEnvironment: record.providerEnvironment || PROVIDER_ENVIRONMENT_TEST,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
});

const buildLegacyAttemptRecord = (record, attemptNumber, reference) => {
    let expectedChargeMinor =
        typeof record.chargeMinor === 'number' && Number.isFinite(record.chargeMinor)
            ? record.chargeMinor
            : undefined;
    let expectedFeeMinor =
        typeof record.feeMinor === 'number' && Number.isFinite(record.feeMinor)
            ? record.feeMinor
            : undefined;

    if (
        (expectedChargeMinor === undefined || expectedFeeMinor === undefined) &&
        typeof record.amountMinor === 'number' &&
        Number.isFinite(record.amountMinor)
    ) {
        try {
            if (expectedChargeMinor === undefined) {
                expectedChargeMinor = calculateCheckoutChargeMinor(record.amountMinor);
            }
            if (expectedFeeMinor === undefined) {
                expectedFeeMinor = calculateCheckoutFeeMinor(
                    expectedChargeMinor !== undefined ? expectedChargeMinor : calculateCheckoutChargeMinor(record.amountMinor)
                );
            }
        } catch {
            // Leave undefined only if computation fails; repository will not be called in that case
        }
    }

    const attempt = {
        paymentId:
            record.paymentTarget === PAYMENT_TARGET_CONTRACT
                ? paymentRepository.contractPaymentId
                    ? paymentRepository.contractPaymentId(record.contractId)
                    : `contract_${record.contractId}`
                : record.milestoneId || '',
        paymentTarget: attemptPaymentTarget(record),
        contractId: record.contractId,
        ...(record.milestoneId ? { milestoneId: record.milestoneId } : {}),
        attemptNumber,
        reference,
        amountMinor: record.amountMinor,
        currency: record.currency,
        commissionAmountMinor: record.commissionAmountMinor,
        status: record.status === PAID_STATUS ? PAID_STATUS : FAILED_STATUS,
        providerEnvironment: record.providerEnvironment || PROVIDER_ENVIRONMENT_TEST,
        providerReference: reference,
        createdAt: record.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        verifiedAt: record.verifiedAt || null,
        paidAt: record.paidAt || null,
        legacy: true,
    };

    if (expectedChargeMinor !== undefined) {
        attempt.expectedChargeMinor = expectedChargeMinor;
    }
    if (expectedFeeMinor !== undefined) {
        attempt.expectedFeeMinor = expectedFeeMinor;
    }
    if (typeof record.providerFeeMinor === 'number' && Number.isFinite(record.providerFeeMinor)) {
        attempt.providerFeeMinor = record.providerFeeMinor;
    }

    return attempt;
};

const attemptForRecord = async (paymentId, record) => {
    const attemptNumber = initializationAttempts(record);
    if (attemptNumber < 1) return null;

    const snapshot = await paymentAttemptRepository.getPaymentAttempt(paymentId, attemptNumber);
    return snapshot.exists
        ? { id: snapshot.id, ...snapshot.data() }
        : null;
};

const referenceForRecord = (paymentId, record, attempt) => {
    if (attempt && typeof attempt.reference === 'string' && attempt.reference.trim()) {
        return attempt.reference;
    }
    return `${REFERENCE_PREFIX}${paymentId}`;
};

/**
 * STAGE 1G retry policy for VERIFICATION only (these constants are separate
 * from the initialization throttle above). Three total verification requests
 * (one initial plus two retries), a linear bounded backoff, and an overall
 * time budget.
 * Retries are permitted ONLY for categories that prove nothing about the
 * transaction: a transport error, a timeout, HTTP 429 and HTTP 5xx. A 4xx
 * (other than 429) is a definitive answer from the provider and is never
 * retried -- a retry cannot change it, and it must not be mistaken for a
 * transient fault.
 */
const VERIFY_MAX_ATTEMPTS = 3;
const VERIFY_BASE_BACKOFF_MS = 250;
const VERIFY_MAX_TOTAL_MS = 5000;

/** Fixed backoff schedule, one entry per gap between the three attempts. */
const VERIFY_BACKOFF_MS = [VERIFY_BASE_BACKOFF_MS, VERIFY_BASE_BACKOFF_MS * 2];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The approved mapping from a provider transaction status to the ONE local
 * status it justifies. `success` is deliberately absent: success is not a
 * status the provider response alone can grant -- it is applied only after the
 * full consistency check passes (see verifyPaymentForMilestone), so it cannot
 * be looked up here without bypassing that check.
 */
const IN_FLIGHT_PROVIDER_STATUSES = ['pending', 'ongoing', 'processing', 'queued'];
const REVIEW_PROVIDER_STATUSES = ['reversed', 'abandoned'];

/**
 * Sends an EXISTING 'created' record, or a definitive 'failed' record, to
 * Paystack in Test Mode and returns the validated checkout URL with the
 * server-derived money figures. Retries always use a NEW reference.
 *
 * Guarded by requireMilestoneEmployer, so milestone and contract are proven
 * and attached. This function creates NOTHING: a milestone with no payment
 * record answers 404 -- initiatePayment owns creation, and keeping a single
 * creation path is what makes the record's identity and eligibility matrix
 * impossible to fork.
 *
 * ORDER OF OPERATIONS, and why it is this order:
 *   1. forbidden client fields (the same 22-field contract), milestoneId
 *      consistency, reference suitability -- pure payload checks, no I/O;
 *   2. the record must exist and be initializable: `created`, or `failed`.
 *      'paid' is refused outright (never re-initialize a completed payment);
 *      'pending' means an attempt is still in flight and 'needs_review' means
 *      its outcome is unresolved, so both are refused rather than retried. A
 *      failed attempt may be retried with the same record and a NEW reference;
 *   3. currency, amount and fee derivation from TRUSTED stored data;
 *   4. the employer's email, read from the users collection -- Paystack
 *      requires it on initialize and it is never taken from the body;
 *   5. the Test Mode secret key is validated. A missing or Live key throws
 *      PaystackConfigurationError here -- BEFORE any write -- so an
 *      unconfigured server leaves the record exactly as it was;
 *   6. THE LATCH + ATTEMPT CLAIM: status -> 'pending', verifyAttempts is
 *      incremented, a durable attempt document is created and a write-once
 *      reference is claimed, all BEFORE the provider call. This is what makes
 *      an ambiguous outcome detectable: if the call times out, dies mid-flight
 *      or answers with anything untrusted, the record already says 'an attempt
 *      is in flight', and step 2 refuses to start another one. Without the
 *      latch a crash between call and write would be indistinguishable from
 *      'never attempted', and a blind retry could double-charge;
 *   7. the provider call. Every attempt uses a reference that has never been
 *      sent before, so a definitive request-level 4xx is rolled back to the
 *      prior `created` or `failed` status (with a statusReason) and a later
 *      retry can safely mint ANOTHER new reference. On transport errors,
 *      timeouts, 5xx, malformed 2xx bodies, mismatched references or
 *      untrusted checkout URLs the record STAYS 'pending' with a statusReason,
 *      and PaymentProviderError is thrown: the outcome is ambiguous, and only
 *      the verification stage may resolve it.
 *
 * NO callback_url is sent: the codebase defines no trusted frontend URL and
 * this stage invents none. The employer returns through the application
 * itself; checkout happens on the provider-hosted page.
 *
 * CONCURRENCY (STAGE 1K): the latch is ATOMIC. The read of the current status
 * and the write to 'pending' happen in one Firestore transaction
 * (paymentRepository.claimPaymentForInitialization), so two simultaneous
 * initializes cannot both move a `created` record to `pending`: exactly one
 * claims it and reaches the provider, and the loser is refused with no provider
 * call. Paystack's duplicate-reference rule is why a retry never reuses the
 * historical reference: the attempt claim mints a write-once reference for the
 * next attempt, and a legacy failed record's old reference is backfilled into
 * its own attempt document before the new one is claimed.
 */
const initializePaymentForMilestone = async ({ milestone, contract, payload }) => {
    for (const field of CLIENT_FORBIDDEN_PAYMENT_FIELDS) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
            throw new PaymentValidationError(`${field} cannot be supplied`);
        }
    }

    const milestoneId = payload && payload.milestoneId;
    if (!milestoneId || typeof milestoneId !== 'string') {
        throw new PaymentValidationError('Missing required fields');
    }
    if (milestoneId !== milestone.id) {
        throw new PaymentValidationError(
            'milestoneId does not match the milestone being paid'
        );
    }
    if (!REFERENCE_ID_PATTERN.test(milestoneId)) {
        throw new PaymentValidationError(
            'milestoneId cannot be used to build a payment reference'
        );
    }

    const existingSnapshot = await paymentRepository.getPaymentByMilestoneId(milestoneId);
    if (!existingSnapshot.exists) {
        throw new PaymentNotFoundError('Payment not found');
    }
    const record = toPlainObject(existingSnapshot);
    const providerEnvironment = assertPaymentEnvironment(record);

    if (record.status === 'paid') {
        throw new PaymentValidationError(
            'this milestone payment has already been completed'
        );
    }
    if (record.status !== CREATED_STATUS && record.status !== FAILED_STATUS) {
        throw new PaymentValidationError(
            'a payment attempt for this milestone is awaiting verification and cannot be initialized again'
        );
    }
    // Money derivation, from the stored milestone only. The contract currency
    // is re-checked (initiatePayment checked it too; a seeded-out-of-band
    // contract must not become a charge in an unsupported currency).
    if (contract.currency !== CONTRACT_CURRENCY) {
        throw new PaymentValidationError('the contract currency must be NGN');
    }
    if (!isPositiveSafeMinorAmount(milestone.amountMinor)) {
        throw new PaymentValidationError(
            'the milestone amount is not a valid positive kobo amount'
        );
    }

    let chargeMinor;
    let feeMinor;
    try {
        chargeMinor = calculateCheckoutChargeMinor(milestone.amountMinor);
        feeMinor = calculateCheckoutFeeMinor(chargeMinor);
    } catch {
        throw new PaymentValidationError(
            'the milestone amount is outside the supported payment range'
        );
    }

    // The relationship must still be live at charging time: an employment
    // that ended after the record was created is not payable, and this call
    // is the one that actually charges. (The task's approval has no reversal
    // path in this codebase, so it is not re-read.)
    if (contract.status !== ACTIVE_CONTRACT_STATUS) {
        throw new PaymentValidationError(
            'the contract must be active before a milestone payment can be initialized'
        );
    }
    const employmentSnapshot = await employmentRepository.getEmploymentById(
        contract.employmentId
    );
    if (!employmentSnapshot.exists) {
        throw new PaymentValidationError(
            'the employment for this contract no longer exists'
        );
    }
    if (employmentSnapshot.data().status !== ACTIVE_EMPLOYMENT_STATUS) {
        throw new PaymentValidationError(
            'this employment has ended, so the milestone payment cannot be initialized'
        );
    }

    // Paystack requires an email on initialize; it is read from the
    // employer's user document, never from the request.
    const employerSnapshot = await userRepository.getUserById(contract.employerId);
    const employer = employerSnapshot.exists ? employerSnapshot.data() : null;
    if (!employer || typeof employer.email !== 'string' || !employer.email) {
        throw new PaymentValidationError(
            'the employer account has no email address, which checkout requires'
        );
    }

    // Configuration is settled BEFORE the latch, so an unconfigured server
    // leaves the record untouched. Test Mode only: a missing, malformed or
    // Live key throws PaystackConfigurationError, which the controller turns
    // into a 503. No fallback, no silent default.
    getSecretKey();
    await assertInitializationThrottle(milestoneId);

    // THE LATCH + ATTEMPT CLAIM. The status re-check, the new attempt document,
    // its write-once reference and the parent's 'pending' latch all commit in
    // ONE transaction. A definitive failure can therefore retry with a NEW
    // reference, while two concurrent requests still cannot both reach Paystack.
    const claim = await paymentAttemptRepository.claimPaymentAttempt({
        paymentId: milestoneId,
        nextAttemptsFor: nextInitializationAttempts,
        allowFailedRetry: true,
        buildAttempt: (currentRecord, attemptNumber, reference) =>
            buildAttemptRecord({
                paymentId: milestoneId,
                record: currentRecord,
                attemptNumber,
                reference,
                chargeMinor,
                feeMinor,
            }),
        buildLegacyAttempt:
            record.status === FAILED_STATUS ? buildLegacyAttemptRecord : undefined,
    });

    if (!claim.claimed) {
        if (claim.reason === 'reference-conflict' || claim.reason === 'attempt-exists') {
            throw new PaymentProviderError(
                'The payment provider could not confirm the initialization',
                { cause: new Error('payment attempt reference conflict') }
            );
        }
        // A concurrent claim won, or the record changed between the pre-check
        // above and the transaction. Both mean "an attempt is already in
        // flight", which is the existing refusal -- and, critically, no second
        // provider call is made.
        throw new PaymentValidationError(
            'a payment attempt for this milestone is awaiting verification and cannot be initialized again'
        );
    }

    const { reference, attemptId, previousStatus } = claim;
    const retryingFailedAttempt = previousStatus === FAILED_STATUS;

    try {
        const result = await paystackClient.initializeTransaction({
            email: employer.email,
            amount: chargeMinor,
            currency: CONTRACT_CURRENCY,
            reference,
            metadata: {
                milestoneId: milestone.id,
                contractId: contract.id,
            },
        });

        const data = result && result.data;
        const checkoutUrl = data && data.authorization_url;
        const echoedReference = data && data.reference;

        // A 2xx whose body will not parse as a usable authorization URL, or
        // which echoes a DIFFERENT reference than the one we sent, is not a
        // success: the transaction may well exist at the provider, so the
        // record stays latched and only verification may resolve it.
        const untrusted =
            !isTrustedCheckoutUrl(checkoutUrl) ||
            (echoedReference !== undefined && echoedReference !== reference);
        if (untrusted) {
            await paymentRepository.updatePaymentFields(milestoneId, {
                statusReason: STATUS_REASON_UNUSABLE,
            });
            await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
                status: PENDING_STATUS,
                statusReason: STATUS_REASON_UNUSABLE,
                providerTransactionId: (data && data.id) || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            throw new PaymentProviderError(
                'The payment provider returned an unusable response',
                { cause: new Error(STATUS_REASON_UNUSABLE) }
            );
        }

        // Success: persist the server-controlled provider fields. Only the
        // keys above are merged -- every existing field survives untouched
        // (the repository's update is partial by construction).
        await paymentRepository.updatePaymentFields(milestoneId, {
            providerReference: reference,
            providerEnvironment,
            chargeMinor,
            feeMinor,
            ...(record.statusReason !== undefined ? { statusReason: null } : {}),
        });
        await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
            status: PENDING_STATUS,
            providerReference: reference,
            providerTransactionId: (data && data.id) || null,
            providerEnvironment,
            expectedChargeMinor: chargeMinor,
            expectedFeeMinor: feeMinor,
            initializedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            paymentId: milestoneId,
            reference,
            status: 'pending',
            amountMinor: milestone.amountMinor,
            feeMinor,
            chargeMinor,
            currency: CONTRACT_CURRENCY,
            checkoutUrl,
        };
    } catch (error) {
        // The configuration error class travels unwrapped by design (Stage
        // 1C); it can only appear here if the key vanished between step 5 and
        // the call, and it still maps to the 503 path.
        if (error instanceof PaystackConfigurationError) {
            throw error;
        }

        // The unusable-response path inside the try already stamped its own
        // statusReason; rethrowing it here must not overwrite that reason.
        if (error instanceof PaymentProviderError) {
            throw error;
        }

        // A 4xx is a provider answer, but NOT every 4xx proves that no
        // transaction was created. Only the statuses treated here as
        // request-level rejections are rolled back:
        //   400 Bad Request, 401 Unauthorized, 403 Forbidden,
        //   404 Not Found, 422 Unprocessable Entity.
        // This attempt's reference is new, so a definitive rejection can be
        // retried later with another new reference. 409 and 429 remain
        // ambiguous and stay latched.
        if (INITIALIZE_ROLLBACK_STATUSES.has(error.statusCode)) {
            await paymentRepository.updatePaymentFields(milestoneId, {
                status: retryingFailedAttempt ? FAILED_STATUS : CREATED_STATUS,
                statusReason: STATUS_REASON_REJECTED,
            });
            await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
                status: FAILED_STATUS,
                statusReason: STATUS_REASON_REJECTED,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            throw new PaymentProviderError(
                'The payment provider rejected the initialization request',
                { cause: error }
            );
        }

        // Everything else -- transport failure, timeout, 5xx, a non-rollback
        // 4xx such as 409/429, or the unusable-response path thrown above --
        // is AMBIGUOUS. The record stays 'pending'; nothing here writes
        // 'failed', because none of these proves anything about the
        // transaction.
        try {
            await paymentRepository.updatePaymentFields(milestoneId, {
                statusReason: STATUS_REASON_UNKNOWN,
            });
            await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
                status: PENDING_STATUS,
                statusReason: STATUS_REASON_UNKNOWN,
                lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch {
            // The latch itself is already 'pending'; failing to stamp a
            // reason must not mask the provider outcome.
        }
        throw new PaymentProviderError(
            'The payment provider could not confirm the initialization',
            { cause: error }
        );
    }
};

/**
 * Sends an existing full-contract payment record to Paystack in Test Mode.
 *
 * Mirrors initializePaymentForMilestone exactly -- the same latch, provider
 * validation, rollback policy and ambiguous-outcome handling -- but derives
 * every money figure from the contract's authoritative total and uses the
 * contract-level payment id/reference.
 */
const initializePaymentForContract = async ({ contract, payload }) => {
    for (const field of CLIENT_FORBIDDEN_CONTRACT_PAYMENT_FIELDS) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
            throw new PaymentValidationError(`${field} cannot be supplied`);
        }
    }

    const contractId = payload && payload.contractId;
    if (!contractId || typeof contractId !== 'string') {
        throw new PaymentValidationError('Missing required fields');
    }
    if (contractId !== contract.id) {
        throw new PaymentValidationError(
            'contractId does not match the contract being paid'
        );
    }

    const paymentId = paymentRepository.contractPaymentId(contractId);
    if (!REFERENCE_ID_PATTERN.test(paymentId)) {
        throw new PaymentValidationError(
            'contractId cannot be used to build a payment reference'
        );
    }

    const existingSnapshot = await paymentRepository.getPaymentByContractId(contractId);
    if (!existingSnapshot.exists) {
        throw new PaymentNotFoundError('Payment not found');
    }
    const record = toPlainObject(existingSnapshot);
    const providerEnvironment = assertPaymentEnvironment(record);

    if (record.paymentTarget !== PAYMENT_TARGET_CONTRACT) {
        throw new PaymentValidationError('this payment record is not a contract payment');
    }
    if (contract.paymentMode !== PAYMENT_MODE_FULL) {
        throw new PaymentValidationError(
            'this contract is paid by milestones, not as a full contract'
        );
    }
    if (record.status === PAID_STATUS) {
        throw new PaymentValidationError(
            'this contract payment has already been completed'
        );
    }
    if (record.status !== CREATED_STATUS && record.status !== FAILED_STATUS) {
        throw new PaymentValidationError(
            'a payment attempt for this contract is awaiting verification and cannot be initialized again'
        );
    }
    if (contract.currency !== CONTRACT_CURRENCY) {
        throw new PaymentValidationError('the contract currency must be NGN');
    }
    if (!isPositiveSafeMinorAmount(contract.totalAmountMinor)) {
        throw new PaymentValidationError(
            'the contract total is not a valid positive kobo amount'
        );
    }

    let chargeMinor;
    let feeMinor;
    try {
        chargeMinor = calculateCheckoutChargeMinor(contract.totalAmountMinor);
        feeMinor = calculateCheckoutFeeMinor(chargeMinor);
    } catch {
        throw new PaymentValidationError(
            'the contract total is outside the supported payment range'
        );
    }

    if (contract.status !== ACTIVE_CONTRACT_STATUS) {
        throw new PaymentValidationError(
            'the contract must be active before a contract payment can be initialized'
        );
    }
    const employmentSnapshot = await employmentRepository.getEmploymentById(
        contract.employmentId
    );
    if (!employmentSnapshot.exists) {
        throw new PaymentValidationError(
            'the employment for this contract no longer exists'
        );
    }
    if (employmentSnapshot.data().status !== ACTIVE_EMPLOYMENT_STATUS) {
        throw new PaymentValidationError(
            'this employment has ended, so the contract payment cannot be initialized'
        );
    }

    const employerSnapshot = await userRepository.getUserById(contract.employerId);
    const employer = employerSnapshot.exists ? employerSnapshot.data() : null;
    if (!employer || typeof employer.email !== 'string' || !employer.email) {
        throw new PaymentValidationError(
            'the employer account has no email address, which checkout requires'
        );
    }

    getSecretKey();
    await assertInitializationThrottle(paymentId);

    const claim = await paymentAttemptRepository.claimPaymentAttempt({
        paymentId,
        nextAttemptsFor: nextInitializationAttempts,
        allowFailedRetry: true,
        buildAttempt: (currentRecord, attemptNumber, reference) =>
            buildAttemptRecord({
                paymentId,
                record: currentRecord,
                attemptNumber,
                reference,
                chargeMinor,
                feeMinor,
            }),
        buildLegacyAttempt:
            record.status === FAILED_STATUS ? buildLegacyAttemptRecord : undefined,
    });

    if (!claim.claimed) {
        if (claim.reason === 'reference-conflict' || claim.reason === 'attempt-exists') {
            throw new PaymentProviderError(
                'The payment provider could not confirm the initialization',
                { cause: new Error('payment attempt reference conflict') }
            );
        }
        throw new PaymentValidationError(
            'a payment attempt for this contract is awaiting verification and cannot be initialized again'
        );
    }

    const { reference, attemptId, previousStatus } = claim;
    const retryingFailedAttempt = previousStatus === FAILED_STATUS;

    try {
        const result = await paystackClient.initializeTransaction({
            email: employer.email,
            amount: chargeMinor,
            currency: CONTRACT_CURRENCY,
            reference,
            metadata: {
                contractId: contract.id,
            },
        });

        const data = result && result.data;
        const checkoutUrl = data && data.authorization_url;
        const echoedReference = data && data.reference;

        const untrusted =
            !isTrustedCheckoutUrl(checkoutUrl) ||
            (echoedReference !== undefined && echoedReference !== reference);
        if (untrusted) {
            await paymentRepository.updateContractPaymentFields(contractId, {
                statusReason: STATUS_REASON_UNUSABLE,
            });
            await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
                status: PENDING_STATUS,
                statusReason: STATUS_REASON_UNUSABLE,
                providerTransactionId: (data && data.id) || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            throw new PaymentProviderError(
                'The payment provider returned an unusable response',
                { cause: new Error(STATUS_REASON_UNUSABLE) }
            );
        }

        await paymentRepository.updateContractPaymentFields(contractId, {
            providerReference: reference,
            providerEnvironment,
            chargeMinor,
            feeMinor,
            ...(record.statusReason !== undefined ? { statusReason: null } : {}),
        });
        await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
            status: PENDING_STATUS,
            providerReference: reference,
            providerTransactionId: (data && data.id) || null,
            providerEnvironment,
            expectedChargeMinor: chargeMinor,
            expectedFeeMinor: feeMinor,
            initializedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return {
            paymentId,
            reference,
            status: 'pending',
            amountMinor: contract.totalAmountMinor,
            feeMinor,
            chargeMinor,
            currency: CONTRACT_CURRENCY,
            checkoutUrl,
        };
    } catch (error) {
        if (error instanceof PaystackConfigurationError) {
            throw error;
        }
        if (error instanceof PaymentProviderError) {
            throw error;
        }

        if (INITIALIZE_ROLLBACK_STATUSES.has(error.statusCode)) {
            await paymentRepository.updateContractPaymentFields(contractId, {
                status: retryingFailedAttempt ? FAILED_STATUS : CREATED_STATUS,
                statusReason: STATUS_REASON_REJECTED,
            });
            await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
                status: FAILED_STATUS,
                statusReason: STATUS_REASON_REJECTED,
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            throw new PaymentProviderError(
                'The payment provider rejected the initialization request',
                { cause: error }
            );
        }

        try {
            await paymentRepository.updateContractPaymentFields(contractId, {
                statusReason: STATUS_REASON_UNKNOWN,
            });
            await paymentAttemptRepository.updatePaymentAttempt(attemptId, {
                status: PENDING_STATUS,
                statusReason: STATUS_REASON_UNKNOWN,
                lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        } catch {
            // The latch itself is already 'pending'; failing to stamp a
            // reason must not mask the provider outcome.
        }
        throw new PaymentProviderError(
            'The payment provider could not confirm the initialization',
            { cause: error }
        );
    }
};

/**
 * ONLY these statuses are treated as request-level rejections, and thus safe
 * to roll the latch back to its prior status. 409 (conflict) and 429 (throttle)
 * are deliberately ABSENT: both can occur AFTER a transaction exists, so
 * rolling back on them could permit a second charge attempt for a transaction
 * that already exists.
 *
 * 400 is retained for ordinary validation failures, but Paystack also uses 400
 * for "Duplicate Transaction Reference". Every new attempt now uses a
 * write-once reference that has never been sent before, so a definitive 400
 * cannot be a duplicate of one of this payment's earlier transactions.
 */
const INITIALIZE_ROLLBACK_STATUSES = new Set([400, 401, 403, 404, 422]);

// ---------------------------------------------------------------------------
// STAGE 1G -- verification (Test Mode only)
// ---------------------------------------------------------------------------

/** Safe, static reasons written onto the record; never provider text. */
const VERIFY_REASON_MISMATCH = 'provider response did not match the expected transaction';
const VERIFY_REASON_MALFORMED = 'provider response was not a usable verification envelope';
const VERIFY_REASON_UNKNOWN_STATUS = 'provider reported an unrecognised transaction status';

/**
 * Is this thrown provider error a category that proves nothing about the
 * transaction and may therefore be retried? Only transport failures, timeouts,
 * HTTP 429 and HTTP 5xx qualify. A Paystack 4xx (other than 429) is a
 * definitive provider answer and is NOT retryable. An unusable 2xx body
 * (PaystackResponseError) is also non-retryable: the request reached the
 * provider and it answered; retrying would just re-read the same thing.
 */
const isRetryableProviderError = (error) => {
    if (error instanceof PaystackConfigurationError) return false;
    // Transport and timeout errors carry no statusCode.
    if (error && error.name === 'PaystackTransportError') return true;
    if (error && error.name === 'PaystackTimeoutError') return true;
    if (error && typeof error.statusCode === 'number') {
        return error.statusCode === 429 || error.statusCode >= 500;
    }
    // Any other unexpected error (including a malformed 2xx) is treated as
    // non-retryable, so a program error cannot be masked by retry loops.
    return false;
};

/**
 * Calls the provider's verify operation with bounded retries for transient
 * failures only, and a bounded overall time budget. Returns the provider
 * envelope on success; throws the LAST provider error when every attempt
 * (within the budget) fails, or immediately for a non-retryable error.
 */
const verifyWithRetry = async (reference, { sleep }) => {
    const startedAt = Date.now();
    let lastError;

    for (let attempt = 1; attempt <= VERIFY_MAX_ATTEMPTS; attempt += 1) {
        try {
            return await paystackClient.verifyTransaction(reference);
        } catch (error) {
            lastError = error;
            if (!isRetryableProviderError(error)) {
                throw error;
            }
            const isLastAttempt = attempt === VERIFY_MAX_ATTEMPTS;
            const budgetSpent = Date.now() - startedAt >= VERIFY_MAX_TOTAL_MS;
            if (isLastAttempt || budgetSpent) {
                throw error;
            }
            // Linear, bounded backoff; the budget check above caps the total.
            await sleep(VERIFY_BACKOFF_MS[attempt - 1] || VERIFY_BASE_BACKOFF_MS);
        }
    }

    throw lastError;
};

/**
 * The safely-selectable subset of a payment record this stage may return.
 * Never the raw record, never a provider payload, never a secret.
 */
const toSafeVerificationResponse = (record, reference = `${REFERENCE_PREFIX}${record.id}`) => ({
    paymentId: record.id,
    reference,
    status: record.status,
    amountMinor: record.amountMinor,
    ...(record.commissionIncluded === true
        ? {
              netPayableMinor: record.netPayableMinor,
              commissionBps: record.commissionBps,
              commissionAmountMinor: record.commissionAmountMinor,
          }
        : {}),
    feeMinor: record.feeMinor,
    chargeMinor: record.chargeMinor,
    currency: record.currency,
});

/**
 * Re-reads a record and returns its safe projection. Used after a transition
 * so the response reflects the document AS STORED (with its resolved
 * Timestamp), exactly as initiatePayment and initialize do.
 */
const readSafe = async (paymentId, attempt) => {
    const snapshot = await paymentRepository.getPaymentByMilestoneId(paymentId);
    const record = toPlainObject(snapshot);
    return toSafeVerificationResponse(record, referenceForRecord(paymentId, record, attempt));
};

/**
 * STAGE 1 -- the terminal-state policy, evaluated INSIDE the outcome
 * transaction against the record as it is at commit time.
 *
 * The status mapping in applyProviderEnvelope decides what one provider
 * response means, but it does so from a snapshot read BEFORE the provider call.
 * A slower, concurrent verification/webhook can settle the record in the gap.
 * This policy closes that gap atomically:
 *
 *   * `paid` is terminal and write-once: any outcome arriving after the record
 *     is paid is REFUSED, so a stale `failed`/`pending`/`needs_review` can
 *     never downgrade it and a duplicate success cannot restamp it;
 *   * `failed -> paid` stays forbidden even when the failure was written
 *     concurrently: a success that lands on a now-failed record is escalated to
 *     needs_review, exactly as the pre-provider check would have done.
 *
 * Pure: no I/O, no provider data, static reasons only.
 */
const resolveOutcomeWrite = (currentRecord, paymentFields, attemptFields) => {
    const requestedStatus = paymentFields && paymentFields.status;
    const currentStatus = currentRecord && currentRecord.status;

    if (currentStatus === PAID_STATUS) {
        return { apply: false, reason: 'paid-is-terminal' };
    }

    if (currentStatus === FAILED_STATUS && requestedStatus === PAID_STATUS) {
        return {
            apply: true,
            escalated: true,
            paymentFields: {
                status: NEEDS_REVIEW_STATUS,
                statusReason: VERIFY_REASON_MISMATCH,
                ...(paymentFields.verifiedAt !== undefined
                    ? { verifiedAt: paymentFields.verifiedAt }
                    : {}),
            },
            attemptFields: attemptFields
                ? {
                      status: NEEDS_REVIEW_STATUS,
                      statusReason: VERIFY_REASON_MISMATCH,
                      updatedAt: attemptFields.updatedAt,
                  }
                : attemptFields,
        };
    }

    return { apply: true, paymentFields, attemptFields };
};

/**
 * Applies ONE verification outcome to the record as a PARTIAL update --
 * never a replace, so every unrelated field survives. `reason` is always a
 * static string from this file (or null), never provider text. `extra`
 * carries the provider-controlled fields a given outcome justifies
 * (providerFeeMinor, verifiedAt, paidAt). statusReason is cleared on a paid
 * outcome and set on review outcomes; a null reason on non-review outcomes
 * leaves any prior reason in place.
 *
 * Returns the repository's outcome, including the status that is actually
 * stored after the transaction, so callers can report the truth even when a
 * late write was refused or escalated.
 */
const applyVerificationOutcome = async (
    paymentId,
    status,
    reason,
    { attempt = null, fields: extra = {}, clearReason = false } = {}
) => {
    const paymentFields = { status, ...extra };
    if (reason !== null && reason !== undefined) {
        paymentFields.statusReason = reason;
    } else if (clearReason) {
        paymentFields.statusReason = null;
    }

    const attemptFields = {
        status,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (reason !== null && reason !== undefined) {
        attemptFields.statusReason = reason;
    }
    if (status === PAID_STATUS) {
        attemptFields.paidAt = extra.paidAt;
        attemptFields.statusReason = null;
        if (extra.providerFeeMinor !== undefined) {
            attemptFields.providerFeeMinor = extra.providerFeeMinor;
        }
    }
    if (status === FAILED_STATUS) {
        attemptFields.completedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    return paymentAttemptRepository.applyPaymentAndAttemptOutcome({
        paymentId,
        attemptNumber: attempt ? attempt.attemptNumber : undefined,
        paymentFields,
        attemptFields,
        resolveWrite: resolveOutcomeWrite,
    });
};

/**
 * Verifies the Paystack transaction behind an already-initialized payment and
 * applies the one approved status transition the outcome justifies.
 *
 * Guarded by requireMilestoneEmployer: milestone and contract are proven and
 * attached, and the caller is the contract's employer.
 *
 * ORDER OF OPERATIONS:
 *   1. forbidden client fields, milestoneId shape and reference suitability --
 *      pure checks, no I/O, mirroring initialize;
 *   2. the payment record must exist;
 *   3. ALREADY PAID: return the stored paid record with NO provider call
 *      (decision D4). A paid payment is never re-verified and never downgraded;
 *   4. the reference is resolved from the CURRENT attempt (via the write-once
 *      registry), falling back to kp_<paymentId> only for a legacy record with
 *      no attempt document. A mismatched stored reference is refused;
 *   5. the expected amount, charge and fee are derived from the TRUSTED stored
 *      milestone and the fee calculator -- never from the body or the
 *      provider;
 *   6. the provider is asked to verify the current attempt's reference, with
 *      bounded retries for transient failures only;
 *   7. the response is checked for full consistency BEFORE any transition:
 *      valid envelope, exact reference, exact NGN currency, and the gross
 *      charge in the provider's kobo unit. Any mismatch or malformed body is a
 *      review-worthy outcome, never 'paid';
 *   8. only then is a status applied:
 *        success                -> paid (all checks passed)
 *        failed                 -> failed (provider's explicit failure)
 *        pending/ongoing/...    -> pending (in flight)
 *        reversed/abandoned/unknown -> needs_review
 *      A transport error, timeout, 429 or 5xx that survives the retries is
 *      AMBIGUOUS: the record is left exactly as it was and PaymentProviderError
 *      is thrown -- never a definitive 'failed'.
 *
 * A record already 'paid' short-circuits (step 3). A record 'failed' or
 * 'needs_review' is allowed to re-verify ONLY because a later genuine provider
 * outcome may still resolve it -- but 'failed -> paid' is forbidden outright,
 * so a failed record that now reports success is escalated to needs_review
 * rather than promoted.
 */
const verifyPaymentForMilestone = async ({ milestone, contract, payload, sleep }) => {
    for (const field of CLIENT_FORBIDDEN_PAYMENT_FIELDS) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
            throw new PaymentValidationError(`${field} cannot be supplied`);
        }
    }

    const milestoneId = payload && payload.milestoneId;
    if (!milestoneId || typeof milestoneId !== 'string') {
        throw new PaymentValidationError('Missing required fields');
    }
    if (milestoneId !== milestone.id) {
        throw new PaymentValidationError(
            'milestoneId does not match the milestone being paid'
        );
    }
    if (!REFERENCE_ID_PATTERN.test(milestoneId)) {
        throw new PaymentValidationError(
            'milestoneId cannot be used to build a payment reference'
        );
    }

    const snapshot = await paymentRepository.getPaymentByMilestoneId(milestoneId);
    if (!snapshot.exists) {
        throw new PaymentNotFoundError('Payment not found');
    }
    const record = toPlainObject(snapshot);
    assertPaymentEnvironment(record);
    const attempt = await attemptForRecord(milestoneId, record);
    const reference = referenceForRecord(milestoneId, record, attempt);

    // (3) Already paid: serve the stored record and contact nobody. A paid
    // payment is terminal. Only the idempotent collection journal is ensured
    // here, so a crash between the paid commit and the journal post is repaired
    // by the next verification of the same payment.
    if (record.status === PAID_STATUS) {
        await accountingLifecycleService.ensureCollectionForPayment(milestoneId);
        return { verified: true, payment: toSafeVerificationResponse(record, reference) };
    }

    // (4) A record not yet at the point of having a reference cannot be
    // verified. 'created' means initialize never completed; any other status
    // means an attempt exists, so the reference must be present and exact.
    if (
        !attempt &&
        record.providerReference !== undefined &&
        record.providerReference !== reference
    ) {
        throw new PaymentValidationError(
            'the stored payment reference does not match this milestone'
        );
    }
    if (record.status === CREATED_STATUS) {
        throw new PaymentValidationError(
            'this payment has not been initialized and cannot be verified'
        );
    }

    // (5) Trusted money expectation.
    if (contract.currency !== CONTRACT_CURRENCY) {
        throw new PaymentValidationError('the contract currency must be NGN');
    }
    if (!isPositiveSafeMinorAmount(milestone.amountMinor)) {
        throw new PaymentValidationError(
            'the milestone amount is not a valid positive kobo amount'
        );
    }
    let expectedChargeMinor;
    try {
        expectedChargeMinor = calculateCheckoutChargeMinor(milestone.amountMinor);
    } catch {
        throw new PaymentValidationError(
            'the milestone amount is outside the supported payment range'
        );
    }

    // Configuration is settled before the provider call: an unconfigured
    // server must not contact anyone, and the record stays untouched.
    getSecretKey();

    // (6) Ask the provider, with bounded retries for transient failures only.
    // The sleep used between retries is overridable via the client (the test
    // double exposes `sleep`); production falls back to a real timer.
    const effectiveSleep =
        typeof sleep === 'function'
            ? sleep
            : typeof paystackClient.sleep === 'function'
              ? paystackClient.sleep
              : defaultSleep;
    let envelope;
    try {
        envelope = await verifyWithRetry(reference, { sleep: effectiveSleep });
    } catch (error) {
        if (error instanceof PaystackConfigurationError) {
            throw error;
        }
        // Ambiguous: transport, timeout, 429 or 5xx survived the retries.
        // The transaction stays in flight; only its "last checked" hint moves.
        if (attempt) {
            try {
                await paymentAttemptRepository.updatePaymentAttempt(attempt.id, {
                    status: PENDING_STATUS,
                    lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            } catch {
                // A failed metadata write must not mask the provider outcome.
            }
        }
        throw new PaymentProviderError(
            'The payment provider could not confirm the transaction',
            { cause: error }
        );
    }

    // (7)-(8) Consistency check, then the one approved status mapping. Shared
    // verbatim with the webhook reconciliation path (Stage 1L) so there is a
    // single status state machine, not two.
    const result = await applyProviderEnvelope(milestoneId, record, {
        reference,
        expectedChargeMinor,
        envelope,
        attempt,
    });
    await accountingLifecycleService.ensureCollectionForPayment(milestoneId);
    return result;
};

/**
 * Verifies the Paystack transaction behind an initialized full-contract
 * payment. It shares the provider/envelope state machine with the milestone
 * path, but derives its expected charge from contract.totalAmountMinor and
 * uses the contract-level deterministic reference.
 */
const verifyPaymentForContract = async ({
    contract,
    payload,
    sleep,
    allowInactive = false,
}) => {
    for (const field of CLIENT_FORBIDDEN_CONTRACT_PAYMENT_FIELDS) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
            throw new PaymentValidationError(`${field} cannot be supplied`);
        }
    }

    const contractId = payload && payload.contractId;
    if (!contractId || typeof contractId !== 'string') {
        throw new PaymentValidationError('Missing required fields');
    }
    if (contractId !== contract.id) {
        throw new PaymentValidationError(
            'contractId does not match the contract being paid'
        );
    }

    const paymentId = paymentRepository.contractPaymentId(contractId);
    if (!REFERENCE_ID_PATTERN.test(paymentId)) {
        throw new PaymentValidationError(
            'contractId cannot be used to build a payment reference'
        );
    }

    const snapshot = await paymentRepository.getPaymentByContractId(contractId);
    if (!snapshot.exists) {
        throw new PaymentNotFoundError('Payment not found');
    }
    const record = toPlainObject(snapshot);
    assertPaymentEnvironment(record);
    const attempt = await attemptForRecord(paymentId, record);
    const reference = referenceForRecord(paymentId, record, attempt);

    if (record.paymentTarget !== PAYMENT_TARGET_CONTRACT) {
        throw new PaymentValidationError('this payment record is not a contract payment');
    }
    if (record.status === PAID_STATUS) {
        await accountingLifecycleService.ensureCollectionForPayment(paymentId);
        return { verified: true, payment: toSafeVerificationResponse(record, reference) };
    }

    if (
        !attempt &&
        record.providerReference !== undefined &&
        record.providerReference !== reference
    ) {
        throw new PaymentValidationError(
            'the stored payment reference does not match this contract'
        );
    }
    if (record.status === CREATED_STATUS) {
        throw new PaymentValidationError(
            'this payment has not been initialized and cannot be verified'
        );
    }

    if (contract.paymentMode !== PAYMENT_MODE_FULL) {
        throw new PaymentValidationError(
            'this contract is paid by milestones, not as a full contract'
        );
    }

    // Client-triggered verification requires the contract and employment to
    // still be live. Webhook reconciliation passes allowInactive because the
    // provider has already collected the money: a later lifecycle change must
    // never strand a real payment in pending. All money, mode, reference and
    // record checks below still apply on both paths.
    if (!allowInactive) {
        if (contract.status !== ACTIVE_CONTRACT_STATUS) {
            throw new PaymentValidationError(
                'the contract must be active before a contract payment can be verified'
            );
        }
        const employmentSnapshot = await employmentRepository.getEmploymentById(
            contract.employmentId
        );
        if (!employmentSnapshot.exists) {
            throw new PaymentValidationError(
                'the employment for this contract no longer exists'
            );
        }
        if (employmentSnapshot.data().status !== ACTIVE_EMPLOYMENT_STATUS) {
            throw new PaymentValidationError(
                'this employment has ended, so the contract payment cannot be verified'
            );
        }
    }

    if (contract.currency !== CONTRACT_CURRENCY) {
        throw new PaymentValidationError('the contract currency must be NGN');
    }
    if (!isPositiveSafeMinorAmount(contract.totalAmountMinor)) {
        throw new PaymentValidationError(
            'the contract total is not a valid positive kobo amount'
        );
    }

    let expectedChargeMinor;
    try {
        expectedChargeMinor = calculateCheckoutChargeMinor(contract.totalAmountMinor);
    } catch {
        throw new PaymentValidationError(
            'the contract total is outside the supported payment range'
        );
    }

    getSecretKey();

    const effectiveSleep =
        typeof sleep === 'function'
            ? sleep
            : typeof paystackClient.sleep === 'function'
              ? paystackClient.sleep
              : defaultSleep;
    let envelope;
    try {
        envelope = await verifyWithRetry(reference, { sleep: effectiveSleep });
    } catch (error) {
        if (error instanceof PaystackConfigurationError) {
            throw error;
        }
        if (attempt) {
            try {
                await paymentAttemptRepository.updatePaymentAttempt(attempt.id, {
                    status: PENDING_STATUS,
                    lastCheckedAt: admin.firestore.FieldValue.serverTimestamp(),
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                });
            } catch {
                // A failed metadata write must not mask the provider outcome.
            }
        }
        throw new PaymentProviderError(
            'The payment provider could not confirm the transaction',
            { cause: error }
        );
    }

    const result = await applyProviderEnvelope(paymentId, record, {
        reference,
        expectedChargeMinor,
        envelope,
        attempt,
    });
    await accountingLifecycleService.ensureCollectionForPayment(paymentId);
    return result;
};

/**
 * STAGE 1L extraction. The post-envelope half of verification, factored out so
 * the client-driven verify route and the provider-driven webhook reconcile
 * apply the EXACT same checks and the EXACT same status mapping. It is the
 * single source of truth for "provider envelope in, one local status out".
 *
 * `envelope` is a provider verify envelope (or, for the webhook, one obtained
 * by re-verifying -- never the raw webhook payload interpreted as an
 * authority). `reference` and `expectedChargeMinor` are the TRUSTED
 * server-derived expectations; they are never taken from the envelope.
 *
 * Behavior is unchanged from the pre-1L inline block and is pinned by the
 * existing Stage 1G tests: malformed envelopes and reference/currency/amount
 * mismatches become needs_review; success becomes paid unless the record was
 * already failed; failed stays/becomes failed; in-flight stays pending;
 * reversed/abandoned/unknown become needs_review.
 */
const applyProviderEnvelope = async (
    paymentId,
    record,
    { reference, expectedChargeMinor, envelope, attempt = null }
) => {
    const data = envelope && envelope.data;
    const malformed =
        !data ||
        typeof data !== 'object' ||
        typeof data.status !== 'string' ||
        typeof data.reference !== 'string' ||
        typeof data.amount !== 'number';

    const settle = (status, reason, fields = {}) =>
        applyVerificationOutcome(paymentId, status, reason, {
            attempt,
            fields,
            clearReason: status === PAID_STATUS && record.statusReason !== undefined,
        });

    // `verified` is derived from the status the guarded transaction ACTUALLY
    // stored, never from the status this call asked for. A refused downgrade
    // (the record was concurrently paid) and an escalation (the record was
    // concurrently failed) therefore report the truth instead of claiming an
    // outcome that was not applied.
    const settledStatus = (outcome) => (outcome ? outcome.status : undefined);

    if (malformed) {
        const outcome = await settle(NEEDS_REVIEW_STATUS, VERIFY_REASON_MALFORMED);
        return {
            verified: settledStatus(outcome) === PAID_STATUS,
            payment: await readSafe(paymentId, attempt),
        };
    }

    const referenceMatches = data.reference === reference;
    const currencyMatches = data.currency === CONTRACT_CURRENCY;
    const amountMatches = data.amount === expectedChargeMinor;

    // A mismatch here is contradictory evidence: the provider answered about a
    // different transaction, or the amount does not match what we asked for.
    // Whatever the provider's status string says, this is NOT 'paid'.
    if (!referenceMatches || !currencyMatches || !amountMatches) {
        const outcome = await settle(NEEDS_REVIEW_STATUS, VERIFY_REASON_MISMATCH);
        return {
            verified: settledStatus(outcome) === PAID_STATUS,
            payment: await readSafe(paymentId, attempt),
        };
    }

    // Status mapping, now that the response is trusted and consistent.
    const providerStatus = data.status;

    if (providerStatus === 'success') {
        // 'failed -> paid' is forbidden. A provider that now reports success
        // for a transaction this record already recorded as failed is a
        // contradiction, not a promotion: escalate to review, never to paid.
        // The same rule is re-checked atomically inside the transaction, so a
        // concurrent failure written after this read cannot be promoted either.
        if (record.status === FAILED_STATUS) {
            const outcome = await settle(NEEDS_REVIEW_STATUS, VERIFY_REASON_MISMATCH, {
                verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            return {
                verified: settledStatus(outcome) === PAID_STATUS,
                payment: await readSafe(paymentId, attempt),
            };
        }
        const outcome = await settle(PAID_STATUS, null, {
            providerFeeMinor: typeof data.fees === 'number' ? data.fees : null,
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return {
            verified: settledStatus(outcome) === PAID_STATUS,
            payment: await readSafe(paymentId, attempt),
        };
    }

    if (providerStatus === 'failed') {
        // Already failed and still failed: idempotent, no write.
        if (record.status === FAILED_STATUS) {
            return {
                verified: true,
                payment: toSafeVerificationResponse(record, reference),
            };
        }
        const outcome = await settle(FAILED_STATUS, null, {
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const storedStatus = settledStatus(outcome);
        return {
            verified: storedStatus === FAILED_STATUS || storedStatus === PAID_STATUS,
            payment: await readSafe(paymentId, attempt),
        };
    }

    if (IN_FLIGHT_PROVIDER_STATUSES.includes(providerStatus)) {
        // In flight: the record stays 'pending' (it already is, or becomes so).
        const outcome = await settle(PENDING_STATUS, null, {
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const storedStatus = settledStatus(outcome);
        return {
            verified: storedStatus === PENDING_STATUS || storedStatus === PAID_STATUS,
            payment: await readSafe(paymentId, attempt),
        };
    }

    if (REVIEW_PROVIDER_STATUSES.includes(providerStatus)) {
        const outcome = await settle(NEEDS_REVIEW_STATUS, VERIFY_REASON_UNKNOWN_STATUS, {
            verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return {
            verified: settledStatus(outcome) === PAID_STATUS,
            payment: await readSafe(paymentId, attempt),
        };
    }

    // Unknown status: never guessed as paid or failed.
    const outcome = await settle(NEEDS_REVIEW_STATUS, VERIFY_REASON_UNKNOWN_STATUS, {
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return {
        verified: settledStatus(outcome) === PAID_STATUS,
        payment: await readSafe(paymentId, attempt),
    };
};

// ---------------------------------------------------------------------------
// STAGE 1L -- webhook reconciliation (Test Mode only)
// ---------------------------------------------------------------------------

/**
 * The only provider event this server acts on. Every other event type is
 * acknowledged and ignored -- it is not an error, but it justifies no local
 * transition, so nothing is written.
 */
const WEBHOOK_ACTIONABLE_EVENT = 'charge.success';

/** Safe, static reason written onto the record; never provider text. */
const WEBHOOK_REASON_EVENT_MISMATCH = 'webhook event did not match the stored payment';

/**
 * The outcome of reconciling one verified webhook event.
 *
 *   reconciled  whether the event caused (or confirmed) a settled local state.
 *               A `false` here never means "the payment failed" -- it means the
 *               event alone proved nothing, so the record was left as it was or
 *               escalated to needs_review.
 *   applied     whether this delivery actually ran reconciliation (as opposed
 *               to an event type that is acknowledged but ignored).
 *   payment     the safe projection of the stored record AFTER any transition,
 *               or null when no payment was located.
 */
class WebhookReconciliationResult {
    constructor({ reconciled, applied, payment }) {
        this.reconciled = reconciled;
        this.applied = applied;
        this.payment = payment;
    }
}

/**
 * Reconciles ONE signature-verified Paystack webhook event against the stored
 * payment it names.
 *
 * WHAT THE WEBHOOK IS AND IS NOT TRUSTED FOR. The signature proves the request
 * came from Paystack; it does NOT make the payload an authority on the
 * transaction's local status. This function therefore uses the event ONLY to
 * (a) learn which payment it concerns, via the deterministic reference, and
 * (b) establish that the event is the one actionable type. It then re-verifies
 * the transaction with Paystack through the EXACT same code path the client
 * verify route uses (verifyPaymentForMilestone -> verifyWithRetry ->
 * applyProviderEnvelope), so a webhook that merely CLAIMS success can never by
 * itself mark a payment paid. "The browser redirected" and "the payload says
 * success" are both explicitly NOT proof here.
 *
 * ORDER OF OPERATIONS:
 *   1. the event must be an object whose `event` is the actionable type; any
 *      other event is acknowledged but applies nothing;
 *   2. the event's reference must be a string with the deterministic kp_ prefix
 *      whose suffix is a usable milestone id. A reference we did not mint
 *      (wrong prefix, blank, malformed) is never resolved to a payment and is
 *      refused as an unknown reference;
 *   3. an event may reference ONLY a payment that already exists -- a webhook
 *      never CREATES a record (requirement: never create a payment from an
 *      untrusted source). A missing record is an unknown reference;
 *   4. a light consistency gate: if the event carries an NGN-currency /
 *      gross-charge expectation that contradicts the stored record, the event
 *      is escalated to needs_review and reconciliation does NOT proceed -- an
 *      event that disagrees with the record with which it claims to be
 *      associated is contradictory evidence, never a paid trigger;
 *   5. otherwise the milestone and contract are loaded server-side and the
 *      authoritative provider re-verification runs, applying the one approved
 *      transition. If the milestone or contract is gone, the event is treated
 *      as unactionable (needs_review on the record, applied = false) rather
 *      than throwing into the transport;
 *   6. an EXISTING paid record short-circuits inside verifyPaymentForMilestone
 *      with no provider call (decision D4): a duplicate delivery is idempotent.
 *
 * This function never throws for an untrusted event: malformed, unknown,
 * mismatched and ignored events all return a result describing what, if
 * anything, was applied. It lets a PaymentProviderError propagate ONLY from
 * step 5, because an ambiguous provider outcome must be reported to the caller
 * as a retryable failure so the webhook can answer non-2xx and Paystack can
 * retry -- never as an acknowledged success.
 *
 * @param {{ event?: string, data?: object }} webhookEvent the parsed body
 * @param {(ms: number) => Promise<void>} [sleep] injectable retry delay
 * @returns {Promise<WebhookReconciliationResult>}
 */
const reconcilePaymentFromWebhook = async (webhookEvent, { sleep } = {}) => {
    const ignored = () => new WebhookReconciliationResult({ reconciled: true, applied: false, payment: null });

    if (!webhookEvent || typeof webhookEvent !== 'object' || Array.isArray(webhookEvent)) {
        return ignored();
    }
    if (webhookEvent.event !== WEBHOOK_ACTIONABLE_EVENT) {
        // A non-actionable event (including a failed-charge event) is
        // acknowledged but reconciles nothing locally: this server never marks
        // a record 'failed' off an unverified event.
        return ignored();
    }

    const data = webhookEvent.data;
    const reference = data && typeof data === 'object' ? data.reference : undefined;

    if (typeof reference !== 'string' || !reference.startsWith(REFERENCE_PREFIX)) {
        return new WebhookReconciliationResult({ reconciled: false, applied: true, payment: null });
    }

    // A retry reference is resolved through the write-once registry, never by
    // string surgery: the registry is the authority on which payment/attempt a
    // reference belongs to. A legacy base reference that predates the registry
    // still resolves by its payment id, preserving old deliveries.
    const referenceSnapshot = await paymentAttemptRepository.getAttemptByReference(reference);
    let paymentId;
    let referencedAttempt = null;

    if (referenceSnapshot.exists) {
        const referenceRecord = referenceSnapshot.data();
        if (referenceRecord.reference !== reference) {
            return new WebhookReconciliationResult({
                reconciled: false,
                applied: true,
                payment: null,
            });
        }
        paymentId = referenceRecord.paymentId;
        if (!paymentId || typeof paymentId !== 'string') {
            return new WebhookReconciliationResult({
                reconciled: false,
                applied: true,
                payment: null,
            });
        }
        const attemptSnapshot = await paymentAttemptRepository.getPaymentAttempt(
            paymentId,
            referenceRecord.attemptNumber
        );
        if (!attemptSnapshot.exists) {
            return new WebhookReconciliationResult({
                reconciled: false,
                applied: true,
                payment: null,
            });
        }
        referencedAttempt = { id: attemptSnapshot.id, ...attemptSnapshot.data() };
    } else {
        paymentId = reference.slice(REFERENCE_PREFIX.length);
        if (!REFERENCE_ID_PATTERN.test(paymentId)) {
            return new WebhookReconciliationResult({
                reconciled: false,
                applied: true,
                payment: null,
            });
        }
    }

    // (3) An event may reference only an existing payment; never create one.
    const snapshot = await paymentRepository.getPaymentByMilestoneId(paymentId);
    if (!snapshot.exists) {
        return new WebhookReconciliationResult({ reconciled: false, applied: true, payment: null });
    }
    const record = toPlainObject(snapshot);
    const currentAttempt = await attemptForRecord(paymentId, record);
    const currentReference = referenceForRecord(paymentId, record, currentAttempt);

    // A delivery for a payment from another Paystack environment is not
    // evidence about this one. Acknowledge it without reconciling or touching
    // the record, rather than answering non-2xx and inviting endless retries.
    const storedEnvironment = record.providerEnvironment || PROVIDER_ENVIRONMENT_TEST;
    if (storedEnvironment !== getPaystackMode()) {
        return new WebhookReconciliationResult({
            reconciled: false,
            applied: true,
            payment: toSafeVerificationResponse(record, currentReference),
        });
    }

    // An out-of-order delivery for an OLD attempt must never settle or
    // downgrade the payment that has since moved on. It is stale evidence.
    if (
        (referencedAttempt &&
            referencedAttempt.attemptNumber !== initializationAttempts(record)) ||
        (!referencedAttempt && reference !== currentReference)
    ) {
        return new WebhookReconciliationResult({
            reconciled: false,
            applied: true,
            payment: toSafeVerificationResponse(record, currentReference),
        });
    }

    // (4) Consistency gate between the event's own claim and the stored record.
    // This is intentionally a NARROW check: it can only ever DOWNGRADE or
    // refuse (to needs_review), never upgrade. Currency, if present in the
    // event, must be NGN; the event's amount, if present, must equal the
    // stored gross charge the record was initialized with.
    const eventCurrency = data.currency;
    const eventAmount = data.amount;
    const currencyContradicts =
        eventCurrency !== undefined && eventCurrency !== CONTRACT_CURRENCY;
    const amountContradicts =
        eventAmount !== undefined &&
        (typeof eventAmount !== 'number' || eventAmount !== record.chargeMinor);

    if (currencyContradicts || amountContradicts) {
        // Do not re-verify against a contradicted reference; escalate to review.
        if (record.status !== PAID_STATUS) {
            await applyVerificationOutcome(
                paymentId,
                NEEDS_REVIEW_STATUS,
                WEBHOOK_REASON_EVENT_MISMATCH,
                { attempt: currentAttempt }
            );
        }
        return {
            reconciled: false,
            applied: true,
            payment: await readSafe(paymentId, currentAttempt),
        };
    }

    // (5a) A contract-level record is reconciled through the contract path,
    // using the contract total as the authoritative amount. Legacy milestone
    // records have no paymentTarget and continue through the milestone path
    // below unchanged.
    if (record.paymentTarget === PAYMENT_TARGET_CONTRACT) {
        const contractSnapshot = record.contractId
            ? await contractRepository.getContractById(record.contractId)
            : null;

        if (!contractSnapshot || !contractSnapshot.exists) {
            return new WebhookReconciliationResult({
                reconciled: false,
                applied: true,
                payment: toSafeVerificationResponse(record, currentReference),
            });
        }

        const contract = { id: contractSnapshot.id, ...contractSnapshot.data() };
        const result = await verifyPaymentForContract({
            contract,
            payload: { contractId: contract.id },
            sleep,
            allowInactive: true,
        });

        return new WebhookReconciliationResult({
            reconciled: result.verified === true,
            applied: true,
            payment: result.payment,
        });
    }

    // (5b) Authoritative re-verification through the shared client-verify path.
    const milestoneSnapshot = await contractRepository.getMilestoneById(paymentId);
    const contractSnapshot = milestoneSnapshot.exists
        ? await contractRepository.getContractById(milestoneSnapshot.data().contractId)
        : null;

    if (!milestoneSnapshot.exists || !contractSnapshot || !contractSnapshot.exists) {
        // The referenced business objects no longer exist: the event cannot be
        // reconciled. Leave the record untouched rather than guess.
        return new WebhookReconciliationResult({
            reconciled: false,
            applied: true,
            payment: toSafeVerificationResponse(record, currentReference),
        });
    }

    const milestone = { id: milestoneSnapshot.id, ...milestoneSnapshot.data() };
    const contract = { id: contractSnapshot.id, ...contractSnapshot.data() };

    // verifyPaymentForMilestone re-reads the record, checks the reference,
    // currency, amount and fee rules against TRUSTED stored data, re-verifies
    // with Paystack, and applies the single approved transition. A
    // PaymentProviderError from here is AMBIGUOUS and propagates so the caller
    // can answer non-2xx and let Paystack retry.
    const result = await verifyPaymentForMilestone({
        milestone,
        contract,
        payload: { milestoneId: paymentId },
        sleep,
    });

    return new WebhookReconciliationResult({
        reconciled: result.verified === true,
        applied: true,
        payment: result.payment,
    });
};

module.exports = {
    PaymentValidationError,
    PaymentNotFoundError,
    PaymentProviderError,
    PAYMENT_STATUSES,
    CREATED_STATUS,
    initiatePayment,
    getPaymentForMilestone,
    initiateContractPayment,
    getPaymentForContract,
    initializePaymentForMilestone,
    initializePaymentForContract,
    verifyPaymentForMilestone,
    verifyPaymentForContract,
    reconcilePaymentFromWebhook,
};
