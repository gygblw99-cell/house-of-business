'use client';

import { useState } from 'react';
import { X } from 'lucide-react';

interface HelpButtonProps {
  title: string;
  content: string; // plain text, supports emoji + newlines
  color?: string;  // accent color (default: #6d28d9)
}

/**
 * כפתור ? קטן ושקט שנפתח לפאנל הסבר פשוט.
 * ממוקם בצד כותרת הדף — לא בולט אבל נגיש תמיד.
 */
export function HelpButton({ title, content, color = '#6d28d9' }: HelpButtonProps) {
  const [open, setOpen] = useState(false);

  const bg    = `${color}18`;
  const hover = `${color}30`;

  return (
    <>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="עזרה"
        title={title}
        className="w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center flex-shrink-0 transition-colors select-none"
        style={{
          background: open ? color : bg,
          color:      open ? 'white' : color,
          border:     `1px solid ${color}40`,
        }}
        onMouseEnter={e => { if (!open) (e.currentTarget.style.background = hover); }}
        onMouseLeave={e => { if (!open) (e.currentTarget.style.background = bg); }}
      >
        {open ? <X className="w-3 h-3" /> : '?'}
      </button>

      {open && (
        <div
          className="mt-3 w-full rounded-2xl p-5 text-sm leading-relaxed whitespace-pre-line animate-fade-in"
          style={{ background: bg, border: `1px solid ${color}30`, color: '#1e293b' }}
        >
          <p className="font-bold mb-2" style={{ color }}>{title}</p>
          {content}
        </div>
      )}
    </>
  );
}
