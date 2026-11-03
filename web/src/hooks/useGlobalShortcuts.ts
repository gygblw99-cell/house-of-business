'use client';
import { useEffect, useRef } from 'react';

export interface ShortcutDef {
  // Match strategy: code (physical key, Hebrew-safe) OR key (char-sensitive)
  code?: string;   // e.g. 'KeyD', 'BracketLeft', 'Slash', 'Digit1'
  key?: string;    // e.g. 'Escape' (special keys only — avoid for letters)
  shift?: boolean; // require shiftKey (e.g. ? = Slash + shift)

  // G → code sequence (press G, then physical key within 1.5s)
  gSeq?: string;   // physical code, e.g. 'KeyD'

  action: () => void;
  label: string;   // human-readable description
  display: string; // what to show in the help modal (e.g. 'G → D')
  group: string;   // section header in help modal
}

export function useGlobalShortcuts(shortcuts: ShortcutDef[]) {
  // The listener below is attached once and must always see the latest
  // shortcut list. Writing the ref in an effect (rather than during render)
  // keeps render pure — a render that React throws away can't leave a stale
  // list behind for the already-attached listener to read.
  const ref = useRef(shortcuts);
  useEffect(() => { ref.current = shortcuts; }, [shortcuts]);

  useEffect(() => {
    let gPending = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    const clearG = () => {
      gPending = false;
      if (gTimer) { clearTimeout(gTimer); gTimer = null; }
    };

    const isEditable = (el: EventTarget | null): boolean => {
      if (!el) return false;
      const e = el as HTMLElement;
      return (
        e.tagName === 'INPUT' ||
        e.tagName === 'TEXTAREA' ||
        e.tagName === 'SELECT' ||
        e.isContentEditable
      );
    };

    // An unspecified `shift` means "no shift", not "don't care". Treating it as
    // don't-care made every shortcut fire on its shifted variant too, so e.g.
    // Shift+L triggered the admin panel's logout.
    const match = (s: ShortcutDef, e: KeyboardEvent): boolean => {
      if ((s.shift ?? false) !== e.shiftKey) return false;
      if (s.code) return e.code === s.code;
      if (s.key)  return e.key  === s.key;
      return false;
    };

    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      const inEdit = isEditable(e.target);

      // Escape works even in inputs
      if (e.key === 'Escape') {
        const s = ref.current.find(x => x.key === 'Escape' && !x.gSeq);
        if (s) { e.preventDefault(); s.action(); }
        clearG();
        return;
      }

      if (inEdit) return;

      // G-sequence: consume next keypress
      if (gPending) {
        clearG();
        const s = ref.current.find(x => x.gSeq === e.code);
        if (s) { e.preventDefault(); s.action(); }
        return;
      }

      // Start G-sequence (only if there are gSeq shortcuts registered)
      if (e.code === 'KeyG' && !e.shiftKey && ref.current.some(x => x.gSeq)) {
        gPending = true;
        gTimer = setTimeout(clearG, 1500);
        return;
      }

      // Direct shortcuts
      for (const s of ref.current) {
        if (s.gSeq) continue;
        if (match(s, e)) { e.preventDefault(); s.action(); return; }
      }
    };

    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      if (gTimer) clearTimeout(gTimer);
    };
  }, []);
}
