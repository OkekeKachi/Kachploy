const VITE_API_URL = import.meta.env && import.meta.env.VITE_API_URL;
const DEFAULT_API_URL = VITE_API_URL || 'http://localhost:3000';

export const buildHealthUrl = (apiUrl) => {
    if (typeof apiUrl !== 'string' || apiUrl.trim() === '') return null;
    return `${apiUrl.trim().replace(/\/+$/, '')}/health`;
};

export const createWarmUpBackend = ({
    apiUrl = DEFAULT_API_URL,
    fetchImpl = globalThis.fetch,
} = {}) => {
    let hasWarmed = false;

    return () => {
        if (hasWarmed) return false;
        hasWarmed = true;

        const url = buildHealthUrl(apiUrl);
        if (!url || typeof fetchImpl !== 'function') return false;

        try {
            Promise.resolve(
                fetchImpl(url, {
                    method: 'GET',
                    mode: 'cors',
                    cache: 'no-store',
                    headers: { Accept: 'application/json' },
                }),
            ).catch(() => {});
        } catch {
            return false;
        }

        return true;
    };
};

export const warmUpBackend = createWarmUpBackend();
