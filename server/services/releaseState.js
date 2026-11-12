'use strict';

// releaseState.js
//
// STAGE 2A. The pure release/attempt state machine. It knows no Firestore, no
// HTTP, no provider and no money. Every transition in Stage 2A and every later
// stage must be validated here rather than by an ad-hoc `if` in a caller.
//
// Two separate machines:
//   * release state -- what the release request as a whole has done;
//   * attempt state -- what one provider attempt has done.
//
// The attempt machine is terminal on success/failure. A retry is a NEW attempt,
// never a re-opening of the failed one. Stage 2A does not execute a retry.

const {
    RELEASE_STATES,
    RELEASE_ATTEMPT_STATES,
} = require('../config/release');

class ReleaseTransitionError extends Error {
    constructor(from, to, entity = 'release') {
        super(`invalid ${entity} transition: ${from} -> ${to}`);
        this.name = 'ReleaseTransitionError';
        this.code = 'RELEASE_INVALID_TRANSITION';
        this.entity = entity;
        this.from = from;
        this.to = to;
    }
}

const RELEASE_TRANSITIONS = Object.freeze({
    requested: Object.freeze(['in_flight', 'cancelled']),
    in_flight: Object.freeze(['succeeded', 'failed', 'needs_review']),
    // A failed release may be retried with a NEW attempt, or escalated when a
    // late success contradicts the recorded definitive failure.
    failed: Object.freeze(['in_flight', 'needs_review']),
    // Resolution requires explicit provider/admin evidence; callers use
    // releaseStateFromAttemptOutcome, which will not resolve implicitly.
    needs_review: Object.freeze(['succeeded', 'failed']),
    succeeded: Object.freeze([]),
    cancelled: Object.freeze([]),
});

const ATTEMPT_TRANSITIONS = Object.freeze({
    created: Object.freeze(['submitted', 'failed']),
    submitted: Object.freeze(['succeeded', 'failed', 'unknown']),
    unknown: Object.freeze(['succeeded', 'failed']),
    succeeded: Object.freeze([]),
    failed: Object.freeze([]),
});

const assertKnownReleaseState = (state) => {
    if (!RELEASE_STATES.includes(state)) {
        throw new ReleaseTransitionError(state, state, 'release');
    }
    return state;
};

const assertKnownAttemptState = (state) => {
    if (!RELEASE_ATTEMPT_STATES.includes(state)) {
        throw new ReleaseTransitionError(state, state, 'attempt');
    }
    return state;
};

const canTransitionRelease = (from, to) =>
    Object.prototype.hasOwnProperty.call(RELEASE_TRANSITIONS, from) &&
    RELEASE_TRANSITIONS[from].includes(to);

const isReviewResolution = (from, to) =>
    from === 'needs_review' && (to === 'succeeded' || to === 'failed');

const transitionRelease = (from, to, { explicitResolution = false } = {}) => {
    assertKnownReleaseState(from);
    assertKnownReleaseState(to);
    if (!canTransitionRelease(from, to)) {
        throw new ReleaseTransitionError(from, to);
    }
    // A needs_review release is ambiguous by definition. Moving it to a
    // definitive result requires explicit provider/admin evidence; a plain
    // transition call cannot silently choose success or failure.
    if (isReviewResolution(from, to) && !explicitResolution) {
        throw new ReleaseTransitionError(from, to);
    }
    return to;
};

const canTransitionAttempt = (from, to) =>
    Object.prototype.hasOwnProperty.call(ATTEMPT_TRANSITIONS, from) &&
    ATTEMPT_TRANSITIONS[from].includes(to);

const isUnknownResolution = (from, to) =>
    from === 'unknown' && (to === 'succeeded' || to === 'failed');

