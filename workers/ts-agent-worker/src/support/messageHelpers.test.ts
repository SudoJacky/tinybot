import { describe, expect, test } from "vitest";

import {
  buildAssistantMessage,
  currentTimeString,
  splitMessage,
  stringifyTextBlocks,
  stripThink,
  truncateText,
} from "./messageHelpers";

describe("messageHelpers", () => {
  test("formats current time with timezone name and UTC offset", () => {
    const now = new Date("2026-06-11T04:05:00.000Z");

    expect(currentTimeString("Asia/Shanghai", now)).toBe("2026-06-11 12:05 (Thursday) (Asia/Shanghai, UTC+08:00)");
  });

  test("falls back to local timezone formatting when timezone is invalid", () => {
    const now = new Date("2026-06-11T04:05:00.000Z");

    expect(currentTimeString("Not/AZone", now)).toMatch(
      /^2026-06-11 \d\d:05 \(Thursday\) \(Not\/AZone, UTC[+-]\d\d:\d\d\)$/,
    );
  });

  test("truncates text with the legacy suffix", () => {
    expect(truncateText("abcdef", 3)).toBe("abc\n... (truncated)");
    expect(truncateText("abcdef", 0)).toBe("abcdef");
    expect(truncateText("abc", 5)).toBe("abc");
  });

  test("stringifies text-only content blocks", () => {
    expect(stringifyTextBlocks([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ])).toBe("first\nsecond");
    expect(stringifyTextBlocks([{ type: "image", url: "file://image.png" }])).toBeUndefined();
    expect(stringifyTextBlocks([{ type: "text", text: 42 }])).toBeUndefined();
  });

  test("splits long messages at newline, space, or hard limit", () => {
    expect(splitMessage("", 5)).toEqual([]);
    expect(splitMessage("short", 10)).toEqual(["short"]);
    expect(splitMessage("line one\nline two", 10)).toEqual(["line one", "line two"]);
    expect(splitMessage("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
    expect(splitMessage("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  test("builds assistant messages with optional reasoning and thinking fields", () => {
    expect(buildAssistantMessage("answer")).toEqual({ role: "assistant", content: "answer" });
    expect(buildAssistantMessage(null, {
      toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
      reasoningContent: "reasoning",
      thinkingBlocks: [{ type: "thinking", text: "trace" }],
    })).toEqual({
      role: "assistant",
      content: null,
      toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
      reasoningContent: "reasoning",
      thinkingBlocks: [{ type: "thinking", text: "trace" }],
    });
  });

  test("strips closed and dangling think blocks", () => {
    expect(stripThink("before <think>hidden</think> after")).toBe("before  after");
    expect(stripThink("answer <think>unfinished")).toBe("answer");
  });
});
