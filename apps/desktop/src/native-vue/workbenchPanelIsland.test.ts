// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountWorkbenchPanelIsland } from "./workbenchPanelIsland";

describe("workbench panel Vue island", () => {
  test("renders a panel shell while preserving the provided content node", () => {
    const host = document.createElement("section");
    const content = document.createElement("div");
    content.className = "desktop-sidebar-content";
    content.textContent = "Session list";

    const mounted = mountWorkbenchPanelIsland(host, {
      content,
      region: "sidebar",
      size: 260,
      visible: true,
    });

    expect(host.className).toBe("desktop-workbench-sidebar");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("workbench-panel");
    expect(host.getAttribute("data-workbench-region")).toBe("sidebar");
    expect(host.getAttribute("data-visible")).toBe("true");
    expect(host.style.getPropertyValue("--region-size")).toBe("260px");
    expect(host.querySelector(".n-card.desktop-workbench-panel")).not.toBeNull();
    expect(host.querySelector(".desktop-workbench-panel-content")?.firstElementChild).toBe(content);
    expect(host.textContent).toContain("Session list");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
