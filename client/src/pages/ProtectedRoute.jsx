import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '../firebase';

// Create a separate component
const ProtectedRoute = ({ children }) => {
    const [user, loading] = useAuthState(auth);
    if (loading) return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 to-gray-100 flex items-center justify-center">
            <div className="flex flex-col items-center space-y-4">
                {/* Main spinner */}
                <div className="relative">
                    <div className="animate-spin rounded-full h-16 w-16 border-4 border-gray-200"></div>
                    <div className="animate-spin rounded-full h-16 w-16 border-4 border-blue-600 border-t-transparent absolute top-0 left-0"></div>
                </div>

                {/* Loading text */}
                <div className="text-center">
                    <p className="text-gray-700 font-medium">Loading...</p>
                    <p className="text-gray-500 text-sm">Please wait while we get you going</p>
                </div>
            </div>
        </div>
    )  
    if (!user) return <Navigate to="/login" />;

    return children;
};

export default ProtectedRoute;
