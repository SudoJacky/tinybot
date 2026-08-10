// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_PREFERENCES,
  applyAppearancePreferences,
  loadAppearancePreferences,
  resolveThemeMode,
  saveAppearancePreferences,
} from "./appAppearance";

describe("app appearance preference", () => {
  test("loads the safe defaults when no local preference exists", () => {
    expect(loadAppearancePreferences(createStorage())).toEqual(DEFAULT_APPEARANCE_PREFERENCES);
  });

  test("persists supported theme modes and per-theme design tokens", () => {
    const storage = createStorage();
    const preferences = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      mode: "dark" as const,
      dark: {
        ...DEFAULT_APPEARANCE_PREFERENCES.dark,
        accent: "#3366ff",
        contrast: 72,
        translucentSidebar: false,
      },
    };

    saveAppearancePreferences(preferences, storage);

    expect(loadAppearancePreferences(storage)).toEqual(preferences);
  });

  test("normalizes malformed stored fields instead of applying invalid CSS", () => {
    const storage = createStorage({
      [APPEARANCE_STORAGE_KEY]: JSON.stringify({
        mode: "sepia",
        light: { accent: "red", background: "#fff", foreground: "#123456", contrast: 999 },
        dark: { uiFont: "comic-sans", codeFont: "papyrus", translucentSidebar: "yes" },
      }),
    });

    const preferences = loadAppearancePreferences(storage);

    expect(preferences.mode).toBe("system");
    expect(preferences.light.accent).toBe(DEFAULT_APPEARANCE_PREFERENCES.light.accent);
    expect(preferences.light.background).toBe(DEFAULT_APPEARANCE_PREFERENCES.light.background);
    expect(preferences.light.foreground).toBe("#123456");
    expect(preferences.light.contrast).toBe(DEFAULT_APPEARANCE_PREFERENCES.light.contrast);
    expect(preferences.dark.uiFont).toBe(DEFAULT_APPEARANCE_PREFERENCES.dark.uiFont);
    expect(preferences.dark.translucentSidebar).toBe(DEFAULT_APPEARANCE_PREFERENCES.dark.translucentSidebar);
  });

  test("resolves system mode and applies the selected theme as global CSS tokens", () => {
    const preferences = {
      ...DEFAULT_APPEARANCE_PREFERENCES,
      mode: "system" as const,
      dark: {
        ...DEFAULT_APPEARANCE_PREFERENCES.dark,
        accent: "#3366ff",
        background: "#101216",
        foreground: "#f5f7ff",
        codeFont: "consolas" as const,
        translucentSidebar: false,
      },
    };

    expect(resolveThemeMode("system", false)).toBe("light");
    expect(resolveThemeMode("system", true)).toBe("dark");

    applyAppearancePreferences(preferences, true, document.documentElement);

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themeMode).toBe("system");
    expect(document.documentElement.style.getPropertyValue("--color-primary")).toBe("#3366ff");
    expect(document.documentElement.style.getPropertyValue("--color-accent")).toBe("#3366ff");
    expect(document.documentElement.style.getPropertyValue("--color-canvas")).toBe("#101216");
    expect(document.documentElement.style.getPropertyValue("--font-code")).toContain("Consolas");
    expect(document.documentElement.style.getPropertyValue("--sidebar-background")).toBe("var(--color-surface-soft)");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyAppearancePreferences(DEFAULT_APPEARANCE_PREFERENCES, false, document.documentElement);
    expect(document.documentElement.style.getPropertyValue("--color-on-primary")).toBe("#111111");
    expect(document.documentElement.style.getPropertyValue("--color-surface")).toBe("var(--color-panel)");
  });
});

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
