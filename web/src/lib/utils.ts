import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNow } from 'date-fns';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number | string | null | undefined): string {
  const n = Number(amount);
  const safe = isFinite(n) && amount !== null && amount !== undefined && amount !== '' ? n : 0;
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(safe);
}

export function formatNumber(value: number | null | undefined, decimals = 0): string {
  const safe = typeof value === 'number' && isFinite(value) ? value : 0;
  return new Intl.NumberFormat('he-IL', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(safe);
}

// date-fns v4's format() throws RangeError on an invalid date rather than
// returning a placeholder, so a single malformed/absent timestamp anywhere in
// a list would take down the whole page. These mirror the defensive handling
// formatCurrency/formatNumber already apply to numbers.
const INVALID_DATE_PLACEHOLDER = '—';

function toValidDate(date: string | Date | null | undefined): Date | null {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(date: string | Date | null | undefined, fmt = 'dd/MM/yyyy'): string {
  const d = toValidDate(date);
  return d ? format(d, fmt) : INVALID_DATE_PLACEHOLDER;
}

// Israeli bi-monthly VAT filing periods are FIXED legal pairs (Jan-Feb,
// Mar-Apr, May-Jun, Jul-Aug, Sep-Oct, Nov-Dec) — not a sliding window from
// whatever month is selected. Given any 1-indexed month, returns the pair's
// first (odd) month. Mirrors backend/src/services/finance/vat.service.js's
// periodStartMonth normalization — shared here so the two frontend VAT pages
// (finance/_tabs/VatTab.tsx and vat-report/page.tsx) can't drift out of sync
// with it or each other again, as already happened once.
export function getBiMonthlyPeriodStartMonth(month: number): number {
  return month % 2 === 0 ? month - 1 : month;
}

export function formatDateTime(date: string | Date | null | undefined): string {
  const d = toValidDate(date);
  return d ? format(d, 'dd/MM/yyyy HH:mm') : INVALID_DATE_PLACEHOLDER;
}

export function timeAgo(date: string | Date | null | undefined): string {
  const d = toValidDate(date);
  return d ? formatDistanceToNow(d, { addSuffix: true }) : INVALID_DATE_PLACEHOLDER;
}

export function formatPercent(value: number | null | undefined, decimals = 1): string {
  const safe = typeof value === 'number' && isFinite(value) ? value : 0;
  return `${safe.toFixed(decimals)}%`;
}

export function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

// The anchor must be in the document for Firefox to honour a synthetic click,
// and the object URL must outlive that click — revoking it synchronously
// cancelled the download before it started in Firefox/Safari. This is the only
// export path in the app (Excel exports for employees, inventory, invoices,
// shifts, VAT/P&L and the full-data dump), so both details matter everywhere.
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.rel      = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

export function getErrorMessage(error: unknown): string {
  // Axios errors are `instanceof Error` too, so the backend's structured
  // message (response.data.error/message) must be checked first — otherwise
  // it's always shadowed by axios's generic "Request failed with status
  // code N" from error.message, and every backend-supplied error string is
  // silently discarded.
  if (typeof error === 'object' && error !== null) {
    const e = error as {
      response?: { status?: number; data?: { error?: string; message?: string } };
      code?: string;
    };
    const backendMessage = e.response?.data?.error || e.response?.data?.message;
    if (backendMessage) return backendMessage;

    // Statuses the API answers with no body, which otherwise surface as axios's
    // "Request failed with status code N" — or as nothing at all, leaving a
    // blank screen with no explanation. The rate limiter is the one people
    // actually reach: 500 requests per 15 minutes, and some pages fire 4-8
    // calls each, so navigating quickly between reports can hit it.
    const status = e.response?.status;
    if (status === 429) return 'יותר מדי בקשות בזמן קצר — המתן רגע ורענן את הדף';
    if (status === 502 || status === 503 || status === 504) {
      return 'השרת אינו זמין כרגע — נסה שוב בעוד רגע';
    }
    if (status === 413) return 'הקובץ גדול מדי';
    if (!e.response && (e.code === 'ERR_NETWORK' || e.code === 'ECONNABORTED')) {
      return 'אין חיבור לשרת — בדוק את החיבור לאינטרנט ונסה שוב';
    }
  }
  if (error instanceof Error) return error.message;
  return 'שגיאה לא ידועה';
}
