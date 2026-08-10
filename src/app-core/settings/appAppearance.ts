export const APPEARANCE_STORAGE_KEY = "tinybot.ui.appearance";

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = Exclude<ThemeMode, "system">;

export const UI_FONT_STACKS = {
  inter: 'Inter, "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Arial, sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif',
  segoe: '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", ui-sans-serif, system-ui, sans-serif',
} as const;

export const CODE_FONT_STACKS = {
  jetbrains: '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, monospace',
  cascadia: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  consolas: 'Consolas, "Cascadia Mono", monospace',
} as const;

export type UiFontId = keyof typeof UI_FONT_STACKS;
export type CodeFontId = keyof typeof CODE_FONT_STACKS;

export type AppearanceTheme = {
  accent: string;
  background: string;
  foreground: string;
  uiFont: UiFontId;
  codeFont: CodeFontId;
  translucentSidebar: boolean;
  contrast: number;
};

export type AppearancePreferences = {
  mode: ThemeMode;
  light: AppearanceTheme;
  dark: AppearanceTheme;
};

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  mode: "system",
  light: {
    accent: "#cc785c",
    background: "#faf9f5",
    foreground: "#141413",
    uiFont: "inter",
    codeFont: "jetbrains",
    translucentSidebar: true,
    contrast: 45,
  },
  dark: {
    accent: "#e28b6f",
    background: "#181817",
    foreground: "#f3f0e9",
    uiFont: "inter",
    codeFont: "jetbrains",
    translucentSidebar: true,
    contrast: 60,
  },
};

type AppearanceStorage = Pick<Storage, "getItem" | "setItem">;

export function loadAppearancePreferences(
  storage: AppearanceStorage = window.localStorage,
): AppearancePreferences {
  const serialized = storage.getItem(APPEARANCE_STORAGE_KEY);
  if (!serialized) {
    return cloneDefaults();
  }
  try {
    return normalizePreferences(JSON.parse(serialized));
  } catch (error) {
    console.warn("[tinybot-appearance] Ignoring an unreadable local appearance preference.", error);
    return cloneDefaults();
  }
}

export function saveAppearancePreferences(
  preferences: AppearancePreferences,
  storage: AppearanceStorage = window.localStorage,
): void {
  storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
}

export function resolveThemeMode(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  systemDark: boolean,
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  const resolvedTheme = resolveThemeMode(preferences.mode, systemDark);
  const theme = preferences[resolvedTheme];
  const surfaceSoftStrength = 2 + theme.contrast * 0.05;
  const surfaceCardStrength = 4 + theme.contrast * 0.09;
  const surfaceStrongStrength = 6 + theme.contrast * 0.13;
  const hairlineStrength = 7 + theme.contrast * 0.08;

  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = preferences.mode;
  root.style.colorScheme = resolvedTheme;
  root.style.setProperty("--font-ui", UI_FONT_STACKS[theme.uiFont]);
  root.style.setProperty("--font-code", CODE_FONT_STACKS[theme.codeFont]);
  root.style.setProperty("--color-canvas", theme.background);
  root.style.setProperty("--color-ink", theme.foreground);
  root.style.setProperty("--color-body", "color-mix(in srgb, var(--color-ink) 82%, var(--color-canvas))");
  root.style.setProperty("--color-muted", "color-mix(in srgb, var(--color-ink) 62%, var(--color-canvas))");
  root.style.setProperty("--color-muted-soft", "color-mix(in srgb, var(--color-ink) 46%, var(--color-canvas))");
  root.style.setProperty("--color-primary", theme.accent);
  root.style.setProperty("--color-primary-active", "color-mix(in srgb, var(--color-primary) 78%, var(--color-ink))");
  root.style.setProperty("--color-on-primary", contrastingTextColor(theme.accent));
  root.style.setProperty("--color-accent", theme.accent);
  root.style.setProperty("--color-panel", "color-mix(in srgb, var(--color-canvas), var(--color-ink) 1%)");
  root.style.setProperty("--color-panel-warm", "color-mix(in srgb, var(--color-canvas), var(--color-primary) 2%)");
  root.style.setProperty("--color-surface", "var(--color-panel)");
  root.style.setProperty("--color-surface-soft", colorMixWithInk(surfaceSoftStrength));
  root.style.setProperty("--color-surface-card", colorMixWithInk(surfaceCardStrength));
  root.style.setProperty("--color-cream-strong", colorMixWithInk(surfaceStrongStrength));
  root.style.setProperty("--color-hairline", colorMixWithInk(hairlineStrength));
  root.style.setProperty("--appearance-contrast", String(theme.contrast));
  root.style.setProperty(
    "--sidebar-background",
    theme.translucentSidebar
      ? "color-mix(in srgb, var(--color-surface-soft) 78%, transparent)"
      : "var(--color-surface-soft)",
  );
  root.style.setProperty("--sidebar-backdrop-filter", theme.translucentSidebar ? "blur(18px) saturate(1.08)" : "none");
  return resolvedTheme;
}

function normalizePreferences(input: unknown): AppearancePreferences {
  const source = isRecord(input) ? input : {};
  return {
    mode: isThemeMode(source.mode) ? source.mode : DEFAULT_APPEARANCE_PREFERENCES.mode,
    light: normalizeTheme(source.light, DEFAULT_APPEARANCE_PREFERENCES.light),
    dark: normalizeTheme(source.dark, DEFAULT_APPEARANCE_PREFERENCES.dark),
  };
}

function normalizeTheme(input: unknown, fallback: AppearanceTheme): AppearanceTheme {
  const source = isRecord(input) ? input : {};
  return {
    accent: normalizeHexColor(source.accent) ?? fallback.accent,
    background: normalizeHexColor(source.background) ?? fallback.background,
    foreground: normalizeHexColor(source.foreground) ?? fallback.foreground,
    uiFont: isRecordKey(source.uiFont, UI_FONT_STACKS) ? source.uiFont : fallback.uiFont,
    codeFont: isRecordKey(source.codeFont, CODE_FONT_STACKS) ? source.codeFont : fallback.codeFont,
    translucentSidebar: typeof source.translucentSidebar === "boolean"
      ? source.translucentSidebar
      : fallback.translucentSidebar,
    contrast: typeof source.contrast === "number"
      && Number.isInteger(source.contrast)
      && source.contrast >= 20
      && source.contrast <= 80
      ? source.contrast
      : fallback.contrast,
  };
}

function normalizeHexColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordKey<T extends Record<string, string>>(value: unknown, record: T): value is keyof T {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(record, value);
}

function colorMixWithInk(strength: number): string {
  return `color-mix(in srgb, var(--color-canvas), var(--color-ink) ${strength.toFixed(2)}%)`;
}

function contrastingTextColor(hexColor: string): "#111111" | "#ffffff" {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hexColor.slice(offset, offset + 2), 16) / 255);
  const luminance = channels
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
  return luminance > 0.179 ? "#111111" : "#ffffff";
}

function cloneDefaults(): AppearancePreferences {
  return {
    mode: DEFAULT_APPEARANCE_PREFERENCES.mode,
    light: { ...DEFAULT_APPEARANCE_PREFERENCES.light },
    dark: { ...DEFAULT_APPEARANCE_PREFERENCES.dark },
  };
}
