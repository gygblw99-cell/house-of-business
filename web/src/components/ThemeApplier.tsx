'use client';

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '@/hooks/useAppDispatch';
import { initTheme, LuxuryTheme } from '@/store/slices/uiSlice';

type ThemeVars = Record<string, string>;

const THEME_VARS: Record<LuxuryTheme, ThemeVars> = {
  'hob-luxury': {
    // Sidebar — pure black with metallic gold
    '--sb-bg':            'linear-gradient(180deg, #050507 0%, #0a0a0e 40%, #0d0d14 100%)',
    '--sb-border':        'rgba(201,162,39,0.2)',
    '--sb-divider':       'rgba(201,162,39,0.1)',
    '--sb-accent':        '#c9a227',
    '--sb-accent-dim':    'rgba(201,162,39,0.15)',
    '--sb-accent-hover':  'rgba(201,162,39,0.1)',
    '--sb-accent-border': 'rgba(201,162,39,0.28)',
    '--sb-text':          '#9aa0ab',
    '--sb-text-muted':    '#9aa0ab',
    '--sb-avatar-bg':     'linear-gradient(135deg, #c9a227, #d4af37)',
    '--sb-avatar-text':   '#050507',
    // Content
    '--color-primary':         '#c9a227',
    '--color-primary-hover':   '#d4af37',
    '--color-primary-dark':    '#a07d10',
    '--color-accent':          '#d4af37',
    '--color-accent-light':    'rgba(201,162,39,0.12)',
    '--card-border-color':     'rgba(201,162,39,0.16)',
    '--card-header-bg':        'rgba(18,18,22,0.97)',
    '--hero-gradient':         'linear-gradient(135deg, #050507 0%, #0a0a0e 60%, #141418 100%)',
    '--hero-accent':           '#c9a227',
    '--kpi-gradient-1':        'linear-gradient(135deg, #141418, #1e1e26)',
    '--kpi-gradient-2':        'linear-gradient(135deg, #a07d10, #c9a227)',
    '--tag-bg':                'rgba(201,162,39,0.12)',
    '--tag-text':              '#c9a227',
    '--link-color':            '#c9a227',
    '--progress-bar':          'linear-gradient(90deg, #a07d10, #c9a227)',
    // Page — dark luxury backgrounds
    '--page-gradient':   'linear-gradient(145deg, #0a0a0e 0%, #0f0f14 50%, #0d0d12 100%)',
    '--glass-bg':        'rgba(18,18,22,0.88)',
    '--glass-border':    'rgba(201,162,39,0.18)',
    '--glass-shadow':    '0 8px 32px rgba(0,0,0,0.5), 0 1px 0 rgba(201,162,39,0.08) inset',
    '--glass-shadow-lg': '0 20px 60px rgba(0,0,0,0.7), 0 1px 0 rgba(201,162,39,0.08) inset',
    '--blob-1':          'rgba(201,162,39,0.05)',
    '--blob-2':          'rgba(201,162,39,0.03)',
    '--blob-3':          'rgba(212,175,55,0.02)',
    // Override base bg vars (applied inline → beat CSS vars)
    '--hob-cream':       '#0f0f14',
    '--hob-surface':     '#141418',
    '--page-bg':         '#0f0f14',
    '--background':      '#0f0f14',
    '--foreground':      '#e8e8e4',
  },
  'royal-emerald': {
    // Sidebar
    '--sb-bg':            'linear-gradient(180deg, #061a0b 0%, #0d3518 40%, #1a5c2a 100%)',
    '--sb-border':        'rgba(201,162,39,0.15)',
    '--sb-divider':       'rgba(201,162,39,0.12)',
    '--sb-accent':        '#c9a227',
    '--sb-accent-dim':    'rgba(201,162,39,0.18)',
    '--sb-accent-hover':  'rgba(201,162,39,0.12)',
    '--sb-accent-border': 'rgba(201,162,39,0.25)',
    '--sb-text':          '#7db585',
    '--sb-text-muted':    '#7db585',
    '--sb-avatar-bg':     'linear-gradient(135deg, #c9a227, #d4af37)',
    '--sb-avatar-text':   '#0d3518',
    // Content
    '--color-primary':         '#1a5c2a',
    '--color-primary-hover':   '#2e7d32',
    '--color-primary-dark':    '#0d3518',
    '--color-accent':          '#c9a227',
    '--color-accent-light':    '#fdf5d3',
    '--card-border-color':     'rgba(201,162,39,0.18)',
    '--card-header-bg':        'rgba(253,252,248,0.9)',
    '--hero-gradient':         'linear-gradient(135deg, #061a0b 0%, #1a5c2a 60%, #2e7d32 100%)',
    '--hero-accent':           '#c9a227',
    '--kpi-gradient-1':        'linear-gradient(135deg, #1a5c2a, #2e7d32)',
    '--kpi-gradient-2':        'linear-gradient(135deg, #a07d10, #c9a227)',
    '--tag-bg':                '#e8f5eb',
    '--tag-text':              '#1a5c2a',
    '--link-color':            '#1a5c2a',
    '--progress-bar':          'linear-gradient(90deg, #1a5c2a, #2e7d32)',
    // Glassmorphism
    '--page-gradient':   'linear-gradient(145deg, #eaf4ea 0%, #fdfcf8 45%, #f7f0e0 100%)',
    '--glass-bg':        'rgba(255,255,255,0.72)',
    '--glass-border':    'rgba(201,162,39,0.22)',
    '--glass-shadow':    '0 8px 32px rgba(10,60,20,0.10), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--glass-shadow-lg': '0 20px 60px rgba(10,60,20,0.15), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--blob-1':          'rgba(26,92,42,0.12)',
    '--blob-2':          'rgba(201,162,39,0.08)',
    '--blob-3':          'rgba(46,125,50,0.06)',
  },
  'midnight-gold': {
    '--sb-bg':            'linear-gradient(180deg, #06060f 0%, #0e0e1f 40%, #18182e 100%)',
    '--sb-border':        'rgba(240,192,64,0.2)',
    '--sb-divider':       'rgba(240,192,64,0.12)',
    '--sb-accent':        '#f0c040',
    '--sb-accent-dim':    'rgba(240,192,64,0.18)',
    '--sb-accent-hover':  'rgba(240,192,64,0.12)',
    '--sb-accent-border': 'rgba(240,192,64,0.3)',
    '--sb-text':          '#7878aa',
    '--sb-text-muted':    '#7878aa',
    '--sb-avatar-bg':     'linear-gradient(135deg, #f0c040, #ffd700)',
    '--sb-avatar-text':   '#0e0e1f',
    '--color-primary':         '#18182e',
    '--color-primary-hover':   '#2a2a50',
    '--color-primary-dark':    '#06060f',
    '--color-accent':          '#f0c040',
    '--color-accent-light':    'rgba(240,192,64,0.1)',
    '--card-border-color':     'rgba(240,192,64,0.2)',
    '--card-header-bg':        'rgba(248,247,255,0.9)',
    '--hero-gradient':         'linear-gradient(135deg, #06060f 0%, #18182e 60%, #2a2a50 100%)',
    '--hero-accent':           '#f0c040',
    '--kpi-gradient-1':        'linear-gradient(135deg, #18182e, #2a2a50)',
    '--kpi-gradient-2':        'linear-gradient(135deg, #a07d10, #f0c040)',
    '--tag-bg':                'rgba(240,192,64,0.1)',
    '--tag-text':              '#7a5c00',
    '--link-color':            '#8844cc',
    '--progress-bar':          'linear-gradient(90deg, #18182e, #2a2a50)',
    '--page-gradient':   'linear-gradient(145deg, #edecff 0%, #f6f5ff 45%, #fffae0 100%)',
    '--glass-bg':        'rgba(255,255,255,0.72)',
    '--glass-border':    'rgba(240,192,64,0.22)',
    '--glass-shadow':    '0 8px 32px rgba(14,14,31,0.10), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--glass-shadow-lg': '0 20px 60px rgba(14,14,31,0.16), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--blob-1':          'rgba(24,24,46,0.10)',
    '--blob-2':          'rgba(240,192,64,0.10)',
    '--blob-3':          'rgba(100,80,200,0.06)',
  },
  'champagne-rose': {
    '--sb-bg':            'linear-gradient(180deg, #1a0a0f 0%, #2d1520 40%, #4a1e30 100%)',
    '--sb-border':        'rgba(212,168,130,0.2)',
    '--sb-divider':       'rgba(212,168,130,0.12)',
    '--sb-accent':        '#d4a882',
    '--sb-accent-dim':    'rgba(212,168,130,0.2)',
    '--sb-accent-hover':  'rgba(212,168,130,0.12)',
    '--sb-accent-border': 'rgba(212,168,130,0.3)',
    '--sb-text':          '#c09898',
    '--sb-text-muted':    '#c09898',
    '--sb-avatar-bg':     'linear-gradient(135deg, #d4a882, #e8c0a0)',
    '--sb-avatar-text':   '#2d1520',
    '--color-primary':         '#4a1e30',
    '--color-primary-hover':   '#6b2d48',
    '--color-primary-dark':    '#1a0a0f',
    '--color-accent':          '#d4a882',
    '--color-accent-light':    '#fff0ec',
    '--card-border-color':     'rgba(212,168,130,0.25)',
    '--card-header-bg':        'rgba(253,248,245,0.9)',
    '--hero-gradient':         'linear-gradient(135deg, #1a0a0f 0%, #4a1e30 60%, #6b2d48 100%)',
    '--hero-accent':           '#d4a882',
    '--kpi-gradient-1':        'linear-gradient(135deg, #4a1e30, #6b2d48)',
    '--kpi-gradient-2':        'linear-gradient(135deg, #8a5a3a, #d4a882)',
    '--tag-bg':                '#fff0ec',
    '--tag-text':              '#8a4030',
    '--link-color':            '#8a4030',
    '--progress-bar':          'linear-gradient(90deg, #4a1e30, #6b2d48)',
    '--page-gradient':   'linear-gradient(145deg, #fff0e8 0%, #faf6f2 45%, #f5e8dc 100%)',
    '--glass-bg':        'rgba(255,255,255,0.74)',
    '--glass-border':    'rgba(212,168,130,0.28)',
    '--glass-shadow':    '0 8px 32px rgba(74,30,48,0.09), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--glass-shadow-lg': '0 20px 60px rgba(74,30,48,0.14), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--blob-1':          'rgba(74,30,48,0.10)',
    '--blob-2':          'rgba(212,168,130,0.10)',
    '--blob-3':          'rgba(200,100,80,0.06)',
  },
  'ocean-sapphire': {
    '--sb-bg':            'linear-gradient(180deg, #030d1a 0%, #071525 40%, #0d2040 100%)',
    '--sb-border':        'rgba(100,180,230,0.2)',
    '--sb-divider':       'rgba(100,180,230,0.1)',
    '--sb-accent':        '#60b8e8',
    '--sb-accent-dim':    'rgba(100,180,230,0.2)',
    '--sb-accent-hover':  'rgba(100,180,230,0.12)',
    '--sb-accent-border': 'rgba(100,180,230,0.3)',
    '--sb-text':          '#5a9ec0',
    '--sb-text-muted':    '#5a9ec0',
    '--sb-avatar-bg':     'linear-gradient(135deg, #60b8e8, #4090c0)',
    '--sb-avatar-text':   '#030d1a',
    '--color-primary':         '#0d2040',
    '--color-primary-hover':   '#1a3560',
    '--color-primary-dark':    '#030d1a',
    '--color-accent':          '#60b8e8',
    '--color-accent-light':    '#e0f0fa',
    '--card-border-color':     'rgba(100,180,230,0.22)',
    '--card-header-bg':        'rgba(244,249,253,0.9)',
    '--hero-gradient':         'linear-gradient(135deg, #030d1a 0%, #0d2040 60%, #1a3560 100%)',
    '--hero-accent':           '#60b8e8',
    '--kpi-gradient-1':        'linear-gradient(135deg, #0d2040, #1a3560)',
    '--kpi-gradient-2':        'linear-gradient(135deg, #2a6080, #60b8e8)',
    '--tag-bg':                '#e0f0fa',
    '--tag-text':              '#0d5080',
    '--link-color':            '#0d5080',
    '--progress-bar':          'linear-gradient(90deg, #0d2040, #1a3560)',
    '--page-gradient':   'linear-gradient(145deg, #e0f0ff 0%, #f4f9fd 45%, #e8f4ff 100%)',
    '--glass-bg':        'rgba(255,255,255,0.72)',
    '--glass-border':    'rgba(100,180,230,0.24)',
    '--glass-shadow':    '0 8px 32px rgba(13,32,64,0.09), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--glass-shadow-lg': '0 20px 60px rgba(13,32,64,0.14), 0 1px 0 rgba(255,255,255,0.8) inset',
    '--blob-1':          'rgba(13,32,64,0.10)',
    '--blob-2':          'rgba(96,184,232,0.10)',
    '--blob-3':          'rgba(30,100,180,0.06)',
  },
};

export function ThemeApplier() {
  const dispatch = useAppDispatch();
  const theme = useAppSelector((s) => s.ui.theme);
  const luxuryTheme = useAppSelector((s) => s.ui.luxuryTheme);

  useEffect(() => { dispatch(initTheme()); }, [dispatch]);

  useEffect(() => {
    const html = document.documentElement;
    // hob-luxury is always dark — ignore the light/dark toggle for it
    if (luxuryTheme === 'hob-luxury') {
      html.classList.add('dark');
      return;
    }
    if (theme === 'dark') html.classList.add('dark');
    else html.classList.remove('dark');
  }, [theme, luxuryTheme]);

  useEffect(() => {
    const html = document.documentElement;
    const vars = THEME_VARS[luxuryTheme] ?? THEME_VARS['hob-luxury'];
    Object.entries(vars).forEach(([key, value]) => {
      html.style.setProperty(key, value);
    });
    // Tag the html element so CSS can target luxury-specific overrides
    html.setAttribute('data-luxury', luxuryTheme);
  }, [luxuryTheme]);

  return null;
}
