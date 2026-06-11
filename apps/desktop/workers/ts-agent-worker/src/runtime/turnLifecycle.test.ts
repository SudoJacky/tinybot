import { describe, expect, test } from "vitest";

import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import { RUNTIME_CONTEXT_TAG } from "../agent/contextBuilder.ts";
import { TurnLifecycle, type SessionBridge } from "./turnLifecycle.ts";

function spec(overrides: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    runId: "run-1",
    sessionId: "session-1",
    messages: [{ role: "user", content: "hello" }],
    model: "test-model",
    maxIterations: 2,
    stream: false,
    ...overrides,
  };
}

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    finalContent: "done",
    messages: [
      { role: "user", content: `${RUNTIME_CONTEXT_TAG}\nCurrent Time: now\n\nhello` },
      { role: "assistant", content: "done" },
    ],
    toolsUsed: [],
    stopReason: "final_response",
    ...overrides,
  };
}

describe("TurnLifecycle", () => {
  test("persists completed turns through session.persist_turn and returns lifecycle metadata", async () => {
    const persistedTurns: Array<{ sessionId: string; messages: AgentMessage[]; clearCheckpoint: boolean }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async () => undefined,
      persistTurn: async (sessionId, turn) => {
        persistedTurns.push({ sessionId, messages: turn.messages, clearCheckpoint: turn.clearCheckpoint });
        return {
          sessionId,
          messagesBefore: 0,
          messagesAfter: turn.messages.length,
          savedMessageCount: turn.messages.length,
          checkpointCleared: turn.clearCheckpoint,
          duplicateMessageCount: 0,
          truncatedToolResultCount: 0,
          omittedSideEffects: ["memory_extraction"],
        };
      },
      getCheckpoint: async () => null,
    };

    const lifecycle = new TurnLifecycle(bridge);
    const metadata = await lifecycle.finalizeTurn("trace-1", spec(), result());

    expect(persistedTurns).toEqual([
      {
        sessionId: "session-1",
        clearCheckpoint: true,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "done" },
        ],
      },
    ]);
    expect(metadata).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      stopReason: "final_response",
      checkpointCleared: true,
      persisted: true,
      savedMessageCount: 2,
      awaitingInput: false,
      omittedSideEffects: ["memory_extraction"],
    });
  });

  test("falls back to append_messages when persist_turn is unavailable", async () => {
    const appended: Array<{ sessionId: string; messages: AgentMessage[] }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async (sessionId, messages) => {
        appended.push({ sessionId, messages });
      },
      getCheckpoint: async () => null,
    };

    const lifecycle = new TurnLifecycle(bridge);
    const metadata = await lifecycle.finalizeTurn("trace-1", spec(), result());

    expect(appended).toEqual([
      {
        sessionId: "session-1",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "done" },
        ],
      },
    ]);
    expect(metadata?.checkpointCleared).toBe(true);
    expect(metadata?.savedMessageCount).toBe(2);
  });

  test("keeps checkpoints for awaiting input results", async () => {
    const persistedTurns: Array<{ clearCheckpoint: boolean }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async () => undefined,
      persistTurn: async (_sessionId, turn) => {
        persistedTurns.push({ clearCheckpoint: turn.clearCheckpoint });
        return {
          sessionId: "session-1",
          messagesBefore: 0,
          messagesAfter: turn.messages.length,
          savedMessageCount: turn.messages.length,
          checkpointCleared: false,
          duplicateMessageCount: 0,
          truncatedToolResultCount: 0,
          omittedSideEffects: [],
        };
      },
      getCheckpoint: async () => null,
    };

    const lifecycle = new TurnLifecycle(bridge);
    const metadata = await lifecycle.finalizeTurn("trace-1", spec(), result({ stopReason: "awaiting_form" }));

    expect(persistedTurns).toEqual([{ clearCheckpoint: false }]);
    expect(metadata?.awaitingInput).toBe(true);
    expect(metadata?.checkpointCleared).toBe(false);
  });
});
