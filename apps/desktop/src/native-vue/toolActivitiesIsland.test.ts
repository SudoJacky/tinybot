// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountToolActivitiesIsland } from "./toolActivitiesIsland";

describe("tool activities Vue island", () => {
  test("renders multiple tool activities", () => {
    const host = document.createElement("div");

    const mounted = mountToolActivitiesIsland(host, {
      activities: [
        {
          argsText: "{\"query\":\"tinybot\"}",
          approvalStatus: "approved",
          id: "tool-1",
          kind: "call",
          name: "web_search",
          responseText: "",
        },
        {
          argsText: "",
          approvalStatus: "",
          id: "tool-2",
          kind: "result",
          name: "web_search",
          responseText: "Found docs",
        },
      ],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("tool-activities");
    expect(host.className).toBe("desktop-tool-activities");
    expect(Array.from(host.querySelectorAll(".desktop-tool-activity-title")).map((title) => title.textContent)).toEqual([
      "web_search",
      "web_search",
    ]);
    expect(Array.from(host.querySelectorAll(".desktop-tool-activity-badge")).map((badge) => badge.textContent)).toEqual([
      "Approved",
      "Call",
      "Result",
    ]);
    expect(host.querySelector('[data-desktop-tool-activity-id="tool-1"] .desktop-tool-activity-section-call .desktop-tool-activity-pre')?.textContent).toBe("{\"query\":\"tinybot\"}");
    expect(host.querySelector('[data-desktop-tool-activity-id="tool-2"] .desktop-tool-activity-section-response .desktop-tool-activity-pre')?.textContent).toBe("Found docs");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
