'use client';

/**
 * Toast notification system using @radix-ui/react-toast.
 * Usage:
 *   import { useToast } from '@/components/ui/Toast';
 *   const { toast } = useToast();
 *   toast({ title: 'נשמר!', variant: 'success' });
 *
 * Wrap your app in <ToastProvider> (already in AppShell).
 */

import * as React from 'react';
import * as ToastPrimitive from '@radix-ui/react-toast';
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Types ─────────────────────────────────────────────────────
interface ToastData {
  id: string;
  title: string;
  description?: string;
  variant?: 'success' | 'error' | 'warning' | 'info';
}

// ── Context ───────────────────────────────────────────────────
const ToastContext = React.createContext<{
  toast: (opts: Omit<ToastData, 'id'>) => void;
}>({ toast: () => {} });

export function useToast() {
  return React.useContext(ToastContext);
}

// ── Provider (wrap app with this) ─────────────────────────────
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastData[]>([]);

  const toast = React.useCallback((opts: Omit<ToastData, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev, { ...opts, id }]);
  }, []);

  const dismiss = (id: string) =>
    setToasts((prev) => prev.filter((t) => t.id !== id));

  return (
    <ToastContext.Provider value={{ toast }}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <Toast key={t.id} data={t} onDismiss={() => dismiss(t.id)} />
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-4 left-4 z-[100] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)]" />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

// ── Single Toast ──────────────────────────────────────────────
const ICONS = {
  success: <CheckCircle className="w-4 h-4 text-green-600" />,
  error:   <XCircle    className="w-4 h-4 text-red-600" />,
  warning: <AlertTriangle className="w-4 h-4 text-amber-600" />,
  info:    <Info       className="w-4 h-4 text-blue-600" />,
};

const BG = {
  success: 'border-green-200 bg-green-50',
  error:   'border-red-200   bg-red-50',
  warning: 'border-amber-200 bg-amber-50',
  info:    'border-blue-200  bg-blue-50',
};

function Toast({ data, onDismiss }: { data: ToastData; onDismiss: () => void }) {
  const variant = data.variant || 'info';
  return (
    <ToastPrimitive.Root
      duration={4000}
      onOpenChange={(open) => { if (!open) onDismiss(); }}
      className={cn(
        'flex items-start gap-3 p-3 rounded-xl border shadow-lg',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[swipe=end]:animate-out data-[state=closed]:fade-out-80',
        'data-[state=open]:slide-in-from-bottom-4 data-[state=closed]:slide-out-to-right-4',
        BG[variant]
      )}
      dir="rtl"
    >
      <div className="flex-shrink-0 mt-0.5">{ICONS[variant]}</div>
      <div className="flex-1 min-w-0">
        <ToastPrimitive.Title className="text-sm font-semibold text-gray-900">
          {data.title}
        </ToastPrimitive.Title>
        {data.description && (
          <ToastPrimitive.Description className="text-xs text-gray-600 mt-0.5">
            {data.description}
          </ToastPrimitive.Description>
        )}
      </div>
      <ToastPrimitive.Close
        onClick={onDismiss}
        className="flex-shrink-0 p-0.5 rounded text-gray-400 hover:text-gray-600 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </ToastPrimitive.Close>
    </ToastPrimitive.Root>
  );
}
