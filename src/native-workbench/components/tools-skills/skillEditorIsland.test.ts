// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import type { DesktopSkillPaneDetailView } from "../../tools-skills/desktopToolsSkills";
import { mountSkillEditorIsland } from "./skillEditorIsland";

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
    saveStatus: "idle",
    saveMessage: "No changes",
    validation: {
      state: "idle",
      message: "",
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

describe("skill editor Vue island", () => {
  test("renders existing editor field hooks and forwards edits", () => {
    const host = document.createElement("div");
    const edits: Array<{ field: string; value: unknown }> = [];

    const mounted = mountSkillEditorIsland(host, {
      skill,
      onEdit: (field, value) => edits.push({ field, value }),
    });

    expect(host.getAttribute("data-desktop-vue-island")).toBe("skill-editor");
    expect(host.className).toContain("desktop-skill-editor");
    const name = host.querySelector<HTMLInputElement>('[data-desktop-skill-editor-field="name"]');
    const description = host.querySelector<HTMLInputElement>('[data-desktop-skill-editor-field="description"]');
    const always = host.querySelector<HTMLInputElement>('[data-desktop-skill-editor-field="always"]');
    const content = host.querySelector<HTMLTextAreaElement>('[data-desktop-skill-editor-field="content"]');

    expect(name?.value).toBe("planner");
    expect(name?.disabled).toBe(true);
    expect(description?.value).toBe("Plan work");
    expect(always?.checked).toBe(true);
    expect(content?.value).toBe("# Planner");

    description!.value = "Plan better";
    description?.dispatchEvent(new Event("input", { bubbles: true }));
    always!.checked = false;
    always?.dispatchEvent(new Event("change", { bubbles: true }));
    content!.value = "# Better planner";
    content?.dispatchEvent(new Event("input", { bubbles: true }));

    expect(edits).toEqual([
      { field: "description", value: "Plan better" },
      { field: "always", value: false },
      { field: "content", value: "# Better planner" },
    ]);

    mounted.unmount();
    expect(host.textContent).toBe("");
  });
});
