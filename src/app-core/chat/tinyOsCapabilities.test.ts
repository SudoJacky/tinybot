import { describe, expect, test } from "vitest";
import {
  normalizeTinyOsEffectiveCapabilities,
  unavailableTinyOsEffectiveCapabilities,
} from "./tinyOsCapabilities";

function payload() {
  const unavailable = { available: false, reasonCode: "runtime_unsupported", reason: "Not supported." };
  const available = { available: true };
  return {
    schemaVersion: "tinybot.effective_capabilities.v1",
    sessionId: "websocket:chat-1",
    evaluatedRunId: "run-1",
    capabilities: {
      agent: { pause: unavailable, resume: unavailable, cancel: available, retry: unavailable },
      files: { read: available, requestChange: unavailable, directEdit: unavailable, save: unavailable },
      terminal: { inspect: available, execute: unavailable, cancel: unavailable },
      browser: { structured: available, realCapture: unavailable, interact: unavailable },
    },
  };
}

describe("TinyOS effective capabilities", () => {
  test("normalizes a backend-authored per-session decision", () => {
    expect(normalizeTinyOsEffectiveCapabilities(payload(), "websocket:chat-1")).toMatchObject({
      evaluatedRunId: "run-1",
      capabilities: { agent: { cancel: { available: true } } },
    });
  });

  test("rejects mismatched sessions and unavailable decisions without reasons", () => {
    expect(() => normalizeTinyOsEffectiveCapabilities(payload(), "websocket:chat-2")).toThrow("session mismatch");
    const invalid = payload();
    invalid.capabilities.agent.pause = { available: false } as typeof invalid.capabilities.agent.pause;
    expect(() => normalizeTinyOsEffectiveCapabilities(invalid, "websocket:chat-1")).toThrow("without a reason");
  });

  test("creates a fail-closed state while backend capability truth is unavailable", () => {
    const unavailable = unavailableTinyOsEffectiveCapabilities("websocket:chat-1", "loading", "Loading capabilities.");
    expect(unavailable.capabilities.agent.cancel).toEqual({
      available: false,
      reason: "Loading capabilities.",
      reasonCode: "loading",
    });
  });
});
