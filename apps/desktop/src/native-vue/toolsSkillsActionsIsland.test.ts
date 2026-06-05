// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { mountToolsSkillsActionsIsland, type ToolsSkillsActionItem } from "./toolsSkillsActionsIsland";

const actions: ToolsSkillsActionItem[] = [
  { action: "createSkill", label: "Create skill", enabled: true },
  { action: "saveSkill", label: "Save skill", enabled: false },
  { action: "validateSkill", label: "Validate skill", enabled: true },
];

describe("tools and skills actions Vue island", () => {
  test("renders desktop action hooks and forwards enabled actions", () => {
    const host = document.createElement("div");
    const clicked: string[] = [];

    const mounted = mountToolsSkillsActionsIsland(host, {
      actions,
      onAction: (action) => clicked.push(action),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("tools-skills-actions");
    expect(host.className).toContain("desktop-tools-skills-actions");
    const create = host.querySelector<HTMLButtonElement>('[data-desktop-tools-skills-action="createSkill"]');
    const save = host.querySelector<HTMLButtonElement>('[data-desktop-tools-skills-action="saveSkill"]');
    const validate = host.querySelector<HTMLButtonElement>('[data-desktop-tools-skills-action="validateSkill"]');
    expect(create?.textContent).toContain("Create skill");
    expect(save?.hasAttribute("disabled")).toBe(true);
    expect(validate?.textContent).toContain("Validate skill");

    create?.click();
    save?.click();
    validate?.click();

    expect(clicked).toEqual(["createSkill", "validateSkill"]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
