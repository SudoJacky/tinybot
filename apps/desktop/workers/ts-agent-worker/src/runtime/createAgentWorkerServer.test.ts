import { describe, expect, test, vi } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { ToolRegistry } from "../tools/toolRegistry";
import { createAgentWorkerServer } from "./createAgentWorkerServer";
import type { ModelProviderConfig } from "./providerFactory";
import type { NativeTextChannelConnector } from "../channels/nativeTextChannel";

type ParsedLine = {
  id?: unknown;
  trace_id?: unknown;
  event?: unknown;
  method?: unknown;
  payload?: Record<string, unknown>;
  params?: Record<string, unknown>;
};

class QueueProvider implements ModelProvider {
  readonly requests: AgentMessage[][] = [];
  readonly options: ModelRequestOptions[] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<ModelResponse> {
    this.requests.push(messages.map((message) => ({ ...message })));
    this.options.push({ ...options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

describe("createAgentWorkerServer", () => {
  test("registers the native spawn tool by default", () => {
    const registry = new ToolRegistry();

    createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: registry,
      writeLine: () => undefined,
      writeLog: () => undefined,
    });

    expect(registry.has("spawn")).toBe(true);
  });

  test("wires stdio requests to the injected model provider", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "factory done", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    const messages = lines.map((line) => JSON.parse(line));
    expect(messages).toContainEqual(
      expect.objectContaining({
        event: "agent.checkpoint",
        payload: expect.objectContaining({ phase: "final_response", runId: "run-1" }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ event: "agent.done" }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ finalContent: "factory done" }),
      }),
    );
  });

  test("wires channel lifecycle requests to an injected native channel manager", async () => {
    const lines: string[] = [];
    let startCalls = 0;
    const channelManager = {
      startAll: async () => {
        startCalls += 1;
      },
      stopAll: async () => undefined,
      login: async () => true,
      status: () => ({
        running: true,
        channels: [
          { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
        ],
        diagnostics: [],
      }),
    };
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      channelManager,
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-start",
        trace_id: "trace-channel-start",
        method: "channel.start",
        params: {},
      }),
    );

