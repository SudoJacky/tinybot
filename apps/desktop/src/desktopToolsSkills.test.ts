import { describe, expect, test } from "vitest";
import {
  buildDesktopToolsSkillsPaneModel,
  updateDesktopSkillEditorDraft,
  buildDesktopSkillCreateRequest,
  buildDesktopSkillDeleteRequest,
  buildDesktopSkillDetailView,
  buildDesktopSkillRows,
  buildDesktopSkillTogglePatch,
  buildDesktopSkillUpdateRequest,
  buildDesktopSkillValidateRequest,
  buildDesktopToolDetailView,
  buildDesktopToolRows,
  buildDesktopToolsConfigHint,
} from "./desktopToolsSkills";

describe("desktop tools and skills helpers", () => {
  test("projects tools with config hints and schema fields for desktop detail panes", () => {
    const rows = buildDesktopToolRows(
      {
        tools: [
          {
            name: "exec",
            description: "Run a shell command",
            parameters: {
              type: "object",
              required: ["command"],
              properties: {
                command: { type: "string", description: "Command to execute" },
                timeout: { type: "number", default: 60 },
                mode: { enum: ["shell", "direct"] },
              },
            },
          },
          { name: "read_file", description: "Read a workspace file" },
        ],
      },
      { tools: { exec: { enable: false }, web: { enable: true } } },
    );

    expect(rows[0]).toMatchObject({
      name: "exec",
      displayName: "Command",
      enabled: false,
      configHint: "execDisabled",
      riskHint: "modifyFiles",
      meta: "disabled / 3 parameters",
    });
    expect(rows[0].schemaFields).toEqual([
      {
        name: "command",
        type: "string",
        required: true,
        description: "Command to execute",
        defaultValue: "",
        enumValues: [],
      },
      {
        name: "timeout",
        type: "number",
        required: false,
        description: "",
        defaultValue: "60",
        enumValues: [],
      },
      {
        name: "mode",
        type: "enum",
        required: false,
        description: "",
        defaultValue: "",
        enumValues: ["shell", "direct"],
      },
    ]);

    const detail = buildDesktopToolDetailView(rows[0].raw, {
      tools: { exec: { enable: false }, web: { enable: true } },
    });
    expect(detail).toMatchObject({
      name: "exec",
      title: "Command",
      enabled: false,
      configHint: "execDisabled",
      schemaText: expect.stringContaining("\"command\""),
    });
  });

  test("detects tool config hints using the root WebUI web and exec enable flags", () => {
    expect(buildDesktopToolsConfigHint({ tools: { web: { enable: false }, exec: { enable: false } } })).toEqual({
      show: true,
      disabledToolGroups: ["web", "exec"],
    });
    expect(buildDesktopToolsConfigHint({ tools: { web: { enable: true }, exec: { enable: true } } })).toEqual({
      show: false,
      disabledToolGroups: [],
    });
  });

  test("projects skill list state with all-enabled, always-load, unavailable, and source metadata", () => {
    const rows = buildDesktopSkillRows(
      {
        skills: [
          { name: "planner", source: "workspace", available: true, always: false },
          { name: "reviewer", source: "builtin", available: true, always: true },
          { name: "archived", source: "workspace", available: false },
        ],
      },
      { skills: { enabled: ["*"] } },
    );

    expect(rows.map((row) => [row.name, row.enabled, row.status, row.deletable, row.meta])).toEqual([
      ["planner", true, "enabled", true, "workspace / enabled"],
      ["reviewer", true, "always", false, "builtin / always"],
      ["archived", false, "unavailable", true, "workspace / unavailable"],
    ]);

    expect(buildDesktopSkillTogglePatch("planner", false, rows.map((row) => row.raw), { skills: { enabled: ["*"] } })).toEqual({
      skills: { enabled: [] },
    });
  });

  test("builds skill detail state and preserves root WebUI create, edit, delete, and validate contracts", () => {
    const detail = buildDesktopSkillDetailView(
      {
        name: "planner",
        content: "# Planner\nWork in phases.",
        tinybot_meta: { description: "Plan work", always: true },
      },
      { name: "planner", source: "workspace" },
    );

    expect(detail).toEqual({
      name: "planner",
      description: "Plan work",
      always: true,
      content: "# Planner\nWork in phases.",
      source: "workspace",
      deletable: true,
      nameEditable: false,
      validation: { state: "idle", message: "" },
    });
    expect(
      buildDesktopSkillCreateRequest({
        name: " planner ",
        description: " Plan work ",
        content: "# Planner",
        always: true,
      }),
    ).toEqual({
      method: "POST",
      path: "/api/skills",
      body: { name: "planner", description: "Plan work", content: "# Planner", always: true },
    });
    expect(buildDesktopSkillUpdateRequest("planner/phase", { description: "Updated", content: "# Updated", always: false })).toEqual({
      method: "PATCH",
      path: "/api/skills/planner%2Fphase",
      body: { description: "Updated", content: "# Updated", always: false },
    });
    expect(buildDesktopSkillDeleteRequest("planner/phase")).toEqual({
      method: "DELETE",
      path: "/api/skills/planner%2Fphase",
    });
    expect(buildDesktopSkillValidateRequest("planner/phase")).toEqual({
      method: "POST",
      path: "/api/skills/planner%2Fphase/validate",
    });
  });

  test("builds a desktop tools and skills pane model with selected detail actions", () => {
    const pane = buildDesktopToolsSkillsPaneModel({
      toolsPayload: {
        tools: [
          {
            name: "exec",
            description: "Run a command",
            parameters: {
              type: "object",
              required: ["command"],
              properties: {
                command: { type: "string", description: "Command to run" },
              },
            },
          },
        ],
      },
      skillsPayload: {
        skills: [
          { name: "planner", source: "workspace", available: true, always: true },
          { name: "reviewer", source: "builtin", available: true },
        ],
      },
      config: {
        tools: { exec: { enable: false }, web: { enable: true } },
        skills: { enabled: ["reviewer"] },
      },
      selectedToolName: "exec",
      selectedSkillName: "planner",
      selectedSkillDetail: {
        name: "planner",
        content: "# Planner",
        tinybot_meta: { description: "Plan work", always: true },
      },
    });

    expect(pane.toolRows.map((row) => [row.name, row.configHint, row.meta])).toEqual([
      ["exec", "execDisabled", "disabled / 1 parameters"],
    ]);
    expect(pane.selectedTool).toMatchObject({
      name: "exec",
      title: "Command",
      configHint: "execDisabled",
      schemaFields: [
        {
          name: "command",
          type: "string",
          required: true,
          description: "Command to run",
          defaultValue: "",
          enumValues: [],
        },
      ],
    });
    expect(pane.skillRows.map((row) => [row.name, row.status, row.source, row.deletable])).toEqual([
      ["planner", "always", "workspace", true],
      ["reviewer", "enabled", "builtin", false],
    ]);
    expect(pane.selectedSkill).toMatchObject({
      name: "planner",
      description: "Plan work",
      source: "workspace",
      always: true,
      deletable: true,
      actions: {
        create: true,
        save: true,
        delete: true,
        validate: true,
        toggleAlways: true,
      },
    });
    expect(pane.status).toBe("1 tool / 2 skills");
  });

  test("projects skill editor dirty, create, save, and validation state", () => {
    const pane = buildDesktopToolsSkillsPaneModel({
      skillsPayload: {
        skills: [{ name: "planner", source: "workspace", available: true }],
      },
      selectedSkillName: "planner",
      selectedSkillDetail: {
        name: "planner",
        content: "# Planner",
        tinybot_meta: { description: "Plan work", always: false },
      },
      skillEditor: {
        saveStatus: "failed",
        saveError: "HTTP 400",
        validation: { state: "invalid", message: "Missing frontmatter" },
      },
    });

    expect(pane.selectedSkill?.editor).toMatchObject({
      mode: "edit",
      dirty: false,
      canSave: false,
      saveStatus: "failed",
      saveMessage: "HTTP 400",
      validation: { state: "invalid", message: "Missing frontmatter" },
      draft: {
        name: "planner",
        description: "Plan work",
        content: "# Planner",
        always: false,
      },
    });
    expect(pane.selectedSkill?.actions.save).toBe(true);

    const dirtyPane = updateDesktopSkillEditorDraft(pane, "description", "Plan better");
    expect(dirtyPane.selectedSkill?.editor).toMatchObject({
      dirty: true,
      canSave: true,
      saveStatus: "idle",
      saveMessage: "Unsaved changes",
      draft: { description: "Plan better" },
    });
    expect(dirtyPane.selectedSkill?.actions.save).toBe(true);

    const createPane = updateDesktopSkillEditorDraft(
      buildDesktopToolsSkillsPaneModel({
        skillsPayload: { skills: [{ name: "planner", source: "workspace", available: true }] },
        skillEditor: { mode: "create" },
      }),
      "name",
      "reviewer",
    );
    const createPaneWithContent = updateDesktopSkillEditorDraft(createPane, "content", "# Reviewer");
    expect(createPaneWithContent.selectedSkill).toMatchObject({
      name: "",
      nameEditable: true,
      source: "workspace",
      editor: {
        mode: "create",
        dirty: true,
        canSave: true,
        draft: {
          name: "reviewer",
          content: "# Reviewer",
        },
      },
      actions: {
        create: true,
        save: true,
        delete: false,
        validate: false,
        toggleAlways: false,
      },
    });
  });
});
