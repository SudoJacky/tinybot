import { describe, expect, test } from "vitest";

import { buildStatusContent } from "./statusFormatter";

describe("statusFormatter", () => {
  test("builds legacy-compatible runtime status content", () => {
    expect(buildStatusContent({
      version: "1.2.3",
      model: "gpt-4.1-mini",
      startTimeMs: 1_000,
      nowMs: 65_000,
      lastUsage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        cached_tokens: 40,
      },
      contextWindowTokens: 8192,
      sessionMessageCount: 7,
      contextTokensEstimate: 1536,
    })).toBe([
      "tinybot v1.2.3",
      "Model: gpt-4.1-mini",
      "Tokens: 100 in / 25 out (40% cached)",
      "Context: 1k/8k (18%)",
      "Session: 7 messages",
      "Uptime: 1m 4s",
    ].join("\n"));
  });

  test("formats hour-scale uptime and missing context window", () => {
    expect(buildStatusContent({
      version: "1.2.3",
      model: "fixture",
      startTimeMs: 0,
      nowMs: 3_700_000,
      lastUsage: {},
      contextWindowTokens: 0,
      sessionMessageCount: 0,
      contextTokensEstimate: 12,
    })).toContain("Context: 12/n/a (0%)\nSession: 0 messages\nUptime: 1h 1m");
  });
});
