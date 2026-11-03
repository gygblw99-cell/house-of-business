import type { Metadata } from 'next';
import { Heebo, Rubik } from 'next/font/google';
import './globals.css';
import GoogleAnalytics from '@/components/GoogleAnalytics';
import { AccessibilityWidget } from '@/components/AccessibilityWidget';

const heebo = Heebo({ subsets: ['latin', 'hebrew'], variable: '--font-heebo', display: 'swap' });
const rubik = Rubik({ subsets: ['latin', 'hebrew'], variable: '--font-rubik', display: 'swap', weight: ['500', '700', '800', '900'] });

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://houseofbusiness.co.il';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'House of Business | מערכת AI לניהול עסקים',
  description: 'מערכת AI לניהול מסעדות, בתי קפה, ברים ועסקים. דשבורד חכם, סוכני AI, שיווק אוטומטי ועוד.',
  keywords: ['ניהול מסעדה', 'AI עסקי', 'מערכת POS', 'ניהול מלאי', 'שיווק AI'],
  icons: {
    icon: '/logo-luxury.png',
    apple: '/logo-luxury.png',
    shortcut: '/logo-luxury.png',
  },
  openGraph: {
    title: 'House of Business | מערכת AI לניהול עסקים',
    description: 'מערכת AI לניהול מסעדות, בתי קפה, ברים ועסקים. דשבורד חכם, סוכני AI, שיווק אוטומטי ועוד.',
    siteName: 'House of Business',
    type: 'website',
    locale: 'he_IL',
    url: SITE_URL,
    images: [{ url: '/logo-luxury.png', width: 512, height: 512, alt: 'House of Business Logo' }],
  },
  twitter: {
    card: 'summary',
    title: 'House of Business | מערכת AI לניהול עסקים',
    description: 'מערכת AI לניהול מסעדות, בתי קפה, ברים ועסקים.',
    images: ['/logo-luxury.png'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl">
      <head>
        <meta name="theme-color" content="#050507" />
        {/* Runs before paint — disables the browser's native scroll-position
            restore (on refresh/back-forward) and any incoming #hash jump, so
            every visit to the marketing site always starts at the very top
            instead of wherever the browser last had it scrolled to. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if('scrollRestoration' in history){history.scrollRestoration='manual';}window.scrollTo(0,0);}catch(e){}`,
          }}
        />
        {/* JSON-LD Organization schema — required for Google to display the
            company logo in Knowledge Panel and search results */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            // Escape < and > so a tainted SITE_URL can't break out of the script tag.
            __html: JSON.stringify({
              '@context': 'https://schema.org',
              '@type': 'Organization',
              name: 'House of Business',
              url: SITE_URL,
              logo: {
                '@type': 'ImageObject',
                url: `${SITE_URL}/logo-luxury.png`,
                width: 512,
                height: 512,
              },
              description: 'מערכת AI לניהול מסעדות, בתי קפה, ברים ועסקים',
              sameAs: [],
            }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e'),
          }}
        />
      </head>
      <body className={`${heebo.variable} ${rubik.variable}`}>
        <GoogleAnalytics />
        <AccessibilityWidget />
        {children}
      </body>
    </html>
  );
}
