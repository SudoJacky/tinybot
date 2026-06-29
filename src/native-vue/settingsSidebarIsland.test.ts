// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import type { DesktopSettingsPaneModel } from "../desktopSettingsProviders";
import { mountSettingsSidebarIsland } from "./settingsSidebarIsland";

const groups: DesktopSettingsPaneModel["groups"] = [
  { id: "general", label: "General", fields: [] },
  { id: "provider-models", label: "Provider & Models", fields: [] },
  { id: "knowledge", label: "Knowledge", fields: [] },
  { id: "tools-approvals", label: "Tools & Approvals", fields: [] },
  { id: "gateway-runtime", label: "Gateway & Runtime", fields: [] },
  { id: "channels", label: "Channels", fields: [] },
];

describe("settings sidebar Vue island", () => {
  test("renders settings navigation with existing desktop hooks and active first item", async () => {
    const host = document.createElement("aside");

    const mounted = mountSettingsSidebarIsland(host, { groups });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("settings-sidebar");
    expect(host.className).toContain("desktop-settings-sidebar");
    expect(host.getAttribute("aria-label")).toBe("Settings navigation");
    expect(host.querySelector(".n-input.desktop-settings-search input")?.getAttribute("placeholder")).toBe("Search settings...");
    expect(host.querySelector(".n-menu.desktop-settings-nav")).not.toBeNull();
    expect(host.textContent).toContain("Personal");
    expect(host.textContent).toContain("System");

    const links = Array.from(host.querySelectorAll<HTMLAnchorElement>("[data-desktop-settings-nav]"));
    expect(links.map((link) => link.getAttribute("data-desktop-settings-nav"))).toEqual([
      "general",
      "provider-models",
      "knowledge",
      "tools-approvals",
      "gateway-runtime",
      "channels",
    ]);
    expect(links.map((link) => link.textContent)).toEqual([
      "General",
      "Provider & Models",
      "Knowledge",
      "Tools & Approvals",
      "Gateway & Runtime",
      "Channels",
    ]);
    expect(links[0]?.getAttribute("href")).toBe("#desktop-settings-group-general");
    expect(links[0]?.getAttribute("data-active")).toBe("true");
    expect(links[0]?.getAttribute("aria-current")).toBe("page");
    links[4]?.click();
    await nextTick();
    const updatedLinks = Array.from(host.querySelectorAll<HTMLAnchorElement>("[data-desktop-settings-nav]"));
    expect(updatedLinks[0]?.getAttribute("data-active")).toBeNull();
    expect(updatedLinks[0]?.getAttribute("aria-current")).toBeNull();
    expect(updatedLinks[4]?.getAttribute("data-active")).toBe("true");
    expect(updatedLinks[4]?.getAttribute("aria-current")).toBe("page");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
