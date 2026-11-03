'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncEvent } from '@/context/SyncContext';
import {
  Plus, Search, Trash2, Mail, CheckCircle, Clock, XCircle,
  ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Package, Loader2, Bell, Send,
  AlertTriangle, ThumbsUp, History, X as XIcon,
  Sparkles, ArrowRight, Star,
  ExternalLink } from 'lucide-react';
import { priceComparisonApi, suppliersApi, inventoryApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';

// Supplier links originate from AI output whose own input is arbitrary
// third-party web content, so they are not trusted enough to hand straight to
// an href. The backend applies the same allowlist; this is the second layer,
// because a stored result from before that fix still flows through here.
function safeUrl(value?: string | null): string {
  if (!value) return '';
  try {
    const u = new URL(value.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useAppDialog } from '@/context/AppDialogContext';

// ── Types ───────────────────────────────────────────────────────────────────
interface Outreach {
  id: string; supplier_name: string; supplier_email: string;
  is_existing: boolean; replied_at: string | null; reply_content: string | null; approved: boolean | null;
  last_attempt_at: string | null; created_at: string;
}
interface PriceRequest {
  id: string; search_type: string; search_query: string; status: string;
  result_data: unknown; created_at: string; outreach_count: number; replies_count: number;
  outreach?: Outreach[];
}
interface Supplier { id: string; name: string; email?: string; }
interface InventoryItem { id: string; name: string; unit: string; cost_per_unit?: number; }
interface ManualSupplier { name: string; email: string; }
interface PriceSupplier {
  name: string; price: string; priceWithDelivery?: string; link?: string; type?: string;
  minOrder?: string; source?: string;
  location?: string; deliveryFee?: string; deliveryAvailable?: boolean; isReachable?: boolean;
}
interface MarketInsight {
  typicalRestaurantCost?: string;
  bestBuyingStrategy?: string;
  seasonalNote?: string;
  portionCost?: string;
}
interface LocationInsight {
  nearbySuppliers?: string[];
  shippingNote?: string;
  distanceWarnings?: string[];
}
interface KnownSupplier { name: string; domain: string; type: string; recommended?: boolean; }
interface SearchResult {
  cheapestPrice: { price: string; source: string; link?: string; note?: string } | null;
  priceRange: { min?: string; max?: string; unit?: string };
  suppliers: PriceSupplier[];
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  marketInsight?: MarketInsight;
  locationInsight?: LocationInsight;
  knownIsraeliSuppliers?: KnownSupplier[];
  requestId?: string;
}

interface BasketItem { id: string; name: string; unit: string; qty: string; }
interface PriceAlert { id: string; search_query: string; target_price: string; unit: string; notify_email: string | null; is_active: boolean; created_at: string; }

type WizardStep = 'query' | 'searching' | 'results' | 'sending' | 'sent' | 'basket';
type WizardMode = 'single' | 'basket';

// ── Stage/Status definitions ────────────────────────────────────────────────
const REQUEST_STAGES = [
  { key: 'created',   label: 'נוצרה',   icon: Plus },
  { key: 'searching', label: 'חיפוש',   icon: Search },
  { key: 'sent',      label: 'נשלח',    icon: Send },
  { key: 'awaiting',  label: 'ממתין',   icon: Clock },
  { key: 'done',      label: 'הושלם',   icon: CheckCircle },
];
const STATUS_TO_STAGE: Record<string, number> = {
  searching: 1, awaiting_reply: 3, completed: 4, no_result: 4,
};
const STATUS_STYLE: Record<string, { label: string; gradient: string; badge: string; dot: string }> = {
  searching:      { label: 'בחיפוש',         gradient: 'from-blue-500 to-cyan-500',    badge: 'bg-blue-500/15 text-blue-300',      dot: 'bg-blue-500' },
  awaiting_reply: { label: 'ממתין לתשובות', gradient: 'from-amber-400 to-orange-500', badge: 'bg-amber-500/15 text-amber-300',    dot: 'bg-amber-500' },
  completed:      { label: 'הושלם',          gradient: 'from-emerald-500 to-teal-500', badge: 'bg-emerald-500/15 text-emerald-300',dot: 'bg-emerald-500' },
  no_result:      { label: 'אין תוצאות',     gradient: 'from-slate-400 to-slate-500',  badge: 'bg-white/5 text-gray-400',          dot: 'bg-slate-400' },
};


const fmtDate = (d: string) => new Date(d).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
const fmtTime = (d: string) => new Date(d).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

// ── Manual supplier row ───────────────────────────────────────────────────────
function ManualSupplierRow({ idx, sup, onChange, onRemove }: {
  idx: number; sup: ManualSupplier;
  onChange: (field: 'name' | 'email', val: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
      <span className="w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(129,140,248,0.15)', color: '#818cf8' }}>{idx + 1}</span>
      <input
        type="text" placeholder="שם הספק"
        value={sup.name}
        onChange={e => onChange('name', e.target.value)}
        className="flex-1 text-sm border-0 focus:outline-none bg-transparent placeholder-slate-600" style={{ color: '#e8e8e4' }}
      />
      <input
        type="email" placeholder="כתובת מייל"
        value={sup.email}
        onChange={e => onChange('email', e.target.value)}
        className="flex-1 text-sm border-0 focus:outline-none bg-transparent placeholder-slate-600 text-left" style={{ color: '#e8e8e4' }}
        dir="ltr"
      />
      <button onClick={onRemove} className="text-slate-300 hover:text-red-400 transition-colors flex-shrink-0">
        <XIcon className="w-4 h-4" />
      </button>
    </div>
  );
}

// ── Outreach row ─────────────────────────────────────────────────────────────
function OutreachRow({ o, onMarkReply }: { o: Outreach; onMarkReply: (reply: string) => void }) {
  const sentAt     = new Date(o.last_attempt_at || o.created_at);
  const expectedAt = new Date(sentAt.getTime() + 3 * 24 * 60 * 60 * 1000);
  const now        = new Date();
  const isOverdue  = !o.replied_at && now > expectedAt;
  const daysLeft   = Math.ceil((expectedAt.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  const STEPS = [
    {
      label: 'נשלח', sublabel: `${fmtDate(sentAt.toISOString())} · ${fmtTime(sentAt.toISOString())}`,
      done: true, color: 'bg-blue-500', ring: 'ring-blue-200',
      icon: <Send className="w-3 h-3 text-white" />,
    },
    {
      label: o.replied_at ? 'נענה' : isOverdue ? 'באיחור' : 'ממתין לתשובה',
      sublabel: o.replied_at
        ? `${fmtDate(o.replied_at)} · ${fmtTime(o.replied_at)}`
        : isOverdue ? 'עבר המועד הצפוי'
        : `צפוי ${fmtDate(expectedAt.toISOString())} · עוד ${daysLeft} ימים`,
      done: !!o.replied_at, active: !o.replied_at, overdue: isOverdue,
      color: o.replied_at ? 'bg-emerald-500' : isOverdue ? 'bg-red-500' : 'bg-amber-400',
      ring: o.replied_at ? 'ring-emerald-200' : isOverdue ? 'ring-red-200' : 'ring-amber-200',
      icon: o.replied_at
        ? <CheckCircle className="w-3 h-3 text-white" />
        : isOverdue ? <AlertTriangle className="w-3 h-3 text-white" />
        : <Clock className="w-3 h-3 text-white" />,
    },
    ...(o.replied_at ? [{
      label: o.approved ? 'אושרה הצעה' : 'ממתין לאישור',
      sublabel: o.approved ? 'ההצעה אושרה' : 'בדוק את ההצעה',
      done: !!o.approved, active: !o.approved,
      color: o.approved ? 'bg-violet-500' : 'bg-slate-300',
      ring: o.approved ? 'ring-violet-200' : 'ring-slate-200',
      icon: <ThumbsUp className="w-3 h-3 text-white" />,
    }] : []),
  ];

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid rgba(201,162,39,0.08)' }}>
        <div>
          <p className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>{o.supplier_name}</p>
          <p className="text-xs" style={{ color: '#9aa0ab' }}>{o.supplier_email}</p>
        </div>
        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full ${
          o.replied_at ? 'bg-emerald-500/15 text-emerald-300' :
          isOverdue    ? 'bg-red-500/15 text-red-300' : 'bg-amber-500/15 text-amber-300'
        }`}>
          {o.replied_at ? <CheckCircle className="w-3 h-3" /> : isOverdue ? <XCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
          {o.replied_at ? 'ענה' : isOverdue ? 'באיחור' : 'ממתין'}
        </span>
      </div>
      <div className="px-4 py-3">
        {STEPS.map((s, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ring-4 ${s.color} ${s.ring}`}>
                {s.icon}
              </div>
              {i < STEPS.length - 1 && <div className="w-0.5 flex-1 my-1 min-h-[20px]" style={{ background: s.done ? 'rgba(201,162,39,0.2)' : 'rgba(255,255,255,0.06)' }} />}
            </div>
            <div className="pb-3">
              <p className="text-xs font-semibold" style={{ color: 'overdue' in s && s.overdue ? '#f87171' : s.done ? '#e8e8e4' : '#9aa0ab' }}>{s.label}</p>
              <p className="text-xs mt-0.5" style={{ color: 'overdue' in s && s.overdue ? '#fca5a5' : '#6b7280' }}>{s.sublabel}</p>
            </div>
          </div>
        ))}
      </div>
      {o.reply_content && (
        <div className="mx-4 mb-3 p-3 rounded-xl text-xs" style={{ background: 'rgba(5,150,105,0.1)', border: '1px solid rgba(5,150,105,0.25)', color: '#6ee7b7' }}>
          {o.reply_content}
        </div>
      )}
      {!o.replied_at && (
        <div className="px-4 pb-3">
          <button
            onClick={() => { const r = prompt('הכנס את תגובת הספק:'); if (r) onMarkReply(r); }}
            className="text-xs text-blue-600 hover:text-blue-800 underline underline-offset-2">
            סמן כנענה ידנית
          </button>
        </div>
      )}
    </div>
  );
}

// ── Relative age ─────────────────────────────────────────────────────────────
// Reading the clock during render is impure: the server and the client render
// at different instants, so a request created near midnight can produce
// different text on each side and trip a hydration mismatch. Sampling the time
// in an effect keeps render deterministic and settles on the client's value.
function DaysSince({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { setNow(Date.now()); }, []);
  if (now === null) return null;
  const days = Math.floor((now - new Date(iso).getTime()) / (1000 * 60 * 60 * 24));
  return <>{days === 0 ? 'היום' : `לפני ${days} ימים`}</>;
}

// ── Request card ─────────────────────────────────────────────────────────────
function RequestCard({
  r, expanded, onToggle, detail, onDelete, onMarkReply,
}: {
  r: PriceRequest; expanded: boolean; onToggle: () => void;
  detail?: PriceRequest; onDelete: () => void;
  onMarkReply: (requestId: string, outreachId: string, reply: string) => void;
}) {
  const st      = STATUS_STYLE[r.status] || STATUS_STYLE.no_result;
  const stageIdx = STATUS_TO_STAGE[r.status] ?? 0;
  const repliedPct = r.outreach_count > 0 ? (r.replies_count / r.outreach_count) * 100 : 0;

  return (
    <div className="rounded-2xl overflow-hidden transition-shadow" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
      <div className={`h-1 w-full bg-gradient-to-r ${st.gradient}`} />
      <div className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-bold text-base truncate" style={{ color: '#e8e8e4' }}>{r.search_query}</h3>
              <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full ${st.badge}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${st.dot}`} />{st.label}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-xs flex-wrap" style={{ color: '#9aa0ab' }}>
              <span><DaysSince iso={r.created_at} /></span>
              <span>·</span><span>{r.outreach_count} ספקים</span>
              <span>·</span>
              <span className={r.replies_count > 0 ? 'text-emerald-600 font-medium' : ''}>{r.replies_count}/{r.outreach_count} ענו</span>
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={onToggle} className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors" style={{ color: '#9aa0ab' }}>
              {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            <button onClick={onDelete} className="w-8 h-8 rounded-xl flex items-center justify-center transition-colors" style={{ color: '#6b7280' }}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>
        {/* Stage bar */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            {REQUEST_STAGES.map((stage, i) => {
              const done   = i < stageIdx;
              const active = i === stageIdx;
              const Icon   = stage.icon;
              return (
                <div key={stage.key} className="flex flex-col items-center flex-1">
                  <div className="flex items-center w-full">
                    {i > 0 && <div className={`flex-1 h-0.5 ${i <= stageIdx ? `bg-gradient-to-r ${st.gradient}` : ''}`} style={i > stageIdx ? { background: 'rgba(201,162,39,0.1)' } : {}} />}
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                      done   ? `bg-gradient-to-br ${st.gradient} shadow-sm`
                      : active ? `bg-gradient-to-br ${st.gradient} shadow-md ring-4 ring-opacity-20 ring-blue-300`
                      : ''
                    }`}
                    style={!(done || active) ? { background: '#1a1a22' } : {}}
                    >
                      <Icon className={`w-3.5 h-3.5 ${done || active ? 'text-white' : ''}`} style={!(done || active) ? { color: '#9aa0ab' } : {}} />
                    </div>
                    {i < REQUEST_STAGES.length - 1 && <div className={`flex-1 h-0.5 ${i < stageIdx ? `bg-gradient-to-r ${st.gradient}` : ''}`} style={i >= stageIdx ? { background: 'rgba(201,162,39,0.1)' } : {}} />}
                  </div>
                  <span className="text-[10px] mt-1.5 font-medium" style={{ color: active ? '#e8e8e4' : done ? '#9aa0ab' : '#555a66' }}>{stage.label}</span>
                </div>
              );
            })}
          </div>
        </div>
        {r.outreach_count > 0 && (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(201,162,39,0.12)' }}>
              <div className={`h-full rounded-full bg-gradient-to-r ${st.gradient} transition-all duration-700`} style={{ width: `${repliedPct}%` }} />
            </div>
            <span className="text-xs flex-shrink-0" style={{ color: '#9aa0ab' }}>{Math.round(repliedPct)}% ענו</span>
          </div>
        )}
      </div>
      {expanded && (
        <div className="px-5 py-4" style={{ borderTop: '1px solid rgba(201,162,39,0.1)', background: '#111116' }}>
          {!detail ? (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-4 justify-center">
              <Loader2 className="w-4 h-4 animate-spin" /> טוען פרטים...
            </div>
          ) : !detail.outreach?.length ? (
            <p className="text-sm text-gray-500 text-center py-4">לא נשלחו פניות לספקים</p>
          ) : (
            <div className="space-y-3">
              {/* Task 5: Supplier reply comparison table */}
              {detail.outreach.filter(o => o.replied_at && o.reply_content).length >= 2 && (
                <div className="rounded-xl overflow-hidden mb-4" style={{ border: '1px solid rgba(201,162,39,0.2)' }}>
                  <div className="px-3 py-2" style={{ background: 'rgba(201,162,39,0.1)', borderBottom: '1px solid rgba(201,162,39,0.15)' }}>
                    <p className="text-xs font-bold" style={{ color: '#c9a227' }}>
                      השוואת תגובות ספקים ({detail.outreach.filter(o => o.replied_at).length} ספקים ענו)
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ background: '#111116', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                          <th className="px-3 py-2 text-right font-semibold" style={{ color: '#9aa0ab' }}>ספק</th>
                          <th className="px-3 py-2 text-right font-semibold" style={{ color: '#9aa0ab' }}>תגובה</th>
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: '#9aa0ab' }}>תאריך</th>
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: '#9aa0ab' }}>אושר</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.outreach.filter(o => o.replied_at).map(o => (
                          <tr key={o.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: o.approved ? 'rgba(5,150,105,0.06)' : undefined }}>
                            <td className="px-3 py-2 font-medium" style={{ color: '#e8e8e4' }}>{o.supplier_name}</td>
                            <td className="px-3 py-2 max-w-xs" style={{ color: '#9aa0ab' }}>
                              <p className="truncate" title={o.reply_content || undefined}>{o.reply_content || '—'}</p>
                            </td>
                            <td className="px-3 py-2 text-center whitespace-nowrap" style={{ color: '#6b7280' }}>
                              {o.replied_at ? new Date(o.replied_at).toLocaleDateString('he-IL') : '—'}
                            </td>
                            <td className="px-3 py-2 text-center">
                              {o.approved ? <CheckCircle className="w-4 h-4 mx-auto text-emerald-500" /> : <span style={{ color: '#6b7280' }}>—</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              <p className="text-xs font-semibold uppercase tracking-wide mb-3" style={{ color: '#9aa0ab' }}>מצב ספקים ({detail.outreach.length})</p>
              {detail.outreach.map(o => (
                <OutreachRow key={o.id} o={o} onMarkReply={(reply) => onMarkReply(r.id, o.id, reply)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function PriceComparisonPage() {
  const { confirm, toast } = useAppDialog();
  const [requests, setRequests]     = useState<PriceRequest[]>([]);
  const [suppliers, setSuppliers]   = useState<Supplier[]>([]);
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading]       = useState(true);
  const [expanded, setExpanded]     = useState<string | null>(null);
  const [expandData, setExpandData] = useState<Record<string, PriceRequest>>({});
  const [listSearch, setListSearch] = useState('');
  const [invSearch, setInvSearch]   = useState('');
  const [showHistory, setShowHistory] = useState(false);

  // ── Wizard state ──
  const [showModal, setShowModal]       = useState(false);
  const [wizardStep, setWizardStep]     = useState<WizardStep>('query');
  const [wizardMode, setWizardMode]     = useState<WizardMode>('single');
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchType, setSearchType]     = useState<'item' | 'supplier'>('item');
  const [error, setError]               = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const [searchRequestId, setSearchRequestId] = useState<string | null>(null);
  const [selectedInvItem, setSelectedInvItem] = useState<InventoryItem | null>(null);
  const [manualSuppliers, setManualSuppliers] = useState<ManualSupplier[]>([{ name: '', email: '' }]);
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody]       = useState('');
  const [selectedSupplierIdx, setSelectedSupplierIdx] = useState(0);
  const [supplierEmails, setSupplierEmails] = useState<Record<number, string>>({});
  const [emailExtracting, setEmailExtracting] = useState<Record<number, boolean>>({});
  // ── Basket mode (Task 8) ──
  const [basketItems, setBasketItems]   = useState<BasketItem[]>([]);
  // ── Price alerts (Task 7) ──
  const [showAlerts, setShowAlerts]     = useState(false);
  const [alerts, setAlerts]             = useState<PriceAlert[]>([]);
  const [alertQuery, setAlertQuery]     = useState('');
  const [alertPrice, setAlertPrice]     = useState('');
  const [alertUnit, setAlertUnit]       = useState('ק"ג');
  // ── Export loading (Task 9) ──

  const load = useCallback(() => {
    priceComparisonApi.list().then(({ data }) => { setRequests(Array.isArray(data) ? data : []); setLoading(false); }).catch(() => setLoading(false));
    suppliersApi.list().then(({ data }) => setSuppliers(Array.isArray(data) ? data : (data.items || []))).catch(() => {});
    inventoryApi.list().then(({ data }) => setInventoryItems(data.items || [])).catch(() => {});
    priceComparisonApi.getAlerts().then(({ data }) => setAlerts(Array.isArray(data) ? data : [])).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  // מרענן גם את הבקשה המורחבת (אם פתוחה) — שינויים חיצוניים (למשל תגובת ספק)
  // צריכים להופיע גם בפירוט הפתוח, לא רק ברשימה
  const expandedRef = useRef<string | null>(null);
  useEffect(() => { expandedRef.current = expanded; });
  useSyncEvent(['price_comparison.updated'], useCallback(() => {
    load();
    if (expandedRef.current) {
      priceComparisonApi.get(expandedRef.current).then(({ data }) => {
        setExpandData(prev => ({ ...prev, [expandedRef.current!]: data }));
      }).catch(() => {});
    }
  }, [load]));

  // Auto-extract emails for ALL suppliers as soon as results arrive
  useEffect(() => {
    if (wizardStep !== 'results' || !searchResult?.suppliers?.length) return;
    searchResult.suppliers.forEach((supplier, idx) => {
      if (!supplier?.link) return;
      if (supplierEmails[idx] !== undefined) return;
      if (emailExtracting[idx]) return;
      setEmailExtracting(prev => ({ ...prev, [idx]: true }));
      priceComparisonApi.extractEmail({ url: supplier.link })
        .then(({ data }) => {
          setSupplierEmails(prev => ({ ...prev, [idx]: data.email || '' }));
        })
        .catch(() => {
          setSupplierEmails(prev => ({ ...prev, [idx]: '' }));
        })
        .finally(() => {
          setEmailExtracting(prev => ({ ...prev, [idx]: false }));
        });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wizardStep, searchResult]);

  const toggleExpand = async (id: string) => {
    if (expanded === id) { setExpanded(null); return; }
    setExpanded(id);
    if (!expandData[id]) {
      const { data } = await priceComparisonApi.get(id);
      setExpandData(prev => ({ ...prev, [id]: data }));
    }
  };

  const deleteRequest = async (id: string) => {
    if (!await confirm('האם למחוק בקשה זו?', 'מחיקת בקשה')) return;
    try { await priceComparisonApi.delete(id); load(); }
    catch (err) { toast(getErrorMessage(err)); }
  };

  // מוסיף ספק שנמצא ע"י ה-AI (עם המייל שחולץ אוטומטית, אם יש) לרשימת
  // "שלח דרך הפלטפורמה" — בלי זה, המשתמש היה צריך להקליד ידנית מחדש שם
  // ומייל שכבר נמצאו והוצגו רגע קודם, לכל ספק בנפרד.
  const addSupplierToSendList = (idx: number) => {
    const s = searchResult?.suppliers?.[idx];
    if (!s) return;
    const email = (supplierEmails[idx] || '').trim();
    setManualSuppliers(prev => {
      if (prev.some(m => m.name === s.name && m.email === email)) return prev; // כבר נוסף
      // שורת הפתיחה הריקה מוחלפת (לא נערמת עליה) כדי לא להשאיר שורה ריקה למעלה
      if (prev.length === 1 && !prev[0].name.trim() && !prev[0].email.trim()) {
        return [{ name: s.name, email }];
      }
      return [...prev, { name: s.name, email }];
    });
    toast(`${s.name} נוסף לרשימת השליחה דרך הפלטפורמה`, 'success');
  };

  const markReply = async (requestId: string, outreachId: string, replyContent: string) => {
    try {
      await priceComparisonApi.updateOutreach(requestId, outreachId, { replyContent, approved: true });
      const { data } = await priceComparisonApi.get(requestId);
      setExpandData(prev => ({ ...prev, [requestId]: data }));
      load();
    } catch (err) { toast(getErrorMessage(err)); }
  };

  // ── Step 1 → search: חיפוש מחירים אמיתי ────────────────────
  const handleQuerySubmit = async () => {
    if (!searchQuery.trim()) { setError('יש להזין שם מוצר לחיפוש'); return; }
    const q = searchQuery.trim();
    setError('');
    setWizardStep('searching');
    const body = `שלום רב,

אנו פונים מ[שם המסעדה / העסק].

ברצוננו לקבל הצעת מחיר עבור: ${q}.

נשמח לקבל פרטים על:
• מחיר ליחידה / ק"ג / ליטר
• כמות מינימום להזמנה
• תנאי תשלום ואשראי
• זמני אספקה ואזורי חלוקה

לפרטים ולתיאום:
📞 [מספר הטלפון שלנו]
📧 [המייל שלנו]
📍 [כתובת העסק]

תודה רבה ומצפים לשמוע מכם,
[שם + תפקיד]
[שם המסעדה / העסק]`;
    setEmailSubject(`בקשת הצעת מחיר — ${q}`);
    setEmailBody(body);
    setManualSuppliers([{ name: '', email: '' }]);
    setSelectedSupplierIdx(0);
    setSupplierEmails({});
    setEmailExtracting({});
    setSearchRequestId(null);
    try {
      const { data } = await priceComparisonApi.searchPrices({ searchQuery: q });
      setSearchResult(data);
      if (data.requestId) setSearchRequestId(data.requestId);
      setWizardStep('results');
    } catch (err) {
      // בעבר: כל כשל (רשת/timeout/500) הוצג כ"לא נמצאו תוצאות" — בדיוק אותה
      // הודעה שהשרת מחזיר עבור חיפוש אמיתי שלא מצא כלום. אין שום דרך להבדיל
      // בין "השרת נכשל" לבין "אין נתוני שוק", אז המשתמש לא יודע שכדאי לנסות
      // שוב. חוזרים לשלב השאילתה (שם כבר יש הצגת error) עם הודעה אמיתית.
      setError(getErrorMessage(err) || 'החיפוש נכשל — נסה שנית');
      setWizardStep('query');
    }
  };

  // ── Step results → send emails ───────────────────────────────
  const handleReviewSubmit = async () => {
    const withEmail = manualSuppliers.filter(s => s.email.trim());
    if (withEmail.length === 0) { setError('הכנס לפחות ספק אחד עם כתובת מייל'); return; }
    setError('');
    setWizardStep('sending');
    try {
      await priceComparisonApi.create({
        searchType,
        searchQuery: searchQuery.trim(),
        suppliers: withEmail.map(s => ({ name: s.name || s.email, email: s.email, isExisting: false })),
        emailDraft: { subject: emailSubject, body: emailBody },
        requestId: searchRequestId,
      });
      setWizardStep('sent');
      setTimeout(() => {
        setShowModal(false);
        setWizardStep('query');
        setSearchQuery('');
        setSearchResult(null);
        setManualSuppliers([{ name: '', email: '' }]);
        load();
      }, 2000);
    } catch (err) {
      setError(getErrorMessage(err));
      setWizardStep('results');
    }
  };

  const openModal = () => {
    setShowModal(true); setWizardStep('query'); setWizardMode('single');
    setError(''); setSearchQuery(''); setSearchResult(null);
    setSearchRequestId(null); setSelectedInvItem(null);
    setManualSuppliers([{ name: '', email: '' }]);
    setSelectedSupplierIdx(0);
    setSupplierEmails({});
    setEmailExtracting({});
    setBasketItems([]);
  };

  // ── Task 7: Price alerts ─────────────────────────────────────
  const [alertSaving, setAlertSaving] = useState(false);
  const handleCreateAlert = async () => {
    if (!alertQuery.trim()) { toast('הכנס שם מוצר להתראה', 'error'); return; }
    if (!alertPrice || isNaN(parseFloat(alertPrice))) { toast('הכנס מחיר יעד', 'error'); return; }
    setAlertSaving(true);
    try {
      const { data } = await priceComparisonApi.createAlert({
        searchQuery: alertQuery.trim(),
        targetPrice: parseFloat(alertPrice),
        unit: alertUnit,
      });
      setAlerts(prev => [data, ...prev]);
      setAlertQuery(''); setAlertPrice('');
      toast('התראת מחיר נוצרה', 'success');
    } catch (err) { toast(getErrorMessage(err), 'error'); }
    finally { setAlertSaving(false); }
  };

  const handleDeleteAlert = async (id: string) => {
    if (!await confirm('האם למחוק את התראת המחיר?', 'מחיקת התראה')) return;
    try {
      await priceComparisonApi.deleteAlert(id);
      setAlerts(prev => prev.filter(a => a.id !== id));
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  const handleToggleAlert = async (alert: PriceAlert) => {
    try {
      const { data } = await priceComparisonApi.toggleAlert(alert.id, !alert.is_active);
      setAlerts(prev => prev.map(a => a.id === alert.id ? data : a));
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  // ── Task 8: Basket RFQ submit ────────────────────────────────
  const handleBasketSubmit = async () => {
    const filledItems = basketItems.filter(it => it.name.trim());
    if (filledItems.length === 0) { setError('הכנס לפחות פריט אחד לסל'); return; }
    const withEmail = manualSuppliers.filter(s => s.email.trim());
    if (withEmail.length === 0) { setError('הכנס לפחות ספק אחד עם מייל'); return; }
    setError('');
    setWizardStep('sending');
    const combinedQuery = `סל מוצרים: ${filledItems.map(it => `${it.name}${it.qty ? ` × ${it.qty} ${it.unit || ''}` : ''}`).join(', ')}`;
    const basketBody = `שלום רב,

אנו פונים בבקשה לקבל הצעת מחיר עבור הפריטים הבאים:

${filledItems.map((it, i) => `${i + 1}. ${it.name}${it.qty ? ` — כמות: ${it.qty} ${it.unit || ''}` : ''}`).join('\n')}

נשמח לקבל:
• מחיר ליחידה / ק"ג / ליטר עבור כל פריט
• כמות מינימום להזמנה
• תנאי תשלום ואשראי
• זמני אספקה ואזורי חלוקה

תודה רבה ומצפים לשמוע מכם,
[שם + תפקיד]`;
    try {
      await priceComparisonApi.create({
        searchType: 'item',
        searchQuery: combinedQuery,
        suppliers: withEmail.map(s => ({ name: s.name || s.email, email: s.email, isExisting: false })),
        emailDraft: { subject: `בקשת הצעת מחיר — סל ${filledItems.length} מוצרים`, body: basketBody },
      });
      setWizardStep('sent');
      setTimeout(() => { setShowModal(false); setWizardStep('query'); setBasketItems([]); load(); }, 2000);
    } catch (err) { setError(getErrorMessage(err)); setWizardStep('basket'); }
  };

  const closeModal = () => {
    if (wizardStep === 'searching' || wizardStep === 'sending') return;
    setShowModal(false);
  };

  const ACTIVE_STATUSES = ['searching', 'awaiting_reply'];
  const activeRequests  = requests.filter(r => ACTIVE_STATUSES.includes(r.status));
  const historyRequests = requests.filter(r => !ACTIVE_STATUSES.includes(r.status));
  const filtered        = activeRequests.filter(r => !listSearch.trim() || r.search_query.toLowerCase().includes(listSearch.toLowerCase()));
  const historyGroups   = historyRequests.reduce<Record<string, PriceRequest[]>>((acc, r) => {
    const month = new Date(r.created_at).toLocaleDateString('he-IL', { month: 'long', year: 'numeric' });
    if (!acc[month]) acc[month] = [];
    acc[month].push(r); return acc;
  }, {});

  const sendableCount = manualSuppliers.filter(s => s.email.trim()).length;

  return (
    <div className="space-y-6" dir="rtl">

      {/* History Drawer */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex" dir="rtl">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowHistory(false)} />
          <div className="relative mr-auto h-full w-full max-w-md shadow-2xl flex flex-col overflow-hidden" style={{ background: '#141418', borderLeft: '1px solid rgba(201,162,39,0.2)' }}>
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid rgba(201,162,39,0.14)', background: '#111116' }}>
              <div className="flex items-center gap-2">
                <History className="w-5 h-5" style={{ color: '#c9a227' }} />
                <h2 className="text-lg font-bold" style={{ color: '#e8e8e4' }}>היסטוריית חיפושים</h2>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227' }}>{requests.length}</span>
              </div>
              <button onClick={() => setShowHistory(false)} className="p-1.5 rounded-xl" style={{ color: '#9aa0ab' }}>
                <XIcon className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-0" style={{ borderBottom: '1px solid rgba(201,162,39,0.14)' }}>
              {[
                { label: 'סה"כ', value: historyRequests.length, color: '#c9a227' },
                { label: 'הושלמו', value: historyRequests.filter(r => r.status === 'completed').length, color: '#22c55e' },
                { label: 'תשובות', value: historyRequests.reduce((s, r) => s + Number(r.replies_count), 0), color: '#60b8e8' },
              ].map((s, i) => (
                <div key={i} className="flex flex-col items-center py-3" style={i < 2 ? { borderLeft: '1px solid rgba(201,162,39,0.1)' } : {}}>
                  <span className="text-xl font-bold" style={{ color: s.color }}>{s.value}</span>
                  <span className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>{s.label}</span>
                </div>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
              {Object.entries(historyGroups).map(([month, items]) => (
                <div key={month}>
                  <p className="text-xs font-bold uppercase tracking-wider mb-2 px-1" style={{ color: '#9aa0ab' }}>{month}</p>
                  <div className="space-y-2">
                    {items.map((r) => {
                      const st = STATUS_STYLE[r.status] || STATUS_STYLE.no_result;
                      return (
                        <div key={r.id} className="flex items-start gap-3 p-3 rounded-xl" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.12)' }}>
                          <div className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${st.dot}`} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <p className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{r.search_query}</p>
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${st.badge}`}>{st.label}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-1 text-xs" style={{ color: '#9aa0ab' }}>
                              <span><DaysSince iso={r.created_at} /></span>
                              <span>·</span><span>{r.outreach_count} ספקים</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Price Alerts Drawer */}
      {showAlerts && (
        <div className="fixed inset-0 z-50 flex" dir="rtl">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setShowAlerts(false)} />
          <div className="relative mr-auto h-full w-full max-w-md shadow-2xl flex flex-col overflow-hidden" style={{ background: '#141418', borderLeft: '1px solid rgba(201,162,39,0.2)' }}>
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid rgba(201,162,39,0.14)', background: '#111116' }}>
              <div className="flex items-center gap-2">
                <Bell className="w-5 h-5" style={{ color: '#c9a227' }} />
                <h2 className="text-lg font-bold" style={{ color: '#e8e8e4' }}>התראות מחיר</h2>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227' }}>{alerts.length}</span>
              </div>
              <button onClick={() => setShowAlerts(false)} className="p-1.5 rounded-xl" style={{ color: '#9aa0ab' }}>
                <XIcon className="w-5 h-5" />
              </button>
            </div>

            {/* New alert form */}
            <div className="px-5 py-4 space-y-2.5" style={{ borderBottom: '1px solid rgba(201,162,39,0.14)' }}>
              <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>קבל התראה כאשר נמצא מחיר נמוך מהיעד</p>
              <input value={alertQuery} onChange={e => setAlertQuery(e.target.value)} placeholder="שם המוצר (למשל: עגבניות)"
                className="w-full px-3 py-2 rounded-xl text-sm" style={{ background: '#0d0d10', border: '1px solid rgba(201,162,39,0.16)', color: '#e8e8e4' }} />
              <div className="flex gap-2">
                <input value={alertPrice} onChange={e => setAlertPrice(e.target.value)} type="number" placeholder="מחיר יעד ₪"
                  className="flex-1 px-3 py-2 rounded-xl text-sm" style={{ background: '#0d0d10', border: '1px solid rgba(201,162,39,0.16)', color: '#e8e8e4' }} />
                <select value={alertUnit} onChange={e => setAlertUnit(e.target.value)}
                  className="px-3 py-2 rounded-xl text-sm" style={{ background: '#0d0d10', border: '1px solid rgba(201,162,39,0.16)', color: '#e8e8e4' }}>
                  <option value='ק"ג'>ק&quot;ג</option>
                  <option value="ליטר">ליטר</option>
                  <option value="יחידה">יחידה</option>
                </select>
              </div>
              <button onClick={handleCreateAlert} disabled={alertSaving}
                className="w-full py-2.5 rounded-xl text-sm font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                style={{ background: '#c9a227', color: '#0a0a0e' }}>
                {alertSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Bell className="w-4 h-4" />}
                צור התראה
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
              {alerts.length === 0 ? (
                <div className="text-center py-10">
                  <Bell className="w-10 h-10 mx-auto mb-2" style={{ color: 'rgba(201,162,39,0.25)' }} />
                  <p className="text-sm" style={{ color: '#9aa0ab' }}>אין התראות מחיר עדיין</p>
                </div>
              ) : alerts.map(a => (
                <div key={a.id} className="flex items-center gap-3 p-3 rounded-xl" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.12)' }}>
                  <button onClick={() => handleToggleAlert(a)}
                    className="w-9 h-5 rounded-full flex-shrink-0 relative transition-colors"
                    style={{ background: a.is_active ? '#c9a227' : 'rgba(255,255,255,0.15)' }}>
                    <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ [a.is_active ? 'right' : 'left']: '2px' } as React.CSSProperties} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: '#e8e8e4' }}>{a.search_query}</p>
                    <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>עד ₪{a.target_price} / {a.unit}</p>
                  </div>
                  <button onClick={() => handleDeleteAlert(a.id)} className="p-1.5 rounded-lg hover:bg-white/5 flex-shrink-0" style={{ color: '#9aa0ab' }}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl p-6 shadow-lg" style={{ background: 'linear-gradient(145deg,#0a0a0e,#141418)', border: '1px solid rgba(201,162,39,0.2)' }}>
        <div className="absolute inset-0 opacity-5">
          <div className="absolute top-0 left-1/4 w-64 h-64 rounded-full blur-3xl" style={{ background: '#c9a227' }} />
        </div>
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold">השוואת מחירים AI</h1>
            <p className="text-white/70 text-sm mt-1">סוכן רכש חכם · מחפש ספקים · שולח הצעות מחיר</p>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <div className="bg-white/15 backdrop-blur rounded-xl px-3 py-1.5 text-xs font-medium">{requests.length} בקשות</div>
              <div className="bg-white/15 backdrop-blur rounded-xl px-3 py-1.5 text-xs font-medium">{activeRequests.length} פעילות</div>
              <div className="bg-white/15 backdrop-blur rounded-xl px-3 py-1.5 text-xs font-medium">{historyRequests.filter(r => r.status === 'completed').length} הושלמו</div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setShowAlerts(true)}
              className="flex items-center gap-1.5 bg-white/15 hover:bg-white/25 backdrop-blur border border-white/20 text-white text-sm font-medium px-4 py-2 rounded-xl transition-all">
              <Bell className="w-4 h-4" /> התראות מחיר
              {alerts.filter(a => a.is_active).length > 0 && (
                <span className="bg-white/30 text-white text-xs font-bold px-1.5 py-0.5 rounded-full">{alerts.filter(a => a.is_active).length}</span>
              )}
            </button>
            <button onClick={() => setShowHistory(true)}
              className="flex items-center gap-1.5 bg-white/15 hover:bg-white/25 backdrop-blur border border-white/20 text-white text-sm font-medium px-4 py-2 rounded-xl transition-all">
              <History className="w-4 h-4" /> היסטוריה
              {historyRequests.length > 0 && (
                <span className="bg-white/30 text-white text-xs font-bold px-1.5 py-0.5 rounded-full">{historyRequests.length}</span>
              )}
            </button>
            <Button onClick={openModal} className="bg-white text-indigo-700 hover:bg-white/90 font-semibold shadow-md border-0">
              <Sparkles className="w-4 h-4" /> חיפוש AI
            </Button>
          </div>
        </div>
      </div>

      {/* Search bar */}
      <div className="relative max-w-sm">
        <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input value={listSearch} onChange={e => setListSearch(e.target.value)} placeholder="חיפוש בקשות..."
          className="w-full pr-9 pl-4 py-2.5 text-sm rounded-xl focus:outline-none focus:ring-2 focus:ring-amber-600/40"
          style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#141418', color: '#e8e8e4' }}
        />
      </div>

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20 gap-2" style={{ color: '#9aa0ab' }}>
          <Loader2 className="w-5 h-5 animate-spin" /> טוען...
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 rounded-2xl" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
          <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'rgba(201,162,39,0.1)' }}>
            <Sparkles className="w-8 h-8" style={{ color: '#c9a227' }} />
          </div>
          <p className="font-semibold text-lg" style={{ color: '#b8bcc4' }}>אין בקשות פעילות</p>
          <p className="text-sm mt-1" style={{ color: '#9aa0ab' }}>
            {requests.length > 0 ? 'כל הבקשות הושלמו — ראה היסטוריה' : 'לחץ "חיפוש AI" כדי להתחיל'}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(r => (
            <RequestCard key={r.id} r={r} expanded={expanded === r.id} onToggle={() => toggleExpand(r.id)}
              detail={expandData[r.id]} onDelete={() => deleteRequest(r.id)} onMarkReply={markReply} />
          ))}
        </div>
      )}

      {/* ── Wizard Modal ── */}
      <Modal open={showModal} onClose={closeModal} title="" size="lg">
        <div dir="rtl">

          {/* ── Step 1: Query ── */}
          {wizardStep === 'query' && (
            <div className="p-6 space-y-5">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="font-bold text-lg" style={{ color: '#e8e8e4' }}>סוכן רכש AI</h2>
                  <p className="text-xs" style={{ color: '#9aa0ab' }}>מחפש ספקים · משווה מחירים · מכין מייל לאישורך</p>
                </div>
              </div>

              {/* Wizard mode */}
              <div className="flex gap-2 p-1 rounded-xl w-fit" style={{ background: '#111116' }}>
                <button onClick={() => setWizardMode('single')}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
                  style={wizardMode === 'single' ? { background: '#141418', color: '#c9a227', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' } : { color: '#9aa0ab' }}>
                  🔍 חיפוש יחיד
                </button>
                <button onClick={() => { setWizardMode('basket'); setWizardStep('basket'); }}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
                  style={wizardMode === 'basket' ? { background: '#141418', color: '#c9a227', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' } : { color: '#9aa0ab' }}>
                  🧺 סל מוצרים
                </button>
              </div>

              {/* Search type */}
              <div className="flex gap-2 p-1 rounded-xl w-fit" style={{ background: '#111116' }}>
                {(['item', 'supplier'] as const).map(t => (
                  <button key={t} onClick={() => setSearchType(t)}
                    className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all"
                    style={searchType === t ? { background: '#141418', color: '#c9a227', boxShadow: '0 1px 3px rgba(0,0,0,0.4)' } : { color: '#9aa0ab' }}>
                    {t === 'item' ? '🛒 מוצר / מרכיב' : '🏢 ספק'}
                  </button>
                ))}
              </div>

              {/* Query input */}
              <div>
                <Input
                  label={searchType === 'item' ? 'מה אתה מחפש?' : 'שם הספק לבדיקה'}
                  value={searchQuery}
                  onChange={e => { setSearchQuery(e.target.value); setSelectedInvItem(null); }}
                  placeholder={searchType === 'item' ? 'לדוג׳: חזה עוף, שמן זית, עגבניות שרי...' : 'לדוג׳: שם חברת הספק'}
                />
                {searchType === 'item' && inventoryItems.length > 0 && (
                  <div className="mt-2">
                    <label className="text-xs mb-1.5 flex items-center gap-1" style={{ color: '#9aa0ab' }}>
                      <Package className="w-3 h-3" /> בחר ממלאי קיים
                    </label>
                    <div className="relative mb-2">
                      <Search className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: '#9aa0ab' }} />
                      <input value={invSearch} onChange={e => setInvSearch(e.target.value)} placeholder="חפש פריט..."
                        className="w-full pr-8 pl-3 py-1.5 text-sm rounded-xl focus:outline-none"
                        style={{ border: '1px solid rgba(201,162,39,0.2)', background: '#111116', color: '#e8e8e4' }} />
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                      {inventoryItems.filter(it => !invSearch || it.name.toLowerCase().includes(invSearch.toLowerCase())).map(it => (
                        <button key={it.id} type="button"
                          onClick={() => { setSearchQuery(it.name); setInvSearch(''); setSelectedInvItem(it); }}
                          className="px-2.5 py-1 text-xs rounded-lg transition-colors"
                          style={{ border: '1px solid rgba(201,162,39,0.2)', color: '#9aa0ab', background: '#111116' }}>
                          {it.name}{it.unit && <span style={{ color: '#6b7280' }} className="mr-1">({it.unit})</span>}
                          {it.cost_per_unit ? <span style={{ color: '#c9a227' }} className="mr-1"> ₪{it.cost_per_unit}/{it.unit}</span> : null}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl" style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-1">
                <Button variant="outline" onClick={closeModal}>ביטול</Button>
                <Button onClick={handleQuerySubmit}
                  className="bg-gradient-to-r from-indigo-600 to-violet-600 border-0 text-white shadow-md">
                  <Sparkles className="w-4 h-4" /> מצא לי ספקים
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 2: Searching ── */}
          {wizardStep === 'searching' && (
            <div className="p-8 flex flex-col items-center space-y-4 text-center">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg"
                style={{ background: 'var(--color-primary, #1a5c2a)' }}>
                <Loader2 className="w-8 h-8 text-white animate-spin" />
              </div>
              <p className="font-bold text-lg" style={{ color: '#e8e8e4' }}>מחפש מחירים עבור: {searchQuery}</p>
              <p className="text-sm text-gray-500">סורק גוגל שופינג + ספקים ישראליים...<br/>זה לוקח כ-10 שניות</p>
            </div>
          )}

          {/* ── Step 3: Results ── */}
          {wizardStep === 'results' && searchResult && (
            <div className="p-5 space-y-4">
              <div className="flex items-center gap-2">
                <button onClick={() => setWizardStep('query')} className="p-1.5 rounded-xl hover:bg-slate-100 text-gray-500">
                  <ArrowRight className="w-4 h-4" />
                </button>
                <h2 className="font-bold" style={{ color: '#e8e8e4' }}>תוצאות חיפוש עבור: {searchQuery}</h2>
              </div>

              {/* Cheapest price highlight */}
              {searchResult.cheapestPrice ? (
                <div className="rounded-2xl p-4 border-2" style={{ background: 'rgba(26,92,42,0.06)', borderColor: 'var(--color-primary, #1a5c2a)' }}>
                  <p className="text-xs font-bold uppercase tracking-wide mb-1" style={{ color: 'var(--color-primary)' }}>המחיר הזול ביותר שנמצא</p>
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <p className="text-2xl font-black" style={{ color: 'var(--color-primary)' }}>{searchResult.cheapestPrice.price}</p>
                      <p className="text-sm font-medium" style={{ color: '#9aa0ab' }}>{searchResult.cheapestPrice.source}</p>
                      {searchResult.cheapestPrice.note && <p className="text-xs mt-0.5" style={{ color: '#6b7280' }}>{searchResult.cheapestPrice.note}</p>}
                    </div>
                    {safeUrl(searchResult.cheapestPrice.link) && (
                      <a href={safeUrl(searchResult.cheapestPrice.link)} target="_blank" rel="noopener noreferrer"
                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold text-white"
                        style={{ background: 'var(--color-primary)' }}>
                        פתח <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                  {searchResult.priceRange?.min && (
                    <p className="text-xs mt-2" style={{ color: '#9aa0ab' }}>טווח מחירים שנמצא: {searchResult.priceRange.min} – {searchResult.priceRange.max} {searchResult.priceRange.unit || ''}</p>
                  )}
                </div>
              ) : (
                <div className="rounded-xl px-4 py-3 flex items-start gap-2" style={{ background: 'rgba(217,119,6,0.1)', border: '1px solid rgba(217,119,6,0.3)' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#fbbf24' }} />
                  <p className="text-sm" style={{ color: '#fcd34d' }}>{searchResult.summary || 'לא נמצאו מחירים ברורים — נסה לשלוח בקשת מחיר לספקים ידנית'}</p>
                </div>
              )}

              {/* Task 4: cost_per_unit comparison */}
              {selectedInvItem && (selectedInvItem.cost_per_unit ?? 0) > 0 && searchResult.cheapestPrice && (() => {
                const currentCost = selectedInvItem.cost_per_unit!;
                const foundPriceNum = parseFloat(searchResult.cheapestPrice!.price.replace(/[^\d.]/g, ''));
                const saving = isNaN(foundPriceNum) ? null : ((currentCost - foundPriceNum) / currentCost * 100);
                return (
                  <div className="rounded-2xl p-4" style={{ background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.25)' }}>
                    <p className="text-xs font-bold mb-2" style={{ color: '#818cf8' }}>📦 השוואה לעלות נוכחית שלך</p>
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                      <div className="text-center">
                        <p className="text-xs mb-1" style={{ color: '#9aa0ab' }}>עלות נוכחית</p>
                        <p className="text-xl font-bold" style={{ color: '#e8e8e4' }}>₪{currentCost}/{selectedInvItem.unit}</p>
                      </div>
                      <div className="text-center text-2xl" style={{ color: '#9aa0ab' }}>→</div>
                      <div className="text-center">
                        <p className="text-xs mb-1" style={{ color: '#9aa0ab' }}>מחיר שנמצא</p>
                        <p className="text-xl font-bold" style={{ color: '#c9a227' }}>{searchResult.cheapestPrice!.price}</p>
                      </div>
                      {saving !== null && (
                        <div className="text-center px-3 py-2 rounded-xl" style={{ background: saving > 0 ? 'rgba(5,150,105,0.15)' : 'rgba(239,68,68,0.15)', border: `1px solid ${saving > 0 ? 'rgba(5,150,105,0.3)' : 'rgba(239,68,68,0.3)'}` }}>
                          <p className="text-xs mb-1" style={{ color: '#9aa0ab' }}>{saving > 0 ? 'חיסכון פוטנציאלי' : 'יקר יותר'}</p>
                          <p className="text-xl font-bold" style={{ color: saving > 0 ? '#34d399' : '#f87171' }}>{Math.abs(saving).toFixed(1)}%</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })()}

              {/* Supplier Browser */}
              {searchResult.suppliers?.length > 0 && (
                <div>
                  {/* Header + prev/next */}
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold uppercase tracking-wide" style={{ color: '#9aa0ab' }}>
                      ספקים שנמצאו ({searchResult.suppliers.length})
                    </p>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => setSelectedSupplierIdx(i => Math.max(0, i - 1))}
                        disabled={selectedSupplierIdx === 0}
                        className="w-7 h-7 rounded-lg flex items-center justify-center disabled:opacity-30 transition-colors"
                        style={{ color: '#9aa0ab' }}>
                        <ChevronRight className="w-4 h-4" />
                      </button>
                      <span className="text-xs px-1 tabular-nums" style={{ color: '#9aa0ab' }}>{selectedSupplierIdx + 1}/{searchResult.suppliers.length}</span>
                      <button
                        onClick={() => setSelectedSupplierIdx(i => Math.min(searchResult.suppliers.length - 1, i + 1))}
                        disabled={selectedSupplierIdx === searchResult.suppliers.length - 1}
                        className="w-7 h-7 rounded-lg flex items-center justify-center disabled:opacity-30 transition-colors"
                        style={{ color: '#9aa0ab' }}>
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Supplier tabs */}
                  <div className="flex gap-1.5 mb-3 overflow-x-auto pb-1">
                    {searchResult.suppliers.map((s, i) => (
                      <button key={i} onClick={() => setSelectedSupplierIdx(i)}
                        className="px-3 py-1 rounded-lg text-xs font-medium whitespace-nowrap transition-all flex-shrink-0 flex items-center gap-1"
                        style={i === selectedSupplierIdx
                          ? { background: s.isReachable === false ? '#7f1d1d' : '#c9a227', color: s.isReachable === false ? '#fca5a5' : '#050507' }
                          : { background: '#1a1a22', color: s.isReachable === false ? '#f87171' : '#9aa0ab' }}>
                        {s.isReachable === false && <span>⚠️</span>}
                        {s.name.length > 16 ? s.name.slice(0, 16) + '…' : s.name}
                      </button>
                    ))}
                  </div>

                  {/* Selected supplier card */}
                  {(() => {
                    const s = searchResult.suppliers[selectedSupplierIdx];
                    const email = supplierEmails[selectedSupplierIdx] || '';
                    return (
                      <div className="rounded-2xl p-4 space-y-3" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.25)' }}>
                        {/* Name + website */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-base leading-tight" style={{ color: '#e8e8e4' }}>{s.name}</p>
                              {s.isReachable === false && (
                                <span className="text-xs px-2 py-0.5 rounded-full font-semibold flex-shrink-0" style={{ background: 'rgba(239,68,68,0.15)', color: '#f87171' }}>
                                  רחוק מדי
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 flex-wrap mt-1">
                            {s.type && (
                              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(201,162,39,0.1)', color: '#9aa0ab' }}>{s.type}</span>
                            )}
                            {s.location && (
                              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(139,92,246,0.12)', color: '#a78bfa' }}>📍 {s.location}</span>
                            )}
                            {s.source && (
                              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'rgba(56,189,248,0.1)', color: '#38bdf8' }}>{s.source}</span>
                            )}
                          </div>
                            {s.price && (
                              <p className="text-xl font-black mt-1.5" style={{ color: '#c9a227' }}>{s.price}</p>
                            )}
                            {s.deliveryFee && (
                              <p className="text-xs mt-0.5" style={{ color: 'rgba(232,232,228,0.6)' }}>
                                🚚 משלוח: <span style={{ color: '#c9a227' }}>{s.deliveryFee}</span>
                                {s.priceWithDelivery && <span style={{ color: 'rgba(232,232,228,0.4)' }}> · כולל משלוח: {s.priceWithDelivery}</span>}
                              </p>
                            )}
                            {s.minOrder && (
                              <p className="text-xs mt-1" style={{ color: 'rgba(232,232,228,0.5)' }}>מינימום הזמנה: {s.minOrder}</p>
                            )}
                          </div>
                          {safeUrl(s.link) ? (
                            <a href={safeUrl(s.link)} target="_blank" rel="noopener noreferrer"
                              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold flex-shrink-0 shadow-sm"
                              style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.3)' }}>
                              <ExternalLink className="w-4 h-4" />
                              כנס לאתר
                            </a>
                          ) : (
                            <span className="text-xs flex-shrink-0 mt-1" style={{ color: '#6b7280' }}>אין קישור</span>
                          )}
                        </div>

                        {/* Email field */}
                        <div>
                          <label className="text-xs font-semibold mb-1.5 flex items-center gap-1" style={{ color: '#9aa0ab' }}>
                            <Mail className="w-3.5 h-3.5" />
                            מייל של הספק
                            {emailExtracting[selectedSupplierIdx] && (
                              <span className="flex items-center gap-1 font-normal" style={{ color: '#fbbf24' }}>
                                <Loader2 className="w-3 h-3 animate-spin" /> מחלץ מהאתר...
                              </span>
                            )}
                            {!emailExtracting[selectedSupplierIdx] && email && (
                              <span className="font-normal" style={{ color: '#34d399' }}>נמצא אוטומטית ✓</span>
                            )}
                          </label>
                          <input
                            type="email"
                            placeholder={emailExtracting[selectedSupplierIdx] ? 'מחפש מייל באתר...' : 'הזן מייל ידנית...'}
                            value={email}
                            onChange={e => setSupplierEmails(prev => ({ ...prev, [selectedSupplierIdx]: e.target.value }))}
                            className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none"
                            style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.2)', color: '#e8e8e4' }}
                            dir="ltr"
                            disabled={emailExtracting[selectedSupplierIdx]}
                          />
                        </div>

                        {/* Email draft + send */}
                        <div className="rounded-xl p-3 space-y-2" style={{ background: '#0f0f14', border: '1px solid rgba(201,162,39,0.12)' }}>
                          <p className="text-xs font-bold" style={{ color: '#c9a227' }}>
                            טיוטת מייל {email ? `→ ${email}` : ''}
                          </p>
                          <input
                            type="text"
                            value={emailSubject}
                            onChange={e => setEmailSubject(e.target.value)}
                            className="w-full rounded-lg px-3 py-1.5 text-sm focus:outline-none"
                            style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)', color: '#e8e8e4' }}
                            placeholder="נושא המייל"
                          />
                          <textarea
                            value={emailBody}
                            onChange={e => setEmailBody(e.target.value)}
                            rows={3}
                            className="w-full rounded-lg px-3 py-1.5 text-sm focus:outline-none resize-none"
                            style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)', color: '#e8e8e4' }}
                          />
                          <a
                            href={email.trim()
                              ? `mailto:${email}?subject=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`
                              : '#'}
                            onClick={e => { if (!email.trim()) { e.preventDefault(); toast('הזן כתובת מייל של הספק תחילה', 'error'); } }}
                            className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white w-full"
                            style={{ background: email.trim() ? 'var(--color-primary)' : '#9ca3af' }}>
                            <Send className="w-4 h-4" />
                            {email.trim() ? `שלח מייל לספק` : 'הזן מייל כדי לשלוח'}
                          </a>
                          {/* שליחת mailto למעלה יוצאת מהמערכת לגמרי — בלי מעקב סטטוס/תגובה.
                              הכפתור הזה מוסיף את הספק (עם המייל שכבר חולץ) לרשימת "שלח
                              דרך הפלטפורמה" למטה, כדי שלא יצטרכו להקליד הכל שוב ידנית. */}
                          {(() => {
                            const isAdded = manualSuppliers.some(m => m.name === s.name);
                            return (
                              <button
                                type="button"
                                onClick={() => addSupplierToSendList(selectedSupplierIdx)}
                                disabled={isAdded}
                                className="flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold w-full disabled:opacity-70"
                                style={isAdded
                                  ? { background: 'rgba(74,222,128,0.12)', color: '#4ade80', border: '1px solid rgba(74,222,128,0.3)' }
                                  : { background: 'rgba(201,162,39,0.12)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.3)' }}>
                                {isAdded
                                  ? <><CheckCircle className="w-4 h-4" /> נוסף לרשימת השליחה דרך הפלטפורמה</>
                                  : <><Plus className="w-4 h-4" /> הוסף לשליחה דרך הפלטפורמה (עם מעקב)</>}
                              </button>
                            );
                          })()}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              {/* AI summary */}
              {searchResult.summary && (
                <div className="rounded-xl px-4 py-3" style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.12)' }}>
                  <p className="text-xs font-bold mb-1" style={{ color: '#c9a227' }}>תובנת AI</p>
                  <p className="text-xs leading-relaxed" style={{ color: '#9aa0ab' }}>{searchResult.summary}</p>
                </div>
              )}

              {/* ── Location / Shipping Insight ── */}
              {searchResult.locationInsight?.shippingNote && (
                <div className="rounded-2xl p-4 space-y-2" style={{ background: 'rgba(139,92,246,0.07)', border: '1px solid rgba(139,92,246,0.25)' }}>
                  <p className="text-xs font-bold flex items-center gap-1.5" style={{ color: '#a78bfa' }}>
                    🚚 משלוח ומיקום ספקים
                  </p>
                  <p className="text-xs leading-relaxed" style={{ color: '#e8e8e4' }}>{searchResult.locationInsight.shippingNote}</p>
                  {searchResult.locationInsight.distanceWarnings && searchResult.locationInsight.distanceWarnings.length > 0 && (
                    <div className="rounded-xl px-3 py-2" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
                      <p className="text-xs font-semibold mb-1" style={{ color: '#f87171' }}>⚠️ ספקים רחוקים — לא כלכלי למשלוח:</p>
                      <p className="text-xs" style={{ color: 'rgba(232,232,228,0.6)' }}>{searchResult.locationInsight.distanceWarnings.join(' · ')}</p>
                    </div>
                  )}
                  {searchResult.locationInsight.nearbySuppliers && searchResult.locationInsight.nearbySuppliers.length > 0 && (
                    <div className="rounded-xl px-3 py-2" style={{ background: 'rgba(74,222,128,0.07)', border: '1px solid rgba(74,222,128,0.2)' }}>
                      <p className="text-xs font-semibold mb-1" style={{ color: '#4ade80' }}>✅ ספקים קרובים לאזורך:</p>
                      <p className="text-xs" style={{ color: 'rgba(232,232,228,0.6)' }}>{searchResult.locationInsight.nearbySuppliers.join(' · ')}</p>
                    </div>
                  )}
                </div>
              )}

              {/* ── Market Insight — מסעדות ── */}
              {searchResult.marketInsight && (
                Object.values(searchResult.marketInsight).some(Boolean)
              ) && (
                <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.2)' }}>
                  <p className="text-xs font-bold flex items-center gap-1.5" style={{ color: '#38bdf8' }}>
                    <Sparkles className="w-3.5 h-3.5" /> תובנות שוק למסעדה
                  </p>
                  <div className="grid grid-cols-1 gap-2">
                    {searchResult.marketInsight.typicalRestaurantCost && (
                      <div className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: 'rgba(56,189,248,0.08)', border: '1px solid rgba(56,189,248,0.15)' }}>
                        <span className="text-xs font-semibold" style={{ color: 'rgba(232,232,228,0.6)' }}>עלות טיפוסית למסעדה</span>
                        <span className="text-sm font-bold" style={{ color: '#38bdf8' }}>{searchResult.marketInsight.typicalRestaurantCost}</span>
                      </div>
                    )}
                    {searchResult.marketInsight.portionCost && (
                      <div className="flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: 'rgba(74,222,128,0.08)', border: '1px solid rgba(74,222,128,0.15)' }}>
                        <span className="text-xs font-semibold" style={{ color: 'rgba(232,232,228,0.6)' }}>עלות ממוצעת למנה</span>
                        <span className="text-sm font-bold" style={{ color: '#4ade80' }}>{searchResult.marketInsight.portionCost}</span>
                      </div>
                    )}
                    {searchResult.marketInsight.bestBuyingStrategy && (
                      <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <p className="text-xs font-semibold mb-1" style={{ color: 'rgba(232,232,228,0.5)' }}>אסטרטגיית רכישה מומלצת</p>
                        <p className="text-xs leading-relaxed" style={{ color: '#e8e8e4' }}>{searchResult.marketInsight.bestBuyingStrategy}</p>
                      </div>
                    )}
                    {searchResult.marketInsight.seasonalNote && (
                      <div className="rounded-xl px-3 py-2.5 flex items-start gap-2" style={{ background: 'rgba(251,191,36,0.06)', border: '1px solid rgba(251,191,36,0.2)' }}>
                        <Star className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#fbbf24' }} />
                        <p className="text-xs leading-relaxed" style={{ color: '#fcd34d' }}>{searchResult.marketInsight.seasonalNote}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ── ספקי מזון ישראליים ידועים ── */}
              {searchResult.knownIsraeliSuppliers && searchResult.knownIsraeliSuppliers.length > 0 && (
                <div className="rounded-2xl p-4 space-y-3" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.07)' }}>
                  <p className="text-xs font-bold flex items-center gap-1.5" style={{ color: '#9aa0ab' }}>
                    <Package className="w-3.5 h-3.5" /> ספקי מזון סיטונאיים בישראל — לפנייה ישירה
                  </p>
                  <div className="grid grid-cols-1 gap-1.5">
                    {searchResult.knownIsraeliSuppliers.map((sup, i) => (
                      <div key={i} className="flex items-center justify-between rounded-xl px-3 py-2.5"
                        style={{ background: sup.recommended ? 'rgba(26,92,42,0.12)' : 'rgba(255,255,255,0.03)', border: sup.recommended ? '1px solid rgba(74,222,128,0.25)' : '1px solid rgba(255,255,255,0.06)' }}>
                        <div className="flex items-center gap-2 min-w-0">
                          {sup.recommended && <span className="text-xs" style={{ color: '#4ade80' }}>★</span>}
                          <div>
                            <p className="text-xs font-semibold" style={{ color: sup.recommended ? '#4ade80' : '#e8e8e4' }}>{sup.name}</p>
                            <p className="text-xs" style={{ color: 'rgba(232,232,228,0.4)' }}>{sup.type}</p>
                          </div>
                        </div>
                        <a href={`https://${sup.domain}`} target="_blank" rel="noopener noreferrer"
                          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg flex-shrink-0"
                          style={{ background: 'rgba(201,162,39,0.1)', color: '#c9a227', border: '1px solid rgba(201,162,39,0.2)' }}>
                          <ExternalLink className="w-3 h-3" /> כנס
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Send via platform */}
              <div>
                <p className="text-xs font-bold uppercase tracking-wide mb-2 flex items-center gap-1" style={{ color: '#9aa0ab' }}>
                  <Mail className="w-3.5 h-3.5" /> שלח דרך הפלטפורמה — שם + מייל
                </p>
                <div className="space-y-2">
                  {manualSuppliers.map((sup, i) => (
                    <ManualSupplierRow key={i} idx={i} sup={sup}
                      onChange={(field, val) => setManualSuppliers(prev => prev.map((s, j) => j === i ? { ...s, [field]: val } : s))}
                      onRemove={() => setManualSuppliers(prev => prev.filter((_, j) => j !== i))}
                    />
                  ))}
                  <button onClick={() => setManualSuppliers(prev => [...prev, { name: '', email: '' }])}
                    className="flex items-center gap-1.5 text-xs font-medium px-1 py-1"
                    style={{ color: 'var(--color-primary)' }}>
                    <Plus className="w-3.5 h-3.5" /> הוסף ספק
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl" style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
                </div>
              )}

              <div className="flex justify-between items-center pt-1">
                <p className="text-xs text-gray-500">
                  {sendableCount > 0 ? `${sendableCount} ספקים יקבלו בקשת מחיר` : 'אפשר לסגור או לשלוח מייל ישירות'}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={closeModal}>סגור</Button>
                  {sendableCount > 0 && (
                    <Button onClick={handleReviewSubmit} className="text-white shadow-md"
                      style={{ background: 'var(--color-primary)' }}>
                      <Send className="w-4 h-4" /> שלח ל-{sendableCount} ספקים
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Basket mode (Task 8) ── */}
          {wizardStep === 'basket' && (
            <div className="p-5 space-y-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(201,162,39,0.15)', border: '1px solid rgba(201,162,39,0.3)' }}>
                  <span className="text-lg">🧺</span>
                </div>
                <div>
                  <h2 className="font-bold text-lg" style={{ color: '#e8e8e4' }}>סל מוצרים</h2>
                  <p className="text-xs" style={{ color: '#9aa0ab' }}>שלח בקשת מחיר לרשימת מוצרים לספק אחד</p>
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold" style={{ color: '#9aa0ab' }}>פריטים בסל</p>
                {basketItems.map((item, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.16)' }}>
                    <span className="w-5 h-5 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(201,162,39,0.15)', color: '#c9a227' }}>{i + 1}</span>
                    <input type="text" placeholder="שם הפריט" value={item.name}
                      onChange={e => setBasketItems(prev => prev.map((b, j) => j === i ? { ...b, name: e.target.value } : b))}
                      className="flex-1 text-sm border-0 focus:outline-none bg-transparent placeholder-slate-600" style={{ color: '#e8e8e4' }} />
                    <input type="text" placeholder="כמות" value={item.qty}
                      onChange={e => setBasketItems(prev => prev.map((b, j) => j === i ? { ...b, qty: e.target.value } : b))}
                      className="w-16 text-sm border-0 focus:outline-none bg-transparent placeholder-slate-600 text-center" style={{ color: '#e8e8e4' }} />
                    <input type="text" placeholder="יחידה" value={item.unit}
                      onChange={e => setBasketItems(prev => prev.map((b, j) => j === i ? { ...b, unit: e.target.value } : b))}
                      className="w-16 text-sm border-0 focus:outline-none bg-transparent placeholder-slate-600" style={{ color: '#e8e8e4' }} />
                    <button onClick={() => setBasketItems(prev => prev.filter((_, j) => j !== i))} className="text-slate-500 hover:text-red-400 flex-shrink-0">
                      <XIcon className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <button onClick={() => {
                  const nextInvItem = inventoryItems.find(it => !basketItems.some(b => b.name === it.name));
                  setBasketItems(prev => [...prev, { id: Date.now().toString(), name: nextInvItem?.name || '', unit: nextInvItem?.unit || '', qty: '' }]);
                }} className="flex items-center gap-1.5 text-xs font-medium px-1 py-1" style={{ color: 'var(--color-primary)' }}>
                  <Plus className="w-3.5 h-3.5" /> הוסף פריט
                </button>
              </div>

              {/* Quick add from inventory */}
              {inventoryItems.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-2" style={{ color: '#9aa0ab' }}>הוסף מהמלאי</p>
                  <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                    {inventoryItems.filter(it => !basketItems.some(b => b.name === it.name)).map(it => (
                      <button key={it.id} onClick={() => setBasketItems(prev => [...prev, { id: it.id, name: it.name, unit: it.unit, qty: '' }])}
                        className="px-2.5 py-1 text-xs rounded-lg transition-colors"
                        style={{ border: '1px solid rgba(201,162,39,0.2)', color: '#9aa0ab', background: '#111116' }}>
                        {it.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Supplier for basket */}
              <div>
                <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: '#9aa0ab' }}>ספקים לשליחה</p>
                <div className="space-y-2">
                  {manualSuppliers.map((sup, i) => (
                    <ManualSupplierRow key={i} idx={i} sup={sup}
                      onChange={(field, val) => setManualSuppliers(prev => prev.map((s, j) => j === i ? { ...s, [field]: val } : s))}
                      onRemove={() => setManualSuppliers(prev => prev.filter((_, j) => j !== i))}
                    />
                  ))}
                  <button onClick={() => setManualSuppliers(prev => [...prev, { name: '', email: '' }])}
                    className="flex items-center gap-1.5 text-xs font-medium px-1 py-1" style={{ color: 'var(--color-primary)' }}>
                    <Plus className="w-3.5 h-3.5" /> הוסף ספק
                  </button>
                </div>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-sm px-4 py-2.5 rounded-xl" style={{ background: 'rgba(220,38,38,0.1)', border: '1px solid rgba(220,38,38,0.3)', color: '#f87171' }}>
                  <AlertTriangle className="w-4 h-4 flex-shrink-0" /> {error}
                </div>
              )}

              <div className="flex justify-between items-center pt-1">
                <Button variant="outline" onClick={() => { setWizardStep('query'); setWizardMode('single'); }}>חזרה</Button>
                <Button onClick={handleBasketSubmit} className="text-white shadow-md" style={{ background: 'var(--color-primary)' }}
                  disabled={basketItems.filter(it => it.name.trim()).length === 0 || manualSuppliers.filter(s => s.email.trim()).length === 0}>
                  <Send className="w-4 h-4" /> שלח סל ({basketItems.filter(it => it.name.trim()).length} פריטים)
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 4: Sending / Sent ── */}
          {(wizardStep === 'sending' || wizardStep === 'sent') && (
            <div className="p-8 flex flex-col items-center space-y-4">
              {wizardStep === 'sending' ? (
                <>
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg"
                    style={{ background: 'var(--color-primary)' }}>
                    <Loader2 className="w-8 h-8 text-white animate-spin" />
                  </div>
                  <p className="text-lg font-bold text-[#e8e8e4]">שולח בקשות מחיר...</p>
                </>
              ) : (
                <>
                  <div className="w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg"
                    style={{ background: 'var(--color-primary)' }}>
                    <CheckCircle className="w-9 h-9 text-white" />
                  </div>
                  <p className="text-xl font-bold text-[#e8e8e4]">הבקשות נשלחו בהצלחה!</p>
                  <p className="text-sm flex items-center gap-1.5" style={{ color: '#9aa0ab' }}>
                    <Bell className="w-3.5 h-3.5" /> תקבל התראה כאשר ספק יענה
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}
