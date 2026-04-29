import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { symphonyTheme, type Theme } from './theme.js';

const ThemeContext = createContext<Theme | null>(null);

export interface ThemeProviderProps {
  /** Override the resolved theme (tests). Defaults to the locked Symphony palette. */
  readonly theme?: Theme;
  readonly children: ReactNode;
}

export function ThemeProvider({ theme, children }: ThemeProviderProps): React.JSX.Element {
  const resolved = useMemo(() => theme ?? symphonyTheme(), [theme]);
  return <ThemeContext.Provider value={resolved}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useTheme() called outside <ThemeProvider>');
  }
  return ctx;
}
