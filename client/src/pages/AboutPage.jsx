import React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Briefcase,
  Check,
  ClipboardList,
  FileText,
  History,
  Layers3,
  MessagesSquare,
  UserRound,
  Wallet,
} from 'lucide-react';
import Button from '../components/ui/Button';
import MarketingNavbar from '../components/marketing/MarketingNavbar';
import MarketingFooter from '../components/marketing/MarketingFooter';
import useMarketingCta from '../useMarketingCta';

const problemCards = [
  {
    icon: MessagesSquare,
    title: 'Scope lives in chat',
    body: 'Requirements get scattered across messages, and assumptions fill the gaps. Both sides can end up imagining a different project.',
  },
  {
    icon: ClipboardList,
    title: 'Applications are hard to compare',
    body: 'When every proposal is a different shape, it is difficult to judge experience, fit, and price without losing the details that matter.',
  },
  {
    icon: Wallet,
    title: 'Payment steps feel uncertain',
    body: 'Without visible milestones and release steps, it is hard to know what is due, what has been approved, and what happens next.',
  },
];

const differenceCards = [
  {
    icon: FileText,
    title: 'Requirements up front',
    body: 'Employers state the job, the application requirements, and the budget or a negotiable price. Resumes, cover letters, and portfolios can be marked as not needed, optional, or required.',
  },
  {
    icon: Layers3,
    title: 'Contract terms both sides accept',
    body: 'After an interview, an employer can send a contract proposal. The freelancer can accept it or request changes before work begins.',
  },
  {
    icon: Wallet,
    title: 'Flexible payment structures',
    body: 'Agree on one payment for the whole project, or divide the work into milestones. Milestones are optional, not mandatory.',
  },
  {
    icon: History,
    title: 'A record you can return to',
    body: 'Applications, tasks, approvals, payment history, reviews, and disputes stay connected to the work instead of disappearing into separate threads.',
  },
];

const principles = [
  {
    number: '01',
    title: 'Clarity before commitment',
    body: 'Both sides should understand the scope, the payment structure, and the next step before work starts.',
  },
  {
    number: '02',
    title: 'Payments tied to agreed work',
    body: 'Milestones, approvals, and release requests create visible checkpoints between doing the work and moving money.',
  },
  {
    number: '03',
    title: 'Honest boundaries',
    body: 'We describe what the platform actually does. We do not dress up payment processing as a guarantee or a regulated escrow service.',
  },
];

