export const normalizeSessionUid = (uid) => (typeof uid === 'string' ? uid : '');

export const shouldClearSessionCache = (previousUid, nextUid) => {
    if (previousUid === undefined) return false;
    return normalizeSessionUid(previousUid) !== normalizeSessionUid(nextUid);
};

export default shouldClearSessionCache;
