import React from 'react';
import { Link } from 'react-router-dom';

const MarketingFooter = () => (
  <footer className="bg-black py-16">
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
      <div className="mb-12 grid gap-8 md:grid-cols-2">
        <div>
          <h3 className="mb-4 text-xl font-semibold text-white">Kachploy</h3>
          <p className="max-w-lg text-white/60">
            A freelance marketplace connecting employers with skilled professionals.
            Manage projects, milestone contracts, and payments all in one place.
          </p>
        </div>
        <nav aria-label="Company">
          <ul className="space-y-2 text-white/60">
            <li>
              <Link
                to="/how-it-works"
                className="inline-flex min-h-6 items-center transition-colors hover:text-white"
              >
                How It Works
              </Link>
            </li>
            <li>
              <Link
                to="/about"
                className="inline-flex min-h-6 items-center transition-colors hover:text-white"
              >
                About
              </Link>
            </li>
          </ul>
        </nav>
      </div>
      <div className="grid gap-6 border-t border-white/10 pt-8 md:grid-cols-3">
        <div>
          <h4 className="mb-3 font-medium text-white">Employer</h4>
          <ul className="space-y-2 text-white/60">
            <li>
              <Link
                to="/post-job"
                className="inline-flex min-h-6 items-center transition-colors hover:text-white"
              >
                Post a Job
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <h4 className="mb-3 font-medium text-white">Freelancer</h4>
          <ul className="space-y-2 text-white/60">
            <li>
              <Link
                to="/login"
                className="inline-flex min-h-6 items-center transition-colors hover:text-white"
              >
                Find Opportunities
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <h4 className="mb-3 font-medium text-white">Company</h4>
          <ul className="space-y-2 text-white/60">
            <li>
              <Link
                to="/about"
                className="inline-flex min-h-6 items-center transition-colors hover:text-white"
              >
                About
              </Link>
            </li>
            <li>
              <Link
                to="/how-it-works"
                className="inline-flex min-h-6 items-center transition-colors hover:text-white"
              >
                How It Works
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </div>
    <div className="mt-12 border-t border-white/10 pt-8 text-center">
      <p className="text-white/60">
        &copy; {new Date().getFullYear()} Kachploy. All rights reserved.
      </p>
    </div>
  </footer>
);

export default MarketingFooter;
