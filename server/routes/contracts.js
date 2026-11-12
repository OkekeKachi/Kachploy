const express = require('express');
const router = express.Router();
const contractController = require('../controllers/contractController');
const {
    protect,
    requireContractEmployer,
    requireContractEmployee,
    requireContractParty,
    requireEmploymentParty,
} = require('../middleware/auth');

// STAGE P1: the contracts resource, mounted at /contracts in app.js.
//
// Four endpoints, no business logic and no inline handlers -- route
// definitions and middleware only, like every router in this codebase.
//
// WHAT A CONTRACT IS HERE. A contract is the record of the price two people
// agreed on for an employment that already exists. It is created by the
// employer after the hire, it carries an explicitly agreed amount in kobo
// (never inferred from jobs.price or applications.employeePrice), and it
// becomes active only when the employee accepts it. P1 charges nobody, holds
// nothing, computes no provider fees and talks to no payment provider: the
// three writes this resource has are create, accept, and nothing else.
//
// AUTHORIZATION: every route is party-scoped and all the decisions are made
// in the guards rather than in the controller:
//   requireContractEmployer  POST   the employer on an existing ACTIVE
//                                   employment may create its contract.
//                                   Body-based (employmentId), like
//                                   requireInterviewAuthor, because the
//                                   employment being contracted is the
//                                   subject of the request rather than part
//                                   of the route. Also refuses a missing
//                                   employment (404) and an ended one (403).
//   requireContractEmployee  POST   the employee named on the contract may
//                                   accept it, and nobody else -- not the
//                                   employer, not a platform actor (there is
//                                   none). Status is a domain rule and stays
//                                   in the service.
//   requireContractParty     GET    either party to the contract may read it
//                                   by its id.
//   requireEmploymentParty   GET    either party to the EMPLOYMENT may read
//                                   its contract. Existing guard, reused:
//                                   this path names an employment, and
//                                   membership in one is exactly the question
//                                   that guard answers. The two read guards
//                                   admit the same two people by
//                                   construction, because the contract copies
//                                   its ids from the employment.
//
// ROUTE ORDER. `/employment/:employmentId` is a two-segment path and is
// registered BEFORE the one-segment `/:contractId`, matching the employments
// router's ordering for the same reason: keeping the precedence explicit even
// though Express would not let the one-segment pattern swallow the
// two-segment one. The first segments also differ in kind ('employment' is a
// fixed word), so no shadowing is possible in either direction.
//
// NO DELETE, NO UPDATE, NO PAYMENT ROUTE. A contract two people agreed on is
// not editable; one the employee does not want is simply never accepted; and
// there is deliberately no /pay, /initiate or /webhook path -- those belong
// to a later stage and their absence here is the stage boundary, not an
// omission.
router.post('/', protect, requireContractEmployer, contractController.createContract);
router.post('/:contractId/accept', protect, requireContractEmployee, contractController.acceptContract);
router.get('/employment/:employmentId', protect, requireEmploymentParty, contractController.getContractForEmployment);
router.post('/proposals', protect, contractController.createProposal);
router.get('/proposals/application/:applicationId', protect, contractController.listProposalsForApplication);
router.get('/proposals/:proposalId', protect, contractController.getProposal);
router.post('/proposals/:proposalId/respond', protect, contractController.respondToProposal);
router.put('/proposals/:proposalId', protect, contractController.reviseProposal);
router.get('/:contractId', protect, requireContractParty, contractController.getContract);

module.exports = router;
