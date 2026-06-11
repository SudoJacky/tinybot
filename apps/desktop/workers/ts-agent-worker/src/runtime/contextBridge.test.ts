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
      "config.snapshot_public": { value: { agents: { defaults: { provider_retry_mode: "standard" } } } },
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
      "config.snapshot_public",
      "session.get_history",
      "workspace.read_bootstrap_files",
      "skills.list",
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

  test("loads provider retry mode from native config defaults for run input projection", async () => {
    const rpcClient = new FakeRpcClient({
      "runtime.now": { current_time: "fixed now" },
      "config.snapshot_public": { value: { agents: { defaults: { provider_retry_mode: "persistent" } } } },
      "session.get_history": { session_id: "session-1", messages: [] },
      "workspace.read_bootstrap_files": { files: [], missing: [] },
    });
    const bridge = new NativeContextBridge(rpcClient);

    const result = await bridge.loadContextInput(runInput({ providerRetryMode: undefined }), "trace-1");

    expect(rpcClient.calls.map((call) => call.method)).toEqual([
      "runtime.now",
      "config.snapshot_public",
      "session.get_history",
      "workspace.read_bootstrap_files",
      "skills.list",
    ]);
    expect((result as { runDefaults?: { providerRetryMode?: string } }).runDefaults).toEqual({
      providerRetryMode: "persistent",
    });
  });

  test("preserves tool-call fields when normalizing session history", async () => {
    const rpcClient = new FakeRpcClient({
      "runtime.now": { current_time: "2026-06-10 09:00:00 Asia/Shanghai" },
      "config.snapshot_public": { value: { agents: { defaults: { provider_retry_mode: "standard" } } } },
      "session.get_history": {
        session_id: "session-1",
        messages: [
          {
            role: "assistant",
            content: "",
            reasoning_content: "Need a tool.",
            thinking_blocks: [{ type: "thinking", text: "trace" }],
            tool_calls: [
              {
                id: "call-1",
                type: "function",
                function: {
                  name: "read_file",
                  arguments: "{\"path\":\"README.md\"}",
                },
              },
            ],
          },
          {
            role: "tool",
            content: "README contents",
            tool_call_id: "call-1",
            name: "read_file",
            metadata: {
              source: "session",
              awaiting_user_input: true,
              stop_reason: "awaiting_form",
            },
          },
        ],
      },
      "workspace.read_bootstrap_files": { files: [], missing: [] },
    });
    const bridge = new NativeContextBridge(rpcClient);

    const result = await bridge.loadContextInput(runInput(), "trace-1");

    expect(result.input.history).toEqual([
      {
        role: "assistant",
        content: "",
        reasoningContent: "Need a tool.",
        thinkingBlocks: [{ type: "thinking", text: "trace" }],
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
      },
      {
        role: "tool",
        content: "README contents",
        toolCallId: "call-1",
        name: "read_file",
        metadata: {
          source: "session",
          awaiting_user_input: true,
          stop_reason: "awaiting_form",
        },
      },
    ]);
    expect(result.metadata.malformedHistoryCount).toBe(0);
  });

  test("falls back to per-file bootstrap reads when the batch RPC is unavailable", async () => {
    const rpcClient = new FakeRpcClient({
      "runtime.now": { current_time: "fixed now" },
      "config.snapshot_public": { value: { agents: { defaults: { provider_retry_mode: "standard" } } } },
      "session.get_history": new Error("session metadata not found"),
      "workspace.read_bootstrap_files": new Error("unknown worker method"),
      "workspace.read_file": { path: "AGENTS.md", contents: "Agent rules" },
    });
    const bridge = new NativeContextBridge(rpcClient);

    const result = await bridge.loadContextInput(runInput(), "trace-1");

    expect(rpcClient.calls.map((call) => call.method)).toEqual([
      "runtime.now",
      "config.snapshot_public",
      "session.get_history",
      "workspace.read_bootstrap_files",
      "workspace.read_file",
      "workspace.read_file",
      "workspace.read_file",
      "workspace.read_file",
      "skills.list",
    ]);
    expect(result.input.history).toEqual([]);
    expect(result.input.bootstrapFiles).toEqual([{ path: "AGENTS.md", contents: "Agent rules" }]);
    expect(result.metadata).toMatchObject({
      missingSession: true,
      bootstrapFallbackUsed: true,
    });
  });

  test("loads native-owned memory recall for run input context", async () => {
    const rpcClient = new FakeRpcClient({
      "runtime.now": { current_time: "fixed now" },
      "config.snapshot_public": { value: { agents: { defaults: { provider_retry_mode: "standard" } } } },
      "session.get_history": { session_id: "session-1", messages: [] },
      "workspace.read_bootstrap_files": { files: [], missing: [] },
      "memory.recall": {
        context: "---\n[MEMORY RECALL]\n\n- User prefers concise implementation handoffs.\n---",
        references: [
          {
            note_id: "note_pref",
            scope: "user",
            type: "preference",
            status: "active",
            content: "User prefers concise implementation handoffs.",
            priority: 0.8,
            confidence: 0.7,
            tags: ["handoff"],
            metadata: { source: "desktop" },
            file: "memory/notes.jsonl",
            line: 1,
            view_file: "USER.md",
            view_line: 12,
          },
        ],
      },
    });
    const bridge = new NativeContextBridge(rpcClient);

    const result = await bridge.loadContextInput(runInput({ input: { content: "Continue implementation" } }), "trace-1");

    expect(rpcClient.calls).toContainEqual({
      traceId: "trace-1",
      method: "memory.recall",
      params: {
        query: "Continue implementation",
        max_notes: 6,
        max_chars: 1600,
      },
    });
    expect(result.input.memoryNotes).toEqual([
      {
        id: "note_pref",
        scope: "user",
        type: "preference",
        status: "active",
        content: "User prefers concise implementation handoffs.",
        priority: 0.8,
        confidence: 0.7,
        tags: ["handoff"],
        metadata: { source: "desktop" },
        file: "memory/notes.jsonl",
        line: 1,
        viewFile: "USER.md",
        viewLine: 12,
      },
    ]);
    expect(result.input.memoryRecallContext).toContain("[MEMORY RECALL]");
    expect(result.input.memoryRecallContext).toContain("concise implementation handoffs");
  });

  test("loads enabled skills context from native skills list", async () => {
    const rpcClient = new FakeRpcClient({
      "runtime.now": { current_time: "fixed now" },
      "config.snapshot_public": {
        value: {
          agents: { defaults: { provider_retry_mode: "standard" } },
          skills: { enabled: ["planner"] },
        },
      },
      "session.get_history": { session_id: "session-1", messages: [] },
      "workspace.read_bootstrap_files": { files: [], missing: [] },
      "skills.list": {
        skills: [
          {
            name: "planner",
            path: "skills/planner/SKILL.md",
            source: "workspace",
            content: [
              "---",
              "name: planner",
              "description: Plan work",
              "always: true",
              "---",
              "Plan the work.",
            ].join("\n"),
          },
          {
            name: "tmux",
            path: "tinybot/skills/tmux/SKILL.md",
            source: "builtin",
            content: [
              "---",
              "name: tmux",
              "description: Terminal sessions",
              "metadata: '{\"tinybot\":{\"requires\":{\"bins\":[\"definitely_missing_tinybot_bin\"],\"env\":[\"DEFINITELY_MISSING_TINYBOT_ENV\"]}}}'",
              "---",
              "Use tmux.",
            ].join("\n"),
          },
        ],
      },
    });
    const bridge = new NativeContextBridge(rpcClient);

    const result = await bridge.loadContextInput(runInput(), "trace-1");

    expect(rpcClient.calls.map((call) => call.method)).toEqual([
      "runtime.now",
      "config.snapshot_public",
      "session.get_history",
      "workspace.read_bootstrap_files",
      "skills.list",
    ]);
    expect(result.input.skills).toMatchObject({
      activeSkillsContent: "### Skill: planner\n\nPlan the work.",
      alwaysSkillNames: ["planner"],
      sourceCounts: { workspace: 1, builtin: 1 },
      unavailableCount: 1,
    });
    expect(result.input.skills?.skillsSummary).toContain("<name>planner</name>");
    expect(result.input.skills?.skillsSummary).not.toContain("<name>tmux</name>");
  });
});
