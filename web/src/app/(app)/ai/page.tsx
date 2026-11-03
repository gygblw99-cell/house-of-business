'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMounted } from '@/hooks/useMounted';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { useSyncEvent } from '@/context/SyncContext';
import { Send, Bot, User, Trash2, Loader2, WifiOff } from 'lucide-react';
import { aiApi } from '@/lib/api';
import { formatDateTime, getErrorMessage } from '@/lib/utils';
import { MarkdownText } from '@/components/ui/MarkdownText';
import type { AiMessage } from '@/types';
import { useAppDialog } from '@/context/AppDialogContext';

export default function AiPage() {
  const { confirm, toast } = useAppDialog();
  const isMounted = useMounted();
  const currentUserId = useAppSelector(s => s.auth.user?.userId);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const loadHistory = useCallback(() => {
    aiApi.history().then(({ data }) => {
      if (!isMounted()) return;
      setMessages((data.messages || []).map((m: AiMessage) => ({ ...m, id: m.id ?? crypto.randomUUID() })));
      setHistoryLoading(false);
    }).catch(() => { if (isMounted()) setHistoryLoading(false); });
  }, [isMounted]);

  useEffect(() => { loadHistory(); }, [loadHistory]);
  // השיחה אישית למשתמש — האירוע משודר לכל העסק, אז מסננים לפי userId כדי
  // שרק טאב/מכשיר אחר של אותו משתמש בדיוק יתעדכן (לא כל עובד בעסק)
  useSyncEvent(['ai_chat.updated'], useCallback((data: unknown) => {
    const userId = (data as { userId?: string })?.userId;
    if (userId && userId === currentUserId) loadHistory();
  }, [currentUserId, loadHistory]));

  useEffect(() => { scrollToBottom(); }, [messages]);

  const send = async () => {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput('');
    setLoading(true);

    const userMsg: AiMessage = { id: crypto.randomUUID(), role: 'user', content: msg, timestamp: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const { data } = await aiApi.chat(msg, isOffline);
      const assistantMsg: AiMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.response,
        timestamp: new Date().toISOString(),
        sources: data.sources,
        toolsUsed: data.toolsUsed,
        provider: data.provider,
        fallbackTriggered: data.fallbackTriggered,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: 'assistant', content: `שגיאה: ${getErrorMessage(err)}`, timestamp: new Date().toISOString() },
      ]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  };

  const clearHistory = async () => {
    if (!await confirm('האם למחוק את כל היסטוריית השיחה?', 'מחיקת היסטוריה')) return;
    try {
      await aiApi.clearHistory();
      setMessages([]);
    } catch (err) { toast(getErrorMessage(err) || 'מחיקת ההיסטוריה נכשלה', 'error'); }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const suggestions = [
    'מה הרווח שלי החודש?',
    'אילו מנות הכי רווחיות?',
    'מה המלאי שדורש הזמנה?',
    'כמה שכר צריך לשלם השבוע?',
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)]" dir="rtl">

      {/* Header */}
      <div className="rounded-2xl px-6 py-5 text-white mb-4 flex items-center justify-between"
        style={{ background: 'var(--hero-gradient)' }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background: 'rgba(255,255,255,0.15)' }}>
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-black">יועץ AI</h1>
            <p className="text-xs" style={{ color: 'rgba(255,255,255,0.6)' }}>מנתח את העסק שלך בזמן אמת</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsOffline(!isOffline)}
            title={isOffline ? 'מצב לא מקוון פעיל — תשובה קבועה בלבד, ללא ניתוח אמיתי של הנתונים שלך. לחץ לחזור למצב מקוון' : 'מצב מקוון — AI מנתח נתונים בזמן אמת. לחץ לעבור למצב לא מקוון (תשובה קבועה, ללא ניתוח AI)'}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors"
            style={isOffline
              ? { background: 'rgba(251,191,36,0.2)', color: '#fbbf24' }
              : { background: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.8)' }}
          >
            <WifiOff className="w-3.5 h-3.5" />
            {isOffline ? 'לא מקוון' : 'מקוון'}
          </button>
          {messages.length > 0 && (
            <button
              onClick={clearHistory}
              className="p-2 rounded-xl transition-colors"
              style={{ background: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.7)' }}
              title="מחק היסטוריה"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto rounded-2xl p-4 space-y-4 mb-4" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.14)' }}>
        {historyLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-primary)' }} />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-6">
            <div className="text-center">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4"
                style={{ background: 'rgba(26,92,42,0.08)' }}>
                <Bot className="w-8 h-8" style={{ color: 'var(--color-primary)' }} />
              </div>
              <h3 className="text-lg font-bold" style={{ color: '#e8e8e4' }}>שלום! אני יועץ ה-AI שלך</h3>
              <p className="text-sm mt-1" style={{ color: '#9aa0ab' }}>שאל אותי כל שאלה על העסק</p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              {suggestions.map((s) => (
                <button
                  key={s}
                  onClick={() => { setInput(s); inputRef.current?.focus(); }}
                  className="px-4 py-2 text-sm rounded-xl transition-colors"
                  style={{ background: 'rgba(26,92,42,0.07)', color: 'var(--color-primary)' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'rgba(26,92,42,0.14)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(26,92,42,0.07)')}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <div key={msg.id ?? i} className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: msg.role === 'user' ? 'var(--color-primary)' : 'rgba(26,92,42,0.1)' }}>
                  {msg.role === 'user'
                    ? <User className="w-4 h-4 text-white" />
                    : <Bot className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />}
                </div>

                {/* Bubble */}
                <div className={`flex-1 max-w-[80%] flex flex-col gap-1 ${msg.role === 'user' ? 'items-end' : ''}`}>
                  <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed ${
                    msg.role === 'user' ? 'rounded-tr-sm' : 'rounded-tl-sm'
                  }`}
                    style={msg.role === 'user'
                      ? { background: 'var(--color-primary)', color: '#fff' }
                      : { background: '#111116', border: '1px solid rgba(201,162,39,0.14)', color: '#e8e8e4' }}>
                    {msg.role === 'user'
                      ? msg.content
                      : <MarkdownText content={msg.content} />}
                  </div>

                  {/* Tools used */}
                  {msg.toolsUsed && msg.toolsUsed.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {msg.toolsUsed.map((t) => (
                        <span key={t} className="text-xs px-2 py-0.5 rounded-full font-medium"
                          style={{ background: 'rgba(26,92,42,0.08)', color: 'var(--color-primary)' }}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Provider badge */}
                  {msg.role === 'assistant' && msg.provider && (
                    <span className="text-[10px]" style={{ color: '#9aa0ab' }}>
                      {msg.provider === 'claude' ? '⚡ Claude' : msg.provider === 'gemini' ? '✦ Gemini' : '✦ Groq'}
                      {msg.fallbackTriggered && ' (fallback)'}
                    </span>
                  )}

                  {msg.timestamp && (
                    <p className="text-xs" style={{ color: '#9aa0ab' }}>{formatDateTime(msg.timestamp)}</p>
                  )}
                </div>
              </div>
            ))}

            {/* Loading dots */}
            {loading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: 'rgba(26,92,42,0.1)' }}>
                  <Bot className="w-4 h-4" style={{ color: 'var(--color-primary)' }} />
                </div>
                <div className="px-4 py-3 rounded-2xl rounded-tl-sm"
                  style={{ background: '#111116', border: '1px solid rgba(201,162,39,0.14)' }}>
                  <div className="flex gap-1">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="w-2 h-2 rounded-full animate-bounce"
                        style={{ background: 'var(--color-primary)', opacity: 0.5, animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="rounded-2xl p-3 flex items-end gap-3" style={{ background: '#141418', border: '1px solid rgba(201,162,39,0.2)' }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="שאל שאלה על העסק... (Enter לשליחה)"
          rows={1}
          className="flex-1 resize-none text-sm focus:outline-none max-h-32 py-1"
          style={{ background: 'transparent', color: '#e8e8e4', lineHeight: '1.5' }}
        />
        <button
          onClick={send}
          disabled={!input.trim() || loading}
          className="flex items-center justify-center w-9 h-9 rounded-xl text-white transition-opacity disabled:opacity-40"
          style={{ background: 'var(--color-primary)' }}
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
}
