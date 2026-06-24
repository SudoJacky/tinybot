import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const desktopSettingsCss = readFileSync(
  new URL("../../../webui/assets/styles/components/desktop-settings.css", import.meta.url),
  "utf8",
);
const desktopIndexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainCss = readFileSync(new URL("../../../webui/assets/styles/main.css", import.meta.url), "utf8");
const nativeSettingsScope = "html[data-desktop-active-workbench-module=\"settings\"] body.desktop-native-workbench";

describe("desktop settings experience stylesheet", () => {
  test("loads from the native shell and stays out of the browser WebUI bundle", () => {
    expect(desktopIndexHtml).toContain('href="/assets/styles/components/desktop-settings.css"');
    expect(mainCss).not.toContain("desktop-settings.css");
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

  test("styles the redesigned settings task pages and quality layers", () => {
    expect(desktopSettingsCss).toContain(".desktop-settings-task-page");
    expect(desktopSettingsCss).toContain(".desktop-settings-provider-page");
    expect(desktopSettingsCss).toContain(".desktop-settings-provider-detail-panel");
    expect(desktopSettingsCss).toContain(".desktop-settings-knowledge-stages");
    expect(desktopSettingsCss).toContain(".desktop-settings-quality-layer-grid");
    expect(desktopSettingsCss).toContain(".desktop-settings-segmented-control");
    expect(desktopSettingsCss).toContain(".desktop-settings-quality-preset");
  });

  test("keeps redesigned settings pages from forcing horizontal scrolling", () => {
    expect(desktopSettingsCss).toContain("overflow-x: hidden");
    expect(desktopSettingsCss).toContain(".desktop-settings-task-card .desktop-settings-field");
    expect(desktopSettingsCss).toContain("grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr))");
    expect(desktopSettingsCss).toContain("width: 100%");
    expect(desktopSettingsCss).toContain("min-width: 0");
  });

  test("uses shared desktop design tokens instead of a light-theme-only palette", () => {
    for (const token of ["--bg", "--panel", "--border", "--text", "--text-muted", "--accent", "--accent-soft"]) {
      expect(desktopSettingsCss).toContain(`var(${token})`);
    }
  });
});
