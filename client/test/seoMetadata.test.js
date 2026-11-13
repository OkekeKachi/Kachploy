import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOINDEX_METADATA,
  PUBLIC_PAGE_METADATA,
  SITE_URL,
  normalizePathname,
  resolvePageMetadata,
} from '../src/components/seoMetadata.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const readClientFile = (relativePath) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');

test('indexable routes have unique titles, descriptions, and canonical URLs', () => {
  const routes = ['/', '/about', '/how-it-works'];
  const titles = new Set();
  const canonicals = new Set();

  for (const route of routes) {
    const metadata = resolvePageMetadata(route);

    assert.equal(metadata.robots, 'index, follow');
    assert.ok(metadata.title);
    assert.ok(metadata.description);
    assert.equal(metadata.canonical, `${SITE_URL}${route === '/' ? '/' : route}`);
    titles.add(metadata.title);
    canonicals.add(metadata.canonical);
  }

  assert.equal(titles.size, routes.length);
  assert.equal(canonicals.size, routes.length);
});

test('trailing slashes resolve to the canonical public route metadata', () => {
  assert.equal(normalizePathname('/about/'), '/about');
  assert.equal(normalizePathname('/how-it-works///'), '/how-it-works');
  assert.equal(resolvePageMetadata('/about/'), PUBLIC_PAGE_METADATA['/about']);
});

test('auth, private, and unknown routes are noindex without a canonical', () => {
  for (const route of [
    '/login',
    '/verify-email',
    '/dashboard',
    '/payments',
    '/complete-profile',
    '/post-job',
    '/jobs/job-1',
    '/profile',
    '/employee/hired-jobs',
    '/employer/jobs/job-1/applications/Title',
    '/messages/conversation-1',
    '/not-a-real-route',
  ]) {
    const metadata = resolvePageMetadata(route);

    assert.equal(metadata, NOINDEX_METADATA);
    assert.equal(metadata.robots, 'noindex, nofollow');
    assert.equal(metadata.canonical, null);
  }
});

test('sitemap contains exactly the three approved public URLs', () => {
  const sitemap = readClientFile('public/sitemap.xml');
  const urls = Array.from(sitemap.matchAll(/<loc>(.*?)<\/loc>/g), (match) => match[1]);

  assert.deepEqual(urls, [
    'https://kachploy.pages.dev/',
    'https://kachploy.pages.dev/about',
    'https://kachploy.pages.dev/how-it-works',
  ]);
  assert.match(sitemap, /xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.doesNotMatch(sitemap, /<lastmod>|<changefreq>|<priority>/);
});

test('robots.txt allows crawling and references the sitemap', () => {
  const robots = readClientFile('public/robots.txt');

  assert.match(robots, /User-agent: \*/);
  assert.match(robots, /Allow: \//);
  assert.match(robots, /Sitemap: https:\/\/kachploy\.pages\.dev\/sitemap\.xml/);
  assert.doesNotMatch(robots, /Disallow:/);
});

test('index.html contains default metadata and preserves the favicon', () => {
  const index = readClientFile('index.html');

  assert.match(index, /<title>Kachploy — Freelance Marketplace for Employers and Freelancers<\/title>/);
  assert.match(index, /<meta\s+name="description"/);
  assert.match(index, /<meta name="robots" content="index, follow" \/>/);
  assert.match(index, /<meta name="theme-color" content="#0a0a0a" \/>/);
  assert.match(index, /<link rel="canonical" href="https:\/\/kachploy\.pages\.dev\/" \/>/);
  assert.match(index, /<meta\s+property="og:title"/);
  assert.match(index, /<meta\s+property="og:description"/);
  assert.match(index, /<meta property="og:type" content="website" \/>/);
  assert.match(index, /<meta property="og:url" content="https:\/\/kachploy\.pages\.dev\/" \/>/);
  assert.match(index, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.match(index, /<link rel="icon" type="image\/png" href="\/favicon\.png" \/>/);
});

test('the router mounts route metadata and a catch-all not-found route', () => {
  const appSource = readClientFile('src/App.jsx');
  const metadataSource = readClientFile('src/components/RouteMetadata.jsx');

  assert.match(appSource, /import RouteMetadata from '\.\/components\/RouteMetadata';/);
  assert.match(appSource, /<RouteMetadata \/>/);
  assert.match(appSource, /import NotFound from '\.\/pages\/NotFound';/);
  assert.match(appSource, /<Route path="\*" element=\{<NotFound \/>\} \/>/);
  assert.match(metadataSource, /document\.title = metadata\.title/);
  assert.match(metadataSource, /setCanonical\(metadata\.canonical\)/);
  assert.match(metadataSource, /\[pathname\]/);
});