    expect(startCalls).toBe(1);
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "channel-start",
      trace_id: "trace-channel-start",
      result: {
        started: true,
        status: {
          running: true,
          channels: [
            { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
          ],
          diagnostics: [],
        },
      },
    });
  });

  test("provides a default TS channel manager for lifecycle requests", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-status",
        trace_id: "trace-channel-status",
        method: "channel.status",
        params: {},
      }),
    );
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-start",
        trace_id: "trace-channel-start",
        method: "channel.start",
        params: {},
      }),
    );
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-stop",
        trace_id: "trace-channel-stop",
        method: "channel.stop",
        params: {},
      }),
    );

    expect(parsedLines(lines).find((line) => line.id === "channel-status")).toMatchObject({
      protocol_version: "1",
      id: "channel-status",
      trace_id: "trace-channel-status",
      result: {
        running: false,
        channels: [],
        diagnostics: [],
        bus: {
          inboundSize: 0,
          outboundSize: 0,
          warningThreshold: 100,
          warnings: [],
          lastWarningAt: null,
          closed: false,
        },
      },
    });
    expect(parsedLines(lines).find((line) => line.id === "channel-start")).toMatchObject({
      protocol_version: "1",
      id: "channel-start",
      trace_id: "trace-channel-start",
      result: {
        started: true,
        status: {
          running: true,
          channels: [],
          diagnostics: [],
        },
      },
    });
    expect(parsedLines(lines).find((line) => line.id === "channel-stop")).toMatchObject({
      protocol_version: "1",
      id: "channel-stop",
      trace_id: "trace-channel-stop",
      result: {
        stopped: true,
        status: {
          running: false,
          channels: [],
          diagnostics: [],
        },
      },
    });
  });

  test("builds default native channel adapters from config and host connectors", async () => {
    const lines: string[] = [];
    const feishuConnector: NativeTextChannelConnector = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      sendText: vi.fn(async () => undefined),
      sendDelta: vi.fn(async () => undefined),
    };
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      nativeChannelConnectors: {
        feishu: feishuConnector,
      },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const start = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-start-native",
        trace_id: "trace-channel-start-native",
        method: "channel.start",
        params: {},
      }),
    );
    await respondToConfigSnapshot(server, lines, {
      channels: {
        feishu: {
          enabled: true,
          allow_from: ["ou_1"],
          streaming: true,
        },
        dingtalk: {
          enabled: true,
          allow_from: ["ding-user"],
        },
      },
    });
    await start;

    expect(feishuConnector.start).toHaveBeenCalledTimes(1);
    expect(parsedLines(lines).find((line) => line.id === "channel-start-native")).toMatchObject({
      protocol_version: "1",
      id: "channel-start-native",
      trace_id: "trace-channel-start-native",
      result: {
        started: true,
        status: {
          running: true,
          channels: [
            { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
          ],
          diagnostics: [],
        },
      },
    });
  });

  test("can build default native channel connectors from the host RPC bridge", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      nativeChannelConnectorBridgeChannels: ["feishu"],
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const start = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-start-bridge",
        trace_id: "trace-channel-start-bridge",
        method: "channel.start",
        params: {},
      }),
    );
    await respondToConfigSnapshot(server, lines, {
      channels: {
        feishu: {
          enabled: true,
          allow_from: ["ou_1"],
        },
      },
    });
    await respondToWorkerRequest(server, lines, "channel.connector.start", { ok: true });
    await start;
    const login = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-login-bridge",
        trace_id: "trace-channel-login-bridge",
        method: "channel.login",
        params: {
          channel: "feishu",
          force: true,
        },
      }),
    );
    await respondToWorkerRequest(server, lines, "channel.connector.login", { ok: true, logged_in: false });
    await login;

    expect(parsedLines(lines).find((line) => line.method === "channel.connector.start")).toMatchObject({
      trace_id: "channel.connector.feishu.start",
      method: "channel.connector.start",
      params: {
        channel: "feishu",
      },
    });
    expect(parsedLines(lines).find((line) => line.id === "channel-start-bridge")).toMatchObject({
      protocol_version: "1",
      id: "channel-start-bridge",
      trace_id: "trace-channel-start-bridge",
      result: {
        started: true,
        status: {
          running: true,
          channels: [
            { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
          ],
          diagnostics: [],
        },
      },
    });
    expect(parsedLines(lines).find((line) => line.method === "channel.connector.login")).toMatchObject({
      trace_id: "channel.connector.feishu.login",
      method: "channel.connector.login",
      params: {
        channel: "feishu",
        force: true,
      },
    });
    expect(parsedLines(lines).find((line) => line.id === "channel-login-bridge")).toMatchObject({
      protocol_version: "1",
      id: "channel-login-bridge",
      trace_id: "trace-channel-login-bridge",
      result: {
        channel: "feishu",
        logged_in: false,
        status: {
          running: true,
          channels: [
            { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
          ],
          diagnostics: [],
        },
      },
    });
  });

  test("reports host RPC connector unavailable responses as channel startup diagnostics", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      nativeChannelConnectorBridgeChannels: ["feishu"],
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const start = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "channel-start-unavailable",
        trace_id: "trace-channel-start-unavailable",
        method: "channel.start",
        params: {},
      }),
    );
    await respondToConfigSnapshot(server, lines, {
      channels: {
        feishu: {
          enabled: true,
          allow_from: ["ou_1"],
        },
      },
    });
    await respondToWorkerRequest(server, lines, "channel.connector.start", {
      ok: true,
      channel: "feishu",
      operation: "start",
      handled: false,
      reason: "native_connector_unavailable",
    });
    await start;

    expect(parsedLines(lines).find((line) => line.id === "channel-start-unavailable")).toMatchObject({
      protocol_version: "1",
      id: "channel-start-unavailable",
      trace_id: "trace-channel-start-unavailable",
      result: {
        started: true,
        status: {
          running: true,
          channels: [
            { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: false },
          ],
          diagnostics: [
            {
              kind: "start_failed",
              channel: "feishu",
              error: "native connector feishu start unavailable: native_connector_unavailable",
            },
          ],
        },
      },
    });
  });

  test("routes dream slash commands through native memory dream RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-dream-log",
        trace_id: "trace-dream-log",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-dream-log",
            sessionId: "session-1",
            messages: [{ role: "user", content: "/dream-log abc123" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "memory.dream_log"));
    const request = parsedLines(lines).find((line) => line.method === "memory.dream_log");
    expect(request).toMatchObject({
      trace_id: "trace-dream-log",
      method: "memory.dream_log",
      params: { sha: "abc123", session_id: "session-1" },
    });
    if (!request || typeof request.id !== "string") {
      throw new Error("missing memory.dream_log request id");
    }
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: request.id,
        trace_id: "trace-dream-log",
        result: { content: "## Dream Update\n\n- Commit: `abc123`" },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(0);
    const messages = parsedLines(lines);
    expect(messages.at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-dream-log",
      trace_id: "trace-dream-log",
      result: {
        finalContent: "## Dream Update\n\n- Commit: `abc123`",
        stopReason: "command",
        metadata: {
          command: "/dream-log",
          render_as: "text",
        },
      },
    });
  });

  test("routes restart slash commands through native runtime restart RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-restart",
        trace_id: "trace-restart",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-restart",
            sessionId: "session-1",
            messages: [{ role: "user", content: " /restart " }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "runtime.restart"));
    const request = parsedLines(lines).find((line) => line.method === "runtime.restart");
    expect(request).toMatchObject({
      trace_id: "trace-restart",
      method: "runtime.restart",
      params: {
        run_id: "run-restart",
        session_id: "session-1",
      },
    });
    if (!request || typeof request.id !== "string") {
      throw new Error("missing runtime.restart request id");
    }
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: request.id,
        trace_id: "trace-restart",
        result: { restart_requested: true },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(0);
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-restart",
      trace_id: "trace-restart",
      result: {
        finalContent: "Restarting...",
        stopReason: "command",
        metadata: {
          command: "/restart",
          render_as: "text",
          restart_requested: true,
        },
      },
    });
  });

  test("routes deferred dream slash commands through provider-backed native apply", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
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
            metadata: {},
          },
        ]),
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      env: { TINYBOT_MODEL: "dream-model" },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-dream",
        trace_id: "trace-dream",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-dream",
            sessionId: "session-1",
            messages: [{ role: "user", content: "/dream" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "memory.dream_run"));
    const dreamRun = parsedLines(lines).find((line) => line.method === "memory.dream_run");
    if (!dreamRun || typeof dreamRun.id !== "string") {
      throw new Error("missing memory.dream_run request id");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: dreamRun.id,
      trace_id: "trace-dream",
      result: {
        content: "Dream deferred 1 conversation evidence record(s) for provider-backed memory extraction.",
        metadata: { deferred: true, pending_evidence: 1 },
      },
    }));

    await waitFor(() => parsedLines(lines).some((line) => line.method === "memory.dream_pending"));
    const pending = parsedLines(lines).find((line) => line.method === "memory.dream_pending");
    if (!pending || typeof pending.id !== "string") {
      throw new Error("missing memory.dream_pending request id");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: pending.id,
      trace_id: "trace-dream",
      result: {
        kind: "conversation_evidence",
        records: [{
          id: "ev_1",
          role: "user",
          content: "Please remember I prefer compact migration slices.",
          cursor: 3,
          message_index: 1,
        }],
        cursor_start: 3,
        cursor_end: 3,
        evidence_ids: ["ev_1"],
      },
    }));

    await waitFor(() => parsedLines(lines).some((line) => line.method === "memory.dream_apply"));
    const apply = parsedLines(lines).find((line) => line.method === "memory.dream_apply");
    expect(apply).toMatchObject({
      trace_id: "trace-dream",
      method: "memory.dream_apply",
      params: {
        session_id: "session-1",
        kind: "conversation_evidence",
        cursor_start: 3,
        cursor_end: 3,
        evidence_ids: ["ev_1"],
      },
    });
    expect(apply?.params?.notes).toEqual([
      expect.objectContaining({
        action: "save",
        content: "User prefers compact migration slices.",
        note_type: "preference",
        scope: "user",
      }),
    ]);
    if (!apply || typeof apply.id !== "string") {
      throw new Error("missing memory.dream_apply request id");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: apply.id,
      trace_id: "trace-dream",
      result: { changed: true, applied_notes: 1, last_evidence_cursor: 3 },
    }));
    await run;

    expect(provider.requests).toHaveLength(1);
    expect(provider.options[0]?.model).toBe("dream-model");
    expect(parsedLines(lines).at(-1)).toMatchObject({
      id: "req-dream",
      trace_id: "trace-dream",
      result: {
        finalContent: "Dream applied 1 provider memory note operation(s) from 1 conversation evidence record(s).",
        stopReason: "command",
        metadata: {
          command: "/dream",
          provider_backed: true,
          applied_notes: 1,
        },
      },
    });
  });

  test("writes usage protocol events before the final agent response", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([
        {
          content: "usage done",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
        },
      ]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    const messages = lines.map((line) => JSON.parse(line));
    expect(messages).toContainEqual(
      expect.objectContaining({
        event: "agent.checkpoint",
        payload: expect.objectContaining({ phase: "final_response", runId: "run-1" }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        event: "agent.usage",
        payload: expect.objectContaining({
          runId: "run-1",
          phase: "before_request",
          source: "heuristic",
          estimated: true,
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        event: "agent.usage",
        payload: expect.objectContaining({
          runId: "run-1",
          phase: "after_response",
          source: "provider_usage",
          tokens: 11,
          estimated: false,
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        event: "agent.usage",
        payload: expect.objectContaining({
          runId: "run-1",
          usage: expect.objectContaining({
            inputTokens: 11,
            outputTokens: 13,
            totalTokens: 24,
            prompt_tokens: 11,
            completion_tokens: 13,
            total_tokens: 24,
          }),
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({ event: "agent.done" }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({
          finalContent: "usage done",
          usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
        }),
      }),
    );
    const finalUsageIndex = messages.findIndex((message) => message.event === "agent.usage" && message.payload?.usage);
    const responseIndex = messages.findIndex((message) => message.id === "req-1");
    expect(finalUsageIndex).toBeGreaterThanOrEqual(0);
    expect(responseIndex).toBeGreaterThan(finalUsageIndex);
  });

  test("registers native read-only tools that can call back into Rust over stdio", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        stopReason: "tool_calls",
      },
      { content: "final", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "read README" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "workspace.read_file"));
    expect(lines.map((line) => JSON.parse(line))).toContainEqual({
      protocol_version: "1",
      id: "worker-req-1",
      trace_id: "trace-1",
      method: "workspace.read_file",
      params: { path: "README.md", format: "numbered_lines" },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "worker-req-1",
        trace_id: "trace-1",
        result: { path: "README.md", contents: "hello" },
      }),
    );
    await run;

    const messages = lines.map((line) => JSON.parse(line));
    expect(messages.at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "final", stopReason: "final_response" },
    });
    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: "hello",
      toolCallId: "call-1",
      name: "read_file",
    });
  });

  test("wires heartbeat trigger to native workspace and session/config bridges", async () => {
    const lines: string[] = [];
    const heartbeatConfigSnapshot = {
      agents: { defaults: { model: "gpt-heartbeat", timezone: "Asia/Shanghai" } },
      channels: { feishu: { enabled: true } },
      gateway: { heartbeat: { enabled: true, interval_s: 120, keep_recent_messages: 5 } },
    };
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "heartbeat-call",
          name: "heartbeat",
          argumentsJson: JSON.stringify({ action: "run", tasks: "Review the stalled desktop task." }),
        }],
        stopReason: "tool_calls",
      },
      { content: "Desktop heartbeat handled.", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      env: { TINYBOT_MODEL: "gpt-heartbeat" },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "heartbeat-req",
        trace_id: "trace-heartbeat",
        method: "heartbeat.trigger_now",
        params: {},
      }),
    );

    await respondToWorkerRequest(server, lines, "workspace.read_file", (request) => {
      expect(request.params).toEqual({ path: "HEARTBEAT.md", format: "raw" });
      return { path: "HEARTBEAT.md", content: "- [ ] Review the stalled desktop task." };
    });
    await respondToWorkerRequest(server, lines, "config.snapshot_public", {
      value: heartbeatConfigSnapshot,
    });
    await respondToWorkerRequest(server, lines, "session.list_metadata", [
      {
        session_id: "feishu:chat-1",
        title: "Feishu",
        updated_at: "2026-06-13T08:00:00.000Z",
      },
    ]);
    await waitFor(() => parsedLines(lines).filter((line) => line.method === "config.snapshot_public").length >= 2);
    const targetConfigRequest = parsedLines(lines).filter((line) => line.method === "config.snapshot_public").at(-1);
    if (!targetConfigRequest || typeof targetConfigRequest.id !== "string" || typeof targetConfigRequest.trace_id !== "string") {
      throw new Error("missing heartbeat target config request");
    }
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: targetConfigRequest.id,
        trace_id: targetConfigRequest.trace_id,
        result: {
          value: heartbeatConfigSnapshot,
        },
      }),
    );
    await waitFor(() => parsedLines(lines).filter((line) => line.method === "config.snapshot_public").length >= 3);
    const trimConfigRequest = parsedLines(lines).filter((line) => line.method === "config.snapshot_public").at(-1);
    if (!trimConfigRequest || typeof trimConfigRequest.id !== "string" || typeof trimConfigRequest.trace_id !== "string") {
      throw new Error("missing trim config request");
    }
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: trimConfigRequest.id,
        trace_id: trimConfigRequest.trace_id,
        result: {
          value: heartbeatConfigSnapshot,
        },
      }),
    );
    await respondToWorkerRequest(server, lines, "session.trim", (request) => {
      expect(request.params).toEqual({ session_id: "heartbeat", keep_recent_messages: 5 });
      return { session_id: "heartbeat", messages_before: 9, messages_after: 5 };
    });
    await run;

    expect(provider.options[0]).toMatchObject({ model: "gpt-heartbeat" });
    expect(provider.requests[0]?.[1]?.content).toContain("Asia/Shanghai");
    expect(provider.requests[1]).toContainEqual({
      role: "user",
      content: "Review the stalled desktop task.",
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "heartbeat-req",
      trace_id: "trace-heartbeat",
      result: {
        status: "executed",
        tasks: "Review the stalled desktop task.",
        response: "Desktop heartbeat handled.",
      },
    });
  });

  test("starts heartbeat scheduling from native heartbeat config", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      env: { OPENAI_API_KEY: "test-key" },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const start = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "heartbeat-start",
        trace_id: "trace-heartbeat-start",
        method: "heartbeat.start",
        params: {},
      }),
    );

    await respondToWorkerRequest(server, lines, "config.snapshot_public", {
      value: {
        gateway: { heartbeat: { enabled: true, interval_s: 2, keep_recent_messages: 6 } },
      },
    });
    await start;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "heartbeat-start",
      trace_id: "trace-heartbeat-start",
      result: {
        started: true,
        status: {
          enabled: true,
          running: true,
          intervalMs: 2000,
        },
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "heartbeat-stop",
        trace_id: "trace-heartbeat-stop",
        method: "heartbeat.stop",
        params: {},
      }),
    );
    expect(parsedLines(lines).at(-1)).toMatchObject({
      id: "heartbeat-stop",
      result: {
        stopped: true,
        status: { running: false },
      },
    });
  });

  test("delivers approved scheduled heartbeat notifications to the selected external target", async () => {
    const lines: string[] = [];
    const handled = new Set<unknown>();
    const heartbeatConfigSnapshot = {
      agents: { defaults: { model: "gpt-heartbeat", timezone: "Asia/Shanghai" } },
      channels: { feishu: { enabled: true } },
      gateway: { heartbeat: { enabled: true, interval_s: 1, keep_recent_messages: 5 } },
    };
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{
          id: "heartbeat-call",
          name: "heartbeat",
          argumentsJson: JSON.stringify({ action: "run", tasks: "Notify about heartbeat task." }),
        }],
        stopReason: "tool_calls",
      },
      { content: "Heartbeat task completed.", toolCalls: [], stopReason: "stop" },
      {
        content: "",
        toolCalls: [{
          id: "evaluate-call",
          name: "evaluate_notification",
          argumentsJson: JSON.stringify({ should_notify: true, reason: "completed" }),
        }],
        stopReason: "tool_calls",
      },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      env: { TINYBOT_MODEL: "gpt-heartbeat" },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const respondNext = async (method: string, result: unknown | ((request: ParsedLine) => unknown)): Promise<ParsedLine> => {
      try {
        await waitFor(() => parsedLines(lines).some((line) => line.method === method && !handled.has(line.id)));
      } catch (error) {
        const pending = parsedLines(lines)
          .filter((line) => line.method && !handled.has(line.id))
          .map((line) => ({ id: line.id, method: line.method, params: line.params }));
        throw new Error(`missing ${method} request; pending=${JSON.stringify(pending)}`, { cause: error });
      }
      const request = parsedLines(lines).find((line) => line.method === method && !handled.has(line.id));
      if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
        throw new Error(`missing ${method} request`);
      }
      handled.add(request.id);
      await server.handleLine(JSON.stringify({
        protocol_version: "1",
        id: request.id,
        trace_id: request.trace_id,
        result: typeof result === "function" ? result(request) : result,
      }));
      return request;
    };

    const start = server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: "heartbeat-start-delivery",
      trace_id: "trace-heartbeat-start-delivery",
      method: "heartbeat.start",
      params: {},
    }));
    await respondNext("config.snapshot_public", { value: heartbeatConfigSnapshot });
    await start;
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await respondNext("workspace.read_file", (request) => {
      expect(request.params).toEqual({ path: "HEARTBEAT.md", format: "raw" });
      return { path: "HEARTBEAT.md", content: "- [ ] Notify about heartbeat task." };
    });
    await respondNext("config.snapshot_public", { value: heartbeatConfigSnapshot });
    await respondNext("session.list_metadata", [
      { session_id: "feishu:chat-2", title: "Feishu", updated_at: "2026-06-13T08:00:00.000Z" },
    ]);
    await respondNext("config.snapshot_public", { value: heartbeatConfigSnapshot });
    await respondNext("config.snapshot_public", { value: heartbeatConfigSnapshot });
    await respondNext("session.trim", (request) => {
      expect(request.params).toEqual({ session_id: "heartbeat", keep_recent_messages: 5 });
      return { session_id: "heartbeat", messages_before: 8, messages_after: 5 };
    });
    await respondNext("config.snapshot_public", { value: heartbeatConfigSnapshot });
    await respondNext("session.list_metadata", [
      { session_id: "feishu:chat-2", title: "Feishu", updated_at: "2026-06-13T08:00:00.000Z" },
    ]);

    await waitFor(() => parsedLines(lines).some((line) => line.event === "heartbeat.delivery"));
    expect(parsedLines(lines)).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-heartbeat-delivery",
      event: "heartbeat.delivery",
      payload: {
        channel: "feishu",
        chatId: "chat-2",
        chat_id: "chat-2",
        content: "Heartbeat task completed.",
        tasks: "Notify about heartbeat task.",
      },
    }));

    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: "heartbeat-stop-delivery",
      trace_id: "trace-heartbeat-stop-delivery",
      method: "heartbeat.stop",
      params: {},
    }));
  });

  test("exposes heartbeat diagnostics through native WebUI status route", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const status = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "webui-status",
        trace_id: "trace-webui-status",
        method: "webui.handle_request",
        params: { method: "GET", path: "/api/status" },
      }),
    );

    const handledRequests = new Set<unknown>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitFor(() => {
        const messages = parsedLines(lines);
        return messages.some((line) => line.id === "webui-status" && "result" in line)
          || messages.some((line) => line.method === "config.snapshot_public" && !handledRequests.has(line.id))
          || messages.some((line) => line.method === "provider.resolve_secret" && !handledRequests.has(line.id));
      });
      const response = parsedLines(lines).find((line) => line.id === "webui-status" && "result" in line);
      if (response) {
        break;
      }
      const request = parsedLines(lines).find((line) =>
        (line.method === "config.snapshot_public" || line.method === "provider.resolve_secret")
        && !handledRequests.has(line.id)
      );
      if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
        throw new Error("missing native status request id");
      }
      handledRequests.add(request.id);
      await server.handleLine(JSON.stringify({
        protocol_version: "1",
        id: request.id,
        trace_id: request.trace_id,
        result: request.method === "provider.resolve_secret"
          ? { apiKey: "test-key", apiKeySource: "env" }
          : {
            value: {
              agents: { defaults: { model: "gpt-heartbeat" } },
              gateway: { heartbeat: { enabled: true, interval_s: 2, keep_recent_messages: 6 } },
            },
          },
      }));
    }
    await status;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "webui-status",
      trace_id: "trace-webui-status",
      result: {
        status: 200,
        body: {
          channels: { websocket: { enabled: true, running: true } },
          heartbeat: {
            enabled: true,
            running: false,
            interval_ms: 2_000,
            last_result: null,
            last_error: null,
          },
          model: "gpt-heartbeat",
        },
      },
    });
  });

  test("refreshes heartbeat config after native WebUI config patch", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const patch = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "webui-config-patch",
        trace_id: "trace-webui-config-patch",
        method: "webui.handle_request",
        params: {
          method: "PATCH",
          path: "/api/config",
          body: { gateway: { heartbeat: { enabled: true, interval_s: 3 } } },
        },
      }),
    );

    await respondToWorkerRequest(server, lines, "config.snapshot_public", {
      value: {
        gateway: { heartbeat: { enabled: false, interval_s: 120, keep_recent_messages: 6 } },
      },
    });
    await respondToWorkerRequest(server, lines, "config.apply_patch_result", {
      ok: true,
      config: {
        gateway: { heartbeat: { enabled: true, interval_s: 3, keep_recent_messages: 6 } },
      },
      updatedFields: ["gateway.heartbeat.enabled", "gateway.heartbeat.interval_s"],
      sideEffects: { applied: [], restartRequired: [], warnings: [] },
    });
    await waitFor(() => parsedLines(lines).filter((line) => line.method === "config.snapshot_public").length >= 2);
    const refreshRequest = parsedLines(lines).filter((line) => line.method === "config.snapshot_public").at(-1);
    if (!refreshRequest || typeof refreshRequest.id !== "string" || typeof refreshRequest.trace_id !== "string") {
      throw new Error("missing heartbeat refresh config request");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: refreshRequest.id,
      trace_id: refreshRequest.trace_id,
      result: {
        value: {
          gateway: { heartbeat: { enabled: true, interval_s: 3, keep_recent_messages: 6 } },
        },
      },
    }));
    await patch;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "webui-config-patch",
      trace_id: "trace-webui-config-patch",
      result: {
        status: 200,
        body: {
          ok: true,
          updatedFields: ["gateway.heartbeat.enabled", "gateway.heartbeat.interval_s"],
        },
      },
    });

    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: "heartbeat-status-after-patch",
      trace_id: "trace-heartbeat-status-after-patch",
      method: "heartbeat.status",
      params: {},
    }));
    expect(parsedLines(lines).at(-1)).toMatchObject({
      id: "heartbeat-status-after-patch",
      result: {
        enabled: true,
        intervalMs: 3_000,
      },
    });
  });

  test("reconnects native MCP discovery after WebUI config patch updates MCP servers", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      enableNativeMcpDiscovery: true,
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const patch = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "webui-mcp-config-patch",
        trace_id: "trace-webui-mcp-config-patch",
        method: "webui.handle_request",
        params: {
          method: "PATCH",
          path: "/api/config",
          body: { tools: { mcpServers: { docs: { command: "node", args: ["server.js"], enabledTools: ["search"] } } } },
        },
      }),
    );

    await respondToWorkerRequest(server, lines, "config.snapshot_public", {
      value: {
        tools: { mcpServers: {} },
        gateway: { heartbeat: { enabled: false, interval_s: 120, keep_recent_messages: 6 } },
      },
    });
    await respondToWorkerRequest(server, lines, "config.apply_patch_result", {
      ok: true,
      config: {
        tools: { mcpServers: { docs: { command: "node", args: ["server.js"], enabledTools: ["search"] } } },
        gateway: { heartbeat: { enabled: false, interval_s: 120, keep_recent_messages: 6 } },
      },
      updatedFields: ["tools.mcpServers.docs.command", "tools.mcpServers.docs.args", "tools.mcpServers.docs.enabledTools"],
      sideEffects: { applied: [], restartRequired: [], warnings: [] },
    });
    await waitFor(() => parsedLines(lines).filter((line) => line.method === "mcp.list_tools").length >= 1);
    const listRequest = parsedLines(lines).find((line) => line.method === "mcp.list_tools");
    if (!listRequest || typeof listRequest.id !== "string" || typeof listRequest.trace_id !== "string") {
      throw new Error("missing mcp.list_tools request");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: listRequest.id,
      trace_id: listRequest.trace_id,
      result: {
        servers: [{
          name: "docs",
          tools: [
            { name: "search", description: "Search docs", input_schema: { type: "object" } },
            { name: "delete", description: "Delete docs", input_schema: { type: "object" } },
          ],
        }],
      },
    }));
    await waitFor(() => parsedLines(lines).filter((line) => line.method === "config.snapshot_public").length >= 2);
    const refreshRequest = parsedLines(lines).filter((line) => line.method === "config.snapshot_public").at(-1);
    if (!refreshRequest || typeof refreshRequest.id !== "string" || typeof refreshRequest.trace_id !== "string") {
      throw new Error("missing heartbeat refresh config request");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: refreshRequest.id,
      trace_id: refreshRequest.trace_id,
      result: {
        value: {
          gateway: { heartbeat: { enabled: false, interval_s: 120, keep_recent_messages: 6 } },
        },
      },
    }));
    await patch;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "webui-mcp-config-patch",
      trace_id: "trace-webui-mcp-config-patch",
      result: {
        status: 200,
        body: {
          ok: true,
          updatedFields: ["tools.mcpServers.docs.command", "tools.mcpServers.docs.args", "tools.mcpServers.docs.enabledTools"],
        },
      },
    });

    const priorRequestIds = new Set(parsedLines(lines).map((line) => line.id));
    const status = server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: "webui-mcp-status",
      trace_id: "trace-webui-mcp-status",
      method: "webui.handle_request",
      params: { method: "GET", path: "/api/status" },
    }));
    const handledRequests = new Set<unknown>();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await waitFor(() => {
        const messages = parsedLines(lines);
        return messages.some((line) => line.id === "webui-mcp-status" && "result" in line)
          || messages.some((line) => line.method === "config.snapshot_public" && !priorRequestIds.has(line.id) && !handledRequests.has(line.id))
          || messages.some((line) => line.method === "provider.resolve_secret" && !priorRequestIds.has(line.id) && !handledRequests.has(line.id));
      });
      const response = parsedLines(lines).find((line) => line.id === "webui-mcp-status" && "result" in line);
      if (response) {
        break;
      }
      const request = parsedLines(lines).find((line) =>
        (line.method === "config.snapshot_public" || line.method === "provider.resolve_secret")
        && !priorRequestIds.has(line.id)
        && !handledRequests.has(line.id)
      );
      if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
        throw new Error("missing native status request id");
      }
      handledRequests.add(request.id);
      await server.handleLine(JSON.stringify({
        protocol_version: "1",
        id: request.id,
        trace_id: request.trace_id,
        result: request.method === "provider.resolve_secret"
          ? { apiKey: "test-key", apiKeySource: "env" }
          : {
            value: {
              agents: { defaults: { model: "gpt-mcp" } },
              gateway: { heartbeat: { enabled: false, interval_s: 120, keep_recent_messages: 6 } },
            },
          },
      }));
    }
    await status;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "webui-mcp-status",
      trace_id: "trace-webui-mcp-status",
      result: {
        status: 200,
        body: {
          mcp: {
            servers: [{
              name: "docs",
              status: "connected",
              registeredTools: ["mcp_docs_search"],
              skippedTools: ["mcp_docs_delete"],
              error: null,
            }],
          },
        },
      },
    });
  });

  test("registers request_form tool that pauses the run through native form RPC", async () => {
    const form = {
      form_id: "travel_plan",
      title: "Travel plan",
      fields: [{ name: "destination", type: "text", label: "Destination" }],
    };
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "request_form", argumentsJson: JSON.stringify({ form }) }],
        stopReason: "tool_calls",
      },
      { content: "should not be requested", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "collect travel details" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "form.request"));
    const formRequest = parsedLines(lines).find((line) => line.method === "form.request");
    expect(formRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "form.request",
      params: {
        run_id: "run-1",
        form,
        continuation_mode: "structured_message",
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: formRequest?.id,
        trace_id: "trace-1",
        result: {
          content: "Waiting for form submission.",
          awaitingUserInput: true,
          stopReason: "awaiting_form",
          formId: "travel_plan",
          form,
          continuationMode: "structured_message",
        },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(1);
    expect(parsedLines(lines)).toContainEqual(
      expect.objectContaining({
        event: "agent.awaiting_form",
        payload: expect.objectContaining({
          runId: "run-1",
          stopReason: "awaiting_form",
          formId: "travel_plan",
          form,
        }),
      }),
    );
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "", stopReason: "awaiting_form" },
    });
  });

  test("registers request_approval tool that pauses the run through native approval RPC", async () => {
    const operation = {
      toolName: "write_file",
      arguments: { path: "notes/today.md", contents: "hello" },
      category: "filesystem_write",
      risk: "medium",
      reason: "File write/edit/delete tools can modify workspace state.",
    };
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "request_approval", argumentsJson: JSON.stringify({ operation }) }],
        stopReason: "tool_calls",
      },
      { content: "should not be requested", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "write a file" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "approval.request"));
    const approvalRequest = parsedLines(lines).find((line) => line.method === "approval.request");
    expect(approvalRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "approval.request",
      params: {
        run_id: "run-1",
        operation,
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: approvalRequest?.id,
        trace_id: "trace-1",
        result: {
          content: "Waiting for approval.",
          awaitingUserInput: true,
          stopReason: "awaiting_approval",
          approvalId: "approval-1",
          operation,
        },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(1);
    expect(parsedLines(lines)).toContainEqual(
      expect.objectContaining({
        event: "agent.awaiting_approval",
        payload: expect.objectContaining({
          runId: "run-1",
          stopReason: "awaiting_approval",
          approvalId: "approval-1",
          operation,
        }),
      }),
    );
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "", stopReason: "awaiting_approval" },
    });
  });

  test("registers memory tools that call native memory RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "search_memory_notes",
            argumentsJson: JSON.stringify({ query: "handoff", note_type: "preference", status: "active", limit: 5 }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "memory checked", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "recall memory" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "memory.search"));
    const memoryRequest = parsedLines(lines).find((line) => line.method === "memory.search");
    expect(memoryRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "memory.search",
      params: {
        query: "handoff",
        note_type: "preference",
        status: "active",
        limit: 5,
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: memoryRequest?.id,
        trace_id: "trace-1",
        result: {
          notes: [
            {
              id: "mem_1",
              scope: "user",
              type: "preference",
              status: "active",
              priority: 0.8,
              confidence: 0.7,
              content: "User prefers concise implementation handoffs.",
              file: "memory/notes.jsonl",
              line: 1,
              view_file: "USER.md",
              view_line: 12,
              sources: [{ capture_origin: "explicit", session_key: "session-1" }],
            },
          ],
        },
      }),
    );
    await run;

    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: expect.stringContaining("User prefers concise implementation handoffs."),
      toolCallId: "call-1",
      name: "search_memory_notes",
      metadata: {
        _memory_references: [
          {
            note_id: "mem_1",
            scope: "user",
            type: "preference",
            status: "active",
            content: "User prefers concise implementation handoffs.",
            priority: 0.8,
            confidence: 0.7,
            tags: [],
            metadata: {},
            evidence_ids: [],
            file: "memory/notes.jsonl",
            line: 1,
            view_file: "USER.md",
            view_line: 12,
          },
        ],
      },
    });
    expect(parsedLines(lines)).toContainEqual(
      expect.objectContaining({
        event: "agent.memory_reference",
        payload: expect.objectContaining({
          runId: "run-1",
          toolCallId: "call-1",
          toolName: "search_memory_notes",
          references: [
            {
              note_id: "mem_1",
              scope: "user",
              type: "preference",
              status: "active",
              content: "User prefers concise implementation handoffs.",
              priority: 0.8,
              confidence: 0.7,
              tags: [],
              metadata: {},
              evidence_ids: [],
              file: "memory/notes.jsonl",
              line: 1,
              view_file: "USER.md",
              view_line: 12,
            },
          ],
        }),
      }),
    );
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "memory checked", stopReason: "final_response" },
    });
  });

  test("registers knowledge tools that call native knowledge RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-rag",
            name: "query_knowledge",
            argumentsJson: JSON.stringify({ query: "TS worker bridge", category: "docs", limit: 3 }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "rag checked", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "query RAG" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "knowledge.query"));
    const ragRequest = parsedLines(lines).find((line) => line.method === "knowledge.query");
    expect(ragRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "knowledge.query",
      params: {
        query: "TS worker bridge",
        category: "docs",
        limit: 3,
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: ragRequest?.id,
        trace_id: "trace-1",
        result: {
          results: [
            {
              id: "doc-1",
              doc_name: "TS Agent Loop Design",
              file_path: "docs/ts-agent-loop.md",
              line_start: 12,
              line_end: 18,
              score: 0.91,
              content: "TS worker should proxy product integrations through Rust.",
            },
          ],
        },
      }),
    );
    await run;

    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: expect.stringContaining("TS worker should proxy product integrations through Rust."),
      toolCallId: "call-rag",
      name: "query_knowledge",
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "rag checked", stopReason: "final_response" },
    });
  });

  test("registers task tool that calls native task RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-task",
            name: "task",
            argumentsJson: JSON.stringify({ action: "progress", plan_id: "plan-1" }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "task checked", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "check task" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "task.plan.get"));
    const taskRequest = parsedLines(lines).find((line) => line.method === "task.plan.get");
    expect(taskRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "task.plan.get",
      params: { plan_id: "plan-1" },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: taskRequest?.id,
        trace_id: "trace-1",
        result: {
          plan: {
            id: "plan-1",
            title: "Backend migration",
            original_request: "Move backend runtime to TS",
            status: "executing",
            current_subtask_ids: [],
            context: {},
            subtasks: [
              {
                id: "a",
                title: "Foundation",
                description: "Build foundation",
                status: "completed",
                dependencies: [],
                parallel_safe: true,
                result: "done",
                error: null,
                started_at: null,
                completed_at: null,
                retry_count: 0,
                max_retries: 2,
              },
            ],
          },
        },
      }),
    );
    await run;

    expect(provider.requests[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      content: expect.stringContaining("**Progress:** 1/1 completed"),
      toolCallId: "call-task",
      name: "task",
    }));
  });

  test("serves cowork blueprint preview through worker RPC", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "cowork-preview-1",
        trace_id: "trace-cowork-preview",
        method: "cowork.preview_blueprint",
        params: {
          blueprint: {
            goal: "Plan launch",
            workflow_mode: "hybrid",
            budgets: { parallel_width: 2 },
          },
        },
      }),
    );

    expect(lines.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "cowork-preview-1",
      trace_id: "trace-cowork-preview",
      result: {
        ok: true,
        blueprint: {
          goal: "Plan launch",
          workflow_mode: "adaptive_starter",
          lead_agent_id: "coordinator",
          budgets: { parallel_width: 2 },
        },
        graph_preview: {
          schema_version: "cowork.graph.preview.v1",
        },
        initial_ready_work: {
          ready_task_ids: ["lead_start"],
        },
      },
    });
  });

  test("wires cowork create_session through native cowork store RPCs", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "cowork-create-1",
        trace_id: "trace-cowork-create",
        method: "cowork.create_session",
        params: {
          goal: "Wire native Cowork store",
          title: "Native Cowork",
          workflow_mode: "team",
          agents: [{ id: "lead", role: "Lead" }],
          tasks: [{ id: "plan", title: "Plan", assigned_agent_id: "lead" }],
        },
      }),
    );

    const workspaceRequest = await respondToWorkerRequest(server, lines, "cowork_store.ensure_session_workspace", {
      workspace_dir: "D:/tmp/cowork/cw-test",
    });
    expect(workspaceRequest).toMatchObject({
      trace_id: "trace-cowork-create",
      params: { session_id: expect.any(String) },
    });
    const writeRequest = await respondToWorkerRequest(
      server,
      lines,
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    expect(writeRequest).toMatchObject({
      trace_id: "trace-cowork-create",
      params: {
        session: expect.objectContaining({
          title: "Native Cowork",
          workspace_dir: "D:/tmp/cowork/cw-test",
        }),
      },
    });
    await run;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "cowork-create-1",
      trace_id: "trace-cowork-create",
      result: {
        session: expect.objectContaining({
          title: "Native Cowork",
          workspace_dir: "D:/tmp/cowork/cw-test",
        }),
      },
    });
  });

  test("registers cowork tool that creates sessions through native cowork store RPCs", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-cowork",
            name: "cowork",
            argumentsJson: JSON.stringify({
              action: "start",
              goal: "Coordinate the TS migration",
              title: "TS Migration Cowork",
              workflow_mode: "team",
              agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
              tasks: [{ id: "plan", title: "Plan migration", assigned_agent_id: "lead" }],
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "cowork started", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "start a cowork session" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    const workspaceRequest = await respondToWorkerRequest(server, lines, "cowork_store.ensure_session_workspace", {
      workspace_dir: "D:/tmp/cowork/cw-tool",
    });
    expect(workspaceRequest).toMatchObject({
      trace_id: "trace-1",
      params: { session_id: expect.any(String) },
    });
    const writeRequest = await respondToWorkerRequest(
      server,
      lines,
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    expect(writeRequest).toMatchObject({
      trace_id: "trace-1",
      params: {
        session: expect.objectContaining({
          title: "TS Migration Cowork",
          workspace_dir: "D:/tmp/cowork/cw-tool",
        }),
      },
    });
    await run;

    expect(provider.requests[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      content: expect.stringContaining("Cowork session started:"),
      toolCallId: "call-cowork",
      name: "cowork",
    }));
  });

  test("registers cowork tool run path through the native cowork scheduler bridge", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-cowork",
            name: "cowork",
            argumentsJson: JSON.stringify({
              action: "start",
              goal: "Coordinate the TS scheduler migration",
              title: "Scheduler Cowork",
              workflow_mode: "team",
              agents: [{ id: "lead", name: "Lead", role: "Coordinator" }],
              tasks: [{ id: "plan", title: "Plan scheduler", assigned_agent_id: "lead" }],
              auto_run: true,
              max_rounds: 1,
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      {
        content: JSON.stringify({
          status: "done",
          action: "complete",
          public_note: "Native scheduler agent round complete.",
          private_note: "Ran through CoworkAgentRuntime.",
          completed_task_ids: ["plan"],
        }),
        toolCalls: [],
        stopReason: "stop",
      },
      { content: "scheduler recorded", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "start and run a cowork session" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    const handledStoreRequests = new Set<unknown>();
    const respondToNextStoreRequest = async (
      method: string,
      result: unknown | ((request: ParsedLine) => unknown),
    ): Promise<ParsedLine> => {
      await waitFor(() => parsedLines(lines).some((line) => line.method === method && !handledStoreRequests.has(line.id)));
      const request = parsedLines(lines).find((line) => line.method === method && !handledStoreRequests.has(line.id));
      if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
        throw new Error(`missing ${method} request`);
      }
      handledStoreRequests.add(request.id);
      await server.handleLine(
        JSON.stringify({
          protocol_version: "1",
          id: request.id,
          trace_id: request.trace_id,
          result: typeof result === "function" ? result(request) : result,
        }),
      );
      return request;
    };
    const respondToPendingAppendEvents = async (): Promise<number> => {
      let count = 0;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const request = parsedLines(lines).find((line) => line.method === "cowork_store.append_event" && !handledStoreRequests.has(line.id));
        if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
          break;
        }
        handledStoreRequests.add(request.id);
        await server.handleLine(
          JSON.stringify({
            protocol_version: "1",
            id: request.id,
            trace_id: request.trace_id,
            result: {
              event_id: typeof request.params?.event === "object" && request.params.event !== null && "id" in request.params.event
                ? request.params.event.id
                : "",
            },
          }),
        );
        count += 1;
      }
      return count;
    };

    await respondToNextStoreRequest("cowork_store.ensure_session_workspace", {
      workspace_dir: "D:/tmp/cowork/cw-scheduler",
    });
    const createWrite = await respondToNextStoreRequest(
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    const createdSession = createWrite.params?.session as Record<string, unknown>;
    await respondToNextStoreRequest("cowork_store.read_snapshot", {
      session: createdSession,
    });
    const schedulerInitialWrite = await respondToNextStoreRequest(
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    await respondToNextStoreRequest("cowork_store.read_snapshot", {
      session: schedulerInitialWrite.params?.session,
    });
    const agentStartWrite = await respondToNextStoreRequest(
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    await respondToNextStoreRequest("cowork_store.read_snapshot", {
      session: agentStartWrite.params?.session,
    });
    const agentRunStartWrite = await respondToNextStoreRequest(
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    await respondToNextStoreRequest("cowork_store.read_snapshot", {
      session: agentRunStartWrite.params?.session,
    });
    const agentFinishWrite = await respondToNextStoreRequest(
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    expect(await respondToPendingAppendEvents()).toBe(2);
    await respondToNextStoreRequest("cowork_store.read_snapshot", {
      session: agentFinishWrite.params?.session,
    });
    await respondToNextStoreRequest(
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    await respondToPendingAppendEvents();
    const schedulerWrite = await respondToNextStoreRequest(
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    await run;

    expect(schedulerWrite.params?.session).toMatchObject({
      title: "Scheduler Cowork",
      stop_reason: "ready_to_finish",
      tasks: expect.objectContaining({
        plan: expect.objectContaining({ status: "completed" }),
      }),
      run_metrics: [expect.objectContaining({ status: "stopped", stop_reason: "ready_to_finish", agent_calls: 1 })],
      scheduler_decisions: [expect.objectContaining({ selected_agent_ids: ["lead"] })],
    });
    expect(provider.requests[1][1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Plan scheduler"),
    });
    expect(provider.requests[2]).toContainEqual(expect.objectContaining({
      role: "tool",
      content: expect.stringContaining("Round 1: running lead"),
      toolCallId: "call-cowork",
      name: "cowork",
    }));
  });

  test("registers cowork tool with provider-backed team planning for goal-only starts", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-cowork",
            name: "cowork",
            argumentsJson: JSON.stringify({
              action: "start",
              goal: "Review the TS migration plan",
              workflow_mode: "team",
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      {
        content: "",
        toolCalls: [
          {
            id: "team-1",
            name: "submit_cowork_team",
            argumentsJson: JSON.stringify({
              title: "Planned Cowork",
              agents: [{ id: "lead", name: "Lead", role: "Coordinator", goal: "Plan work", responsibilities: ["Coordinate"] }],
              tasks: [{ id: "lead_start", title: "Plan", description: "Plan work", assigned_agent_id: "lead" }],
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "cowork planned", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "start a planned cowork session" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await respondToWorkerRequest(server, lines, "cowork_store.ensure_session_workspace", {
      workspace_dir: "D:/tmp/cowork/cw-planned",
    });
    const writeRequest = await respondToWorkerRequest(
      server,
      lines,
      "cowork_store.write_snapshot",
      (request) => ({ session: request.params?.session }),
    );
    await run;

    expect(provider.options[1]).toMatchObject({
      toolChoice: { type: "function", function: { name: "submit_cowork_team" } },
    });
    expect(writeRequest).toMatchObject({
      params: {
        session: expect.objectContaining({
          title: "Planned Cowork",
          agents: expect.objectContaining({ lead: expect.objectContaining({ role: "Coordinator" }) }),
          tasks: expect.objectContaining({ lead_start: expect.objectContaining({ assigned_agent_id: "lead" }) }),
        }),
      },
    });
  });

  test("registers cron tool that calls native cron RPC", async () => {
    const lines: string[] = [];
    const respondedRequestIds = new Set<string>();
    const respondToRequest = async (request: ParsedLine, result: unknown): Promise<void> => {
      if (typeof request.id !== "string" || typeof request.trace_id !== "string") {
        throw new Error("missing worker request id");
      }
      respondedRequestIds.add(request.id);
      await server.handleLine(
        JSON.stringify({
          protocol_version: "1",
          id: request.id,
          trace_id: request.trace_id,
          result,
        }),
      );
    };
    const respondToNextRequest = async (method: string, result: unknown): Promise<ParsedLine> => {
      await waitFor(() => parsedLines(lines).some((line) =>
        line.method === method && typeof line.id === "string" && !respondedRequestIds.has(line.id)
      ));
      const request = parsedLines(lines).find((line) =>
        line.method === method && typeof line.id === "string" && !respondedRequestIds.has(line.id)
      );
      if (!request) {
        throw new Error(`missing ${method} request`);
      }
      await respondToRequest(request, result);
      return request;
    };
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-cron",
            name: "cron",
            argumentsJson: JSON.stringify({
              action: "add",
              message: "Check status",
              every_seconds: 60,
              deliver: true,
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "cron checked", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            sessionId: "chat-1",
            messages: [{ role: "user", content: "schedule a status check" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await respondToNextRequest("config.snapshot_public", {
      value: { agents: { defaults: { timezone: "UTC" } } },
    });
    await waitFor(() => parsedLines(lines).some((line) => line.method === "cron.job.add"));
    const cronRequest = parsedLines(lines).find((line) => line.method === "cron.job.add");
    expect(cronRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "cron.job.add",
      params: {
        job: {
          name: "Check status",
          schedule: { kind: "every", everyMs: 60000 },
          payload: { kind: "agent_turn", message: "Check status", deliver: true, channel: "native", to: "chat-1" },
          deleteAfterRun: false,
        },
      },
    });
    await respondToNextRequest("session.set_checkpoint", { session_id: "chat-1" });

    if (!cronRequest) {
      throw new Error("missing cron.job.add request");
    }
    await respondToRequest(cronRequest, {
      job: {
        id: "job-1",
        name: "Check status",
        enabled: true,
        schedule: { kind: "every", everyMs: 60000 },
        payload: { kind: "agent_turn", message: "Check status", deliver: true, channel: "native", to: "chat-1" },
        state: { nextRunAtMs: 1775000060000 },
        createdAtMs: 1775000000000,
        updatedAtMs: 1775000000000,
        deleteAfterRun: false,
      },
    });
    await respondToNextRequest("session.set_checkpoint", { session_id: "chat-1" });
    await respondToNextRequest("session.set_checkpoint", { session_id: "chat-1" });
    await respondToNextRequest("session.persist_turn", { session_id: "chat-1", message_count: 4 });
    await run;

    expect(provider.requests[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      content: "Created job 'Check status' (id: job-1)",
      toolCallId: "call-cron",
      name: "cron",
    }));
  });

  test("uses native config timezone as the cron tool default timezone", async () => {
    const lines: string[] = [];
    const respondedRequestIds = new Set<string>();
    const respondToRequest = async (request: ParsedLine, result: unknown): Promise<void> => {
      if (typeof request.id !== "string" || typeof request.trace_id !== "string") {
        throw new Error("missing worker request id");
      }
      respondedRequestIds.add(request.id);
      await server.handleLine(
        JSON.stringify({
          protocol_version: "1",
          id: request.id,
          trace_id: request.trace_id,
          result,
        }),
      );
    };
    const respondToNextRequest = async (method: string, result: unknown): Promise<ParsedLine> => {
      await waitFor(() => parsedLines(lines).some((line) =>
        line.method === method && typeof line.id === "string" && !respondedRequestIds.has(line.id)
      ));
      const request = parsedLines(lines).find((line) =>
        line.method === method && typeof line.id === "string" && !respondedRequestIds.has(line.id)
      );
      if (!request) {
        throw new Error(`missing ${method} request`);
      }
      await respondToRequest(request, result);
      return request;
    };
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-cron-tz",
            name: "cron",
            argumentsJson: JSON.stringify({
              action: "add",
              message: "Morning report",
              cron_expr: "0 9 * * *",
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "cron timezone checked", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-cron-tz",
        trace_id: "trace-cron-tz",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-cron-tz",
            sessionId: "chat-cron-tz",
            messages: [{ role: "user", content: "schedule the morning report" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) =>
      line.method === "config.snapshot_public" || line.method === "cron.job.add"
    ));
    const configRequest = parsedLines(lines).find((line) => line.method === "config.snapshot_public");
    if (configRequest) {
      await respondToRequest(configRequest, {
        value: { agents: { defaults: { timezone: "Asia/Shanghai" } } },
      });
    }
    await waitFor(() => parsedLines(lines).some((line) => line.method === "cron.job.add"));
    const cronRequest = parsedLines(lines).find((line) => line.method === "cron.job.add");
    expect(cronRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-cron-tz",
      method: "cron.job.add",
      params: {
        job: {
          name: "Morning report",
          schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
          payload: { kind: "agent_turn", message: "Morning report", deliver: true, channel: "native", to: "chat-cron-tz" },
          deleteAfterRun: false,
        },
      },
    });
    await respondToNextRequest("session.set_checkpoint", { session_id: "chat-cron-tz" });
    if (!cronRequest) {
      throw new Error("missing cron.job.add request");
    }
    await respondToRequest(cronRequest, {
      job: {
        id: "job-tz",
        name: "Morning report",
        enabled: true,
        schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
        payload: { kind: "agent_turn", message: "Morning report", deliver: true, channel: "native", to: "chat-cron-tz" },
        state: { nextRunAtMs: 1775000060000 },
        createdAtMs: 1775000000000,
        updatedAtMs: 1775000000000,
        deleteAfterRun: false,
      },
    });
    await respondToNextRequest("session.set_checkpoint", { session_id: "chat-cron-tz" });
    await respondToNextRequest("session.set_checkpoint", { session_id: "chat-cron-tz" });
    await respondToNextRequest("session.persist_turn", { session_id: "chat-cron-tz", message_count: 4 });
    await run;

    expect(provider.requests[1]).toContainEqual(expect.objectContaining({
      role: "tool",
      content: "Created job 'Morning report' (id: job-tz)",
      toolCallId: "call-cron-tz",
      name: "cron",
    }));
  });

  test("registers MCP tools that call native mcp RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-mcp",
            name: "call_mcp_tool",
            argumentsJson: JSON.stringify({
              server: "docs",
              tool: "search",
              arguments: { query: "agent loop" },
            }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "mcp checked", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "call MCP" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "mcp.call_tool"));
    const mcpRequest = parsedLines(lines).find((line) => line.method === "mcp.call_tool");
    expect(mcpRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "mcp.call_tool",
      params: {
        server: "docs",
        tool: "search",
        arguments: { query: "agent loop" },
      },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: mcpRequest?.id,
        trace_id: "trace-1",
        result: {
          content: "MCP search result",
          server: "docs",
          tool: "search",
        },
      }),
    );
    await run;

    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: "MCP search result",
      toolCallId: "call-mcp",
      name: "call_mcp_tool",
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "mcp checked", stopReason: "final_response" },
    });
  });

  test("registers discovered native MCP tools as dynamic wrapped tools", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-mcp",
            name: "mcp_docs_search",
            argumentsJson: JSON.stringify({ query: "agent loop" }),
          },
        ],
        stopReason: "tool_calls",
      },
      { content: "dynamic mcp checked", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      enableNativeMcpDiscovery: true,
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "call dynamic MCP" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      tools: { mcpServers: { docs: { enabledTools: ["*"] } } },
    });
    await waitFor(() => parsedLines(lines).some((line) => line.method === "mcp.list_tools"));
    const listRequest = parsedLines(lines).find((line) => line.method === "mcp.list_tools");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: listRequest?.id,
        trace_id: "trace-1",
        result: {
          servers: [
            {
              name: "docs",
              tools: [
                {
                  name: "search",
                  description: "Search docs",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                },
              ],
            },
          ],
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "approval.request"));
    const approvalRequest = parsedLines(lines).find((line) => line.method === "approval.request");
    expect(approvalRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "approval.request",
      params: {
        run_id: "run-1",
        operation: {
          toolName: "mcp_docs_search",
          arguments: { query: "agent loop" },
        },
        classification: {
          category: "mcp",
          risk: "high",
        },
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: approvalRequest?.id,
        trace_id: "trace-1",
        result: {
          content: "Waiting for approval.",
          awaitingUserInput: true,
          stopReason: "awaiting_approval",
          approvalId: "approval-1",
          operation: {
            toolName: "mcp_docs_search",
            arguments: { query: "agent loop" },
          },
        },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(1);
    expect(parsedLines(lines)).toContainEqual(expect.objectContaining({
      event: "agent.awaiting_approval",
      payload: expect.objectContaining({
        runId: "run-1",
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
      }),
    }));
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "", stopReason: "awaiting_approval" },
    });
  });

  test("filters native MCP discovery with the current config snapshot during agent runs", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      { content: "mcp config filtered", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      enableNativeMcpDiscovery: true,
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-mcp-filter",
        trace_id: "trace-mcp-filter",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-mcp-filter",
            messages: [{ role: "user", content: "use configured MCP tools" }],
            model: "test-model",
            maxIterations: 1,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      tools: {
        mcpServers: {
          docs: { enabledTools: ["search"], toolTimeout: 9 },
        },
      },
    });
    await waitFor(() => parsedLines(lines).some((line) => line.method === "mcp.list_tools"));
    const listRequest = parsedLines(lines).find((line) => line.method === "mcp.list_tools");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: listRequest?.id,
        trace_id: "trace-mcp-filter",
        result: {
          servers: [
            {
              name: "docs",
              tools: [
                { name: "search", description: "Search docs", inputSchema: { type: "object" } },
                { name: "delete", description: "Delete docs", inputSchema: { type: "object" } },
              ],
            },
          ],
        },
      }),
    );

    await run;

    expect(provider.options[0].tools?.map((tool) => tool.name)).toContain("mcp_docs_search");
    expect(provider.options[0].tools?.map((tool) => tool.name)).not.toContain("mcp_docs_delete");
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-mcp-filter",
      trace_id: "trace-mcp-filter",
      result: { finalContent: "mcp config filtered", stopReason: "final_response" },
    });
  });

  test("skips native MCP discovery when the current config has no MCP servers", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([
      { content: "no mcp configured", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      enableNativeMcpDiscovery: true,
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-no-mcp",
        trace_id: "trace-no-mcp",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-no-mcp",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 1,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, { tools: { mcpServers: {} } });
    await run;

    expect(parsedLines(lines).some((line) => line.method === "mcp.list_tools")).toBe(false);
    expect(provider.options[0].tools?.map((tool) => tool.name)).not.toContain("mcp_docs_search");
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-no-mcp",
      trace_id: "trace-no-mcp",
      result: { finalContent: "no mcp configured", stopReason: "final_response" },
    });
  });

  test("continues agent runs when native MCP discovery fails", async () => {
    const lines: string[] = [];
    const logs: string[] = [];
    const provider = new QueueProvider([
      { content: "mcp unavailable but run continues", toolCalls: [], stopReason: "stop" },
    ]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      enableNativeMcpDiscovery: true,
      writeLine: (line) => lines.push(line),
      writeLog: (line) => logs.push(line),
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 1,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, { tools: { mcpServers: { docs: { enabledTools: ["*"] } } } });
    await waitFor(() => parsedLines(lines).some((line) => line.method === "mcp.list_tools"));
    const listRequest = parsedLines(lines).find((line) => line.method === "mcp.list_tools");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: listRequest?.id,
        trace_id: "trace-1",
        error: {
          code: "worker_error",
          message: "native MCP unavailable",
          details: {},
          retryable: false,
          source: "rust_core",
        },
      }),
    );
    await run;

    expect(provider.requests).toHaveLength(1);
    expect(logs).toContain("native MCP discovery failed: native MCP unavailable");
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "mcp unavailable but run continues", stopReason: "final_response" },
    });
  });

  test("loads model provider config from native config when provider is not injected", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "native config done", toolCalls: [], stopReason: "stop" }]);
    const createdConfigs: ModelProviderConfig[] = [];
    const server = createAgentWorkerServer({
      tools: new ToolRegistry(),
      env: { OPENAI_API_KEY: "env-key" },
      createModelProvider: (config) => {
        createdConfigs.push(config);
        return provider;
      },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { provider: "openai", model: "gpt-5" } },
      providers: {
        openai: {
          provider: "openai",
          api_base: "https://api.test/v1",
          api_key: null,
        },
      },
    });
    await respondToProviderSecret(server, lines, "openai", { apiKey: "env-key", apiKeySource: "env:OPENAI_API_KEY" });
    await run;

    expect(createdConfigs).toEqual([
      {
        kind: "resolved",
        resolved: expect.objectContaining({
          providerId: "openai",
          apiKey: "env-key",
          apiKeySource: "env:OPENAI_API_KEY",
          apiBase: "https://api.test/v1",
          model: "gpt-5",
        }),
      },
    ]);
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "native config done", stopReason: "final_response" },
    });
  });

  test("reloads lazy model provider config for the next run", async () => {
    const lines: string[] = [];
    const createdConfigs: ModelProviderConfig[] = [];
    let providerCount = 0;
    const server = createAgentWorkerServer({
      tools: new ToolRegistry(),
      env: {},
      createModelProvider: (config) => {
        providerCount += 1;
        createdConfigs.push(config);
        return new QueueProvider([{ content: `provider ${providerCount}`, toolCalls: [], stopReason: "stop" }]);
      },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const firstRun = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { provider: "openai", model: "gpt-5" } },
      providers: {
        openai: {
          provider: "openai",
          api_base: "https://api.first.test/v1",
          api_key: null,
        },
      },
    });
    await respondToProviderSecret(server, lines, "openai", { apiKey: "first-key", apiKeySource: "config" });
    await firstRun;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "provider 1", stopReason: "final_response" },
    });

    lines.length = 0;
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "reload-1",
        trace_id: "trace-reload",
        method: "worker.provider.reload",
        params: { reason: "config.apply_patch_result" },
      }),
    );

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "reload-1",
      trace_id: "trace-reload",
      result: { reloaded: true },
    });

    lines.length = 0;
    const secondRun = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-2",
        trace_id: "trace-2",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-2",
            messages: [{ role: "user", content: "hello again" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { provider: "openai", model: "gpt-5.1" } },
      providers: {
        openai: {
          provider: "openai",
          api_base: "https://api.second.test/v1",
          api_key: null,
        },
      },
    });
    await respondToProviderSecret(server, lines, "openai", { apiKey: "second-key", apiKeySource: "config" });
    await secondRun;

    expect(createdConfigs).toEqual([
      {
        kind: "resolved",
        resolved: expect.objectContaining({
          providerId: "openai",
          apiKey: "first-key",
          apiBase: "https://api.first.test/v1",
          model: "gpt-5",
        }),
      },
      {
        kind: "resolved",
        resolved: expect.objectContaining({
          providerId: "openai",
          apiKey: "second-key",
          apiBase: "https://api.second.test/v1",
          model: "gpt-5.1",
        }),
      },
    ]);
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-2",
      trace_id: "trace-2",
      result: { finalContent: "provider 2", stopReason: "final_response" },
    });
  });

  test("lists provider models from native config without exposing provider secrets", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      env: {},
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const request = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "models-1",
        trace_id: "trace-models",
        method: "provider.models.list",
        params: { providerId: "dashscope", manualModelIds: ["qwen-manual-extra"] },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
      providers: {
        dashscope: {
          provider: "dashscope",
          api_base: "https://dashscope.test/compatible-mode/v1",
          api_key: null,
          models: ["qwen-profile", "qwen-max"],
          manual_models: ["qwen-manual"],
        },
      },
    });
    await respondToProviderSecret(server, lines, "dashscope", { apiKey: "dashscope-key", apiKeySource: "config" });
    await request;

    const response = parsedLines(lines).at(-1);
    expect(response).toMatchObject({
      protocol_version: "1",
      id: "models-1",
      trace_id: "trace-models",
      result: {
        providerId: "dashscope",
        model: "qwen-max",
        source: "explicit",
        apiKeySource: "config",
        models: expect.arrayContaining(["qwen-max", "qwen-profile", "qwen-manual", "qwen-manual-extra"]),
        modelSources: expect.objectContaining({
          "qwen-max": ["curated", "profile"],
          "qwen-profile": ["profile"],
          "qwen-manual": ["manual"],
          "qwen-manual-extra": ["manual"],
        }),
        sourceCounts: { curated: 11, profile: 1, live: 0, manual: 2 },
        warning: null,
        url: "https://dashscope.test/compatible-mode/v1/models",
      },
    });
    expect(JSON.stringify(response)).not.toContain("dashscope-key");
  });

  test("refreshes provider models through live discovery when requested", async () => {
    const lines: string[] = [];
    const discoveryCalls: Array<{ url: string; authorization?: string }> = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      env: {},
      fetchProviderModelsJson: async (url, headers) => {
        discoveryCalls.push({ url, authorization: headers.Authorization });
        if (url === "https://dashscope.test/compatible-mode/models") {
          throw new Error("not found");
        }
        return { data: [{ id: "qwen-live" }, { id: "qwen-max" }] };
      },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const request = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "models-live-1",
        trace_id: "trace-models-live",
        method: "provider.models.list",
        params: { providerId: "dashscope", refreshLive: true },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
      providers: {
        dashscope: {
          provider: "dashscope",
          api_base: "https://dashscope.test/compatible-mode",
          api_key: null,
        },
      },
    });
    await respondToProviderSecret(server, lines, "dashscope", { apiKey: "dashscope-key", apiKeySource: "config" });
    await request;

    expect(discoveryCalls).toEqual([
      { url: "https://dashscope.test/compatible-mode/models", authorization: "Bearer dashscope-key" },
      { url: "https://dashscope.test/compatible-mode/v1/models", authorization: "Bearer dashscope-key" },
    ]);
    const response = parsedLines(lines).at(-1);
    expect(response).toMatchObject({
      protocol_version: "1",
      id: "models-live-1",
      trace_id: "trace-models-live",
      result: {
        providerId: "dashscope",
        models: expect.arrayContaining(["qwen-live", "qwen-max"]),
        modelSources: expect.objectContaining({
          "qwen-live": ["live"],
          "qwen-max": ["curated", "live"],
        }),
        sourceCounts: { curated: 11, profile: 0, live: 1, manual: 0 },
        warning: "live discovery used fallback base URL: https://dashscope.test/compatible-mode/v1",
        url: "https://dashscope.test/compatible-mode/v1/models",
      },
    });
    expect(JSON.stringify(response)).not.toContain("dashscope-key");
  });

  test("does not emit a live discovery warning when the primary models endpoint succeeds", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      env: {},
      fetchProviderModelsJson: async () => ({ data: [{ id: "qwen-live" }] }),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const request = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "models-live-primary",
        trace_id: "trace-models-live-primary",
        method: "provider.models.list",
        params: { providerId: "dashscope", refreshLive: true },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
      providers: {
        dashscope: {
          provider: "dashscope",
          api_base: "https://dashscope.test/compatible-mode/v1",
          api_key: null,
        },
      },
    });
    await respondToProviderSecret(server, lines, "dashscope", { apiKey: "dashscope-key", apiKeySource: "config" });
    await request;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "models-live-primary",
      result: {
        models: expect.arrayContaining(["qwen-live"]),
        warning: null,
        url: "https://dashscope.test/compatible-mode/v1/models",
      },
    });
  });

  test("passes WebUI provider-models temporary key and base overrides to live discovery", async () => {
    const lines: string[] = [];
    const discoveryCalls: Array<{ url: string; authorization?: string }> = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      env: {},
      fetchProviderModelsJson: async (url, headers) => {
        discoveryCalls.push({ url, authorization: headers.Authorization });
        return { data: [{ id: "qwen-preview" }] };
      },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const request = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "webui-provider-models",
        trace_id: "trace-webui-provider-models",
        method: "webui.handle_request",
        params: {
          method: "POST",
          path: "/api/provider-models",
          body: {
            provider: "dashscope",
            api_key: "preview-key",
            api_base: "https://preview.test/compatible-mode/v1",
            refresh: true,
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
      providers: {
        dashscope: {
          provider: "dashscope",
          api_base: "https://config.test/compatible-mode/v1",
          api_key: null,
        },
      },
    });
    await request;

    expect(parsedLines(lines).some((line) => line.method === "provider.resolve_secret")).toBe(false);
    expect(discoveryCalls).toEqual([
      {
        url: "https://preview.test/compatible-mode/v1/models",
        authorization: "Bearer preview-key",
      },
    ]);
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "webui-provider-models",
      result: {
        status: 200,
        body: {
          ok: true,
          models: expect.arrayContaining(["qwen-preview"]),
          url: "https://preview.test/compatible-mode/v1/models",
        },
      },
    });
  });

  test("lists provider catalog entries for settings surfaces", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "catalog-1",
        trace_id: "trace-catalog",
        method: "provider.catalog.list",
        params: {},
      }),
    );

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "catalog-1",
      trace_id: "trace-catalog",
      result: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "dashscope",
            displayName: "DashScope",
            categories: ["built_in"],
            supportsModelDiscovery: true,
            curatedModels: expect.arrayContaining(["qwen-max"]),
          }),
        ]),
      },
    });
  });

  test("resolves provider runtime status from native config without exposing provider secrets", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      env: {},
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const request = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "runtime-1",
        trace_id: "trace-runtime",
        method: "provider.runtime.resolve",
        params: {},
      }),
    );

    await respondToConfigSnapshot(server, lines, {
      agents: { defaults: { active_profile: "dashscope-coding", provider: "openai", model: "qwen3-coder-plus" } },
      providers: {
        profiles: {
          "dashscope-coding": {
            provider: "dashscope",
            api_base: "https://dashscope.test/compatible-mode/v1",
            api_key: null,
            models: ["qwen3-coder-plus"],
            manual_models: ["qwen-manual"],
          },
        },
      },
    });
    await respondToProviderSecret(server, lines, "dashscope", { apiKey: "profile-key", apiKeySource: "config" });
    await request;

    expect(parsedLines(lines)).toContainEqual(
      expect.objectContaining({
        method: "provider.resolve_secret",
        params: expect.objectContaining({ providerId: "dashscope", profileName: "dashscope-coding" }),
      }),
    );
    const response = parsedLines(lines).at(-1);
    expect(response).toMatchObject({
      protocol_version: "1",
      id: "runtime-1",
      trace_id: "trace-runtime",
      result: {
        providerId: "dashscope",
        model: "qwen3-coder-plus",
        profileName: "dashscope-coding",
        source: "profile",
        apiMode: "openai_chat_completions",
        apiBase: "https://dashscope.test/compatible-mode/v1",
        apiKeySource: "config",
        models: ["qwen3-coder-plus"],
        manualModelIds: ["qwen-manual"],
        supportsModelDiscovery: true,
      },
    });
    expect(JSON.stringify(response)).not.toContain("profile-key");
  });

  test("validates model ids against provider catalog before saving settings", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "validate-1",
        trace_id: "trace-validate",
        method: "provider.model.validate",
        params: { providerId: "deepseek", model: "qwen-max" },
      }),
    );

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "validate-1",
      trace_id: "trace-validate",
      result: {
        ok: false,
        message: "Model 'qwen-max' appears to belong to provider 'dashscope', not 'deepseek'.",
      },
    });
  });

  test("preserves OpenAI-compatible multimodal empty text parts like Python", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "empty text handled", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const request = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "openai-chat-multimodal",
        trace_id: "trace-openai-chat-multimodal",
        method: "webui.handle_request",
        params: {
          method: "POST",
          path: "/v1/chat/completions",
          body: {
            model: "tinybot",
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "prefix" },
                { type: "text" },
                { type: "image_url", image_url: { url: "ignored" } },
              ],
            }],
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {});
    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.set_checkpoint"));
    const checkpointRequest = parsedLines(lines).find((line) => line.method === "session.set_checkpoint");
    if (!checkpointRequest || typeof checkpointRequest.id !== "string") {
      throw new Error("missing checkpoint request");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: checkpointRequest.id,
      trace_id: "trace-openai-chat-multimodal",
      result: { session_id: "api:default" },
    }));
    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.persist_turn"));
    const persistRequest = parsedLines(lines).find((line) => line.method === "session.persist_turn");
    if (!persistRequest || typeof persistRequest.id !== "string") {
      throw new Error("missing persist request");
    }
    await server.handleLine(JSON.stringify({
      protocol_version: "1",
      id: persistRequest.id,
      trace_id: "trace-openai-chat-multimodal",
      result: { session_id: "api:default", saved_message_count: 2 },
    }));
    await respondToMemoryCapture(server, lines, "trace-openai-chat-multimodal");
    await request;

    expect(provider.requests[0]?.[0]).toMatchObject({
      role: "user",
      content: "prefix ",
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "openai-chat-multimodal",
      trace_id: "trace-openai-chat-multimodal",
      result: {
        status: 200,
        body: {
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "empty text handled" } }],
        },
      },
    });
  });

  test("prioritizes OpenAI-compatible stream rejection before message role validation", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const request = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "openai-chat-stream-invalid-role",
        trace_id: "trace-openai-chat-stream-invalid-role",
        method: "webui.handle_request",
        params: {
          method: "POST",
          path: "/v1/chat/completions",
          body: {
            stream: true,
            messages: [{ role: "assistant", content: "hello" }],
          },
        },
      }),
    );

    await respondToConfigSnapshot(server, lines, {});
    await request;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "openai-chat-stream-invalid-role",
      trace_id: "trace-openai-chat-stream-invalid-role",
      result: {
        status: 400,
        body: {
          error: {
            message: "stream=true is not supported yet. Set stream=false or omit it.",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
  });

  test("projects WebUI skills list and detail through native RPC", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      env: { TOKEN: "set" },
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const list = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "skills-list-1",
        trace_id: "trace-skills-list",
        method: "skills.webui_list",
        params: {},
      }),
    );

    await respondToConfigSnapshot(server, lines, { skills: { enabled: ["planner"] } });
    await respondToSkillsList(server, lines, [
      {
        name: "planner",
        path: "skills/planner/SKILL.md",
        source: "workspace",
        content: [
          "---",
          "name: planner",
          "description: Plan work",
          "always: true",
          "metadata: '{\"tinybot\":{\"requires\":{\"env\":[\"TOKEN\"]}}}'",
          "---",
          "Plan the work.",
        ].join("\n"),
      },
    ]);
    await list;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "skills-list-1",
      trace_id: "trace-skills-list",
      result: {
        skills: [
          {
            name: "planner",
            source: "workspace",
            path: "skills/planner/SKILL.md",
            description: "Plan work",
            available: true,
            enabled: true,
            always: true,
          },
        ],
      },
    });

    const detail = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "skills-detail-1",
        trace_id: "trace-skills-detail",
        method: "skills.webui_detail",
        params: { name: "planner" },
      }),
    );
    await respondToSkillsList(server, lines, [
      {
        name: "planner",
        path: "skills/planner/SKILL.md",
        source: "workspace",
        content: "---\nname: planner\ndescription: Plan work\n---\nPlan the work.",
      },
    ]);
    await detail;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "skills-detail-1",
      trace_id: "trace-skills-detail",
      result: {
        name: "planner",
        content: "Plan the work.",
        metadata: { name: "planner", description: "Plan work" },
        tinybot_meta: {},
        available: true,
      },
    });
  });

  test("persists checkpoint and appends messages through native session RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const run = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "req-1",
        trace_id: "trace-1",
        method: "agent.run",
        params: {
          spec: {
            runId: "run-1",
            sessionId: "session-1",
            messages: [{ role: "user", content: "hello" }],
            model: "test-model",
            maxIterations: 2,
            stream: false,
          },
        },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "session.set_checkpoint"));
    const setRequest = lines.map((line) => JSON.parse(line)).find((message) => message.method === "session.set_checkpoint");
    expect(setRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "session.set_checkpoint",
      params: {
        session_id: "session-1",
        checkpoint: {
          runId: "run-1",
          phase: "final_response",
          iteration: 0,
          model: "test-model",
        },
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: setRequest.id,
        trace_id: "trace-1",
        result: { ok: true },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "session.persist_turn"));
    const persistRequest = lines.map((line) => JSON.parse(line)).find((message) => message.method === "session.persist_turn");
    expect(persistRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-1",
      method: "session.persist_turn",
      params: {
        session_id: "session-1",
        run_id: "run-1",
        clear_checkpoint: true,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "done" },
        ],
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: persistRequest.id,
        trace_id: "trace-1",
        result: { session_id: "session-1", saved_message_count: 2 },
      }),
    );
    await respondToMemoryCapture(server, lines, "trace-1");
    await run;

    expect(lines.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: { finalContent: "done", stopReason: "final_response" },
    });
  });

  test("restores checkpoint through native session RPC", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const restore = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "restore-1",
        trace_id: "trace-restore",
        method: "agent.restore_checkpoint",
        params: { sessionId: "session-1" },
      }),
    );

    await waitFor(() => lines.some((line) => JSON.parse(line).method === "session.get_checkpoint"));
    const checkpointRequest = lines.map((line) => JSON.parse(line)).find((message) => message.method === "session.get_checkpoint");
    expect(checkpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-restore",
      method: "session.get_checkpoint",
      params: { session_id: "session-1" },
    });

    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest.id,
        trace_id: "trace-restore",
        result: {
          runId: "run-1",
          phase: "awaiting_tools",
          iteration: 1,
          model: "test-model",
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
          },
          pendingToolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
        },
      }),
    );
    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.append_messages"));
    const appendRequest = parsedLines(lines).find((message) => message.method === "session.append_messages");
    expect(appendRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-restore",
      method: "session.append_messages",
      params: {
        session_id: "session-1",
        messages: [
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call-1", type: "function", function: { name: "echo", arguments: "{}" } }],
          },
          {
            role: "tool",
            content: "Error: Task interrupted before this tool finished.",
            tool_call_id: "call-1",
            name: "echo",
          },
        ],
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: appendRequest.id,
        trace_id: "trace-restore",
        result: { ok: true },
      }),
    );
    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.clear_checkpoint"));
    const clearRequest = parsedLines(lines).find((message) => message.method === "session.clear_checkpoint");
    expect(clearRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-restore",
      method: "session.clear_checkpoint",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: clearRequest.id,
        trace_id: "trace-restore",
        result: { ok: true },
      }),
    );
    await restore;

    expect(lines.map((line) => JSON.parse(line)).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "restore-1",
      trace_id: "trace-restore",
      result: {
        sessionId: "session-1",
        checkpoint: {
          runId: "run-1",
          phase: "awaiting_tools",
          iteration: 1,
          model: "test-model",
        },
        restored: true,
        restoredMessageCount: 2,
      },
    });
  });

  test("resumes approval through native approval and session RPC", async () => {
    const lines: string[] = [];
    const server = createAgentWorkerServer({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const resume = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "resume-approval-1",
        trace_id: "trace-resume",
        method: "agent.resume_approval",
        params: {
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: true,
          scope: "session",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "approval.resolve"));
    const approvalRequest = parsedLines(lines).find((message) => message.method === "approval.resolve");
    expect(approvalRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume",
      method: "approval.resolve",
      params: {
        session_id: "session-1",
        approval_id: "approval-1",
        approved: true,
        scope: "session",
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: approvalRequest?.id,
        trace_id: "trace-resume",
        result: {
          approvalId: "approval-1",
          approved: true,
          scope: "session",
          status: "approved",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.get_checkpoint"));
    const checkpointRequest = parsedLines(lines).find((message) => message.method === "session.get_checkpoint");
    expect(checkpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume",
      method: "session.get_checkpoint",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest?.id,
        trace_id: "trace-resume",
        result: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
        },
      }),
    );
    await resume;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "resume-approval-1",
      trace_id: "trace-resume",
      result: {
        sessionId: "session-1",
        approval: {
          approvalId: "approval-1",
          approved: true,
          scope: "session",
          status: "approved",
        },
        checkpoint: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
        },
      },
    });
  });

  test("continues denied approval through native approval and session RPC", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "No file will be written.", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const resume = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "resume-approval-1",
        trace_id: "trace-resume-denied",
        method: "agent.resume_approval",
        params: {
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: false,
          scope: "once",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "approval.resolve"));
    const approvalRequest = parsedLines(lines).find((message) => message.method === "approval.resolve");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: approvalRequest?.id,
        trace_id: "trace-resume-denied",
        result: {
          approvalId: "approval-1",
          approved: false,
          scope: "once",
          status: "denied",
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.get_checkpoint"));
    const checkpointRequest = parsedLines(lines).find((message) => message.method === "session.get_checkpoint");
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest?.id,
        trace_id: "trace-resume-denied",
        result: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
          maxIterations: 2,
          stream: false,
          messages: [
            { role: "user", content: "write a file" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "approval-call-1", name: "request_approval", argumentsJson: "{}" }],
            },
            {
              role: "tool",
              content: "Waiting for approval.",
              toolCallId: "approval-call-1",
              name: "request_approval",
              metadata: {
                awaitingUserInput: true,
                stopReason: "awaiting_approval",
                approvalId: "approval-1",
                operation: {
                  toolName: "write_file",
                  arguments: { path: "notes/today.md", contents: "hello" },
                },
              },
            },
          ],
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.set_checkpoint"));
    const setCheckpointRequest = parsedLines(lines).find((message) => message.method === "session.set_checkpoint");
    expect(setCheckpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume-denied",
      method: "session.set_checkpoint",
      params: {
        session_id: "session-1",
        checkpoint: expect.objectContaining({
          runId: "run-1",
          phase: "final_response",
        }),
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: setCheckpointRequest?.id,
        trace_id: "trace-resume-denied",
        result: { session_id: "session-1" },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.persist_turn"));
    const persistRequest = parsedLines(lines).find((message) => message.method === "session.persist_turn");
    expect(persistRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-resume-denied",
      method: "session.persist_turn",
      params: {
        session_id: "session-1",
        run_id: "run-1",
        clear_checkpoint: true,
        messages: expect.arrayContaining([
          {
            role: "tool",
            content: "Approval denied: approval-1",
            tool_call_id: "approval-call-1",
            name: "request_approval",
            metadata: {
              approvalId: "approval-1",
              approved: false,
              status: "denied",
            },
          },
        ]),
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: persistRequest?.id,
        trace_id: "trace-resume-denied",
        result: { session_id: "session-1", saved_message_count: 4 },
      }),
    );
    await respondToMemoryCapture(server, lines, "trace-resume-denied");
    await resume;

    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "resume-approval-1",
      trace_id: "trace-resume-denied",
      result: {
        approval: {
          approvalId: "approval-1",
          approved: false,
          scope: "once",
          status: "denied",
        },
        result: {
          finalContent: "No file will be written.",
          stopReason: "final_response",
        },
      },
    });
  });

  test("submits a form through native session checkpoint and continues the run", async () => {
    const lines: string[] = [];
    const provider = new QueueProvider([{ content: "trip captured", toolCalls: [], stopReason: "stop" }]);
    const server = createAgentWorkerServer({
      provider,
      tools: new ToolRegistry(),
      writeLine: (line) => lines.push(line),
      writeLog: () => undefined,
    });

    const submit = server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: "submit-form-1",
        trace_id: "trace-submit-form",
        method: "agent.submit_form",
        params: {
          sessionId: "session-1",
          formId: "travel_plan",
          values: { destination: "Paris" },
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.get_checkpoint"));
    const checkpointRequest = parsedLines(lines).find((message) => message.method === "session.get_checkpoint");
    expect(checkpointRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      method: "session.get_checkpoint",
      params: { session_id: "session-1" },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: checkpointRequest?.id,
        trace_id: "trace-submit-form",
        result: {
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
          maxIterations: 2,
          stream: false,
          messages: [
            { role: "user", content: "plan a trip" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "form-call-1", name: "request_form", argumentsJson: "{}" }],
            },
            {
              role: "tool",
              content: "Waiting for form submission.",
              toolCallId: "form-call-1",
              name: "request_form",
              metadata: {
                awaitingUserInput: true,
                stopReason: "awaiting_form",
                formId: "travel_plan",
              },
            },
          ],
        },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.set_checkpoint"));
    const setRequest = parsedLines(lines).find((message) => message.method === "session.set_checkpoint");
    expect(setRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      method: "session.set_checkpoint",
      params: {
        session_id: "session-1",
        checkpoint: expect.objectContaining({
          runId: "run-1",
          phase: "final_response",
          model: "test-model",
        }),
      },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: setRequest?.id,
        trace_id: "trace-submit-form",
        result: { ok: true },
      }),
    );

    await waitFor(() => parsedLines(lines).some((line) => line.method === "session.persist_turn"));
    const persistRequest = parsedLines(lines).find((message) => message.method === "session.persist_turn");
    expect(persistRequest).toMatchObject({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      method: "session.persist_turn",
      params: { session_id: "session-1", run_id: "run-1", clear_checkpoint: true },
    });
    await server.handleLine(
      JSON.stringify({
        protocol_version: "1",
        id: persistRequest?.id,
        trace_id: "trace-submit-form",
        result: { session_id: "session-1", saved_message_count: 4 },
      }),
    );
    await respondToMemoryCapture(server, lines, "trace-submit-form");
    await submit;

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]).toContainEqual({
      role: "tool",
      content: "Agent UI form submitted: travel_plan\n{\"destination\":\"Paris\"}",
      toolCallId: "form-call-1",
      name: "request_form",
      metadata: {
        formId: "travel_plan",
        action: "submitted",
        values: { destination: "Paris" },
      },
    });
    expect(parsedLines(lines).at(-1)).toMatchObject({
      protocol_version: "1",
      id: "submit-form-1",
      trace_id: "trace-submit-form",
      result: {
        sessionId: "session-1",
        form: {
          formId: "travel_plan",
          action: "submitted",
          values: { destination: "Paris" },
        },
        result: {
          finalContent: "trip captured",
          stopReason: "final_response",
        },
      },
    });
  });
});

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (assertion()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}

