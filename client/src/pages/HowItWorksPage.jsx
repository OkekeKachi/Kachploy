import React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  BadgeCheck,
  Briefcase,
  CheckCircle2,
  ClipboardList,
  FileText,
  ListChecks,
  MessagesSquare,
  Search,
  Upload,
  UserRound,
  Wallet,
} from 'lucide-react';
import Button from '../components/ui/Button';
import MarketingNavbar from '../components/marketing/MarketingNavbar';
import MarketingFooter from '../components/marketing/MarketingFooter';
import useMarketingCta from '../useMarketingCta';

const employerSteps = [
  {
    icon: Briefcase,
    title: 'Post the job',
    body: 'Describe the work, set the application requirements for a resume, cover letter, and portfolio as not needed, optional, or required, then set a budget or a negotiable price.',
  },
  {
    icon: ClipboardList,
    title: 'Review applications',
    body: 'Applications arrive with the materials you asked for. Compare profiles and proposals, then schedule interviews with the people you want to know better.',
  },
  {
    icon: FileText,
    title: 'Agree on the contract',
    body: 'Send a contract proposal with the scope and payment structure. Choose a single payment or milestones. The freelancer accepts the proposal or requests changes.',
  },
  {
    icon: Wallet,
    title: 'Confirm the applicable payment',
    body: 'For a milestone contract, confirm the applicable milestone payment before its tasks begin. The 5% Kachploy commission is included in the milestone amount; Paystack processing fees are separate.',
  },
  {
    icon: CheckCircle2,
    title: 'Review the work',
    body: 'When work is submitted, review it against the agreed milestone or project. Approve it, or request a revision if something needs to change.',
  },
  {
    icon: BadgeCheck,
    title: 'Release payment and review',
    body: 'Approved work moves through release and payout steps. A verified payout account is required, and release requests and employer approval are part of the process. Each side can leave one review per employment, and disputes can be raised when needed.',
  },
];

const freelancerSteps = [
  {
    icon: Search,
    title: 'Find work',
    body: 'Browse active jobs and read the requirements before applying. Each post states the budget or that the price is negotiable.',
  },
  {
    icon: ClipboardList,
    title: 'Apply with what was requested',
    body: 'Send the resume, cover letter, and portfolio items the employer asked for. Optional materials can still strengthen your application; required ones are part of the brief.',
  },
  {
    icon: MessagesSquare,
    title: 'Interview and agree on terms',
    body: 'Interview with the employer, then review the contract proposal. Accept it or request changes until the scope and payment structure are clear to both sides.',
  },
  {
    icon: ListChecks,
    title: 'Complete milestone work',
    body: 'For a milestone contract, complete the tasks for the applicable milestone. Milestone tasks require the applicable payment confirmation before work begins.',
  },
  {
    icon: Upload,
    title: 'Submit the deliverable',
    body: 'Submit your work for review. The employer can approve it or request a revision, and the milestone or project record shows where things stand.',
  },
  {
    icon: BadgeCheck,
    title: 'Get paid and leave a review',
    body: 'Approved work moves through release and payout. Make sure your payout account is verified; release requests and employer approval are part of the process. Each side can leave one review per employment, and disputes can be raised when needed.',
  },
];

