'use client';

import { useEffect } from 'react';
import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { fetchNotifications, markRead, markAllRead, deleteNotification } from '@/store/slices/notificationsSlice';
import { useSyncEvent } from '@/context/SyncContext';
import { timeAgo, getErrorMessage } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useAppDialog } from '@/context/AppDialogContext';

export default function NotificationsPage() {
  const dispatch = useAppDispatch();
  const { toast, confirm } = useAppDialog();
  const { items, loading } = useAppSelector((s) => s.notifications);

  useEffect(() => { dispatch(fetchNotifications()); }, [dispatch]);
  useSyncEvent('notification', () => dispatch(fetchNotifications()));

  return (
    <div className="space-y-6 max-w-2xl" dir="rtl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-[#e8e8e4]">התראות</h1>
        {items.some((n) => !n.is_read) && (
          <Button variant="outline" size="sm" onClick={() => dispatch(markAllRead()).unwrap().catch((err) => toast(getErrorMessage(err) || 'סימון הכל כנקרא נכשל', 'error'))}>
            <CheckCheck className="w-4 h-4" /> סמן הכל כנקרא
          </Button>
        )}
      </div>

      {loading ? (
        <div className="text-center py-12 text-[rgba(232,232,228,0.42)]">טוען...</div>
      ) : items.length === 0 ? (
        <div className="text-center py-16">
          <Bell className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-[rgba(232,232,228,0.42)]">אין התראות חדשות</p>
        </div>
      ) : (
        <Card>
          <div className="divide-y divide-[rgba(201,162,39,0.08)]">
            {items.map((notif) => (
              <div
                key={notif.id}
                className={`flex items-start gap-3 px-6 py-4 hover:bg-[rgba(201,162,39,0.06)] transition-colors cursor-pointer ${
                  !notif.is_read ? 'bg-blue-900/10' : ''
                }`}
                onClick={() => !notif.is_read && dispatch(markRead(notif.id)).unwrap().catch((err) => toast(getErrorMessage(err) || 'סימון כנקרא נכשל', 'error'))}
              >
                <div className={`mt-1 w-2 h-2 rounded-full flex-shrink-0 ${!notif.is_read ? 'bg-blue-500' : 'bg-transparent'}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${!notif.is_read ? 'font-semibold text-[#e8e8e4]' : 'font-medium text-[rgba(232,232,228,0.72)]'}`}>
                    {notif.title}
                  </p>
                  <p className="text-sm text-[rgba(232,232,228,0.42)] mt-0.5">{notif.body}</p>
                  <p className="text-xs text-[rgba(232,232,228,0.42)] mt-1">{timeAgo(notif.created_at)}</p>
                </div>
                <button
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!await confirm('האם למחוק התראה זו?', 'מחיקת התראה')) return;
                    dispatch(deleteNotification(notif.id)).unwrap().catch((err) => toast(getErrorMessage(err) || 'מחיקת ההתראה נכשלה', 'error'));
                  }}
                  className="p-1.5 rounded-lg text-[rgba(232,232,228,0.3)] hover:text-red-400 hover:bg-red-500/10 transition-colors flex-shrink-0"
                  title="מחק התראה"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
