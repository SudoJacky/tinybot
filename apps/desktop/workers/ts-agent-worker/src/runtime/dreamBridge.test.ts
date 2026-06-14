import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { NativeDreamBridge, ProviderBackedDreamBridge } from "./dreamBridge";

function rpcClient(result: unknown) {
  const calls: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      request: async (traceId: string, method: string, params: Record<string, unknown>) => {
        calls.push({ traceId, method, params });
        return result;
      },
    },
  };
}

function sequenceRpcClient(results: unknown[]) {
  const calls: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      request: async (traceId: string, method: string, params: Record<string, unknown>) => {
        calls.push({ traceId, method, params });
        if (results.length === 0) {
          throw new Error(`unexpected native request: ${method}`);
        }
        return results.shift();
      },
    },
  };
}

class RecordingProvider implements ModelProvider {
  readonly requests: Array<{ messages: AgentMessage[]; options?: ModelRequestOptions }> = [];

  constructor(private readonly response: ModelResponse) {}

  async complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    this.requests.push({ messages, options });
    return this.response;
  }
}

describe("NativeDreamBridge", () => {
  test("runs Dream through native memory RPC", async () => {
    const { client, calls } = rpcClient({ content: "Dream completed." });
    const bridge = new NativeDreamBridge(client);

    const result = await bridge.runDream({ traceId: "trace-1", sessionId: "session-1" });

    expect(calls).toEqual([
      {
        traceId: "trace-1",
        method: "memory.dream_run",
        params: { session_id: "session-1" },
      },
    ]);
    expect(result).toEqual({ content: "Dream completed.", metadata: undefined });
  });

  test("reads Dream log through native memory RPC", async () => {
    const { client, calls } = rpcClient({
      content: "## Dream Update",
      metadata: { source: "native" },
    });
    const bridge = new NativeDreamBridge(client);

    const result = await bridge.getDreamLog({ traceId: "trace-2", sessionId: "session-1", sha: "abc123" });

    expect(calls).toEqual([
      {
        traceId: "trace-2",
        method: "memory.dream_log",
        params: { session_id: "session-1", sha: "abc123" },
      },
    ]);
    expect(result).toEqual({ content: "## Dream Update", metadata: { source: "native" } });
  });

  test("restores Dream memory through native memory RPC", async () => {
    const { client, calls } = rpcClient({ content: "## Dream Restore" });
    const bridge = new NativeDreamBridge(client);

    const result = await bridge.restoreDream({ traceId: "trace-3", sessionId: undefined });

    expect(calls).toEqual([
      {
        traceId: "trace-3",
        method: "memory.dream_restore",
        params: {},
      },
    ]);
    expect(result).toEqual({ content: "## Dream Restore", metadata: undefined });
  });

  test("reads pending Dream batches through native memory RPC", async () => {
    const { client, calls } = rpcClient({
      kind: "conversation_evidence",
      records: [{ id: "ev_1", content: "We discussed the runtime." }],
      cursor_start: 3,
      cursor_end: 3,
    });
    const bridge = new NativeDreamBridge(client);

    const result = await bridge.getPendingDreamBatch({ traceId: "trace-4", sessionId: "session-1" });

    expect(calls).toEqual([
      {
        traceId: "trace-4",
        method: "memory.dream_pending",
        params: { session_id: "session-1" },
      },
    ]);
    expect(result).toEqual({
      kind: "conversation_evidence",
      records: [{ id: "ev_1", content: "We discussed the runtime." }],
      cursor_start: 3,
      cursor_end: 3,
    });
  });

  test("applies provider Dream batches through native memory RPC", async () => {
    const { client, calls } = rpcClient({
      changed: true,
      applied_notes: 1,
      last_evidence_cursor: 5,
    });
    const bridge = new NativeDreamBridge(client);

    const result = await bridge.applyDreamBatch({
      traceId: "trace-5",
      sessionId: "session-1",
      kind: "conversation_evidence",
      cursorStart: 3,
      cursorEnd: 5,
      evidenceIds: ["ev_1", "ev_2"],
      notes: [
        {
          content: "User prefers focused migration slices.",
          noteType: "preference",
          scope: "user",
        },
      ],
    });

    expect(calls).toEqual([
      {
        traceId: "trace-5",
        method: "memory.dream_apply",
        params: {
          session_id: "session-1",
          kind: "conversation_evidence",
          cursor_start: 3,
          cursor_end: 5,
          evidence_ids: ["ev_1", "ev_2"],
          notes: [
            {
              content: "User prefers focused migration slices.",
              note_type: "preference",
              scope: "user",
            },
          ],
        },
      },
    ]);
    expect(result).toEqual({
      changed: true,
      applied_notes: 1,
      last_evidence_cursor: 5,
    });
  });
});

