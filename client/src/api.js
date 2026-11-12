// api.js
//
// Shared axios instance that attaches the Firebase ID token to every request.
//
// The server requires `Authorization: Bearer <id-token>` on all 21 routes
// (see server/test/docs/ENDPOINTS.md). Before this module each page called the
// global `axios` directly with a hardcoded origin and no token, so nearly every
// request was rejected with 401.
//
// All 31 frontend call sites now use this instance. Pages import it as
// `import api from '../api';` and pass bare paths, which resolve against
// baseURL below:
//
//   import api from '../api';
//   const res = await api.get('/jobs');
//
// If you add a call site, use `api`, not the bare `axios` import.

import axios from 'axios';
import { auth } from './firebase';

const VITE_API_URL = import.meta.env.VITE_API_URL;
const BASE_URL = VITE_API_URL || 'http://localhost:3000';

export const api = axios.create({ baseURL: BASE_URL });

// ---------------------------------------------------------------------------
// STAGE 1I.1. Named payment + contract call helpers.
//
// Each is a thin wrapper over the same `api` instance above, so the Firebase ID
// token is attached by the existing interceptor and the Authorization header,
// baseURL and error surface are identical to every other call site. They exist
// so the payment panel does not hand-spell URLs, and so the request shapes are
// stated once and testable.
//
// NOTHING HERE INFERS OR COMPUTES PAYMENT TRUTH. The server owns amounts,
// statuses, references and the checkout URL; these helpers only move the two
// fields the backend accepts (`milestoneId`, `idempotencyKey`) and return the
// server's payload untouched.
// ---------------------------------------------------------------------------

/**
 * The contract and its milestone schedule for one employment.
 * GET /contracts/employment/:employmentId -> { contract, milestones }.
 * Guarded server-side by requireEmploymentParty (either contract party).
 *
 * STAGE 1I.3. A 404 is the NORMAL "no contract yet" state -- an active
 * employment before its employer creates one -- not a failure, so it is
 * returned as `{ contract: null, milestones: [] }` rather than thrown. Every
 * other error (401/403/500) propagates so the caller can report it. This
 * mirrors fetchPaymentForMilestone and is what lets the contract UI tell
 * "no contract yet" (draw the create/pending states) apart from "the read
 * failed" (show an error).
 */
export const fetchContractForEmployment = async (employmentId) => {
    try {
        const res = await api.get(`/contracts/employment/${employmentId}`);
        return {
            contract: res.data.contract || null,
            milestones: res.data.milestones || [],
        };
    } catch (err) {
        if (err && err.response && err.response.status === 404) {
            return { contract: null, milestones: [] };
        }
        throw err;
    }
};

/**
 * Creates a contract for an employment. POST /contracts
 * -> { message, contractId, contract, milestones }.
 *
 * The caller supplies the WHOLE contract request body as the backend defines
 * it -- `{ employmentId, paymentMode, currency?, totalAmountMinor?, milestones? }`
 * -- and this helper forwards it unchanged. It invents no field and derives
 * nothing: employment identity, amounts and commission are the server's, and
 * any forbidden or malformed field comes back as a 400 the caller can display.
 */
export const createContract = async (payload) => {
    const res = await api.post('/contracts', payload);
    return res.data;
};

/**
 * Accepts a pending contract. POST /contracts/:contractId/accept
 * -> { message, contract }.
 *
 * `contractId` is the employment id (the contract's deterministic document id).
 * The accepting employee's identity is taken from the verified token by the
 * server guard, never sent from here.
 */
export const acceptContract = async (contractId) => {
    const res = await api.post(`/contracts/${contractId}/accept`, {});
    return res.data;
};

export const createContractProposal = async (payload) => {
    const res = await api.post('/contracts/proposals', payload);
    return res.data;
};

export const fetchContractProposalsForApplication = async (applicationId) => {
    const res = await api.get(`/contracts/proposals/application/${applicationId}`);
    return res.data;
};

