'use strict';

// releaseRepository.js
//
// STAGE 2A. Data access for release requests and release attempts. This file
// owns only the direct Firestore calls and performs no provider work, no
// accounting and no state-machine decision of its own.
//
// CREATE-ONLY FOR REQUESTS IN STAGE 2A. A release request is created together
// with its `release_requested` audit event in one transaction. A duplicate uses
// the deterministic release id and returns the stored request instead of
// writing again. Later stages may add an explicit compare-and-set transition
// path; this stage deliberately has no release execution and therefore no such
// caller.
//
// Attempts are also deterministic and create-only here. Stage 2A does not
// submit attempts or implement retries; a later stage must add an explicit
// transition path rather than reusing an existing attempt document.

const { db } = require('../config/firebase');
const { releaseAttemptId } = require('../config/release');
const releaseEventRepository = require('./releaseEventRepository');

const releaseDoc = (releaseId) => db.collection('releaseRequests').doc(releaseId);
const attemptDoc = (attemptId) => db.collection('releaseAttempts').doc(attemptId);

const getReleaseById = (releaseId) => releaseDoc(releaseId).get();

const assertAttemptDocument = (releaseId, attemptNumber, attemptData) => {
    if (!attemptData || typeof attemptData !== 'object' || Array.isArray(attemptData)) {
        throw new TypeError('attemptData must be an object');
    }
    if (attemptData.releaseId !== releaseId) {
        throw new TypeError('attemptData.releaseId must match the release');
    }
    if (attemptData.attemptNumber !== attemptNumber) {
        throw new TypeError('attemptData.attemptNumber must match the attempt number');
    }
    if (attemptData.status !== 'created') {
        throw new TypeError('a new release attempt must start in created');
    }
};

const assertEventList = (events) => {
    if (events === undefined) return [];
    if (!Array.isArray(events)) {
        throw new TypeError('events must be an array');
    }
    for (const event of events) {
        if (!event || typeof event !== 'object' || Array.isArray(event)) {
            throw new TypeError('each event must be an object');
        }
        if (typeof event.id !== 'string' || !event.id) {
            throw new TypeError('each event must have an id');
        }
        if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) {
            throw new TypeError('each event must have a data object');
        }
    }
    return events;
};

const stageEvents = (tx, events) => {
    for (const event of events) {
        releaseEventRepository.appendEventInTransaction(tx, event.id, event.data);
    }
};

/**
 * Atomically creates the request and its first event if the deterministic id
 * is still free. If another caller won, returns its stored document.
 *
 * Both reads happen before either write (the fake enforces the same rule as
 * Firestore), and a concurrent loser retries into the `exists` branch, so the
 * request and its event are all-or-nothing.
 */
const createReleaseWithEventIfAbsent = (releaseId, releaseData, eventId, eventData) =>
    db.runTransaction(async (tx) => {
        const requestRef = releaseDoc(releaseId);
        const eventRef = db.collection('releaseEvents').doc(eventId);

        const existing = await tx.get(requestRef);
        if (existing.exists) {
            return {
                created: false,
                release: { id: existing.id, ...existing.data() },
            };
        }

        tx.create(requestRef, releaseData);
        tx.create(eventRef, eventData);

        return {
            created: true,
            release: { id: releaseId, ...releaseData },
            eventId,
        };
    });

/**
 * Atomically creates one attempt for an existing release. The attempt id is
 * derived from release id + attempt number, so asking twice for the same
 * attempt number returns the first attempt rather than overwriting it.
 *
 * A retry must use a new attempt number, which produces a new id. Stage 2A
 * intentionally does not perform that retry.
 */
const createAttemptIfAbsent = (releaseId, attemptNumber, attemptData) => {
    const id = releaseAttemptId(releaseId, attemptNumber);

    return db.runTransaction(async (tx) => {
        const requestRef = releaseDoc(releaseId);
        const attemptRef = attemptDoc(id);

        const requestSnapshot = await tx.get(requestRef);
        if (!requestSnapshot.exists) {
            return { created: false, reason: 'release-missing', attemptId: id };
        }

        const attemptSnapshot = await tx.get(attemptRef);
        if (attemptSnapshot.exists) {
            return {
                created: false,
                reason: 'attempt-exists',
                attempt: { id: attemptSnapshot.id, ...attemptSnapshot.data() },
            };
        }

        assertAttemptDocument(releaseId, attemptNumber, attemptData);
        tx.create(attemptRef, attemptData);
        return {
            created: true,
            attempt: { id, ...attemptData },
        };
    });
};

