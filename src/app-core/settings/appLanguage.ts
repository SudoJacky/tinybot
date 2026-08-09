export const APP_LANGUAGE_STORAGE_KEY = "tinybot-lang";

export type AppLanguage = "en" | "zh";

type AppLanguageStorage = Pick<Storage, "getItem" | "setItem">;

export function loadAppLanguage(
  storage: AppLanguageStorage = window.localStorage,
  systemLanguage: string = window.navigator.language,
): AppLanguage {
  return normalizeAppLanguage(storage.getItem(APP_LANGUAGE_STORAGE_KEY))
    ?? detectAppLanguage(systemLanguage);
}

export function saveAppLanguage(
  language: AppLanguage,
  storage: AppLanguageStorage = window.localStorage,
): void {
  storage.setItem(APP_LANGUAGE_STORAGE_KEY, language);
}

export function appLanguageTag(language: AppLanguage): "en-US" | "zh-CN" {
  return language === "zh" ? "zh-CN" : "en-US";
}

function detectAppLanguage(systemLanguage: string): AppLanguage {
  return systemLanguage.trim().toLowerCase().startsWith("zh") ? "zh" : "en";
}

function normalizeAppLanguage(value: string | null): AppLanguage | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "zh" || normalized === "zh-cn") {
    return "zh";
  }
  if (normalized === "en" || normalized === "en-us") {
    return "en";
  }
  return null;
}
