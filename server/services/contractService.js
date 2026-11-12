'use strict';

// contractService.js
//
// Business and data layer for the contracts resource (new in Stage P1). An
// contract is the record of the price two people agreed on for work already
// in flight: it is created by the employer AFTER an employment exists, it
// carries an explicitly agreed amount in kobo, and it becomes binding only
// when the employee accepts it. Nothing in this resource moves money. P1
// charges nobody, holds nothing in escrow, computes no provider fees and
// talks to no payment provider; what it produces is a contract document that
// a later stage can hang payments on.
//
// WHAT EXISTS HERE
//   * createContract -- the only write path for a new contract. Employer
//     identity and employment existence/active state are established by the
//     router's requireContractEmployer guard before this runs; everything
//     here is payload validation, commission arithmetic and the writes.
//   * acceptContract -- the employee's one write: pending_acceptance ->
//     active. It stamps acceptedAt/acceptedBy and touches nothing else.
//   * getContractForEmployment / getContract -- the two party-scoped reads.
//     Both return the contract and its milestone schedule.
//
// WHAT DELIBERATELY DOES NOT EXIST YET
//   * No rejection path. The status lifecycle in P1 is two values,
//     pending_acceptance and active; a contract the employee does not want is
//     simply never accepted, and a cancel/reject write (with whatever
//     refund-adjacent semantics it needs) belongs with the payment lifecycle
//     stage, not here. CONTRACT_STATUSES is exported so the first writer of a
//     third status cannot invent one silently.
//   * No payment initiation, no payout state, no provider reference fields on
//     the document. Employee acceptance explicitly does NOT initiate a
//     payment, and there is no endpoint that could.
//   * No edit path. An amount two people agreed on is not a draft: a contract
//     with the wrong number is corrected by never accepting it and creating a
//     new employment/contract pair, which the deterministic-id rule makes
//     impossible to do silently on top of an existing contract.
//   * No partially-written contract: creation commits the contract and its
//     complete initial schedule in one transaction. See createContract.
//
// AUTHORIZATION: none of these functions performs any. Like every other
// service in this codebase, the identity and ownership decisions live in the
// router guards -- requireContractEmployer (create), requireContractEmployee
// (accept), requireContractParty and requireEmploymentParty (reads). By the
// time a call reaches this file the caller has already been proven to be the
// employment's employer or employee as the action requires. The status check
// in acceptContract is a domain rule, not an ownership rule: it lives here
// because the guard cannot know the status without loading the contract,
// which it does, but the RULE belongs to the resource's lifecycle rather than
// to authentication.

const { admin } = require('../config/firebase');
const contractRepository = require('../repositories/contractRepository');
const contractProposalRepository = require('../repositories/contractProposalRepository');
const taskRepository = require('../repositories/taskRepository');
const applicationRepository = require('../repositories/applicationRepository');
const jobRepository = require('../repositories/jobRepository');
const {
    PLATFORM_COMMISSION_BPS,
    CONTRACT_CURRENCY,
    MAX_AMOUNT_MINOR,
    isPositiveSafeMinorAmount,
    calculateCommissionMinor,
} = require('../config/commission');

/**
 * A contract request cannot be described: a missing, malformed or disallowed
 * field, an amount that is not a positive safe integer of kobo, a milestone
 * schedule that references a task that does not exist or belongs to another
 * employment, a duplicate. Surfaces as a 400, exactly as every other
 * ValidationError in this codebase, and is deliberately the only domain error
 * this resource raises for a client's own mistake.
 */
class ContractValidationError extends Error {}

class ContractNotFoundError extends Error {}

class ContractForbiddenError extends Error {}

class ContractProposalNotFoundError extends Error {}

// ContractNotFoundError defined above

/**
 * The canonical contract statuses.
 *
 * An allow-list of exactly the two values P1 writes and reads. There is no
 * `rejected`, no `cancelled`, no `draft` and no payment-adjacent status: a
 * contract is either waiting for the employee (`pending_acceptance`) or
 * agreed by both parties (`active`). The transition is one-way in P1 --
 * pending -> active, driven solely by POST /contracts/:contractId/accept --
 * and nothing in this stage can move a contract back.
 */
const CONTRACT_STATUSES = ['pending_acceptance', 'active'];

/** The status a newly created contract is written with. */
const PENDING_ACCEPTANCE_STATUS = 'pending_acceptance';

