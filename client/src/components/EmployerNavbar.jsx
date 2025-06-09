import React, { useState } from 'react';
import { Search, Bell, User, Menu, X, Home, Briefcase, Users, Settings, LogOut, ChevronDown } from 'lucide-react';

const EmployerNavbar = ({ user }) => {
    console.log(user)
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
    const [notifications] = useState(3); // Mock notification count

    const getInitials = (fullName) => {
        if (!fullName) return '';

        const names = fullName.split(' ');
        const firstInitial = names[0]?.charAt(0) || '';
        const lastInitial = names[1]?.charAt(0) || '';        
        
        return (firstInitial + lastInitial).toUpperCase();
        
        
      };

    const navigationItems = [
        { name: 'Dashboard', href: '/dashboard', icon: Home, current: true },
        { name: 'Find Jobs', href: '/jobs', icon: Briefcase, current: false },
        { name: 'Applications', href: '/applications', icon: Users, current: false },
        { name: 'Profile', href: '/profile', icon: User, current: false },
    ];

    const profileMenuItems = [
        { name: 'View Profile', href: '/profile', icon: User },
        { name: 'Settings', href: '/settings', icon: Settings },
        { name: 'Sign out', href: '/logout', icon: LogOut },
    ];

    const toggleMobileMenu = () => {
        setIsMobileMenuOpen(!isMobileMenuOpen);
    };

    const toggleProfileDropdown = () => {
        setIsProfileDropdownOpen(!isProfileDropdownOpen);
    };

    return (
        <nav className="bg-white shadow-lg border-b border-gray-100 sticky top-0 z-50">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                <div className="flex justify-between items-center h-16">
                    {/* Logo Section */}
                    <div className="flex items-center space-x-3">
                        <div className="flex items-center space-x-2">
                            <img
                                src="/image.png"
                                alt="Kachploy Logo"
                                className="h-6 w-6 object-contain"
                                onError={(e) => {
                                    // Fallback if image fails to load
                                    e.target.style.display = 'none';
                                    e.target.nextSibling.style.display = 'flex';
                                }}
                            />
                            {/* Fallback logo */}
                            {/* <div className="hidden h-8 w-8 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg items-center justify-center">
                                <span className="text-white font-bold text-sm">K</span>
                            </div> */}
                            <span className="text-xl font-bold text-gray-900">Kachploy</span>
                        </div>
                    </div>

                    {/* Desktop Navigation */}
                    <div className="hidden md:flex items-center space-x-8">
                        {navigationItems.map((item) => {
                            const Icon = item.icon;
                            return (
                                <a
                                    key={item.name}
                                    href={item.href}
                                    className={`flex items-center space-x-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${item.current
                                            ? 'bg-blue-50 text-blue-700 border border-blue-100'
                                            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                        }`}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span>{item.name}</span>
                                </a>
                            );
                        })}
                    </div>

                    {/* Right Section */}
                    <div className="flex items-center space-x-4">
                        {/* Search Bar - Hidden on mobile */}
                        <div className="hidden lg:block relative">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                                <input
                                    type="text"
                                    placeholder="Search jobs..."
                                    className="pl-10 pr-4 py-2 w-64 border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all duration-200"
                                />
                            </div>
                        </div>

                        {/* Notifications */}
                        <div className="relative">
                            <button className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors duration-200 relative">
                                <Bell className="w-5 h-5" />
                                {notifications > 0 && (
                                    <span className="absolute -top-1 -right-1 h-5 w-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center animate-pulse">
                                        {notifications}
                                    </span>
                                )}
                            </button>
                        </div>

                        {/* Profile Dropdown */}
                        <div className="relative">
                            <button
                                onClick={toggleProfileDropdown}
                                className="flex items-center space-x-2 p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors duration-200"
                            >
                                <div className="w-8 h-8 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center">
                                    <span className="text-white text-sm font-semibold">{getInitials(user.fullName)}</span>
                                </div>
                                <ChevronDown className="w-4 h-4 hidden sm:block" />
                            </button>

                            {/* Profile Dropdown Menu */}
                            {isProfileDropdownOpen && (
                                <div className="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border border-gray-100 py-1 z-50">
                                    <div className="px-4 py-2 border-b border-gray-100">
                                        <p className="text-sm font-medium text-gray-900">{user.fullName}</p>
                                        <p className="text-sm text-gray-500">{user.email}</p>
                                    </div>
                                    {profileMenuItems.map((item) => {
                                        const Icon = item.icon;
                                        return (
                                            <a
                                                key={item.name}
                                                href={item.href}
                                                className="flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-200"
                                            >
                                                <Icon className="w-4 h-4" />
                                                <span>{item.name}</span>
                                            </a>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Mobile Menu Button */}
                        <div className="md:hidden">
                            <button
                                onClick={toggleMobileMenu}
                                className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors duration-200"
                            >
                                {isMobileMenuOpen ? (
                                    <X className="w-6 h-6" />
                                ) : (
                                    <Menu className="w-6 h-6" />
                                )}
                            </button>
                        </div>
                    </div>
                </div>

                {/* Mobile Menu */}
                {isMobileMenuOpen && (
                    <div className="md:hidden border-t border-gray-100 bg-white">
                        <div className="px-2 pt-2 pb-3 space-y-1">
                            {/* Mobile Search */}
                            <div className="px-3 py-2">
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
                                    <input
                                        type="text"
                                        placeholder="Search jobs..."
                                        className="pl-10 pr-4 py-2 w-full border border-gray-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                                    />
                                </div>
                            </div>

                            {/* Mobile Navigation Items */}
                            {navigationItems.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <a
                                        key={item.name}
                                        href={item.href}
                                        className={`flex items-center space-x-3 px-3 py-2 rounded-lg text-base font-medium transition-all duration-200 ${item.current
                                                ? 'bg-blue-50 text-blue-700 border border-blue-100'
                                                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                            }`}
                                    >
                                        <Icon className="w-5 h-5" />
                                        <span>{item.name}</span>
                                    </a>
                                );
                            })}

                            {/* Mobile Profile Section */}
                            <div className="border-t border-gray-200 pt-4 mt-4">
                                <div className="flex items-center px-3 py-2">
                                    <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center">
                                        <span className="text-white font-semibold">JD</span>
                                    </div>
                                    <div className="ml-3">
                                        <p className="text-base font-medium text-gray-900">John Doe</p>
                                        <p className="text-sm text-gray-500">john@example.com</p>
                                    </div>
                                </div>
                                {profileMenuItems.map((item) => {
                                    const Icon = item.icon;
                                    return (
                                        <a
                                            key={item.name}
                                            href={item.href}
                                            className="flex items-center space-x-3 px-3 py-2 text-base text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors duration-200"
                                        >
                                            <Icon className="w-5 h-5" />
                                            <span>{item.name}</span>
                                        </a>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Overlay for dropdowns */}
            {(isProfileDropdownOpen || isMobileMenuOpen) && (
                <div
                    className="fixed inset-0 z-40"
                    onClick={() => {
                        setIsProfileDropdownOpen(false);
                        setIsMobileMenuOpen(false);
                    }}
                ></div>
            )}
        </nav>
    );
};

export default EmployerNavbar;