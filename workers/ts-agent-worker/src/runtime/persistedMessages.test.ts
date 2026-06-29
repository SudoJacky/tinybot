import { describe, expect, test } from "vitest";

import { RUNTIME_CONTEXT_TAG } from "../agent/contextBuilder.ts";
import { persistedSessionMessages } from "./persistedMessages.ts";

describe("persistedSessionMessages", () => {
  test("strips runtime context and omits non-history messages before session persistence", () => {
    expect(persistedSessionMessages([
      { role: "system", content: "System prompt" },
      { role: "user", content: `${RUNTIME_CONTEXT_TAG}\nCurrent Time: now\n\nContinue` },
      { role: "assistant", content: "" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }] },
      { role: "tool", content: "README contents", toolCallId: "call-1", name: "read_file" },
    ])).toEqual([
      { role: "user", content: "Continue" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{}" }] },
      { role: "tool", content: "README contents", toolCallId: "call-1", name: "read_file" },
    ]);
  });

  test("deduplicates persisted user assistant and tool messages by legacy session keys", () => {
    expect(persistedSessionMessages([
      { role: "user", content: "Repeat this" },
      { role: "user", content: "Repeat this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
      },
      { role: "tool", content: "README contents", toolCallId: "call-1", name: "read_file" },
      { role: "tool", content: "README contents again", toolCallId: "call-1", name: "read_file" },
    ])).toEqual([
      { role: "user", content: "Repeat this" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
      },
      { role: "tool", content: "README contents", toolCallId: "call-1", name: "read_file" },
    ]);
  });

  test("truncates oversized tool results before session persistence", () => {
    expect(persistedSessionMessages([
      { role: "tool", content: "abcdef", toolCallId: "call-1", name: "read_file" },
    ], { maxToolResultChars: 3 })).toEqual([
      { role: "tool", content: "abc\n... (truncated)", toolCallId: "call-1", name: "read_file" },
    ]);
  });
});
