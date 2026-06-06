// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountToolActivityIsland } from "./toolActivityIsland";

describe("tool activity Vue island", () => {
  test("renders summary badges and call/response sections", () => {
    const host = document.createElement("details");

    const mounted = mountToolActivityIsland(host, {
      argsText: "{\"query\":\"tinybot\"}",
      approvalStatus: "approved",
      id: "tool-1",
      kind: "call",
      name: "web_search",
      responseText: "Found docs",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("tool-activity");
    expect(host.className).toBe("desktop-tool-activity");
    expect(host.getAttribute("data-desktop-tool-activity-kind")).toBe("call");
    expect(host.getAttribute("data-desktop-tool-activity-id")).toBe("tool-1");
    expect(host.querySelector(".desktop-tool-activity-title")?.textContent).toBe("web_search");
    expect(host.querySelector(".desktop-tool-activity-preview")?.textContent).toBe("{\"query\":\"tinybot\"}");
    expect(Array.from(host.querySelectorAll(".desktop-tool-activity-badge")).map((badge) => badge.textContent)).toEqual(["Approved", "Call"]);
    expect(host.querySelector(".desktop-tool-activity-section-call .desktop-tool-activity-pre")?.textContent).toBe("{\"query\":\"tinybot\"}");
    expect(host.querySelector(".desktop-tool-activity-section-response .desktop-tool-activity-pre")?.textContent).toBe("Found docs");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("collapses long tool content and dispatches run-chain inspection", () => {
    const host = document.createElement("details");
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

    const nestedDetails = host.querySelector(".desktop-tool-activity-content-details");
    expect(host.getAttribute("data-desktop-run-chain-item-key")).toBe("assistant-1:tool-call:tool-1");
    expect(nestedDetails?.querySelector(".desktop-tool-activity-content-preview")?.textContent).toContain("tinybot");
    expect(nestedDetails?.querySelector(".desktop-tool-activity-pre")?.textContent).toBe(longArgs);

    host.querySelector<HTMLElement>(".desktop-tool-activity-summary")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(inspected).toEqual(["assistant-1:tool-call:tool-1"]);
  });

  test("renders empty body for activity without details", () => {
    const host = document.createElement("details");

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
    expect(host.querySelector(".desktop-tool-activity-preview")?.textContent).toBe("No details");
    expect(host.querySelector(".desktop-tool-activity-badge")?.textContent).toBe("Result");
    expect(host.querySelector(".desktop-tool-activity-empty")?.textContent).toBe("No arguments or response.");
  });
});