/** The status a contract moves to when the employee accepts it. */
const ACTIVE_CONTRACT_STATUS = 'active';

const PROPOSAL_PENDING_ACCEPTANCE = 'pending_acceptance';
const PROPOSAL_CHANGES_REQUESTED = 'changes_requested';
const PROPOSAL_ACCEPTED = 'accepted';

const PROPOSAL_STATUSES = [
    PROPOSAL_PENDING_ACCEPTANCE,
    PROPOSAL_CHANGES_REQUESTED,
    PROPOSAL_ACCEPTED,
];

/**
 * The two payment modes P1 distinguishes.
 *
 * `full` -- one agreed total, no schedule. The request must carry
 * totalAmountMinor explicitly.
 * `milestones` -- the total is DERIVED from a 1..50 entry schedule; a
 * client-supplied total is rejected rather than reconciled, so the stored
 * total can only ever be the sum of the stored milestones.
 *
 * The mode is stored on the document because it changes what the milestone
 * list means (absent vs exhaustive), and because a later payment stage must
 * be able to tell the two apart without re-deriving it.
 */
const CONTRACT_PAYMENT_MODES = ['full', 'milestones'];

/** Inclusive bounds on a milestone schedule. 1..50, per the P1 scope. */
const MIN_MILESTONES = 1;
const MAX_MILESTONES = 50;

/**
 * The request-body fields createContract will not accept from a client, no
 * matter what else is valid.
 *
 * Every one of these is either derived from the employment record (the three
 * copied identities -- employmentId itself is required from the body because
 * it NAMES the employment, and the guard loads the record by it), computed
 * server-side from the agreed amount (the two commission fields, via
 * config/commission.js), or written by a different endpoint at a different
 * time (status, acceptedAt, acceptedBy, createdAt). A client that sends any
 * of them gets a 400 naming the field, rather than having it silently
 * dropped: silently dropping a field the client believes was applied is how
 * a client and a document come to disagree, and a commission field that was
 * silently ignored would look like a successful override to whoever sent it.
 */
const CLIENT_FORBIDDEN_CONTRACT_FIELDS = [
    'id',
    'employerId',
    'employeeId',
    'jobId',
    'applicationId',
    'commissionBps',
    'commissionAmountMinor',
    'status',
    'createdAt',
    'acceptedAt',
    'acceptedBy',
];

/**
 * Flattens a QuerySnapshot into `{ id, ...data }` objects.
 *
 * The same shape every list read in this codebase produces -- the document id
 * is added and no field is renamed, dropped or reshaped. Shared by the
 * milestone list so a milestone in a read response is the stored document.
 */
const toPlainObjects = (snapshot) => {
    const rows = [];
    snapshot.forEach((doc) => {
        rows.push({ id: doc.id, ...doc.data() });
    });
    return rows;
};

/**
 * Validates one monetary field name/value pair as a kobo amount.
 *
 * Split out because four different fields need the same check with four
 * different names in the error message, and a single generic message ("invalid
 * amount") would make a 400 from a three-field request unactionable.
 */
const requireMinorAmount = (value, fieldName) => {
    if (!isPositiveSafeMinorAmount(value)) {
        throw new ContractValidationError(
            `${fieldName} must be a positive integer number of kobo (the NGN minor unit)`
        );
    }
};

/**
 * Validates the raw milestone entries a client sent, BEFORE any task read.
 *
 * Shape only: each entry must be an object with a non-empty label and a
 * positive safe integer amountMinor. `taskId` is optional and retained only for
 * legacy milestone-to-task links; new task associations live on the task's own
 * `milestoneId` field, so a milestone does not require a task to exist. When a
 * legacy taskId IS supplied, no two entries may name the same one. Returns the
 * cleaned entries. The legacy task-existence and task-employment checks happen
 * in validateMilestoneTasks, after this passes, so a malformed or
 * self-contradicting schedule is rejected without spending any reads at all.
 */
