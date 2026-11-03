'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

// ── Route → background image mapping ─────────────────────────────────────────
// Add an entry here as each image is generated and placed in /public/backgrounds/
const BACKGROUNDS: Record<string, string> = {
  '/suppliers':       '/backgrounds/suppliers.webp',
  // '/dashboard':    '/backgrounds/dashboard.webp',
  // '/finance':      '/backgrounds/finance.webp',
  // '/recipes':      '/backgrounds/recipes.webp',
  // '/inventory':    '/backgrounds/inventory.webp',
  // '/employees':    '/backgrounds/employees.webp',
  // '/payroll':      '/backgrounds/payroll.webp',
  // '/shifts':       '/backgrounds/shifts.webp',
  // '/deliveries':   '/backgrounds/deliveries.webp',
  // '/menu-engineering': '/backgrounds/menu-engineering.webp',
  // '/audit':        '/backgrounds/audit.webp',
  // '/reports':      '/backgrounds/reports.webp',
  // '/settings':     '/backgrounds/settings.webp',
  // '/ai':           '/backgrounds/ai.webp',
  // '/price-comparison': '/backgrounds/price-comparison.webp',
  // '/reviews':      '/backgrounds/reviews.webp',
  // '/pos':          '/backgrounds/pos.webp',
  // '/invoices':     '/backgrounds/invoices.webp',
  // '/survival-mode':    '/backgrounds/survival-mode.webp',
  // '/tasks':        '/backgrounds/tasks.webp',
  // '/clock-in':     '/backgrounds/clock-in.webp',
  // '/loyalty':      '/backgrounds/loyalty.webp',
  // '/table-queue':  '/backgrounds/table-queue.webp',
  // '/pl-streams':   '/backgrounds/pl-streams.webp',
  // '/smart-reorder':    '/backgrounds/smart-reorder.webp',
  // '/fraud-alerts': '/backgrounds/fraud-alerts.webp',
  // '/guardian':     '/backgrounds/guardian.webp',
  // '/shift-planner':    '/backgrounds/shift-planner.webp',
  // '/supplier-ledger':  '/backgrounds/supplier-ledger.webp',
  // '/ingredient-cost':  '/backgrounds/ingredient-cost.webp',
  // '/orchestrator': '/backgrounds/orchestrator.webp',
  // '/profit-leak':  '/backgrounds/profit-leak.webp',
  // '/reminders':    '/backgrounds/reminders.webp',
  // '/calendar':     '/backgrounds/calendar.webp',
  // '/weekly-report':    '/backgrounds/weekly-report.webp',
  // '/zreport':      '/backgrounds/zreport.webp',
  // '/vat-report':   '/backgrounds/vat-report.webp',
  // '/ai-marketing': '/backgrounds/ai-marketing.webp',
};

// Pages that manage their own background (skip FeatureBackground for these)
const SKIP_ROUTES = new Set(['/forecast']);

export function FeatureBackground() {
  const pathname = usePathname();
  const segment = '/' + (pathname?.split('/')[1] ?? '');

  const [current, setCurrent] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (SKIP_ROUTES.has(segment)) {
      setVisible(false);
      return;
    }
    const image = BACKGROUNDS[segment] ?? null;
    if (image === current) return;

    // Cross-fade: fade out → swap → fade in
    setVisible(false);
    const t = setTimeout(() => {
      setCurrent(image);
      setNext(null);
      if (image) setVisible(true);
    }, 350);
    return () => clearTimeout(t);
  }, [segment]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current && !next) return null;

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        pointerEvents: 'none',
        backgroundImage: current ? `url(${current})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        opacity: visible ? 0.14 : 0,
        transition: 'opacity 400ms ease',
        // Subtle bottom fade so content doesn't get lost near footer
        maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
      }}
    />
  );
}
