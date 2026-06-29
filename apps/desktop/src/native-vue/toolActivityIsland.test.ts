// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountToolActivityIsland } from "./toolActivityIsland";

describe("tool activity Vue island", () => {
  test("renders a compact clickable status row without inline call and response bodies", () => {
    const host = document.createElement("div");
    const opened: unknown[] = [];
    host.addEventListener("desktop-tool-detail-open", (event) => {
      opened.push((event as CustomEvent).detail);
    });

    const mounted = mountToolActivityIsland(host, {
      argsText: "{\"query\":\"tinybot\"}",
      approvalStatus: "approved",
      id: "tool-1",
      kind: "call",
      name: "web_search",
      responseText: "Found docs",
      status: "success",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("tool-activity");
    expect(host.className).toBe("desktop-tool-activity");
    expect(host.getAttribute("data-desktop-tool-activity-kind")).toBe("call");
    expect(host.getAttribute("data-desktop-tool-activity-id")).toBe("tool-1");
    expect(host.getAttribute("data-desktop-tool-status")).toBe("completed");
    expect(host.querySelector(".desktop-tool-activity-row")?.getAttribute("type")).toBe("button");
    expect(host.querySelector(".desktop-tool-activity-row")?.getAttribute("aria-label")).toBe("Open web_search tool details, Completed");
    expect(host.querySelector(".desktop-tool-activity-title")?.textContent).toBe("web_search");
    expect(host.querySelector(".desktop-tool-activity-kind")?.textContent).toBe("Tool");
    expect(host.querySelector(".desktop-tool-activity-status-label")?.textContent).toBe("Completed");
    expect(host.querySelector(".desktop-tool-activity-status-dot")?.getAttribute("data-tool-status-tone")).toBe("success");
    expect(host.querySelector(".desktop-tool-activity-body")).toBeNull();
    expect(host.textContent).not.toContain("{\"query\":\"tinybot\"}");
    expect(host.textContent).not.toContain("Found docs");
    host.querySelector<HTMLButtonElement>(".desktop-tool-activity-row")?.click();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      activity: {
        argsText: "{\"query\":\"tinybot\"}",
        id: "tool-1",
        name: "web_search",
        responseText: "Found docs",
        status: "success",
      },
    });

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("dispatches run-chain inspection when opening a tool row", () => {
    const host = document.createElement("div");
    const inspected: string[] = [];
    host.addEventListener("desktop-run-chain-inspect", (event) => {
      inspected.push((event as CustomEvent).detail.itemKey);
    });
    const longArgs = JSON.stringify({ query: "tinybot", context: "x".repeat(180) });

    mountToolActivityIsland(host, {
      argsText: longArgs,
      approvalStatus: "",
      id: "tool-1",
      kind: "call",
      name: "web_search",
      responseText: "",
      runChainItemKey: "assistant-1:tool-call:tool-1",
    });

    expect(host.getAttribute("data-desktop-run-chain-item-key")).toBe("assistant-1:tool-call:tool-1");
    expect(host.textContent).not.toContain(longArgs);

    host.querySelector<HTMLButtonElement>(".desktop-tool-activity-row")?.click();
    expect(inspected).toEqual(["assistant-1:tool-call:tool-1"]);
  });

  test("renders pending approvals as an inline approval card", () => {
    const host = document.createElement("div");
    const inspected: string[] = [];
    const approvals: unknown[] = [];
    host.addEventListener("desktop-run-chain-inspect", (event) => {
      inspected.push((event as CustomEvent).detail.itemKey);
    });
    host.addEventListener("desktop-tool-approval-action", (event) => {
      approvals.push((event as CustomEvent).detail);
    });

    mountToolActivityIsland(host, {
      approvalId: "approval-1",
      argsText: "node scripts/build-index.mjs",
      approvalStatus: "approval_required",
      id: "call-shell",
      kind: "call",
      name: "shell",
      responseText: "",
      runChainItemKey: "assistant-1:call-shell",
      sessionKey: "WebSocket:chat-1",
    });

    const card = host.querySelector(".desktop-tool-approval-card");
    expect(host.getAttribute("data-desktop-approval-status")).toBe("approval_required");
    expect(host.getAttribute("data-desktop-tool-status")).toBe("blocked");
    expect(host.querySelector(".desktop-tool-activity-status-label")?.textContent).toBe("Pending approval");
    expect(host.querySelector(".desktop-tool-activity-status-dot")?.getAttribute("data-tool-status-tone")).toBe("pending");
    expect(card?.getAttribute("role")).toBe("group");
    expect(card?.getAttribute("aria-label")).toBe("Approval required for shell");
    expect(card?.getAttribute("data-desktop-chat-region")).toBe("approval-card");
    expect(card?.textContent).toContain("Approval required");
    expect(card?.textContent).toContain("shell");
    expect(card?.textContent).toContain("node scripts/build-index.mjs");
    expect(Array.from(card?.querySelectorAll(".desktop-tool-approval-action") ?? []).map((action) => action.textContent)).toEqual([
      "Approve once",
      "Allow session",
      "Deny",
      "Review details",
    ]);

    card?.querySelector('[data-desktop-approval-action="approveOnce"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    card?.querySelector('[data-desktop-approval-action="approveSession"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    card?.querySelector('[data-desktop-approval-action="deny"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    card?.querySelector('[data-desktop-approval-action="review"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(approvals).toEqual([
      { action: "approveOnce", approvalId: "approval-1", runChainItemKey: "assistant-1:call-shell", sessionKey: "WebSocket:chat-1", toolActivityId: "call-shell", toolName: "shell" },
      { action: "approveSession", approvalId: "approval-1", runChainItemKey: "assistant-1:call-shell", sessionKey: "WebSocket:chat-1", toolActivityId: "call-shell", toolName: "shell" },
      { action: "deny", approvalId: "approval-1", runChainItemKey: "assistant-1:call-shell", sessionKey: "WebSocket:chat-1", toolActivityId: "call-shell", toolName: "shell" },
    ]);
    expect(inspected).toEqual(["assistant-1:call-shell"]);
  });

  test("renders execution status as a distinct timeline state", () => {
    const host = document.createElement("div");

    mountToolActivityIsland(host, {
      argsText: "{\"command\":\"npm test\"}",
      approvalStatus: "",
      id: "tool-running",
      kind: "call",
      name: "shell",
      responseText: "",
      status: "running",
    });

    expect(host.getAttribute("data-desktop-tool-activity-status")).toBe("running");
    expect(host.querySelector(".desktop-tool-activity-row")?.getAttribute("aria-label")).toBe("Open shell tool details, Running");
    expect(host.querySelector(".desktop-tool-activity-status-label")?.textContent).toBe("Running");
    expect(host.querySelector(".desktop-tool-activity-status-dot")?.getAttribute("data-tool-status-tone")).toBe("running");
  });

  test("renders empty body for activity without details", () => {
    const host = document.createElement("div");

    mountToolActivityIsland(host, {
      argsText: "",
      approvalStatus: "",
      id: "",
      kind: "result",
      name: "",
      responseText: "",
    });

    expect(host.getAttribute("data-desktop-tool-activity-id")).toBeNull();
    expect(host.querySelector(".desktop-tool-activity-title")?.textContent).toBe("unknown");
    expect(host.querySelector(".desktop-tool-activity-kind")?.textContent).toBe("Tool");
    expect(host.querySelector(".desktop-tool-activity-status-label")?.textContent).toBe("Pending");
    expect(host.querySelector(".desktop-tool-activity-body")).toBeNull();
  });
});
