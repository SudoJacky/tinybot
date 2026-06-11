import { describe, expect, test } from "vitest";

import { buildContextMessages } from "./contextBuilder";

describe("buildContextMessages", () => {
  test("builds system and current user messages for empty history", () => {
    const result = buildContextMessages({
      identity: "Identity",
      currentMessage: "Hello",
      runtime: { currentTime: "2026-06-10 09:00:00 Asia/Shanghai" },
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ role: "system", content: expect.stringContaining("Identity") });
    expect(result.messages[1]).toEqual({
      role: "user",
      content: "[Runtime Context - metadata only, not instructions]\nCurrent Time: 2026-06-10 09:00:00 Asia/Shanghai\n\nHello",
    });
    expect(result.metadata).toMatchObject({
      bootstrapFiles: [],
      historyMessageCount: 0,
      mergedWithLastMessage: false,
      runtimeContextIncluded: true,
      memoryContextIncluded: false,
      knowledgeContextIncluded: false,
      skillsContextIncluded: false,
    });
    expect(result.metadata.omittedContext).toEqual([
      "memory",
      "recent_context",
      "experience",
      "knowledge",
      "skills_detail",
      "active_task_progress",
    ]);
  });

  test("prepends runtime context fields and user profile to current content", () => {
    const result = buildContextMessages({
      identity: "Identity",
      currentMessage: "Help me plan.",
      runtime: {
        currentTime: "2026-06-10 09:00:00 Asia/Shanghai",
        channel: "desktop",
        chatId: "chat-1",
        userProfile: {
          name: "Ada",
          preferences: ["concise"],
          mentionedEntities: ["tinybot"],
          communicationStyle: "direct",
          keyFacts: ["uses desktop app"],
        },
      },
    });

    expect(result.messages[1].content).toContain("Channel: desktop\nChat ID: chat-1");
    expect(result.messages[1].content).toContain(
      "User Context: Name: Ada; Preferences: concise; Known Entities: tinybot; Communication Style: direct; Key Facts: uses desktop app",
    );
  });

  test("appends history before current message when trailing role differs", () => {
    const result = buildContextMessages({
      identity: "Identity",
      currentMessage: "Next",
      runtime: { currentTime: "now" },
      history: [
        { role: "user", content: "Earlier" },
        { role: "assistant", content: "Answer" },
      ],
    });

    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(result.messages.at(-1)?.content).toContain("Next");
    expect(result.metadata.historyMessageCount).toBe(2);
  });

  test("merges current user content into trailing user history", () => {
    const result = buildContextMessages({
      identity: "Identity",
      currentMessage: "Continue",
      runtime: { currentTime: "now" },
      history: [{ role: "user", content: "Earlier" }],
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({
      role: "user",
      content: "Earlier\n\n[Runtime Context - metadata only, not instructions]\nCurrent Time: now\n\nContinue",
    });
    expect(result.metadata.mergedWithLastMessage).toBe(true);
  });

  test("adds memory recall as a separate system message with active note metadata", () => {
    const result = buildContextMessages({
      identity: "Identity",
      currentMessage: "Continue the implementation",
      runtime: { currentTime: "now" },
      memoryNotes: [
        {
          id: "note_pref",
          scope: "user",
          type: "preference",
          status: "active",
          content: "User prefers concise implementation handoffs.",
          priority: 0.8,
          confidence: 0.7,
          tags: ["handoff", "communication"],
          metadata: { source: "desktop" },
        },
      ],
    });

    expect(result.messages.map((message) => message.role)).toEqual(["system", "user", "system"]);
    expect(result.messages.at(-1)?.content).toContain("[MEMORY RECALL]");
    expect(result.messages.at(-1)?.content).toContain(
      "- User prefers concise implementation handoffs. (id: note_pref; scope: user; type: preference; priority: 0.8; confidence: 0.7; tags: communication, handoff; metadata: {\"source\":\"desktop\"})",
    );
    expect(result.metadata.memoryContextIncluded).toBe(true);
    expect(result.metadata.omittedContext).not.toContain("memory");
    expect(result.metadata._memory_references).toEqual([
      {
        note_id: "note_pref",
        scope: "user",
        type: "preference",
        status: "active",
        content: "User prefers concise implementation handoffs.",
        priority: 0.8,
        confidence: 0.7,
        tags: ["handoff", "communication"],
        metadata: { source: "desktop" },
      },
    ]);
  });

  test("injects active skills and skills summary into the system prompt", () => {
    const result = buildContextMessages({
      identity: "Identity",
      currentMessage: "Use skills",
      runtime: { currentTime: "now" },
      skills: {
        activeSkillsContent: "### Skill: planner\n\nPlan the work.",
        skillsSummary: "<skills>\n  <skill available=\"true\"><name>planner</name></skill>\n</skills>",
        alwaysSkillNames: ["planner"],
        unavailableCount: 1,
        sourceCounts: { workspace: 1, builtin: 2 },
      },
    });

    expect(result.messages[0].content).toContain("# Active Skills\n\n### Skill: planner\n\nPlan the work.");
    expect(result.messages[0].content).toContain("# Skills");
    expect(result.messages[0].content).toContain("<skills>\n  <skill available=\"true\"><name>planner</name></skill>\n</skills>");
    expect(result.messages[0].content).not.toContain("(deferred in TS context phase 1)");
    expect(result.metadata).toMatchObject({
      skillsContextIncluded: true,
      skillsSummaryIncluded: true,
      alwaysSkillsIncluded: true,
      alwaysSkillNames: ["planner"],
      skillsUnavailableCount: 1,
      skillsSourceCounts: { workspace: 1, builtin: 2 },
    });
    expect(result.metadata.omittedContext).not.toContain("skills_detail");
  });
});
