import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import Button from '../components/ui/Button';
import EmptyState from '../components/ui/EmptyState';
import MarketingNavbar from '../components/marketing/MarketingNavbar';
import MarketingFooter from '../components/marketing/MarketingFooter';
import { Home, Search, CheckCircle, Briefcase } from 'lucide-react';
import { useAuthState } from 'react-firebase-hooks/auth';
import { auth } from '../firebase';

const LandingPage = () => {
  const navigate = useNavigate();
  const [authUser, authLoading] = useAuthState(auth);

  // Role-aware CTA destination
  const ctaDestination = () => {
    if (authLoading) {
      // During initialization, navigate to login as safe default
      navigate('/login');
      return '/login';
    }
    if (!authUser) {
      navigate('/login');
      return '/login';
    }
    // Authenticated user — navigate to dashboard;
    // RoleBasedDashboard will render the correct view per role
    navigate('/dashboard');
    return '/dashboard';
  };

  // --- Featured Opportunities (real API data) ---
  const { data: jobs, isLoading, isError } = useQuery({
    queryKey: ['jobs'],
    queryFn: async () => {
      const res = await axios.get('/jobs', {
        params: { status: 'active' },
        timeout: 8000,
      });
      return res.data || [];
    },
    staleTime: 60000,
    cacheTime: 30000,
    refetchWindow: 30000,
    refetchOnWindowFocus: false,
    retry: (failureCount) => failureCount < 2,
  });

  return (
    <main className="min-h-screen bg-canvas text-foreground">
      <MarketingNavbar />

      {/* ----------------- Hero Section ----------------- */}
      <section className="relative overflow-hidden py-24 md:py-32 lg:py-40 bg-[#0a0a0a]">
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/hero-dark-background.jpg')" }}
          aria-hidden="true"
        />
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/70 via-black/45 to-[#0a0a0a]"
          aria-hidden="true"
        />
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white leading-tight">
                Great work starts with the right connection.
              </h1>
              <p className="mt-6 text-lg md:text-xl text-white/75 max-w-xl">
                Find skilled professionals, discover meaningful opportunities, and manage
                projects with confidence — all in one place.
              </p>
              <div className="mt-8 flex flex-wrap gap-4">
                <Button
                  variant="primary"
                  size="lg"
                  className="focus-visible:ring-offset-[#0a0a0a]!"
                  onClick={() => ctaDestination(true)}
                >
                  Find a Freelancer
                </Button>
                <Button
                  variant="ghost"
                  size="lg"
                  className="text-white! hover:bg-white/10! hover:text-white! focus-visible:ring-offset-[#0a0a0a]!"
                  onClick={() => ctaDestination(false)}
                >
                  Find Work
                </Button>
              </div>
            </div>
            <div>
              <div className="relative overflow-hidden rounded-lg border border-white/10 shadow-card">
                <img
                  src="/hero-showcase.jpg"
                  alt="Professional freelancer working on laptop with collaborative team in modern office"
                  className="w-full aspect-[3/2] object-cover saturate-[0.85]"
                />
                <div
                  className="absolute inset-0 bg-black/20 pointer-events-none"
                  aria-hidden="true"
                />
              </div>
              <div className="mt-6 rounded-lg border border-white/10 bg-white/5 p-6 flex items-center justify-center">
                <div className="text-center">
                  <h3 className="text-base font-medium text-white mb-3">
                    Pay your way
                  </h3>
                  <p className="text-sm text-white/75 mb-4">
                    Choose milestone-based payments for projects completed in stages, or
                    agree on one payment for the entire project. Milestones are optional,
                    not mandatory.
                  </p>
                  <div className="space-y-2 text-xs text-white/60">
                    <div>
                      <span className="font-medium text-indigo-300">Milestone-based</span>
                      — Divide a project into smaller stages and pay according to agreed
                      milestones.
                    </div>
                    <div>
                      <span className="font-medium text-indigo-300">One-time payment</span>
                      — Agree on the project and pay the freelancer in one payment.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------- Employer Section ----------------- */}
      <section className="py-20 md:py-24 bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
              Find the right people to bring your ideas to life.
            </h2>
          </div>
          <div className="prose max-w-none text-center">
            <p className="text-foreground-muted mb-6 max-w-xl mx-auto">
              Post opportunities that attract the right talent. Review applications,
              agree on clear contracts, and track work progress from submission to
              approval. Everything in one place — no scattered emails, no guesswork.
            </p>

            <Button
              variant="primary"
              size="md"
              onClick={() => ctaDestination(true)}
            >
              Find Talent
            </Button>
          </div>
        </div>
      </section>

      {/* ----------------- Freelancer Section ----------------- */}
      <section className="py-20 md:py-24 bg-canvas">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
                Turn your skills into meaningful opportunities.
              </h2>
              <p className="mt-6 text-lg md:text-xl text-foreground-muted max-w-xl">
                Discover opportunities that match your expertise. Apply under clear
                payment agreements, submit deliverables, and track payment progress —
                all while keeping 100% ownership of your work and profile. Payment
                terms can be milestone-based (for projects completed in stages) or
                one-time (for the entire project).
              </p>
              <Button
                variant="primary"
                size="md"
                onClick={() => ctaDestination(false)}
              >
                Explore Opportunities
              </Button>
            </div>
            <div className="relative">
              <div className="bg-surface rounded-xl overflow-hidden border border-border shadow-card max-w-sm">
                <div className="p-6">
                  <h3 className="text-base font-medium text-foreground mb-3">
                    How Freelancers Get Paid
                  </h3>
                  <p className="text-sm text-foreground-muted mb-4">
                    Work can be divided into milestones for projects completed in stages,
                    or agreed as a one-time payment for the entire project. Submit
                    deliverables for each stage. Employer reviews and approves.
                    Payment is released automatically.
                  </p>
                  <div className="space-y-2 text-xs text-foreground-muted">
                    <div>
                      <span className="font-medium">Submit</span> deliverables
                    </div>
                    <div>
                      <span className="font-medium">Employer reviews</span>
                    </div>
                    <div>
                      <span className="font-medium">Approve & payment</span> released
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------- How It Works ----------------- */}
      <section className="py-20 md:py-24 bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-3 gap-6 md:gap-8">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-accent-subtle text-accent-subtle-foreground flex items-center justify-center mx-auto mb-6">
                <Home className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-2">
                Discover
              </h3>
              <p className="text-foreground-muted">
                Employers find talent; freelancers find opportunities.
              </p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-accent-subtle text-accent-subtle-foreground flex items-center justify-center mx-auto mb-6">
                <Briefcase className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-2">
                Agree
              </h3>
              <p className="text-foreground-muted">
                Both parties agree on contract terms and milestones.
              </p>
            </div>
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-accent-subtle text-accent-subtle-foreground flex items-center justify-center mx-auto mb-6">
                <CheckCircle className="h-6 w-6" />
              </div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-2">
                Deliver
              </h3>
              <p className="text-foreground-muted">
                Work is submitted, reviewed, approved, and payments are processed.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------- Milestone-Based Payments ----------------- */}
      <section
        className="payments-parallax-bg relative overflow-hidden py-20 md:py-24 bg-[#0a0a0a]"
        style={{ backgroundImage: "url('/payments-dark-background.jpg')" }}
      >
        <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
        <div
          className="absolute inset-0 bg-gradient-to-b from-black/40 via-black/25 to-black/60"
          aria-hidden="true"
        />
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-white">
              How You Get Paid
            </h2>
          </div>
          <div className="prose max-w-lg mx-auto">
            <p className="text-white/75 mb-8">
              Projects can be paid in different ways. You can choose milestone-based
              payments, dividing a project into smaller stages with payments at each
              stage, or agree on one payment for the entire project. Milestones are
              optional, not mandatory.
            </p>
            <div className="space-y-4 md:space-y-6 max-w-md mx-auto">
              <div className="flex justify-between items-center px-4 py-3 rounded-lg border border-white/10 bg-white/10 backdrop-blur-sm">
                <span className="font-medium text-white">Milestone 1</span>
                <span className="font-medium text-indigo-200">₦30,000</span>
              </div>
              <div className="flex justify-between items-center px-4 py-3 rounded-lg border border-white/10 bg-white/10 backdrop-blur-sm">
                <span className="font-medium text-white">Milestone 2</span>
                <span className="font-medium text-indigo-200">₦40,000</span>
              </div>
              <div className="flex justify-between items-center px-4 py-3 rounded-lg border border-white/10 bg-white/10 backdrop-blur-sm">
                <span className="font-medium text-white">Milestone 3</span>
                <span className="font-medium text-indigo-200">₦30,000</span>
              </div>
            </div>
            <div className="mt-8 pt-8 border-t border-white/15 text-center">
              <p className="text-white/75">
                Total: ₦100,000 — Kachploy commission (5%) is included in each milestone
                amount, not added on top. Paystack processing fees are separate.
              </p>
            </div>
          </div>
          <div className="mt-12 pt-12 border-t border-white/15">
            <p className="text-white/70">
              Kachploy does not provide legally regulated escrow, guaranteed payments,
              instant payouts, or insurance. Payment collection, work approval, and
              freelancer payout are distinct steps supported by the platform. Milestone
              payments are one of several ways to structure a project — employers and
              freelancers can agree on either milestone-based or one-time payment
              arrangements.
            </p>
          </div>
        </div>
      </section>

      {/* ----------------- Featured Opportunities ----------------- */}
      <section className="py-20 md:py-24 bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
              Featured Opportunities
            </h2>
            <p className="text-foreground-muted mt-2">
              Real jobs from our marketplace
            </p>
          </div>

          {/* Loading / Error states */}
          {isLoading && (
            <p className="text-foreground-muted text-center">Loading opportunities...</p>
          )}
          {isError && (
            <p className="text-foreground-muted text-center">Failed to load opportunities.</p>
          )}

          {/* Empty / Results */}
          {!isLoading && !isError && jobs.length === 0 && (
            <EmptyState
              icon={<Search className="h-6 w-6" aria-hidden="true" />}
              title="No opportunities yet"
              description="There are currently no active opportunities. Log in or get started to browse available roles."
              action={
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => navigate('/login')}
                >
                  Log In to Browse
                </Button>
              }
            />
          )}

          <div className="grid md:grid-cols-2 gap-6">
            {jobs && Array.isArray(jobs) ? jobs.map((job) => {
              const title = job.title || 'Untitled Opportunity';
              const budget = job.budget ?? 'Budget not specified';
              const category = job.category ?? '';
              const posted = job.postedAt
                ? new Date(job.postedAt).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : 'Recently posted';
              const jobId = job._id || job.id;
              return (
                <article
                  key={jobId}
                  className="bg-canvas rounded-lg border border-border p-5 hover:border-accent transition-colors"
                >
                  <h3 className="text-lg font-medium text-foreground line-clamp-2">
                    {title}
                  </h3>
                  <div className="mt-3 flex items-center gap-3 text-sm text-foreground-muted">
                    {category && <span>{category}</span>}
                    <span>{budget}</span>
                    <span>{posted}</span>
                  </div>
                  <Link
                    to={`/jobs/${jobId}`}
                    className="mt-3 text-accent underline underline-offset-2"
                  >
                    View Job
                  </Link>
                </article>
              );
            }) : null}
          </div>
        </div>
      </section>

      {/* ----------------- Why Choose Kachploy ----------------- */}
      <section className="py-20 md:py-24 bg-canvas">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid md:grid-cols-3 gap-6 md:gap-8">
            <div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-4">
                Clear Project Expectations
              </h3>
              <p className="text-foreground-muted">
                Well-defined scopes and milestone agreements mean no surprise deliverables
                and no guesswork about what was agreed.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-4">
                Structured Milestone Agreements
              </h3>
              <p className="text-foreground-muted">
                Projects can be broken into agreed stages with clear deliverables for each.
                Pay is released when milestones are approved, or a single payment can be
                agreed for the entire project. Milestones are optional, not mandatory.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-4">
                Organized Collaboration
              </h3>
              <p className="text-foreground-muted">
                Central place to share files, review work, give feedback, and approve
                deliverables — all without scattered emails or lost messages.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-4">
                Transparent Commission
              </h3>
              <p className="text-foreground-muted">
                5% commission on each milestone amount — included in the amount, not
                added on top. No hidden fees.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-4">
                Progress Visibility
              </h3>
              <p className="text-foreground-muted">
                Track work status, payment progress, and approval state at a glance.
                Always know where your project stands.
              </p>
            </div>
            <div>
              <h3 className="text-xl font-bold tracking-tight text-foreground mb-4">
                Central Management
              </h3>
              <p className="text-foreground-muted">
                One place to manage opportunities, contracts, deliverables, and payments.
                Everything tracked in one system.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------- FAQ Section ----------------- */}
      <section className="py-20 md:py-24 bg-surface">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">
              Frequently Asked Questions
            </h2>
          </div>

          <div className="space-y-3">
            <details className="bg-canvas rounded-lg border border-border p-5">
              <summary
                className="text-lg font-medium text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                What is Kachploy?
              </summary>
              <p className="mt-4 text-foreground-muted">
                Kachploy is a freelance marketplace connecting employers with skilled
                freelancers. Platform features include posting opportunities, reviewing
                applicants, milestone-based contracts, deliverable submission and
                review, and tracked payment processing with a transparent 5% commission.
              </p>
            </details>

            <details className="bg-canvas rounded-lg border border-border p-5">
              <summary
                className="text-lg font-medium text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                How do I find freelance opportunities?
              </summary>
              <p className="mt-4 text-foreground-muted">
                Browse active opportunities after logging in. Filter by category, budget,
                and skill set. Apply directly through the platform with a message and
                your profile. Applications are sent to the employer for review.
              </p>
            </details>

            <details className="bg-canvas rounded-lg border border-border p-5">
              <summary
                className="text-lg font-medium text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                How do employers hire freelancers?
              </summary>
              <p className="mt-4 text-foreground-muted">
                Post an opportunity describing the project scope, budget, and required
                skills. Review applicant profiles and applications. Select a freelancer
                and agree on payment terms — either milestone-based payments for projects
                completed in stages, or one payment for the entire project. Work begins
                upon contract acceptance.
              </p>
            </details>

            <details className="bg-canvas rounded-lg border border-border p-5">
              <summary
                className="text-lg font-medium text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                How do milestone payments work?
              </summary>
              <p className="mt-4 text-foreground-muted">
                Projects can be paid in different ways. Freelance projects may use
                milestone-based payments, dividing the project into smaller stages with
                payments at each stage, or a single one-time payment for the entire
                project. Milestones are optional, not mandatory. Freelancers submit
                deliverables for review. Employers approve completed milestones,
                triggering payment release. Kachploy charges a 5% commission included
                in each milestone amount. Paystack processing fees are separate.
              </p>
            </details>

            <details className="bg-canvas rounded-lg border border-border p-5">
              <summary
                className="text-lg font-medium text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                What commission does Kachploy charge?
              </summary>
              <p className="mt-4 text-foreground-muted">
                Kachploy charges a 5% commission on each milestone amount. This commission
                is included in the milestone amount, not added on top. For example, a
                ₦30,000 milestone includes the 5% commission (₦28,500 to the freelancer,
                ₦1,500 to Kachploy).
              </p>
            </details>

            <details className="bg-canvas rounded-lg border border-border p-5">
              <summary
                className="text-lg font-medium text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              >
                Is Kachploy free to join?
              </summary>
              <p className="mt-4 text-foreground-muted">
                Yes. Joining as either an employer or a freelancer is free. The 5% commission
                is only applied when a milestone payment is processed. Creating an
                opportunity or applying for one costs nothing upfront.
              </p>
            </details>
          </div>
        </div>
      </section>

{/* ----------------- Closing CTA ----------------- */}
      <section className="relative py-24 md:py-32 lg:py-40 bg-canvas">
        <div className="absolute inset-0 bg-[url('/cta-background.jpg')] bg-no-repeat bg-center bg-cover bg-gray-800/60"></div>
        <div className="absolute inset-0 bg-black/40"></div>
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 text-center relative z-10">
          <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white">
            Your next great opportunity starts here.
          </h2>
          <p className="mt-6 text-lg md:text-xl text-white/90 max-w-2xl mx-auto">
            Whether you're looking for exceptional talent or your next project, Kachploy
            helps you take the next step.
          </p>
          <div className="mt-8 flex flex-wrap gap-4 justify-center">
            <Button
              variant="primary"
              size="lg"
              onClick={() => ctaDestination(false)}
            >
              Get Started
            </Button>
            <Button
              variant="ghost"
              size="lg"
              onClick={() => ctaDestination(false)}
            >
              Explore Opportunities
            </Button>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </main>
  );
};

export default LandingPage;