export const fetchContractProposal = async (proposalId) => {
    const res = await api.get(`/contracts/proposals/${proposalId}`);
    return res.data;
};

export const respondToContractProposal = async (proposalId, payload) => {
    const res = await api.post(`/contracts/proposals/${proposalId}/respond`, payload);
    return res.data;
};

export const reviseContractProposal = async (proposalId, payload) => {
    const res = await api.put(`/contracts/proposals/${proposalId}`, payload);
    return res.data;
};

/**
 * The stored payment record for one milestone.
 * GET /payments/milestone/:milestoneId -> { payment }.
 *
 * A 404 is the NORMAL "no payment record created yet" state, not a failure, so
 * it is returned as `{ payment: null }` rather than thrown. Every other error
 * (401/403/500) propagates so the caller can report it.
 */
export const fetchPaymentForMilestone = async (milestoneId) => {
    try {
        const res = await api.get(`/payments/milestone/${milestoneId}`);
        return { payment: res.data.payment || null };
    } catch (err) {
        if (err && err.response && err.response.status === 404) {
            return { payment: null };
        }
        throw err;
    }
};

/**
 * Creates (or, on an idempotent replay, returns) the payment record for a
 * milestone. POST /payments -> { message, payment }.
 *
 * The idempotencyKey is the caller's responsibility and MUST be reused for a
 * repeated attempt at the SAME creation so the server treats it as a replay.
 */
export const createPaymentRecord = async (milestoneId, idempotencyKey) => {
    const res = await api.post('/payments', { milestoneId, idempotencyKey });
    return res.data;
};

/**
 * Asks the server to initialize Test Mode checkout for a milestone.
 * POST /payments/initialize -> { message, paymentId, reference, status,
 * amountMinor, feeMinor, chargeMinor, currency, checkoutUrl }.
 *
 * Only `milestoneId` is sent: no amount, no currency, no provider field is ever
 * taken from the client. The server validates the returned checkout URL before
 * this module ever sees it; the panel re-checks the host before navigating.
 */
export const initializePayment = async (milestoneId) => {
    const res = await api.post('/payments/initialize', { milestoneId });
    return res.data;
};

/**
 * Asks the server to verify the Paystack transaction behind a milestone.
 * POST /payments/verify -> { message, verified, payment }.
 *
 * The server is the ONLY authority on status here; `verified` is not proof of a
 * charge on its own and the panel always reads `payment.status`.
 */
export const verifyPayment = async (milestoneId) => {
    const res = await api.post('/payments/verify', { milestoneId });
    return res.data;
};

/**
 * The stored payment record for one full contract.
 * GET /payments/contract/:contractId -> { payment }.
 *
 * A 404 is the normal "no payment record created yet" state, mapped to
 * `{ payment: null }` exactly like the milestone read.
 */
export const fetchPaymentForContract = async (contractId) => {
    try {
        const res = await api.get(`/payments/contract/${contractId}`);
        return { payment: res.data.payment || null };
    } catch (err) {
        if (err && err.response && err.response.status === 404) {
            return { payment: null };
        }
        throw err;
    }
};

/** Creates (or replays) the one payment record for a full contract. */
export const createContractPaymentRecord = async (contractId, idempotencyKey) => {
    const res = await api.post('/payments/contract', { contractId, idempotencyKey });
    return res.data;
};

/**
 * Initializes Test Mode checkout for a full contract. Only `contractId` is
 * sent; the server derives the amount, fee, reference and checkout URL.
 */
export const initializeContractPayment = async (contractId) => {
    const res = await api.post('/payments/contract/initialize', { contractId });
    return res.data;
};

/** Asks the server to verify the provider transaction for a full contract. */
export const verifyContractPayment = async (contractId) => {
    const res = await api.post('/payments/contract/verify', { contractId });
    return res.data;
};