const nonEmptyText = (value) =>
    typeof value === 'string' && value.trim().length > 0;

const hasPriorAttempt = (release) =>
    (Number.isSafeInteger(release.attemptCount) && release.attemptCount > 0) ||
    (Number.isSafeInteger(release.currentAttemptNumber) &&
        release.currentAttemptNumber > 0) ||
    Boolean(release.currentAttemptId);

/**
 * STAGE 2C.1. The persisted authorization is the only authority that permits a
 * retry. This check is pure: the caller performs it inside the claim
 * transaction before any write. A rejection leaves the release, attempt and
 * authorization documents untouched.
 */
const retryAuthorizationRejection = (
    release,
    currentAttempt,
    attemptNumber,
    retryActorUid
) => {
    if (!nonEmptyText(retryActorUid)) return 'retry-actor-required';
    if (
        release.retryAuthorizationStatus === 'consumed' ||
        release.retryAuthorizationConsumedAt
    ) {
        return 'retry-authorization-consumed';
    }
    if (release.retryAuthorizationStatus !== 'authorized') {
        return 'retry-authorization-missing';
    }
    if (!nonEmptyText(release.retryAuthorizationId)) {
        return 'retry-authorization-missing';
    }
    if (release.retryAuthorizationReleaseId !== release.id) {
        return 'retry-authorization-release-mismatch';
    }
    if (release.retryAuthorizationFailedAttemptId !== currentAttempt.id) {
        return 'retry-authorization-attempt-mismatch';
    }
    if (
        release.retryAuthorizationFailedAttemptNumber !==
        currentAttempt.attemptNumber
    ) {
        return 'retry-authorization-attempt-mismatch';
    }
    if (
        release.retryAuthorizationTargetAttemptNumber !== attemptNumber ||
        release.retryAuthorizedForAttemptNumber !== attemptNumber
    ) {
        return 'retry-authorization-attempt-number-mismatch';
    }
    if (release.retryAuthorizedBy !== retryActorUid) {
        return 'retry-authorization-actor-mismatch';
    }
    if (
        !nonEmptyText(release.retryAuthorizationReason) ||
        !nonEmptyText(release.retryAuthorizationSource) ||
        !nonEmptyText(release.retryAuthorizationReference)
    ) {
        return 'retry-authorization-evidence-missing';
    }
    return null;
};

