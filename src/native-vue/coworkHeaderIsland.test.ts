// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopCoworkCockpitView } from "../desktopCowork";
import { mountCoworkHeaderIsland } from "./coworkHeaderIsland";

const header: DesktopCoworkCockpitView["header"] = {
  id: "cowork-session-1",
  title: "Desktop migration",
  goal: "Move Cowork into a desktop cockpit",
  status: "running",
  workflow: "Adaptive Starter",
  updatedAt: "2026-06-05T08:00:00Z",
};

describe("cowork header Vue island", () => {
  test("renders the active session header with existing desktop copy", () => {
    const host = document.createElement("section");

    const mounted = mountCoworkHeaderIsland(host, { header });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("cowork-header");
    expect(host.className).toContain("desktop-cowork-header");
    expect(host.querySelector("h2")?.textContent).toBe("Desktop migration");
    expect(host.textContent).toContain("Move Cowork into a desktop cockpit");
    expect(host.textContent).toContain("running / Adaptive Starter / 2026-06-05T08:00:00Z");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("preserves the existing fallback copy for missing goals and timestamps", () => {
    const host = document.createElement("section");

    const mounted = mountCoworkHeaderIsland(host, {
      header: {
        ...header,
        goal: "",
        updatedAt: "",
      },
    });

    expect(host.textContent).toContain("No goal provided.");
    expect(host.textContent).toContain("running / Adaptive Starter");
    expect(host.textContent).not.toContain("running / Adaptive Starter / ");

    mounted.unmount();
  });
});
