'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Star, TrendingUp, AlertTriangle, CheckCircle2, Trash2,
  Plus, ExternalLink, ChevronDown, ChevronUp, Loader2, MessageSquare,
  ThumbsUp, ThumbsDown, Zap,
} from 'lucide-react';
import { reviewsApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';

// ── Platform logos (SVG inline) ──────────────────────────────
function GoogleLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
    </svg>
  );
}

function WoltLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="50" fill="#009DE0"/>
      <text x="50" y="67" textAnchor="middle" fill="white" fontSize="44" fontWeight="900" fontFamily="Arial,sans-serif">W</text>
    </svg>
  );
}

function TenbisLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="18" fill="#FF6600"/>
      <text x="50" y="58" textAnchor="middle" fill="white" fontSize="30" fontWeight="900" fontFamily="Arial,sans-serif">10bis</text>
    </svg>
  );
}

function MishlohaLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="50" fill="#E91E8C"/>
      <text x="50" y="67" textAnchor="middle" fill="white" fontSize="48" fontWeight="900" fontFamily="Arial,sans-serif">M</text>
    </svg>
  );
}

function TripAdvisorLogo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="50" fill="#00AA6C"/>
      {/* Owl eyes */}
      <circle cx="32" cy="52" r="14" fill="white"/>
      <circle cx="68" cy="52" r="14" fill="white"/>
      <circle cx="32" cy="52" r="8" fill="#00AA6C"/>
      <circle cx="68" cy="52" r="8" fill="#00AA6C"/>
      <circle cx="32" cy="52" r="4" fill="black"/>
      <circle cx="68" cy="52" r="4" fill="black"/>
      {/* Beak */}
      <ellipse cx="50" cy="65" rx="8" ry="5" fill="#FF6600"/>
    </svg>
  );
}

function PlatformLogo({ id, size = 28 }: { id: string; size?: number }) {
  if (id === 'google')      return <GoogleLogo size={size} />;
  if (id === 'wolt')        return <WoltLogo size={size} />;
  if (id === 'tenbis')      return <TenbisLogo size={size} />;
  if (id === 'mishloha')    return <MishlohaLogo size={size} />;
  if (id === 'tripadvisor') return <TripAdvisorLogo size={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="50" fill="#9CA3AF"/>
      <text x="50" y="67" textAnchor="middle" fill="white" fontSize="44" fontWeight="700" fontFamily="Arial,sans-serif">?</text>
    </svg>
  );
}

// ── Platform config ─────────────────────────────────────────
const PLATFORMS = [
  {
    id: 'google',
    label: 'Google Maps',
    color: '#4285F4',
    bg: '#EAF1FF',
    hint: 'כנס לדף העסק ב-Google → ביקורות → העתק את הביקורות',
    link: 'https://business.google.com',
  },
  {
    id: 'wolt',
    label: 'Wolt',
    color: '#009DE0',
    bg: '#E5F6FD',
    hint: 'פתח את דף המסעדה ב-Wolt → גלול לביקורות → העתק',
    link: 'https://wolt.com',
  },
  {
    id: 'tenbis',
    label: 'תן ביס',
    color: '#FF6600',
    bg: '#FFF0E5',
    hint: 'כנס לפורטל תן ביס → ביקורות → העתק את הטקסט',
    link: 'https://www.10bis.co.il',
  },
  {
    id: 'mishloha',
    label: 'משלוחה',
    color: '#E91E8C',
    bg: '#FDE8F4',
    hint: 'כנס לדשבורד משלוחה → חוות דעת → העתק',
    link: 'https://www.mishloha.co.il',
  },
  {
    id: 'tripadvisor',
    label: 'TripAdvisor',
    color: '#00AA6C',
    bg: '#E5F7F2',
    hint: 'כנס לדף העסק ב-TripAdvisor → ביקורות → העתק',
    link: 'https://www.tripadvisor.com',
  },
  {
    id: 'other',
    label: 'אחר',
    color: '#6B7280',
    bg: '#F3F4F6',
    hint: 'הדבק ביקורות מכל מקור אחר',
    link: null,
  },
];

// ── Types ───────────────────────────────────────────────────
interface Issue {
  topic: string;
  count: number;
  severity: 'גבוה' | 'בינוני' | 'נמוך';
  example: string;
}

interface Analysis {
  overallSentiment: 'חיובי' | 'ניטרלי' | 'שלילי';
  averageRating: number;
  totalReviews: number;
  summary: string;
  strengths: string[];
  issues: Issue[];
  repeatingComplaints: string[];
  actionItems: string[];
  positiveHighlights: string[];
  keywords: string[];
}

