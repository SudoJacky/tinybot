import { describe, expect, test } from "vitest";

import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunnerCheckpoint } from "../agent/agentRunner.ts";
import { RUNTIME_CONTEXT_TAG } from "../agent/contextBuilder.ts";
import { TurnLifecycle, type MemoryEvidenceBridge, type SessionBridge } from "./turnLifecycle.ts";

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

function checkpoint(overrides: Partial<AgentRunnerCheckpoint> = {}): AgentRunnerCheckpoint {
  return {
    phase: "awaiting_tools",
    iteration: 1,
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
    assistantMessage: {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "lookup", arguments: "{}" }],
    },
    completedToolResults: [],
    pendingToolCalls: [{ id: "call-1", name: "lookup", arguments: "{}" }],
    ...overrides,
  };
}

describe("TurnLifecycle", () => {
  test("writes runner checkpoints through the session bridge with versioned payloads", async () => {
    const checkpointWrites: Array<{ sessionId: string; checkpoint: Record<string, unknown>; traceId: string }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async (sessionId, value, traceId) => {
        checkpointWrites.push({ sessionId, checkpoint: value, traceId });
      },
      clearCheckpoint: async () => undefined,
      appendMessages: async () => undefined,
      getCheckpoint: async () => null,
    };

    const lifecycle = new TurnLifecycle(bridge);
    await lifecycle.writeCheckpoint("trace-1", spec({ maxIterations: 4, stream: true }), checkpoint());

    expect(checkpointWrites).toEqual([
      {
        sessionId: "session-1",
        traceId: "trace-1",
        checkpoint: expect.objectContaining({
          version: 1,
          runId: "run-1",
          run_id: "run-1",
          phase: "awaiting_tools",
          maxIterations: 4,
          max_iterations: 4,
          stream: true,
          pendingToolCalls: [{ id: "call-1", name: "lookup", arguments: "{}" }],
          pending_tool_calls: [{ id: "call-1", name: "lookup", arguments: "{}" }],
        }),
      },
    ]);
  });

  test("clears checkpoints only when a session bridge and session id are available", async () => {
    const cleared: Array<{ sessionId: string; traceId: string }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async (sessionId, traceId) => {
        cleared.push({ sessionId, traceId });
      },
      appendMessages: async () => undefined,
      getCheckpoint: async () => null,
    };

    await new TurnLifecycle(bridge).clearCheckpoint("trace-1", spec());
    await new TurnLifecycle(bridge).clearCheckpoint("trace-2", spec({ sessionId: undefined }));
    await new TurnLifecycle(undefined).clearCheckpoint("trace-3", spec());

    expect(cleared).toEqual([{ sessionId: "session-1", traceId: "trace-1" }]);
  });

  test("restores interrupted checkpoints by appending materialized messages and clearing the checkpoint", async () => {
    const appended: Array<{ sessionId: string; messages: AgentMessage[]; traceId: string }> = [];
    const cleared: Array<{ sessionId: string; traceId: string }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async (sessionId, traceId) => {
        cleared.push({ sessionId, traceId });
      },
      appendMessages: async (sessionId, messages, traceId) => {
        appended.push({ sessionId, messages, traceId });
      },
      getCheckpoint: async () => ({
        runId: "run-1",
        phase: "awaiting_tools",
        iteration: 1,
        model: "test-model",
        assistantMessage: {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-pending", name: "lookup", argumentsJson: "{}" }],
        },
        completedToolResults: [
          { role: "tool", content: "finished", toolCallId: "call-done", name: "done_tool" },
        ],
        pendingToolCalls: [{ id: "call-pending", name: "lookup", argumentsJson: "{}" }],
      }),
    };

    const restored = await new TurnLifecycle(bridge).restoreCheckpoint("trace-1", "session-1");

    expect(restored).toMatchObject({
      checkpoint: expect.objectContaining({ runId: "run-1", phase: "awaiting_tools" }),
      restored: true,
      restoredMessageCount: 3,
    });
    expect(appended).toEqual([
      {
        sessionId: "session-1",
        traceId: "trace-1",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-pending", name: "lookup", argumentsJson: "{}" }],
          },
          { role: "tool", content: "finished", toolCallId: "call-done", name: "done_tool" },
          {
            role: "tool",
            content: "Error: Task interrupted before this tool finished.",
            toolCallId: "call-pending",
            name: "lookup",
          },
        ],
      },
    ]);
    expect(cleared).toEqual([{ sessionId: "session-1", traceId: "trace-1" }]);
  });

  test("keeps awaiting-input checkpoints during restore without appending pending transcript", async () => {
    const appended: Array<AgentMessage[]> = [];
    const cleared: string[] = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async (sessionId) => {
        cleared.push(sessionId);
      },
      appendMessages: async (_sessionId, messages) => {
        appended.push(messages);
      },
      getCheckpoint: async () => ({
        runId: "run-1",
        phase: "tools_completed",
        iteration: 1,
        model: "test-model",
        completedToolResults: [
          {
            role: "tool",
            content: "Waiting for form submission.",
            toolCallId: "call-form",
            name: "request_form",
            metadata: {
              awaitingUserInput: true,
              stopReason: "awaiting_form",
              formId: "travel_plan",
            },
          },
        ],
      }),
    };

    const restored = await new TurnLifecycle(bridge).restoreCheckpoint("trace-1", "session-1");

    expect(restored).toMatchObject({
      checkpoint: expect.objectContaining({ runId: "run-1", phase: "tools_completed" }),
      restored: true,
      restoredMessageCount: 0,
    });
    expect(appended).toEqual([]);
    expect(cleared).toEqual([]);
  });

  test("rejects unsupported checkpoint versions during restore", async () => {
    const appended: AgentMessage[][] = [];
    const cleared: string[] = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async (sessionId) => {
        cleared.push(sessionId);
      },
      appendMessages: async (_sessionId, messages) => {
        appended.push(messages);
      },
      getCheckpoint: async () => ({
        version: 2,
        runId: "run-newer",
        phase: "awaiting_tools",
        iteration: 1,
        model: "test-model",
      }),
    };

    await expect(new TurnLifecycle(bridge).restoreCheckpoint("trace-1", "session-1"))
      .rejects.toThrow("unsupported checkpoint version: 2");
    expect(appended).toEqual([]);
    expect(cleared).toEqual([]);
  });

  test("persists completed turns through session.persist_turn and returns lifecycle metadata", async () => {
    const persistedTurns: Array<{ sessionId: string; messages: AgentMessage[]; clearCheckpoint: boolean }> = [];
    const capturedEvidence: Array<{ sessionId: string; messages: AgentMessage[]; startIndex: number; traceId: string }> = [];
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
          omittedSideEffects: ["conversation_evidence", "memory_extraction"],
        };
      },
      getCheckpoint: async () => null,
    };
    const memoryBridge: MemoryEvidenceBridge = {
      captureEvidence: async (sessionId, request, traceId) => {
        capturedEvidence.push({
          sessionId,
          messages: request.messages,
          startIndex: request.startIndex,
          traceId,
        });
        return { evidence: [{ id: "ev-user" }, { id: "ev-assistant" }] };
      },
    };

    const lifecycle = new TurnLifecycle(bridge, memoryBridge);
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
    expect(capturedEvidence).toEqual([
      {
        sessionId: "session-1",
        traceId: "trace-1",
        startIndex: 0,
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
      evidenceCapturedCount: 2,
      omittedSideEffects: ["memory_extraction"],
    });
  });

  test("does not capture conversation evidence for duplicate-only persisted turns", async () => {
    const capturedEvidence: Array<{ messages: AgentMessage[]; startIndex: number }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async () => undefined,
      persistTurn: async (_sessionId, turn) => ({
        sessionId: "session-1",
        messagesBefore: 2,
        messagesAfter: 2,
        savedMessageCount: 0,
        checkpointCleared: turn.clearCheckpoint,
        duplicateMessageCount: turn.messages.length,
        truncatedToolResultCount: 0,
        omittedSideEffects: ["conversation_evidence"],
      }),
      getCheckpoint: async () => null,
    };
    const memoryBridge: MemoryEvidenceBridge = {
      captureEvidence: async (_sessionId, request) => {
        capturedEvidence.push({ messages: request.messages, startIndex: request.startIndex });
        return { evidence: [{ id: "duplicate-ev" }] };
      },
    };

    const metadata = await new TurnLifecycle(bridge, memoryBridge).finalizeTurn("trace-1", spec(), result());

    expect(capturedEvidence).toEqual([]);
    expect(metadata?.savedMessageCount).toBe(0);
    expect(metadata?.evidenceCapturedCount).toBe(0);
    expect(metadata?.omittedSideEffects).toContain("conversation_evidence");
  });

  test("captures actual saved messages when persisted turn skips non-tail duplicates", async () => {
    const capturedEvidence: Array<{ messages: AgentMessage[]; startIndex: number }> = [];
    const savedMessages: AgentMessage[] = [
      { role: "assistant", content: "new middle note" },
    ];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async () => undefined,
      persistTurn: async (_sessionId, turn) => ({
        sessionId: "session-1",
        messagesBefore: 3,
        messagesAfter: 4,
        savedMessageCount: savedMessages.length,
        checkpointCleared: turn.clearCheckpoint,
        duplicateMessageCount: turn.messages.length - savedMessages.length,
        truncatedToolResultCount: 0,
        omittedSideEffects: ["conversation_evidence"],
        savedMessages,
      }),
      getCheckpoint: async () => null,
    };
    const memoryBridge: MemoryEvidenceBridge = {
      captureEvidence: async (_sessionId, request) => {
        capturedEvidence.push({ messages: request.messages, startIndex: request.startIndex });
        return { evidence: [{ id: "ev-1" }] };
      },
    };
    const turnResult = result({
      messages: [
        { role: "user", content: "already saved" },
        { role: "assistant", content: "new middle note" },
        { role: "assistant", content: "already saved tail" },
      ],
    });

    const metadata = await new TurnLifecycle(bridge, memoryBridge).finalizeTurn("trace-1", spec(), turnResult);

    expect(capturedEvidence).toEqual([
      {
        startIndex: 3,
        messages: savedMessages,
      },
    ]);
    expect(metadata?.savedMessageCount).toBe(1);
    expect(metadata?.evidenceCapturedCount).toBe(1);
    expect(metadata?.omittedSideEffects).toEqual([]);
  });

  test("falls back to append_messages when persist_turn is unavailable", async () => {
    const appended: Array<{ sessionId: string; messages: AgentMessage[] }> = [];
    const clearedCheckpoints: string[] = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async (sessionId) => {
        clearedCheckpoints.push(sessionId);
      },
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
    expect(clearedCheckpoints).toEqual(["session-1"]);
    expect(metadata?.checkpointCleared).toBe(true);
    expect(metadata?.savedMessageCount).toBe(2);
  });

  test("updates user profile after a completed turn and records the duplicate fingerprint", async () => {
    const profileUpdates: Array<{ sessionId: string; profile: Record<string, unknown>; metadata: Record<string, unknown>; traceId: string }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async () => undefined,
      persistTurn: async (_sessionId, turn) => ({
        sessionId: "session-1",
        messagesBefore: 0,
        messagesAfter: turn.messages.length,
        savedMessageCount: turn.messages.length,
        checkpointCleared: turn.clearCheckpoint,
        duplicateMessageCount: 0,
        truncatedToolResultCount: 0,
        omittedSideEffects: [],
      }),
      getCheckpoint: async () => null,
    };
    const profileBridge = {
      getUserProfile: async () => ({
        profile: { preferences: ["short answers"] },
        metadata: {},
      }),
      updateUserProfile: async (
        sessionId: string,
        request: { profile: Record<string, unknown>; metadata: Record<string, unknown> },
        traceId: string,
      ) => {
        profileUpdates.push({ sessionId, profile: request.profile, metadata: request.metadata, traceId });
      },
    };
    const extractor = {
      extract: async () => ({
        name: "Ada",
        preferences: ["short answers", "code examples"],
      }),
    };

    const lifecycle = new TurnLifecycle(bridge, undefined, profileBridge, extractor);
    const metadata = await lifecycle.finalizeTurn(
      "trace-profile",
      spec({ messages: [{ role: "user", content: "my name is Ada" }] }),
      result({
        messages: [
          { role: "user", content: "my name is Ada" },
          { role: "assistant", content: "Nice to meet you, Ada." },
        ],
      }),
    );

    expect(profileUpdates).toEqual([
      {
        sessionId: "session-1",
        traceId: "trace-profile",
        profile: {
          name: "Ada",
          preferences: ["short answers", "code examples"],
        },
        metadata: {
          entity_extractor_last_turn_hash: expect.any(String),
        },
      },
    ]);
    expect(metadata?.omittedSideEffects).not.toContain("user_profile");
  });

  test("uses append fallback session size as the evidence start index", async () => {
    const capturedEvidence: Array<{ startIndex: number; messages: AgentMessage[] }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async () => ({
        sessionId: "session-1",
        messagesBefore: 5,
        messagesAfter: 7,
        savedMessageCount: 2,
      }),
      getCheckpoint: async () => null,
    };
    const memoryBridge: MemoryEvidenceBridge = {
      captureEvidence: async (_sessionId, request) => {
        capturedEvidence.push({ startIndex: request.startIndex, messages: request.messages });
        return { evidence: [{ id: "ev-1" }] };
      },
    };

    const metadata = await new TurnLifecycle(bridge, memoryBridge).finalizeTurn("trace-1", spec(), result());

    expect(capturedEvidence).toEqual([
      {
        startIndex: 5,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "done" },
        ],
      },
    ]);
    expect(metadata?.savedMessageCount).toBe(2);
    expect(metadata?.omittedSideEffects).toEqual([]);
  });

  test("does not capture conversation evidence for duplicate-only append fallback turns", async () => {
    const capturedEvidence: Array<{ startIndex: number; messages: AgentMessage[] }> = [];
    const bridge: SessionBridge = {
      setCheckpoint: async () => undefined,
      clearCheckpoint: async () => undefined,
      appendMessages: async () => ({
        sessionId: "session-1",
        messagesBefore: 2,
        messagesAfter: 2,
        savedMessageCount: 0,
      }),
      getCheckpoint: async () => null,
    };
    const memoryBridge: MemoryEvidenceBridge = {
      captureEvidence: async (_sessionId, request) => {
        capturedEvidence.push({ startIndex: request.startIndex, messages: request.messages });
        return { evidence: [{ id: "duplicate-ev" }] };
      },
    };

    const metadata = await new TurnLifecycle(bridge, memoryBridge).finalizeTurn("trace-1", spec(), result());

    expect(capturedEvidence).toEqual([]);
    expect(metadata?.savedMessageCount).toBe(0);
    expect(metadata?.evidenceCapturedCount).toBe(0);
    expect(metadata?.omittedSideEffects).toContain("conversation_evidence");
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
