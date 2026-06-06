// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountTaskStateBadgeIsland } from "./taskStateBadgeIsland";

describe("task state badge Vue island", () => {
  test("renders task state badge attributes and label", () => {
    const host = document.createElement("span");

    const mounted = mountTaskStateBadgeIsland(host, {
      state: "failed",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("task-state-badge");
    expect(host.className).toContain("desktop-task-state-badge");
    expect(host.getAttribute("data-desktop-task-state-badge")).toBe("failed");
    expect(host.textContent).toBe("failed");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders completed task state", () => {
    const host = document.createElement("span");

    mountTaskStateBadgeIsland(host, {
      state: "completed",
    });

    expect(host.getAttribute("data-desktop-task-state-badge")).toBe("completed");
    expect(host.textContent).toBe("completed");
  });
});
