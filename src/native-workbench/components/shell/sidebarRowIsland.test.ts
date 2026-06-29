// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSidebarRowIsland } from "./sidebarRowIsland";

describe("sidebar row Vue island", () => {
  test("renders an active workspace row with entity metadata", () => {
    const host = document.createElement("a");

    const mounted = mountSidebarRowIsland(host, {
      active: true,
      entityId: "Personal",
      entityModule: "workspace",
      href: "#",
      kind: "folder",
      meta: "Local folder",
      title: "Personal",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("sidebar-row");
    expect(host.className).toBe("desktop-sidebar-row");
    expect(host.getAttribute("href")).toBe("#");
    expect(host.getAttribute("data-active")).toBe("true");
    expect(host.getAttribute("data-sidebar-row-kind")).toBe("folder");
    expect(host.getAttribute("data-desktop-entity-module")).toBe("workspace");
    expect(host.getAttribute("data-desktop-entity-id")).toBe("Personal");
    expect(host.querySelector(".desktop-sidebar-row-label")?.textContent).toBe("Personal");
    expect(host.querySelector(".desktop-sidebar-row-meta")?.textContent).toBe("Local folder");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders an inactive chat row without optional entity metadata", () => {
    const host = document.createElement("a");

    mountSidebarRowIsland(host, {
      active: false,
      href: "#",
      kind: "chat",
      meta: "No activity yet",
      title: "Planning",
    });

    expect(host.getAttribute("data-active")).toBe("false");
    expect(host.getAttribute("data-sidebar-row-kind")).toBe("chat");
    expect(host.hasAttribute("data-desktop-entity-module")).toBe(false);
    expect(host.hasAttribute("data-desktop-entity-id")).toBe(false);
    expect(host.querySelector(".desktop-sidebar-row-label")?.textContent).toBe("Planning");
    expect(host.querySelector(".desktop-sidebar-row-meta")?.textContent).toBe("No activity yet");
  });
});
