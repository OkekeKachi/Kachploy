import React from 'react';
import { Link } from 'react-router-dom';
import MarketingNavbar from '../components/marketing/MarketingNavbar';
import MarketingFooter from '../components/marketing/MarketingFooter';

const NotFound = () => (
  <main className="min-h-screen bg-canvas text-foreground">
    <MarketingNavbar />

    <section className="mx-auto flex min-h-[60vh] max-w-3xl flex-col items-center justify-center px-4 py-24 text-center sm:px-6 lg:px-8">
      <p className="text-sm font-semibold uppercase tracking-[0.22em] text-accent">
        404
      </p>
      <h1 className="mt-4 text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
        Page not found
      </h1>
      <p className="mt-5 max-w-xl text-lg leading-relaxed text-foreground-muted">
        The page you are looking for does not exist or may have moved.
      </p>
      <Link
        to="/"
        className="mt-8 inline-flex h-11 items-center justify-center rounded-md bg-accent px-5 text-base font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        Back to homepage
      </Link>
    </section>

    <MarketingFooter />
  </main>
);

export default NotFound;
