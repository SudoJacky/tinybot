// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountHelpSurfaceIsland } from "./helpSurfaceIsland";

describe("help surface Vue island", () => {
  test("mounts Naive UI help actions and routes button actions", () => {
    const host = document.createElement("section");
    const actions: string[] = [];

    const mounted = mountHelpSurfaceIsland(host, {
      onAction: (action) => actions.push(action),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("help-surface");
    expect(host.className).toContain("desktop-help-pane");
    expect(host.getAttribute("aria-label")).toBe("Desktop help");
    expect(host.querySelector("h2")?.textContent).toBe("Help");
    expect(host.querySelector<HTMLAnchorElement>('[data-desktop-help-action="docs"]')?.getAttribute("href")).toBe("/docs");
    expect(Array.from(host.querySelectorAll(".desktop-help-action")).map((action) => action.textContent)).toEqual([
      "Open docs",
      "Shortcut help",
      "Page help",
      "Backend logs",
      "Help tour",
    ]);

    host.querySelector<HTMLButtonElement>('[data-desktop-help-action="shortcut-help"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-help-action="page-help"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-help-action="backend-logs"]')?.click();
    host.querySelector<HTMLButtonElement>('[data-desktop-help-action="help-tour"]')?.click();

    expect(actions).toEqual(["shortcut-help", "page-help", "backend-logs", "help-tour"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
