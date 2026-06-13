import { describe, expect, test } from "vitest";

import { NativeDreamBridge } from "./dreamBridge";

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