const validateMilestoneShape = (milestones) => {
    if (!Array.isArray(milestones)) {
        throw new ContractValidationError('milestones must be an array');
    }

    if (milestones.length < MIN_MILESTONES || milestones.length > MAX_MILESTONES) {
        throw new ContractValidationError(
            `milestones must contain between ${MIN_MILESTONES} and ${MAX_MILESTONES} entries`
        );
    }

    const cleaned = milestones.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new ContractValidationError(`milestones[${index}] must be an object`);
        }

        const { taskId, label, amountMinor } = entry;

        if (taskId != null && typeof taskId !== 'string') {
            throw new ContractValidationError(`milestones[${index}].taskId must be a string`);
        }

        if (typeof label !== 'string' || !label.trim()) {
            throw new ContractValidationError(`milestones[${index}].label is required`);
        }

        requireMinorAmount(amountMinor, `milestones[${index}].amountMinor`);

        const cleanedEntry = { label: label.trim(), amountMinor };

        const trimmedTaskId = typeof taskId === 'string' ? taskId.trim() : '';
        if (trimmedTaskId) cleanedEntry.taskId = trimmedTaskId;

        return cleanedEntry;
    });

    // Legacy links still point from one milestone to one task, so a taskId may
    // appear at most once. An omitted taskId is not a duplicate: milestones are
    // independent payment obligations and new tasks link themselves by
    // `milestoneId`.
    const seenTaskIds = new Set();
    cleaned.forEach((entry, index) => {
        if (!entry.taskId) return;

        if (seenTaskIds.has(entry.taskId)) {
            throw new ContractValidationError(
                `milestones[${index}].taskId duplicates an earlier entry: ${entry.taskId} (a task may be linked to at most one milestone)`
            );
        }
        seenTaskIds.add(entry.taskId);
    });

    return cleaned;
};

/**
 * Verifies every milestone's task exists and belongs to the contract's own
 * employment. Returns nothing; throws on the first failure.
 *
 * OWNERSHIP RULE. A milestone pays for work, and work in this system is a
 * task, and a task belongs to exactly one employment (tasks carry
 * `employmentId` since Stage 9B). So the chain is milestone -> task ->
 * employmentId, and the id must equal the employment this contract is being
 * created for. That is the only linkage P1 needs: it rules out a milestone
 * paying for a stranger's task, for a task on another job, and for a task
 * that does not exist at all.
 *
 * A task written before Stage 9B has NO employmentId field. It is rejected
 * here -- `task.employmentId !== employmentId` is true for `undefined` --
 * with the same 400 as a wrong-employment task, because there is no way to
 * prove such a task belongs to this employment, and inventing a jobId-based
 * fallback would re-open exactly the hole the employmentId field closed.
 * Seeding one is what the missing-linkage test does.
 *
 * One read per milestone, sequential. These are validation reads performed
 * before the write transaction, and the N reads are bounded by the 50-milestone
 * cap, so the cost is explicit and finite rather than unbounded.
 */
const validateMilestoneTasks = async (milestones, employmentId) => {
    for (const milestone of milestones) {
        if (!milestone.taskId) continue;

        const snapshot = await taskRepository.getTaskById(milestone.taskId);

        if (!snapshot.exists) {
            throw new ContractValidationError(
                `milestones task not found: ${milestone.taskId}`
            );
        }

        const task = snapshot.data();

        if (task.employmentId !== employmentId) {
            throw new ContractValidationError(
                `milestones task ${milestone.taskId} does not belong to this employment`
            );
        }
    }
};

/**
 * Sums a validated milestone schedule, rejecting any total that leaves the
 * safe-integer range or the documented contract-amount bound.
 *
 * The AGGREGATE gets its own checks because each entry's amount being valid
 * says nothing about their sum: fifty individually valid amounts can sum to
 * an unsafe integer, or (more plausibly) to a total above MAX_AMOUNT_MINOR,
 * and either would hand calculateCommissionMinor a value config/commission.js
 * documents as impossible. Without the bound, `total * 500` could exceed
 * Number.MAX_SAFE_INTEGER and lose a kobo of commission; with it, the
 * milestones path enforces the same ceiling the full path enforces on
 * totalAmountMinor directly. The checks run per-addition so the failure names
 * the running problem rather than surfacing as a mysterious commission
 * mismatch later, and this runs BEFORE the first write, so a rejected total
 * leaves no contract and no milestones behind.
 */
const sumMilestoneAmounts = (milestones) =>
    milestones.reduce((total, milestone) => {
        const next = total + milestone.amountMinor;
        if (!Number.isSafeInteger(next)) {
            throw new ContractValidationError(
                'the milestone schedule total exceeds the safe integer range'
            );
        }
        if (next > MAX_AMOUNT_MINOR) {
            throw new ContractValidationError(
                `the milestone schedule total must not exceed ${MAX_AMOUNT_MINOR} kobo (the maximum contract amount)`
            );
        }
        return next;
    }, 0);

