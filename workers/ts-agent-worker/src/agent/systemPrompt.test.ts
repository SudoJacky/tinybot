import { describe, expect, test } from "vitest";

import { buildSystemPrompt } from "./systemPrompt";

describe("buildSystemPrompt", () => {
  test("includes identity and bootstrap files in deterministic order", () => {
    const prompt = buildSystemPrompt({
      identity: "You are TinyBot.",
      bootstrapFiles: [
        { path: "USER.md", contents: "User rules" },
        { path: "AGENTS.md", contents: "Agent rules" },
      ],
    });

    expect(prompt).toContain("You are TinyBot.");
    expect(prompt.indexOf("## AGENTS.md")).toBeLessThan(prompt.indexOf("## USER.md"));
    expect(prompt).toContain("## AGENTS.md\n\nAgent rules");
    expect(prompt).toContain("## USER.md\n\nUser rules");
  });

  test("omits missing bootstrap files and empty skills context by default", () => {
    const prompt = buildSystemPrompt({
      identity: "Identity",
      bootstrapFiles: [
        { path: "AGENTS.md", contents: "Agent rules" },
        { path: "TOOLS.md", contents: "" },
      ],
    });

    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).not.toContain("## TOOLS.md");
    expect(prompt).not.toContain("# Active Skills");
    expect(prompt).not.toContain("(deferred in TS context phase 1)");
  });

  test("can still include a deferred skills placeholder when explicitly requested", () => {
    const prompt = buildSystemPrompt({
      identity: "Identity",
      includeDeferredSkillsPlaceholder: true,
    });

    expect(prompt).toContain("# Active Skills\n\n(deferred in TS context phase 1)");
  });
});
