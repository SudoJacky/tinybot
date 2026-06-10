import { describe, expect, test } from "vitest";

import { NativeContextBridge } from "./contextBridge";
import type { AgentRunInput } from "../agent/contextTypes";
import type { JsonObject } from "../protocol/messages";

class FakeRpcClient {
  readonly calls: Array<{ traceId: string; method: string; params: JsonObject }> = [];

  constructor(private readonly responses: Record<string, unknown | Error>) {}

  async request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    this.calls.push({ traceId, method, params });
    const response = this.responses[method];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

function runInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: "run-1",
    sessionId: "session-1",
    input: { content: "Continue" },
    model: "test-model",
    maxIterations: 2,
    stream: false,
    ...overrides,
  };
}

describe("NativeContextBridge", () => {
  test("loads runtime, session history, user profile, and bootstrap files from native RPC", async () => {
    const rpcClient = new FakeRpcClient({
      "runtime.now": { current_time: "2026-06-10 09:00:00 Asia/Shanghai" },
      "session.get_history": {
        session_id: "session-1",
        messages: [
          { role: "user", content: "Earlier" },
          { role: "unknown", content: "bad role" },
          { role: "assistant", content: 42 },
        ],
        user_profile: {
          name: "Ada",
          preferences: ["concise"],
          mentioned_entities: ["tinybot"],
        },
      },
      "workspace.read_bootstrap_files": {
        files: [{ path: "AGENTS.md", contents: "Agent rules" }],
        missing: ["TOOLS.md"],
      },
    });
    const bridge = new NativeContextBridge(rpcClient);

    const result = await bridge.loadContextInput(runInput({ channel: "desktop", chatId: "chat-1" }), "trace-1");

    expect(rpcClient.calls.map((call) => call.method)).toEqual([
      "runtime.now",
      "session.get_history",
      "workspace.read_bootstrap_files",
    ]);
    expect(result.input).toMatchObject({
      identity: expect.stringContaining("TinyBot"),
      currentMessage: "Continue",
      history: [{ role: "user", content: "Earlier" }],
      bootstrapFiles: [{ path: "AGENTS.md", contents: "Agent rules" }],
      runtime: {
        currentTime: "2026-06-10 09:00:00 Asia/Shanghai",
        channel: "desktop",
        chatId: "chat-1",
        userProfile: {
          name: "Ada",
          preferences: ["concise"],
          mentionedEntities: ["tinybot"],
        },
      },
    });
    expect(result.metadata).toEqual({
      missingSession: false,
      malformedHistoryCount: 2,
      missingBootstrapFiles: ["TOOLS.md"],
      bootstrapFallbackUsed: false,
    });
  });

  test("falls back to per-file bootstrap reads when the batch RPC is unavailable", async () => {
    const rpcClient = new FakeRpcClient({
      "runtime.now": { current_time: "fixed now" },
      "session.get_history": new Error("session metadata not found"),
      "workspace.read_bootstrap_files": new Error("unknown worker method"),
      "workspace.read_file": { path: "AGENTS.md", contents: "Agent rules" },
    });
    const bridge = new NativeContextBridge(rpcClient);

    const result = await bridge.loadContextInput(runInput(), "trace-1");

    expect(rpcClient.calls.map((call) => call.method)).toEqual([
      "runtime.now",
      "session.get_history",
      "workspace.read_bootstrap_files",
      "workspace.read_file",
      "workspace.read_file",
      "workspace.read_file",
      "workspace.read_file",
    ]);
    expect(result.input.history).toEqual([]);
    expect(result.input.bootstrapFiles).toEqual([{ path: "AGENTS.md", contents: "Agent rules" }]);
    expect(result.metadata).toMatchObject({
      missingSession: true,
      bootstrapFallbackUsed: true,
    });
  });
});
