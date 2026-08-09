import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import {
  appLanguageTag,
  loadAppLanguage,
  saveAppLanguage,
  type AppLanguage,
} from "../../app-core/settings/appLanguage";
import { i18n } from "../i18n";

type AppLanguageContextValue = {
  language: AppLanguage;
  setLanguage: (language: AppLanguage) => void;
};

const AppLanguageContext = createContext<AppLanguageContextValue | null>(null);

function applyLanguage(language: AppLanguage): void {
  document.documentElement.lang = appLanguageTag(language);
  if (i18n.resolvedLanguage !== language) {
    void i18n.changeLanguage(language);
  }
}

export function AppLanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage>(() => {
    const initialLanguage = loadAppLanguage();
    applyLanguage(initialLanguage);
    return initialLanguage;
  });

  const setLanguage = useCallback((nextLanguage: AppLanguage) => {
    saveAppLanguage(nextLanguage);
    applyLanguage(nextLanguage);
    setLanguageState(nextLanguage);
  }, []);

  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);
  return (
    <I18nextProvider i18n={i18n}>
      <AppLanguageContext.Provider value={value}>{children}</AppLanguageContext.Provider>
    </I18nextProvider>
  );
}

export function useAppLanguage(): AppLanguageContextValue {
  const context = useContext(AppLanguageContext);
  if (!context) {
    throw new Error("useAppLanguage must be used within AppLanguageProvider");
  }
  return context;
}