const transitionAttempt = (from, to, { explicitResolution = false } = {}) => {
    assertKnownAttemptState(from);
    assertKnownAttemptState(to);
    if (!canTransitionAttempt(from, to)) {
        throw new ReleaseTransitionError(from, to, 'attempt');
    }
    // An unknown attempt is ambiguous. Resolving it needs evidence from the
    // provider or an authorised reconciliation decision, not a default guess.
    if (isUnknownResolution(from, to) && !explicitResolution) {
        throw new ReleaseTransitionError(from, to, 'attempt');
    }
    return to;
};

const isTerminalReleaseState = (state) =>
    state === 'succeeded' || state === 'cancelled';

const isTerminalAttemptState = (state) =>
    state === 'succeeded' || state === 'failed';

/**
 * Maps one provider-attempt outcome onto the next RELEASE state.
 *
 * This is the one place that encodes the conflict rules:
 *   * a success after a definitive failure escalates to needs_review -- it is
 *     never written over the recorded failure and never silently becomes a
 *     success;
 *   * an unknown outcome always escalates to needs_review;
 *   * a needs_review release stays there unless the caller explicitly supplies
 *     provider evidence (`explicitResolution: true`);
 *   * a succeeded release stays succeeded, even if a late contradictory event
 *     arrives (the release's terminal success is not downgraded).
 *
 * `priorAttemptState` is the state of the attempt this outcome belongs to. When
 * it is `failed`, a subsequent success is a late-success conflict even if the
 * release-level state has already moved on.
 *
 * `explicitResolution` is only a state-machine gate. It is not evidence and not
 * authorization: a future trusted service boundary must derive it from stored
 * provider/admin evidence and must never accept the flag directly from a client.
 */
const releaseStateFromAttemptOutcome = (
    currentState,
    attemptOutcome,
    { priorAttemptState, explicitResolution = false } = {}
) => {
    assertKnownReleaseState(currentState);
    assertKnownAttemptState(attemptOutcome);
    if (priorAttemptState !== undefined) {
        assertKnownAttemptState(priorAttemptState);
    }

    if (currentState === 'succeeded') {
        return 'succeeded';
    }

    if (currentState === 'cancelled') {
        throw new ReleaseTransitionError(currentState, attemptOutcome, 'release');
    }

    if (currentState === 'needs_review') {
        // Already under review: another ambiguous outcome is not a transition,
        // and a definitive outcome is only a resolution when the trusted caller
        // supplies evidence. A late success after a failed attempt is therefore
        // a conflict by default, not a reason to throw before this branch.
        if (attemptOutcome === 'unknown') {
            return 'needs_review';
        }
        if (attemptOutcome === 'succeeded') {
            return explicitResolution
                ? transitionRelease(currentState, 'succeeded', { explicitResolution: true })
                : 'needs_review';
        }
        if (attemptOutcome === 'failed') {
            return explicitResolution
                ? transitionRelease(currentState, 'failed', { explicitResolution: true })
                : 'needs_review';
        }
    }

    const lateSuccessConflict =
        attemptOutcome === 'succeeded' &&
        (currentState === 'failed' || priorAttemptState === 'failed');

    if (lateSuccessConflict) {
        return transitionRelease(currentState, 'needs_review');
    }

    if (attemptOutcome === 'unknown') {
        return transitionRelease(currentState, 'needs_review');
    }

    if (attemptOutcome === 'succeeded') {
        return transitionRelease(currentState, 'succeeded');
    }

    if (attemptOutcome === 'failed') {
        return transitionRelease(currentState, 'failed');
    }

    // `created` / `submitted` are attempt lifecycle states, not outcomes.
    throw new ReleaseTransitionError(currentState, attemptOutcome, 'release');
};

module.exports = {
    ReleaseTransitionError,
    RELEASE_TRANSITIONS,
    ATTEMPT_TRANSITIONS,
    canTransitionRelease,
    canTransitionAttempt,
    transitionRelease,
    transitionAttempt,
    isTerminalReleaseState,
    isTerminalAttemptState,
    releaseStateFromAttemptOutcome,
};
