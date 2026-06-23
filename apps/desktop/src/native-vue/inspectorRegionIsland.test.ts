// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopRunChainItem } from "../desktopRunChainInspector";
import type { DesktopWorkLensProjection } from "../desktopWorkLens";
import { mountInspectorRegionIsland } from "./inspectorRegionIsland";

const runChainItems: DesktopRunChainItem[] = [
  {
    key: "tool:1",
    kind: "tool",
    title: "Tool",
    preview: "Loaded project files",
    status: "running",
    inspectable: true,
    detailTitle: "Tool",
    detailSubtitle: "Tool detail",
    detailSections: [{ type: "text", label: "Command", text: "read_file" }],
  },
  {
    key: "file:1",
    kind: "file",
    title: "File",
    preview: "Updated desktop shell",
    status: "completed",
    inspectable: true,
    detailTitle: "File",
    detailSubtitle: "File detail",
    detailSections: [{ type: "text", label: "Path", text: "apps/desktop/src/desktopWorkbenchShell.ts" }],
  },
];

const workLens: DesktopWorkLensProjection = {
  mode: "ready",
  kind: "knowledgeJob",
  id: "knowledge:doc-1:index",
  title: "Index Desktop UX Notes",
  state: "failed",
  stateReason: "Embedding provider returned 429",
  canonicalRoute: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
  fallbackReason: "",
  relatedResources: [],
  outputs: [],
  nextActions: [
    { id: "retry", label: "Retry" },
    { id: "copyDiagnostics", label: "Copy diagnostics", diagnosticText: "HTTP 429" },
  ],
  sections: [{
    id: "happening",
    title: "What is happening?",
    rows: [{ label: "Status", value: "failed" }],
  }],
};

describe("inspector region Vue island", () => {
  test("renders Run Chain overview with Work Lens and forwards actions", () => {
    const host = document.createElement("aside");
    const runActions: string[] = [];
    const lensActions: string[] = [];
    const copied: string[] = [];

    const mounted = mountInspectorRegionIsland(host, {
      runChainItems,
      workLens,
      onRunChainAction: (action) => runActions.push(`${action.type}:${"value" in action ? action.value : ""}`),
      onWorkLensAction: (event) => lensActions.push(event.action),
      copyText: (text) => {
        copied.push(text);
      },
    });

    expect(host.className).toBe("desktop-inspector-content");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("inspector-region");
    expect(host.querySelector(".desktop-run-chain-overview")?.getAttribute("data-desktop-vue-island")).toBe("run-chain-overview");
    expect(host.querySelector(".desktop-run-chain-overview")?.textContent).toContain("Activity");
    expect(host.querySelector(".desktop-work-lens")?.getAttribute("data-desktop-vue-island")).toBe("work-lens");
    expect(host.querySelector(".desktop-work-lens")?.getAttribute("data-desktop-work-lens-id")).toBe("knowledge:doc-1:index");
    expect(host.querySelector(".desktop-work-lens")?.textContent).toContain("Index Desktop UX Notes");
    expect(host.querySelector(".desktop-run-chain-inspector")).toBeNull();

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="pin"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="tasks"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-work-lens-action="retry"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-work-lens-action="copyDiagnostics"]')?.click();

    expect(runActions).toEqual(["pin:true", "tab:tasks"]);
    expect(lensActions).toEqual(["retry", "copyDiagnostics"]);
    expect(copied).toEqual(["HTTP 429"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders Run Chain inspector when no Work Lens is active", async () => {
    const host = document.createElement("aside");
    const selected: string[] = [];

    mountInspectorRegionIsland(host, {
      runChainItems,
      selectedRunChainItemKey: "tool:1",
      onRunChainItemSelected: (item) => selected.push(item.key),
    });

    expect(host.querySelector(".desktop-work-lens")).toBeNull();
    expect(host.querySelector(".desktop-run-chain-overview")?.getAttribute("data-desktop-vue-island")).toBe("run-chain-overview");
    expect(host.querySelector(".desktop-run-chain-inspector")?.getAttribute("data-desktop-vue-island")).toBe("run-chain-inspector");
    expect(host.querySelector(".desktop-run-chain-inspector")?.textContent).toContain("Run-chain inspector");
    expect(host.querySelector('[data-desktop-run-chain-item="tool:1"]')?.getAttribute("aria-selected")).toBe("true");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-item="file:1"]')?.click();
    await nextTick();

    expect(host.querySelector('[data-desktop-run-chain-item="file:1"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-detail")?.textContent).toContain("Path: apps/desktop/src/desktopWorkbenchShell.ts");
    expect(selected).toEqual(["file:1"]);
  });
});
