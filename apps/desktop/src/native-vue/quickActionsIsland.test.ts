// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountQuickActionsIsland } from "./quickActionsIsland";

describe("quick actions Vue island", () => {
  test("renders desktop quick action links with the existing route contract", () => {
    const host = document.createElement("div");

    const mounted = mountQuickActionsIsland(host);

    expect(host.getAttribute("data-desktop-vue-island")).toBe("quick-actions");
    expect(host.className).toContain("desktop-quick-actions");
    expect([...host.querySelectorAll<HTMLAnchorElement>(".desktop-quick-action")].map((node) => node.textContent)).toEqual([
      "New chat",
      "Open workspace",
      "Gateway status",
    ]);
    expect([...host.querySelectorAll<HTMLAnchorElement>(".desktop-quick-action")].map((node) => node.getAttribute("href"))).toEqual([
      "/chat/new",
      "/workspace",
      "/api/status",
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
