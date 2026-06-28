import { describe, expect, test } from "vitest";

import {
  latestUserAssistantTurn,
  mergeUserProfile,
  shouldExtractUserProfile,
  turnFingerprint,
} from "./entityProfile.ts";

describe("entityProfile", () => {
  test("matches Python entity extraction signal and duplicate fingerprint semantics", () => {
    expect(shouldExtractUserProfile("")).toBe(false);
    expect(shouldExtractUserProfile("Please remember my email is ada@example.com")).toBe(true);
    expect(shouldExtractUserProfile("my name is Ada", {})).toBe(true);
    expect(turnFingerprint("  My   Name IS Ada  ")).toBe(turnFingerprint("my name is ada"));
  });

  test("merges scalar profile fields and union-merges list fields like Python", () => {
    expect(mergeUserProfile(
      {
        name: "Ada",
        preferences: ["short answers"],
        mentioned_entities: ["tinybot"],
      },
      {
        name: "Grace",
        communication_style: "concise",
        preferences: ["short answers", "code examples"],
        mentioned_entities: ["tinybot", "native app"],
        key_facts: ["uses uv"],
      },
    )).toEqual({
      name: "Grace",
      communication_style: "concise",
      preferences: ["short answers", "code examples"],
      mentioned_entities: ["tinybot", "native app"],
      key_facts: ["uses uv"],
    });
  });

  test("ignores delegated control and approval placeholder messages when selecting extraction turns", () => {
    expect(latestUserAssistantTurn([
      { role: "user", content: "my name is Ada" },
      {
        role: "assistant",
        content: "Waiting for approval.",
        metadata: {
          _delegate_event: true,
          _approval_status: "approval_required",
        },
      },
      {
        role: "tool",
        content: "Waiting for approval.",
        metadata: {
          _delegate_event: true,
        },
      },
      { role: "assistant", content: "Nice to meet you, Ada." },
    ])).toEqual({
      userMessage: "my name is Ada",
      assistantMessage: "Nice to meet you, Ada.",
    });

    expect(latestUserAssistantTurn([
      { role: "user", content: "my name is Ada" },
      { role: "assistant", content: "Waiting for approval.", metadata: { _delegate_event: true } },
    ])).toEqual({
      userMessage: "my name is Ada",
      assistantMessage: "",
    });
  });
});
