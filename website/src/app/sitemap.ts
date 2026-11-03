import type { MetadataRoute } from 'next';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://houseofbusiness.co.il';

// Fixed dates, bumped by hand when a page's content actually changes.
// `new Date()` here stamped every page as modified on each deploy, which
// trains crawlers to ignore lastModified entirely.
const HOME_UPDATED    = new Date('2026-08-08');
const LEGAL_UPDATED   = new Date('2026-06-26');

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL,              lastModified: HOME_UPDATED,  changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/privacy`, lastModified: LEGAL_UPDATED, changeFrequency: 'yearly', priority: 0.3 },
    { url: `${SITE_URL}/terms`,   lastModified: LEGAL_UPDATED, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