const claimAttemptForSubmission = async ({
    releaseId,
    attemptNumber,
    claimedAt,
    buildAttempt,
    buildEvents,
    retryActorUid,
}) => {
    const attemptId = releaseAttemptId(releaseId, attemptNumber);
    if (typeof buildAttempt !== 'function') {
        throw new TypeError('buildAttempt must be a function');
    }

    return db.runTransaction(async (tx) => {
        const requestRef = releaseDoc(releaseId);
        const attemptRef = attemptDoc(attemptId);

        const releaseSnapshot = await tx.get(requestRef);
        if (!releaseSnapshot.exists) {
            return { claimed: false, reason: 'release-missing' };
        }
        const release = { id: releaseSnapshot.id, ...releaseSnapshot.data() };

        if (release.status !== 'requested' && release.status !== 'failed') {
            return {
                claimed: false,
                reason: 'not-claimable',
                status: release.status,
                release,
            };
        }

        const currentAttemptCount = Number.isSafeInteger(release.attemptCount)
            ? release.attemptCount
            : 0;
        const expectedAttemptNumber = currentAttemptCount + 1;
        if (attemptNumber !== expectedAttemptNumber) {
            return {
                claimed: false,
                reason: 'attempt-number-mismatch',
                expectedAttemptNumber,
                release,
            };
        }

        let retryContext = null;

        if (release.status === 'requested') {
            // A fresh release may only take its first attempt. Persisted prior
            // attempt state means this is not an initial submission and cannot
            // be treated as one merely because the status says `requested`.
            if (hasPriorAttempt(release)) {
                return {
                    claimed: false,
                    reason: 'release-state-inconsistent',
                    release,
                };
            }
        } else {
            if (currentAttemptCount < 1) {
                return {
                    claimed: false,
                    reason: 'retry-current-attempt-missing',
                    release,
                };
            }

            const currentAttemptNumber = Number.isSafeInteger(
                release.currentAttemptNumber
            )
                ? release.currentAttemptNumber
                : currentAttemptCount;
            if (currentAttemptNumber !== currentAttemptCount) {
                return {
                    claimed: false,
                    reason: 'retry-current-attempt-mismatch',
                    release,
                };
            }

            const expectedCurrentAttemptId = releaseAttemptId(
                releaseId,
                currentAttemptNumber
            );
            const currentAttemptId =
                release.currentAttemptId || expectedCurrentAttemptId;
            if (currentAttemptId !== expectedCurrentAttemptId) {
                return {
                    claimed: false,
                    reason: 'retry-current-attempt-mismatch',
                    release,
                };
            }

            const currentAttemptSnapshot = await tx.get(
                attemptDoc(currentAttemptId)
            );
            if (!currentAttemptSnapshot.exists) {
                return {
                    claimed: false,
                    reason: 'retry-current-attempt-missing',
                    release,
                };
            }
            const currentAttempt = {
                id: currentAttemptSnapshot.id,
                ...currentAttemptSnapshot.data(),
            };
            if (
                currentAttempt.releaseId !== releaseId ||
                currentAttempt.attemptNumber !== currentAttemptNumber
            ) {
                return {
                    claimed: false,
                    reason: 'retry-current-attempt-mismatch',
                    release,
                    attempt: currentAttempt,
                };
            }
            if (currentAttempt.status !== 'failed') {
                return {
                    claimed: false,
                    reason: 'attempt-not-definitively-failed',
                    release,
                    attempt: currentAttempt,
                };
            }

            const rejection = retryAuthorizationRejection(
                release,
                currentAttempt,
                attemptNumber,
                retryActorUid
            );
            if (rejection) {
                return {
                    claimed: false,
                    reason: rejection,
                    release,
                    attempt: currentAttempt,
                };
            }

            retryContext = {
                authorizationId: release.retryAuthorizationId,
                authorizedBy: release.retryAuthorizedBy,
                authorizedAt: release.retryAuthorizedAt,
                failedAttemptId: currentAttempt.id,
                failedAttemptNumber: currentAttempt.attemptNumber,
                targetAttemptNumber: attemptNumber,
                reason: release.retryAuthorizationReason,
                evidence: {
                    source: release.retryAuthorizationSource,
                    reference: release.retryAuthorizationReference,
                },
                submittedBy: retryActorUid,
            };
        }

        const attemptSnapshot = await tx.get(attemptRef);
        if (attemptSnapshot.exists) {
            return {
                claimed: false,
                reason: 'attempt-exists',
                attempt: { id: attemptSnapshot.id, ...attemptSnapshot.data() },
                release,
            };
        }

        const attemptData = buildAttempt(release, attemptNumber, claimedAt);
        assertAttemptDocument(releaseId, attemptNumber, attemptData);

        const releaseFields = {
            status: 'in_flight',
            attemptCount: attemptNumber,
            currentAttemptId: attemptId,
            currentAttemptNumber: attemptNumber,
            updatedAt: claimedAt,
            ...(retryContext
                ? {
                      retryAuthorizationStatus: 'consumed',
                      retryAuthorizationConsumedAt: claimedAt,
                      retryAuthorizationConsumedBy: retryActorUid,
                      retryAuthorizationConsumedForAttemptNumber:
                          attemptNumber,
                      retryAuthorizationConsumedByAttemptId: attemptId,
                  }
                : {}),
        };
        const events = assertEventList(
            typeof buildEvents === 'function'
                ? buildEvents(release, attemptNumber, claimedAt, {
                      retry: Boolean(retryContext),
                      retryAuthorization: retryContext,
                  })
                : []
        );

        tx.create(attemptRef, attemptData);
        tx.update(requestRef, releaseFields);
        stageEvents(tx, events);

        return {
            claimed: true,
            attemptId,
            attemptNumber,
            retry: Boolean(retryContext),
            retryAuthorization: retryContext,
            release: { ...release, ...releaseFields },
            attempt: { id: attemptId, ...attemptData },
            eventIds: events.map((event) => event.id),
        };
    });
};