/**
 * The caller's server-side payment history page.
 * GET /payments/history -> { payments, pagination, summary, filters }.
 *
 * Ownership, filtering, ordering, pagination and summary totals are all decided
 * by the server. This helper forwards only the query parameters and never
 * derives a payment, amount or status on the client.
 */
export const fetchPaymentHistory = async (params = {}) => {
    const res = await api.get('/payments/history', { params });
    return res.data;
};

export const fetchPayoutAccount = async () => {
    const res = await api.get('/users/payout-account');
    return res.data;
};

export const fetchPayoutBanks = async () => {
    const res = await api.get('/users/payout-account/banks');
    return res.data;
};

export const resolvePayoutAccount = async ({ bankAccountNumber, bankCode }) => {
    const res = await api.post('/users/payout-account/resolve', {
        bankAccountNumber,
        bankCode,
    });
    return res.data;
};

export const savePayoutAccount = async ({ bankAccountNumber, bankCode }) => {
    const res = await api.put('/users/payout-account', {
        bankAccountNumber,
        bankCode,
    });
    return res.data;
};

export const fetchReleaseWorkspace = async (employmentId) => {
    const res = await api.get(`/releases/employment/${employmentId}`);
    return res.data;
};

export const createReleaseRequest = async (targetType, targetId) => {
    const res = await api.post('/releases', { targetType, targetId });
    return res.data;
};

export const fetchRelease = async (releaseId) => {
    const res = await api.get(`/releases/${releaseId}`);
    return res.data;
};

export const approveRelease = async (releaseId) => {
    const res = await api.post(`/releases/${releaseId}/approve`, {});
    return res.data;
};

export const reconcileRelease = async (releaseId) => {
    const res = await api.post(`/releases/${releaseId}/reconcile`, {});
    return res.data;
};

// Employment lifecycle
export const completeEmployment = async (employmentId, payload = {}) => {
    const res = await api.post(`/employments/${employmentId}/complete`, payload);
    return res.data;
};

export const terminateEmployment = async (employmentId, payload = {}) => {
    const res = await api.post(`/employments/${employmentId}/terminate`, payload);
    return res.data;
};

export const recordEmploymentSettlement = async (employmentId, payload = {}) => {
    const res = await api.post(`/employments/${employmentId}/settlement`, payload);
    return res.data;
};

// Disputes
// The dispute collection is scoped to an employment by the server route, so
// creation carries the employment id in the path rather than the body.
export const createDispute = async (employmentId, payload = {}) => {
    const res = await api.post(`/employments/${employmentId}/disputes`, payload);
    return res.data;
};

// Disputes are listed per party. The server's guard rejects any uid that is not
// the authenticated caller, so this always passes the signed-in user's uid.
export const listDisputes = async (uid) => {
    const res = await api.get(`/disputes/party/${uid}`);
    return res.data;
};

export const getDispute = async (disputeId) => {
    const res = await api.get(`/disputes/${disputeId}`);
    return res.data;
};

export const submitDisputeEvidence = async (disputeId, payload = {}) => {
    const res = await api.post(`/disputes/${disputeId}/evidence`, payload);
    return res.data;
};

// Reviews
// One review per reviewer per employment, addressed by the employment id.
export const createReview = async (employmentId, payload = {}) => {
    const res = await api.post(`/employments/${employmentId}/reviews`, payload);
    return res.data;
};

api.interceptors.request.use(async (config) => {
  const user = auth.currentUser;

  // No signed-in user: send the request unauthenticated and let the server
  // decide. This keeps public reads and the sign-up flow working.
  if (!user) return config;

  try {
    // getIdToken() returns the cached token when still valid and transparently
    // refreshes it when expired, so this is both cheap and always current.
    const token = await user.getIdToken();
    config.headers.Authorization = `Bearer ${token}`;
  } catch (err) {
    // A failed token fetch must not silently fall back to an anonymous request;
    // the resulting 401 is easier to diagnose than a missing header.
    console.error('Could not attach ID token to request', err);
  }

  return config;
});

export default api;
