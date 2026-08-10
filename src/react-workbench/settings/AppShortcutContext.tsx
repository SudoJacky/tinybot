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
  DEFAULT_SHORTCUT_PREFERENCES,
  loadShortcutPreferences,
  saveShortcutPreferences,
  type ShortcutBinding,
  type ShortcutCommandId,
  type ShortcutPreferences,
} from "../../app-core/settings/appShortcuts";
import { createDesktopNativeShortcutClient } from "../../app-core/native/desktopNativeShortcuts";

type AppShortcutContextValue = {
  preferences: ShortcutPreferences;
  setBinding: (commandId: ShortcutCommandId, binding: ShortcutBinding) => void;
  resetBinding: (commandId: ShortcutCommandId) => void;
  resetAll: () => void;
};

const AppShortcutContext = createContext<AppShortcutContextValue | null>(null);

export function AppShortcutProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<ShortcutPreferences>(loadShortcutPreferences);
  const nativeClient = useMemo(createDesktopNativeShortcutClient, []);

  useEffect(() => {
    if (!nativeClient) {
      return;
    }
    void nativeClient.sync(preferences).catch((error) => {
      console.error("[tinybot-shortcuts] Failed to synchronize native menu shortcuts.", error);
    });
  }, [nativeClient, preferences]);

  const commit = useCallback((update: (current: ShortcutPreferences) => ShortcutPreferences) => {
    setPreferences((current) => {
      const next = update(current);
      saveShortcutPreferences(next);
      return next;
    });
  }, []);

  const setBinding = useCallback((commandId: ShortcutCommandId, binding: ShortcutBinding) => {
    commit((current) => ({ ...current, [commandId]: binding }));
  }, [commit]);

  const resetBinding = useCallback((commandId: ShortcutCommandId) => {
    setBinding(commandId, DEFAULT_SHORTCUT_PREFERENCES[commandId]);
  }, [setBinding]);

  const resetAll = useCallback(() => {
    commit(() => ({ ...DEFAULT_SHORTCUT_PREFERENCES }));
  }, [commit]);

  const value = useMemo(() => ({ preferences, resetAll, resetBinding, setBinding }), [
    preferences,
    resetAll,
    resetBinding,
    setBinding,
  ]);

  return <AppShortcutContext.Provider value={value}>{children}</AppShortcutContext.Provider>;
}

export function useAppShortcuts(): AppShortcutContextValue {
  const context = useContext(AppShortcutContext);
  if (!context) {
    throw new Error("useAppShortcuts must be used within AppShortcutProvider");
  }
  return context;
}
