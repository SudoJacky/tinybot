import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  applyAppearancePreferences,
  loadAppearancePreferences,
  resolveThemeMode,
  saveAppearancePreferences,
  type AppearancePreferences,
  type AppearanceTheme,
  type ResolvedTheme,
  type ThemeMode,
} from "../../app-core/settings/appAppearance";

type AppAppearanceContextValue = {
  preferences: AppearancePreferences;
  resolvedTheme: ResolvedTheme;
  setThemeMode: (mode: ThemeMode) => void;
  toggleTheme: () => void;
  updateTheme: (theme: ResolvedTheme, patch: Partial<AppearanceTheme>) => void;
  resetTheme: (theme: ResolvedTheme) => void;
};

const AppAppearanceContext = createContext<AppAppearanceContextValue | null>(null);

export function AppAppearanceProvider({ children }: { children: ReactNode }) {
  const [systemDark, setSystemDark] = useState(prefersDarkTheme);
  const [preferences, setPreferences] = useState<AppearancePreferences>(() => {
    const initialPreferences = loadAppearancePreferences();
    applyAppearancePreferences(initialPreferences, prefersDarkTheme());
    return initialPreferences;
  });

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) {
      return undefined;
    }
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    applyAppearancePreferences(preferences, systemDark);
  }, [preferences, systemDark]);

  const commit = useCallback((update: (current: AppearancePreferences) => AppearancePreferences) => {
    setPreferences((current) => {
      const next = update(current);
      saveAppearancePreferences(next);
      return next;
    });
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    commit((current) => ({ ...current, mode }));
  }, [commit]);

  const updateTheme = useCallback((theme: ResolvedTheme, patch: Partial<AppearanceTheme>) => {
    commit((current) => ({ ...current, [theme]: { ...current[theme], ...patch } }));
  }, [commit]);

  const resetTheme = useCallback((theme: ResolvedTheme) => {
    commit((current) => ({
      ...current,
      [theme]: { ...DEFAULT_APPEARANCE_PREFERENCES[theme] },
    }));
  }, [commit]);

  const resolvedTheme = resolveThemeMode(preferences.mode, systemDark);
  const toggleTheme = useCallback(() => {
    setThemeMode(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setThemeMode]);

  const value = useMemo(() => ({
    preferences,
    resolvedTheme,
    setThemeMode,
    toggleTheme,
    updateTheme,
    resetTheme,
  }), [preferences, resetTheme, resolvedTheme, setThemeMode, toggleTheme, updateTheme]);

  return <AppAppearanceContext.Provider value={value}>{children}</AppAppearanceContext.Provider>;
}

export function useAppAppearance(): AppAppearanceContextValue {
  const context = useContext(AppAppearanceContext);
  if (!context) {
    throw new Error("useAppAppearance must be used within AppAppearanceProvider");
  }
  return context;
}

function prefersDarkTheme(): boolean {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}
