import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { auth } from '../firebase';
import { Search, User, Menu, X, Home, LogOut, ChevronDown, ClipboardList, FileText, CreditCard } from 'lucide-react';
import MessagesNavLink from './MessagesNavLink';
import Button from './ui/Button';
import { isNavPathActive } from './navRouteActive';
import { useUserQuery } from '../useUserQuery';

/*
  STAGE 11.1: AppNavbar -- the one shared application shell for both roles.

  This file is the Stage 6x/10x `EmployerNavbar.jsx` renamed and reorganised. The
  audit found the employee dashboard rendering a component called "EmployerNavbar",
  which was confusing but, importantly, already the SINGLE implementation: no page
  mounted the old Navbar.jsx any more. So the fix is not to merge two navbars -- it
  is to give the one live navbar an honest name and a shared, token-based look.

  WHAT IS UNCHANGED (and must stay unchanged):
    * The two role-dependent destination sets and every href in them.
    * handleSignOut: `auth.signOut()` then navigate('/login') -- the working sign-out.
    * MessagesNavLink, which owns the unread poll at 15000ms.
    * The `roleKnown` gate that prevents the employer set flashing before the
      caller's user document (and therefore `role`) has loaded.

  WHAT THIS STAGE CHANGES: the visual layer (flat surfaces and design tokens
  instead of gradients), the semantics (a <header> landmark wrapping the <nav>), and
  accessibility (aria-labels, aria-expanded/haspopup on the menus, and keyboard
  focus rings).     No route, request, role rule or piece of behaviour changes.
*/

