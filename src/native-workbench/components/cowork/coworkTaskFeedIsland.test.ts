// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopCoworkTaskCenterItem } from "../../cowork/desktopCowork";
import { mountCoworkTaskFeedIsland } from "./coworkTaskFeedIsland";

const items: DesktopCoworkTaskCenterItem[] = Array.from({ length: 25 }, (_, index) => ({
  id: `task-${index + 1}`,
  title: `Task ${index + 1}`,
  status: index === 0 ? "blocked" : index % 2 === 0 ? "completed" : "running",
  tone: index === 0 ? "attention" : index % 2 === 0 ? "complete" : "normal",
  detail: index === 0 ? "1 blocker" : `Detail ${index + 1}`,
  destination: {
    module: "cowork",
    sessionId: "cowork-1",
    selection: { type: "task", id: `task-${index + 1}` },
  },
}));

describe("cowork task feed Vue island", () => {
  test("renders bounded task status rows and cockpit totals", () => {
    const host = document.createElement("section");

    const mounted = mountCoworkTaskFeedIsland(host, {
      items,
      totals: {
        agents: 3,
        tasks: 25,
        mailbox: 2,
        artifacts: 4,
      },
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-task-feed");
    expect(host.className).toContain("desktop-cowork-task-feed");
    expect(host.querySelector("h2")?.textContent).toBe("Task feed");
    expect(host.querySelectorAll(".desktop-cowork-task-feed-row")).toHaveLength(20);
    expect(host.querySelector(".desktop-cowork-task-feed-row")?.textContent).toContain("Task 1: blocked / 1 blocker");
    expect(host.querySelector(".desktop-cowork-task-feed")?.textContent ?? host.textContent).not.toContain("Task 21");
    expect(host.querySelector(".desktop-cowork-limit-status")?.textContent).toBe("Showing 20 of 25 task status items");
    expect(host.textContent).toContain("3 agents / 25 tasks / 2 mailbox / 4 artifacts");
    expect(host.querySelector('[data-desktop-cowork-task-tone="attention"]')?.textContent).toContain("blocked");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders an empty task feed with zero totals", () => {
    const host = document.createElement("section");

    const mounted = mountCoworkTaskFeedIsland(host, {
      items: [],
      totals: {
        agents: 0,
        tasks: 0,
        mailbox: 0,
        artifacts: 0,
      },
    });

    expect(host.querySelector(".desktop-cowork-limit-status")?.textContent).toBe("Showing 0 of 0 task status items");
    expect(host.textContent).toContain("0 agents / 0 tasks / 0 mailbox / 0 artifacts");
    expect(host.textContent).toContain("No task status items.");

    mounted.unmount();
  });
});
