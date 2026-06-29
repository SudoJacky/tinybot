// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountDesktopTaskStatusSurfaceIsland } from "./desktopTaskStatusSurfaceIsland";

describe("desktop task status surface Vue island", () => {
  test("renders a Naive UI status surface shell with the sidebar sentinel", () => {
    const host = document.createElement("aside");

    const mounted = mountDesktopTaskStatusSurfaceIsland(host);

    expect(host.className).toBe("desktop-task-status-surface");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("desktop-task-status-surface");
    expect(host.getAttribute("data-desktop-task-status-surface")).toBe("sidebar");
    expect(host.getAttribute("aria-label")).toBe("Desktop task status");
    expect(host.querySelector(".n-card.desktop-task-status-surface-card")).not.toBeNull();

    const sentinel = host.querySelector<HTMLElement>(".desktop-task-status-surface-sentinel");
    expect(sentinel?.getAttribute("aria-hidden")).toBe("true");
    expect(sentinel?.hidden).toBe(true);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
