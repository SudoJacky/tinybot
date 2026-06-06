// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountActivityRailIsland } from "./activityRailIsland";

describe("activity rail Vue island", () => {
  test("renders primary module navigation with chat active", () => {
    const host = document.createElement("nav");

    const mounted = mountActivityRailIsland(host);

    expect(host.getAttribute("data-desktop-vue-island")).toBe("activity-rail");
    expect(host.className).toBe("desktop-activity-rail");
    expect(host.getAttribute("data-workbench-region")).toBe("activity");
    expect(host.getAttribute("aria-label")).toBe("Desktop workbench modules");

    const primary = Array.from(host.querySelectorAll<HTMLAnchorElement>(".desktop-activity-button"));
    expect(primary.map((item) => item.textContent)).toEqual(["Chat", "Files", "Knowledge", "Cowork"]);
    expect(primary.map((item) => item.getAttribute("href"))).toEqual(["/chat", "/workspace", "/knowledge", "/cowork"]);
    expect(primary.map((item) => item.getAttribute("data-desktop-module-target"))).toEqual([
      "chat",
      "workspace",
      "knowledge",
      "cowork",
    ]);
    expect(primary.map((item) => item.getAttribute("data-focus-order"))).toEqual([
      "activity-1",
      "activity-2",
      "activity-3",
      "activity-4",
    ]);
    expect(primary[0]?.getAttribute("data-active")).toBe("true");
    expect(primary[0]?.getAttribute("aria-current")).toBe("page");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders secondary module navigation", () => {
    const host = document.createElement("nav");

    mountActivityRailIsland(host);

    const secondary = Array.from(host.querySelectorAll<HTMLAnchorElement>(".desktop-activity-secondary-button"));
    expect(secondary.map((item) => item.textContent)).toEqual(["Docs", "GitHub", "Settings"]);
    expect(secondary.map((item) => item.getAttribute("href"))).toEqual([
      "/docs",
      "https://github.com/SudoJacky/tinybot",
      "/settings",
    ]);
    expect(secondary.map((item) => item.getAttribute("data-desktop-module-target"))).toEqual([
      "docs",
      "gateway",
      "settings",
    ]);
    expect(secondary.every((item) => item.getAttribute("aria-label") === item.textContent)).toBe(true);
    expect(secondary.every((item) => item.getAttribute("title") === item.textContent)).toBe(true);
  });
});
