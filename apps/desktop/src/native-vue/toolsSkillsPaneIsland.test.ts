// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopToolsSkillsPaneModel } from "../desktopToolsSkills";
import { mountToolsSkillsPaneIsland } from "./toolsSkillsPaneIsland";

const pane: DesktopToolsSkillsPaneModel = {
  status: "1 tool / 1 skill",
  toolRows: [{
    name: "read_file",
    displayName: "Read file",
    description: "Read files",
    enabled: true,
    configHint: "",
    riskHint: "",
    schemaFields: [{
      name: "path",
      type: "string",
      required: true,
      description: "File path",
      defaultValue: "",
      enumValues: [],
    }],
    schemaText: "{}",
    meta: "enabled",
    raw: {},
  }],
  skillRows: [{
    name: "planner",
    source: "workspace",
    available: true,
    always: false,
    enabled: true,
    status: "enabled",
    deletable: true,
    meta: "workspace skill",
    raw: {},
  }],
  selectedTool: {
    name: "read_file",
    displayName: "Read file",
    description: "Read files",
    enabled: true,
    configHint: "",
    riskHint: "",
    schemaFields: [{
      name: "path",
      type: "string",
      required: true,
      description: "File path",
      defaultValue: "",
      enumValues: [],
    }],
    schemaText: "{}",
    meta: "enabled",
    raw: {},
    title: "Read file",
    emptySchemaText: "No parameters.",
  },
  selectedSkill: {
    name: "planner",
    description: "Plan work",
    always: false,
    content: "# Planner",
    source: "workspace",
    deletable: true,
    nameEditable: false,
    available: true,
    validation: {
      state: "idle",
      message: "",
    },
    editor: {
      mode: "edit",
      draft: {
        name: "planner",
        description: "Plan work",
        content: "# Planner",
        always: false,
      },
      lastSaved: {
        name: "planner",
        description: "Plan work",
        content: "# Planner",
        always: false,
      },
      dirty: true,
      canSave: true,
      saveStatus: "idle",
      saveMessage: "Unsaved changes",
      validation: {
        state: "idle",
        message: "",
      },
    },
    actions: {
      create: true,
      save: true,
      delete: true,
      validate: true,
      toggleAlways: true,
    },
  },
};

describe("tools and skills pane Vue island", () => {
  test("renders the pane shell and forwards skill actions", () => {
    const host = document.createElement("section");
    const actions: Array<{ action: string; field?: string; value?: unknown }> = [];

    const mounted = mountToolsSkillsPaneIsland(host, {
      pane,
      onToolsSkillsAction: (event) => {
        actions.push({ action: event.action, field: event.field, value: event.value });
      },
    });

    expect(host.className).toBe("desktop-workbench-section desktop-tools-skills-pane");
    expect(host.getAttribute("data-desktop-vue-island")).toBe("tools-skills-pane");
    expect(host.getAttribute("data-desktop-module-surface")).toBe("tools skills");
    expect(host.getAttribute("aria-label")).toBe("Tools and skills");
    expect(host.querySelector(".n-space.desktop-tools-skills-stack")).not.toBeNull();
    expect(host.textContent).toContain("1 tool / 1 skill");

    expect(host.querySelector(".desktop-tools-list")?.getAttribute("data-desktop-vue-island")).toBe("tools-list");
    expect(host.querySelector(".desktop-tools-list")?.textContent).toContain("Read file");
    expect(host.querySelector('[data-desktop-entity-module="tools"]')?.getAttribute("data-desktop-entity-id")).toBe("read_file");
    expect(host.querySelector(".desktop-tool-detail")?.getAttribute("data-desktop-vue-island")).toBe("tool-detail");
    expect(host.querySelector(".desktop-tool-detail")?.textContent).toContain("Tool detail: Read file");
    expect(host.querySelector('[data-desktop-tool-schema-field="path"]')?.textContent).toContain("required");

    expect(host.querySelector(".desktop-skills-list")?.getAttribute("data-desktop-vue-island")).toBe("skills-list");
    expect(host.querySelector(".desktop-skills-list")?.textContent).toContain("planner");
    expect(host.querySelector('[data-desktop-entity-module="skills"]')?.getAttribute("data-desktop-entity-id")).toBe("planner");
    expect(host.querySelector(".desktop-skill-detail-summary")?.getAttribute("data-desktop-vue-island")).toBe("skill-detail-summary");
    expect(host.querySelector(".desktop-skill-detail-summary")?.textContent).toContain("Skill detail: planner");
    expect(host.querySelector(".desktop-skill-editor")?.getAttribute("data-desktop-vue-island")).toBe("skill-editor");
    expect(host.querySelector(".desktop-tools-skills-actions")?.getAttribute("data-desktop-vue-island")).toBe("tools-skills-actions");

    const description = host.querySelector<HTMLInputElement>('[data-desktop-skill-editor-field="description"]');
    description!.value = "Plan better";
    description?.dispatchEvent(new Event("input", { bubbles: true }));
    host.querySelector<HTMLButtonElement>('[data-desktop-tools-skills-action="saveSkill"]')?.click();

    expect(actions).toEqual([
      { action: "editSkill", field: "description", value: "Plan better" },
      { action: "saveSkill", field: undefined, value: undefined },
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
