// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountSidebarWorkspaceListIsland } from "./sidebarWorkspaceListIsland";

describe("sidebar workspace list Vue island", () => {
  test("renders workspace heading and rows with stable navigation contract", () => {
    const host = document.createElement("section");

    const mounted = mountSidebarWorkspaceListIsland(host, {
      rows: [
        { active: true, entityId: "tinybot", meta: "Active session", title: "tinybot" },
        { active: false, entityId: "archive", meta: "May 20", title: "archive" },
      ],
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("sidebar-workspace-list");
    expect(host.className).toBe("desktop-sidebar-list-section desktop-sidebar-list-section-workspaces");
    expect(host.querySelector(".desktop-sidebar-section-heading h2")?.textContent).toBe("Workspaces");
    expect(host.querySelector(".desktop-sidebar-section-action")?.textContent).toBe("+");

    const list = host.querySelector(".desktop-workspace-list");
    expect(list?.getAttribute("role")).toBe("list");
    const rows = Array.from(host.querySelectorAll<HTMLAnchorElement>(".desktop-sidebar-row"));
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(["/files", "/files"]);
    expect(rows.map((row) => row.getAttribute("data-sidebar-row-kind"))).toEqual(["folder", "folder"]);
    expect(rows.map((row) => row.getAttribute("data-desktop-entity-module"))).toEqual(["files", "files"]);
    expect(rows.map((row) => row.getAttribute("data-desktop-entity-id"))).toEqual(["tinybot", "archive"]);
    expect(rows.map((row) => row.getAttribute("data-active"))).toEqual(["true", "false"]);
    expect(rows[0]?.querySelector(".desktop-sidebar-row-label")?.textContent).toBe("tinybot");
    expect(rows[0]?.querySelector(".desktop-sidebar-row-meta")?.textContent).toBe("Active session");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