/**
 * Creates a contract for an active employment, plus its milestone schedule
 * when the mode is `milestones`.
 *
 * `employment` is the record the router's requireContractEmployer guard has
 * already loaded and proven the caller owns (as employer) and proven is
 * `active`; its four identity fields are the ONLY source of the contract's
 * identities. `payload` is the raw request body.
 *
 * VALIDATION BEFORE WRITING. Every check in this function -- the forbidden
 * fields, the mode/total/currency rules, the milestone shape (including the
 * one-task-one-milestone rule), the milestone task reads, the duplicate check
 * -- runs before the first write. A request that fails any of them leaves the
 * `contracts` and `milestones` collections exactly as they were: there is no
 * partial contract and no orphaned milestone.
 *
 * ATOMIC CONTRACT + INITIAL SCHEDULE. The successful write is one transaction
 * in contractRepository.createContractWithMilestonesIfAbsent. It reads the
 * deterministic contract id, then creates the contract and every cleaned
 * milestone in the same commit. The service cap is 50 milestones, so this is
 * at most 51 writes, below Firestore's 500-write transaction limit. Any write
 * failure aborts the whole commit: there is no contract without its schedule
 * and no partial schedule. The callback performs no external calls or
 * unrelated side effects; all validation, including the bounded task reads,
 * happens before it. Milestone ids remain Firestore-generated and are
 * allocated before the callback so retries target the same documents.
 *
 * THE DUPLICATE CHECK has two layers. The read of contracts/{employmentId}
 * below rejects a SEQUENTIAL duplicate with the established 400 before doing
 * any work. The transaction reads the same deterministic id again before its
 * writes: if two concurrent creators both pass the earlier read, exactly one
 * transaction creates the contract and its schedule, and the other resolves
 * to `{ created: false }` without writing anything. An existing pending or
 * accepted contract can therefore never be replaced.
 *
 * Returns `{ contractId, contract, milestones }` where `contract` is the
 * document as Firestore stored it (re-read, so the serverTimestamp createdAt
 * is a real Timestamp rather than the unresolved sentinel) and `milestones`
 * is the stored schedule, empty in `full` mode.
 */
