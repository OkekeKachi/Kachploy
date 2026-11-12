/**
 * Extracts the sentence a server sent for a failed request.
 *
 * The employment/dispute/review controllers answer with `{ message }`, while
 * some older routes answer with `{ error }`. Reading only one shape leaves the
 * other invisible and the UI falls back to a generic sentence even when the
 * server explained the refusal. `message` wins when both are present because it
 * is the shape the current controllers emit.
 *
 * Anything that is not a non-empty string is ignored, so a malformed body can
 * never render `[object Object]` or an empty error line.
 */
export const apiErrorMessage = (error, fallback) => {
    const data = error && error.response && error.response.data;
    if (!data || typeof data !== 'object') return fallback;

    for (const value of [data.message, data.error]) {
        if (typeof value === 'string' && value.trim()) return value;
    }
    return fallback;
};
