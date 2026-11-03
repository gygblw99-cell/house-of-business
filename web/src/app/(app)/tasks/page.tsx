'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, Trash2, Camera, CheckCircle2, Circle, Clock,
  AlertTriangle, User, RefreshCw, X,
  History, ChevronDown, ChevronUp, Sparkles, Loader2 } from 'lucide-react';
import { tasksApi, employeesApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { DatePicker } from '@/components/ui/DatePicker';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';
import { useImgToken } from '@/hooks/useImgToken';

// ── Types ──────────────────────────────────────────────────
interface Subtask {
  id: string;
  title: string;
  status: 'pending' | 'done';
  completed_by_name?: string;
  completion_photo?: string;
  completed_at?: string;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  due_date?: string;
  assigned_to?: string;
  assigned_to_name?: string;
  created_by_name: string;
  subtasks: Subtask[];
  created_at: string;
  completion_photo?: string;
  approved_at?: string;
}

interface Employee { id: string; full_name: string; }

// ── Helpers ─────────────────────────────────────────────────
const PRIORITY_META = {
  low:    { label: 'נמוכה',  dot: '#6b7280',   text: '#9aa0ab' },
  normal: { label: 'רגילה',  dot: '#60b8e8',   text: '#60b8e8' },
  high:   { label: 'גבוהה',  dot: '#fb923c',   text: '#fb923c' },
  urgent: { label: 'דחופה!', dot: '#ef4444',   text: '#ef4444' },
};

// Gold gradient for buttons
const GOLD_BTN = 'linear-gradient(135deg, #b8941f, #c9a227, #d4af37)';
const GOLD_COLOR = '#c9a227';
const CARD_BG = '#141418';
const EXPANDED_BG = '#0f0f14';
const BORDER_GOLD = 'rgba(201,162,39,0.16)';
const BORDER_GOLD_STRONG = 'rgba(201,162,39,0.28)';

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// ── Main ────────────────────────────────────────────────────
export default function TasksPage() {
  const { confirm, toast } = useAppDialog();
  const { user } = useAppSelector(s => s.auth);
  const isManager = user?.role === 'owner' || user?.role === 'manager' || user?.role === 'partner';

  const [tasks, setTasks]         = useState<Task[]>([]);
  const [history, setHistory]     = useState<Task[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading]     = useState(true);
  const [openTask, setOpenTask]   = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [filter, setFilter]       = useState<'all' | 'open' | 'in_progress' | 'done'>('all');

  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm]             = useState({ title: '', description: '', assignedTo: '', priority: 'normal', dueDate: '' });
  const [subtaskInputs, setSubtaskInputs] = useState<string[]>(['']);
  // Kept in lockstep with subtaskInputs purely so each row has a stable React
  // key — subtaskInputs itself stays plain string[] since it's sent as-is on
  // submit (line ~133) and values aren't unique enough to key by themselves.
  const [subtaskKeys, setSubtaskKeys] = useState<string[]>([crypto.randomUUID()]);
  const [creating, setCreating]     = useState(false);

  const [addingSubTo, setAddingSubTo] = useState<string | null>(null);
  const [newSubTitle, setNewSubTitle] = useState('');
  const [suggestions, setSuggestions] = useState<{ title: string; description: string; priority: string; source: string }[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [suggestError, setSuggestError] = useState(false);

  const photoRefs        = useRef<Record<string, HTMLInputElement | null>>({});
  const photoCameraRefs  = useRef<Record<string, HTMLInputElement | null>>({});
  const taskPhotoRefs       = useRef<Record<string, HTMLInputElement | null>>({});
  const taskPhotoCameraRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // בלי זה, שום כפתור לא הראה שהעלאה בתהליך — בדיוק בתנאים שהפיצ'ר הזה
  // מיועד להם (מובייל, WiFi חלש במטבח/מחסן), משתמש שלא רואה משוב מיידי
  // עלול ללחוץ שוב ולשלוח שתי העלאות מקבילות לאותה תת-משימה/משימה.
  const [uploadingSubtasks, setUploadingSubtasks] = useState<Set<string>>(new Set());
  const [uploadingTasks, setUploadingTasks]       = useState<Set<string>>(new Set());

  const [imgToken] = useImgToken();
  const [photoViewer, setPhotoViewer] = useState<string | null>(null);
  // completion_photo is stored as /uploads/filename; route through the api-proxy
  // which now also serves /api/uploads/:filename (alias added in the backend).
  const photoUrl = (path: string) => {
    const filename = path.replace(/^.*\/uploads\//, '');
    return `/api-proxy/uploads/${filename}${imgToken ? `?token=${imgToken}` : ''}`;
  };

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      tasksApi.list(),
      tasksApi.history(),
      employeesApi.list(),
    ]).then(([t, h, e]) => {
      setTasks(t.data.tasks || []);
      setHistory(h.data.tasks || []);
      setEmployees((e.data.employees || []).filter((emp: Employee & { is_active: boolean }) => emp.is_active));
    }).catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);
  useSyncEvent('task.updated', load);

  const createTask = async () => {
    if (!form.title.trim()) return;
    setCreating(true);
    try {
      await tasksApi.create({
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        assignedTo: form.assignedTo || undefined,
        priority: form.priority,
        dueDate: form.dueDate || undefined,
        subtasks: subtaskInputs.filter(s => s.trim()),
      });
      setShowCreate(false);
      setForm({ title: '', description: '', assignedTo: '', priority: 'normal', dueDate: '' });
      setSubtaskInputs(['']);
      setSubtaskKeys([crypto.randomUUID()]);
      toast('משימה נוצרה', 'success');
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
    finally { setCreating(false); }
  };

  const deleteTask = async (id: string) => {
    if (!await confirm('האם למחוק משימה זו?', 'מחיקת משימה')) return;
    try {
      await tasksApi.delete(id);
      setTasks(prev => prev.filter(t => t.id !== id));
      toast('משימה נמחקה', 'success');
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  const deleteSubtask = async (taskId: string, subId: string) => {
    if (!await confirm('האם למחוק תת-משימה זו?', 'מחיקת תת-משימה')) return;
    try {
      await tasksApi.deleteSubtask(taskId, subId);
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  const addSubtask = async (taskId: string) => {
    if (!newSubTitle.trim()) return;
    try {
      await tasksApi.addSubtask(taskId, newSubTitle.trim());
      setAddingSubTo(null); setNewSubTitle('');
      toast('תת-משימה נוספה', 'success');
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  const handlePhotoUpload = async (taskId: string, subId: string, file: File) => {
    if (uploadingSubtasks.has(subId)) return; // כבר מעלה — מונע שליחה כפולה
    setUploadingSubtasks(prev => new Set(prev).add(subId));
    try {
      await tasksApi.completeSubtask(taskId, subId, file);
      toast('תת-משימה הושלמה!', 'success');
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
    finally {
      setUploadingSubtasks(prev => { const next = new Set(prev); next.delete(subId); return next; });
    }
  };

  const handleTaskComplete = async (taskId: string, file: File) => {
    if (uploadingTasks.has(taskId)) return; // כבר מעלה — מונע שליחה כפולה
    setUploadingTasks(prev => new Set(prev).add(taskId));
    try {
      await tasksApi.completeTask(taskId, file);
      toast('המשימה הועברה לאישור מנהל', 'success');
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
    finally {
      setUploadingTasks(prev => { const next = new Set(prev); next.delete(taskId); return next; });
    }
  };

  const handleApprove = async (taskId: string) => {
    try {
      await tasksApi.approve(taskId);
      toast('משימה אושרה ועברה להיסטוריה', 'success');
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  const loadSuggestions = async () => {
    setLoadingSuggest(true);
    setShowSuggest(true);
    setSuggestError(false);
    try {
      const res = await tasksApi.aiSuggest();
      setSuggestions(res.data?.suggestions || []);
    } catch (err) {
      setSuggestions([]);
      setSuggestError(true);
      toast(getErrorMessage(err), 'error');
    }
    finally { setLoadingSuggest(false); }
  };

  const createFromSuggestion = async (s: { title: string; description: string; priority: string }) => {
    try {
      await tasksApi.create({ title: s.title, description: s.description, priority: s.priority });
      setSuggestions(prev => prev.filter(x => x.title !== s.title));
      toast('משימה נוצרה מהצעת AI', 'success');
      load();
    } catch (err) { toast(getErrorMessage(err), 'error'); }
  };

  const filtered = tasks.filter(t => filter === 'all' ? true : t.status === filter);
  const counts = {
    all: tasks.length,
    open: tasks.filter(t => t.status === 'open').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    done: tasks.filter(t => t.status === 'done').length,
  };

  const inputStyle = {
    background: '#1a1a20',
    border: `1px solid rgba(201,162,39,0.2)`,
    color: '#e8e8e4',
    borderRadius: '12px',
    padding: '10px 14px',
    fontSize: '14px',
    width: '100%',
    outline: 'none',
  } as React.CSSProperties;

  return (
    <div
      className="min-h-screen"
      style={{ background: 'linear-gradient(145deg, #0a0a0e 0%, #0f0f14 50%, #0d0d12 100%)' }}
      dir="rtl"
    >
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">

        {/* ── Header ────────────────────────────────────────── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-black" style={{ color: '#e8e8e4' }}>משימות</h1>
            <p className="text-sm mt-0.5" style={{ color: '#9aa0ab' }}>{tasks.length} משימות פעילות</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHistory(true)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm transition-colors relative"
              style={{
                background: '#141418',
                border: `1px solid ${BORDER_GOLD_STRONG}`,
                color: '#9aa0ab',
              }}
            >
              <History className="w-4 h-4" />
              היסטוריה
              {history.length > 0 && (
                <span
                  className="absolute -top-1.5 -left-1.5 w-4 h-4 text-xs rounded-full flex items-center justify-center font-bold"
                  style={{ background: GOLD_BTN, color: '#050507' }}
                >
                  {history.length}
                </span>
              )}
            </button>
            <button
              onClick={load}
              className="p-2 rounded-xl transition-colors"
              style={{
                background: '#141418',
                border: `1px solid ${BORDER_GOLD_STRONG}`,
                color: '#9aa0ab',
              }}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {isManager && (
              <>
                <button
                  onClick={loadSuggestions}
                  title="הצעות AI"
                  className="p-2 rounded-xl transition-colors"
                  style={{
                    background: showSuggest ? 'rgba(201,162,39,0.12)' : '#141418',
                    border: `1px solid ${showSuggest ? 'rgba(201,162,39,0.4)' : BORDER_GOLD_STRONG}`,
                    color: '#c9a227',
                  }}
                >
                  <Sparkles className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowCreate(true)}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold transition-all hover:opacity-90"
                  style={{ background: GOLD_BTN, color: '#050507', boxShadow: '0 4px 14px rgba(201,162,39,0.3)' }}
                >
                  <Plus className="w-4 h-4" /> משימה חדשה
                </button>
              </>
            )}
          </div>
        </div>

        {/* ── Filter pills ──────────────────────────────────── */}
        <div className="flex gap-2 overflow-x-auto pb-1">
          {([
            ['all', 'הכל', counts.all],
            ['open', 'פתוחות', counts.open],
            ['in_progress', 'בביצוע', counts.in_progress],
            ['done', 'ממתינות לאישור', counts.done],
          ] as const).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className="flex-shrink-0 px-4 py-1.5 rounded-full text-sm font-semibold transition-all"
              style={
                filter === key
                  ? { background: GOLD_BTN, color: '#050507', boxShadow: '0 2px 10px rgba(201,162,39,0.3)' }
                  : { background: '#141418', border: `1px solid ${BORDER_GOLD_STRONG}`, color: '#9aa0ab' }
              }
            >
              {label}
              {count > 0 && (
                <span className="mr-1.5 text-xs font-bold" style={{ color: filter === key ? '#050507' : 'rgba(201,162,39,0.5)' }}>
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ── AI Suggestions panel ─────────────────────────── */}
        {showSuggest && (
          <div className="rounded-2xl p-4 space-y-3"
            style={{ background: '#141418', border: `1px solid rgba(201,162,39,0.22)` }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4" style={{ color: '#c9a227' }} />
                <span className="text-sm font-bold" style={{ color: '#c9a227' }}>הצעות AI — משימות מומלצות לעסק</span>
              </div>
              <button onClick={() => setShowSuggest(false)}
                className="p-1 rounded-lg transition-colors" style={{ color: '#9aa0ab' }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            {loadingSuggest ? (
              <div className="flex items-center gap-2 py-2">
                <div className="w-4 h-4 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: '#c9a227 transparent transparent transparent' }} />
                <span className="text-sm" style={{ color: '#9aa0ab' }}>מנתח נתוני עסק...</span>
              </div>
            ) : suggestError ? (
              <p className="text-sm py-2" style={{ color: '#ef4444' }}>שגיאה בטעינת ההצעות — נסה שוב</p>
            ) : suggestions.length === 0 ? (
              <p className="text-sm py-2" style={{ color: '#9aa0ab' }}>לא נמצאו הצעות כרגע — הכל תקין!</p>
            ) : (
              <div className="space-y-2">
                {suggestions.map((s, i) => {
                  const priorityColor = s.priority === 'urgent' ? '#ef4444' : s.priority === 'high' ? '#fb923c' : '#60b8e8';
                  return (
                    <div key={i} className="flex items-start justify-between gap-3 p-3 rounded-xl"
                      style={{ background: '#1a1a20', border: '1px solid rgba(201,162,39,0.1)' }}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold" style={{ color: '#e8e8e4' }}>{s.title}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: `${priorityColor}18`, color: priorityColor }}>
                            {s.priority === 'urgent' ? 'דחוף' : s.priority === 'high' ? 'גבוה' : 'רגיל'}
                          </span>
                        </div>
                        <p className="text-xs mt-0.5" style={{ color: '#9aa0ab' }}>{s.description}</p>
                      </div>
                      <button
                        onClick={() => createFromSuggestion(s)}
                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-bold transition-all hover:opacity-80"
                        style={{ background: GOLD_BTN, color: '#050507' }}
                      >
                        צור
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Task list ─────────────────────────────────────── */}
        {loading ? (
          <div className="flex flex-col items-center py-20 gap-3">
            <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: `${GOLD_COLOR} transparent transparent transparent` }} />
            <p className="text-sm" style={{ color: '#9aa0ab' }}>טוען משימות...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center py-20 gap-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: 'rgba(201,162,39,0.08)', border: `1px solid ${BORDER_GOLD_STRONG}` }}>
              <CheckCircle2 className="w-8 h-8" style={{ color: 'rgba(201,162,39,0.5)' }} />
            </div>
            <div className="text-center">
              <p className="font-semibold" style={{ color: '#e8e8e4' }}>אין משימות להצגה</p>
              <p className="text-sm mt-1" style={{ color: '#9aa0ab' }}>הכל נקי ומסודר 🎉</p>
            </div>
            {isManager && (
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-bold text-sm transition-all hover:opacity-90"
                style={{ background: GOLD_BTN, color: '#050507', boxShadow: '0 4px 14px rgba(201,162,39,0.3)' }}
              >
                <Plus className="w-4 h-4" /> צור משימה
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map(task => {
              const isOpen = openTask === task.id;
              const doneCount = task.subtasks.filter(s => s.status === 'done').length;
              const totalCount = task.subtasks.length;
              const progress = totalCount > 0 ? Math.round((doneCount / totalCount) * 100) : 0;
              const isOverdue = task.due_date && task.status !== 'done' && new Date(task.due_date) < new Date();
              const pm = PRIORITY_META[task.priority];
              const isDone = task.status === 'done';

              return (
                <div
                  key={task.id}
                  className="rounded-2xl overflow-hidden transition-all"
                  style={{
                    background: CARD_BG,
                    border: `1px solid ${isDone ? 'rgba(34,197,94,0.25)' : isOverdue ? 'rgba(239,68,68,0.25)' : BORDER_GOLD}`,
                    boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
                  }}
                >
                  {/* Card header */}
                  <div
                    className="px-5 pt-4 pb-3 cursor-pointer select-none"
                    onClick={() => setOpenTask(isOpen ? null : task.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        {/* Priority + status */}
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: pm.dot }} />
                          <span className="text-xs font-semibold" style={{ color: pm.text }}>{pm.label}</span>
                          {isDone && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(201,162,39,0.12)', color: GOLD_COLOR }}>
                              ממתין לאישור
                            </span>
                          )}
                          {isOverdue && !isDone && (
                            <span className="text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-0.5" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444' }}>
                              <AlertTriangle className="w-3 h-3" /> באיחור
                            </span>
                          )}
                        </div>

                        {/* Title */}
                        <p className="font-bold text-base leading-tight" style={{ color: isDone ? '#6b7280' : '#e8e8e4', textDecoration: isDone ? 'line-through' : 'none' }}>
                          {task.title}
                        </p>

                        {/* Meta row */}
                        <div className="flex items-center gap-3 mt-1.5 text-xs flex-wrap" style={{ color: '#9aa0ab' }}>
                          <span className="flex items-center gap-1">
                            <User className="w-3 h-3" />
                            {task.assigned_to_name || 'כל הצוות'}
                          </span>
                          {task.due_date && (
                            <span className="flex items-center gap-1" style={{ color: isOverdue && !isDone ? '#ef4444' : '#9aa0ab', fontWeight: isOverdue && !isDone ? '600' : 'normal' }}>
                              <Clock className="w-3 h-3" />
                              יעד: {formatDate(task.due_date)}
                            </span>
                          )}
                          {totalCount > 0 && (
                            <span>{doneCount}/{totalCount} תת-משימות</span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                        {isDone && isManager && (
                          <button
                            onClick={e => { e.stopPropagation(); handleApprove(task.id); }}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors"
                            style={{ background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.3)', color: '#4ade80' }}
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" /> אשר
                          </button>
                        )}
                        {isManager && (
                          <button
                            onClick={e => { e.stopPropagation(); deleteTask(task.id); }}
                            className="p-1.5 rounded-lg transition-colors"
                            style={{ color: '#6b7280' }}
                            onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                            onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {isOpen
                          ? <ChevronUp className="w-4 h-4" style={{ color: GOLD_COLOR }} />
                          : <ChevronDown className="w-4 h-4" style={{ color: '#6b7280' }} />}
                      </div>
                    </div>

                    {/* Progress bar */}
                    {totalCount > 0 && (
                      <div className="mt-3 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                        <div
                          className="h-full rounded-full transition-all duration-500"
                          style={{ width: `${progress}%`, background: progress === 100 ? 'linear-gradient(90deg,#16a34a,#4ade80)' : GOLD_BTN }}
                        />
                      </div>
                    )}
                  </div>

                  {/* Expanded content */}
                  {isOpen && (
                    <div
                      className="border-t px-5 py-4 space-y-4"
                      style={{ borderColor: BORDER_GOLD, background: EXPANDED_BG }}
                    >
                      {/* Creator info */}
                      <div
                        className="flex items-center gap-2 text-xs rounded-xl px-3 py-2"
                        style={{ background: 'rgba(201,162,39,0.06)', border: `1px solid ${BORDER_GOLD}` }}
                      >
                        <Sparkles className="w-3.5 h-3.5" style={{ color: GOLD_COLOR }} />
                        <span style={{ color: '#9aa0ab' }}>
                          ניתנה על ידי <strong style={{ color: GOLD_COLOR }}>{task.created_by_name}</strong>
                          {' · '}
                          {formatDateTime(task.created_at)}
                        </span>
                      </div>

                      {/* Description */}
                      {task.description && (
                        <div
                          className="text-sm leading-relaxed rounded-xl px-4 py-3"
                          style={{ background: '#141418', border: `1px solid ${BORDER_GOLD}`, color: '#b8bcc4' }}
                        >
                          {task.description}
                        </div>
                      )}

                      {/* Subtasks */}
                      {(task.subtasks.length > 0 || isManager) && (
                        <div className="space-y-2">
                          {task.subtasks.length > 0 && (
                            <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: '#6b7280' }}>תת-משימות</p>
                          )}
                          {task.subtasks.map(sub => (
                            <div
                              key={sub.id}
                              className="flex items-start gap-3 p-3 rounded-xl transition-all"
                              style={{
                                background: sub.status === 'done' ? 'rgba(34,197,94,0.06)' : '#141418',
                                border: `1px solid ${sub.status === 'done' ? 'rgba(34,197,94,0.2)' : BORDER_GOLD}`,
                              }}
                            >
                              {sub.status === 'done'
                                ? <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#4ade80' }} />
                                : <Circle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#6b7280' }} />}
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-medium" style={{ color: sub.status === 'done' ? '#6b7280' : '#e8e8e4', textDecoration: sub.status === 'done' ? 'line-through' : 'none' }}>
                                  {sub.title}
                                </p>
                                {sub.status === 'done' && sub.completed_by_name && (
                                  <p className="text-xs mt-0.5" style={{ color: '#6b7280' }}>
                                    {sub.completed_by_name} · {sub.completed_at ? formatDate(sub.completed_at) : ''}
                                  </p>
                                )}
                                {sub.completion_photo && (
                                  <button onClick={() => setPhotoViewer(photoUrl(sub.completion_photo!))} className="mt-2 block text-left">
                                    <img
                                      src={photoUrl(sub.completion_photo)}
                                      alt="תמונת ביצוע"
                                      className="h-20 w-auto rounded-lg object-cover hover:opacity-80 transition-opacity"
                                      style={{ border: '1px solid rgba(34,197,94,0.3)' }}
                                    />
                                  </button>
                                )}
                              </div>
                              {sub.status === 'pending' && (
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  {/* Gallery picker */}
                                  <input
                                    ref={el => { photoRefs.current[sub.id] = el; }}
                                    type="file" accept="image/*" className="hidden"
                                    onChange={e => {
                                      const file = e.target.files?.[0];
                                      if (file) handlePhotoUpload(task.id, sub.id, file);
                                      e.target.value = '';
                                    }}
                                  />
                                  {/* Camera capture */}
                                  <input
                                    ref={el => { photoCameraRefs.current[sub.id] = el; }}
                                    type="file" accept="image/*" capture="environment" className="hidden"
                                    onChange={e => {
                                      const file = e.target.files?.[0];
                                      if (file) handlePhotoUpload(task.id, sub.id, file);
                                      e.target.value = '';
                                    }}
                                  />
                                  {(isManager || !task.assigned_to || task.assigned_to === user?.userId) && (
                                    <>
                                      <button
                                        onClick={() => photoCameraRefs.current[sub.id]?.click()}
                                        disabled={uploadingSubtasks.has(sub.id)}
                                        title="צלם תמונה"
                                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 min-h-[44px]"
                                        style={{ background: 'rgba(201,162,39,0.1)', border: `1px solid ${BORDER_GOLD_STRONG}`, color: GOLD_COLOR }}
                                      >
                                        {uploadingSubtasks.has(sub.id)
                                          ? <><Loader2 className="w-4 h-4 animate-spin" /> מעלה...</>
                                          : <><Camera className="w-4 h-4" /> צלם</>}
                                      </button>
                                      <button
                                        onClick={() => photoRefs.current[sub.id]?.click()}
                                        disabled={uploadingSubtasks.has(sub.id)}
                                        title="בחר מהגלריה"
                                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold transition-colors disabled:opacity-50 min-h-[44px]"
                                        style={{ background: 'rgba(96,184,232,0.1)', border: '1px solid rgba(96,184,232,0.3)', color: '#60b8e8' }}
                                      >
                                        <span>גלריה</span>
                                      </button>
                                    </>
                                  )}
                                  {isManager && (
                                    <button
                                      onClick={() => deleteSubtask(task.id, sub.id)}
                                      className="p-1 rounded-lg transition-colors"
                                      style={{ color: '#6b7280' }}
                                      onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                                      onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              )}
                            </div>
                          ))}

                          {/* Add subtask inline */}
                          {isManager && task.status !== 'done' && task.status !== 'cancelled' && (
                            addingSubTo === task.id ? (
                              <div className="flex gap-2">
                                <input
                                  autoFocus
                                  value={newSubTitle}
                                  onChange={e => setNewSubTitle(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') addSubtask(task.id);
                                    if (e.key === 'Escape') { setAddingSubTo(null); setNewSubTitle(''); }
                                  }}
                                  placeholder="שם תת-משימה..."
                                  style={inputStyle}
                                />
                                <button
                                  onClick={() => addSubtask(task.id)}
                                  className="px-3 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                                  style={{ background: GOLD_BTN, color: '#050507' }}
                                >
                                  הוסף
                                </button>
                                <button
                                  onClick={() => { setAddingSubTo(null); setNewSubTitle(''); }}
                                  className="px-3 py-2 rounded-xl text-sm transition-colors"
                                  style={{ background: '#1a1a20', border: `1px solid ${BORDER_GOLD}`, color: '#9aa0ab' }}
                                >
                                  ביטול
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => { setAddingSubTo(task.id); setNewSubTitle(''); }}
                                className="flex items-center gap-1 text-xs font-semibold transition-colors"
                                style={{ color: 'rgba(201,162,39,0.6)' }}
                                onMouseEnter={e => (e.currentTarget.style.color = GOLD_COLOR)}
                                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(201,162,39,0.6)')}
                              >
                                <Plus className="w-3.5 h-3.5" /> הוסף תת-משימה
                              </button>
                            )
                          )}
                        </div>
                      )}

                      {/* Complete task button */}
                      {(task.status === 'open' || task.status === 'in_progress') &&
                        (isManager || !task.assigned_to || task.assigned_to === user?.userId) && (
                        <>
                          {/* Gallery picker */}
                          <input
                            ref={el => { taskPhotoRefs.current[task.id] = el; }}
                            type="file" accept="image/*" className="hidden"
                            onChange={e => {
                              const file = e.target.files?.[0];
                              if (file) handleTaskComplete(task.id, file);
                              e.target.value = '';
                            }}
                          />
                          {/* Camera capture */}
                          <input
                            ref={el => { taskPhotoCameraRefs.current[task.id] = el; }}
                            type="file" accept="image/*" capture="environment" className="hidden"
                            onChange={e => {
                              const file = e.target.files?.[0];
                              if (file) handleTaskComplete(task.id, file);
                              e.target.value = '';
                            }}
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => taskPhotoCameraRefs.current[task.id]?.click()}
                              disabled={uploadingTasks.has(task.id)}
                              className="flex-1 flex items-center justify-center gap-2 py-3.5 rounded-2xl font-bold text-sm transition-all hover:opacity-90 disabled:opacity-60"
                              style={{ background: GOLD_BTN, color: '#050507', boxShadow: '0 4px 18px rgba(201,162,39,0.35)' }}
                            >
                              {uploadingTasks.has(task.id)
                                ? <><Loader2 className="w-5 h-5 animate-spin" /> מעלה תמונה...</>
                                : <><Camera className="w-5 h-5" /> צלם תמונה לאישור</>}
                            </button>
                            <button
                              onClick={() => taskPhotoRefs.current[task.id]?.click()}
                              disabled={uploadingTasks.has(task.id)}
                              className="flex items-center justify-center gap-1.5 px-4 py-3.5 rounded-2xl font-bold text-sm transition-all hover:opacity-90 disabled:opacity-60"
                              style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: '#e8e8e4' }}
                            >
                              גלריה
                            </button>
                          </div>
                        </>
                      )}

                      {/* Done — awaiting manager approval */}
                      {task.status === 'done' && isManager && (
                        <div
                          className="rounded-2xl p-4 text-center space-y-2"
                          style={{ border: '2px solid rgba(34,197,94,0.25)', background: 'rgba(34,197,94,0.05)' }}
                        >
                          <p className="text-sm font-semibold" style={{ color: '#4ade80' }}>המשימה הושלמה — ממתינה לאישורך</p>
                          {task.completion_photo && (
                            <button onClick={() => setPhotoViewer(photoUrl(task.completion_photo!))} className="block mx-auto">
                              <img
                                src={photoUrl(task.completion_photo)}
                                alt="תמונת ביצוע"
                                className="mx-auto h-32 w-auto rounded-xl object-cover hover:opacity-80 transition-opacity"
                                style={{ border: '2px solid rgba(34,197,94,0.3)' }}
                              />
                            </button>
                          )}
                          <button
                            onClick={() => handleApprove(task.id)}
                            className="w-full py-2.5 rounded-xl font-bold text-sm transition-all hover:opacity-90"
                            style={{ background: 'linear-gradient(135deg, #16a34a, #22c55e)', color: 'white', boxShadow: '0 4px 14px rgba(34,197,94,0.3)' }}
                          >
                            <CheckCircle2 className="w-4 h-4 inline ml-1" />
                            אשר ושלח להיסטוריה
                          </button>
                        </div>
                      )}

                      {/* Done — employee view */}
                      {task.status === 'done' && !isManager && (
                        <div className="flex items-center justify-center gap-2 py-3 text-sm font-semibold" style={{ color: '#4ade80' }}>
                          <CheckCircle2 className="w-5 h-5" />
                          הושלמה — ממתינה לאישור המנהל
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── History Modal ─────────────────────────────────────── */}
      <Modal open={showHistory} onClose={() => setShowHistory(false)} title={`היסטוריית משימות (${history.length})`} size="md">
        <div className="p-4 space-y-3 max-h-[60vh] overflow-y-auto">
          {history.length === 0 ? (
            <p className="text-center py-8 text-sm" style={{ color: '#9aa0ab' }}>אין עדיין משימות בהיסטוריה</p>
          ) : (
            history.map(task => (
              <div
                key={task.id}
                className="flex items-start gap-3 p-3 rounded-xl"
                style={{ background: '#141418', border: `1px solid ${BORDER_GOLD}` }}
              >
                <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#4ade80' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold line-through" style={{ color: '#9aa0ab' }}>{task.title}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#6b7280' }}>
                    {task.created_by_name} · {formatDate(task.created_at)}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>

      {/* ── Create Task Modal ─────────────────────────────────── */}
      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="משימה חדשה" size="md">
        <div className="p-6 space-y-4">
          <Input label="כותרת *" value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="מה צריך לעשות?" />
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: '#9aa0ab' }}>תיאור (אופציונלי)</label>
            <textarea
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              placeholder="פירוט נוסף..."
              rows={2}
              style={{ ...inputStyle, resize: 'none' }}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: '#9aa0ab' }}>עדיפות</label>
              <select
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                style={inputStyle}
              >
                <option value="low">נמוכה</option>
                <option value="normal">רגילה</option>
                <option value="high">גבוהה</option>
                <option value="urgent">דחופה</option>
              </select>
            </div>
            <DatePicker label="תאריך יעד" value={form.dueDate} onChange={v => setForm(f => ({ ...f, dueDate: v }))} clearable />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1" style={{ color: '#9aa0ab' }}>הקצה לעובד</label>
            <select
              value={form.assignedTo}
              onChange={e => setForm(f => ({ ...f, assignedTo: e.target.value }))}
              style={inputStyle}
            >
              <option value="">כל הצוות</option>
              {employees.map(e => <option key={e.id} value={e.id}>{e.full_name}</option>)}
            </select>
          </div>

          {/* Subtasks */}
          <div>
            <label className="block text-sm font-medium mb-2" style={{ color: '#9aa0ab' }}>תת-משימות</label>
            <div className="space-y-2">
              {subtaskInputs.map((s, i) => (
                <div key={subtaskKeys[i]} className="flex gap-2">
                  <input
                    value={s}
                    onChange={e => setSubtaskInputs(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                    placeholder={`תת-משימה ${i + 1}...`}
                    style={inputStyle}
                  />
                  {subtaskInputs.length > 1 && (
                    <button
                      onClick={() => {
                        setSubtaskInputs(prev => prev.filter((_, j) => j !== i));
                        setSubtaskKeys(prev => prev.filter((_, j) => j !== i));
                      }}
                      className="p-2 transition-colors"
                      style={{ color: '#6b7280' }}
                      onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                      onMouseLeave={e => (e.currentTarget.style.color = '#6b7280')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => {
                  setSubtaskInputs(prev => [...prev, '']);
                  setSubtaskKeys(prev => [...prev, crypto.randomUUID()]);
                }}
                className="flex items-center gap-1 text-sm font-medium transition-colors"
                style={{ color: 'rgba(201,162,39,0.7)' }}
                onMouseEnter={e => (e.currentTarget.style.color = GOLD_COLOR)}
                onMouseLeave={e => (e.currentTarget.style.color = 'rgba(201,162,39,0.7)')}
              >
                <Plus className="w-4 h-4" /> הוסף תת-משימה
              </button>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2" style={{ borderTop: `1px solid ${BORDER_GOLD}` }}>
            <Button variant="outline" onClick={() => setShowCreate(false)}>ביטול</Button>
            <Button onClick={createTask} loading={creating} disabled={creating || !form.title.trim()}>
              צור משימה
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Photo lightbox ── */}
      {photoViewer && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.9)' }}
          onClick={() => setPhotoViewer(null)}
        >
          <button
            className="absolute top-4 right-4 p-2 rounded-full text-white hover:bg-white/10"
            onClick={() => setPhotoViewer(null)}
          >
            <X className="w-6 h-6" />
          </button>
          <img
            src={photoViewer}
            alt="תמונת ביצוע"
            className="max-w-full max-h-full rounded-xl object-contain"
            onClick={e => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
