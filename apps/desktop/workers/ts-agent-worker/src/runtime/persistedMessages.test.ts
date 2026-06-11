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
});