async function respondToWorkerRequest(
  server: ReturnType<typeof createAgentWorkerServer>,
  lines: string[],
  method: string,
  result: unknown | ((request: ParsedLine) => unknown),
): Promise<ParsedLine> {
  await waitFor(() => parsedLines(lines).some((line) => line.method === method));
  const request = parsedLines(lines).find((line) => line.method === method);
  if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
    throw new Error(`missing ${method} request`);
  }
  await server.handleLine(
    JSON.stringify({
      protocol_version: "1",
      id: request.id,
      trace_id: request.trace_id,
      result: typeof result === "function" ? result(request) : result,
    }),
  );
  return request;
}

async function respondToConfigGet(server: ReturnType<typeof createAgentWorkerServer>, lines: string[], path: string, value: unknown): Promise<void> {
  await waitFor(() => parsedLines(lines).some((line) => line.method === "config.get" && line.params?.path === path));
  const request = parsedLines(lines).find((line) => line.method === "config.get" && line.params?.path === path);
  if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
    throw new Error(`missing config.get request for ${path}`);
  }
  await server.handleLine(
    JSON.stringify({
      protocol_version: "1",
      id: request.id,
      trace_id: request.trace_id,
      result: { path, value },
    }),
  );
}

async function respondToConfigSnapshot(server: ReturnType<typeof createAgentWorkerServer>, lines: string[], value: unknown): Promise<void> {
  await waitFor(() => parsedLines(lines).some((line) => line.method === "config.snapshot_public"));
  const request = parsedLines(lines).find((line) => line.method === "config.snapshot_public");
  if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
    throw new Error("missing config.snapshot_public request");
  }
  await server.handleLine(
    JSON.stringify({
      protocol_version: "1",
      id: request.id,
      trace_id: request.trace_id,
      result: { value },
    }),
  );
}

