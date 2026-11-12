'use strict';

const DEFAULT_PROVIDER_ID = 'simulated-release-provider';

const createSimulatedReleaseProvider = (options = {}) => {
    const outcomes = options.outcomes || {};
    const lookups = options.lookups || {};
    const defaultOutcome = options.defaultOutcome || 'succeeded';
    const providerId = options.providerId || DEFAULT_PROVIDER_ID;
    const calls = [];
    const lookupCalls = [];
    const recordedOutcomes = new Map();

    const specFor = (table, input) => {
        const attemptKey = `${input.releaseId}:${input.attemptNumber}`;
        if (Object.prototype.hasOwnProperty.call(table, attemptKey)) {
            return { found: true, spec: table[attemptKey] };
        }
        if (Object.prototype.hasOwnProperty.call(table, input.releaseId)) {
            return { found: true, spec: table[input.releaseId] };
        }
        return { found: false };
    };

    const identityFor = (input) => ({
        releaseId: input.releaseId,
        attemptId: input.attemptId,
        attemptNumber: input.attemptNumber,
        currency: input.currency,
        amountMinor: input.amountMinor,
    });

    const throwSimulated = () => {
        const error = new Error('simulated release provider failure');
        error.code = 'SIMULATED_RELEASE_PROVIDER_ERROR';
        throw error;
    };

    const resolveSpec = async (spec, input) => {
        if (spec === 'throw') throwSimulated();
        const resolved = typeof spec === 'function' ? await spec(input) : spec;
        if (resolved === 'throw') throwSimulated();
        return resolved;
    };

    const buildResult = (spec, input) => {
        const reference = `${providerId}_${input.releaseId}_${input.attemptNumber}`;
        const outcome = typeof spec === 'string' ? spec : spec && spec.outcome;

        if (outcome === 'succeeded') {
            return {
                outcome,
                providerReference:
                    (spec && spec.providerReference) || reference,
            };
        }
        if (outcome === 'failed') {
            return {
                outcome,
                failureReason:
                    (spec && spec.failureReason) || 'simulated_release_failed',
            };
        }
        if (outcome === 'unknown') {
            return {
                outcome,
                failureReason:
                    (spec && spec.failureReason) || 'simulated_release_unknown',
            };
        }
        return spec;
    };

    return {
        providerId,
        calls,
        lookupCalls,
        async submitRelease(input) {
            calls.push(structuredClone(input));

            const entry = specFor(outcomes, input);
            const spec = entry.found ? entry.spec : defaultOutcome;
            const resolved = await resolveSpec(spec, input);
            const result = buildResult(resolved, input);

            // Only a definitive provider result is authoritative enough for a
            // later lookup. Unknown/throw results stay unknown.
            if (result && (result.outcome === 'succeeded' || result.outcome === 'failed')) {
                recordedOutcomes.set(input.attemptId, structuredClone(result));
            }
            return result;
        },
        async lookupReleaseOutcome(input) {
            lookupCalls.push(structuredClone(input));

            const entry = specFor(lookups, input);
            if (entry.found) {
                const resolved = await resolveSpec(entry.spec, input);
                if (resolved === null || resolved === undefined) return null;
                return {
                    ...identityFor(input),
                    ...buildResult(resolved, input),
                };
            }

            const recorded = recordedOutcomes.get(input.attemptId);
            if (!recorded) return null;
            return {
                ...identityFor(input),
                ...structuredClone(recorded),
            };
        },
    };
};

module.exports = {
    DEFAULT_PROVIDER_ID,
    createSimulatedReleaseProvider,
};