describe("ProviderBackedDreamBridge", () => {
  test("uses provider JSON operations for deferred conversation evidence and applies them natively", async () => {
    const { client, calls } = sequenceRpcClient([
      {
        content: "Dream deferred 1 conversation evidence record(s) for provider-backed memory extraction.",
        metadata: { deferred: true, pending_evidence: 1 },
      },
      {
        kind: "conversation_evidence",
        records: [
          {
            id: "ev_1",
            turn_id: "turn_1",
            session_key: "desktop:session-1",
            role: "user",
            content: "Please remember I prefer compact migration slices.",
            cursor: 3,
            message_index: 1,
          },
        ],
        cursor_start: 3,
        cursor_end: 3,
        evidence_ids: ["ev_1"],
        memory_context: {
          current_notes: "- id=note_user_pref status=active scope=user type=preference priority=0.8 confidence=0.9: User prefers compact migration slices.",
          current_memory: "Project memory view\n",
          current_soul: "Assistant memory view\n",
          current_user: "User memory view\n",
        },
      },
      {
        changed: true,
        applied_notes: 1,
        last_evidence_cursor: 3,
      },
    ]);
    const provider = new RecordingProvider({
      content: JSON.stringify([
        {
          action: "save",
          scope: "user",
          type: "preference",
          content: "User prefers compact migration slices.",
          priority: 0.7,
          confidence: 0.8,
          evidence_ids: ["ev_1"],
          tags: ["dream"],
          metadata: { reason: "explicit preference" },
        },
        { action: "skip", scope: "project", type: "project", content: "" },
      ]),
      toolCalls: [],
      stopReason: "stop",
    });
    const bridge = new ProviderBackedDreamBridge({
      nativeBridge: new NativeDreamBridge(client),
      provider,
      model: "dream-model",
    });

    const result = await bridge.runDream({ traceId: "trace-dream", sessionId: "session-1" });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.options?.model).toBe("dream-model");
    expect(provider.requests[0]?.messages[0]?.role).toBe("system");
    expect(provider.requests[0]?.messages[0]?.content).toContain("Output ONLY a JSON array");
    expect(provider.requests[0]?.messages[1]?.content).toContain("## Conversation Evidence");
    expect(provider.requests[0]?.messages[1]?.content).toContain("[ev_1] cursor=3");
    expect(provider.requests[0]?.messages[1]?.content).toContain("## Current Memory Notes");
    expect(provider.requests[0]?.messages[1]?.content).toContain("id=note_user_pref status=active");
    expect(provider.requests[0]?.messages[1]?.content).toContain("## Current MEMORY.md");
    expect(provider.requests[0]?.messages[1]?.content).toContain("Project memory view");
    expect(provider.requests[0]?.messages[1]?.content).toContain("## Current SOUL.md");
    expect(provider.requests[0]?.messages[1]?.content).toContain("Assistant memory view");
    expect(provider.requests[0]?.messages[1]?.content).toContain("## Current USER.md");
    expect(provider.requests[0]?.messages[1]?.content).toContain("User memory view");
    expect(calls).toEqual([
      {
        traceId: "trace-dream",
        method: "memory.dream_run",
        params: { session_id: "session-1" },
      },
      {
        traceId: "trace-dream",
        method: "memory.dream_pending",
        params: { session_id: "session-1" },
      },
      {
        traceId: "trace-dream",
        method: "memory.dream_apply",
        params: {
          session_id: "session-1",
          kind: "conversation_evidence",
          cursor_start: 3,
          cursor_end: 3,
          evidence_ids: ["ev_1"],
          notes: [
            {
              action: "save",
              content: "User prefers compact migration slices.",
              note_type: "preference",
              scope: "user",
              priority: 0.7,
              confidence: 0.8,
              tags: ["dream"],
              metadata: { reason: "explicit preference" },
              evidence_ids: ["ev_1"],
            },
          ],
        },
      },
    ]);
    expect(result).toEqual({
      content: "Dream applied 1 provider memory note operation(s) from 1 conversation evidence record(s).",
      metadata: {
        changed: true,
        provider_backed: true,
        applied_notes: 1,
        skipped_operations: 1,
        last_evidence_cursor: 3,
      },
    });
  });

  test("accepts a single provider JSON operation object like Python Dream", async () => {
    const { client, calls } = sequenceRpcClient([
      {
        content: "Dream deferred 1 legacy history record(s) for provider-backed memory extraction.",
        metadata: { deferred: true, pending_legacy_history: 1 },
      },
      {
        kind: "legacy_history",
        records: [{ cursor: 4, timestamp: "2026-06-13 12:00", content: "User prefers direct handoffs." }],
        cursor_start: 4,
        cursor_end: 4,
      },
      {
        changed: true,
        applied_notes: 1,
        last_dream_cursor: 4,
      },
    ]);
    const provider = new RecordingProvider({
      content: JSON.stringify({
        action: "save",
        scope: "user",
        type: "preference",
        content: "User prefers direct handoffs.",
        priority: 0.75,
        confidence: 0.85,
        tags: ["dream"],
        metadata: { reason: "legacy history" },
      }),
      toolCalls: [],
      stopReason: "stop",
    });
    const bridge = new ProviderBackedDreamBridge({
      nativeBridge: new NativeDreamBridge(client),
      provider,
      model: "dream-model",
    });

    const result = await bridge.runDream({ traceId: "trace-dream", sessionId: "session-1" });

    expect(calls.map((call) => call.method)).toEqual(["memory.dream_run", "memory.dream_pending", "memory.dream_apply"]);
    expect(calls[2]?.params).toMatchObject({
      session_id: "session-1",
      kind: "legacy_history",
      cursor_start: 4,
      cursor_end: 4,
      notes: [
        expect.objectContaining({
          action: "save",
          content: "User prefers direct handoffs.",
          note_type: "preference",
          scope: "user",
        }),
      ],
    });
    expect(result).toEqual({
      content: "Dream applied 1 provider memory note operation(s) from 1 legacy history record(s).",
      metadata: {
        changed: true,
        provider_backed: true,
        applied_notes: 1,
        skipped_operations: 0,
        last_dream_cursor: 4,
      },
    });
  });

  test("ignores provider JSON operations with unsupported actions like Python Dream", async () => {
    const { client, calls } = sequenceRpcClient([
      {
        content: "Dream deferred 1 conversation evidence record(s) for provider-backed memory extraction.",
        metadata: { deferred: true, pending_evidence: 1 },
      },
      {
        kind: "conversation_evidence",
        records: [{ id: "ev_1", cursor: 9, content: "Temporary note." }],
        cursor_start: 9,
        cursor_end: 9,
        evidence_ids: ["ev_1"],
      },
      {
        changed: false,
        applied_notes: 0,
        last_evidence_cursor: 9,
      },
    ]);
    const provider = new RecordingProvider({
      content: JSON.stringify([
        {
          action: "delete",
          scope: "user",
          type: "preference",
          content: "Unsupported action must not save this.",
          evidence_ids: ["ev_1"],
        },
        {
          action: "skip",
          scope: "project",
          type: "project",
          content: "",
          evidence_ids: [],
        },
      ]),
      toolCalls: [],
      stopReason: "stop",
    });
    const bridge = new ProviderBackedDreamBridge({
      nativeBridge: new NativeDreamBridge(client),
      provider,
      model: "dream-model",
    });

    const result = await bridge.runDream({ traceId: "trace-dream", sessionId: "session-1" });

    expect(calls.map((call) => call.method)).toEqual(["memory.dream_run", "memory.dream_pending", "memory.dream_apply"]);
    expect(calls[2]?.params).toMatchObject({
      session_id: "session-1",
      kind: "conversation_evidence",
      cursor_start: 9,
      cursor_end: 9,
      evidence_ids: ["ev_1"],
      notes: [],
    });
    expect(result).toEqual({
      content: "Dream applied 0 provider memory note operation(s) from 1 conversation evidence record(s).",
      metadata: {
        changed: false,
        provider_backed: true,
        applied_notes: 0,
        skipped_operations: 1,
        last_evidence_cursor: 9,
      },
    });
  });

  test("leaves deferred cursors untouched when provider output is not JSON operations", async () => {
    const { client, calls } = sequenceRpcClient([
      {
        content: "Dream deferred 1 legacy history record(s) for provider-backed memory extraction.",
        metadata: { deferred: true, pending_legacy_history: 1 },
      },
      {
        kind: "legacy_history",
        records: [{ cursor: 4, timestamp: "2026-06-13 12:00", content: "Discussed transient UI state." }],
        cursor_start: 4,
        cursor_end: 4,
      },
    ]);
    const provider = new RecordingProvider({ content: "No durable memory.", toolCalls: [], stopReason: "stop" });
    const bridge = new ProviderBackedDreamBridge({
      nativeBridge: new NativeDreamBridge(client),
      provider,
      model: "dream-model",
    });

    const result = await bridge.runDream({ traceId: "trace-dream", sessionId: undefined });

    expect(calls.map((call) => call.method)).toEqual(["memory.dream_run", "memory.dream_pending"]);
    expect(result.content).toBe("Dream provider extraction failed; cursor unchanged.");
    expect(result.metadata).toMatchObject({
      changed: false,
      provider_backed: true,
      deferred: true,
      error: "invalid_provider_json",
    });
  });
});