async function respondToProviderSecret(
  server: ReturnType<typeof createAgentWorkerServer>,
  lines: string[],
  providerId: string,
  value: unknown,
): Promise<void> {
  await waitFor(() => parsedLines(lines).some((line) => line.method === "provider.resolve_secret" && line.params?.providerId === providerId));
  const request = parsedLines(lines).find((line) => line.method === "provider.resolve_secret" && line.params?.providerId === providerId);
  if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
    throw new Error(`missing provider.resolve_secret request for ${providerId}`);
  }
  await server.handleLine(
    JSON.stringify({
      protocol_version: "1",
      id: request.id,
      trace_id: request.trace_id,
      result: value,
    }),
  );
}

async function respondToMemoryCapture(server: ReturnType<typeof createAgentWorkerServer>, lines: string[], traceId: string): Promise<void> {
  await waitFor(() => parsedLines(lines).some((line) => line.method === "memory.capture_evidence" && line.trace_id === traceId));
  const request = parsedLines(lines).find((line) => line.method === "memory.capture_evidence" && line.trace_id === traceId);
  if (!request || typeof request.id !== "string") {
    throw new Error(`missing memory.capture_evidence request for ${traceId}`);
  }
  await server.handleLine(
    JSON.stringify({
      protocol_version: "1",
      id: request.id,
      trace_id: traceId,
      result: { evidence: [] },
    }),
  );
}

