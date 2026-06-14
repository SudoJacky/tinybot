import { describe, expect, test } from "vitest";

import {
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
});