const applyReleaseDecision = async ({ releaseId, attemptNumber, decide }) => {
    if (typeof decide !== 'function') {
        throw new TypeError('decide must be a function');
    }
    const attemptId = releaseAttemptId(releaseId, attemptNumber);

    return db.runTransaction(async (tx) => {
        const requestRef = releaseDoc(releaseId);
        const attemptRef = attemptDoc(attemptId);

        const releaseSnapshot = await tx.get(requestRef);
        if (!releaseSnapshot.exists) {
            return { applied: false, reason: 'release-missing' };
        }
        const release = { id: releaseSnapshot.id, ...releaseSnapshot.data() };

        const attemptSnapshot = await tx.get(attemptRef);
        if (!attemptSnapshot.exists) {
            return { applied: false, reason: 'attempt-missing', release };
        }
        const attempt = { id: attemptSnapshot.id, ...attemptSnapshot.data() };

        if (
            attempt.releaseId !== releaseId ||
            attempt.attemptNumber !== attemptNumber
        ) {
            return { applied: false, reason: 'attempt-mismatch', release, attempt };
        }

        const decision = decide(release, attempt) || {};
        if (decision.apply === false) {
            return {
                applied: false,
                reason: decision.reason || 'refused',
                release,
                attempt,
            };
        }

        const releaseFields = decision.releaseFields || {};
        const attemptFields = decision.attemptFields || {};
        const events = assertEventList(decision.events);

        // STAGE 2C idempotency: a duplicate reconciliation may decide the same
        // logical outcome again. Read the deterministic event documents before
        // any write (Firestore requires all reads first) and create only the
        // ones that do not exist. The state change and its new events still
        // commit atomically, while a repeated call cannot duplicate history.
        const uniqueEvents = Array.from(
            new Map(events.map((event) => [event.id, event])).values()
        );
        const eventRefs = uniqueEvents.map((event) =>
            db.collection('releaseEvents').doc(event.id)
        );
        const eventSnapshots = [];
        for (const eventRef of eventRefs) {
            eventSnapshots.push(await tx.get(eventRef));
        }
        const missingEvents = uniqueEvents.filter(
            (event, index) => !eventSnapshots[index].exists
        );

        if (Object.keys(releaseFields).length > 0) {
            tx.update(requestRef, releaseFields);
        }
        if (Object.keys(attemptFields).length > 0) {
            tx.update(attemptRef, attemptFields);
        }
        stageEvents(tx, missingEvents);

        return {
            applied: true,
            release: { ...release, ...releaseFields },
            attempt: { ...attempt, ...attemptFields },
            eventIds: missingEvents.map((event) => event.id),
        };
    });
};

const getAttemptById = (attemptId) => attemptDoc(attemptId).get();

const listAttemptsByReleaseId = (releaseId) =>
    db.collection('releaseAttempts').where('releaseId', '==', releaseId).get();

const listReleasesByEmployment = (employmentId) =>
    db.collection('releaseRequests').where('employmentId', '==', employmentId).get();

// STAGE 2C read helpers. These are deliberately read-only; reconciliation
// decides state through applyReleaseDecision, never by writing a query result.
const listReleasesByStatus = (status) =>
    db.collection('releaseRequests').where('status', '==', status).get();

const listAllReleases = () => db.collection('releaseRequests').get();

const listAttemptsByStatus = (status) =>
    db.collection('releaseAttempts').where('status', '==', status).get();

module.exports = {
    getReleaseById,
    createReleaseWithEventIfAbsent,
    createAttemptIfAbsent,
    claimAttemptForSubmission,
    applyReleaseDecision,
    getAttemptById,
    listAttemptsByReleaseId,
    listReleasesByEmployment,
    listReleasesByStatus,
    listAllReleases,
    listAttemptsByStatus,
};
