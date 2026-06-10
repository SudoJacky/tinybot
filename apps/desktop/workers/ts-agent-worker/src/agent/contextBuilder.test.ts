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
});
