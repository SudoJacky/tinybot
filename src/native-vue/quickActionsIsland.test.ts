// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountQuickActionsIsland } from "./quickActionsIsland";

describe("quick actions Vue island", () => {
  test("mounts without rendering redundant empty-state shortcuts", () => {
    const host = document.createElement("div");

    const mounted = mountQuickActionsIsland(host);

    expect(host.getAttribute("data-desktop-vue-island")).toBe("quick-actions");
    expect(host.className).toContain("desktop-quick-actions");
    expect(host.querySelectorAll(".desktop-quick-action")).toHaveLength(0);
    expect(host.textContent).toBe("");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
