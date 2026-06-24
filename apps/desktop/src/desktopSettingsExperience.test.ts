import { describe, expect, test } from "vitest";
import desktopSettingsCss from "../../../webui/assets/styles/components/desktop-settings.css?raw";
import mainCss from "../../../webui/assets/styles/main.css?raw";

const nativeSettingsScope = "html[data-desktop-active-workbench-module=\"settings\"] body.desktop-native-workbench";

describe("desktop settings experience stylesheet", () => {
  test("loads after the shared WebUI theme and stays scoped to the native settings route", () => {
    expect(mainCss.trimEnd().endsWith("@import './components/desktop-settings.css';")).toBe(true);
    expect(desktopSettingsCss).toContain(nativeSettingsScope);
    expect(desktopSettingsCss).not.toMatch(/^body\s*\{/m);
  });

  test("provides clear search, navigation, save, and keyboard focus states", () => {
    expect(desktopSettingsCss).toContain(".desktop-settings-search-results");
    expect(desktopSettingsCss).toContain("max-height: min(336px, 42vh)");
    expect(desktopSettingsCss).toContain('.desktop-settings-nav-item[data-active="true"]::before');
    expect(desktopSettingsCss).toContain(".desktop-settings-save-status-button:not(:disabled)");
    expect(desktopSettingsCss).toContain(":focus-visible");
    expect(desktopSettingsCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("adapts the settings layout for compact desktop windows", () => {
    expect(desktopSettingsCss).toContain("@media (max-width: 1040px)");
    expect(desktopSettingsCss).toContain("@media (max-width: 760px)");
    expect(desktopSettingsCss).toContain("@media (max-width: 520px)");
    expect(desktopSettingsCss).toContain("grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr))");
    expect(desktopSettingsCss).toContain("grid-template-columns: 1fr");
  });

  test("uses shared desktop design tokens instead of a light-theme-only palette", () => {
    for (const token of ["--bg", "--panel", "--border", "--text", "--text-muted", "--accent", "--accent-soft"]) {
      expect(desktopSettingsCss).toContain(`var(${token})`);
    }
  });
});