const createContract = async ({ employment, payload }) => {
    for (const field of CLIENT_FORBIDDEN_CONTRACT_FIELDS) {
        if (payload && Object.prototype.hasOwnProperty.call(payload, field)) {
            throw new ContractValidationError(
                `${field} is derived from the employment and the commission configuration and cannot be supplied`
            );
        }
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new ContractValidationError('Request body must be an object');
    }

    // employmentId is required FROM the body and deliberately NOT in
    // CLIENT_FORBIDDEN_CONTRACT_FIELDS above: it NAMES the employment the
    // guard loaded, so a create cannot be issued without one. Its value never
    // reaches the stored document -- the identities written below are copied
    // from the loaded employment record -- this is the ordinary
    // missing-field path for a direct service call (the router's guard has
    // already refused an absent one with its own 400).
    if (typeof payload.employmentId !== 'string' || !payload.employmentId.trim()) {
        throw new ContractValidationError('employmentId is required');
    }

    const { paymentMode, totalAmountMinor, currency, milestones: rawMilestones } = payload;

    if (!CONTRACT_PAYMENT_MODES.includes(paymentMode)) {
        throw new ContractValidationError(
            `paymentMode must be one of: ${CONTRACT_PAYMENT_MODES.join(', ')}`
        );
    }

    // NGN ONLY. An absent currency defaults to NGN; any present value that is
    // not exactly 'NGN' is rejected. Lowercase 'ngn' and any other code are
    // refused rather than normalised, because normalising a currency code is
    // the kind of silent fix that turns a client bug into a stored lie.
    if (currency !== undefined && currency !== CONTRACT_CURRENCY) {
        throw new ContractValidationError(`currency must be ${CONTRACT_CURRENCY}`);
    }

    let resolvedTotal;
    let cleanedMilestones = [];

    if (paymentMode === 'full') {
        if (rawMilestones !== undefined) {
            throw new ContractValidationError(
                'milestones must not be supplied for a full paymentMode'
            );
        }

        requireMinorAmount(totalAmountMinor, 'totalAmountMinor');
        resolvedTotal = totalAmountMinor;
    } else {
        // milestones mode: the total is derived, never accepted. A supplied
        // totalAmountMinor is rejected outright rather than checked against
        // the sum -- there is no reconciliation to do, and accepting a
        // matching one would make the client believe the server had trusted it.
        if (totalAmountMinor !== undefined) {
            throw new ContractValidationError(
                'totalAmountMinor must not be supplied for a milestones paymentMode; the total is derived from the schedule'
            );
        }

        cleanedMilestones = validateMilestoneShape(rawMilestones);
        await validateMilestoneTasks(cleanedMilestones, employment.id);
        resolvedTotal = sumMilestoneAmounts(cleanedMilestones);
    }

    // Commission arithmetic, on the validated total only.
    const commissionAmountMinor = calculateCommissionMinor(resolvedTotal);

    // The duplicate check. AFTER all validation so a malformed request cannot
    // be probed for the existence of a contract, and BEFORE any write so the
    // rejection leaves both collections untouched.
    const existing = await contractRepository.getContractById(employment.id);
    if (existing.exists) {
        throw new ContractValidationError(
            'a contract already exists for this employment'
        );
    }

    const document = {
        // The four identities, copied from the employment the guard loaded.
        // Never from the body: CLIENT_FORBIDDEN_CONTRACT_FIELDS rejected any
        // attempt above, and this is the only place they are written.
        employmentId: employment.id,
        employerId: employment.employerId,
        employeeId: employment.employeeId,
        jobId: employment.jobId,
        applicationId: employment.applicationId,

        currency: CONTRACT_CURRENCY,
        paymentMode,
        totalAmountMinor: resolvedTotal,

        // The commission, computed here from the platform constant and never
        // from the request. commissionBps is stored alongside the amount so a
        // reader can re-derive and check the arithmetic from the document
        // alone, and so a future rate change leaves old contracts describing
        // the rate they were actually created under.
        commissionBps: PLATFORM_COMMISSION_BPS,
        commissionAmountMinor,

        status: PENDING_ACCEPTANCE_STATUS,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),

        // acceptedAt / acceptedBy are deliberately ABSENT from the created
        // document, not written as null. A contract nobody has accepted has no
        // acceptance time and no accepting party, and an explicit null would
        // conflate "not yet" with "cleared" -- the same absent-until-written
        // convention interviews' `response` field uses.
    };

    const milestoneDocuments = cleanedMilestones.map((milestone) => ({
        contractId: employment.id,
        employmentId: employment.id,
        ...(milestone.taskId ? { taskId: milestone.taskId } : {}),
        label: milestone.label,
        amountMinor: milestone.amountMinor,
        status: PENDING_ACCEPTANCE_STATUS,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }));

    const created = await contractRepository.createContractWithMilestonesIfAbsent(
        employment.id,
        document,
        milestoneDocuments
    );
    if (!created.created) {
        throw new ContractValidationError(
            'a contract already exists for this employment'
        );
    }

    const contractId = created.contractId;

    // Re-read rather than echoing `document`: the pre-write payload still
    // holds the UNRESOLVED serverTimestamp() sentinel, so returning it would
    // serialise `{"__sentinel":"serverTimestamp"}` onto the wire. This is the
    // same read-back conversationService performs for the same reason.
    const written = await contractRepository.getContractById(contractId);
    const contract = { id: written.id, ...written.data() };

    const milestoneSnapshot = await contractRepository.listMilestonesByContract(contractId);

    return { contractId, contract, milestones: toPlainObjects(milestoneSnapshot) };
};

/**
 * Accepts a pending contract, moving it pending_acceptance -> active.
 *
 * `contract` is the record the router's requireContractEmployee guard has
 * already loaded and proven the caller is the employee ON. `employeeUid`
 * comes from the verified token via that same guard, never from the body.
 *
 * ACCEPTANCE IS NOT PAYMENT. This function writes three fields -- status,
 * acceptedAt, acceptedBy -- and nothing else. It does not read or write the
 * employment, the task, the job or the application; it initiates no payment,
 * calls no provider, and stores no provider reference. Those separations are
 * the point of P1's stage boundary and are pinned by test #24.
 *
 * A contract that is not `pending_acceptance` -- which in P1 can only mean
 * already `active` -- is a 400, and the update is never issued, so a repeated
 * acceptance cannot restamp acceptedAt or alter anything at all. There is no
 * idempotent-success reading here deliberately: "accepted twice" is a client
 * bug worth surfacing, not a no-op worth hiding, and the 400 matches how
 * every other invalid-state transition in this codebase answers.
 *
 * Returns `{ contract }` as Firestore stored it after the update (re-read, so
 * acceptedAt is a real Timestamp).
 */
