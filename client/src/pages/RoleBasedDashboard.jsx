import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase'; // Assuming you're using Firebase for authentication
import axios from 'axios';
import EmployerDashboard from './EmployerDashboard';  // Make sure to import these components
import EmployeeDashboard from './EmployeeDashboard';

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
    const [role, setRole] = useState(null);
    const navigate = useNavigate();

    useEffect(() => {
        const fetchRole = async () => {
            // Get current user UID from Firebase authentication
            const user = auth.currentUser;

            if (!user) {
                // If no user is authenticated, navigate to login
                navigate('/login');
                return;
            }

            try {
                // Fetch user role from the backend
                const response = await axios.get(`http://localhost:3000/users/getUser/${user.uid}`);
                const userRole = response.data.user.role;

                setRole(userRole); // Set the role in the state
            } catch (error) {
                console.error('Error fetching role:', error);
                // Handle error appropriately
            }
        };

        fetchRole();
    }, [navigate]);  // Only run this effect on mount (initial render)

    if (role === null) {
        return (
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
    }

    if (role === 'employer') {
        return <EmployerDashboard />;
    } else if (role === 'employee') {
        return <EmployeeDashboard />;
    }

    return <div>Unauthorized</div>; // In case the role doesn't match anything
};

export default RoleBasedDashboard;
