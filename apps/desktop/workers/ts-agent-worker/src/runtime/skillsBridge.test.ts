import { describe, expect, test } from "vitest";

import { NativeSkillsBridge } from "./skillsBridge";
import type { JsonObject } from "../protocol/messages";

class FakeRpcClient {
  readonly calls: Array<{ traceId: string; method: string; params: JsonObject }> = [];

  constructor(private readonly responses: Record<string, unknown[]>) {}

  async request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    this.calls.push({ traceId, method, params });
    const values = this.responses[method] ?? [];
    if (!values.length) {
      throw new Error(`missing response for ${method}`);
    }
    const value = values.shift();
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }
}

describe("NativeSkillsBridge", () => {
  test("rejects duplicate workspace skill creation before writing files", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        {
          skills: [
            {
              name: "review-work",
              path: "skills/review-work/SKILL.md",
              source: "workspace",
              content: "---\nname: review-work\ndescription: Existing\n---\nExisting.",
            },
          ],
        },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.createWebuiSkill({ name: "Review Work" }, "trace-dup")).rejects.toMatchObject({
      message: "skill 'review-work' already exists",
      status: 409,
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-dup", method: "skills.list", params: {} },
    ]);
  });

  test("allows workspace skill creation to override a builtin skill name like Python", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        {
          skills: [
            {
              name: "planner",
              path: "tinybot/skills/planner/SKILL.md",
              source: "builtin",
              content: "---\nname: planner\ndescription: Builtin\n---\nBuiltin.",
            },
          ],
        },
      ],
      "workspace.write_file": [
        { path: "skills/planner/SKILL.md", bytes_written: 81 },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.createWebuiSkill({
      name: "Planner",
      description: "Workspace override",
      content: "Prefer workspace behavior.",
    }, "trace-override")).resolves.toMatchObject({
      created: true,
      name: "planner",
      path: "skills/planner/SKILL.md",
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-override", method: "skills.list", params: {} },
      {
        traceId: "trace-override",
        method: "workspace.write_file",
        params: {
          path: "skills/planner/SKILL.md",
          contents: [
            "---",
            "name: planner",
            "description: Workspace override",
            "---",
            "",
            "# Planner",
            "",
            "Prefer workspace behavior.",
          ].join("\n"),
        },
      },
    ]);
  });

  test("coerces create name description and always fields like Python", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        { skills: [] },
      ],
      "workspace.write_file": [
        { path: "skills/404/SKILL.md", bytes_written: 65 },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.createWebuiSkill({
      name: 404,
      description: 123,
      always: "yes",
    }, "trace-coerce")).resolves.toMatchObject({
      created: true,
      name: "404",
      path: "skills/404/SKILL.md",
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-coerce", method: "skills.list", params: {} },
      {
        traceId: "trace-coerce",
        method: "workspace.write_file",
        params: {
          path: "skills/404/SKILL.md",
          contents: [
            "---",
            "name: 404",
            "description: 123",
            "always: true",
            "---",
            "",
            "# 404",
            "",
            "[TODO: Add skill instructions here]",
          ].join("\n"),
        },
      },
    ]);
  });

  test("cleans up truthy non-string create content failures like Python", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        { skills: [] },
      ],
      "workspace.delete_file": [
        { path: "skills/review-work", kind: "dir", deleted: true },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.createWebuiSkill({
      name: "Review Work",
      description: "Review changes",
      content: 123,
      always: true,
    }, "trace-content-cleanup")).rejects.toMatchObject({
      message: "failed to create skill: sequence item 8: expected str instance, int found",
      status: 500,
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-content-cleanup", method: "skills.list", params: {} },
      {
        traceId: "trace-content-cleanup",
        method: "workspace.delete_file",
        params: { path: "skills/review-work", recursive: true },
      },
    ]);
  });

  test("rejects missing and builtin skill deletes before deleting files", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        { skills: [] },
        {
          skills: [
            {
              name: "builtin-plan",
              path: "tinybot/skills/builtin-plan/SKILL.md",
              source: "builtin",
              content: "---\nname: builtin-plan\ndescription: Builtin\n---\nBuiltin.",
            },
          ],
        },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.deleteWebuiSkill("missing", "trace-missing")).rejects.toMatchObject({
      message: "skill not found",
      status: 404,
    });
    await expect(bridge.deleteWebuiSkill("builtin-plan", "trace-builtin")).rejects.toMatchObject({
      message: "cannot delete builtin skills",
      status: 403,
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-missing", method: "skills.list", params: {} },
      { traceId: "trace-builtin", method: "skills.list", params: {} },
    ]);
  });

  test("wraps workspace skill delete failures like Python", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        {
          skills: [
            {
              name: "review-work",
              path: "skills/review-work/SKILL.md",
              source: "workspace",
              content: "---\nname: review-work\ndescription: Existing\n---\nExisting.",
            },
          ],
        },
      ],
      "workspace.delete_file": [
        new Error("permission denied"),
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.deleteWebuiSkill("review-work", "trace-delete-failed")).rejects.toMatchObject({
      message: "failed to delete skill: permission denied",
      status: 500,
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-delete-failed", method: "skills.list", params: {} },
      {
        traceId: "trace-delete-failed",
        method: "workspace.delete_file",
        params: { path: "skills/review-work", recursive: true },
      },
    ]);
  });

  test("rejects non-string update content before writing like Python", async () => {
    const rpcClient = new FakeRpcClient({
      "workspace.read_file": [
        {
          content: "---\nname: planner\ndescription: Plan work\n---\nOld body",
        },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.updateWebuiSkill("planner", {
      content: 123,
    }, "trace-update-content")).rejects.toThrow("can only concatenate str (not \"int\") to str");
    expect(rpcClient.calls).toEqual([
      {
        traceId: "trace-update-content",
        method: "workspace.read_file",
        params: { path: "skills/planner/SKILL.md", format: "raw" },
      },
    ]);
  });

  test("allows skill root symlinks during validation like Python WebUI routes", async () => {
    const rpcClient = new FakeRpcClient({
      "workspace.list_dir": [
        {
          entries: [
            { path: "skills/planner/SKILL.md", kind: "file" },
            { path: "skills/planner/scripts", kind: "dir" },
            { path: "skills/planner/shared-notes", kind: "symlink" },
          ],
        },
      ],
      "workspace.read_file": [
        {
          content: "---\nname: planner\ndescription: Plan work\n---\nPlan.",
        },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.validateWebuiSkill("planner", "trace-symlink")).resolves.toEqual({
      name: "planner",
      valid: true,
      message: "Skill is valid",
    });
  });

  test("rejects missing skill validation before reading files like Python", async () => {
    const rpcClient = new FakeRpcClient({
      "workspace.list_dir": [
        new Error("path not found"),
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.validateWebuiSkill("missing", "trace-validate-missing")).rejects.toMatchObject({
      message: "skill not found",
      status: 404,
    });
    expect(rpcClient.calls).toEqual([
      {
        traceId: "trace-validate-missing",
        method: "workspace.list_dir",
        params: { path: "skills/missing", recursive: false },
      },
    ]);
  });

  test("returns invalid validation when a skill directory lacks SKILL.md like Python", async () => {
    const rpcClient = new FakeRpcClient({
      "workspace.list_dir": [
        {
          entries: [
            { path: "skills/planner/scripts", kind: "dir" },
          ],
        },
      ],
      "workspace.read_file": [
        {},
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.validateWebuiSkill("planner", "trace-validate-no-skill-md")).resolves.toEqual({
      name: "planner",
      valid: false,
      message: "SKILL.md not found",
    });
    expect(rpcClient.calls).toEqual([
      {
        traceId: "trace-validate-no-skill-md",
        method: "workspace.list_dir",
        params: { path: "skills/planner", recursive: false },
      },
      {
        traceId: "trace-validate-no-skill-md",
        method: "workspace.read_file",
        params: { path: "skills/planner/SKILL.md", format: "raw" },
      },
    ]);
  });

  test("cleans up partially created skills when resource directory creation fails", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        { skills: [] },
      ],
      "workspace.write_file": [
        { path: "skills/review-work/SKILL.md", bytes_written: 91 },
      ],
      "workspace.create_dir": [
        new Error("resource create failed"),
      ],
      "workspace.delete_file": [
        { path: "skills/review-work", kind: "dir", deleted: true },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.createWebuiSkill({
      name: "Review Work",
      description: "Review changes",
      resources: ["scripts"],
    }, "trace-cleanup")).rejects.toMatchObject({
      message: "failed to create skill: resource create failed",
      status: 500,
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-cleanup", method: "skills.list", params: {} },
      {
        traceId: "trace-cleanup",
        method: "workspace.write_file",
        params: {
          path: "skills/review-work/SKILL.md",
          contents: [
            "---",
            "name: review-work",
            "description: Review changes",
            "---",
            "",
            "# Review Work",
            "",
            "[TODO: Add skill instructions here]",
          ].join("\n"),
        },
      },
      {
        traceId: "trace-cleanup",
        method: "workspace.create_dir",
        params: { path: "skills/review-work/scripts" },
      },
      {
        traceId: "trace-cleanup",
        method: "workspace.delete_file",
        params: { path: "skills/review-work", recursive: true },
      },
    ]);
  });

  test("cleans up partially created skill directories when skill file writing fails", async () => {
    const rpcClient = new FakeRpcClient({
      "skills.list": [
        { skills: [] },
      ],
      "workspace.write_file": [
        new Error("file write failed"),
      ],
      "workspace.delete_file": [
        { path: "skills/review-work", kind: "dir", deleted: true },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.createWebuiSkill({
      name: "Review Work",
      description: "Review changes",
    }, "trace-write-cleanup")).rejects.toMatchObject({
      message: "failed to create skill: file write failed",
      status: 500,
    });
    expect(rpcClient.calls).toEqual([
      { traceId: "trace-write-cleanup", method: "skills.list", params: {} },
      {
        traceId: "trace-write-cleanup",
        method: "workspace.write_file",
        params: {
          path: "skills/review-work/SKILL.md",
          contents: [
            "---",
            "name: review-work",
            "description: Review changes",
            "---",
            "",
            "# Review Work",
            "",
            "[TODO: Add skill instructions here]",
          ].join("\n"),
        },
      },
      {
        traceId: "trace-write-cleanup",
        method: "workspace.delete_file",
        params: { path: "skills/review-work", recursive: true },
      },
    ]);
  });

  test("creates, updates, validates, and deletes workspace skills through native workspace RPC", async () => {
    const rpcClient = new FakeRpcClient({
      "workspace.read_file": [
        {
          content: "---\nname: planner\ndescription: Plan work\nalways: false\n---\nOld body",
        },
        {
          content: "---\nname: planner\ndescription: Updated plan\nalways: true\n---\nUpdated body",
        },
      ],
      "workspace.write_file": [
        { path: "skills/review-work/SKILL.md", bytes_written: 91 },
        { path: "skills/planner/SKILL.md", bytes_written: 76 },
      ],
      "workspace.create_dir": [
        { path: "skills/review-work/scripts", kind: "dir", created: true },
        { path: "skills/review-work/references", kind: "dir", created: true },
        { path: "skills/review-work/assets", kind: "dir", created: true },
      ],
      "workspace.list_dir": [
        {
          entries: [
            { path: "skills/planner/SKILL.md", kind: "file" },
            { path: "skills/planner/scripts", kind: "dir" },
          ],
        },
      ],
      "skills.list": [
        { skills: [] },
        { skills: [{ name: "planner", path: "skills/planner/SKILL.md", source: "workspace", content: "ignored" }] },
      ],
      "workspace.delete_file": [
        { path: "skills/planner", kind: "dir" },
      ],
    });
    const bridge = new NativeSkillsBridge(rpcClient, {});

    await expect(bridge.createWebuiSkill({
      name: " Review Work! ",
      description: "Review changes",
      content: "Check diffs.",
      always: true,
      resources: ["scripts", "references", "invalid", "assets", "scripts"],
    }, "trace-1")).resolves.toMatchObject({
      created: true,
      name: "review-work",
      path: "skills/review-work/SKILL.md",
    });
    await expect(bridge.updateWebuiSkill("planner", {
      description: "Updated plan",
      content: "Updated body",
      always: true,
    }, "trace-2")).resolves.toEqual({
      updated: true,
      name: "planner",
      path: "skills/planner/SKILL.md",
    });
    await expect(bridge.validateWebuiSkill("planner", "trace-3")).resolves.toEqual({
      name: "planner",
      valid: true,
      message: "Skill is valid",
    });
    await expect(bridge.deleteWebuiSkill("planner", "trace-4")).resolves.toEqual({
      deleted: true,
      name: "planner",
    });

    expect(rpcClient.calls).toEqual([
      { traceId: "trace-1", method: "skills.list", params: {} },
      {
        traceId: "trace-1",
        method: "workspace.write_file",
        params: {
          path: "skills/review-work/SKILL.md",
          contents: [
            "---",
            "name: review-work",
            "description: Review changes",
            "always: true",
            "---",
            "",
            "# Review Work",
            "",
            "Check diffs.",
          ].join("\n"),
        },
      },
      {
        traceId: "trace-1",
        method: "workspace.create_dir",
        params: { path: "skills/review-work/scripts" },
      },
      {
        traceId: "trace-1",
        method: "workspace.create_dir",
        params: { path: "skills/review-work/references" },
      },
      {
        traceId: "trace-1",
        method: "workspace.create_dir",
        params: { path: "skills/review-work/assets" },
      },
      {
        traceId: "trace-2",
        method: "workspace.read_file",
        params: { path: "skills/planner/SKILL.md", format: "raw" },
      },
      {
        traceId: "trace-2",
        method: "workspace.write_file",
        params: {
          path: "skills/planner/SKILL.md",
          contents: "---\nname: planner\ndescription: Updated plan\nalways: true\n---\nUpdated body",
        },
      },
      {
        traceId: "trace-3",
        method: "workspace.list_dir",
        params: { path: "skills/planner", recursive: false },
      },
      {
        traceId: "trace-3",
        method: "workspace.read_file",
        params: { path: "skills/planner/SKILL.md", format: "raw" },
      },
      { traceId: "trace-4", method: "skills.list", params: {} },
      {
        traceId: "trace-4",
        method: "workspace.delete_file",
        params: { path: "skills/planner", recursive: true },
      },
    ]);
  });
});