const Timeline = ({ steps }) => (
  <div className="relative mt-12 md:mt-16">
    <div
      className="absolute bottom-0 left-5 top-0 w-px bg-border lg:left-1/2 lg:-translate-x-1/2"
      aria-hidden="true"
    />
    <ol>
      {steps.map((step, index) => {
        const Icon = step.icon;
        const isLeft = index % 2 === 0;

        return (
          <li key={step.title} className="relative pl-14 lg:pl-0">
            <div
              className={`lg:grid lg:grid-cols-2 lg:gap-16 ${
                index === steps.length - 1 ? '' : 'lg:pb-14'
              }`}
            >
              <div
                className={
                  isLeft
                    ? 'lg:pr-16 lg:text-right'
                    : 'lg:col-start-2 lg:pl-16'
                }
              >
                <article className="rounded-xl border border-border bg-surface p-6 shadow-card md:p-7">
                  <div
                    className={`flex items-center gap-3 ${
                      isLeft ? 'lg:justify-end' : ''
                    }`}
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-foreground-subtle">
                      Step {index + 1}
                    </p>
                  </div>
                  <h3 className="mt-5 text-xl font-semibold text-foreground">
                    {step.title}
                  </h3>
                  <p className="mt-3 leading-relaxed text-foreground-muted">
                    {step.body}
                  </p>
                </article>
              </div>
            </div>

            <span className="absolute left-5 top-6 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border-4 border-canvas bg-accent text-xs font-semibold text-white lg:left-1/2 lg:top-7">
              {index + 1}
            </span>
          </li>
        );
      })}
    </ol>
  </div>
);

