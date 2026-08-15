import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const shellStylesheet = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");
const chatStylesheet = readFileSync(new URL("../chat/ChatPage.css", import.meta.url), "utf8");
const tinyOsStylesheet = readFileSync(new URL("../chat/TinyOsShell.css", import.meta.url), "utf8");
const settingsStylesheet = readFileSync(new URL("../settings/SettingsRoute.css", import.meta.url), "utf8");
const memoryStylesheet = readFileSync(new URL("../memory/MemoryRoute.css", import.meta.url), "utf8");

describe("workbench CSS interaction contracts", () => {
  test("keeps the TinyOS backdrop translucent while it is hovered or focused", () => {
    const backdropInteractionRule = tinyOsStylesheet.match(
      /button\.tinyos-overlay-backdrop:hover,\s*button\.tinyos-overlay-backdrop:focus-visible\s*\{([^}]+)\}/,
    );

    expect(backdropInteractionRule?.[1]).toContain("background: rgb(20 20 19 / 18%)");
  });

  test("keeps TinyOS shell overlays compact and preserves gentle reduced-motion fades", () => {
    expect(tinyOsStylesheet).toContain("@container (max-width: 520px)");
    expect(tinyOsStylesheet).toContain(".tinyos-shell-overlay");
    expect(tinyOsStylesheet).toContain("max-height: calc(100% - 8px)");
    expect(tinyOsStylesheet).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(tinyOsStylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(shellStylesheet).toContain("animation-duration: 1ms !important");
    expect(tinyOsStylesheet).toContain("transition-duration: 140ms");
    expect(tinyOsStylesheet).not.toContain("transition-duration: 0ms !important");
  });

  test("keeps conversation rows intrinsic and scopes drawer header layout", () => {
    const conversationRule = chatStylesheet.match(/\.react-conversation-view\s*\{([^}]+)\}/);
    const drawerHeaderRule = chatStylesheet.match(
      /\.react-right-drawer__header,\s*\.react-command-palette > div\s*\{([^}]+)\}/,
    );
    const artifactDetailRule = chatStylesheet.match(/\.react-artifact-detail\s*\{([^}]+)\}/);

    expect(conversationRule?.[1]).toContain("grid-auto-rows: max-content");
    expect(drawerHeaderRule?.[1]).toContain("display: flex");
    expect(artifactDetailRule?.[1]).toContain("min-width: 0");
    expect(chatStylesheet).not.toContain(".react-right-drawer > div");
  });

  test("centers a bounded conversation track on wide windows", () => {
    const conversationRule = chatStylesheet.match(/\.react-conversation-view\s*\{([^}]+)\}/);

    expect(conversationRule?.[1]).toContain("grid-template-columns: minmax(0, min(920px, 100%))");
    expect(conversationRule?.[1]).toContain("justify-content: center");
  });

  test("floats queued inputs above the composer without consuming conversation layout", () => {
    const queueRule = chatStylesheet.match(/\.react-queued-inputs\s*\{([^}]+)\}/);
    const queueListRule = chatStylesheet.match(/\.react-queued-inputs ol\s*\{([^}]+)\}/);

    expect(queueRule?.[1]).toContain("position: absolute");
    expect(queueRule?.[1]).toContain("bottom: calc(100% - 8px)");
    expect(queueRule?.[1]).toContain("max-height: min(160px, 32vh)");
    expect(queueListRule?.[1]).toContain("overflow-y: auto");
  });

  test("keeps tool activity rows compact without shrinking their action controls", () => {
    const headerRule = chatStylesheet.match(/\.react-tool-activity__header\s*\{([^}]+)\}/);
    const actionRule = chatStylesheet.match(
      /\.react-tool-activity__open-details,\s*\.react-tool-activity__toggle,\s*\.react-patch-file__copy\s*\{([^}]+)\}/,
    );
    const detailsRule = chatStylesheet.match(/\.react-tool-activity__details\s*\{([^}]+)\}/);

    expect(headerRule?.[1]).toContain("min-height: 44px");
    expect(headerRule?.[1]).toContain("padding: 6px 0");
    expect(actionRule?.[1]).toContain("width: 30px");
    expect(actionRule?.[1]).toContain("height: 30px");
    expect(detailsRule?.[1]).toContain("padding: 0 0 12px 26px");
  });

  test("routes appearance controls through shared theme tokens", () => {
    expect(shellStylesheet).toContain("--color-panel:");
    expect(shellStylesheet).toContain("--color-accent: var(--color-primary)");
    expect(shellStylesheet).toContain("font-family: var(--font-ui)");
    expect(shellStylesheet).toContain("background: var(--sidebar-background)");
    expect(settingsStylesheet).toContain(".react-theme-mode-grid");
  });

  test("keeps route styles with their lazy-loaded owners", () => {
    expect(shellStylesheet).not.toMatch(/\.(?:tinyos|react-settings|react-memory)-/);
    expect(chatStylesheet).not.toMatch(/\.(?:tinyos|react-settings|react-memory)-/);
    expect(tinyOsStylesheet).toContain(".tinyos-workspace");
    expect(tinyOsStylesheet).toContain("@keyframes react-spin");
    expect(settingsStylesheet).toContain(".react-settings-layout");
    expect(settingsStylesheet).toContain("@keyframes react-settings-spin");
    expect(memoryStylesheet).toContain(".react-memory-page");
    expect(memoryStylesheet).toContain("@keyframes react-settings-spin");
    expect(shellStylesheet).toContain("@keyframes react-list-enter");
    expect(shellStylesheet).toContain("@keyframes react-session-tab-spin");
  });
});