async function respondToSkillsList(server: ReturnType<typeof createAgentWorkerServer>, lines: string[], skills: unknown[]): Promise<void> {
  const handled = handledSkillsListRequests(lines);
  await waitFor(() => pendingSkillsListRequest(lines, handled) !== undefined);
  const request = pendingSkillsListRequest(lines, handled);
  if (!request || typeof request.id !== "string" || typeof request.trace_id !== "string") {
    throw new Error("missing skills.list request");
  }
  handled.add(request.id);
  await server.handleLine(
    JSON.stringify({
      protocol_version: "1",
      id: request.id,
      trace_id: request.trace_id,
      result: { skills },
    }),
  );
}

const handledSkillsListByLines = new WeakMap<string[], Set<unknown>>();

function handledSkillsListRequests(lines: string[]): Set<unknown> {
  let handled = handledSkillsListByLines.get(lines);
  if (!handled) {
    handled = new Set();
    handledSkillsListByLines.set(lines, handled);
  }
  return handled;
}

function pendingSkillsListRequest(lines: string[], handled: Set<unknown>): ParsedLine | undefined {
  return parsedLines(lines).find((line) => line.method === "skills.list" && !handled.has(line.id));
}

function parsedLines(lines: string[]): ParsedLine[] {
  return lines.map((line) => JSON.parse(line));
}