const HowItWorksPage = () => {
  const goToDashboardOrLogin = useMarketingCta();

  return (
    <main className="min-h-screen bg-canvas text-foreground">
      <MarketingNavbar />

      {/* ----------------- Hero ----------------- */}
      <section className="relative overflow-hidden bg-[#0a0a0a]">
        <div
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: "url('/how-it-works-hero-background.jpg')" }}
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
              How Kachploy works
            </p>
            <h1 className="marketing-rise marketing-rise-delay-1 mt-5 text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl md:text-6xl lg:text-7xl">
              From first hello to final payment.
            </h1>
            <p className="marketing-rise marketing-rise-delay-2 mt-6 max-w-2xl text-lg leading-relaxed text-white/75 md:text-xl">
              A clear path for both sides of the table: post or find the work, agree on
              the terms, complete the milestones, and keep every payment step visible.
            </p>
            <div className="marketing-rise marketing-rise-delay-3 mt-9 flex flex-wrap items-center gap-4">
              <a
                href="#employers"
                className="inline-flex h-11 items-center justify-center gap-2 rounded-md bg-accent px-5 text-base font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
              >
                For employers
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <a
                href="#freelancers"
                className="inline-flex h-11 items-center justify-center rounded-md border border-white/20 px-5 text-base font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
              >
                For freelancers
              </a>
            </div>
          </div>

          <nav
            aria-label="On this page"
            className="mt-16 flex flex-wrap gap-x-8 gap-y-3 border-t border-white/15 pt-8 text-sm md:mt-20"
          >
            <a
              href="#employers"
              className="inline-flex min-h-6 items-center text-white/70 transition-colors hover:text-white"
            >
              Employer workflow
            </a>
            <a
              href="#freelancers"
              className="inline-flex min-h-6 items-center text-white/70 transition-colors hover:text-white"
            >
              Freelancer workflow
            </a>
            <a
              href="#payments"
              className="inline-flex min-h-6 items-center text-white/70 transition-colors hover:text-white"
            >
              Payments
            </a>
            <a
              href="#good-to-know"
              className="inline-flex min-h-6 items-center text-white/70 transition-colors hover:text-white"
            >
              Good to know
            </a>
          </nav>
        </div>
      </section>

      {/* ----------------- Overview ----------------- */}
      <section className="border-b border-border bg-surface py-16 md:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
                One workflow, two perspectives
              </p>
              <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                The same agreement, seen from both sides.
              </h2>
            </div>
            <p className="max-w-2xl text-lg leading-relaxed text-foreground-muted lg:justify-self-end">
              Every project has a job post, an application, a contract, and a payment
              record. What changes is who does each step. Choose your side below to see
              the full path.
            </p>
          </div>

          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            <a
              href="#employers"
              className="group flex items-center justify-between gap-6 rounded-xl border border-border bg-canvas p-6 transition-colors hover:border-accent/40 hover:bg-accent-subtle/40"
            >
              <div className="flex items-center gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
                  <Briefcase className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-semibold text-foreground">I am hiring</p>
                  <p className="mt-1 text-sm text-foreground-muted">
                    Post a job and review applications
                  </p>
                </div>
              </div>
              <ArrowRight className="h-5 w-5 shrink-0 text-foreground-subtle transition-transform group-hover:translate-x-1 group-hover:text-accent" aria-hidden="true" />
            </a>

            <a
              href="#freelancers"
              className="group flex items-center justify-between gap-6 rounded-xl border border-border bg-canvas p-6 transition-colors hover:border-accent/40 hover:bg-accent-subtle/40"
            >
              <div className="flex items-center gap-4">
                <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent-subtle text-accent-subtle-foreground">
                  <UserRound className="h-5 w-5" aria-hidden="true" />
                </span>
                <div>
                  <p className="font-semibold text-foreground">I am freelancing</p>
                  <p className="mt-1 text-sm text-foreground-muted">
                    Find work and submit deliverables
                  </p>
                </div>
              </div>
              <ArrowRight className="h-5 w-5 shrink-0 text-foreground-subtle transition-transform group-hover:translate-x-1 group-hover:text-accent" aria-hidden="true" />
            </a>
          </div>
        </div>
      </section>

      {/* ----------------- Employers ----------------- */}
      <section id="employers" className="scroll-mt-24 bg-canvas py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              For employers
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
              Hire with the brief, terms, and payment record in view.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-foreground-muted">
              Set expectations before applications arrive, then follow the work through
              approval and payment without losing the thread.
            </p>
          </div>

          <Timeline steps={employerSteps} />
        </div>
      </section>

      {/* ----------------- Freelancers ----------------- */}
      <section id="freelancers" className="scroll-mt-24 border-y border-border bg-surface py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
              For freelancers
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl md:text-5xl">
              Apply, deliver, and follow the payment steps.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-foreground-muted">
              Know what the employer asked for, what the contract says, and what has been
              approved before the next milestone begins.
            </p>
          </div>

          <Timeline steps={freelancerSteps} />
        </div>
      </section>

      {/* ----------------- Payments ----------------- */}
      <section id="payments" className="scroll-mt-24 relative overflow-hidden bg-[#0a0a0a] py-20 md:py-28">
        <div className="marketing-grid marketing-grid-fade absolute inset-0 opacity-30" aria-hidden="true" />
        <div className="relative z-10 mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-indigo-300">
              Payments
            </p>
            <h2 className="mt-4 text-3xl font-bold tracking-tight text-white sm:text-4xl md:text-5xl">
              Payments, without the guesswork.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-white/70">
              A contract can use one payment for the whole project or a series of
              milestones. Either way, the terms are agreed before the work begins and the
              payment steps stay visible afterwards.
            </p>
          </div>

          <div className="mt-12 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <div className="grid gap-4 sm:grid-cols-2">
              <article className="rounded-xl border border-white/15 bg-white/[0.06] p-6">
                <p className="text-sm font-semibold text-indigo-300">5% commission</p>
                <p className="mt-3 leading-relaxed text-white/70">
                  Kachploy&apos;s 5% commission is included in each milestone amount, not
                  added on top. Paystack processing fees are separate.
                </p>
              </article>

              <article className="rounded-xl border border-white/15 bg-white/[0.06] p-6">
                <p className="text-sm font-semibold text-indigo-300">Flexible structure</p>
                <p className="mt-3 leading-relaxed text-white/70">
                  Milestones are optional. A project can be paid in stages or with one
                  payment for the entire scope.
                </p>
              </article>

              <article className="rounded-xl border border-white/15 bg-white/[0.06] p-6">
                <p className="text-sm font-semibold text-indigo-300">Separate steps</p>
                <p className="mt-3 leading-relaxed text-white/70">
                  Payment collection, work approval, and freelancer payout are distinct.
                  A verified payout account is required for payout.
                </p>
              </article>

              <article className="rounded-xl border border-white/15 bg-white/[0.06] p-6">
                <p className="text-sm font-semibold text-indigo-300">Not escrow</p>
                <p className="mt-3 leading-relaxed text-white/70">
                  Kachploy does not provide legally regulated escrow, guaranteed payments,
                  instant payouts, or insurance.
                </p>
              </article>
            </div>

            <div className="rounded-xl border border-white/15 bg-white/[0.06] p-6 sm:p-8">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-indigo-300">
                Illustrative example
              </p>
              <h3 className="mt-2 text-xl font-semibold text-white">
                A milestone amount
              </h3>

              <div className="mt-6 space-y-4">
                {[
                  ['Milestone amount', 'NGN 30,000'],
                  ['Kachploy commission (5%, included)', 'NGN 1,500'],
                  ['Freelancer receives', 'NGN 28,500'],
                ].map(([label, value], index) => (
                  <div
                    key={label}
                    className={`flex items-center justify-between gap-4 ${
                      index === 2
                        ? 'border-t border-white/15 pt-4 text-white'
                        : 'text-white/65'
                    }`}
                  >
                    <span className="text-sm">{label}</span>
                    <span className={index === 2 ? 'font-semibold' : 'font-medium text-white/85'}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <p className="mt-6 border-t border-white/15 pt-5 text-sm leading-relaxed text-white/60">
                Paystack processing fees are separate. The platform collects payment,
                records approval, and supports the release and payout steps; it does not
                guarantee payment or pay out instantly.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ----------------- Good to know ----------------- */}
      <section id="good-to-know" className="scroll-mt-24 bg-canvas py-20 md:py-28">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-accent">
                Good to know
              </p>
              <h2 className="mt-4 text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
                The details that keep the workflow clear.
              </h2>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {[
                [
                  'Reviews',
                  'Both sides can leave one review per employment after the work is complete.',
                ],
                [
                  'Disputes',
                  'If an issue cannot be resolved between the parties, a dispute can be raised through the existing workflow.',
                ],
                [
                  'Interviews',
                  'Employers can schedule interviews before sending a contract proposal.',
                ],
                [
                  'Contract changes',
                  'A freelancer can accept a contract proposal or request changes before agreeing to it.',
                ],
                [
                  'Milestone payments',
                  'Milestone tasks require the applicable payment confirmation before work begins.',
                ],
                [
                  'Payout readiness',
                  'A verified payout account is required, and release requests and employer approval are part of the payout process.',
                ],
              ].map(([title, body]) => (
                <article
                  key={title}
                  className="rounded-xl border border-border bg-surface p-6 shadow-card"
                >
                  <h3 className="font-semibold text-foreground">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-foreground-muted">
                    {body}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ----------------- Closing CTA ----------------- */}
      <section className="relative overflow-hidden bg-[#0a0a0a] py-24 md:py-32">
        <div className="marketing-grid marketing-grid-fade absolute inset-0 opacity-30" aria-hidden="true" />
        <div className="absolute left-1/2 top-0 h-72 w-72 -translate-x-1/2 rounded-full bg-indigo-500/15 blur-3xl" aria-hidden="true" />
        <div className="relative z-10 mx-auto max-w-3xl px-4 text-center sm:px-6 lg:px-8">
          <h2 className="text-4xl font-bold tracking-tight text-white md:text-5xl lg:text-6xl">
            Start with the work. Keep the process clear.
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-white/70 md:text-xl">
            Whether you are hiring or freelancing, the next step begins with a clear
            brief and an agreement both sides understand.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-4">
            <Button size="lg" onClick={goToDashboardOrLogin}>
              Get started
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Link
              to="/about"
              className="inline-flex h-11 items-center justify-center rounded-md border border-white/20 px-5 text-base font-medium text-white transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-[#0a0a0a]"
            >
              More about Kachploy
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </main>
  );
};

export default HowItWorksPage;
