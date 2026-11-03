'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Accessibility, Plus, Minus, Contrast, Link2, PauseCircle, RotateCcw, X } from 'lucide-react';

const STORAGE_KEY = 'hob_a11y_prefs';
const FONT_STEPS = [1, 1.1, 1.25, 1.4] as const;

interface A11yPrefs {
  fontStep: number; // index into FONT_STEPS
  contrast: boolean;
  underlineLinks: boolean;
  stopAnimations: boolean;
}

const DEFAULT_PREFS: A11yPrefs = { fontStep: 0, contrast: false, underlineLinks: false, stopAnimations: false };

// localStorage is user-writable and survives across deploys, so a value saved
// by an older build (or edited by hand) can carry a fontStep that's no longer
// a valid index. Spreading it in unchecked yielded FONT_STEPS[n] === undefined,
// which rendered as "NaN%" and set --a11y-zoom to the string "undefined".
function sanitize(raw: unknown): A11yPrefs {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<A11yPrefs>;
  const step = Number(p.fontStep);
  return {
    fontStep: Number.isInteger(step) && step >= 0 && step < FONT_STEPS.length ? step : 0,
    contrast:       p.contrast       === true,
    underlineLinks: p.underlineLinks === true,
    stopAnimations: p.stopAnimations === true,
  };
}

function applyPrefs(prefs: A11yPrefs) {
  const html = document.documentElement;
  html.style.setProperty('--a11y-zoom', String(FONT_STEPS[prefs.fontStep]));
  html.toggleAttribute('data-a11y-contrast', prefs.contrast);
  html.toggleAttribute('data-a11y-underline-links', prefs.underlineLinks);
  html.toggleAttribute('data-a11y-stop-animations', prefs.stopAnimations);
}

export function AccessibilityWidget() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<A11yPrefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);

  // Load + apply saved prefs once on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = sanitize(JSON.parse(raw));
        setPrefs(saved);
        applyPrefs(saved);
      }
    } catch { /* ignore malformed/blocked storage */ }
    setReady(true);
  }, []);

  // Re-apply + persist whenever prefs change (skip the initial mount, already handled above)
  useEffect(() => {
    if (!ready) return;
    applyPrefs(prefs);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
  }, [prefs, ready]);

  const update = (patch: Partial<A11yPrefs>) => setPrefs(p => ({ ...p, ...patch }));

  return (
    <>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label="פתח תפריט נגישות"
        aria-expanded={open}
        title="נגישות"
        style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 200,
          width: 52, height: 52, borderRadius: '50%',
          background: '#1a5c2a', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: '2px solid #c9a227', boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          cursor: 'pointer',
        }}
      >
        <Accessibility size={26} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="הגדרות נגישות"
          dir="rtl"
          style={{
            position: 'fixed', bottom: 82, right: 20, zIndex: 200,
            width: 300, maxWidth: 'calc(100vw - 40px)',
            background: '#141418', border: '1px solid rgba(201,162,39,0.3)',
            borderRadius: 16, boxShadow: '0 12px 48px rgba(0,0,0,0.5)',
            padding: 20, color: '#e8e8e8',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, margin: 0, color: '#c9a227' }}>נגישות</h2>
            <button
              onClick={() => setOpen(false)}
              aria-label="סגור"
              style={{ background: 'none', border: 'none', color: '#9aa0ab', cursor: 'pointer', padding: 4 }}
            >
              <X size={18} />
            </button>
          </div>

          <div style={{ marginBottom: 14 }}>
            <p style={{ fontSize: 13, color: '#9aa0ab', marginBottom: 8 }}>גודל טקסט</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={() => update({ fontStep: Math.max(0, prefs.fontStep - 1) })}
                disabled={prefs.fontStep === 0}
                aria-label="הקטן טקסט"
                style={{ ...btnStyle, opacity: prefs.fontStep === 0 ? 0.4 : 1 }}
              >
                <Minus size={16} />
              </button>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>
                {Math.round(FONT_STEPS[prefs.fontStep] * 100)}%
              </div>
              <button
                onClick={() => update({ fontStep: Math.min(FONT_STEPS.length - 1, prefs.fontStep + 1) })}
                disabled={prefs.fontStep === FONT_STEPS.length - 1}
                aria-label="הגדל טקסט"
                style={{ ...btnStyle, opacity: prefs.fontStep === FONT_STEPS.length - 1 ? 0.4 : 1 }}
              >
                <Plus size={16} />
              </button>
            </div>
          </div>

          <ToggleRow icon={<Contrast size={16} />} label="ניגודיות גבוהה" checked={prefs.contrast} onChange={v => update({ contrast: v })} />
          <ToggleRow icon={<Link2 size={16} />} label="הדגשת קישורים" checked={prefs.underlineLinks} onChange={v => update({ underlineLinks: v })} />
          <ToggleRow icon={<PauseCircle size={16} />} label="עצירת אנימציות" checked={prefs.stopAnimations} onChange={v => update({ stopAnimations: v })} />

          <button
            onClick={() => setPrefs(DEFAULT_PREFS)}
            style={{ ...btnStyle, width: '100%', marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
          >
            <RotateCcw size={14} /> איפוס
          </button>
        </div>
      )}
    </>
  );
}

const btnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  border: '1px solid rgba(201,162,39,0.25)',
  borderRadius: 8,
  color: '#e8e8e8',
  cursor: 'pointer',
  padding: '8px 10px',
};

function ToggleRow({ icon, label, checked, onChange }: { icon: ReactNode; label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0', cursor: 'pointer', fontSize: 13 }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{icon}{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ width: 18, height: 18, accentColor: '#c9a227', cursor: 'pointer' }}
      />
    </label>
  );
}
