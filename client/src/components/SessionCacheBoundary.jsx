import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { auth } from '../firebase';
import { normalizeSessionUid, shouldClearSessionCache } from '../sessionCache';

const SessionCacheBoundary = ({ children }) => {
    const queryClient = useQueryClient();
    const previousUidRef = useRef(undefined);

    useEffect(
        () =>
            auth.onAuthStateChanged((user) => {
                const uid = normalizeSessionUid(user && user.uid);

                if (shouldClearSessionCache(previousUidRef.current, uid)) {
                    queryClient.clear();
                }

                previousUidRef.current = uid;
            }),
        [queryClient]
    );

    return children;
};

export default SessionCacheBoundary;