const acceptContract = async ({ contract, employeeUid }) => {
    if (contract.status !== PENDING_ACCEPTANCE_STATUS) {
        throw new ContractValidationError(
            'only a contract pending acceptance can be accepted'
        );
    }

    await contractRepository.updateContractFields(contract.id, {
        status: ACTIVE_CONTRACT_STATUS,
        acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
        acceptedBy: employeeUid,
    });

    const written = await contractRepository.getContractById(contract.id);

    return { contract: { id: written.id, ...written.data() } };
};

/**
 * Reads one contract and its milestone schedule by contract id.
 *
 * `contractId` is the employment id (deterministic document id). A missing
 * contract is a ContractNotFoundError, which the controller maps to a 404;
 * the router's requireContractParty guard has already answered a missing
 * contract with its own 404 for the /contracts/:contractId route, so from
 * there this throw is a backstop, exactly as in getEmployment.
 *
 * Both reads return the same `{ contract, milestones }` shape so the two
 * routes are interchangeable for a client.
 */
const getContract = async (contractId) => {
    const snapshot = await contractRepository.getContractById(contractId);

    if (!snapshot.exists) {
        throw new ContractNotFoundError('Contract not found');
    }

    const contract = { id: snapshot.id, ...snapshot.data() };
    const milestoneSnapshot = await contractRepository.listMilestonesByContract(contractId);

    return { contract, milestones: toPlainObjects(milestoneSnapshot) };
};

/**
 * Reads the contract held against one employment, plus its schedule.
 *
 * The employment-scoped sibling of getContract, for the
 * GET /contracts/employment/:employmentId route. Because the contract's
 * document id IS the employment id, this is the same document getContract
 * would find under that id; the two routes differ only in which guard
 * authorises them (requireEmploymentParty vs requireContractParty), which is
 * a difference about how a caller proves membership, not about what is stored.
 *
 * A valid employment with no contract is a 404, not an empty body: there is
 * no partial resource to represent, and the UI distinguishes "no contract
 * yet" from "contract exists" by the status code exactly as it does for a
 * missing interview list's parent.
 */
const getContractForEmployment = async (employmentId) => {
    const snapshot = await contractRepository.getContractById(employmentId);

    if (!snapshot.exists) {
        throw new ContractNotFoundError('Contract not found');
    }

    const contract = { id: snapshot.id, ...snapshot.data() };
    const milestoneSnapshot = await contractRepository.listMilestonesByContract(employmentId);

    return { contract, milestones: toPlainObjects(milestoneSnapshot) };
};

const validateProposalMilestoneShape = (milestones) => {
    if (!Array.isArray(milestones)) {
        throw new ContractValidationError('milestones must be an array');
    }
    if (milestones.length < MIN_MILESTONES || milestones.length > MAX_MILESTONES) {
        throw new ContractValidationError(
            `milestones must contain between ${MIN_MILESTONES} and ${MAX_MILESTONES} entries`
        );
    }
    const cleaned = milestones.map((entry, index) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new ContractValidationError(`milestones[${index}] must be an object`);
        }
        const { label, amountMinor, description } = entry;
        if (typeof label !== 'string' || !label.trim()) {
            throw new ContractValidationError(`milestones[${index}].label is required`);
        }
        requireMinorAmount(amountMinor, `milestones[${index}].amountMinor`);
        if (description !== undefined && description !== null && typeof description !== 'string') {
            throw new ContractValidationError(`milestones[${index}].description must be a string`);
        }
        return {
            label: label.trim(),
            amountMinor,
            description: typeof description === 'string' ? description.trim() : '',
        };
    });
    return cleaned;
};

