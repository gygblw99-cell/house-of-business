'use client';

import { Provider } from 'react-redux';
import { store } from '@/store';
import { ThemeApplier } from '@/components/ThemeApplier';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <Provider store={store}>
      <ThemeApplier />
      {children}
    </Provider>
  );
}
