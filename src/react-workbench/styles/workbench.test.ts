import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const stylesheet = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");

describe("workbench CSS interaction contracts", () => {
  test("keeps the TinyOS backdrop translucent while it is hovered or focused", () => {
    const backdropInteractionRule = stylesheet.match(
      /button\.tinyos-overlay-backdrop:hover,\s*button\.tinyos-overlay-backdrop:focus-visible\s*\{([^}]+)\}/,
    );

    expect(backdropInteractionRule?.[1]).toContain("background: rgb(20 20 19 / 18%)");
  });

  test("keeps TinyOS shell overlays compact and preserves gentle reduced-motion fades", () => {
    expect(stylesheet).toContain("@container (max-width: 520px)");
    expect(stylesheet).toContain(".tinyos-shell-overlay");
    expect(stylesheet).toContain("max-height: calc(100% - 8px)");
    expect(stylesheet).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(stylesheet).toContain("@media (prefers-reduced-motion: reduce)");
    expect(stylesheet).toContain("animation-duration: 1ms !important");
    expect(stylesheet).toContain("transition-duration: 140ms");
    expect(stylesheet).not.toContain("transition-duration: 0ms !important");
  });

  test("keeps conversation rows intrinsic and scopes drawer header layout", () => {
    const conversationRule = stylesheet.match(/\.react-conversation-view\s*\{([^}]+)\}/);
    const drawerHeaderRule = stylesheet.match(
      /\.react-right-drawer__header,\s*\.react-command-palette > div\s*\{([^}]+)\}/,
    );
    const artifactDetailRule = stylesheet.match(/\.react-artifact-detail\s*\{([^}]+)\}/);

    expect(conversationRule?.[1]).toContain("grid-auto-rows: max-content");
    expect(drawerHeaderRule?.[1]).toContain("display: flex");
    expect(artifactDetailRule?.[1]).toContain("min-width: 0");
    expect(stylesheet).not.toContain(".react-right-drawer > div");
  });

  test("centers a bounded conversation track on wide windows", () => {
    const conversationRule = stylesheet.match(/\.react-conversation-view\s*\{([^}]+)\}/);

    expect(conversationRule?.[1]).toContain("grid-template-columns: minmax(0, min(920px, 100%))");
    expect(conversationRule?.[1]).toContain("justify-content: center");
  });

  test("floats queued inputs above the composer without consuming conversation layout", () => {
    const queueRule = stylesheet.match(/\.react-queued-inputs\s*\{([^}]+)\}/);
    const queueListRule = stylesheet.match(/\.react-queued-inputs ol\s*\{([^}]+)\}/);

    expect(queueRule?.[1]).toContain("position: absolute");
    expect(queueRule?.[1]).toContain("bottom: calc(100% - 8px)");
    expect(queueRule?.[1]).toContain("max-height: min(160px, 32vh)");
    expect(queueListRule?.[1]).toContain("overflow-y: auto");
  });

  test("keeps tool activity rows compact without shrinking their action controls", () => {
    const headerRule = stylesheet.match(/\.react-tool-activity__header\s*\{([^}]+)\}/);
    const actionRule = stylesheet.match(
      /\.react-tool-activity__open-details,\s*\.react-tool-activity__toggle,\s*\.react-patch-file__copy\s*\{([^}]+)\}/,
    );
    const detailsRule = stylesheet.match(/\.react-tool-activity__details\s*\{([^}]+)\}/);

    expect(headerRule?.[1]).toContain("min-height: 44px");
    expect(headerRule?.[1]).toContain("padding: 6px 0");
    expect(actionRule?.[1]).toContain("width: 30px");
    expect(actionRule?.[1]).toContain("height: 30px");
    expect(detailsRule?.[1]).toContain("padding: 0 0 12px 26px");
  });

  test("routes appearance controls through shared theme tokens", () => {
    expect(stylesheet).toContain("--color-panel:");
    expect(stylesheet).toContain("--color-accent: var(--color-primary)");
    expect(stylesheet).toContain("font-family: var(--font-ui)");
    expect(stylesheet).toContain("background: var(--sidebar-background)");
    expect(stylesheet).toContain(".react-theme-mode-grid");
  });
});
