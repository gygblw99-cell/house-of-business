'use client';
import { useCallback, useEffect, useRef, useState, memo } from 'react';
import {
  Images, Search, X, FileText, Truck, ClipboardList,
  TrendingUp, FolderOpen, ChevronLeft, ChevronRight,
  ExternalLink, Trash2, Loader2, Sparkles, AlertTriangle, Upload,
} from 'lucide-react';
import api from '@/lib/api/client';
import { getErrorMessage } from '@/lib/utils';
import { DateRangePicker } from '@/components/ui/DatePicker';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import { useImgToken, withImgToken } from '@/hooks/useImgToken';
import { useLatestRequest } from '@/hooks/useLatestRequest';

// ── Types ─────────────────────────────────────────────────────
interface GalleryItem {
  id: string;
  image_url: string;
  category: string;
  title: string | null;
  description: string | null;
  entity_id: string | null;
  entity_type: string | null;
  upload_date: string;
}

interface GalleryResult {
  items: GalleryItem[];
  total: number;
  page: number;
  pages: number;
  parsed?: { category: string | null; search: string | null; dateFrom: string | null; dateTo: string | null };
}

// ── Category config ───────────────────────────────────────────
const CATEGORIES = [
  { key: 'all',      label: 'הכל',         icon: FolderOpen,    color: '#c9a227' },
  { key: 'invoices', label: 'חשבוניות',    icon: FileText,      color: '#60a5fa' },
  { key: 'suppliers',label: 'ספקים',       icon: Truck,         color: '#a78bfa' },
  { key: 'tasks',    label: 'משימות',      icon: ClipboardList, color: '#34d399' },
  { key: 'finance',  label: 'פיננסים',     icon: TrendingUp,    color: '#fb923c' },
  { key: 'other',    label: 'אחר',         icon: FolderOpen,    color: '#94a3b8' },
];

function getCategoryConfig(key: string) {
  return CATEGORIES.find(c => c.key === key) || CATEGORIES[CATEGORIES.length - 1];
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function isPDF(url: string) {
  return /\.pdf$/i.test(url);
}

// ── Gallery Card — own error state so it retries when imgToken changes ────────
const GalleryCard = memo(function GalleryCard({ item, imgToken, onDelete, onOpen, onRefreshToken }: {
  item: GalleryItem;
  imgToken: string | null;
  onDelete: (id: string) => void;
  onOpen:   (item: GalleryItem) => void;
  onRefreshToken: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  const retriedRef = useRef(false);
  // When the token changes (including after a forced refresh), clear error so the img retries.
  useEffect(() => { setImgError(false); retriedRef.current = false; }, [imgToken]);

  const handleImgError = useCallback(() => {
    // First failure: force-refresh the token in case the backend restarted and
    // invalidated the cached token. If it was a real 401 the new token will fix it.
    // If the image is genuinely missing (404/500) the retry will also fail, and
    // then we show the "תמונה לא זמינה" error state.
    if (!retriedRef.current) {
      retriedRef.current = true;
      onRefreshToken();
    } else {
      setImgError(true);
    }
  }, [onRefreshToken]);

  const cat = getCategoryConfig(item.category);
  // /uploads/ URLs are auth-gated — never attempt to load them without a token
  // (the backend returns 401 and the browser shows a broken image icon or fires
  // onError, marking the image as failed permanently for this render cycle).
  const needsToken  = item.image_url.includes('/uploads/');
  const tokenReady  = !needsToken || imgToken !== null;

  return (
    <div
      className="group rounded-2xl overflow-hidden cursor-pointer transition-all"
      style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}
      onClick={() => onOpen(item)}
    >
      <div className="relative" style={{ aspectRatio: '3/4', background: 'rgba(0,0,0,0.3)' }}>
        {isPDF(item.image_url) ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <FileText className="w-8 h-8" style={{ color: cat.color }} />
            <span className="text-xs" style={{ color: 'rgba(232,232,228,0.4)' }}>PDF</span>
          </div>
        ) : imgError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center"
            style={{ background: 'rgba(30,20,10,0.85)' }}>
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor"
              style={{ color: 'rgba(201,162,39,0.6)' }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <span className="text-xs font-medium" style={{ color: 'rgba(232,232,228,0.7)' }}>תמונה לא זמינה</span>
          </div>
        ) : !tokenReady ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'rgba(201,162,39,0.3)' }} />
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={withImgToken(item.image_url, imgToken)}
            alt={item.title || ''}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-contain transition-transform group-hover:scale-[1.02]"
            style={{ background: '#111' }}
            onError={handleImgError}
          />
        )}
        <div
          className="absolute top-2 right-2 flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold"
          style={{ background: `${cat.color}22`, border: `1px solid ${cat.color}40`, color: cat.color }}
        >
          <cat.icon className="w-2.5 h-2.5" />
          {cat.label}
        </div>
        <button
          onClick={e => { e.stopPropagation(); onDelete(item.id); }}
          className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
          style={{ background: 'rgba(239,68,68,0.2)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          <Trash2 className="w-3 h-3 text-red-400" />
        </button>
      </div>
      <div className="p-2.5">
        <p className="text-xs font-semibold truncate" style={{ color: 'rgba(232,232,228,0.8)' }}>
          {item.title || cat.label}
        </p>
        <p className="text-xs mt-0.5" style={{ color: 'rgba(232,232,228,0.35)' }}>
          {formatDate(item.upload_date)}
        </p>
      </div>
    </div>
  );
});

