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

  test("allows skill root symlinks during validation like Python WebUI routes", async () => {
    const rpcClient = new FakeRpcClient({
      "workspace.read_file": [
        {
          content: "---\nname: planner\ndescription: Plan work\n---\nPlan.",
        },
      ],
      "workspace.list_dir": [
        {
          entries: [
            { path: "skills/planner/SKILL.md", kind: "file" },
            { path: "skills/planner/scripts", kind: "dir" },
            { path: "skills/planner/shared-notes", kind: "symlink" },
          ],
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
        method: "workspace.read_file",
        params: { path: "skills/planner/SKILL.md", format: "raw" },
      },
      {
        traceId: "trace-3",
        method: "workspace.list_dir",
        params: { path: "skills/planner", recursive: false },
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
