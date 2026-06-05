// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSidebarActionsIsland } from "./sidebarActionsIsland";

describe("sidebar actions Vue island", () => {
  test("renders new chat link and session search input", () => {
    const host = document.createElement("section");

    const mounted = mountSidebarActionsIsland(host);

    expect(host.getAttribute("data-desktop-vue-island")).toBe("sidebar-actions");
    expect(host.className).toContain("desktop-sidebar-actions");

    const newChat = host.querySelector<HTMLAnchorElement>(".desktop-sidebar-primary-action");
    expect(newChat?.getAttribute("href")).toBe("/chat/new");
    expect(newChat?.getAttribute("aria-label")).toBe("New chat");
    expect(newChat?.textContent).toContain("New chat");
    expect(newChat?.querySelector(".desktop-sidebar-shortcut")?.textContent).toBe("Ctrl N");

    const search = host.querySelector<HTMLInputElement>(".desktop-sidebar-search");
    expect(search?.getAttribute("type")).toBe("search");
    expect(search?.getAttribute("aria-label")).toBe("Search");
    expect(search?.getAttribute("placeholder")).toBe("Search");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