interface Batch {
  id: string;
  platform: string;
  analysis: Analysis | null;
  created_at: string;
  preview: string;
}

// ── Star rating component ────────────────────────────────────
function Stars({ rating }: { rating: number }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <Star
          key={i}
          className={`w-4 h-4 ${i <= Math.round(rating) ? 'text-amber-400 fill-amber-400' : 'text-gray-200 fill-gray-200'}`}
        />
      ))}
    </div>
  );
}

// ── Severity badge ────────────────────────────────────────────
function SeverityBadge({ sev }: { sev: string }) {
  if (sev === 'גבוה') return <Badge variant="danger">{sev}</Badge>;
  if (sev === 'בינוני') return <Badge variant="warning">{sev}</Badge>;
  return <Badge variant="default">{sev}</Badge>;
}

// ── Main Page ────────────────────────────────────────────────
export default function ReviewsPage() {
  const { confirm, toast } = useAppDialog();
  const [batches, setBatches]   = useState<Batch[]>([]);
  const [loading, setLoading]   = useState(true);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  const [showAdd, setShowAdd]   = useState(false);
  const [creatingTasks, setCreatingTasks] = useState<string | null>(null);
  const [selPlatform, setSelPlatform] = useState(PLATFORMS[0].id);
  const [reviewText, setReviewText]   = useState('');
  const [analyzing, setAnalyzing]     = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await reviewsApi.list();
      setBatches(data.batches || []);
    } catch (err) { toast(getErrorMessage(err) || 'טעינת הביקורות נכשלה', 'error'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { load(); }, [load]);
  useSyncEvent('review.updated', load);

  const analyze = async () => {
    if (!reviewText.trim()) return;
    setAnalyzing(true);
    try {
      const { data } = await reviewsApi.analyze(selPlatform, reviewText);
      toast('הניתוח הושלם!', 'success');
      setShowAdd(false);
      setReviewText('');
      load();
      setOpenBatch(data.id);
    } catch (err) {
      toast(getErrorMessage(err));
    } finally {
      setAnalyzing(false);
    }
  };

  const deleteBatch = async (id: string) => {
    if (!await confirm('האם למחוק ניתוח זה?', 'מחיקת ניתוח')) return;
    try {
      await reviewsApi.delete(id);
      setBatches(prev => prev.filter(b => b.id !== id));
    } catch (err) {
      toast(getErrorMessage(err));
    }
  };

  // Aggregate all issues across all batches
  const { topIssues, avgRating } = useMemo(() => {
    const allIssues = batches
      .flatMap(b => b.analysis?.issues || [])
      .reduce<Record<string, { count: number; severity: string; examples: string[] }>>((acc, issue) => {
        if (!acc[issue.topic]) acc[issue.topic] = { count: 0, severity: issue.severity, examples: [] };
        acc[issue.topic].count += issue.count;
        if (issue.example) acc[issue.topic].examples.push(issue.example);
        return acc;
      }, {});

    const topIssues = Object.entries(allIssues)
      .sort(([, a], [, b]) => b.count - a.count)
      .slice(0, 5);

    const rated = batches.filter(b => b.analysis?.averageRating);
    const avgRating = rated.length > 0
      ? rated.reduce((s, b) => s + (b.analysis?.averageRating || 0), 0) / rated.length
      : null;

    return { topIssues, avgRating };
  }, [batches]);

  const platform = (id: string) => PLATFORMS.find(p => p.id === id) || PLATFORMS[PLATFORMS.length - 1];

  return (
    <div className="space-y-6" dir="rtl">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">ניתוח ביקורות</h1>
          <p className="text-sm text-[rgba(232,232,228,0.45)] mt-1">
            סיכום ביקורות מכל הפלטפורמות — זיהוי בעיות חוזרות
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="w-4 h-4" /> הוסף ביקורות לניתוח
        </Button>
      </div>

      {/* How it works */}
      <div className="bg-blue-950/20 border border-blue-800/30 rounded-xl p-4 text-sm text-blue-300">
        <p className="font-bold mb-2 flex items-center gap-2">
          <MessageSquare className="w-4 h-4" /> איך זה עובד?
        </p>
        <ol className="space-y-1.5 list-none">
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-blue-900/50 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">1</span>
            <span>כנס לפלטפורמה שבה יש לך ביקורות (וולט, גוגל, תן ביס, משלוחה) דרך הקישורים למטה</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-blue-900/50 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">2</span>
            <span>גלול לאזור הביקורות, סמן את כולן והעתק (Ctrl+A → Ctrl+C)</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-blue-900/50 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">3</span>
            <span>לחץ "הוסף ביקורות לניתוח", בחר את הפלטפורמה והדבק את הטקסט</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="w-5 h-5 rounded-full bg-blue-900/50 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0 mt-0.5">4</span>
            <span>ה-AI מנתח את הביקורות ומחזיר: דירוג כולל, חוזקות, בעיות לפי חומרה, תלונות חוזרות ופעולות מומלצות</span>
          </li>
        </ol>
        <p className="mt-2 text-xs text-blue-400">
          💡 ניתן להוסיף ביקורות ממספר פלטפורמות — המערכת תצבור ותזהה בעיות חוזרות בין כולן
        </p>
      </div>

      {/* Platform quick links */}
      <div className="flex gap-2 flex-wrap">
        {PLATFORMS.filter(p => p.link).map(p => (
          <a
            key={p.id}
            href={p.link!}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border hover:opacity-80 transition-opacity"
            style={{ background: p.bg, borderColor: p.color + '40', color: p.color }}
          >
            <ExternalLink className="w-3 h-3" />
            {p.label}
          </a>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-20 text-[rgba(232,232,228,0.4)]">טוען ביקורות...</div>
      ) : (
        <>
          {/* ── Global summary (if >1 batches) ─────────────── */}
          {batches.length > 1 && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Avg rating */}
              <Card>
                <CardContent className="p-5">
                  <p className="text-xs text-[rgba(232,232,228,0.45)] mb-1">דירוג ממוצע כולל</p>
                  <div className="flex items-end gap-2">
                    <span className="text-3xl font-black text-amber-500">
                      {avgRating ? avgRating.toFixed(1) : '—'}
                    </span>
                    <Stars rating={avgRating || 0} />
                  </div>
                  <p className="text-xs text-[rgba(232,232,228,0.4)] mt-1">{batches.length} קבוצות ביקורות</p>
                </CardContent>
              </Card>

              {/* Top issues */}
              <Card className="lg:col-span-2">
                <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="w-4 h-4 text-red-500" />בעיות חוזרות בכל הפלטפורמות</CardTitle></CardHeader>
                <CardContent className="p-4 pt-0 space-y-1.5">
                  {topIssues.length === 0 ? (
                    <p className="text-sm text-[rgba(232,232,228,0.4)]">אין בעיות חוזרות</p>
                  ) : topIssues.map(([topic, data], i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      <span className="text-red-400 font-bold w-4 text-center">{i + 1}</span>
                      <span className="flex-1 text-[rgba(232,232,228,0.75)]">{topic}</span>
                      <SeverityBadge sev={data.severity} />
                      <span className="text-xs text-[rgba(232,232,228,0.4)]">{data.count}×</span>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── No batches yet ───────────────────────────── */}
          {batches.length === 0 && (
            <Card>
              <CardContent className="py-20 text-center">
                <MessageSquare className="w-14 h-14 text-[rgba(232,232,228,0.2)] mx-auto mb-4" />
                <p className="text-[rgba(232,232,228,0.45)] font-medium mb-1">אין עדיין ביקורות מנותחות</p>
                <p className="text-xs text-[rgba(232,232,228,0.4)] mb-5">
                  כנס לוולט / גוגל / תן ביס, העתק את הביקורות ולחץ "הוסף לניתוח"
                </p>
                <Button onClick={() => setShowAdd(true)}>
                  <Plus className="w-4 h-4" /> התחל לנתח ביקורות
                </Button>
              </CardContent>
            </Card>
          )}

          {/* ── Batch list ───────────────────────────────── */}
          <div className="space-y-3">
            {batches.map(batch => {
              const pl      = platform(batch.platform);
              const a       = batch.analysis;
              const isOpen  = openBatch === batch.id;

              return (
                <Card key={batch.id} className="overflow-hidden">
                  {/* Header */}
                  <div
                    className="flex items-center gap-3 px-5 py-4 cursor-pointer hover:bg-[rgba(201,162,39,0.06)] transition-colors"
                    onClick={() => setOpenBatch(isOpen ? null : batch.id)}
                  >
                    <div
                      className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden"
                      style={{ background: pl.bg }}
                    >
                      <PlatformLogo id={pl.id} size={28} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-[#e8e8e4] text-sm">{pl.label}</span>
                        {a?.overallSentiment && (
                          <Badge variant={
                            a.overallSentiment === 'חיובי' ? 'success' :
                            a.overallSentiment === 'שלילי' ? 'danger' : 'default'
                          }>
                            {a.overallSentiment === 'חיובי' ? <ThumbsUp className="w-3 h-3 inline mr-0.5" /> : a.overallSentiment === 'שלילי' ? <ThumbsDown className="w-3 h-3 inline mr-0.5" /> : null}
                            {a.overallSentiment}
                          </Badge>
                        )}
                        {a?.averageRating && <Stars rating={a.averageRating} />}
                        {a?.totalReviews && (
                          <span className="text-xs text-[rgba(232,232,228,0.4)]">{a.totalReviews} ביקורות</span>
                        )}
                      </div>
                      {a?.summary && (
                        <p className="text-xs text-[rgba(232,232,228,0.45)] mt-0.5 truncate">{a.summary}</p>
                      )}
                      {!a && (
                        <p className="text-xs text-red-400 mt-0.5">ניתוח נכשל — נסה שנית</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-[rgba(232,232,228,0.4)]">
                        {new Date(batch.created_at).toLocaleDateString('he-IL')}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); deleteBatch(batch.id); }}
                        className="p-1.5 rounded-lg hover:bg-red-950/30 text-[rgba(232,232,228,0.3)] hover:text-red-400 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                      {isOpen ? <ChevronUp className="w-4 h-4 text-[rgba(232,232,228,0.4)]" /> : <ChevronDown className="w-4 h-4 text-[rgba(232,232,228,0.4)]" />}
                    </div>
                  </div>

                  {/* Expanded analysis */}
                  {isOpen && a && (
                    <div className="border-t border-[rgba(201,162,39,0.14)] bg-[#0f0f14]/50 px-5 py-4 space-y-5">

                      {/* Summary */}
                      <div className="bg-[#141418] rounded-xl border border-[rgba(201,162,39,0.14)] p-4">
                        <p className="text-sm text-[rgba(232,232,228,0.75)] leading-relaxed">{a.summary}</p>
                      </div>

                      {/* Strengths + Issues */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Strengths */}
                        <div className="bg-green-950/20 rounded-xl p-4">
                          <p className="text-xs font-bold text-green-700 mb-2 flex items-center gap-1">
                            <ThumbsUp className="w-3.5 h-3.5" /> חוזקות
                          </p>
                          <ul className="space-y-1.5">
                            {a.strengths.map((s, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-sm text-green-800">
                                <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-green-500" />
                                {s}
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* Issues */}
                        <div className="bg-red-950/20 rounded-xl p-4">
                          <p className="text-xs font-bold text-red-700 mb-2 flex items-center gap-1">
                            <AlertTriangle className="w-3.5 h-3.5" /> בעיות מזוהות
                          </p>
                          {a.issues.length === 0 ? (
                            <p className="text-sm text-green-600">לא זוהו בעיות</p>
                          ) : (
                            <ul className="space-y-2">
                              {a.issues.map((issue, i) => (
                                <li key={i} className="text-sm">
                                  <div className="flex items-center gap-2 mb-0.5">
                                    <span className="font-medium text-red-800">{issue.topic}</span>
                                    <SeverityBadge sev={issue.severity} />
                                    <span className="text-xs text-gray-400 mr-auto">{issue.count}×</span>
                                  </div>
                                  {issue.example && (
                                    <p className="text-xs text-[rgba(232,232,228,0.45)] italic pr-2 border-r-2 border-red-800/40">
                                      "{issue.example}"
                                    </p>
                                  )}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>

                      {/* Repeating complaints */}
                      {a.repeatingComplaints.length > 0 && (
                        <div>
                          <p className="text-xs font-bold text-[rgba(232,232,228,0.6)] mb-2">תלונות חוזרות</p>
                          <div className="flex gap-2 flex-wrap">
                            {a.repeatingComplaints.map((c, i) => (
                              <span key={i} className="px-2.5 py-1 rounded-full bg-red-950/30 text-red-400 text-xs font-medium">
                                {c}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Action items */}
                      {a.actionItems.length > 0 && (
                        <div className="bg-blue-950/20 rounded-xl p-4">
                          <p className="text-xs font-bold text-blue-400 mb-2 flex items-center gap-1">
                            <Zap className="w-3.5 h-3.5" /> פעולות מומלצות
                          </p>
                          <ul className="space-y-1.5">
                            {a.actionItems.map((item, i) => (
                              <li key={i} className="flex items-start gap-1.5 text-sm text-blue-300">
                                <span className="w-4 h-4 rounded-full bg-blue-900/50 text-blue-300 text-xs flex items-center justify-center flex-shrink-0 font-bold mt-0.5">
                                  {i + 1}
                                </span>
                                {item}
                              </li>
                            ))}
                          </ul>
                          <div className="mt-3 flex justify-end">
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-blue-800/40 text-blue-300 hover:bg-blue-900/30"
                              disabled={creatingTasks === batch.id}
                              onClick={async () => {
                                setCreatingTasks(batch.id);
                                try {
                                  const { data } = await reviewsApi.createTasksFromBatch(batch.id);
                                  toast(`נוצרו ${data.created} משימות בהצלחה`, 'success');
                                } catch (err) {
                                  toast(getErrorMessage(err) || 'שגיאה ביצירת משימות', 'error');
                                } finally {
                                  setCreatingTasks(null);
                                }
                              }}
                            >
                              {creatingTasks === batch.id ? (
                                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> יוצר משימות...</>
                              ) : (
                                <><CheckCircle2 className="w-3.5 h-3.5" /> צור {a.actionItems.length} משימות</>
                              )}
                            </Button>
                          </div>
                        </div>
                      )}

                      {/* Positive highlights */}
                      {a.positiveHighlights.length > 0 && (
                        <div>
                          <p className="text-xs font-bold text-[rgba(232,232,228,0.6)] mb-2">הדגשות חיוביות</p>
                          <div className="flex gap-2 flex-wrap">
                            {a.positiveHighlights.map((h, i) => (
                              <span key={i} className="px-2.5 py-1 rounded-full bg-green-950/30 text-green-400 text-xs font-medium">
                                ✓ {h}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Keywords */}
                      {a.keywords.length > 0 && (
                        <div>
                          <p className="text-xs font-bold text-[rgba(232,232,228,0.6)] mb-2">מילות מפתח</p>
                          <div className="flex gap-1.5 flex-wrap">
                            {a.keywords.map((kw, i) => (
                              <span key={i} className="px-2 py-0.5 rounded bg-[#1a1a20] text-[rgba(232,232,228,0.6)] text-xs border border-[rgba(201,162,39,0.1)]">
                                #{kw}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* ── Add Reviews Modal ────────────────────────────── */}
      <Modal open={showAdd} onClose={() => { setShowAdd(false); setReviewText(''); }} title="הוספת ביקורות לניתוח" size="lg">
        <div className="p-6 space-y-4">
          {/* Platform selector */}
          <div>
            <label className="block text-sm font-medium text-[rgba(232,232,228,0.75)] mb-2">בחר פלטפורמה</label>
            <div className="grid grid-cols-3 gap-2">
              {PLATFORMS.map(p => (
                <button
                  key={p.id}
                  onClick={() => setSelPlatform(p.id)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-sm font-medium transition-all ${
                    selPlatform === p.id
                      ? 'border-current'
                      : 'border-[rgba(201,162,39,0.14)] hover:border-[rgba(201,162,39,0.25)] bg-[#141418]'
                  }`}
                  style={selPlatform === p.id ? { background: p.bg, borderColor: p.color, color: p.color } : {}}
                >
                  <PlatformLogo id={p.id} size={20} />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Hint */}
          <div className="bg-blue-950/20 rounded-xl px-4 py-3 text-xs text-blue-300 flex items-start gap-2 border border-blue-800/30">
            <TrendingUp className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <strong>{platform(selPlatform).label}:</strong> {platform(selPlatform).hint}
              {platform(selPlatform).link && (
                <a href={platform(selPlatform).link!} target="_blank" rel="noopener noreferrer"
                   className="mr-1 underline">פתח →</a>
              )}
            </div>
          </div>

          {/* Text area */}
          <div>
            <label className="block text-sm font-medium text-[rgba(232,232,228,0.75)] mb-1">
              הדבק ביקורות כאן
            </label>
            <textarea
              value={reviewText}
              onChange={e => setReviewText(e.target.value)}
              placeholder={`הדבק את הביקורות מ-${platform(selPlatform).label}...\n\nלדוגמה:\n★★★★☆ המבורגר טעים מאוד אבל השירות איטי\n★★★★★ מקום נהדר, נחזור בוודאות`}
              rows={10}
              className="w-full text-sm border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.75)] rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono leading-relaxed"
            />
            <p className="text-xs text-[rgba(232,232,228,0.4)] mt-1">{reviewText.length} תווים · מינימום 20</p>
          </div>

          <div className="flex justify-end gap-3">
            <Button variant="outline" onClick={() => { setShowAdd(false); setReviewText(''); }}>ביטול</Button>
            <Button
              onClick={analyze}
              loading={analyzing}
              disabled={reviewText.trim().length < 20}
            >
              {analyzing ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> מנתח...</>
              ) : (
                <><Zap className="w-4 h-4" /> נתח עם AI</>
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
