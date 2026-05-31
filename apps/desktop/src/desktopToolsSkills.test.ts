import { describe, expect, test } from "vitest";
import {
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
});
