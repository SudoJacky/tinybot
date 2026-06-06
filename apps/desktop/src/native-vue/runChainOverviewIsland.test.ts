// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopRunChainItem } from "../desktopRunChainInspector";
import { mountRunChainOverviewIsland } from "./runChainOverviewIsland";

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
    detailSections: [],
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
    detailSections: [],
  },
];

describe("run chain overview Vue island", () => {
  test("renders switchable Naive UI overview controls and forwards shell actions", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];

    const mounted = mountRunChainOverviewIsland(host, {
      items: runChainItems,
      onAction: (action) => actions.push(`${action.type}:${action.value ?? ""}`),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("run-chain-overview");
    expect(host.className).toContain("desktop-run-chain-overview");
    expect(host.getAttribute("aria-label")).toBe("Run Chain");
    expect(host.querySelector("h2")?.textContent).toBe("Run Chain");
    expect(host.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("Gateway: Connected");
    expect(host.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("Run: Running");
    expect(host.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("2 items");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("context");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="files"]')?.click();
    await Promise.resolve();
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="files"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("files");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Open Workspace");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-summary="items"]')?.click();
    await Promise.resolve();
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="tasks"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("tasks");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Current Run");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Tool: Loaded project files");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="pin"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="close"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-action="Open Task Center"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-action="New Run Chain Item"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-feed-item="tool:1"]')?.click();
    await nextTick();

    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="pin"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(actions).toEqual([
      "tab:files",
      "summary:items",
      "pin:true",
      "close:",
      "open-task-center:",
      "new-item:",
      "feed:tool:1",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
