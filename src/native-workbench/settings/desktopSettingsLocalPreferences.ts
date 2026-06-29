import {
  applyDesktopSettingsFieldEdit,
  type DesktopSettingsFormState,
} from "./desktopSettingsProviders";

const DESKTOP_SETTINGS_LOCAL_PREFERENCES_KEY = "tinybot.desktop.settings.preferences";

export interface DesktopSettingsLocalPreferences {
  providerEditorSelectedProvider?: string;
}

type DesktopSettingsPreferenceStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadDesktopSettingsLocalPreferences(
  storage: DesktopSettingsPreferenceStorage | null | undefined = defaultDesktopSettingsPreferenceStorage(),
): DesktopSettingsLocalPreferences {
  if (!storage) {
    return {};
  }
  try {
    const raw = storage.getItem(DESKTOP_SETTINGS_LOCAL_PREFERENCES_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const provider = stringOrEmpty(parsed.providerEditorSelectedProvider).trim();
    return provider ? { providerEditorSelectedProvider: provider } : {};
  } catch {
    return {};
  }
}

export function saveDesktopSettingsLocalPreferences(
  preferences: DesktopSettingsLocalPreferences,
  storage: DesktopSettingsPreferenceStorage | null | undefined = defaultDesktopSettingsPreferenceStorage(),
): void {
  if (!storage) {
    return;
  }
  const current = loadDesktopSettingsLocalPreferences(storage);
  const next: DesktopSettingsLocalPreferences = {
    ...current,
    ...preferences,
  };
  try {
    storage.setItem(DESKTOP_SETTINGS_LOCAL_PREFERENCES_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable in constrained browser contexts.
  }
}

export function clearDesktopSettingsLocalPreferences(
  storage: DesktopSettingsPreferenceStorage | null | undefined = defaultDesktopSettingsPreferenceStorage(),
): void {
  try {
    storage?.removeItem(DESKTOP_SETTINGS_LOCAL_PREFERENCES_KEY);
  } catch {
    // Storage may be unavailable in constrained browser contexts.
  }
}

export function applyDesktopSettingsLocalPreferences(
  state: DesktopSettingsFormState,
  preferences: DesktopSettingsLocalPreferences,
): DesktopSettingsFormState {
  const providerId = preferences.providerEditorSelectedProvider?.trim();
  if (!providerId || !state.providerSummaries.some((provider) => provider.id === providerId)) {
    return state;
  }
  return applyDesktopSettingsFieldEdit(state, "selectedProvider", providerId);
}

function defaultDesktopSettingsPreferenceStorage(): DesktopSettingsPreferenceStorage | null {
  return typeof window !== "undefined" ? window.localStorage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}
