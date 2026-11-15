import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import Button from '../ui/Button';
import BrandWordmark from '../BrandWordmark';
import useMarketingCta from '../../useMarketingCta';

const desktopItems = [
  { label: 'Home', to: '/' },
  { label: 'Find Work', to: '/find-work', cta: true },
  { label: 'Find Talent', to: '/find-talent', cta: true },
  { label: 'How It Works', to: '/how-it-works' },
  { label: 'About', to: '/about' },
  { label: 'Log In', to: '/login' },
];

const MarketingNavbar = () => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isNavScrolled, setIsNavScrolled] = useState(false);
  const location = useLocation();
  const goToDashboardOrLogin = useMarketingCta();

  useEffect(() => {
    const threshold = 12;
    let frame = 0;

    const updateNavState = () => {
      frame = 0;
      const nextScrolled = window.scrollY > threshold;
      setIsNavScrolled((prev) => (prev === nextScrolled ? prev : nextScrolled));
    };

    const handleScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateNavState);
    };

    updateNavState();
    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isMobileMenuOpen) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsMobileMenuOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMobileMenuOpen]);

  const navLinkClasses = (size = 'sm', onDark = false) =>
    `flex items-center gap-2 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 ${
      onDark ? 'focus-visible:ring-offset-[#0a0a0a]' : 'focus-visible:ring-offset-canvas'
    } ${size === 'sm' ? 'px-3 py-2 text-sm' : 'px-3 py-2 text-base'} ${
      onDark
        ? 'text-white/75 hover:bg-white/10 hover:text-white'
        : 'text-foreground-muted hover:bg-surface-muted hover:text-foreground'
    }`;

  const handleCtaClick = (event) => {
    event.preventDefault();
    setIsMobileMenuOpen(false);
    goToDashboardOrLogin();
  };

  const handleMobileNavigation = () => {
    setIsMobileMenuOpen(false);
  };

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-colors duration-300 ${
        isNavScrolled
          ? 'border-border bg-surface/95 backdrop-blur-sm'
          : 'border-transparent bg-[#0a0a0a]'
      }`}
    >
      <nav aria-label="Primary" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between gap-4">
          <Link
            to="/dashboard"
            className="flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            aria-label="Kachploy home"
          >
            <BrandWordmark
              size="md"
              tone={isNavScrolled ? 'light' : 'dark'}
              className="transition-colors"
            />
          </Link>

          <div className="hidden items-center gap-2 lg:flex">
            {desktopItems.map((item) =>
              item.cta ? (
                <Link
                  key={item.label}
                  to={item.to}
                  className={navLinkClasses('sm', !isNavScrolled)}
                  onClick={handleCtaClick}
                >
                  {item.label}
                </Link>
              ) : (
                <Link
                  key={item.label}
                  to={item.to}
                  className={navLinkClasses('sm', !isNavScrolled)}
                >
                  {item.label}
                </Link>
              ),
            )}
            <Link
              to="/get-started"
              className={navLinkClasses('sm', !isNavScrolled)}
              onClick={handleCtaClick}
            >
              Get Started
            </Link>
          </div>

          <div className="lg:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsMobileMenuOpen((open) => !open)}
              aria-label={isMobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={isMobileMenuOpen}
              aria-controls="marketing-mobile-menu"
              className={
                isNavScrolled
                  ? ''
                  : 'text-white! hover:bg-white/10! hover:text-white! focus-visible:ring-offset-[#0a0a0a]!'
              }
            >
              {isMobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </Button>
          </div>
        </div>

        {isMobileMenuOpen && (
          <div
            id="marketing-mobile-menu"
            className={`border-t lg:hidden ${
              isNavScrolled
                ? 'border-border bg-surface'
                : 'border-white/10 bg-[#0a0a0a]'
            }`}
          >
            <div className="space-y-1 px-2 pb-4 pt-2">
              {desktopItems.map((item) =>
                item.cta ? (
                  <Link
                    key={item.label}
                    to={item.to}
                    className={navLinkClasses('base', !isNavScrolled)}
                    onClick={handleCtaClick}
                  >
                    {item.label}
                  </Link>
                ) : (
                  <Link
                    key={item.label}
                    to={item.to}
                    className={navLinkClasses('base', !isNavScrolled)}
                    onClick={handleMobileNavigation}
                  >
                    {item.label}
                  </Link>
                ),
              )}
              <div
                className={`mt-3 border-t px-3 pt-3 ${
                  isNavScrolled ? 'border-border' : 'border-white/10'
                }`}
              >
                <Button
                  size="md"
                  className="w-full"
                  onClick={() => {
                    setIsMobileMenuOpen(false);
                    goToDashboardOrLogin();
                  }}
                >
                  Get Started
                </Button>
              </div>
            </div>
          </div>
        )}
      </nav>
    </header>
  );
};

export default MarketingNavbar;
