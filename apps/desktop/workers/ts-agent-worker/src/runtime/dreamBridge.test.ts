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
});
