import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export type LuxuryTheme = 'hob-luxury' | 'royal-emerald' | 'midnight-gold' | 'champagne-rose' | 'ocean-sapphire';

interface UiState {
  sidebarOpen: boolean;
  // Separate from sidebarOpen on purpose: sidebarOpen is the desktop
  // collapsed/expanded width preference (sensibly defaults to open).
  // mobileSidebarOpen is the mobile drawer's visibility and must default
  // to closed, or the full-width drawer covers page content on first load
  // before the user has ever tapped the "עוד" button.
  mobileSidebarOpen: boolean;
  theme: 'light' | 'dark';
  luxuryTheme: LuxuryTheme;
}

const getInitialTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'dark';
  return (localStorage.getItem('hob_theme') as 'light' | 'dark') || 'dark';
};

// v3 = hob-luxury default; bump version to force-reset on next deploy
const THEME_VERSION = '3';
const getInitialLuxuryTheme = (): LuxuryTheme => {
  if (typeof window === 'undefined') return 'hob-luxury';
  const savedVersion = localStorage.getItem('hob_theme_version');
  if (savedVersion !== THEME_VERSION) {
    localStorage.setItem('hob_theme_version', THEME_VERSION);
    localStorage.setItem('hob_luxury_theme', 'hob-luxury');
    localStorage.setItem('hob_theme', 'dark');
    return 'hob-luxury';
  }
  return (localStorage.getItem('hob_luxury_theme') as LuxuryTheme) || 'hob-luxury';
};

const initialState: UiState = {
  sidebarOpen: true,
  mobileSidebarOpen: false,
  theme: 'dark',
  luxuryTheme: 'hob-luxury',
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toggleSidebar: (state) => { state.sidebarOpen = !state.sidebarOpen; },
    setSidebar: (state, action) => { state.sidebarOpen = action.payload; },
    toggleMobileSidebar: (state) => { state.mobileSidebarOpen = !state.mobileSidebarOpen; },
    setMobileSidebar: (state, action) => { state.mobileSidebarOpen = action.payload; },
    toggleTheme: (state) => {
      state.theme = state.theme === 'light' ? 'dark' : 'light';
      if (typeof window !== 'undefined') {
        localStorage.setItem('hob_theme', state.theme);
      }
    },
    initTheme: (state) => {
      state.theme = getInitialTheme();
      state.luxuryTheme = getInitialLuxuryTheme();
    },
    setLuxuryTheme: (state, action: PayloadAction<LuxuryTheme>) => {
      state.luxuryTheme = action.payload;
      if (typeof window !== 'undefined') {
        localStorage.setItem('hob_luxury_theme', action.payload);
      }
    },
  },
});

export const { toggleSidebar, setSidebar, toggleMobileSidebar, setMobileSidebar, toggleTheme, initTheme, setLuxuryTheme } = uiSlice.actions;
export default uiSlice.reducer;
