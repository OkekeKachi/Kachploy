import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { resolvePageMetadata, SOCIAL_IMAGE_URL } from './seoMetadata';

const setMeta = (attribute, key, content) => {
  const nodes = Array.from(document.head.querySelectorAll(`meta[${attribute}="${key}"]`));

  if (content == null) {
    nodes.forEach((node) => node.remove());
    return;
  }

  let node = nodes.shift();

  if (!node) {
    node = document.createElement('meta');
    node.setAttribute(attribute, key);
    document.head.appendChild(node);
  }

  node.setAttribute('content', content);
  nodes.forEach((extra) => extra.remove());
};

const setCanonical = (href) => {
  const nodes = Array.from(document.head.querySelectorAll('link[rel="canonical"]'));

  if (href == null) {
    nodes.forEach((node) => node.remove());
    return;
  }

  let node = nodes.shift();

  if (!node) {
    node = document.createElement('link');
    node.setAttribute('rel', 'canonical');
    document.head.appendChild(node);
  }

  node.setAttribute('href', href);
  nodes.forEach((extra) => extra.remove());
};

const RouteMetadata = () => {
  const { pathname } = useLocation();

  useEffect(() => {
    const metadata = resolvePageMetadata(pathname);

    document.title = metadata.title;
    setMeta('name', 'description', metadata.description);
    setMeta('name', 'robots', metadata.robots);
    setCanonical(metadata.canonical);
    setMeta('property', 'og:title', metadata.title);
    setMeta('property', 'og:description', metadata.description);
    setMeta('property', 'og:type', 'website');
    setMeta('property', 'og:url', metadata.canonical);
    setMeta('property', 'og:image', SOCIAL_IMAGE_URL);
    setMeta('property', 'og:site_name', 'Kachploy');
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', metadata.title);
    setMeta('name', 'twitter:description', metadata.description);
    setMeta('name', 'twitter:image', SOCIAL_IMAGE_URL);
  }, [pathname]);

  return null;
};

export default RouteMetadata;
