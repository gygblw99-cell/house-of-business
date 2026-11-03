'use client';

/**
 * AppDialogContext
 * מחליף את window.alert() ו-window.confirm() בכל האפליקציה.
 *
 * שימוש:
 *   const { confirm, toast } = useAppDialog();
 *   if (!await confirm('האם למחוק?')) return;
 *   toast('שגיאה: ' + err.message, 'error');
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { X, AlertTriangle, CheckCircle, Info } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────
type ToastType = 'error' | 'success' | 'info';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

interface ConfirmState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  resolve: ((v: boolean) => void) | null;
}

interface AppDialogCtx {
  confirm: (message: string, title?: string, confirmLabel?: string) => Promise<boolean>;
  toast: (message: string, type?: ToastType) => void;
}

// ── Context ────────────────────────────────────────────────────
const AppDialogContext = createContext<AppDialogCtx>({
  confirm: async () => false,
  toast: () => {},
});

export function useAppDialog() {
  return useContext(AppDialogContext);
}

// ── Provider ───────────────────────────────────────────────────
export function AppDialogProvider({ children }: { children: React.ReactNode }) {
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    open: false, title: '', message: '', confirmLabel: 'מחק', resolve: null,
  });
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastId = useRef(0);

  // ── confirm ──────────────────────────────────────────────────
  const confirm = useCallback((message: string, title = 'אישור פעולה', confirmLabel = 'מחק') => {
    return new Promise<boolean>((resolve) => {
      setConfirmState({ open: true, title, message, confirmLabel, resolve });
    });
  }, []);

  const handleConfirm = (value: boolean) => {
    confirmState.resolve?.(value);
    setConfirmState(s => ({ ...s, open: false, resolve: null }));
  };

  // ── toast ────────────────────────────────────────────────────
  const toast = useCallback((message: string, type: ToastType = 'error') => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4500);
  }, []);

  const removeToast = (id: number) => setToasts(prev => prev.filter(t => t.id !== id));

  // Both callbacks are stable, but a fresh object literal here would still give
  // the context a new identity on every toast/confirm state change — forcing a
  // re-render of every consumer in the app just to show a toast.
  const ctxValue = useMemo(() => ({ confirm, toast }), [confirm, toast]);

  return (
    <AppDialogContext.Provider value={ctxValue}>
      {children}

      {/* ── Confirm Modal ──────────────────────────────────── */}
      {confirmState.open && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 10000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(15,23,42,0.45)', backdropFilter: 'blur(4px)',
          }}
          onClick={() => handleConfirm(false)}
        >
          <div
            dir="rtl"
            style={{
              background: 'white', borderRadius: 20, padding: '28px 32px',
              width: 340, boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
              border: '1px solid #e2e8f0',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Icon */}
            {(() => {
              const isDestructive = confirmState.confirmLabel.startsWith('מחק');
              return (
                <div style={{
                  width: 52, height: 52, borderRadius: 14,
                  background: isDestructive
                    ? 'linear-gradient(135deg,#fee2e2,#fecaca)'
                    : 'linear-gradient(135deg,#dbeafe,#bfdbfe)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  marginBottom: 16,
                }}>
                  {isDestructive
                    ? <AlertTriangle style={{ width: 26, height: 26, color: '#dc2626' }} />
                    : <CheckCircle style={{ width: 26, height: 26, color: '#2563eb' }} />
                  }
                </div>
              );
            })()}

            {/* Title */}
            <p style={{ fontWeight: 800, fontSize: 17, color: '#0f172a', marginBottom: 8 }}>
              {confirmState.title}
            </p>

            {/* Message */}
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24, lineHeight: 1.6 }}>
              {confirmState.message}
            </p>

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => handleConfirm(false)}
                style={{
                  padding: '9px 20px', borderRadius: 10, fontSize: 14, fontWeight: 600,
                  border: '1.5px solid #e2e8f0', background: 'white', color: '#475569',
                  cursor: 'pointer',
                }}
              >
                ביטול
              </button>
              <button
                onClick={() => handleConfirm(true)}
                style={{
                  padding: '9px 20px', borderRadius: 10, fontSize: 14, fontWeight: 700,
                  border: 'none',
                  background: confirmState.confirmLabel.startsWith('מחק')
                    ? 'linear-gradient(135deg,#ef4444,#dc2626)'
                    : 'linear-gradient(135deg,#3b82f6,#2563eb)',
                  color: 'white', cursor: 'pointer',
                }}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Container ────────────────────────────────── */}
      <div style={{
        position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
        zIndex: 10001, display: 'flex', flexDirection: 'column', gap: 10,
        alignItems: 'center', pointerEvents: 'none',
      }}>
        {toasts.map(t => {
          const cfg = {
            error:   { bg: '#fef2f2', border: '#fca5a5', text: '#b91c1c', Icon: AlertTriangle },
            success: { bg: '#f0fdf4', border: '#86efac', text: '#15803d', Icon: CheckCircle },
            info:    { bg: '#eff6ff', border: '#93c5fd', text: '#1d4ed8', Icon: Info },
          }[t.type];
          return (
            <div
              key={t.id}
              dir="rtl"
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                background: cfg.bg, border: `1.5px solid ${cfg.border}`,
                borderRadius: 12, padding: '12px 16px',
                boxShadow: '0 4px 20px rgba(0,0,0,0.10)',
                minWidth: 260, maxWidth: 400,
                pointerEvents: 'all',
                animation: 'slideUp 0.25s ease',
              }}
            >
              <cfg.Icon style={{ width: 18, height: 18, color: cfg.text, flexShrink: 0 }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: cfg.text, flex: 1 }}>{t.message}</span>
              <button
                onClick={() => removeToast(t.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}
              >
                <X style={{ width: 14, height: 14, color: cfg.text }} />
              </button>
            </div>
          );
        })}
      </div>

      <style>{`
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </AppDialogContext.Provider>
  );
}
