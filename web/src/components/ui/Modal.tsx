'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}

const sizes = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export function Modal({ open, onClose, title, children, size = 'md' }: ModalProps) {
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const content = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4" dir="rtl">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'relative w-full rounded-2xl shadow-xl z-10 max-h-[90vh] overflow-y-auto modal-scroll',
          sizes[size]
        )}
        style={{ background: 'var(--hob-surface, #141418)' }}
      >
        {title && (
          <div
            className="flex items-center justify-between px-6 py-4"
            style={{ background: 'var(--card-header-bg, #0f0f14)', borderBottom: '1px solid var(--card-border-color, rgba(201,162,39,0.16))', borderRadius: '1rem 1rem 0 0' }}
          >
            <h2 className="text-lg font-semibold" style={{ color: 'var(--foreground, #e8e8e4)' }}>{title}</h2>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-colors"
              style={{ color: 'var(--color-primary, #1a5c2a)' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--color-accent-light, #f3f4f6)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );

  return typeof document !== 'undefined'
    ? createPortal(content, document.body)
    : null;
}
