// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopSkillPaneDetailView } from "../../tools-skills/desktopToolsSkills";
import { mountSkillDetailSummaryIsland } from "./skillDetailSummaryIsland";

const skill: DesktopSkillPaneDetailView = {
  name: "planner",
  description: "Plan work",
  always: true,
  content: "# Planner",
  source: "workspace",
  deletable: true,
  nameEditable: false,
  available: true,
  editor: {
    mode: "edit",
    draft: {
      name: "planner",
      description: "Plan work",
      content: "# Planner",
      always: true,
    },
    lastSaved: {
      name: "planner",
      description: "Plan work",
      content: "# Planner",
      always: true,
    },
    dirty: false,
    canSave: false,
    saveStatus: "saved",
    saveMessage: "Saved",
    validation: {
      state: "invalid",
      message: "Missing heading",
    },
  },
  actions: {
    create: false,
    save: false,
    delete: true,
    validate: true,
    toggleAlways: true,
  },
  validation: {
    state: "idle",
    message: "",
  },
};

describe("skill detail summary Vue island", () => {
  test("renders selected skill summary with existing desktop copy", () => {
    const host = document.createElement("section");

    const mounted = mountSkillDetailSummaryIsland(host, { skill });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("skill-detail-summary");
    expect(host.className).toContain("desktop-skill-detail-summary");
    expect(host.querySelector("h2")?.textContent).toBe("Skill detail: planner");
    expect(host.textContent).toContain("Plan work");
    expect(host.textContent).toContain("Source: workspace");
    expect(host.textContent).toContain("Always load: Enabled");
    expect(host.textContent).toContain("Save state: Saved");
    expect(host.textContent).toContain("Validation: Missing heading");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("falls back to validation state when there is no message", () => {
    const host = document.createElement("section");

    const mounted = mountSkillDetailSummaryIsland(host, {
      skill: {
        ...skill,
        always: false,
        editor: {
          ...skill.editor,
          validation: {
            state: "valid",
            message: "",
          },
        },
      },
    });

    expect(host.textContent).toContain("Always load: Disabled");
    expect(host.textContent).toContain("Validation: valid");

    mounted.unmount();
  });
});
