import { describe, expect, test } from "vitest";

import { SkillsRuntime } from "./skillsRuntime";

describe("SkillsRuntime", () => {
  test("matches legacy skills discovery summary and always-skill filtering", () => {
    const runtime = new SkillsRuntime({
      skills: [
        {
          name: "planner",
          path: "workspace/skills/planner/SKILL.md",
          source: "workspace",
          content: [
            "---",
            "name: planner",
            "description: Workspace planner & reviewer",
            "metadata: '{\"tinybot\":{\"always\":true,\"requires\":{\"bins\":[\"git\"],\"env\":[\"TOKEN\"]}}}'",
            "---",
            "Plan from workspace.",
          ].join("\n"),
        },
        {
          name: "planner",
          path: "workers/ts-agent-worker/skills/planner/SKILL.md",
          source: "builtin",
          content: [
            "---",
            "name: planner",
            "description: Builtin planner",
            "---",
            "Plan from builtin.",
          ].join("\n"),
        },
        {
          name: "tmux",
          path: "workers/ts-agent-worker/skills/tmux/SKILL.md",
          source: "builtin",
          content: [
            "---",
            "name: tmux",
            "description: Terminal <session>",
            "metadata: '{\"openclaw\":{\"requires\":{\"bins\":[\"tmux\"],\"env\":[\"TMUX_SOCKET\"]}}}'",
            "---",
            "Use tmux.",
          ].join("\n"),
        },
      ],
      hasBin: (bin) => bin === "git",
      hasEnv: (name) => name === "TOKEN",
    });

    expect(runtime.listSkills({ filterUnavailable: false })).toEqual([
      { name: "planner", path: "workspace/skills/planner/SKILL.md", source: "workspace" },
      { name: "tmux", path: "workers/ts-agent-worker/skills/tmux/SKILL.md", source: "builtin" },
    ]);
    expect(runtime.getAlwaysSkills(["*"])).toEqual(["planner"]);
    expect(runtime.loadSkillsForContext(["planner"])).toBe("### Skill: planner\n\nPlan from workspace.");
    expect(runtime.buildContext(["*"])).toMatchObject({
      activeSkillsContent: "### Skill: planner\n\nPlan from workspace.",
      alwaysSkillNames: ["planner"],
      unavailableCount: 1,
      sourceCounts: { workspace: 1, builtin: 1 },
    });
    expect(runtime.buildSkillsSummary(["*"])).toBe(
      [
        "<skills>",
        '  <skill available="true">',
        "    <name>planner</name>",
        "    <description>Workspace planner &amp; reviewer</description>",
        "    <location>workspace/skills/planner/SKILL.md</location>",
        "  </skill>",
        '  <skill available="false">',
        "    <name>tmux</name>",
        "    <description>Terminal &lt;session&gt;</description>",
        "    <location>workers/ts-agent-worker/skills/tmux/SKILL.md</location>",
        "    <requires>CLI: tmux, ENV: TMUX_SOCKET</requires>",
        "  </skill>",
        "</skills>",
      ].join("\n"),
    );
  });

  test("projects legacy-compatible WebUI list and detail payloads", () => {
    const runtime = new SkillsRuntime({
      skills: [
        {
          name: "planner",
          path: "workspace/skills/planner/SKILL.md",
          source: "workspace",
          content: [
            "---",
            "name: planner",
            "description: Workspace planner & reviewer",
            "metadata: '{\"tinybot\":{\"requires\":{\"bins\":[\"git\"],\"env\":[\"TOKEN\"]}}}'",
            "always: true",
            "---",
            "Plan from workspace.",
          ].join("\n"),
        },
        {
          name: "planner",
          path: "workers/ts-agent-worker/skills/planner/SKILL.md",
          source: "builtin",
          content: [
            "---",
            "name: planner",
            "description: Builtin planner",
            "---",
            "Plan from builtin.",
          ].join("\n"),
        },
        {
          name: "tmux",
          path: "workers/ts-agent-worker/skills/tmux/SKILL.md",
          source: "builtin",
          content: [
            "---",
            "name: tmux",
            "description: Terminal session",
            "metadata: '{\"openclaw\":{\"requires\":{\"bins\":[\"tmux\"],\"env\":[\"TMUX_SOCKET\"]}}}'",
            "---",
            "Use tmux.",
          ].join("\n"),
        },
      ],
      hasBin: (bin) => bin === "git",
      hasEnv: (name) => name === "TOKEN",
    });

    expect(runtime.buildWebuiList(["planner"])).toEqual({
      skills: [
        {
          name: "planner",
          source: "workspace",
          path: "workspace/skills/planner/SKILL.md",
          description: "Workspace planner & reviewer",
          available: true,
          enabled: true,
          always: true,
        },
        {
          name: "tmux",
          source: "builtin",
          path: "workers/ts-agent-worker/skills/tmux/SKILL.md",
          description: "Terminal session",
          available: false,
          enabled: false,
          always: false,
          missing_requirements: "CLI: tmux, ENV: TMUX_SOCKET",
        },
      ],
    });
    expect(runtime.buildWebuiDetail("planner")).toEqual({
      name: "planner",
      content: "Plan from workspace.",
      raw_content: [
        "---",
        "name: planner",
        "description: Workspace planner & reviewer",
        "metadata: '{\"tinybot\":{\"requires\":{\"bins\":[\"git\"],\"env\":[\"TOKEN\"]}}}'",
        "always: true",
        "---",
        "Plan from workspace.",
      ].join("\n"),
      metadata: {
        name: "planner",
        description: "Workspace planner & reviewer",
        metadata: "{\"tinybot\":{\"requires\":{\"bins\":[\"git\"],\"env\":[\"TOKEN\"]}}}",
        always: "true",
      },
      tinybot_meta: {
        requires: {
          bins: ["git"],
          env: ["TOKEN"],
        },
        always: true,
      },
      available: true,
    });
    expect(runtime.buildWebuiDetail("missing")).toBeNull();
  });
});
