import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const shellStylesheet = readFileSync(new URL("./workbench.css", import.meta.url), "utf8");
const chatStylesheet = readFileSync(new URL("../chat/ChatPage.css", import.meta.url), "utf8");
const settingsStylesheet = readFileSync(new URL("../settings/SettingsRoute.css", import.meta.url), "utf8");
const memoryStylesheet = readFileSync(new URL("../memory/MemoryRoute.css", import.meta.url), "utf8");

describe("workbench CSS interaction contracts", () => {
  test("keeps document scrolling disabled while desktop surfaces own overflow", () => {
    const documentRule = shellStylesheet.match(/html,\s*body,\s*#root\s*\{([^}]+)\}/);
    const shellRule = shellStylesheet.match(/\.react-desktop-shell\s*\{([^}]+)\}/);
    const sessionRowsRule = shellStylesheet.match(/\.react-session-list__rows\s*\{([^}]+)\}/);
    const conversationRule = chatStylesheet.match(/\.react-conversation-view\s*\{([^}]+)\}/);

    expect(documentRule?.[1]).toContain("width: 100%");
    expect(documentRule?.[1]).toContain("height: 100%");
    expect(documentRule?.[1]).toContain("overflow: hidden");
    expect(shellRule?.[1]).toContain("width: 100%");
    expect(shellRule?.[1]).toContain("height: 100%");
    expect(sessionRowsRule?.[1]).toContain("overflow: auto");
    expect(conversationRule?.[1]).toContain("overflow: auto");
  });

  test("keeps workspace header actions in one fixed right-aligned row", () => {
    const actionsRule = shellStylesheet.match(/\.react-session-workspace__actions\s*\{([^}]+)\}/);
    const buttonRule = shellStylesheet.match(/\.react-session-workspace__actions > button\s*\{([^}]+)\}/);

    expect(actionsRule?.[1]).toContain("width: 64px");
    expect(actionsRule?.[1]).toContain("justify-content: flex-end");
    expect(actionsRule?.[1]).toContain("flex-wrap: nowrap");
    expect(buttonRule?.[1]).toContain("flex: 0 0 32px");
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
    const composerTargetRule = chatStylesheet.match(/\.react-composer-drop-target\s*\{([^}]+)\}/);
    const queueRule = chatStylesheet.match(/\.react-queued-inputs\s*\{([^}]+)\}/);
    const queueListRule = chatStylesheet.match(/\.react-queued-inputs ol\s*\{([^}]+)\}/);

    expect(composerTargetRule?.[1]).toContain("position: relative");
    expect(queueRule?.[1]).toContain("position: absolute");
    expect(queueRule?.[1]).toContain("bottom: calc(100% - 8px)");
    expect(queueRule?.[1]).toContain("max-height: min(160px, 32vh)");
    expect(queueListRule?.[1]).toContain("overflow-y: auto");
  });

  test("keeps execution summaries and tool activity compact without shrinking action controls", () => {
    const timelineTriggerRule = chatStylesheet.match(/\.react-execution-timeline__trigger\s*\{([^}]+)\}/);
    const timelineHeadingRule = chatStylesheet.match(/\.react-execution-timeline__heading\s*\{([^}]+)\}/);
    const timelineSummaryRule = chatStylesheet.match(/\.react-execution-timeline__summary\s*\{([^}]+)\}/);
    const timelineContentRule = chatStylesheet.match(/\.react-execution-timeline__content\s*\{([^}]+)\}/);
    const reasoningRule = chatStylesheet.match(/\.react-execution-reasoning\s*\{([^}]+)\}/);
    const reasoningTriggerRule = chatStylesheet.match(/\.react-execution-reasoning__trigger\s*\{([^}]+)\}/);
    const reasoningPreviewRule = chatStylesheet.match(/\.react-execution-reasoning__preview\s*\{([^}]+)\}/);
    const reasoningContentRule = chatStylesheet.match(/\.react-execution-reasoning__content\s*\{([^}]+)\}/);
    const headerRule = chatStylesheet.match(/\.react-tool-activity__header\s*\{([^}]+)\}/);
    const actionRule = chatStylesheet.match(/\.react-patch-file__copy\s*\{([^}]+)\}/);
    const detailsRule = chatStylesheet.match(/\.react-tool-activity__details\s*\{([^}]+)\}/);
    const previewRule = chatStylesheet.match(/\.react-tool-activity__preview\s*\{([^}]+)\}/);
    const toolTitleRule = chatStylesheet.match(/\.react-tool-activity__copy strong\s*\{([^}]+)\}/);
    const toolChevronRule = chatStylesheet.match(/\.react-tool-activity\[data-open="true"\] \.react-tool-activity__chevron\s*\{([^}]+)\}/);

    expect(timelineTriggerRule?.[1]).toContain("min-height: 40px");
    expect(timelineTriggerRule?.[1]).toContain("padding: 0 0 4px");
    expect(timelineTriggerRule?.[1]).toContain("justify-content: flex-start");
    expect(timelineHeadingRule?.[1]).toContain("display: flex");
    expect(timelineHeadingRule?.[1]).toContain("flex: 1 1 auto");
    expect(timelineSummaryRule?.[1]).toContain("text-overflow: ellipsis");
    expect(timelineSummaryRule?.[1]).toContain("white-space: nowrap");
    expect(timelineContentRule?.[1]).toContain("padding: 4px 0 4px 28px");
    expect(reasoningRule?.[1]).toContain("min-height: 34px");
    expect(reasoningTriggerRule?.[1]).toContain("grid-template-columns: max-content minmax(0, 1fr) max-content");
    expect(reasoningPreviewRule?.[1]).toContain("overflow: hidden");
    expect(reasoningPreviewRule?.[1]).toContain("text-overflow: ellipsis");
    expect(reasoningPreviewRule?.[1]).toContain("white-space: nowrap");
    expect(reasoningContentRule?.[1]).toContain("line-height: 1.6");
    expect(reasoningContentRule?.[1]).not.toContain("max-height");
    expect(headerRule?.[1]).toContain("min-height: 34px");
    expect(headerRule?.[1]).toContain("padding: 2px 0");
    expect(headerRule?.[1]).toContain("display: flex");
    expect(headerRule?.[1]).toContain("justify-content: flex-start");
    expect(actionRule?.[1]).toContain("width: 30px");
    expect(actionRule?.[1]).toContain("height: 30px");
    expect(detailsRule?.[1]).toContain("gap: 4px");
    expect(detailsRule?.[1]).toContain("padding: 0 0 6px 22px");
    expect(previewRule?.[1]).toContain("min-height: 32px");
    expect(previewRule?.[1]).toContain("padding: 6px 10px");
    expect(toolTitleRule?.[1]).toContain("font-size: 12px");
    expect(toolTitleRule?.[1]).toContain("font-weight: 600");
    expect(toolChevronRule?.[1]).toContain("transform: rotate(90deg)");
  });

  test("presents agent form choices as compact selectable cards", () => {
    const formCardRule = chatStylesheet.match(/\.react-agent-ui-form-card\s*\{([^}]+)\}/);
    const choiceRule = chatStylesheet.match(/\.react-agent-ui-form-field__choice\s*\{([^}]+)\}/);
    const selectedRule = chatStylesheet.match(/\.react-agent-ui-form-field__choice:has\(input:checked\)\s*\{([^}]+)\}/);

    expect(formCardRule?.[1]).toContain("border-radius: 14px");
    expect(formCardRule?.[1]).toContain("padding: 18px");
    expect(choiceRule?.[1]).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(choiceRule?.[1]).toContain("min-height: 42px");
    expect(selectedRule?.[1]).toContain("border-color: color-mix(in srgb, var(--color-primary) 68%");
  });

  test("routes appearance controls through shared theme tokens", () => {
    expect(shellStylesheet).toContain("--color-panel:");
    expect(shellStylesheet).toContain("--color-accent: var(--color-primary)");
    expect(shellStylesheet).toContain("font-family: var(--font-ui)");
    expect(shellStylesheet).toContain("background: var(--sidebar-background)");
    expect(settingsStylesheet).toContain(".react-theme-mode-grid");
  });

  test("uses one shared visual authority for menu popover surfaces and items", () => {
    const popoverSurfaceRule = shellStylesheet.match(/\.react-popover-surface\s*\{([^}]+)\}/);
    const popoverItemRule = shellStylesheet.match(/\.react-popover-item\s*\{([^}]+)\}/);

    expect(popoverSurfaceRule?.[1]).toContain("border-radius: 9px");
    expect(popoverSurfaceRule?.[1]).toContain("padding: 6px");
    expect(popoverSurfaceRule?.[1]).toContain("box-shadow: 0 18px 42px rgb(20 20 19 / 14%)");
    expect(popoverItemRule?.[1]).toContain("min-height: 36px");
    expect(popoverItemRule?.[1]).toContain("border-radius: 7px");
    expect(shellStylesheet).toMatch(/\.react-popover-item:focus-visible\s*{[^}]*border-color:\s*var\(--color-primary\);/s);
  });

  test("keeps Profile and Chat charts on the shared Lieflat Porcelain palette", () => {
    expect(shellStylesheet).toContain("--lieflat-porcelain-bg: #f7f2eb");
    expect(shellStylesheet).toContain("--lieflat-porcelain-data: #334eac");
    expect(shellStylesheet).toContain("--lieflat-porcelain-data-2: #7096d1");
    expect(shellStylesheet).toContain("--lieflat-porcelain-faint-data: #bad6eb");
    expect(chatStylesheet).toContain("background: var(--lieflat-porcelain-bg)");
    expect(chatStylesheet).toContain("--lieflat-tone-0: var(--lieflat-porcelain-data)");
    expect(chatStylesheet).toContain("stroke-width: 2.43");
    expect(settingsStylesheet).toContain("background: var(--lieflat-porcelain-bg)");
    expect(settingsStylesheet).toContain("stroke: var(--lieflat-porcelain-data)");
    expect(settingsStylesheet).toContain("stroke-width: 2.52");
  });

  test("keeps route styles with their lazy-loaded owners", () => {
    expect(shellStylesheet).not.toMatch(/\.(?:react-settings|react-memory)-/);
    expect(chatStylesheet).not.toMatch(/\.(?:react-settings|react-memory)-/);
    expect(settingsStylesheet).toContain(".react-settings-layout");
    expect(settingsStylesheet).toContain("@keyframes react-settings-spin");
    expect(memoryStylesheet).toContain(".react-memory-page");
    expect(memoryStylesheet).toContain("@keyframes react-settings-spin");
    expect(shellStylesheet).toContain("@keyframes react-list-enter");
    expect(shellStylesheet).toContain("@keyframes react-session-tab-spin");
  });
});
