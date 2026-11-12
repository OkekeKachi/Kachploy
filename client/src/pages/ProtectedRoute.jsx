import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '../firebase';
import { PageLoader } from '../components/ui/Spinner';

/*
  STAGE 11.1: the loading state now uses the shared PageLoader primitive from the
  design system, instead of the one-off two-ring spinner this file used to carry.
  The gate itself is unchanged: while Firebase resolves, show a loader; with no
  session, redirect to /login; otherwise render the protected children.
*/
const ProtectedRoute = ({ children }) => {
    const [user, loading] = useAuthState(auth);

    if (loading) {
        return <PageLoader label="Please wait while we get you going" />;
    }

    if (!user) return <Navigate to="/login" />;

    return children;
};

export default ProtectedRoute;
