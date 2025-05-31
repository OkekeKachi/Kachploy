import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import { Search, Menu, X, ChevronDown } from 'lucide-react';

const Navbar = ({ user }) => {
    
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const navigate = useNavigate();

    const toggleMobileMenu = () => {
        setIsMobileMenuOpen(prev => !prev);
    };

    const toggleDropdown = () => {
        setIsDropdownOpen(prev => !prev);
    };

    const handleLogout = async () => {
        try {
            await auth.signOut();
            navigate('/login');
        } catch (error) {
            console.error('Logout error:', error);
        }
    };

    return (
        <nav className="bg-gray shadow-sm">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex justify-between h-16">
                    {/* Left: Logo and Links */}
                    <div className="flex items-center">
                        <div className="flex-shrink-0 flex items-center">
                            <img src="/image.png" alt="Logo" className="h-5 w-5" />
                            <span className="ml-2 text-xl font-semibold">KachPloy</span>
                        </div>
                        <div className="hidden md:ml-6 md:flex md:space-x-4">
                            <Link to="/my-applications" className="px-3 py-2 text-sm text-gray-900 hover:text-gray-600">
                                My Applications
                            </Link>
                            <Link to="/profile" className="px-3 py-2 text-sm text-gray-900 hover:text-gray-600">
                                Profile
                            </Link>
                            <Link to="/my-jobs" className="px-3 py-2 text-sm text-gray-900 hover:text-gray-600">
                                My Jobs
                            </Link>
                        </div>
                    </div>

                    {/* Center: Search */}
                    <div className="hidden md:flex items-center">
                        <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                <Search className="h-4 w-4 text-gray-500" />
                            </div>
                            <input
                                type="text"
                                placeholder="Search for jobs"
                                className="block w-80 pl-10 pr-3 py-1.5 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                            />
                        </div>
                    </div>

                    {/* Right: Profile */}
                    <div className="hidden md:flex items-center">
                        <div className="relative">
                            <button
                                onClick={toggleDropdown}
                                className="flex items-center space-x-2 focus:outline-none"
                            >
                                {user?.profilePic && (
                                    <img
                                        className="h-8 w-8 rounded-full object-cover"
                                        src={user.profilePic}
                                        alt="Profile"
                                    />
                                )}
                                <ChevronDown className="h-4 w-4 text-gray-600" />
                            </button>

                            {/* Dropdown Menu */}
                            {isDropdownOpen && (
                                <div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg py-1 z-50">
                                    <Link to="/profile" className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">
                                        Edit Profile
                                    </Link>
                                    <div className="border-t border-gray-100"></div>
                                    <button
                                        onClick={handleLogout}
                                        className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                                    >
                                        Logout
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Mobile menu button */}
                    <div className="flex items-center md:hidden">
                        <button
                            onClick={toggleMobileMenu}
                            className="inline-flex items-center justify-center p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 focus:outline-none"
                        >
                            {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
                        </button>
                    </div>
                </div>
            </div>

            {/* Mobile menu */}
            {isMobileMenuOpen && (
                <div className="md:hidden">
                    <div className="pt-2 pb-3 space-y-1">
                        <div className="px-4 py-3 border-b border-gray-200">
                            <div className="flex items-center space-x-3">
                                {user?.profilePic && (
                                    <img
                                        className="h-10 w-10 rounded-full object-cover"
                                        src={user.profilePic}
                                        alt="Profile"
                                    />
                                )}
                                <div>
                                    <div className="font-medium text-gray-800">{user?.fullName || 'User'}</div>
                                    <div className="text-sm text-gray-500">{user?.email || 'user@example.com'}</div>
                                </div>
                            </div>
                        </div>
                        <Link to="/my-applications" className="block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100">
                            My Applications
                        </Link>
                        <Link to="/profile" className="block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100">
                            Profile
                        </Link>
                        <Link to="/my-jobs" className="block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100">
                            My Jobs
                        </Link>
                        <button
                            onClick={handleLogout}
                            className="w-full text-left block px-4 py-2 text-base font-medium text-gray-700 hover:bg-gray-100"
                        >
                            Logout
                        </button>
                    </div>
                    <div className="pt-4 pb-3 px-4">
                        <div className="relative">
                            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                                <Search className="h-4 w-4 text-gray-500" />
                            </div>
                            <input
                                type="text"
                                placeholder="Search for jobs"
                                className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                            />
                        </div>
                    </div>
                </div>
            )}
        </nav>
    );
};

export default Navbar;