const AboutPage = () => {
  const goToDashboardOrLogin = useMarketingCta();

  return (
    <main className="min-h-screen bg-canvas text-foreground">
      <MarketingNavbar />

      {/* ----------------- Hero ----------------- */}
      <section className="relative overflow-hidden bg-[#0a0a0a]">
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/about-hero-background.jpg')" }}
          aria-hidden="true"
        />
        <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
        <div
          className="marketing-grid marketing-grid-fade absolute inset-0 opacity-40"
          aria-hidden="true"
        />

        <div className="relative z-10 mx-auto max-w-7xl px-4 pb-20 pt-24 sm:px-6 md:pb-24 md:pt-32 lg:px-8 lg:pb-28 lg:pt-40">
          <div className="max-w-3xl">
            <p className="marketing-rise text-sm font-semibold uppercase tracking-[0.22em] text-indigo-300">
              About Kachploy
            </p>
            <h1 className="marketing-rise marketing-rise-delay-1 mt-5 text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl md:text-6xl lg:text-7xl">
              Freelance work, with fewer loose ends.
            </h1>
            <p className="marketing-rise marketing-rise-delay-2 mt-6 max-w-2xl text-lg leading-relaxed text-white/75 md:text-xl">
              Kachploy brings the working relationship into one place: the job, the
              agreement, the work, and the payment record. Both sides can see what was
              agreed and what happens next.
            </p>
            <div className="marketing-rise marketing-rise-delay-3 mt-9 flex flex-wrap items-center gap-4">
              <Button size="lg" onClick={goToDashboardOrLogin}>
                Get started
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Button>
              <Link
                to="/how-it-works"
                className="inline-flex h-11 items-center justify-center rounded-md border border-white/20 px-5 text-base font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
              >
                See how it works
              </Link>
            </div>
          </div>

          <div className="mt-16 grid gap-4 border-t border-white/15 pt-8 sm:grid-cols-3 md:mt-20">
            {[
              'Structured job posts',
              'Contracts both sides accept',
              'Milestone or one-time payments',
            ].map((item) => (
              <div key={item} className="flex items-center gap-3 text-sm text-white/70">
                <Check className="h-4 w-4 shrink-0 text-indigo-300" aria-hidden="true" />
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------- Problem ----------------- */}
      <section className="bg-canvas py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              The problem
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
              The work is rarely the hard part.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-foreground-muted">
              Freelance projects often break down around the work, not inside it. The
              brief is unclear, the application is hard to read, or nobody is sure which
              payment step comes next.
            </p>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {problemCards.map((card) => {
              const Icon = card.icon;
              return (
                <article
                  key={card.title}
                  className="rounded-xl border border-border bg-surface p-7 shadow-card"
                >
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-6 text-lg font-semibold text-foreground">
                    {card.title}
                  </h3>
                  <p className="mt-3 leading-relaxed text-foreground-muted">{card.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* ----------------- Solution ----------------- */}
      <section className="relative overflow-hidden bg-[#0a0a0a] py-20 md:py-28">
        <div
          className="marketing-grid marketing-grid-fade absolute inset-0 opacity-30"
          aria-hidden="true"
        />
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-300">
                The idea
              </p>
              <h2 className="mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl md:text-5xl">
                One shared record from job post to payout.
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-white/70">
                Kachploy gives the relationship a structure. Employers post with real
                requirements. Freelancers apply with the information that was actually
                asked for. Both sides agree on terms before the work begins.
              </p>
              <ul className="mt-8 space-y-4">
                {[
                  'The job post states the requirements and the budget or negotiable price.',
                  'The contract records the payment structure both sides accept.',
                  'Milestones and tasks create visible checkpoints for the work.',
                  'Payment history keeps collection, approval, release, and payout steps in view.',
                ].map((item) => (
                  <li key={item} className="flex gap-3 text-white/75">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-indigo-400/15 text-indigo-200">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative">
              <div className="absolute -inset-4 rounded-3xl bg-indigo-400/10 blur-2xl" aria-hidden="true" />
              <div className="relative rounded-2xl border border-white/15 bg-white/[0.06] p-5 shadow-2xl backdrop-blur-sm sm:p-7">
                <div className="flex items-center justify-between gap-4 border-b border-white/10 pb-5">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
                      Illustrative example
                    </p>
                    <h3 className="mt-2 text-xl font-semibold text-white">Contract snapshot</h3>
                  </div>
                  <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-medium text-white/70">
                    Milestone-based
                  </span>
                </div>

                <dl className="mt-5 space-y-4 text-sm">
                  {[
                    ['Scope', 'Landing page redesign'],
                    ['Agreed amount', 'Split across 3 milestones'],
                    ['Current step', 'Milestone 2 · work in review'],
                    ['Commission', '5% included in each milestone amount'],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex flex-col gap-1 border-b border-white/10 pb-4 last:border-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
                    >
                      <dt className="text-white/50">{label}</dt>
                      <dd className="font-medium text-white sm:text-right">{value}</dd>
                    </div>
                  ))}
                </dl>

                <div className="mt-6 rounded-lg border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center justify-between text-xs text-white/60">
                    <span>Milestone progress</span>
                    <span>2 of 3</span>
                  </div>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full w-2/3 rounded-full bg-indigo-400" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------- Differentiators ----------------- */}
      <section className="bg-surface py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-end">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
                What makes it different
              </p>
              <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
                Structure, not guesswork.
              </h2>
            </div>
            <p className="max-w-xl text-lg leading-relaxed text-foreground-muted lg:justify-self-end">
              The platform is built around the handoffs where freelance projects usually
              lose clarity: the brief, the application, the agreement, and the payment.
            </p>
          </div>

          <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
            {differenceCards.map((card) => {
              const Icon = card.icon;
              return (
                <article key={card.title} className="bg-surface p-7 md:p-9">
                  <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-surface-muted text-foreground">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </div>
                  <h3 className="mt-6 text-lg font-semibold text-foreground">
                    {card.title}
                  </h3>
                  <p className="mt-3 leading-relaxed text-foreground-muted">{card.body}</p>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* ----------------- Principles ----------------- */}
      <section className="bg-surface-muted py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              Our principles
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
              What we optimize for.
            </h2>
          </div>

          <div className="mt-12 grid gap-10 md:grid-cols-3">
            {principles.map((principle) => (
              <article key={principle.number} className="border-t border-border-strong pt-6">
                <p className="text-sm font-semibold text-accent">{principle.number}</p>
                <h3 className="mt-4 text-xl font-semibold text-foreground">
                  {principle.title}
                </h3>
                <p className="mt-3 leading-relaxed text-foreground-muted">{principle.body}</p>
              </article>
            ))}
          </div>

          <div className="mt-14 rounded-xl border border-border-strong bg-surface p-7 md:p-9">
            <h3 className="text-lg font-semibold text-foreground">What Kachploy is not</h3>
            <p className="mt-4 max-w-4xl leading-relaxed text-foreground-muted">
              Kachploy does not provide legally regulated escrow, guaranteed payments,
              instant payouts, or insurance. Payment collection, work approval, and
              freelancer payout are separate steps. A payout requires a verified payout
              account, and release requests and employer approval are part of the
              process.
            </p>
          </div>
        </div>
      </section>

      {/* ----------------- Who it is for ----------------- */}
      <section className="bg-surface py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              Who it is for
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
              Two sides. One shared process.
            </h2>
          </div>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <article className="rounded-xl border border-border bg-canvas p-7 md:p-9">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
                <Briefcase className="h-6 w-6" aria-hidden="true" />
              </div>
              <h3 className="mt-6 text-2xl font-semibold text-foreground">For employers</h3>
              <p className="mt-3 leading-relaxed text-foreground-muted">
                Post the work, state what applicants need to send, review applications,
                schedule interviews, and agree on a contract before the project begins.
              </p>
              <button
                type="button"
                onClick={goToDashboardOrLogin}
                className="mt-7 inline-flex items-center gap-2 font-semibold text-accent hover:text-accent-hover"
              >
                Start hiring
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </article>

            <article className="rounded-xl border border-border bg-canvas p-7 md:p-9">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
                <UserRound className="h-6 w-6" aria-hidden="true" />
              </div>
              <h3 className="mt-6 text-2xl font-semibold text-foreground">For freelancers</h3>
              <p className="mt-3 leading-relaxed text-foreground-muted">
                Find active jobs, apply with the requested materials, agree on terms,
                complete milestone work, submit deliverables, and keep a record of every
                payment step.
              </p>
              <button
                type="button"
                onClick={goToDashboardOrLogin}
                className="mt-7 inline-flex items-center gap-2 font-semibold text-accent hover:text-accent-hover"
              >
                Find work
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </article>
          </div>
        </div>
      </section>

      {/* ----------------- Closing CTA ----------------- */}
      <section className="relative overflow-hidden bg-[#0a0a0a] py-24 md:py-32">
        <div className="marketing-grid marketing-grid-fade absolute inset-0 opacity-30" aria-hidden="true" />
        <div className="absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-indigo-500/15 blur-3xl" aria-hidden="true" />
        <div className="relative z-10 mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-4xl font-bold tracking-tight text-white md:text-5xl lg:text-6xl">
            Build the work on a clearer foundation.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-white/70 md:text-xl">
            Post a job or find your next project, with the terms, milestones, and payment
            record in one place.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-4">
            <Button size="lg" onClick={goToDashboardOrLogin}>
              Get started
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Link
              to="/how-it-works"
              className="inline-flex h-11 items-center justify-center rounded-md border border-white/20 px-5 text-base font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
            >
              See the full workflow
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </main>
  );
};

export default AboutPage;
