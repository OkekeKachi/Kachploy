export const SITE_URL = 'https://kachploy.pages.dev';
export const SOCIAL_IMAGE_URL = `${SITE_URL}/hero-showcase.jpg`;

export const PUBLIC_PAGE_METADATA = {
  '/': {
    title: 'Kachploy — Freelance Marketplace for Employers and Freelancers',
    description:
      'Kachploy connects employers with skilled freelancers to post jobs, manage contracts, track milestones, and keep payments in one place.',
    canonical: `${SITE_URL}/`,
    robots: 'index, follow',
  },
  '/about': {
    title: 'About Kachploy — Freelance Work With Fewer Loose Ends',
    description:
      'Learn how Kachploy brings the job, contract, work, and payment record together so employers and freelancers can work with clearer expectations.',
    canonical: `${SITE_URL}/about`,
    robots: 'index, follow',
  },
  '/how-it-works': {
    title: 'How Kachploy Works — From Job Post to Payment',
    description:
      'See how employers post jobs and review applications, and how freelancers apply, complete milestones, and get paid through Kachploy.',
    canonical: `${SITE_URL}/how-it-works`,
    robots: 'index, follow',
  },
};

export const NOINDEX_METADATA = {
  title: 'Kachploy',
  description:
    'Kachploy is a freelance marketplace connecting employers with skilled freelancers.',
  canonical: null,
  robots: 'noindex, nofollow',
};

export const normalizePathname = (pathname) => {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return '/';
  const withoutTrailingSlash = pathname.replace(/\/+$/, '');
  return withoutTrailingSlash || '/';
};

export const resolvePageMetadata = (pathname) =>
  PUBLIC_PAGE_METADATA[normalizePathname(pathname)] || NOINDEX_METADATA;
