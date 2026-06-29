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
    expect(host.querySelector(".n-space.desktop-tool-activities-list")).not.toBeNull();
    expect(Array.from(host.querySelectorAll(".desktop-tool-activity")).map((activity) => activity.getAttribute("data-desktop-vue-island"))).toEqual([
      "tool-activity",
      "tool-activity",
    ]);
    expect(Array.from(host.querySelectorAll(".desktop-tool-activity-title")).map((title) => title.textContent)).toEqual([
      "web_search",
      "web_search",
    ]);
    expect(Array.from(host.querySelectorAll(".desktop-tool-activity-kind")).map((kind) => kind.textContent)).toEqual([
      "Tool",
      "Tool",
    ]);
    expect(Array.from(host.querySelectorAll(".desktop-tool-activity-status-label")).map((status) => status.textContent)).toEqual([
      "Completed",
      "Pending",
    ]);
    expect(host.textContent).not.toContain("{\"query\":\"tinybot\"}");
    expect(host.textContent).not.toContain("Found docs");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
