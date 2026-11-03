'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppSelector } from '@/hooks/useAppDispatch';
import { LuxuryTheme } from '@/store/slices/uiSlice';

const THEME_GRADIENT: Record<LuxuryTheme, string> = {
  'hob-luxury':     'linear-gradient(135deg, #050507 0%, #0a0a0e 50%, #c9a227 100%)',
  'royal-emerald':  'linear-gradient(135deg, #061a0b 0%, #1a5c2a 50%, #c9a227 100%)',
  'midnight-gold':  'linear-gradient(135deg, #06060f 0%, #18182e 50%, #f0c040 100%)',
  'champagne-rose': 'linear-gradient(135deg, #1a0a0f 0%, #4a1e30 50%, #d4a882 100%)',
  'ocean-sapphire': 'linear-gradient(135deg, #030d1a 0%, #0d2040 50%, #60b8e8 100%)',
};

export function ThemeTransition() {
  const luxuryTheme = useAppSelector((s) => s.ui.luxuryTheme);
  const [visible, setVisible] = useState(false);
  const [opacity, setOpacity] = useState(0);
  const [gradient, setGradient] = useState(THEME_GRADIENT['royal-emerald']);
  const prevTheme = useRef<LuxuryTheme | null>(null);
  const t1 = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const t2 = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const t3 = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (prevTheme.current === null) {
      prevTheme.current = luxuryTheme;
      return;
    }
    if (prevTheme.current === luxuryTheme) return;
    prevTheme.current = luxuryTheme;

    // clear any running timers
    clearTimeout(t1.current);
    clearTimeout(t2.current);
    clearTimeout(t3.current);

    setGradient(THEME_GRADIENT[luxuryTheme]);
    setOpacity(0);
    setVisible(true);

    // frame 1: fade in
    t1.current = setTimeout(() => setOpacity(1), 30);
    // frame 2: fade out
    t2.current = setTimeout(() => setOpacity(0), 420);
    // frame 3: remove
    t3.current = setTimeout(() => setVisible(false), 820);
  }, [luxuryTheme]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: gradient,
        opacity,
        pointerEvents: 'none',
        transition: opacity === 1
          ? 'opacity 0.35s ease-in'
          : 'opacity 0.38s ease-out',
      }}
    />
  );
}
