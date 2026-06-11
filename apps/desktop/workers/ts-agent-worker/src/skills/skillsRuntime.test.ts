import { describe, expect, test } from "vitest";

import { SkillsRuntime } from "./skillsRuntime";

describe("SkillsRuntime", () => {
  test("matches Python skills discovery summary and always-skill filtering", () => {
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
          path: "tinybot/skills/planner/SKILL.md",
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
          path: "tinybot/skills/tmux/SKILL.md",
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
      { name: "tmux", path: "tinybot/skills/tmux/SKILL.md", source: "builtin" },
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
        "    <location>tinybot/skills/tmux/SKILL.md</location>",
        "    <requires>CLI: tmux, ENV: TMUX_SOCKET</requires>",
        "  </skill>",
        "</skills>",
      ].join("\n"),
    );
  });
});
