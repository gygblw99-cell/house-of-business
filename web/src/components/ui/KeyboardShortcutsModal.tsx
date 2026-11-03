'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Keyboard } from 'lucide-react';
import type { ShortcutDef } from '@/hooks/useGlobalShortcuts';

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex items-center justify-center px-2 py-0.5 rounded-md text-xs font-mono font-bold"
      style={{
        background: 'rgba(255,255,255,0.08)',
        border: '1px solid rgba(255,255,255,0.18)',
        color: '#e8e8e4',
        minWidth: '1.6rem',
        boxShadow: '0 2px 0 rgba(0,0,0,0.4)',
      }}
    >
      {children}
    </kbd>
  );
}

function ShortcutRow({ s }: { s: ShortcutDef }) {
  const parts = s.display.split('→').map(p => p.trim());
  return (
    <div
      className="flex items-center justify-between py-2 px-3 rounded-lg"
      style={{ background: 'rgba(255,255,255,0.03)' }}
    >
      <span className="text-sm" style={{ color: '#b8bcc4' }}>{s.label}</span>
      <div className="flex items-center gap-1.5 flex-shrink-0 mr-3">
        {parts.map((p, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <span style={{ color: '#9aa0ab', fontSize: 10 }}>then</span>}
            <Kbd>{p}</Kbd>
          </span>
        ))}
      </div>
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  shortcuts: ShortcutDef[];
  appName?: string;
}

export function KeyboardShortcutsModal({ open, onClose, shortcuts, appName = 'פלטפורמה' }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!mounted || !open) return null;

  // Group shortcuts, skip Escape (it closes this modal — self-referential)
  const groups: Record<string, ShortcutDef[]> = {};
  for (const s of shortcuts) {
    if (s.key === 'Escape') continue;
    if (!groups[s.group]) groups[s.group] = [];
    groups[s.group].push(s);
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: 300 }}
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }} />

      {/* Panel */}
      <div
        className="relative w-full mx-4 rounded-2xl overflow-hidden shadow-2xl"
        style={{
          maxWidth: 680,
          background: '#111116',
          border: '1px solid rgba(201,162,39,0.2)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ borderBottom: '1px solid rgba(201,162,39,0.12)' }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: 'rgba(201,162,39,0.12)', border: '1px solid rgba(201,162,39,0.25)' }}
            >
              <Keyboard className="w-4 h-4" style={{ color: '#c9a227' }} />
            </div>
            <div>
              <h2 className="font-bold text-base" style={{ color: '#e8e8e4' }}>קיצורי מקלדת</h2>
              <p className="text-xs" style={{ color: '#9aa0ab' }}>{appName}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg transition-colors"
            style={{ color: '#9aa0ab' }}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 overflow-y-auto" style={{ maxHeight: '65vh' }}>
          <div className="grid gap-6" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
            {Object.entries(groups).map(([group, items]) => (
              <div key={group}>
                <p
                  className="text-xs font-bold uppercase tracking-widest mb-2 pb-1"
                  style={{
                    color: '#c9a227',
                    borderBottom: '1px solid rgba(201,162,39,0.15)',
                  }}
                >
                  {group}
                </p>
                <div className="space-y-1">
                  {items.map((s, i) => <ShortcutRow key={i} s={s} />)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div
          className="flex items-center justify-between px-6 py-3"
          style={{ borderTop: '1px solid rgba(201,162,39,0.1)', background: 'rgba(0,0,0,0.25)' }}
        >
          <p className="text-xs flex items-center gap-1.5" style={{ color: '#9aa0ab' }}>
            לחץ <Kbd>?</Kbd> בכל עמוד לפתיחה מחדש
          </p>
          <p className="text-xs flex items-center gap-1.5" style={{ color: '#9aa0ab' }}>
            סגור עם <Kbd>Esc</Kbd>
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
}
