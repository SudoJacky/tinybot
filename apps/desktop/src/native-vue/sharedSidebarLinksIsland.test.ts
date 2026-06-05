// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSharedSidebarLinksIsland } from "./sharedSidebarLinksIsland";

describe("shared sidebar links Vue island", () => {
  test("renders sidebar link group with item attributes", () => {
    const host = document.createElement("section");

    const mounted = mountSharedSidebarLinksIsland(host, {
      label: "Resources",
      items: [
        {
          href: "/docs",
          icon: "book",
          id: "docs",
          kind: "link",
          label: "Docs",
        },
        {
          href: "/workspace",
          id: "workspace",
          kind: "link",
          label: "Workspace",
        },
      ],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("shared-sidebar-links");
    expect(host.className).toBe("desktop-workbench-section");
    expect(host.querySelector("h2")?.textContent).toBe("Resources");

    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>(".desktop-workbench-link"));
    expect(links.map((link) => link.textContent)).toEqual(["Docs", "Workspace"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/docs", "/workspace"]);
    expect(links[0]?.getAttribute("data-sidebar-item-id")).toBe("docs");
    expect(links[0]?.getAttribute("data-sidebar-item-kind")).toBe("link");
    expect(links[0]?.getAttribute("data-sidebar-href")).toBe("/docs");
    expect(links[0]?.getAttribute("data-sidebar-icon")).toBe("book");
    expect(links[1]?.hasAttribute("data-sidebar-icon")).toBe(false);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders fallback title when group label is missing", () => {
    const host = document.createElement("section");

    mountSharedSidebarLinksIsland(host, {
      items: [],
    });

    expect(host.querySelector("h2")?.textContent).toBe("Resources");
    expect(host.querySelector(".desktop-workbench-link")).toBeNull();
  });
});
