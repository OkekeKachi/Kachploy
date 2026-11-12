import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase'; // Assuming you're using Firebase for authentication
import EmployerDashboard from './EmployerDashboard';  // Make sure to import these components
import EmployeeDashboard from './EmployeeDashboard';
import { PageLoader } from '../components/ui/Spinner';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import { useUserQuery } from '../useUserQuery';
import { ShieldAlert } from 'lucide-react';

// const SkeletonJobLoader = () => {
//     return (
//         <div className="max-w-7xl bg-amber-950 mx-auto px-4 sm:px-6 lg:px-8 py-4">
//             {/* Custom Animation Styles */}
//             <style jsx>{`
//         @keyframes customPulse {
//           0% { opacity: 1; }
//           50% { opacity: 0.5; }
//           100% { opacity: 1; }
//         }
//         .animate-custom-pulse {
//           animation: customPulse 1.5s infinite;
//         }
//       `}</style>

//             {/* Navigation Bar Skeleton */}
//             <nav className="bg-white py-4">
//                 <div className="flex justify-between items-center">
//                     {/* Left Side: Logo and Navigation Links */}
//                     <div className="flex items-center space-x-5">
//                         {/* Logo Skeleton */}
//                         <div className="flex items-center">
//                             <div className="w-5 h-5 bg-gray-200 mr-2 rounded animate-custom-pulse"></div>
//                             <div className="w-20 h-5 bg-gray-200 rounded animate-custom-pulse"></div>
//                         </div>

//                         {/* Navigation Links Skeleton */}
//                         {['My Applications', 'Profile', 'My Jobs'].map((link, index) => (
//                             <div
//                                 key={link}
//                                 className={`w-24 h-4 bg-gray-200 rounded animate-custom-pulse ${index === 0 ? 'ml-5' : ''}`}
//                             ></div>
//                         ))}
//                     </div>

//                     {/* Right Side: Search and Profile */}
//                     <div className="flex items-center">
//                         {/* Search Bar Skeleton */}
//                         <div className="w-80 h-8 bg-gray-200 rounded-lg mr-6 animate-custom-pulse"></div>

//                         {/* Profile Dropdown Skeleton */}
//                         <div className="flex items-center mt-3">
//                             <div className="w-8 h-8 rounded-full bg-gray-200 mr-2 animate-custom-pulse"></div>
//                             <div className="w-5 h-5 bg-gray-200 rounded animate-custom-pulse"></div>
//                         </div>
//                     </div>

//                     {/* Mobile Menu Trigger Skeleton - Hidden on desktop, visible on mobile */}
//                     <div className="md:hidden">
//                         <div className="w-6 h-6 bg-gray-200 rounded animate-custom-pulse"></div>
//                     </div>
//                 </div>
//             </nav>

//             {/* Main Content Area */}
//             <div className="flex flex-col md:flex-row mt-8 space-y-8 md:space-y-0 md:space-x-8">
//                 {/* Left Column */}
//                 <div className="md:w-2/3">
//                     {/* Carousel/Banner Skeleton */}
//                     <div className="h-64 bg-gray-200 rounded-lg animate-custom-pulse ml-8"></div>

//                     {/* Search Bar Skeleton (Mobile) */}
//                     <div className=" h-8 bg-gray-200 rounded-lg mt-6 animate-custom-pulse  ml-8"></div>

//                     {/* Heading Skeleton */}
//                     <div className="h-8 w-48 bg-gray-200 rounded mt-8 animate-custom-pulse ml-8"></div>

//                     {/* Job Split View Skeleton */}
//                     <div className="flex flex-col md:flex-row mt-6 ml-10">
//                         {/* Left Job Panel */}
//                         <div className="w-full md:w-1/2 h-96 bg-gray-200 rounded-l-lg animate-custom-pulse max-w-md"></div>

//                         {/* Right Job Panel */}
//                         <div className="w-full md:w-1/2 h-96 bg-gray-200 rounded-r-lg animate-custom-pulse max-w-md"></div>
//                     </div>
//                 </div>

//                 {/* Right Column */}
//                 <div className="md:w-1/3 space-y-6">
//                     {/* Three Profile Sidebar Skeletons */}
//                     {[1, 2, 3].map((item) => (
//                         <div
//                             key={item}
//                             className="h-48 bg-gray-200 rounded-lg animate-custom-pulse mr-3"
//                         ></div>
//                     ))}
//                 </div>
//             </div>
//         </div>
//     );
// };

const RoleBasedDashboard = () => {
    const navigate = useNavigate();

    // Phases 1-2 of the data-fetching audit: this page's own GET /users/getUser/:uid
    // is now the shared identity query. It used to fetch the document here and then
    // render a dashboard that fetched the SAME document again on every /dashboard
    // visit; both reads are now one cache entry keyed by uid (see useUserQuery).
    // The redirect for a missing session is kept as its own effect, exactly as the
    // old fetchRole() did before it read the role.
    useEffect(() => {
        if (!auth.currentUser) {
            navigate('/login');
        }
    }, [navigate]);

    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const userQuery = useUserQuery(uid);

    // `role` is null until the document arrives -- which is the PageLoader gate
    // below, unchanged. A loaded document with no `role` yields undefined, so it
    // falls through to the Unauthorized screen exactly as the old
    // `setRole(response.data.user.role)` did. A failed read leaves the document
    // absent, so the loader keeps showing, same as the old catch-and-log path.
    const role = userQuery.data ? userQuery.data.role : null;

    if (role === null) {
        // STAGE 11.1: shared PageLoader primitive replaces the local spinner block.
        return <PageLoader label="Please wait while we get you going" />;
    }

    if (role === 'employer') {
        return <EmployerDashboard />;
    } else if (role === 'employee') {
        return <EmployeeDashboard />;
    }

    /*
        STAGE 11.17d: presentation-only polish for the fallback that renders when the
        fetched role is neither 'employer' nor 'employee'. It was a bare
        <div>Unauthorized</div>; it is now the shared EmptyState primitive on the
        design tokens, matching the rest of the app.

        The action reuses the same destination and mechanism this component already
        uses when there is no authenticated user (navigate('/login')): it adds a
        user-triggered way back, and changes none of the existing redirects,
        authorization logic or role routing above.
    */
    return (
        <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
            <div className="w-full max-w-md">
                <EmptyState
                    icon={ShieldAlert}
                    title="Unauthorized"
                    description="Your account doesn't have access to a dashboard. Try signing in again, or contact support if the problem continues."
                    action={
                        <Button onClick={() => navigate('/login')}>
                            Back to login
                        </Button>
                    }
                />
            </div>
        </div>
    ); // In case the role doesn't match anything
};

export default RoleBasedDashboard;
