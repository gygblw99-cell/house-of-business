'use client';

import { useCallback, useEffect, useState, useRef } from 'react';
import { Send, Trash2, Users, MessageSquare, CheckCheck, Check, History } from 'lucide-react';
import { messagesApi, employeesApi } from '@/lib/api';
import { formatDateTime, getErrorMessage } from '@/lib/utils';
import { useSyncEvent } from '@/context/SyncContext';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { useAppDialog } from '@/context/AppDialogContext';

interface MessageReader { id: string; full_name: string; }
interface Message {
  id: string; sender_id: string; sender_name: string; content: string;
  recipient_ids: string[]; group_name: string | null; is_read: boolean; created_at: string;
  is_read_by: string[]; readers: MessageReader[];
}
interface Employee { id: string; full_name: string; }

export default function MessagesPage() {
  const { toast } = useAppDialog();
  const currentUser    = useAppSelector(s => s.auth.user);
  const [messages, setMessages]     = useState<Message[]>([]);
  const [employees, setEmployees]   = useState<Employee[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showCompose, setShowCompose] = useState(false);

  // compose form
  const [content, setContent]           = useState('');
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [groupName, setGroupName]       = useState('');
  const [sending, setSending]           = useState(false);
  const [composeError, setComposeError] = useState('');

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [showHistory, setShowHistory]       = useState(false);
  const [historyMsgs, setHistoryMsgs]       = useState<Message[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const openHistory = async () => {
    setShowHistory(true);
    setHistoryLoading(true);
    try {
      const { data } = await messagesApi.history();
      setHistoryMsgs(Array.isArray(data) ? data : []);
    } catch { setHistoryMsgs([]); }
    finally { setHistoryLoading(false); }
  };

  const load = useCallback(() => {
    Promise.all([
      messagesApi.list(),
      employeesApi.list(),
    ]).then(([msgs, emps]) => {
      setMessages(Array.isArray(msgs.data) ? msgs.data : []);
      setEmployees((emps.data.employees || []).filter((e: Employee & { is_active: boolean }) => e.is_active));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh when an employee reads a message
  useSyncEvent(['new_message', 'message_read'], load);

  const markRead = async (id: string) => {
    try { await messagesApi.markRead(id); setMessages(prev => prev.map(m => m.id === id ? { ...m, is_read: true } : m)); }
    catch (err) { toast(getErrorMessage(err) || 'סימון כנקרא נכשל'); }
  };

  const deleteMsg = async (id: string) => {
    try { await messagesApi.delete(id); setMessages(prev => prev.filter(m => m.id !== id)); }
    catch (err) { toast(getErrorMessage(err)); }
  };

  const toggleRecipient = (id: string) =>
    setRecipientIds(prev => prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]);

  const send = async () => {
    if (!content.trim()) { setComposeError('יש להזין תוכן'); return; }
    if (recipientIds.length === 0) { setComposeError('יש לבחור לפחות נמען אחד'); return; }
    setSending(true); setComposeError('');
    try {
      await messagesApi.send({ recipientIds, content: content.trim(), groupName: groupName || null });
      setShowCompose(false); setContent(''); setRecipientIds([]); setGroupName('');
      load();
    } catch (err) { setComposeError(getErrorMessage(err)); }
    finally { setSending(false); }
  };

  const unread = messages.filter(m => !m.is_read && m.sender_id !== currentUser?.userId).length;

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#e8e8e4]">
              הודעות צוות
              {unread > 0 && <span className="mr-2 text-sm bg-blue-600 text-white px-2 py-0.5 rounded-full">{unread}</span>}
            </h1>
          <p className="text-sm text-[rgba(232,232,228,0.45)] mt-1">הודעות פנימיות לצוות העסק</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={openHistory}><History className="w-4 h-4" /> היסטוריה</Button>
          <Button onClick={() => { setShowCompose(true); setComposeError(''); }}>
            <Send className="w-4 h-4" /> הודעה חדשה
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-16 text-[rgba(232,232,228,0.4)]">טוען...</div>
      ) : messages.length === 0 ? (
        <Card>
          <CardContent className="text-center py-16">
            <MessageSquare className="w-12 h-12 text-[rgba(232,232,228,0.2)] mx-auto mb-3" />
            <p className="text-[rgba(232,232,228,0.4)]">אין הודעות עדיין</p>
            <p className="text-sm text-[rgba(232,232,228,0.4)] mt-1">לחץ "הודעה חדשה" לשלוח לצוות</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {messages.map(m => {
            const isOwn = m.sender_id === currentUser?.userId;
            const unreadMsg = !m.is_read && !isOwn;
            return (
              <Card key={m.id} className={unreadMsg ? 'border-blue-200 bg-blue-50/30' : ''}>
                <CardContent className="py-3">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5">
                      {m.sender_name?.charAt(0) || '?'}
                    </div>
                    <div
                      className="flex-1 min-w-0"
                      role={unreadMsg ? 'button' : undefined}
                      tabIndex={unreadMsg ? 0 : undefined}
                      onClick={() => { if (unreadMsg) markRead(m.id); }}
                      onKeyDown={e => { if (unreadMsg && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); markRead(m.id); } }}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-[#e8e8e4]">{m.sender_name}</span>
                        {isOwn && <Badge variant="info">יצאה</Badge>}
                        {unreadMsg && <Badge variant="default">חדש</Badge>}
                        {m.group_name && (
                          <span className="text-xs text-[rgba(232,232,228,0.4)] flex items-center gap-1">
                            <Users className="w-3 h-3" />{m.group_name}
                          </span>
                        )}
                        <span className="text-xs text-[rgba(232,232,228,0.4)] mr-auto">{formatDateTime(m.created_at)}</span>
                      </div>
                      <p className="text-sm text-[rgba(232,232,228,0.75)] mt-1 whitespace-pre-wrap">{m.content}</p>
                      {isOwn && (() => {
                        const readers = m.readers || [];
                        const totalRecipients = (m.recipient_ids || []).length;
                        const allRead = totalRecipients > 0 && readers.length >= totalRecipients;
                        return (
                          <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                            {allRead
                              ? <CheckCheck className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                              : readers.length > 0
                                ? <CheckCheck className="w-3.5 h-3.5 text-[rgba(232,232,228,0.4)] flex-shrink-0" />
                                : <Check className="w-3.5 h-3.5 text-[rgba(232,232,228,0.3)] flex-shrink-0" />}
                            {readers.length > 0
                              ? <span className="text-xs text-[rgba(232,232,228,0.4)]">
                                  קראו: {readers.map(r => r.full_name).join(', ')}
                                  {!allRead && ` (${readers.length}/${totalRecipients})`}
                                </span>
                              : <span className="text-xs text-[rgba(232,232,228,0.4)]">לא נקרא עדיין (0/{totalRecipients})</span>}
                          </div>
                        );
                      })()}
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      {isOwn && (
                        <button onClick={() => deleteMsg(m.id)} className="text-[rgba(232,232,228,0.3)] hover:text-red-400">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Modal — כתיבת הודעה */}
      <Modal open={showCompose} onClose={() => setShowCompose(false)} title="הודעה חדשה לצוות" size="md">
        <div className="space-y-4" dir="rtl">
          <div>
            <label className="text-sm font-medium text-[rgba(232,232,228,0.75)] block mb-2">נמענים</label>
            <div className="flex flex-wrap gap-2">
              {employees.filter(e => e.id !== currentUser?.userId).map(e => (
                <button key={e.id} onClick={() => toggleRecipient(e.id)}
                  className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${
                    recipientIds.includes(e.id)
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-[#141418] text-[rgba(232,232,228,0.6)] border-[rgba(201,162,39,0.14)] hover:bg-[rgba(201,162,39,0.06)]'
                  }`}>
                  {e.full_name}
                </button>
              ))}
            </div>
            {recipientIds.length > 0 && (
              <p className="text-xs text-[rgba(232,232,228,0.45)] mt-1">{recipientIds.length} נמענים נבחרו</p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-[rgba(232,232,228,0.75)] block mb-1">נושא (אופציונלי)</label>
            <input
              type="text"
              value={groupName}
              onChange={e => setGroupName(e.target.value)}
              placeholder="לדוג׳: עדכון תפריט, שינוי משמרות..."
              className="w-full border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.75)] rounded-xl px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div>
            <label className="text-sm font-medium text-[rgba(232,232,228,0.75)] block mb-1">הודעה</label>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="כתוב את ההודעה שלך..."
              rows={5}
              className="w-full border border-[rgba(201,162,39,0.16)] bg-[#141418] text-[rgba(232,232,228,0.75)] rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {composeError && <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{composeError}</p>}

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={() => setShowCompose(false)}>ביטול</Button>
            <Button onClick={send} loading={sending}>
              <Send className="w-4 h-4" /> שלח
            </Button>
          </div>
        </div>
      </Modal>

      {/* History modal */}
      <Modal open={showHistory} onClose={() => setShowHistory(false)} title="היסטוריית הודעות">
        <div className="p-4 space-y-2 max-h-[70vh] overflow-y-auto" dir="rtl">
          {historyLoading ? (
            <p className="text-center text-[rgba(232,232,228,0.4)] py-8">טוען...</p>
          ) : historyMsgs.length === 0 ? (
            <p className="text-center text-[rgba(232,232,228,0.4)] py-8">אין היסטוריה</p>
          ) : historyMsgs.map(m => {
            const isOwn = m.sender_id === currentUser?.userId;
            return (
              <div key={m.id} className={`p-3 rounded-xl border text-sm ${isOwn ? 'bg-blue-950/20 border-blue-800/30' : m.is_read ? 'bg-[#1a1a20] border-[rgba(201,162,39,0.1)]' : 'bg-[#141418] border-[rgba(201,162,39,0.16)]'}`}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-medium text-[rgba(232,232,228,0.75)]">{isOwn ? 'אתה' : m.sender_name}</span>
                  <span className="text-xs text-[rgba(232,232,228,0.4)]">{formatDateTime(m.created_at)}</span>
                </div>
                <p className="text-[rgba(232,232,228,0.75)] whitespace-pre-wrap">{m.content}</p>
                {m.is_read_by?.length > 0 && (
                  <p className="text-xs text-[rgba(232,232,228,0.4)] mt-1 flex items-center gap-1">
                    <CheckCheck className="w-3 h-3" /> נקרא
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}
