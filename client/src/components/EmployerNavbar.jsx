import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import { Search, Bell, User, Menu, X, Home, LogOut, ChevronDown, ClipboardList } from 'lucide-react';

const EmployerNavbar = ({ user }) => {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
    // STAGE 6I: the `const [notifications] = useState(3)` state is gone. It was a
    // hardcoded count, so the navbar permanently showed a red "3" to every employer
    // that could never be read, clicked or dismissed -- there is no notifications
    // feature behind it anywhere in the codebase. Presenting a fabricated number as
    // real state is worse than showing nothing.
    const navigate = useNavigate();

    // STAGE 6H. "Sign out" used to be a profileMenuItems entry with
    // `href: '/logout'`, and there is no /logout route -- so it rendered as an
    // anchor that navigated away and left the Firebase session completely intact.
    // This navbar therefore had no working sign-out.
    //
    // This is the mechanism the rest of the app uses, taken from Navbar.jsx, which
    // is the only complete implementation of the three in the codebase: sign out of
    // Firebase Auth, then go to the existing login route. The other two are
    // Dashboard.jsx (`signOut().then(...)`, a dead file) and EmployeeDashboard.jsx,
    // whose handler is a stub that navigates to /login without ever calling
    // auth.signOut(). No new auth system is introduced.
    const handleSignOut = async () => {
        try {
            await auth.signOut();
            // Close whichever menu the click came from, since the page it lives on
            // is about to unmount.
            setIsProfileDropdownOpen(false);
            setIsMobileMenuOpen(false);
            navigate('/login');
        } catch (error) {
            console.error('Logout error:', error);
        }
    };

    const getInitials = (fullName) => {
        if (!fullName) return '';

        const names = fullName.split(' ');
        const firstInitial = names[0]?.charAt(0) || '';
        const lastInitial = names[1]?.charAt(0) || '';        
        
        return (firstInitial + lastInitial).toUpperCase();
        
        
      };

    const navigationItems = [
        { name: 'Dashboard', href: '/dashboard', icon: Home, current: true },
        // STAGE 6G. Added so the employer job list this navbar sits above is
        // actually reachable. The two /my-jobs links that existed lived in
        // Navbar.jsx, which no page ever renders -- both of its call sites are
        // commented out -- so the page added in Stage 6E had no live navigation to
        // it. Same entry shape as its neighbours, so it renders through the
        // existing desktop and mobile maps with no markup change.
        { name: 'My Jobs', href: '/my-jobs', icon: ClipboardList, current: false },
        // STAGE 6P. "Find Jobs" (/jobs) and "Applications" (/applications) are
        // removed here. Neither path is a route in App.jsx, so both were dead
        // destinations that only worked as full-page-reloading <a href> anchors --
        // and even then they landed on nothing. The useful employer journeys this
        // navbar should expose, /my-jobs and /profile, were already the two entries
        // surrounding them (Stages 6G and 6D), so the dead pair is dropped rather
        // than repointed, which would have produced duplicate links to the same
        // two pages. The offering is now exactly Dashboard, My Jobs and Profile.
        { name: 'Profile', href: '/profile', icon: User, current: false },
    ];

    const profileMenuItems = [
        { name: 'View Profile', href: '/profile', icon: User },
        // STAGE 6P. The { name: 'Settings', href: '/settings' } entry is gone.
        // /settings has no route in App.jsx and no page component, so it was a
        // dead destination like the two navigationItems removed above -- the only
        // difference being that it lived in this dropdown. There is nothing to
        // repoint it at and this stage may not add routes, so it is removed.
        // STAGE 6H: was `{ name: 'Sign out', href: '/logout', icon: LogOut }`. The
        // href is gone, and the two profileMenuItems maps below render this entry
        // as a <button> wired to handleSignOut rather than an <a>.
        { name: 'Sign out', icon: LogOut, onClick: handleSignOut },
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
                    {/* STAGE 6P. All four internal links in this file are now React
                        Router <Link to={item.href}> rather than <a href={item.href}>.
                        Every one of these hrefs is an in-app path, and a plain anchor
                        makes the browser tear down the whole document and refetch the
                        bundle, losing client state and auth context on each click.
                        <Link> renders an <a href> in the DOM underneath, so the markup,
                        styling and right-click/open-in-new-tab behaviour are unchanged;
                        only the navigation mechanism differs. Sign out is untouched and
                        still renders as a <button> via the onClick branch. */}
                    <div className="hidden md:flex items-center space-x-8">
                        {navigationItems.map((item) => {
                            const Icon = item.icon;
                            return (
                                <Link
                                    key={item.name}
                                    to={item.href}
                                    className={`flex items-center space-x-2 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-200 ${item.current
                                            ? 'bg-blue-50 text-blue-700 border border-blue-100'
                                            : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                        }`}
                                >
                                    <Icon className="w-4 h-4" />
                                    <span>{item.name}</span>
                                </Link>
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
                        {/* STAGE 6I: the red badge and its count are removed. The
                            `relative` class on the button went with it -- it existed only
                            to anchor the badge's absolute positioning, and the wrapping
                            div keeps its own `relative` for the profile dropdown beside
                            it. The Bell control itself is deliberately left in place to
                            keep the navbar layout unchanged; see the note in the report,
                            because it has no handler and so is still inert. */}
                        <div className="relative">
                            <button className="p-2 text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors duration-200">
                                <Bell className="w-5 h-5" />
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
                                        const itemClass = "flex items-center space-x-2 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors duration-200";

                                        // STAGE 6H: an entry with an onClick is an action,
                                        // not a destination, so it renders as a button.
                                        // The class string is the anchor's own styling, plus
                                        // w-full text-left so a button lines up with the
                                        // links above it.
                                        if (item.onClick) {
                                            return (
                                                <button
                                                    key={item.name}
                                                    type="button"
                                                    onClick={item.onClick}
                                                    className={`${itemClass} w-full text-left`}
                                                >
                                                    <Icon className="w-4 h-4" />
                                                    <span>{item.name}</span>
                                                </button>
                                            );
                                        }

                                        return (
                                            <Link
                                                key={item.name}
                                                to={item.href}
                                                className={itemClass}
                                            >
                                                <Icon className="w-4 h-4" />
                                                <span>{item.name}</span>
                                            </Link>
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
                            {/* STAGE 6P. The two mobile links now close the menu on click.
                                The old anchors did this implicitly, because the full
                                page reload they triggered unmounted the whole navbar.
                                <Link> navigates without reloading, so without an explicit
                                close the menu would stay open on top of the page the
                                employer just asked for. */}
                            {navigationItems.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <Link
                                        key={item.name}
                                        to={item.href}
                                        onClick={() => setIsMobileMenuOpen(false)}
                                        className={`flex items-center space-x-3 px-3 py-2 rounded-lg text-base font-medium transition-all duration-200 ${item.current
                                                ? 'bg-blue-50 text-blue-700 border border-blue-100'
                                                : 'text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                                            }`}
                                    >
                                        <Icon className="w-5 h-5" />
                                        <span>{item.name}</span>
                                    </Link>
                                );
                            })}

                            {/* Mobile Profile Section */}
                            <div className="border-t border-gray-200 pt-4 mt-4">
                                <div className="flex items-center px-3 py-2">
                                    <div className="w-10 h-10 bg-gradient-to-br from-blue-400 to-purple-500 rounded-full flex items-center justify-center">
                                        {/* STAGE 6H: was a hardcoded `JD`. Now the same
                                            getInitials(user.fullName) the desktop avatar
                                            uses, so both menus show the same person. */}
                                        <span className="text-white font-semibold">
                                            {getInitials(user?.fullName)}
                                        </span>
                                    </div>
                                    <div className="ml-3">
                                        {/* STAGE 6H: were hardcoded 'John Doe' and
                                            'john@example.com', so every employer saw the
                                            same fake identity in the mobile menu while the
                                            desktop dropdown showed their real one. Both now
                                            read the `user` prop, as the desktop dropdown
                                            does, with 'Not set' as the fallback for a value
                                            the document has not got yet. */}
                                        <p className="text-base font-medium text-gray-900">
                                            {user?.fullName || 'Not set'}
                                        </p>
                                        <p className="text-sm text-gray-500">
                                            {user?.email || 'Not set'}
                                        </p>
                                    </div>
                                </div>
{profileMenuItems.map((item) => {
                                        const Icon = item.icon;
                                        const itemClass = "flex items-center space-x-3 px-3 py-2 text-base text-gray-600 hover:text-gray-900 hover:bg-gray-50 rounded-lg transition-colors duration-200";

                                        // STAGE 6H: the mobile copy of the same conditional
                                        // as the desktop dropdown above, so Sign out is a
                                        // button in both menus.
                                        if (item.onClick) {
                                            return (
                                                <button
                                                    key={item.name}
                                                    type="button"
                                                    onClick={item.onClick}
                                                    className={`${itemClass} w-full text-left`}
                                                >
                                                    <Icon className="w-5 h-5" />
                                                    <span>{item.name}</span>
                                                </button>
                                            );
                                        }

                                        return (
                                            <Link
                                                key={item.name}
                                                to={item.href}
                                                onClick={() => {
                                                    setIsProfileDropdownOpen(false);
                                                    setIsMobileMenuOpen(false);
                                                }}
                                                className={itemClass}
                                            >
                                                <Icon className="w-5 h-5" />
                                                <span>{item.name}</span>
                                            </Link>
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