// ── Main Page ─────────────────────────────────────────────────
export default function GalleryPage() {
  const { confirm, toast } = useAppDialog();
  const [imgToken, refreshToken] = useImgToken();
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);

  const [category, setCategory] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');
  const [search, setSearch]     = useState('');
  const [smartQuery, setSmartQuery] = useState('');
  const [parsedHint, setParsedHint] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [smartLoading, setSmartLoading] = useState(false);
  const [lightbox, setLightbox] = useState<GalleryItem | null>(null);
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const smartRef    = useRef<HTMLInputElement>(null);
  const uploadRef   = useRef<HTMLInputElement>(null);
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevDateRef   = useRef({ dateFrom: '', dateTo: '' });
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingCategory, setPendingCategory] = useState('other');
  const [pendingPreview, setPendingPreview] = useState<string | null>(null);

  // Fetch gallery
  const beginRequest = useLatestRequest();

  const fetchGallery = useCallback(async (opts: {
    cat?: string; q?: string; from?: string; to?: string; p?: number;
  } = {}) => {
    const latest = beginRequest();
    setLoading(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams();
      const cat = opts.cat ?? category;
      const from = opts.from ?? dateFrom;
      const to = opts.to ?? dateTo;
      const pg = opts.p ?? page;
      if (cat && cat !== 'all') params.set('category', cat);
      if (opts.q)   params.set('search', opts.q);
      if (from)     params.set('dateFrom', from);
      if (to)       params.set('dateTo', to);
      params.set('page', String(pg));
      params.set('limit', '40');
      const { data } = await api.get<GalleryResult>(`/gallery?${params}`);
      latest(() => {
        setItems(data.items);
        setTotal(data.total);
        setPages(data.pages);
      });
    } catch {
      latest(() => setFetchError('שגיאה בטעינת הגלריה — נסה לרענן'));
    }
    latest(() => setLoading(false));
  }, [category, dateFrom, dateTo, page, beginRequest]);

  // Fetch category counts
  useEffect(() => {
    api.get('/gallery/categories').then(({ data }) => {
      const map: Record<string, number> = { all: data.total };
      data.categories.forEach((c: { category: string; count: number }) => {
        map[c.category] = c.count;
      });
      setCategoryCounts(map);
    }).catch(() => {});
  }, []);

  // Debounce gallery refetch — immediate for category/page changes, 400 ms for date changes
  useEffect(() => {
    const datesChanged = prevDateRef.current.dateFrom !== dateFrom || prevDateRef.current.dateTo !== dateTo;
    prevDateRef.current = { dateFrom, dateTo };
    if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current);
    fetchTimerRef.current = setTimeout(() => fetchGallery(), datesChanged ? 400 : 0);
    return () => { if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current); };
  }, [fetchGallery]);

  // תמונות חדשות מגיעות מהעלאת חשבוניות וצירופי משימות
  useSyncEvent(['invoice_uploaded', 'task.updated'], () => fetchGallery());

  // Category click — state change drives the useEffect, no direct fetchGallery call needed
  const handleCategory = (k: string) => {
    setCategory(k);
    setPage(1);
    setParsedHint(null);
    setSmartQuery('');
  };

  // Regular search
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setParsedHint(null);
    fetchGallery({ q: search, p: 1 });
  };

  // Smart AI search
  const handleSmartSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!smartQuery.trim()) return;
    setSmartLoading(true);
    try {
      const { data } = await api.post<GalleryResult>('/gallery/smart-search', { query: smartQuery });
      setItems(data.items);
      setTotal(data.total);
      setPages(data.pages);
      setPage(1);
      if (data.parsed) {
        const hints: string[] = [];
        if (data.parsed.category) hints.push(`קטגוריה: ${getCategoryConfig(data.parsed.category).label}`);
        if (data.parsed.search)   hints.push(`חיפוש: "${data.parsed.search}"`);
        if (data.parsed.dateFrom) hints.push(`מ-${data.parsed.dateFrom}`);
        if (data.parsed.dateTo)   hints.push(`עד-${data.parsed.dateTo}`);
        setParsedHint(hints.length ? hints.join(' | ') : null);
      }
    } catch (err) { toast(getErrorMessage(err) || 'חיפוש חכם נכשל', 'error'); }
    setSmartLoading(false);
  };

  const clearSmartSearch = () => {
    setSmartQuery('');
    setParsedHint(null);
    setPage(1);
  };

  const handleDelete = async (id: string) => {
    if (!await confirm('למחוק תמונה זו מהגלריה?', 'מחיקת תמונה', 'מחק')) return;
    const removed = items.find(i => i.id === id);
    setItems(prev => prev.filter(i => i.id !== id));
    if (lightbox?.id === id) setLightbox(null);
    try {
      await api.delete(`/gallery/${id}`);
    } catch {
      if (removed) setItems(prev => [...prev, removed]);
      toast('שגיאה במחיקה — נסה שנית', 'error');
    }
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPendingFile(file);
    setPendingCategory('other');
    if (!isPDF(file.name)) {
      const url = URL.createObjectURL(file);
      setPendingPreview(url);
    } else {
      setPendingPreview(null);
    }
    if (uploadRef.current) uploadRef.current.value = '';
  };

  const handleConfirmUpload = async () => {
    if (!pendingFile) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('image', pendingFile);
      fd.append('category', pendingCategory);
      await api.post('/gallery/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      fetchGallery();
      toast('התמונה הועלתה לגלריה ✓', 'success');
      if (pendingPreview) URL.revokeObjectURL(pendingPreview);
      setPendingFile(null);
      setPendingPreview(null);
    } catch (err) {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'העלאה נכשלה', 'error');
    } finally {
      setUploading(false);
    }
  };

  const handleCancelUpload = () => {
    if (pendingPreview) URL.revokeObjectURL(pendingPreview);
    setPendingFile(null);
    setPendingPreview(null);
  };

  const inp: React.CSSProperties = {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(201,162,39,0.2)',
    borderRadius: '10px',
    color: 'rgba(232,232,228,0.85)',
    padding: '9px 12px',
    fontSize: '13px',
    outline: 'none',
  };

  return (
    <div className="flex flex-col h-full" style={{ color: 'rgba(232,232,228,0.9)' }}>

      {/* ── Header ── */}
      <div className="flex-shrink-0 mb-5">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-3">
            <Images className="w-6 h-6" style={{ color: '#c9a227' }} />
            <h1 className="text-2xl font-black">גלריה</h1>
          </div>
          <button
            onClick={() => uploadRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors disabled:opacity-50"
            style={{ background: 'rgba(201,162,39,0.12)', border: '1px solid rgba(201,162,39,0.25)', color: '#c9a227' }}
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
            העלאה
          </button>
          <input ref={uploadRef} type="file" accept="image/*,.pdf" className="hidden" onChange={handleUpload} />
        </div>
        <p style={{ color: 'rgba(232,232,228,0.35)', fontSize: 13 }}>
          כל התמונות שהועלו לפלטפורמה — {total.toLocaleString()} פריטים
        </p>
      </div>

      {/* ── Smart search ── */}
      <form onSubmit={handleSmartSearch} className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <Sparkles className="w-4 h-4 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(201,162,39,0.5)' }} />
          <input
            ref={smartRef}
            value={smartQuery}
            onChange={e => setSmartQuery(e.target.value)}
            placeholder='חיפוש חכם: "חשבונית של ספק כהן מינואר 2025"'
            style={{ ...inp, paddingRight: 34, width: '100%' }}
          />
          {smartQuery && (
            <button type="button" onClick={clearSmartSearch}
              className="absolute left-3 top-1/2 -translate-y-1/2">
              <X className="w-3.5 h-3.5" style={{ color: 'rgba(232,232,228,0.3)' }} />
            </button>
          )}
        </div>
        <button
          type="submit"
          disabled={smartLoading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-all"
          style={{
            background: 'rgba(201,162,39,0.15)',
            border: '1px solid rgba(201,162,39,0.3)',
            color: '#c9a227',
          }}
        >
          {smartLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
          חפש
        </button>
      </form>

      {parsedHint && (
        <div
          className="mb-3 px-3 py-2 rounded-xl text-xs flex items-center gap-2"
          style={{ background: 'rgba(201,162,39,0.07)', border: '1px solid rgba(201,162,39,0.15)', color: 'rgba(201,162,39,0.8)' }}
        >
          <Sparkles className="w-3 h-3 flex-shrink-0" />
          זיהוי אוטומטי: {parsedHint}
          <button onClick={clearSmartSearch} className="mr-auto">
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* ── Regular search + date ── */}
      <form onSubmit={handleSearch} className="mb-4 flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="w-3.5 h-3.5 absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'rgba(232,232,228,0.3)' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="חיפוש רגיל — שם, תיאור..."
            style={{ ...inp, paddingRight: 30, width: '100%' }} />
        </div>
        <DateRangePicker
          from={dateFrom} to={dateTo}
          onFromChange={v => { setDateFrom(v); setPage(1); fetchGallery({ from: v, p: 1 }); }}
          onToChange={v   => { setDateTo(v);   setPage(1); fetchGallery({ to: v,   p: 1 }); }}
        />
        <button type="submit"
          className="px-4 py-2 rounded-xl text-xs font-semibold"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(232,232,228,0.6)' }}>
          סנן
        </button>
      </form>

      {/* ── Category tabs ── */}
      <div className="flex gap-2 flex-wrap mb-5">
        {CATEGORIES.map(({ key, label, icon: Icon, color }) => {
          const active = category === key;
          const count  = categoryCounts[key];
          return (
            <button
              key={key}
              onClick={() => handleCategory(key)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-all"
              style={{
                background: active ? `${color}18` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${active ? color + '40' : 'rgba(255,255,255,0.07)'}`,
                color: active ? color : 'rgba(232,232,228,0.4)',
              }}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
              {count != null && (
                <span className="px-1.5 rounded-full text-xs"
                  style={{ background: active ? `${color}20` : 'rgba(255,255,255,0.06)', color: active ? color : 'rgba(232,232,228,0.3)' }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Grid ── */}
      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'rgba(201,162,39,0.5)' }} />
        </div>
      ) : fetchError ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'rgba(232,232,228,0.4)' }}>
          <AlertTriangle className="w-10 h-10" style={{ color: '#ef4444' }} />
          <p className="text-sm">{fetchError}</p>
          <button onClick={() => fetchGallery()} className="text-xs px-4 py-2 rounded-xl" style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227' }}>
            נסה שנית
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3" style={{ color: 'rgba(232,232,228,0.25)' }}>
          <Images className="w-12 h-12" />
          <p className="text-sm">אין תמונות בגלריה</p>
          <p className="text-xs">תמונות שתעלה לחשבוניות ולפיצ'רים אחרים יופיעו כאן</p>
        </div>
      ) : (
        <>
          <div className="flex-1 grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', alignContent: 'start' }}>
            {items.map(item => (
              <GalleryCard
                key={item.id}
                item={item}
                imgToken={imgToken}
                onDelete={handleDelete}
                onOpen={setLightbox}
                onRefreshToken={refreshToken}
              />
            ))}
          </div>

          {/* Pagination */}
          {pages > 1 && (
            <div className="flex items-center justify-center gap-3 mt-6 py-4">
              <button
                onClick={() => { setPage(p => p - 1); fetchGallery({ p: page - 1 }); }}
                disabled={page <= 1}
                className="p-2 rounded-xl transition-all"
                style={{ background: page <= 1 ? 'rgba(255,255,255,0.03)' : 'rgba(201,162,39,0.1)', border: '1px solid rgba(201,162,39,0.15)', color: page <= 1 ? 'rgba(232,232,228,0.2)' : '#c9a227' }}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
              <span className="text-sm" style={{ color: 'rgba(232,232,228,0.5)' }}>{page} / {pages}</span>
              <button
                onClick={() => { setPage(p => p + 1); fetchGallery({ p: page + 1 }); }}
                disabled={page >= pages}
                className="p-2 rounded-xl transition-all"
                style={{ background: page >= pages ? 'rgba(255,255,255,0.03)' : 'rgba(201,162,39,0.1)', border: '1px solid rgba(201,162,39,0.15)', color: page >= pages ? 'rgba(232,232,228,0.2)' : '#c9a227' }}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>
          )}
        </>
      )}

      {/* ── Upload category picker ── */}
      {pendingFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.8)' }}
          onClick={handleCancelUpload}
        >
          <div
            className="rounded-2xl flex flex-col w-full"
            style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.2)', maxWidth: 420 }}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <span className="font-bold text-sm" style={{ color: 'rgba(232,232,228,0.9)' }}>בחר קטגוריה לתמונה</span>
              <button onClick={handleCancelUpload} style={{ color: 'rgba(232,232,228,0.4)' }}>
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Preview */}
            <div className="flex items-center justify-center p-4" style={{ minHeight: 140, background: 'rgba(0,0,0,0.3)' }}>
              {pendingPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={pendingPreview} alt="" className="max-h-32 max-w-full object-contain rounded-xl" />
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <FileText className="w-10 h-10" style={{ color: 'rgba(201,162,39,0.5)' }} />
                  <span className="text-xs" style={{ color: 'rgba(232,232,228,0.4)' }}>{pendingFile.name}</span>
                </div>
              )}
            </div>

            {/* Category picker */}
            <div className="px-5 pb-4 pt-3">
              <p className="text-xs mb-3" style={{ color: 'rgba(232,232,228,0.4)' }}>קטגוריה:</p>
              <div className="grid grid-cols-2 gap-2 mb-5">
                {CATEGORIES.filter(c => c.key !== 'all').map(({ key, label, icon: Icon, color }) => (
                  <button
                    key={key}
                    onClick={() => setPendingCategory(key)}
                    className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold transition-all"
                    style={{
                      background: pendingCategory === key ? `${color}18` : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${pendingCategory === key ? color + '50' : 'rgba(255,255,255,0.08)'}`,
                      color: pendingCategory === key ? color : 'rgba(232,232,228,0.45)',
                    }}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              <button
                onClick={handleConfirmUpload}
                disabled={uploading}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-50"
                style={{ background: 'rgba(201,162,39,0.15)', border: '1px solid rgba(201,162,39,0.3)', color: '#c9a227' }}
              >
                {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                העלה לגלריה
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightbox && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.85)' }}
          onClick={() => setLightbox(null)}
        >
          <div
            className="relative rounded-2xl overflow-hidden flex flex-col"
            style={{ background: '#050507', border: '1px solid rgba(201,162,39,0.2)', maxWidth: 780, width: '100%', maxHeight: '90vh' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Lightbox header */}
            <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="flex items-center gap-2.5">
                {(() => { const c = getCategoryConfig(lightbox.category); return <c.icon className="w-4 h-4" style={{ color: c.color }} />; })()}
                <span className="font-bold text-sm" style={{ color: 'rgba(232,232,228,0.9)' }}>
                  {lightbox.title || getCategoryConfig(lightbox.category).label}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <a href={withImgToken(lightbox.image_url, imgToken)} target="_blank" rel="noreferrer"
                  className="p-2 rounded-lg" style={{ color: 'rgba(201,162,39,0.6)' }}>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
                <button onClick={() => handleDelete(lightbox.id)} className="p-2 rounded-lg text-red-400/60">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => setLightbox(null)} className="p-2 rounded-lg"
                  style={{ color: 'rgba(232,232,228,0.4)' }}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Lightbox image */}
            <div className="flex-1 overflow-auto flex items-center justify-center" style={{ minHeight: 300, background: 'rgba(0,0,0,0.4)' }}>
              {isPDF(lightbox.image_url) ? (
                <iframe src={withImgToken(lightbox.image_url, imgToken)} className="w-full" style={{ height: 500, border: 'none' }} />
              ) : (lightbox.image_url.includes('/uploads/') && !imgToken) ? (
                <Loader2 className="w-8 h-8 animate-spin" style={{ color: 'rgba(201,162,39,0.3)' }} />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={withImgToken(lightbox.image_url, imgToken)} alt={lightbox.title || ''} decoding="async" className="max-w-full max-h-[82vh] object-contain p-2" />
              )}
            </div>

            {/* Lightbox meta */}
            <div className="px-5 py-4 space-y-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
              {lightbox.description && (
                <p className="text-sm" style={{ color: 'rgba(232,232,228,0.55)' }}>{lightbox.description}</p>
              )}
              <div className="flex items-center gap-4 text-xs" style={{ color: 'rgba(232,232,228,0.3)' }}>
                <span>{formatDate(lightbox.upload_date)}</span>
                {lightbox.entity_type && <span>סוג: {lightbox.entity_type}</span>}
                {lightbox.entity_id && lightbox.entity_type === 'invoice' && (
                  <a href={`/invoices`} className="underline" style={{ color: 'rgba(201,162,39,0.6)' }}>
                    פתח חשבונית ←
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
