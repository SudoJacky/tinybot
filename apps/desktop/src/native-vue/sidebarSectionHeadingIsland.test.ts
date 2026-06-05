// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSidebarSectionHeadingIsland } from "./sidebarSectionHeadingIsland";

describe("sidebar section heading Vue island", () => {
  test("renders heading label and optional action", () => {
    const host = document.createElement("div");

    const mounted = mountSidebarSectionHeadingIsland(host, {
      title: "Workspaces",
      action: "+",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("sidebar-section-heading");
    expect(host.className).toContain("desktop-sidebar-section-heading");
    expect(host.querySelector("h2")?.textContent).toBe("Workspaces");
    const action = host.querySelector<HTMLButtonElement>(".desktop-sidebar-section-action");
    expect(action?.getAttribute("type")).toBe("button");
    expect(action?.getAttribute("aria-label")).toBe("Workspaces action");
    expect(action?.textContent).toBe("+");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders heading without action", () => {
    const host = document.createElement("div");

    const mounted = mountSidebarSectionHeadingIsland(host, {
      title: "Recent chats",
    });

    expect(host.querySelector("h2")?.textContent).toBe("Recent chats");
    expect(host.querySelector(".desktop-sidebar-section-action")).toBeNull();

    mounted.unmount();
  });
});
