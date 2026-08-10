import type { TFunction } from "i18next";
import { Monitor, Moon, RotateCcw, Sun, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  CODE_FONT_STACKS,
  UI_FONT_STACKS,
  type AppearanceTheme,
  type CodeFontId,
  type ResolvedTheme,
  type ThemeMode,
  type UiFontId,
} from "../../app-core/settings/appAppearance";
import { useAppAppearance } from "./AppAppearanceContext";

const THEME_MODE_OPTIONS: Array<{ mode: ThemeMode; icon: LucideIcon }> = [
  { mode: "system", icon: Monitor },
  { mode: "light", icon: Sun },
  { mode: "dark", icon: Moon },
];

export function AppearanceSettingsPage() {
  const { preferences, resetTheme, resolvedTheme, setThemeMode, updateTheme } = useAppAppearance();
  const { t } = useTranslation("settings");
  return (
    <section className="react-appearance-settings" aria-labelledby="appearance-settings-title">
      <header className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("appearance.eyebrow")}</span>
          <h2 id="appearance-settings-title">{t("appearance.title")}</h2>
          <p>{t("appearance.description")}</p>
        </div>
      </header>

      <fieldset className="react-appearance-settings__modes">
        <legend>{t("appearance.modeTitle")}</legend>
        <p>{t("appearance.modeDescription")}</p>
        <div className="react-theme-mode-grid" role="radiogroup" aria-label={t("appearance.modeOptionsLabel")}>
          {THEME_MODE_OPTIONS.map(({ mode, icon: Icon }) => (
            <label className="react-theme-mode-card" data-selected={preferences.mode === mode ? "true" : "false"} key={mode}>
              <input
                aria-label={t(`appearance.modes.${mode}`)}
                checked={preferences.mode === mode}
                name="tinybot-theme-mode"
                onChange={() => setThemeMode(mode)}
                type="radio"
                value={mode}
              />
              <span className="react-theme-mode-card__preview" data-preview={mode} aria-hidden="true">
                <span className="react-theme-mode-card__chrome"><Icon size={13} /></span>
                <span className="react-theme-mode-card__window">
                  <i /><i /><i />
                </span>
              </span>
              <strong>{t(`appearance.modes.${mode}`)}</strong>
              <small>{t(`appearance.modeDescriptions.${mode}`)}</small>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="react-appearance-settings__themes">
        <ThemeEditor
          active={resolvedTheme === "light"}
          theme="light"
          value={preferences.light}
          onChange={(patch) => updateTheme("light", patch)}
          onReset={() => resetTheme("light")}
          t={t}
        />
        <ThemeEditor
          active={resolvedTheme === "dark"}
          theme="dark"
          value={preferences.dark}
          onChange={(patch) => updateTheme("dark", patch)}
          onReset={() => resetTheme("dark")}
          t={t}
        />
      </div>

      <small className="react-app-settings__persistence">{t("appearance.persistence")}</small>
    </section>
  );
}

function ThemeEditor({
  active,
  onChange,
  onReset,
  t,
  theme,
  value,
}: {
  active: boolean;
  onChange: (patch: Partial<AppearanceTheme>) => void;
  onReset: () => void;
  t: TFunction<"settings">;
  theme: ResolvedTheme;
  value: AppearanceTheme;
}) {
  const themeName = t(`appearance.modes.${theme}`);
  return (
    <section className="react-appearance-theme" data-active={active ? "true" : "false"} aria-labelledby={`appearance-${theme}-title`}>
      <header>
        <div>
          <h3 id={`appearance-${theme}-title`}>{t("appearance.themeTitle", { theme: themeName })}</h3>
          {active ? <span>{t("appearance.active")}</span> : null}
        </div>
        <button type="button" onClick={onReset}>
          <RotateCcw aria-hidden="true" size={14} />
          {t("appearance.reset")}
        </button>
      </header>
      <div className="react-appearance-theme__rows">
        <ColorRow
          ariaLabel={t("appearance.colorAria", { theme: themeName, token: t("appearance.accent").toLocaleLowerCase() })}
          label={t("appearance.accent")}
          value={value.accent}
          onChange={(accent) => onChange({ accent })}
        />
        <ColorRow
          ariaLabel={t("appearance.colorAria", { theme: themeName, token: t("appearance.background").toLocaleLowerCase() })}
          label={t("appearance.background")}
          value={value.background}
          onChange={(background) => onChange({ background })}
        />
        <ColorRow
          ariaLabel={t("appearance.colorAria", { theme: themeName, token: t("appearance.foreground").toLocaleLowerCase() })}
          label={t("appearance.foreground")}
          value={value.foreground}
          onChange={(foreground) => onChange({ foreground })}
        />
        <SelectRow
          ariaLabel={t("appearance.selectAria", { theme: themeName, setting: t("appearance.uiFont") })}
          label={t("appearance.uiFont")}
          value={value.uiFont}
          options={(Object.keys(UI_FONT_STACKS) as UiFontId[]).map((id) => ({ id, label: t(`appearance.uiFonts.${id}`) }))}
          onChange={(uiFont) => onChange({ uiFont: uiFont as UiFontId })}
        />
        <SelectRow
          ariaLabel={t("appearance.selectAria", { theme: themeName, setting: t("appearance.codeFont") })}
          label={t("appearance.codeFont")}
          value={value.codeFont}
          options={(Object.keys(CODE_FONT_STACKS) as CodeFontId[]).map((id) => ({ id, label: t(`appearance.codeFonts.${id}`) }))}
          onChange={(codeFont) => onChange({ codeFont: codeFont as CodeFontId })}
        />
        <label className="react-appearance-row react-appearance-row--toggle">
          <span>
            <strong>{t("appearance.translucentSidebar")}</strong>
            <small>{t("appearance.translucentSidebarDescription")}</small>
          </span>
          <input
            aria-label={t("appearance.toggleAria", { theme: themeName })}
            checked={value.translucentSidebar}
            onChange={(event) => onChange({ translucentSidebar: event.target.checked })}
            type="checkbox"
          />
        </label>
        <label className="react-appearance-row react-appearance-row--range">
          <span>
            <strong>{t("appearance.contrast")}</strong>
            <small>{t("appearance.contrastDescription")}</small>
          </span>
          <span className="react-appearance-range">
            <input
              aria-label={t("appearance.contrastAria", { theme: themeName })}
              max="80"
              min="20"
              onChange={(event) => onChange({ contrast: Number(event.target.value) })}
              type="range"
              value={value.contrast}
            />
            <output>{value.contrast}</output>
          </span>
        </label>
      </div>
    </section>
  );
}

function ColorRow({
  ariaLabel,
  label,
  onChange,
  value,
}: {
  ariaLabel: string;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="react-appearance-row react-appearance-row--color">
      <strong>{label}</strong>
      <span className="react-appearance-color">
        <input aria-label={ariaLabel} onChange={(event) => onChange(event.target.value)} type="color" value={value} />
        <code>{value.toUpperCase()}</code>
      </span>
    </label>
  );
}

function SelectRow({
  ariaLabel,
  label,
  onChange,
  options,
  value,
}: {
  ariaLabel: string;
  label: string;
  onChange: (value: string) => void;
  options: Array<{ id: string; label: string }>;
  value: string;
}) {
  return (
    <label className="react-appearance-row">
      <strong>{label}</strong>
      <select aria-label={ariaLabel} onChange={(event) => onChange(event.target.value)} value={value}>
        {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
    </label>
  );
}
