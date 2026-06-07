// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { buildDesktopTaskCenterItems } from "../desktopTaskCenter";
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
      onAction: (action) => actions.push(`${action.type}:${"value" in action ? action.value : ""}`),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("run-chain-overview");
    expect(host.className).toContain("desktop-run-chain-overview");
    expect(host.getAttribute("aria-label")).toBe("Activity inspector");
    expect(host.querySelector("h2")?.textContent).toBe("Activity");
    expect(host.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("Gateway");
    expect(host.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("Running");
    expect(host.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("2 items");
    expect(host.querySelector('[data-desktop-run-chain-summary="gateway"]')?.getAttribute("aria-label")).toBe("Gateway: Connected");
    expect(host.querySelector('[data-desktop-run-chain-summary="gateway"]')?.getAttribute("title")).toBe("Gateway: Connected");
    expect(host.querySelector('[data-desktop-run-chain-summary="run"]')?.getAttribute("aria-label")).toBe("Run: Running");
    expect(host.querySelector('[data-desktop-run-chain-summary="gateway"]')?.className).toContain("desktop-run-chain-status-pill");
    expect(host.querySelector('[data-desktop-run-chain-summary="gateway"]')?.getAttribute("data-status-tone")).toBe("connected");
    expect(host.querySelector('[data-desktop-run-chain-summary="run"]')?.getAttribute("data-status-tone")).toBe("muted");
    expect(host.querySelector(".desktop-run-chain-status-dot")).not.toBeNull();
    expect([...host.querySelectorAll('[data-desktop-run-chain-tab]')].map((node) => node.textContent)).toEqual([
      "Context",
      "Files",
      "Tasks",
      "Approvals",
      "Activity",
    ]);
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("context");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="files"]')?.click();
    await Promise.resolve();
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="files"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("files");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Open Files");
    expect(host.querySelector(".desktop-run-chain-panel a")?.getAttribute("href")).toBe("/files");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-summary="items"]')?.click();
    await Promise.resolve();
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="activity"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("activity");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Activity Feed");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Tool: Loaded project files");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="tasks"]')?.click();
    await Promise.resolve();
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="tasks"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("tasks");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Tasks");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Task center: Available");
    expect(host.querySelector(".desktop-run-chain-new-item")?.getAttribute("data-button-variant")).toBe("secondary");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="approvals"]')?.click();
    await Promise.resolve();
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="approvals"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("approvals");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Approvals");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("No pending approvals");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="activity"]')?.click();
    await Promise.resolve();
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="activity"]')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("activity");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Activity Feed");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Tool: Loaded project files");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="pin"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="close"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-action="Open Task Center"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="tasks"]')?.click();
    await Promise.resolve();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-action="New Activity Item"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="activity"]')?.click();
    await Promise.resolve();
    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-feed-item="tool:1"]')?.click();
    await nextTick();

    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="pin"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="pin"]')?.getAttribute("aria-label")).toBe("Pin panel");
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="close"]')?.getAttribute("title")).toBe("Close panel");
    expect(host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-control="pin"]')?.getAttribute("data-button-variant")).toBe("ghost");
    expect(host.querySelector('[data-desktop-run-chain-action="Open Task Center"]')?.getAttribute("data-button-variant")).toBe("primary");
    expect(actions).toEqual([
      "tab:files",
      "summary:items",
      "tab:tasks",
      "tab:approvals",
      "tab:activity",
      "pin:true",
      "close:",
      "open-task-center:",
      "tab:tasks",
      "new-item:",
      "tab:activity",
      "feed:tool:1",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("shows a light empty state when the Tasks tab has no chain items", async () => {
    const host = document.createElement("section");

    const mounted = mountRunChainOverviewIsland(host, {
      items: [],
    });

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="tasks"]')?.click();
    await nextTick();

    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("No chain items yet.");
    expect(host.querySelector(".desktop-run-chain-empty-state")).not.toBeNull();
    expect(host.querySelectorAll('[data-desktop-run-chain-action="New Activity Item"]')).toHaveLength(1);

    mounted.unmount();
  });

  test("renders live approval queue from Task Center items", async () => {
    const host = document.createElement("section");
    const taskItems = buildDesktopTaskCenterItems({
      approvals: [
        {
          id: "approval-1",
          title: "Approve shell command",
          status: "requires_approval",
          detail: "Shell command approval required",
          canonical: { module: "approvals", entityId: "approval-1", href: "/chat/chat-1" },
          approval: { approvalId: "approval-1", sessionKey: "WebSocket:chat-1" },
        },
      ],
    });

    const mounted = mountRunChainOverviewIsland(host, {
      items: [],
      taskItems,
    });

    expect(host.querySelector(".desktop-run-chain-summary-strip")?.textContent).toContain("1 approval");
    expect(host.querySelector('[data-desktop-run-chain-summary="approvals"]')?.getAttribute("data-status-tone")).toBe("attention");

    host.querySelector<HTMLButtonElement>('[data-desktop-run-chain-tab="approvals"]')?.click();
    await nextTick();

    expect(host.querySelector(".desktop-run-chain-panel")?.getAttribute("data-desktop-run-chain-panel")).toBe("approvals");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Pending: 1");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Queue: 1 pending approval");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Approve shell command");
    expect(host.querySelector(".desktop-run-chain-panel")?.textContent).toContain("Shell command approval required");
    expect(host.querySelector('[data-desktop-run-chain-approval-item="approval-1"]')).not.toBeNull();

    mounted.unmount();
  });
});