/*
    Phases 1-2 of the data-fetching audit replace the module-level identity
    cache this component used to keep (navIdentityUid/navIdentity/navIdentityPromise)
    with the app-wide identity query, useUserQuery. Why this is better here:
      * One request and one cached document, shared with RoleBasedDashboard and
        the dashboards -- /dashboard used to fetch the same document twice,
        once in the router page and once again in the child it rendered.
      * Profile saves (Profile.jsx, completeProfile.jsx) invalidate the query
        key, so the navbar's chip and role can no longer go stale for the rest
        of the session the way the module cache did.
    The visible behaviour is unchanged: a failed read is a read that yields no
    document (reduced link set, no wrong role's links), and the navbar still
    makes the read only when the caller did not pass a `role` of its own.
*/
const AppNavbar = ({ user }) => {
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
    const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
    // STAGE 6I: the `const [notifications] = useState(3)` state is gone. It was a
    // hardcoded count, so the navbar permanently showed a red "3" to every employer
    // that could never be read, clicked or dismissed -- there is no notifications
    // feature behind it anywhere in the codebase. Presenting a fabricated number as
    // real state is worse than showing nothing.
    const navigate = useNavigate();
    const location = useLocation();
    const profileButtonRef = useRef(null);
    const mobileMenuButtonRef = useRef(null);

    useEffect(() => {
        setIsProfileDropdownOpen(false);
        setIsMobileMenuOpen(false);
    }, [location.pathname]);

    useEffect(() => {
        if (!isProfileDropdownOpen && !isMobileMenuOpen) return undefined;

        const handleKeyDown = (event) => {
            if (event.key !== 'Escape') return;

            const profileWasOpen = isProfileDropdownOpen;
            setIsProfileDropdownOpen(false);
            setIsMobileMenuOpen(false);

            if (profileWasOpen) {
                profileButtonRef.current?.focus();
            } else {
                mobileMenuButtonRef.current?.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [isMobileMenuOpen, isProfileDropdownOpen]);

    // STAGE 6H. Sign out signs out of Firebase Auth, then goes to the existing login
    // route. It is the mechanism the rest of the app uses. No new auth system is
    // introduced.
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

    /*
        STAGE 10D: is the person reading this navbar an employee?

        The role is still read from the caller's `user` when the caller passes a whole
        document (EmployeeDashboard, EmployerDashboard, MyJobs, PostJobForm,
        JobDetails and the employer workspace pages do, via `setUser(res.data.user)`),
        and only the exact string 'employee' counts -- the value RoleBasedDashboard
        compares against. Pages that pass an auth-session user with no `role` are
        completed by the shared identity query below, instead of every one of them
        adding that read itself.
    */
    const callerRole = typeof user?.role === 'string' ? user.role : '';

    /*
        The navbar's read of the CALLER'S user document, now useUserQuery (see the
        note above the component). Several pages (My Applications, My Jobs, the
        workspaces, Messages, ViewJobApplications) deliberately hand this component
        an auth-session user carrying no `role`, so the role-gated entries below
        would collapse to Dashboard/Profile on exactly those pages; the query fills
        that in, from the same cache the dashboards use.

        `enabled` reproduces the old effect's guard exactly: no read at all when
        the caller already supplied a role, and no request without a session.
        ProtectedRoute has always resolved the session before any page mounting
        this navbar renders, so the uid is available on the first run.
    */
    const uid = auth.currentUser ? auth.currentUser.uid : '';
    const { data: identityDoc } = useUserQuery(uid, {
        enabled: !callerRole && Boolean(uid),
    });

    const identityRole =
        identityDoc && typeof identityDoc.role === 'string' ? identityDoc.role : '';
    const role = callerRole || identityRole;
    const isEmployee = role === 'employee';

    // The profile chip's identity: the caller's values win whenever they have one,
    // and the navbar's own read fills the auth-session pages where displayName alone
    // can leave the avatar empty.
    const fullName = (user && user.fullName) || (identityDoc && identityDoc.fullName) || '';
    const email = (user && user.email) || (identityDoc && identityDoc.email) || '';

    /*
        STAGE 10F.1: is the role actually known yet?

        On document-passing pages `user` starts as `{}` and only gains a `role` after
        their own `GET /users/getUser/:uid` resolves. On auth-session pages it never
        carries one, and the navbar's cached read supplies it. `roleKnown` is
        therefore exactly "a role has arrived from one of the two sources".

        FAILING CLOSED. If neither source produces a role, `roleKnown` stays false,
        so NEITHER role's entry list renders -- the navbar shows Dashboard, Profile,
        the messages icon and sign-out, and no wrong "My Jobs".
    */
    const roleKnown = role.length > 0;

    /*
        STAGE 10D: the employee's two destinations, and the employer's one.

        An employee's "My Jobs" is /employee/hired-jobs (the work they were hired for,
        HiredJobs.jsx) and NOT /my-jobs: /my-jobs is this app's name for jobs you
        POSTED, so reusing the entry for an applicant would send them to an empty page
        that looks like data loss. The two entries share a label and deliberately do
        not share a destination.

        THE EMPLOYER'S SET IS UNCHANGED. Same entry, same order, same href, same icon,
        and 'My Jobs' still means /my-jobs.

        ACTIVE STATE IS DERIVED FROM THE ROUTE. `current` used to be hardcoded
        (`true` on Dashboard everywhere, `false` on everything else), which kept
        Dashboard highlighted on every page of the app. It is now computed from the
        current location through isNavPathActive, so exactly one link -- the one for
        the page actually open -- is highlighted, and only /dashboard lights up
        Dashboard.
    */
    const navigationItems = [
        { name: 'Dashboard', href: '/dashboard', icon: Home },
        ...(roleKnown
            ? isEmployee
                ? [
                    // STAGE 10D. The applicant's two pages, in the order they are used:
                    // what they applied for, then the work they were hired for.
                    { name: 'My Applications', href: '/my-applications', icon: FileText },
                    { name: 'My Jobs', href: '/employee/hired-jobs', icon: ClipboardList },
                ]
                : [
                    // STAGE 10D. The employer's one destination: the jobs he POSTED.
                    { name: 'My Jobs', href: '/my-jobs', icon: ClipboardList },
                ]
            : []),
        // Payments is shared by both roles. The page is the same view for an
        // employer and an employee; GET /payments/history decides ownership.
        { name: 'Payments', href: '/payments', icon: CreditCard },
        // STAGE 10D. This entry stays outside the role branch above, because Profile
        // is the one destination both roles genuinely share.
        { name: 'Profile', href: '/profile', icon: User },
    ].map((item) => ({ ...item, current: isNavPathActive(location.pathname, item.href) }));

    const profileMenuItems = [
        { name: 'View Profile', href: '/profile', icon: User },
        // STAGE 6H: this entry is an action, not a destination, so it renders as a
        // <button> wired to handleSignOut rather than an <a>.
        { name: 'Sign out', icon: LogOut, onClick: handleSignOut },
    ];

    const toggleMobileMenu = () => {
        setIsMobileMenuOpen((prev) => !prev);
        setIsProfileDropdownOpen(false);
    };

    const toggleProfileDropdown = () => {
        setIsProfileDropdownOpen((prev) => !prev);
        setIsMobileMenuOpen(false);
    };

    // One shared class string for the link rows, so the desktop rail, the mobile
    // list and their active states cannot drift apart.
    const navLinkClasses = (isCurrent, size = 'sm') =>
        `flex items-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
            size === 'sm' ? 'px-3 py-2 text-sm' : 'px-3 py-2 text-base'
        } ${
            isCurrent
                ? 'bg-accent-subtle text-accent-subtle-foreground'
                : 'text-foreground-muted hover:bg-surface-muted hover:text-foreground'
        }`;

    const menuItemClasses =
        'flex items-center gap-2 px-4 py-2 text-sm text-foreground-muted hover:bg-surface-muted hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';

    return (
        <header className="sticky top-0 z-50 border-b border-border bg-surface">
            <nav aria-label="Primary" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
                <div className="flex h-16 items-center justify-between gap-4">
                    {/* Logo Section */}
                    <Link
                        to="/"
                        className="flex items-center gap-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                    >
                        <img
                            src="/image.png"
                            alt=""
                            className="h-6 w-6 object-contain"
                            onError={(e) => {
                                // Fallback if the image fails to load: hide it and let
                                // the wordmark below stand in.
                                e.currentTarget.style.display = 'none';
                            }}
                        />
                        <span className="text-xl font-semibold tracking-tight text-foreground">
                            Kachploy
                        </span>
                    </Link>

                    {/* Desktop Navigation */}
                    {/* STAGE 6P. All internal links are React Router <Link> rather than
                        <a href>, so navigation does not tear down the document. <Link>
                        renders an <a href> underneath, so the markup and
                        right-click/open-in-new-tab behaviour are unchanged. */}
                    <div className="hidden lg:flex items-center gap-1">
                        {navigationItems.map((item) => {
                            const Icon = item.icon;
                            return (
                                <Link
                                    key={item.name}
                                    to={item.href}
                                    aria-current={item.current ? 'page' : undefined}
                                    className={navLinkClasses(item.current)}
                                >
                                    <Icon className="h-4 w-4" aria-hidden="true" />
                                    <span>{item.name}</span>
                                </Link>
                            );
                        })}
                    </div>

                    {/* Right Section */}
                    <div className="flex items-center gap-2">
                        {/* Search Bar - Hidden below extra-large, where the
                            role links plus the search field would overflow. */}
                        <div className="hidden xl:block relative">
                            <Search
                                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle"
                                aria-hidden="true"
                            />
                            <input
                                type="text"
                                placeholder="Search jobs..."
                                aria-label="Search jobs"
                                className="w-64 rounded-md border border-border-strong bg-surface py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                            />
                        </div>

                        {/* Messages, with the real unread count (MessagesNavLink). */}
                        <MessagesNavLink />

                        {/* Profile Dropdown */}
                        <div className="relative">
                            <button
                                ref={profileButtonRef}
                                type="button"
                                onClick={toggleProfileDropdown}
                                aria-haspopup="menu"
                                aria-expanded={isProfileDropdownOpen}
                                aria-controls="account-menu"
                                className="flex items-center gap-2 rounded-md p-1.5 text-foreground-muted transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                            >
                                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-sm font-semibold text-foreground-inverse">
                                    {getInitials(fullName)}
                                </span>
                                <ChevronDown className="hidden h-4 w-4 sm:block" aria-hidden="true" />
                                <span className="sr-only">Open account menu</span>
                            </button>

                            {/* Profile Dropdown Menu */}
                            {isProfileDropdownOpen && (
                                <div
                                    id="account-menu"
                                    role="menu"
                                    aria-label="Account menu"
                                    className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-lg border border-border bg-surface py-1 shadow-raised"
                                >
                                    <div className="border-b border-border px-4 py-2">
                                        <p className="truncate text-sm font-medium text-foreground">
                                            {fullName}
                                        </p>
                                        <p className="truncate text-sm text-foreground-subtle">
                                            {email}
                                        </p>
                                    </div>
                                    {profileMenuItems.map((item) => {
                                        const Icon = item.icon;

                                        // STAGE 6H: an entry with an onClick is an action,
                                        // not a destination, so it renders as a button.
                                        if (item.onClick) {
                                            return (
                                                <button
                                                    key={item.name}
                                                    type="button"
                                                    role="menuitem"
                                                    onClick={item.onClick}
                                                    className={`${menuItemClasses} w-full text-left`}
                                                >
                                                    <Icon className="h-4 w-4" aria-hidden="true" />
                                                    <span>{item.name}</span>
                                                </button>
                                            );
                                        }

                                        return (
                                            <Link
                                                key={item.name}
                                                to={item.href}
                                                role="menuitem"
                                                className={menuItemClasses}
                                            >
                                                <Icon className="h-4 w-4" aria-hidden="true" />
                                                <span>{item.name}</span>
                                            </Link>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Mobile Menu Button */}
                        <div className="lg:hidden">
                            <Button
                                ref={mobileMenuButtonRef}
                                variant="ghost"
                                size="icon"
                                onClick={toggleMobileMenu}
                                aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
                                aria-expanded={isMobileMenuOpen}
                                aria-controls="app-mobile-menu"
                            >
                                {isMobileMenuOpen ? (
                                    <X className="h-6 w-6" aria-hidden="true" />
                                ) : (
                                    <Menu className="h-6 w-6" aria-hidden="true" />
                                )}
                            </Button>
                        </div>
                    </div>
                </div>

                {/* Mobile Menu */}
                {isMobileMenuOpen && (
                    <div id="app-mobile-menu" className="relative z-[45] border-t border-border bg-surface lg:hidden">
                        <div className="space-y-1 px-2 pb-3 pt-2">
                            {/* Mobile Search */}
                            <div className="px-3 py-2">
                                <div className="relative">
                                    <Search
                                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-subtle"
                                        aria-hidden="true"
                                    />
                                    <input
                                        type="text"
                                        placeholder="Search jobs..."
                                        aria-label="Search jobs"
                                        className="w-full rounded-md border border-border-strong bg-surface py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-foreground-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
                                    />
                                </div>
                            </div>

                            {/* Mobile Navigation Items */}
                            {/* STAGE 6P. The mobile links close the menu on click, because
                                <Link> navigates without reloading and would otherwise leave
                                the menu open on top of the page just requested. */}
                            {navigationItems.map((item) => {
                                const Icon = item.icon;
                                return (
                                    <Link
                                        key={item.name}
                                        to={item.href}
                                        onClick={() => setIsMobileMenuOpen(false)}
                                        aria-current={item.current ? 'page' : undefined}
                                        className={navLinkClasses(item.current, 'base')}
                                    >
                                        <Icon className="h-5 w-5" aria-hidden="true" />
                                        <span>{item.name}</span>
                                    </Link>
                                );
                            })}

                            {/* Mobile Profile Section */}
                            <div className="mt-4 border-t border-border pt-4">
                                <div className="flex items-center px-3 py-2">
                                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent font-semibold text-foreground-inverse">
                                        {getInitials(fullName)}
                                    </span>
                                    <div className="ml-3 min-w-0">
                                        {/* STAGE 6H: read the resolved identity, with 'Not set'
                                            as the fallback for a value not yet loaded. */}
                                        <p className="truncate text-base font-medium text-foreground">
                                            {fullName || 'Not set'}
                                        </p>
                                        <p className="truncate text-sm text-foreground-subtle">
                                            {email || 'Not set'}
                                        </p>
                                    </div>
                                </div>
                                {profileMenuItems.map((item) => {
                                    const Icon = item.icon;
                                    const itemClass = `${menuItemClasses} text-base`;

                                    // STAGE 6H: the mobile copy of the same conditional as
                                    // the desktop dropdown, so Sign out is a button in both.
                                    if (item.onClick) {
                                        return (
                                            <button
                                                key={item.name}
                                                type="button"
                                                onClick={item.onClick}
                                                className={`${itemClass} w-full text-left`}
                                            >
                                                <Icon className="h-5 w-5" aria-hidden="true" />
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
                                            <Icon className="h-5 w-5" aria-hidden="true" />
                                            <span>{item.name}</span>
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}
            </nav>

            {/* Overlay for dropdowns */}
            {(isProfileDropdownOpen || isMobileMenuOpen) && (
                <div
                    className="fixed inset-0 z-40"
                    aria-hidden="true"
                    onClick={() => {
                        setIsProfileDropdownOpen(false);
                        setIsMobileMenuOpen(false);
                    }}
                />
            )}
        </header>
    );
};

export default AppNavbar;