const createProposal = async (payload = {}, employerId) => {
    const { applicationId, paymentMode, totalAmountMinor, milestones } = payload || {};

    if (!applicationId) throw new ContractValidationError('applicationId is required');
    if (!CONTRACT_PAYMENT_MODES.includes(paymentMode)) {
        throw new ContractValidationError('Invalid paymentMode');
    }

    const appSnap = await applicationRepository.getApplicationById(applicationId);
    if (!appSnap.exists) throw new ContractNotFoundError('Application not found');
    const application = appSnap.data();

    if (application.employeeId === undefined || application.jobId === undefined) {
        throw new ContractValidationError('Application is incomplete');
    }

    const jobSnap = await jobRepository.getJobById(application.jobId);
    if (!jobSnap.exists) throw new ContractNotFoundError('Job not found');
    const job = jobSnap.data();
    if (job.postedBy !== employerId) {
        throw new ContractForbiddenError('You do not have permission to create a proposal for this application');
    }

    if (application.status !== 'interviewed' && application.status !== 'accepted') {
        throw new ContractValidationError('Application must be interviewed before a proposal can be made');
    }

    let cleanedMilestones = null;
    let computedTotal = null;

    if (paymentMode === 'milestones') {
        cleanedMilestones = validateProposalMilestoneShape(milestones);
        computedTotal = sumMilestoneAmounts(cleanedMilestones);
        if (totalAmountMinor !== undefined && totalAmountMinor !== null && totalAmountMinor !== computedTotal) {
            throw new ContractValidationError('totalAmountMinor must equal the sum of milestone amounts');
        }
    } else if (paymentMode === 'full') {
        if (milestones !== undefined && milestones !== null) {
            throw new ContractValidationError('milestones are not allowed for full payment mode');
        }
        requireMinorAmount(totalAmountMinor, 'totalAmountMinor');
        if (totalAmountMinor > MAX_AMOUNT_MINOR) {
            throw new ContractValidationError('totalAmountMinor exceeds the allowed maximum');
        }
        computedTotal = totalAmountMinor;
    }

    const commissionAmountMinor = calculateCommissionMinor(computedTotal);
    const commissionBps = PLATFORM_COMMISSION_BPS;

    const now = admin.firestore.FieldValue.serverTimestamp();
    const proposal = {
        applicationId,
        jobId: application.jobId,
        employerId,
        employeeId: application.employeeId,
        paymentMode,
        currency: CONTRACT_CURRENCY,
        totalAmountMinor: computedTotal,
        commissionBps,
        commissionAmountMinor,
        milestones: cleanedMilestones || [],
        status: PROPOSAL_PENDING_ACCEPTANCE,
        createdAt: now,
        updatedAt: now,
        proposedBy: employerId,
    };

    const existing = await contractProposalRepository.listProposalsByApplication(applicationId);
    if (!existing.empty) {
        const docs = existing.docs.map((d) => ({ id: d.id, ...d.data() }));
        const hasAccepted = docs.some((d) => d.status === PROPOSAL_ACCEPTED);
        if (hasAccepted) {
            throw new ContractValidationError('An accepted proposal already exists for this application');
        }
        const hasPending = docs.some((d) => d.status === PROPOSAL_PENDING_ACCEPTANCE || d.status === PROPOSAL_CHANGES_REQUESTED);
        if (hasPending) {
            throw new ContractValidationError('A proposal is already pending for this application');
        }
    }

    const proposalId = await contractProposalRepository.addProposal(proposal);
    const written = await contractProposalRepository.getProposalById(proposalId);
    return { proposal: { id: written.id, ...written.data() } };
};

const getProposal = async (proposalId, callerId) => {
    const snapshot = await contractProposalRepository.getProposalById(proposalId);
    if (!snapshot.exists) throw new ContractProposalNotFoundError('Proposal not found');
    const proposal = { id: snapshot.id, ...snapshot.data() };
    if (proposal.employerId !== callerId && proposal.employeeId !== callerId) {
        throw new ContractForbiddenError('You do not have permission to view this proposal');
    }
    return { proposal };
};

const listProposalsForApplication = async (applicationId, callerId) => {
    const appSnap = await applicationRepository.getApplicationById(applicationId);
    if (!appSnap.exists) throw new ContractNotFoundError('Application not found');
    const application = appSnap.data();
    const jobSnap = await jobRepository.getJobById(application.jobId);
    if (!jobSnap.exists) throw new ContractNotFoundError('Job not found');
    const job = jobSnap.data();
    const isEmployer = job.postedBy === callerId;
    const isEmployee = application.employeeId === callerId;
    if (!isEmployer && !isEmployee) {
        throw new ContractForbiddenError('You do not have permission to view proposals for this application');
    }
    const snapshot = await contractProposalRepository.listProposalsByApplication(applicationId);
    const proposals = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return { proposals };
};

