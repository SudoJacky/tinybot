// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSharedSidebarLinkIsland } from "./sharedSidebarLinkIsland";

describe("shared sidebar link Vue island", () => {
  test("renders shared sidebar link attributes", () => {
    const host = document.createElement("a");

    const mounted = mountSharedSidebarLinkIsland(host, {
      href: "/docs",
      icon: "book",
      id: "docs",
      kind: "link",
      label: "Docs",
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("shared-sidebar-link");
    expect(host.className).toBe("desktop-workbench-link");
    expect(host.getAttribute("href")).toBe("/docs");
    expect(host.getAttribute("data-sidebar-item-id")).toBe("docs");
    expect(host.getAttribute("data-sidebar-item-kind")).toBe("link");
    expect(host.getAttribute("data-sidebar-href")).toBe("/docs");
    expect(host.getAttribute("data-sidebar-icon")).toBe("book");
    expect(host.textContent).toBe("Docs");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("omits optional icon when absent", () => {
    const host = document.createElement("a");

    mountSharedSidebarLinkIsland(host, {
      href: "/workspace",
      id: "workspace",
      kind: "link",
      label: "Workspace",
    });

    expect(host.getAttribute("href")).toBe("/workspace");
    expect(host.hasAttribute("data-sidebar-icon")).toBe(false);
    expect(host.textContent).toBe("Workspace");
  });
});
