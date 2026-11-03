import Script from 'next/script';

const GA_ID = process.env.NEXT_PUBLIC_GA_ID;
// The repo's .env.production ships a literal 'G-XXXXXXXXXX' placeholder —
// without this guard the site would load Google's gtag script and silently
// "track" against a nonexistent property until someone notices analytics
// are empty. Real ID: replace NEXT_PUBLIC_GA_ID in the deployment env.
const isPlaceholder = !GA_ID || /^G-X+$/i.test(GA_ID);

export default function GoogleAnalytics() {
  if (isPlaceholder) return null;
  return (
    <>
      <Script src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`} strategy="afterInteractive" />
      <Script id="ga-init" strategy="afterInteractive">{`
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', '${GA_ID}', { page_path: window.location.pathname });
      `}</Script>
    </>
  );
}
