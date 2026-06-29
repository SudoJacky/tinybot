import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const desktopSettingsCss = readFileSync(
  new URL("../webui/assets/styles/components/desktop-settings.css", import.meta.url),
  "utf8",
);
const desktopIndexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const mainCss = readFileSync(new URL("../webui/assets/styles/main.css", import.meta.url), "utf8");
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
    expect(desktopSettingsCss).toMatch(
      /\.desktop-workbench-sidebar\s+\.desktop-settings-sidebar:focus-within\s*\{[\s\S]*?box-shadow:\s*none;/,
    );
    expect(desktopSettingsCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("adapts the settings layout for compact desktop windows", () => {
    const workbenchSettingsSidebarRule = desktopSettingsCss.match(
      /\.desktop-workbench-sidebar \.desktop-settings-sidebar \{[\s\S]*?\}/,
    )?.[0] ?? "";

    expect(desktopSettingsCss).toContain("@media (max-width: 1040px)");
    expect(desktopSettingsCss).toContain("@media (max-width: 760px)");
    expect(desktopSettingsCss).toContain("@media (max-width: 520px)");
    expect(desktopSettingsCss).toMatch(
      /html\[data-desktop-active-workbench-module="settings"\]\s+body\.desktop-native-workbench\s+\.desktop-settings-pane\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    );
    expect(desktopSettingsCss).not.toContain("grid-template-columns: minmax(216px, 252px) minmax(0, 1fr)");
    expect(desktopSettingsCss).toContain(".desktop-workbench-sidebar .desktop-settings-sidebar");
    expect(workbenchSettingsSidebarRule).toContain("min-height: 100%");
    expect(workbenchSettingsSidebarRule).toContain("overflow: visible");
    expect(desktopSettingsCss).toContain("grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr))");
    expect(desktopSettingsCss).toContain("grid-template-columns: 1fr");
  });

  test("styles the redesigned settings task pages and quality layers", () => {
    const providerDetailPanelRule = desktopSettingsCss.match(
      /\.desktop-settings-provider-detail-panel \{[\s\S]*?\}/,
    )?.[0] ?? "";

    expect(desktopSettingsCss).toContain(".desktop-settings-task-page");
    expect(desktopSettingsCss).toContain(".desktop-settings-provider-page");
    expect(desktopSettingsCss).toContain(".desktop-settings-provider-detail-panel");
    expect(providerDetailPanelRule).toContain("max-height:");
    expect(providerDetailPanelRule).toContain("overflow-y: auto");
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

  test("collapses provider settings at constrained content widths", () => {
    expect(desktopSettingsCss).toMatch(
      /\.desktop-settings-content\s*\{[\s\S]*?align-content:\s*start;/,
    );
    expect(desktopSettingsCss).toContain("container-type: inline-size");
    expect(desktopSettingsCss).toContain("@container desktop-settings-content (max-width: 880px)");
    expect(desktopSettingsCss).toMatch(
      /\.desktop-settings-header,\s*[\s\S]*?\.desktop-settings-provider-header\s*\{[\s\S]*?justify-content:\s*start;[\s\S]*?min-height:\s*0;/,
    );
    expect(desktopSettingsCss).toMatch(
      /\.desktop-settings-save-region\s*\{[\s\S]*?flex:\s*0\s+1\s+auto;/,
    );
    expect(desktopSettingsCss).toMatch(
      /\.desktop-settings-provider-page\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
    );
    expect(desktopSettingsCss).toMatch(
      /\.desktop-settings-provider-detail-panel\s*\{[\s\S]*?position:\s*static;[\s\S]*?max-height:\s*none;/,
    );
    expect(desktopSettingsCss).toContain("grid-template-columns: minmax(0, 1fr) repeat(3, minmax(0, max-content))");
    expect(desktopSettingsCss).toContain("overflow-wrap: anywhere");
  });

  test("shows local settings navigation only when the workbench sidebar is hidden", () => {
    expect(desktopSettingsCss).toMatch(
      /\.desktop-settings-local-nav\s*\{[\s\S]*?display:\s*none;/,
    );
    expect(desktopSettingsCss).toContain('.desktop-workbench-shell[data-sidebar-visible="false"] .desktop-settings-local-nav');
    expect(desktopSettingsCss).toMatch(
      /\.desktop-workbench-shell\[data-sidebar-visible="false"\]\s+\.desktop-settings-local-nav\s*\{[\s\S]*?display:\s*grid;/,
    );
    expect(desktopSettingsCss).toContain(".desktop-settings-local-nav-current");
    expect(desktopSettingsCss).toContain(".desktop-settings-local-nav-restore");
  });

  test("uses shared desktop design tokens instead of a light-theme-only palette", () => {
    for (const token of ["--bg", "--panel", "--border", "--text", "--text-muted", "--accent", "--accent-soft"]) {
      expect(desktopSettingsCss).toContain(`var(${token})`);
    }
  });
});
