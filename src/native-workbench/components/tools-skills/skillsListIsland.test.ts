// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopSkillRow } from "../../tools-skills/desktopToolsSkills";
import { mountSkillsListIsland } from "./skillsListIsland";

const skills: DesktopSkillRow[] = [
  {
    name: "planner",
    source: "workspace",
    available: true,
    always: true,
    enabled: true,
    status: "always",
    deletable: true,
    meta: "workspace / always",
    raw: {},
  },
  {
    name: "reviewer",
    source: "builtin",
    available: true,
    always: false,
    enabled: true,
    status: "enabled",
    deletable: false,
    meta: "builtin / enabled",
    raw: {},
  },
];

describe("skills list Vue island", () => {
  test("renders skill rows with existing entity hooks and copy", () => {
    const host = document.createElement("section");

    const mounted = mountSkillsListIsland(host, { skills });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("skills-list");
    expect(host.className).toContain("desktop-skills-list");
    expect(host.querySelector("h2")?.textContent).toBe("Skills");
    const planner = host.querySelector<HTMLElement>('[data-desktop-entity-id="planner"]');
    const reviewer = host.querySelector<HTMLElement>('[data-desktop-entity-id="reviewer"]');
    expect(planner?.getAttribute("data-desktop-entity-module")).toBe("skills");
    expect(planner?.textContent).toContain("planner: workspace / always");
    expect(reviewer?.getAttribute("data-desktop-entity-module")).toBe("skills");
    expect(reviewer?.textContent).toContain("reviewer: builtin / enabled");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