const respondToProposal = async (proposalId, callerId, action, message = '') => {
    const snapshot = await contractProposalRepository.getProposalById(proposalId);
    if (!snapshot.exists) throw new ContractProposalNotFoundError('Proposal not found');
    const proposal = { id: snapshot.id, ...snapshot.data() };
    if (proposal.employeeId !== callerId) {
        throw new ContractForbiddenError('Only the intended employee can respond to this proposal');
    }
    if (proposal.status === PROPOSAL_ACCEPTED) {
        throw new ContractValidationError('An accepted proposal cannot be modified');
    }
    if (action === 'accept') {
        await contractProposalRepository.updateProposalFields(proposalId, {
            status: PROPOSAL_ACCEPTED,
            acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
            acceptedBy: callerId,
            responseMessage: message || '',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } else if (action === 'request_changes') {
        await contractProposalRepository.updateProposalFields(proposalId, {
            status: PROPOSAL_CHANGES_REQUESTED,
            responseMessage: message || '',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } else {
        throw new ContractValidationError('Invalid action');
    }
    const written = await contractProposalRepository.getProposalById(proposalId);
    return { proposal: { id: written.id, ...written.data() } };
};

const reviseProposal = async (proposalId, payload = {}, employerId) => {
    const snapshot = await contractProposalRepository.getProposalById(proposalId);
    if (!snapshot.exists) throw new ContractProposalNotFoundError('Proposal not found');
    const proposal = { id: snapshot.id, ...snapshot.data() };
    if (proposal.employerId !== employerId) {
        throw new ContractForbiddenError('You do not have permission to revise this proposal');
    }
    if (proposal.status === PROPOSAL_ACCEPTED) {
        throw new ContractValidationError('An accepted proposal cannot be modified');
    }
    if (proposal.status !== PROPOSAL_CHANGES_REQUESTED && proposal.status !== PROPOSAL_PENDING_ACCEPTANCE) {
        throw new ContractValidationError('Proposal cannot be revised in its current state');
    }

    const { paymentMode, totalAmountMinor, milestones } = payload || {};
    if (!CONTRACT_PAYMENT_MODES.includes(paymentMode)) {
        throw new ContractValidationError('Invalid paymentMode');
    }

    let cleanedMilestones = null;
    let computedTotal = null;
    if (paymentMode === 'milestones') {
        cleanedMilestones = validateProposalMilestoneShape(milestones);
        computedTotal = sumMilestoneAmounts(cleanedMilestones);
        if (totalAmountMinor !== undefined && totalAmountMinor !== null && totalAmountMinor !== computedTotal) {
            throw new ContractValidationError('totalAmountMinor must equal the sum of milestone amounts');
        }
    } else if (paymentMode === 'full') {
        if (milestones !== undefined && milestones !== null) {
            throw new ContractValidationError('milestones are not allowed for full payment mode');
        }
        requireMinorAmount(totalAmountMinor, 'totalAmountMinor');
        if (totalAmountMinor > MAX_AMOUNT_MINOR) {
            throw new ContractValidationError('totalAmountMinor exceeds the allowed maximum');
        }
        computedTotal = totalAmountMinor;
    }

    const commissionAmountMinor = calculateCommissionMinor(computedTotal);
    const commissionBps = PLATFORM_COMMISSION_BPS;

    await contractProposalRepository.updateProposalFields(proposalId, {
        paymentMode,
        totalAmountMinor: computedTotal,
        commissionBps,
        commissionAmountMinor,
        milestones: cleanedMilestones || [],
        status: PROPOSAL_PENDING_ACCEPTANCE,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const written = await contractProposalRepository.getProposalById(proposalId);
    return { proposal: { id: written.id, ...written.data() } };
};

module.exports = {
    ContractValidationError,
    ContractNotFoundError,
    ContractForbiddenError,
    ContractProposalNotFoundError,
    CONTRACT_STATUSES,
    PENDING_ACCEPTANCE_STATUS,
    ACTIVE_CONTRACT_STATUS,
    CONTRACT_PAYMENT_MODES,
    MAX_MILESTONES,
    PROPOSAL_STATUSES,
    PROPOSAL_PENDING_ACCEPTANCE,
    PROPOSAL_CHANGES_REQUESTED,
    PROPOSAL_ACCEPTED,
    createContract,
    acceptContract,
    getContract,
    getContractForEmployment,
    createProposal,
    getProposal,
    listProposalsForApplication,
    respondToProposal,
    reviseProposal,
};
