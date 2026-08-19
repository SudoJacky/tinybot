import { describe, expect, test } from "vitest";
import {
  normalizeTinyOsEffectiveCapabilities,
  unavailableTinyOsEffectiveCapabilities,
} from "./tinyOsCapabilities";

function backendCapabilities() {
  return {
    schemaVersion: "tinybot.effective_capabilities.v2",
    threadId: "thread-1",
    evaluatedTurnId: "turn-1",
    capabilities: {
      agent: {
        cancel: { available: true },
        retry: {
          available: false,
          reason: "The active turn is not failed.",
          reasonCode: "turn_not_failed",
        },
      },
      futureCapabilityGroup: { available: true },
    },
  };
}

describe("chat runtime capabilities", () => {
  test("normalizes only the decisions used by Chat", () => {
    expect(normalizeTinyOsEffectiveCapabilities(backendCapabilities(), "thread-1")).toEqual({
      schemaVersion: "tinybot.effective_capabilities.v2",
      threadId: "thread-1",
      evaluatedTurnId: "turn-1",
      capabilities: {
        agent: {
          cancel: { available: true },
          retry: {
            available: false,
            reason: "The active turn is not failed.",
            reasonCode: "turn_not_failed",
          },
        },
      },
    });
  });

  test("rejects mismatched threads and unavailable decisions without reasons", () => {
    expect(() => normalizeTinyOsEffectiveCapabilities(backendCapabilities(), "thread-other"))
      .toThrow(/thread mismatch/i);
    const invalid = backendCapabilities();
    invalid.capabilities.agent.retry = { available: false } as typeof invalid.capabilities.agent.retry;
    expect(() => normalizeTinyOsEffectiveCapabilities(invalid, "thread-1"))
      .toThrow(/without a reason/i);
  });

  test("creates a fail-closed state while capability truth is unavailable", () => {
    expect(unavailableTinyOsEffectiveCapabilities("thread-1", "loading", "Loading")).toEqual({
      schemaVersion: "tinybot.effective_capabilities.v2",
      threadId: "thread-1",
      capabilities: {
        agent: {
          cancel: { available: false, reason: "Loading", reasonCode: "loading" },
          retry: { available: false, reason: "Loading", reasonCode: "loading" },
        },
      },
    });
  });
});
