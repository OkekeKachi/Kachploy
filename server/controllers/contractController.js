'use strict';

// contractController.js
//
// HTTP layer for the contracts resource (new in Stage P1). Express handlers,
// each doing only the three things every controller in this codebase does:
// read the request, call exactly one contractService function, and translate
// the outcome into a status code and body.
//
// There are four: create, accept, and the two reads. Every one of them is
// party-authorised by a router guard before this handler runs -- the create
// by requireContractEmployer, the accept by requireContractEmployee, the
// reads by requireContractParty and requireEmploymentParty -- so no handler
// here re-derives ownership, and no handler reads an identity from the
// request body: the acting uid reaches the service from req.user, which
// protect populated from the verified token.
//
// WHAT THIS CONTROLLER DELIBERATELY DOES NOT DO
//   * It does not accept money. There is no payment, charge, payout or
//     provider-reference endpoint in this resource, and the accept handler
//     below does not initiate one -- acceptance writes three fields on one
//     document and nothing else.
//   * It does not touch employments, tasks, jobs or applications. Creating a
//     contract reads the employment (through the guard) and reads tasks (in
//     the service, to validate milestones) but writes to `contracts` and
//     `milestones` only.
//   * It does not expose commission configuration errors as if they were
//     provider misconfiguration. No payment-provider credentials exist in P1
//     and none are required; the only configuration this resource reads is
//     the commission constant, which cannot fail to be present.

const contractService = require('../services/contractService');

/**
 * Maps a service failure onto the HTTP response.
 *
 * The same helper the other controllers use. Validation failures are turned
 * into a 400 and skip the console.error -- a request the caller got wrong is
 * not a server fault -- and not-found failures into a 404, which for the two
 * read routes is a backstop behind the router guards' own 404s.
 */
const sendFailure = (res, err, { log, message }) => {
    if (err instanceof contractService.ContractValidationError) {
        return res.status(400).json({ message: err.message });
    }

    if (err instanceof contractService.ContractNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (err instanceof contractService.ContractProposalNotFoundError) {
        return res.status(404).json({ message: err.message });
    }

    if (err instanceof contractService.ContractForbiddenError) {
        return res.status(403).json({ message: err.message });
    }

    if (log) {
        console.error(log, err);
    }

    return res.status(500).json({ message });
};

/**
 * POST /contracts
 *
 * Guarded by requireContractEmployer in the router, which has already loaded
 * the employment named by body.employmentId, refused a missing one with a
 * 404, refused a caller who is not that employment's employer with a 403,
 * and refused an ended/inactive employment with a 403. So the employment
 * this handler hands to the service is proven to exist, to be active, and to
 * belong to the caller as employer -- and its four identity fields are the
 * only source of the contract's identities.
 *
 * Responds 200 rather than 201, matching every other create in this API
 * (applications, tasks, interviews, conversations all answer 200; jobs is
 * the lone 201). Responds `{ message, contractId, contract, milestones }`,
 * where the contract is the stored document (with its server-resolved
 * Timestamps) and milestones is the stored schedule -- empty in `full` mode.
 */
const createContract = async (req, res) => {
    try {
        const { contractId, contract, milestones } = await contractService.createContract({
            employment: req.employment,
            payload: req.body,
        });

        res.status(200).json({
            message: 'Contract created successfully',
            contractId,
            contract,
            milestones,
        });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating contract:',
            message: 'Failed to create contract',
        });
    }
};

/**
 * POST /contracts/:contractId/accept
 *
 * Guarded by requireContractEmployee in the router, which has loaded the
 * contract and refused anyone who is not the employee named on it. The uid
 * that stamps acceptedBy is req.user.uid from the verified token.
 *
 * Responds `{ message, contract }`. The contract carries the new `active`
 * status and the acceptedAt/acceptedBy stamps as Firestore stored them. No
 * payment is initiated here and none is reported here.
 */
const acceptContract = async (req, res) => {
    try {
        const { contract } = await contractService.acceptContract({
            contract: req.contract,
            employeeUid: req.user.uid,
        });

        res.status(200).json({ message: 'Contract accepted successfully', contract });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error accepting contract:',
            message: 'Failed to accept contract',
        });
    }
};

/**
 * GET /contracts/employment/:employmentId
 *
 * Guarded by requireEmploymentParty, which has already loaded the employment
 * and refused a missing one with a 404 and a stranger with a 403, so this
 * handler performs no authorization of its own. An employment that exists but
 * has no contract answers 404 from the service -- "no contract yet" is the
 * normal state before an employer creates one and has no partial body to
 * represent.
 *
 * Responds `{ contract, milestones }`.
 */
const getContractForEmployment = async (req, res) => {
    try {
        const result = await contractService.getContractForEmployment(req.employment.id);

        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching contract for employment:',
            message: 'Failed to fetch contract',
        });
    }
};

/**
 * GET /contracts/:contractId
 *
 * Guarded by requireContractParty, which has loaded the contract and refused
 * anyone who is not one of its two parties, so this handler performs no
 * authorization of its own.
 *
 * Responds `{ contract, milestones }` -- the same shape as the
 * employment-scoped read, so a client may use either.
 */
const getContract = async (req, res) => {
    try {
        const result = await contractService.getContract(req.params.contractId);

        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching contract:',
            message: 'Failed to fetch contract',
        });
    }
};

const createProposal = async (req, res) => {
    try {
        const result = await contractService.createProposal(req.body, req.user.uid);
        res.status(200).json({ message: 'Proposal created successfully', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error creating proposal:',
            message: 'Failed to create proposal',
        });
    }
};

const getProposal = async (req, res) => {
    try {
        const result = await contractService.getProposal(req.params.proposalId, req.user.uid);
        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching proposal:',
            message: 'Failed to fetch proposal',
        });
    }
};

const listProposalsForApplication = async (req, res) => {
    try {
        const result = await contractService.listProposalsForApplication(req.params.applicationId, req.user.uid);
        res.status(200).json(result);
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error fetching proposals:',
            message: 'Failed to fetch proposals',
        });
    }
};

const respondToProposal = async (req, res) => {
    try {
        const { action, message } = req.body || {};
        const result = await contractService.respondToProposal(req.params.proposalId, req.user.uid, action, message);
        res.status(200).json({ message: 'Proposal response recorded', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error responding to proposal:',
            message: 'Failed to respond to proposal',
        });
    }
};

const reviseProposal = async (req, res) => {
    try {
        const result = await contractService.reviseProposal(req.params.proposalId, req.body, req.user.uid);
        res.status(200).json({ message: 'Proposal updated successfully', ...result });
    } catch (error) {
        sendFailure(res, error, {
            log: 'Error revising proposal:',
            message: 'Failed to revise proposal',
        });
    }
};

module.exports = {
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
