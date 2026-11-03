'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2, Bell, Clock, LayoutDashboard, CalendarX, History } from 'lucide-react';
import { remindersApi } from '@/lib/api';
import { getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { useAppDialog } from '@/context/AppDialogContext';
import { useSyncEvent } from '@/context/SyncContext';

interface Reminder {
  id: string; title: string; remind_at: string; is_sent: boolean; created_at: string;
  show_on_dashboard: boolean; expires_at: string | null;
}

function formatRemindAt(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function isPast(iso: string) { return new Date(iso) < new Date(); }

// datetime-local input מצפה לשעה מקומית — ממיר Date לפורמט מקומי
function toLocalInput(d: Date): string {
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - offset).toISOString().slice(0, 16);
}

const emptyForm = { title: '', remindAt: '', showOnDashboard: false, expiresAt: '' };

export default function RemindersPage() {
  const { toast, confirm } = useAppDialog();
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading]     = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm]           = useState(emptyForm);
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory]         = useState<Reminder[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const load = () => {
    remindersApi.list().then(({ data }) => {
      setReminders(Array.isArray(data) ? data : []);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);
  useSyncEvent('notification', load);

  const openNew = () => {
    const now = new Date();
    now.setHours(now.getHours() + 1, 0, 0, 0);
    setForm({ ...emptyForm, remindAt: toLocalInput(now) });
    setEditingId(null); setError('');
    setShowModal(true);
  };

  const openEdit = (r: Reminder) => {
    setForm({
      title: r.title,
      remindAt: toLocalInput(new Date(r.remind_at)),
      showOnDashboard: !!r.show_on_dashboard,
      expiresAt: r.expires_at ? toLocalInput(new Date(r.expires_at)) : '',
    });
    setEditingId(r.id); setError('');
    setShowModal(true);
  };

  const save = async () => {
    if (!form.title.trim()) { setError('כותרת חסרה'); return; }
    if (!form.remindAt)     { setError('תאריך חסר'); return; }
    setSaving(true); setError('');
    try {
      const payload = {
        title: form.title,
        remindAt: new Date(form.remindAt).toISOString(),
        showOnDashboard: form.showOnDashboard,
        expiresAt: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      };
      if (editingId) await remindersApi.update(editingId, payload);
      else           await remindersApi.create(payload);
      setShowModal(false);
      toast(editingId ? 'תזכורת עודכנה' : 'תזכורת נוצרה', 'success');
      load();
    } catch (err) { setError(getErrorMessage(err)); }
    finally { setSaving(false); }
  };

  const del = async (id: string) => {
    if (!await confirm('האם למחוק תזכורת זו?', 'מחיקת תזכורת')) return;
    try { await remindersApi.delete(id); setReminders(prev => prev.filter(r => r.id !== id)); }
    catch (err) { toast(getErrorMessage(err)); }
  };

  const openHistory = async () => {
    setShowHistory(true);
    setHistoryLoading(true);
    try {
      const { data } = await remindersApi.history();
      setHistory(Array.isArray(data) ? data : []);
    } catch { setHistory([]); }
    finally { setHistoryLoading(false); }
  };

  const upcoming = reminders.filter(r => !isPast(r.remind_at) && !r.is_sent);
  const pinned   = upcoming.filter(r => r.show_on_dashboard);

  return (
    <div className="space-y-6 max-w-2xl" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">תזכורות</h1>
          <p className="text-sm text-[rgba(232,232,228,0.42)] mt-1">
            {upcoming.length} קרובות
            {pinned.length > 0 && <span className="mr-2 text-blue-600">· {pinned.length} מוצגות בדשבורד</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={openHistory}><History className="w-4 h-4" /> היסטוריה</Button>
          <Button onClick={openNew}><Plus className="w-4 h-4" /> תזכורת חדשה</Button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-gray-400">טוען...</div>
      ) : upcoming.length === 0 ? (
        <Card>
          <CardContent className="text-center py-16">
            <Bell className="w-12 h-12 text-gray-200 mx-auto mb-3" />
            <p className="text-gray-400">אין תזכורות קרובות</p>
            <p className="text-sm text-gray-400 mt-1">לחץ "תזכורת חדשה" להוסיף · לחץ "היסטוריה" לראות ישנות</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {upcoming.map(r => (
            <Card key={r.id} className={r.show_on_dashboard ? 'border-blue-300 bg-blue-50/20' : 'border-blue-100'}>
              <CardContent className="py-3">
                <div className="flex items-center gap-3">
                  <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${r.show_on_dashboard ? 'bg-blue-900/40' : 'bg-blue-900/20'}`}>
                    <Bell className="w-4 h-4 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-[#e8e8e4]">{r.title}</p>
                      {r.show_on_dashboard && (
                        <span className="flex items-center gap-1 text-xs bg-blue-900/30 text-blue-300 px-2 py-0.5 rounded-full font-medium">
                          <LayoutDashboard className="w-3 h-3" /> דשבורד
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      <p className="text-xs text-[rgba(232,232,228,0.42)] flex items-center gap-1">
                        <Clock className="w-3 h-3" />{formatRemindAt(r.remind_at)}
                      </p>
                      {r.expires_at && (
                        <p className="text-xs text-orange-500 flex items-center gap-1">
                          <CalendarX className="w-3 h-3" />פג {formatRemindAt(r.expires_at)}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => openEdit(r)} className="text-xs text-blue-600 hover:underline">ערוך</button>
                    <button onClick={() => del(r.id)} className="text-gray-300 hover:text-red-500">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Modal open={showModal} onClose={() => setShowModal(false)} title={editingId ? 'עריכת תזכורת' : 'תזכורת חדשה'} size="sm">
        <div className="space-y-4" dir="rtl">
          <Input label="כותרת" value={form.title}
            onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
            placeholder="לדוג׳: לשלם חשמל, להזמין ציוד..." />

          <div>
            <label className="text-sm font-medium text-[rgba(232,232,228,0.72)] block mb-1">תאריך ושעה לתזכורת</label>
            <input type="datetime-local" value={form.remindAt}
              onChange={e => setForm(f => ({ ...f, remindAt: e.target.value }))}
              className="w-full border border-[rgba(201,162,39,0.16)] bg-[#1a1a20] text-[#e8e8e4] rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[rgba(201,162,39,0.4)]" />
          </div>

          {/* תאריך תפוגה */}
          <div className={`rounded-xl border-2 transition-all overflow-hidden ${
            form.expiresAt ? 'border-orange-400/50 bg-orange-900/10' : 'border-[rgba(201,162,39,0.16)] bg-[#141418]'
          }`}>
            <button
              type="button"
              onClick={() => setForm(f => ({ ...f, expiresAt: f.expiresAt ? '' : toLocalInput(new Date(Date.now() + 7 * 86400000)) }))}
              className="w-full flex items-center justify-between px-4 py-3"
            >
              <div className="flex items-center gap-2">
                <CalendarX className={`w-4 h-4 ${form.expiresAt ? 'text-orange-500' : 'text-gray-400'}`} />
                <div className="text-right">
                  <p className={`text-sm font-medium ${form.expiresAt ? 'text-orange-400' : 'text-[rgba(232,232,228,0.55)]'}`}>תאריך תפוגה</p>
                  {!form.expiresAt && <p className="text-xs text-[rgba(232,232,228,0.4)]">התזכורת תמחק אוטומטית בתאריך שתבחר</p>}
                  {form.expiresAt && <p className="text-xs text-orange-500">פגה ב-{new Date(form.expiresAt).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</p>}
                </div>
              </div>
              <div className={`w-10 h-5 rounded-full transition-colors relative flex-shrink-0 ${form.expiresAt ? 'bg-orange-400' : 'bg-[rgba(232,232,228,0.15)]'}`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-[#e8e8e4] shadow transition-all ${form.expiresAt ? 'right-0.5' : 'left-0.5'}`} />
              </div>
            </button>
            {form.expiresAt && (
              <div className="px-4 pb-3">
                <input type="datetime-local" value={form.expiresAt}
                  onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))}
                  className="w-full border border-orange-400/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-400/40 bg-[#1a1a20] text-[#e8e8e4]" />
              </div>
            )}
          </div>

          {/* Toggle — הצג בדשבורד */}
          <button type="button"
            onClick={() => setForm(f => ({ ...f, showOnDashboard: !f.showOnDashboard }))}
            className={`w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all ${
              form.showOnDashboard
                ? 'border-blue-500/50 bg-blue-900/15 text-blue-300'
                : 'border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.55)] hover:border-[rgba(201,162,39,0.3)]'
            }`}>
            <div className="flex items-center gap-2">
              <LayoutDashboard className="w-4 h-4" />
              <span className="text-sm font-medium">הצג בדשבורד</span>
            </div>
            <div className={`w-10 h-5 rounded-full transition-colors relative ${form.showOnDashboard ? 'bg-blue-500' : 'bg-[rgba(232,232,228,0.15)]'}`}>
              <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-[#e8e8e4] shadow transition-all ${form.showOnDashboard ? 'right-0.5' : 'left-0.5'}`} />
            </div>
          </button>

          {error && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setShowModal(false)}>ביטול</Button>
            <Button onClick={save} loading={saving}>שמור</Button>
          </div>
        </div>
      </Modal>

      {/* History modal */}
      <Modal open={showHistory} onClose={() => setShowHistory(false)} title="היסטוריית תזכורות">
        <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto" dir="rtl">
          {historyLoading ? (
            <p className="text-center text-gray-400 py-8">טוען...</p>
          ) : history.length === 0 ? (
            <p className="text-center text-gray-400 py-8">אין היסטוריה</p>
          ) : history.map(r => (
            <div key={r.id} className="flex items-start gap-3 p-3 rounded-xl bg-[#1a1a20] border border-[rgba(201,162,39,0.14)]">
              <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${r.is_sent ? 'bg-green-400' : 'bg-[rgba(232,232,228,0.3)]'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[rgba(232,232,228,0.72)] truncate">{r.title}</p>
                <p className="text-xs text-[rgba(232,232,228,0.4)] mt-0.5">{formatRemindAt(r.remind_at)}</p>
              </div>
              <span className="text-xs text-[rgba(232,232,228,0.4)] flex-shrink-0">
                {r.is_sent ? 'נשלחה' : 'נמחקה'}
              </span>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
