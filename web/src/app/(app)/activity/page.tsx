'use client';

import { useEffect, useState } from 'react';
import { History, RefreshCw, User } from 'lucide-react';
import { activityApi } from '@/lib/api';
import { useSyncEvent } from '@/context/SyncContext';
import { Card, CardContent } from '@/components/ui/Card';
import { getErrorMessage } from '@/lib/utils';
import { useAppDialog } from '@/context/AppDialogContext';
import { useLatestRequest } from '@/hooks/useLatestRequest';

interface ActivityEntry {
  id: string;
  action: string;
  details: Record<string, unknown> | null;
  createdAt: string;
  user: { name: string | null; role: string | null };
}

const ACTION_LABELS: Record<string, string> = {
  login: 'התחברות', logout: 'התנתקות', password_reset: 'איפוס סיסמה',
  employee_added: 'עובד נוסף', employee_updated: 'עדכון עובד', employee_removed: 'עובד הוסר',
  shift_clock_in: 'כניסה למשמרת', shift_clock_out: 'יציאה ממשמרת', shift_edited: 'עריכת משמרת', absent_marked: 'סימון היעדרות',
  inventory_updated: 'עדכון מלאי', waste_recorded: 'רישום פחת',
  invoice_uploaded: 'העלאת חשבונית', invoice_approved: 'אישור חשבונית', invoice_deleted: 'מחיקת חשבונית',
  supplier_added: 'ספק נוסף', order_sent: 'הזמנה נשלחה', order_cancelled: 'הזמנה בוטלה',
  pos_connected: 'חיבור קופה', pos_synced: 'סנכרון קופה',
  expense_added: 'הוצאה נוספה', expense_deleted: 'הוצאה נמחקה',
  recipe_created: 'מנה נוצרה', recipe_updated: 'עדכון מנה', recipe_deleted: 'מחיקת מנה',
  ai_chat: 'שיחת AI',
};

const ROLE_LABELS: Record<string, string> = {
  owner: 'בעלים', partner: 'שותף', manager: 'מנהל', employee: 'עובד',
};

export default function ActivityLogPage() {
  const { toast } = useAppDialog();
  const [entries, setEntries]   = useState<ActivityEntry[]>([]);
  const [actions, setActions]   = useState<string[]>([]);
  const [actionFilter, setActionFilter] = useState('');
  const [loading, setLoading]   = useState(true);

  const beginRequest = useLatestRequest();

  const load = () => {
    const latest = beginRequest();
    setLoading(true);
    activityApi.list({ limit: 100, action: actionFilter || undefined })
      .then(r => latest(() => setEntries(Array.isArray(r.data) ? r.data : [])))
      .catch(err => latest(() => { setEntries([]); toast(getErrorMessage(err) || 'שגיאה בטעינת יומן הפעילות', 'error'); }))
      .finally(() => latest(() => setLoading(false)));
  };

  useEffect(() => { load(); }, [actionFilter]); // eslint-disable-line react-hooks/exhaustive-deps
  // יומן פעילות רחב מדי מכדי להאזין לכל סוג אירוע — רענון קליל כשיש פעילות מכירות/כללית
  useSyncEvent('dashboard.refresh', load);
  useEffect(() => { activityApi.actions().then(r => setActions(Array.isArray(r.data) ? r.data : [])).catch(() => {}); }, []);

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <History className="w-6 h-6" style={{ color: '#c9a227' }} />
            יומן פעילות
          </h1>
          <p className="text-sm opacity-60 mt-0.5">מעקב אחר פעולות משתמשים בעסק — ביקורת ושקיפות</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={actionFilter}
            onChange={e => setActionFilter(e.target.value)}
            className="px-3 py-2 rounded-xl text-sm outline-none"
            style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border-color)' }}
          >
            <option value="">כל הפעולות</option>
            {actions.map(a => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
          </select>
          <button onClick={load} className="p-2 rounded-xl hover:bg-[rgba(201,162,39,0.06)] transition-colors" title="רענן">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[...Array(8)].map((_, i) => <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: 'var(--card-bg)' }} />)}
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center opacity-50">
            <p>אין רשומות פעילות להצגה</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y" style={{ borderColor: 'var(--card-border-color)' }}>
              {entries.map(e => (
                <div key={e.id} className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--card-border-color)' }}>
                  <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(201,162,39,0.1)' }}>
                    <User className="w-4 h-4" style={{ color: '#c9a227' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold">
                      {ACTION_LABELS[e.action] || e.action}
                      {e.user?.name && <span className="font-normal opacity-60"> — {e.user.name}</span>}
                      {e.user?.role && <span className="text-xs opacity-40"> ({ROLE_LABELS[e.user.role] || e.user.role})</span>}
                    </p>
                  </div>
                  <span className="text-xs opacity-40 flex-shrink-0">
                    {new Date(e.createdAt).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
