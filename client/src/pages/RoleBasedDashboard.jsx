import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth } from '../firebase'; // Assuming you're using Firebase for authentication
import axios from 'axios';
import EmployerDashboard from './EmployerDashboard';  // Make sure to import these components
import EmployeeDashboard from './EmployeeDashboard';

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
        return <div>Loading...</div>; // Show loading while role is being fetched
    }

    if (role === 'employer') {
        return <EmployerDashboard />;
    } else if (role === 'employee') {
        return <EmployeeDashboard />;
    }

    return <div>Unauthorized</div>; // In case the role doesn't match anything
};

export default RoleBasedDashboard;
