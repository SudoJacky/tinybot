import { describe, expect, test, vi } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import { MessageBus } from "../bus/messageBus";
import { CoworkScheduler } from "../cowork/coworkScheduler";
import { CoworkService, createMemoryCoworkStore } from "../cowork/coworkService";
import type { CoworkSession } from "../cowork/coworkTypes";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import type { WorkerEvent, WorkerRequest } from "../protocol/messages";
import { ToolRegistry } from "../tools/toolRegistry";
import { AgentWorker, type ProviderModelsListRequest } from "./agentWorker";

class QueueProvider implements ModelProvider {
  readonly options: Array<ModelRequestOptions | undefined> = [];
  readonly messages: AgentMessage[][] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], callbacks?: ModelRequestOptions): Promise<ModelResponse> {
    this.messages.push(messages);
    this.options.push(callbacks);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

function request(params: Record<string, unknown>): WorkerRequest {
  return {
    protocol_version: "1",
    id: "req-1",
    trace_id: "trace-1",
    method: "agent.run",
    params,
  };
}

function runInputRequest(params: Record<string, unknown>): WorkerRequest {
  return {
    protocol_version: "1",
    id: "run-input-1",
    trace_id: "trace-run-input",
    method: "agent.run_input",
    params,
  };
}

function cronRunDueRequest(params: Record<string, unknown>): WorkerRequest {
  return {
    protocol_version: "1",
    id: "cron-run-due-1",
    trace_id: "trace-cron-run-due",
    method: "cron.run_due",
    params,
  };
}

function heartbeatRequest(method: string, params: Record<string, unknown> = {}): WorkerRequest {
  return {
    protocol_version: "1",
    id: `${method}-1`,
    trace_id: `trace-${method}`,
    method,
    params,
  };
}

function coworkRequest(method: string, params: Record<string, unknown> = {}): WorkerRequest {
  return {
    protocol_version: "1",
    id: `${method}-1`,
    trace_id: `trace-${method}`,
    method,
    params,
  };
}

function cancelRequest(runId: string): WorkerRequest {
  return {
    protocol_version: "1",
    id: "cancel-1",
    trace_id: "trace-cancel",
    method: "agent.cancel",
    params: { runId },
  };
}

function snakeCancelRequest(runId: string): WorkerRequest {
  return {
    protocol_version: "1",
    id: "cancel-snake-1",
    trace_id: "trace-cancel-snake",
    method: "agent.cancel",
    params: { run_id: runId },
  };
}

function restoreCheckpointRequest(sessionId: string): WorkerRequest {
  return {
    protocol_version: "1",
    id: "restore-1",
    trace_id: "trace-restore",
    method: "agent.restore_checkpoint",
    params: { sessionId },
  };
}

function snakeRestoreCheckpointRequest(sessionId: string): WorkerRequest {
  return {
    protocol_version: "1",
    id: "restore-snake-1",
    trace_id: "trace-restore-snake",
    method: "agent.restore_checkpoint",
    params: { session_id: sessionId },
  };
}

function resumeApprovalRequest(params: Record<string, unknown>): WorkerRequest {
  return {
    protocol_version: "1",
    id: "resume-approval-1",
    trace_id: "trace-resume-approval",
    method: "agent.resume_approval",
    params,
  };
}

function submitFormRequest(params: Record<string, unknown>): WorkerRequest {
  return {
    protocol_version: "1",
    id: "submit-form-1",
    trace_id: "trace-submit-form",
    method: "agent.submit_form",
    params,
  };
}

function skillsWebuiListRequest(params: Record<string, unknown> = {}): WorkerRequest {
  return {
    protocol_version: "1",
    id: "skills-list-1",
    trace_id: "trace-skills-list",
    method: "skills.webui_list",
    params,
  };
}

function skillsWebuiDetailRequest(params: Record<string, unknown>): WorkerRequest {
  return {
    protocol_version: "1",
    id: "skills-detail-1",
    trace_id: "trace-skills-detail",
    method: "skills.webui_detail",
    params,
  };
}

function skillsWebuiMutationRequest(method: string, params: Record<string, unknown>): WorkerRequest {
  return {
    protocol_version: "1",
    id: `${method}-1`,
    trace_id: `trace-${method}`,
    method,
    params,
  };
}

function webuiRequest(method: string, params: Record<string, unknown> = {}): WorkerRequest {
  return {
    protocol_version: "1",
    id: `${method}-1`,
    trace_id: `trace-${method}`,
    method,
    params,
  };
}

function channelRequest(method: string, params: Record<string, unknown> = {}): WorkerRequest {
  return {
    protocol_version: "1",
    id: `${method}-1`,
    trace_id: `trace-${method}`,
    method,
    params,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("AgentWorker", () => {
  test("reports WebUI route migration owners and route groups", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    const response = await worker.handleRequest(webuiRequest("webui.route_specs"));
    const routes = (response.result as { route_diagnostics: Array<Record<string, unknown>> }).route_diagnostics;
    const route = (key: string, method: string) => routes.find((item) => item.key === key && item.method === method);

    expect(route("get_status", "GET")).toMatchObject({
      key: "get_status",
      method: "GET",
      path: "/api/status",
      public: false,
      owner: "ts-worker",
      route_group: "status",
    });
    expect(route("openai_chat_completions", "POST")).toMatchObject({
      key: "openai_chat_completions",
      method: "POST",
      path: "/v1/chat/completions",
      public: true,
      owner: "ts-worker",
      route_group: "openai",
    });
    expect(route("cowork_route", "POST")).toMatchObject({
      key: "cowork_route",
      method: "POST",
      path: "/api/cowork/{path:.+}",
      public: false,
      owner: "ts-worker",
      route_group: "cowork",
    });
  });

  test("serves WebUI status control route through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      statusProvider: {
        channelRunning: true,
        provider: { name: "openai", profile: "default" },
        model: "gpt-test",
      },
      heartbeatRuntime: {
        start: vi.fn(async () => true),
        stop: vi.fn(() => undefined),
        triggerNow: vi.fn(async () => ({ status: "skipped", reason: "no_active_tasks" })),
        getStatus: vi.fn(() => ({
          enabled: true,
          running: false,
          intervalMs: 120_000,
          lastResult: { status: "skipped", tasks: "" },
        })),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "get_status", method: "GET", path: "/api/status", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/status",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          channels: { websocket: { enabled: true, running: true } },
          heartbeat: {
            enabled: true,
            running: false,
            interval_ms: 120_000,
            last_result: { status: "skipped", tasks: "" },
          },
          provider: { name: "openai", profile: "default" },
          model: "gpt-test",
        },
      },
    });
  });

  test("maps transport events to legacy gateway WebSocket frames through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await expect(worker.handleRequest(webuiRequest("transport.gateway_frame", {
      kind: "message",
      chatId: "chat-1",
      content: "reading file",
      metadata: {
        _stream_id: "msg-1",
        _progress: true,
        _tool_name: "read_file",
      },
    }))).resolves.toMatchObject({
      result: {
        event: "message",
        chat_id: "chat-1",
        message_id: "msg-1",
        text: "reading file",
        _progress: true,
        _tool_name: "read_file",
      },
    });
  });

  test("maps inbound WebSocket client frames through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await expect(worker.handleRequest(webuiRequest("transport.websocket_message", {
      clientId: "client-1",
      attachedChatId: "chat-1",
      frame: {
        type: "message",
        chat_id: "chat-1",
        content: "  hello  ",
        use_persistent_rag: true,
      },
    }))).resolves.toMatchObject({
      result: {
        kind: "message",
        chatId: "chat-1",
        sessionId: "websocket:chat-1",
        inbound: {
          channel: "websocket",
          sender_id: "client-1",
          chat_id: "chat-1",
          content: "hello",
          metadata: { _use_persistent_rag: true },
          session_key: "websocket:chat-1",
        },
        frames: [],
      },
    });
  });

  test("cancels active WebSocket session runs through transport interrupt frames", async () => {
    const events: WorkerEvent[] = [];
    const completion = deferred<ModelResponse>();
    const provider: ModelProvider = {
      complete: async () => completion.promise,
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const runResponsePromise = worker.handleRequest(
      request({
        spec: {
          runId: "websocket-run-1",
          sessionId: "websocket:chat-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: true,
        },
      }),
    );

    await expect(worker.handleRequest(webuiRequest("transport.websocket_message", {
      clientId: "client-1",
      frame: {
        type: "interrupt",
        chat_id: "chat-1",
      },
    }))).resolves.toMatchObject({
      result: {
        kind: "interrupt",
        chatId: "chat-1",
        sessionId: "websocket:chat-1",
        frames: [{ event: "interrupted", chat_id: "chat-1", cancelled: true }],
      },
    });

    completion.resolve({ content: "late answer", toolCalls: [], stopReason: "stop" });
    const runResponse = await runResponsePromise;

    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.cancelled",
      payload: expect.objectContaining({ runId: "websocket-run-1" }),
    }));
    expect(runResponse.result).toMatchObject({
      finalContent: "",
      stopReason: "cancelled",
      error: "cancelled",
    });
  });

  test("dispatches channel inbound envelopes through the agent run_input path", async () => {
    const events: WorkerEvent[] = [];
    const provider = new QueueProvider([
      {
        content: "channel done",
        toolCalls: [],
        stopReason: "stop",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, cachedTokens: 1 },
      },
    ]);
    const loadedInputs: Array<{
      runId: string;
      sessionId: string;
      channel?: string;
      chatId?: string;
      stream?: boolean;
      metadata?: Record<string, unknown>;
      traceId: string;
    }> = [];
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
      contextBridge: {
        loadContextInput: async (input, traceId) => {
          loadedInputs.push({
            runId: input.runId,
            sessionId: input.sessionId,
            channel: input.channel,
            chatId: input.chatId,
            stream: input.stream,
            metadata: input.metadata,
            traceId,
          });
          return {
            input: {
              identity: "Identity",
              currentMessage: input.input.content,
              runtime: {
                currentTime: "2026-06-13 10:00:00 Asia/Shanghai",
                channel: input.channel,
                chatId: input.chatId,
              },
            },
            metadata: {
              missingSession: false,
              malformedHistoryCount: 0,
              missingBootstrapFiles: [],
              bootstrapFallbackUsed: false,
            },
          };
        },
      },
    });

    const response = await worker.handleRequest(channelRequest("channel.dispatch_inbound", {
      message: {
        channel: "websocket",
        sender_id: "client-1",
        chat_id: "chat-1",
        content: "hello from channel",
        timestamp: "2026-06-13T02:00:00.000Z",
        media: ["file://clip.png"],
        metadata: { _wants_stream: true, message_id: "msg-1" },
        session_key_override: "thread:42",
      },
    }));

    expect(loadedInputs).toEqual([
      expect.objectContaining({
        runId: "channel-websocket-chat-1-1",
        sessionId: "thread:42",
        channel: "websocket",
        chatId: "chat-1",
        stream: true,
        metadata: expect.objectContaining({
          senderId: "client-1",
          message_id: "msg-1",
        }),
        traceId: "trace-channel.dispatch_inbound",
      }),
    ]);
    expect(provider.messages[0]?.at(-1)?.role).toBe("user");
    expect(provider.messages[0]?.at(-1)?.content).toContain("hello from channel");
    expect(response).toMatchObject({
      protocol_version: "1",
      id: "channel.dispatch_inbound-1",
      trace_id: "trace-channel.dispatch_inbound",
      result: {
        dispatched: 1,
        outboundMessages: [
          expect.objectContaining({
            channel: "websocket",
            chatId: "chat-1",
            content: "",
            metadata: expect.objectContaining({
              _usage: true,
              usage_data: {
                prompt_tokens: 4,
                completion_tokens: 2,
                total_tokens: 6,
                cached_tokens: 1,
              },
            }),
          }),
          expect.objectContaining({
            channel: "websocket",
            chatId: "chat-1",
            content: "",
            metadata: expect.objectContaining({ _streamed: true }),
          }),
        ],
        outbound_messages: [
          expect.objectContaining({ channel: "websocket", chat_id: "chat-1" }),
          expect.objectContaining({ channel: "websocket", chat_id: "chat-1" }),
        ],
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.done",
      payload: expect.objectContaining({
        runId: "channel-websocket-chat-1-1",
        stopReason: "final_response",
      }),
    }));
  });

  test("publishes channel inbound replies onto the shared channel bus for native dispatch", async () => {
    const channelBus = new MessageBus();
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "native channel reply",
          toolCalls: [],
          stopReason: "stop",
        },
      ]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      channelBus,
      contextBridge: {
        loadContextInput: async (input) => ({
          input: {
            identity: "Identity",
            currentMessage: input.input.content,
            runtime: {
              currentTime: "2026-06-14 10:00:00 Asia/Shanghai",
              channel: input.channel,
              chatId: input.chatId,
            },
          },
          metadata: {
            missingSession: false,
            malformedHistoryCount: 0,
            missingBootstrapFiles: [],
            bootstrapFallbackUsed: false,
          },
        }),
      },
    });

    const response = await worker.handleRequest(channelRequest("channel.dispatch_inbound", {
      message: {
        channel: "feishu",
        sender_id: "ou_1",
        chat_id: "oc_1",
        content: "hello",
        timestamp: "2026-06-14T02:00:00.000Z",
        media: [],
        metadata: {},
      },
    }));

    expect(response).toMatchObject({
      result: {
        outboundMessages: [
          expect.objectContaining({
            channel: "feishu",
            chatId: "oc_1",
            content: "native channel reply",
          }),
        ],
      },
    });
    expect(channelBus.drainOutboundForTest()).toEqual([
      expect.objectContaining({
        channel: "feishu",
        chatId: "oc_1",
        content: "native channel reply",
      }),
    ]);
  });

  test("dispatches channel stop commands through active session cancellation without loading agent context", async () => {
    const events: WorkerEvent[] = [];
    const completion = deferred<ModelResponse>();
    let providerCalls = 0;
    const loadedInputs: AgentRunInput[] = [];
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return completion.promise;
        }
        throw new Error("channel stop reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
      contextBridge: {
        loadContextInput: async (input) => {
          loadedInputs.push(input);
          return {
            input: {
              identity: "Identity",
              currentMessage: input.input.content,
              runtime: {
                currentTime: "2026-06-13 10:00:00 Asia/Shanghai",
                channel: input.channel,
                chatId: input.chatId,
              },
            },
            metadata: {
              missingSession: false,
              malformedHistoryCount: 0,
              missingBootstrapFiles: [],
              bootstrapFallbackUsed: false,
            },
          };
        },
      },
    });

    const runResponsePromise = worker.handleRequest(
      request({
        spec: {
          runId: "run-channel-active-1",
          sessionId: "websocket:chat-1",
          messages: [{ role: "user", content: "keep working" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    const stopResponse = await worker.handleRequest(channelRequest("channel.dispatch_inbound", {
      message: {
        channel: "websocket",
        sender_id: "client-1",
        chat_id: "chat-1",
        content: "/stop",
        timestamp: "2026-06-13T02:00:00.000Z",
        media: [],
        metadata: {},
      },
    }));
    completion.resolve({ content: "late answer", toolCalls: [], stopReason: "stop" });
    const runResponse = await runResponsePromise;

    expect(providerCalls).toBe(1);
    expect(loadedInputs).toEqual([]);
    expect(stopResponse).toMatchObject({
      result: {
        dispatched: 1,
        outboundMessages: [
          expect.objectContaining({
            channel: "websocket",
            chatId: "chat-1",
            content: "Stopped 1 task(s).",
            metadata: expect.objectContaining({
              command: "/stop",
              cancelled_count: 1,
              run_ids: ["run-channel-active-1"],
            }),
          }),
        ],
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.cancelled",
      payload: expect.objectContaining({ runId: "run-channel-active-1" }),
    }));
    expect(runResponse.result).toMatchObject({
      finalContent: "",
      stopReason: "cancelled",
      error: "cancelled",
    });
  });

  test("serves WebUI tools control route through TS worker RPC", async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: "shell",
      description: "A".repeat(250),
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "ok" }),
    });

    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools,
      emitEvent: () => undefined,
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "get_tools", method: "GET", path: "/api/tools", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/tools",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          tools: [{ name: "shell", description: "A".repeat(200) }],
        },
      },
    });
  });

  test("serves WebUI skills read routes through TS worker RPC", async () => {
    const calls: Array<{ type: string; traceId: string; name?: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      skillsBridge: {
        listWebuiSkills: async (traceId) => {
          calls.push({ type: "list", traceId });
          return { skills: [{ name: "planner/phase", tinybot_meta: { always: true } }] };
        },
        getWebuiSkillDetail: async (name, traceId) => {
          calls.push({ type: "detail", traceId, name });
          return { name, content: "Plan.", tinybot_meta: { always: true } };
        },
        createWebuiSkill: async () => ({}),
        updateWebuiSkill: async () => ({}),
        deleteWebuiSkill: async () => ({}),
        validateWebuiSkill: async () => ({}),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "get_skills", method: "GET", path: "/api/skills", public: false },
          { key: "get_skill_detail", method: "GET", path: "/api/skills/{name}", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/skills",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: { skills: [{ name: "planner/phase", tinybot_meta: { always: true } }] },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/skills/planner%2Fphase",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: { name: "planner/phase", content: "Plan.", tinybot_meta: { always: true } },
      },
    });
    expect(calls).toEqual([
      { type: "list", traceId: "trace-webui.handle_request" },
      { type: "detail", traceId: "trace-webui.handle_request", name: "planner/phase" },
    ]);
  });

  test("serves WebUI skills mutation routes through TS worker RPC", async () => {
    const calls: Array<{ type: string; traceId: string; name?: string; body?: unknown }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      skillsBridge: {
        listWebuiSkills: async () => ({}),
        getWebuiSkillDetail: async () => ({}),
        createWebuiSkill: async (body, traceId) => {
          calls.push({ type: "create", traceId, body });
          return { created: true, name: "planner" };
        },
        updateWebuiSkill: async (name, body, traceId) => {
          calls.push({ type: "update", traceId, name, body });
          return { updated: true, name };
        },
        deleteWebuiSkill: async (name, traceId) => {
          calls.push({ type: "delete", traceId, name });
          return { deleted: true, name };
        },
        validateWebuiSkill: async (name, traceId) => {
          calls.push({ type: "validate", traceId, name });
          return { valid: true, name };
        },
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "create_skill", method: "POST", path: "/api/skills", public: false },
          { key: "update_skill", method: "PATCH", path: "/api/skills/{name}", public: false },
          { key: "delete_skill", method: "DELETE", path: "/api/skills/{name}", public: false },
          { key: "validate_skill", method: "POST", path: "/api/skills/{name}/validate", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/skills",
      body: { name: "planner", content: "Plan." },
    }))).resolves.toMatchObject({
      result: { status: 200, body: { created: true, name: "planner" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "PATCH",
      path: "/api/skills/planner%2Fphase",
      body: { content: "Updated." },
    }))).resolves.toMatchObject({
      result: { status: 200, body: { updated: true, name: "planner/phase" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "DELETE",
      path: "/api/skills/planner%2Fphase",
    }))).resolves.toMatchObject({
      result: { status: 200, body: { deleted: true, name: "planner/phase" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/skills/planner%2Fphase/validate",
    }))).resolves.toMatchObject({
      result: { status: 200, body: { valid: true, name: "planner/phase" } },
    });
    expect(calls).toEqual([
      { type: "create", traceId: "trace-webui.handle_request", body: { name: "planner", content: "Plan." } },
      { type: "update", traceId: "trace-webui.handle_request", name: "planner/phase", body: { content: "Updated." } },
      { type: "delete", traceId: "trace-webui.handle_request", name: "planner/phase" },
      { type: "validate", traceId: "trace-webui.handle_request", name: "planner/phase" },
    ]);
  });

  test("serves Python-compatible WebUI skills route errors through TS worker RPC", async () => {
    const calls: Array<{ type: string; traceId: string; name?: string; body?: unknown }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      skillsBridge: {
        listWebuiSkills: async () => ({}),
        getWebuiSkillDetail: async (name, traceId) => {
          calls.push({ type: "detail", traceId, name });
          return null;
        },
        createWebuiSkill: async (body, traceId) => {
          calls.push({ type: "create", traceId, body });
          throw Object.assign(new Error("skill 'planner' already exists"), { status: 409 });
        },
        updateWebuiSkill: async () => ({}),
        deleteWebuiSkill: async (name, traceId) => {
          calls.push({ type: "delete", traceId, name });
          throw Object.assign(new Error("cannot delete builtin skills"), { status: 403 });
        },
        validateWebuiSkill: async () => ({}),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/skills",
      body: "not-json-object",
    }))).resolves.toMatchObject({
      result: { status: 400, body: { error: "invalid json body" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/skills",
      body: { name: "planner" },
    }))).resolves.toMatchObject({
      result: { status: 409, body: { error: "skill 'planner' already exists" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "PATCH",
      path: "/api/skills/planner",
      body: "not-json-object",
    }))).resolves.toMatchObject({
      result: { status: 400, body: { error: "invalid json body" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/skills/missing",
    }))).resolves.toMatchObject({
      result: { status: 404, body: { error: "skill not found" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "DELETE",
      path: "/api/skills/builtin",
    }))).resolves.toMatchObject({
      result: { status: 403, body: { error: "cannot delete builtin skills" } },
    });
    expect(calls).toEqual([
      { type: "create", traceId: "trace-webui.handle_request", body: { name: "planner" } },
      { type: "detail", traceId: "trace-webui.handle_request", name: "missing" },
      { type: "delete", traceId: "trace-webui.handle_request", name: "builtin" },
    ]);
  });

  test("serves WebUI bootstrap route through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiBootstrapProvider: {
        bootstrap: async () => ({
          token: "native-token-1",
          ws_path: "/ws",
          token_ttl_s: 3600,
          refresh_token_path: "/webui/refresh-token",
          sessions_path: "/api/sessions",
          workspace_files_path: "/api/workspace/files",
          cowork_path: "/api/cowork",
        }),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "bootstrap", method: "GET", path: "/webui/bootstrap", public: true },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/webui/bootstrap",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          token: "native-token-1",
          ws_path: "/ws",
          token_ttl_s: 3600,
          refresh_token_path: "/webui/refresh-token",
          sessions_path: "/api/sessions",
          workspace_files_path: "/api/workspace/files",
          cowork_path: "/api/cowork",
        },
      },
    });
  });

  test("serves WebUI refresh-token route through TS worker RPC", async () => {
    const refreshRequests: Array<{ token: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiBootstrapProvider: {
        bootstrap: async () => ({
          token: "native-token-1",
          ws_path: "/ws",
          token_ttl_s: 3600,
          refresh_token_path: "/webui/refresh-token",
          sessions_path: "/api/sessions",
          workspace_files_path: "/api/workspace/files",
          cowork_path: "/api/cowork",
        }),
        refreshToken: async (token: string, traceId: string) => {
          refreshRequests.push({ token, traceId });
          return token === "native-token-1" ? { token, token_ttl_s: 3600 } : null;
        },
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "refresh_token", method: "POST", path: "/webui/refresh-token", public: true },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/webui/refresh-token",
      headers: { Authorization: "Bearer native-token-1" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          token: "native-token-1",
          token_ttl_s: 3600,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/webui/refresh-token",
      headers: { Authorization: "Bearer wrong-token" },
    }))).resolves.toMatchObject({
      result: {
        status: 401,
        body: { error: "unauthorized" },
      },
    });
    expect(refreshRequests).toEqual([
      { token: "native-token-1", traceId: "trace-webui.handle_request" },
      { token: "wrong-token", traceId: "trace-webui.handle_request" },
    ]);
  });

  test("serves WebUI config route through TS worker RPC", async () => {
    const patchRequests: Array<{ body: Record<string, unknown>; traceId: string }> = [];
    const heartbeatRuntime = {
      start: vi.fn(async () => true),
      stop: vi.fn(() => undefined),
      triggerNow: vi.fn(async () => ({ status: "missing_file" as const })),
      getStatus: vi.fn(() => ({
        enabled: true,
        running: true,
        executing: false,
        intervalMs: 120_000,
        lastResult: null,
        lastError: null,
      })),
      refreshConfig: vi.fn(async () => ({
        enabled: false,
        running: false,
        executing: false,
        intervalMs: 5_000,
        lastResult: null,
        lastError: null,
      })),
    };
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
          providers: { dashscope: { api_key: "********" } },
        }),
        patchConfig: async (body, traceId) => {
          patchRequests.push({ body, traceId });
          return {
            config: {
              agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } },
              providers: {
                dashscope: { api_key: "********" },
                openrouter: { api_key: "********", api_base: "https://openrouter.ai/api/v1" },
              },
            },
            updatedFields: ["agents.defaults.provider", "agents.defaults.model", "providers.openrouter"],
          };
        },
      },
      heartbeatRuntime,
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "get_config", method: "GET", path: "/api/config", public: false },
          { key: "patch_config", method: "PATCH", path: "/api/config", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/config",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
          providers: { dashscope: { api_key: "********" } },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "PATCH",
      path: "/api/config",
      body: {
        agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } },
        providers: { openrouter: { api_key: "or-key", api_base: "https://openrouter.ai/api/v1" } },
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          config: {
            agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } },
            providers: {
              dashscope: { api_key: "********" },
              openrouter: { api_key: "********", api_base: "https://openrouter.ai/api/v1" },
            },
          },
          updatedFields: ["agents.defaults.provider", "agents.defaults.model", "providers.openrouter"],
        },
      },
    });
    expect(patchRequests).toEqual([
      {
        body: {
          agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } },
          providers: { openrouter: { api_key: "or-key", api_base: "https://openrouter.ai/api/v1" } },
        },
        traceId: "trace-webui.handle_request",
      },
    ]);
    expect(heartbeatRuntime.refreshConfig).toHaveBeenCalledTimes(1);
  });

  test("serves OpenAI-compatible health and models routes through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "health", method: "GET", path: "/health", public: true },
          { key: "openai_models", method: "GET", path: "/v1/models", public: true },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/health",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: { status: "ok" },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/models",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "list",
          data: [
            {
              id: "openai/gpt-4o-mini",
              object: "model",
              created: 0,
              owned_by: "tinybot",
            },
          ],
        },
      },
    });
  });

  test("serves non-stream OpenAI-compatible chat completions through TS worker RPC", async () => {
    const provider = new QueueProvider([{ content: "TS answer", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "openai_chat_completions", method: "POST", path: "/v1/chat/completions", public: true },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: [{ type: "text", text: "Hello" }, { type: "text", text: "API" }] }],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          id: expect.stringMatching(/^chatcmpl-/),
          object: "chat.completion",
          created: expect.any(Number),
          model: "openai/gpt-4o-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "TS answer" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
      },
    });
    expect(provider.messages.at(-1)).toEqual([{ role: "user", content: "Hello API" }]);

    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "other-model",
        messages: [{ role: "user", content: "Hello" }],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Only configured model 'openai/gpt-4o-mini' is available",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: 123,
        messages: [{ role: "user", content: "Hello" }],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Only configured model 'openai/gpt-4o-mini' is available",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: ["openai/gpt-4o-mini"],
        messages: [{ role: "user", content: "Hello" }],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Only configured model 'openai/gpt-4o-mini' is available",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      },
    }))).resolves.toMatchObject({
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
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        stream: "true",
        messages: [{ role: "user", content: "Hello" }],
      },
    }))).resolves.toMatchObject({
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
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        messages: [{ role: "system", content: "No" }, { role: "user", content: "Hello" }],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Only a single user message is supported",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
  });

  test("retries empty OpenAI-compatible chat completions with original API content", async () => {
    const provider = new QueueProvider([
      { content: "   ", toolCalls: [], stopReason: "stop" },
      { content: "", toolCalls: [], stopReason: "stop" },
      { content: "Recovered answer", toolCalls: [], stopReason: "stop" },
    ]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "Recover please" }],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          choices: [
            {
              message: { role: "assistant", content: "Recovered answer" },
            },
          ],
        },
      },
    });
    expect(provider.messages).toHaveLength(3);
    expect(provider.messages[0]).toEqual([{ role: "user", content: "Recover please" }]);
    expect(provider.messages[2]).toEqual([{ role: "user", content: "Recover please" }]);
  });

  test("serializes OpenAI-compatible chat completions per API session", async () => {
    const firstCompletion = deferred<ModelResponse>();
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return firstCompletion.promise;
        }
        return { content: "second answer", toolCalls: [], stopReason: "stop" };
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });
    const chatRequest = (content: string) => worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        session_id: "same-session",
        messages: [{ role: "user", content }],
      },
    }));

    const firstResponsePromise = chatRequest("first");
    await Promise.resolve();
    const secondResponsePromise = chatRequest("second");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(providerCalls).toBe(1);
    firstCompletion.resolve({ content: "first answer", toolCalls: [], stopReason: "stop" });
    await expect(firstResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "first answer" } }] },
      },
    });
    await expect(secondResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "second answer" } }] },
      },
    });
    expect(providerCalls).toBe(2);
  });

  test("does not serialize distinct numeric OpenAI-compatible API sessions", async () => {
    const firstCompletion = deferred<ModelResponse>();
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return firstCompletion.promise;
        }
        return { content: "second numeric answer", toolCalls: [], stopReason: "stop" };
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });
    const chatRequest = (sessionId: number, content: string) => worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        session_id: sessionId,
        messages: [{ role: "user", content }],
      },
    }));

    const firstResponsePromise = chatRequest(1, "first");
    await Promise.resolve();
    const secondResponsePromise = chatRequest(2, "second");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(providerCalls).toBe(2);
    firstCompletion.resolve({ content: "first numeric answer", toolCalls: [], stopReason: "stop" });
    await expect(firstResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "first numeric answer" } }] },
      },
    });
    await expect(secondResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "second numeric answer" } }] },
      },
    });
  });

  test("ignores camelCase OpenAI-compatible sessionId like Python", async () => {
    const firstCompletion = deferred<ModelResponse>();
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return firstCompletion.promise;
        }
        return { content: "second default answer", toolCalls: [], stopReason: "stop" };
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });
    const chatRequest = (sessionId: string, content: string) => worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        sessionId,
        messages: [{ role: "user", content }],
      },
    }));

    const firstResponsePromise = chatRequest("camel-one", "first");
    await Promise.resolve();
    const secondResponsePromise = chatRequest("camel-two", "second");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(providerCalls).toBe(1);
    firstCompletion.resolve({ content: "first default answer", toolCalls: [], stopReason: "stop" });
    await expect(firstResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "first default answer" } }] },
      },
    });
    await expect(secondResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "second default answer" } }] },
      },
    });
    expect(providerCalls).toBe(2);
  });

  test("stringifies object OpenAI-compatible session ids like Python", async () => {
    const firstCompletion = deferred<ModelResponse>();
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return firstCompletion.promise;
        }
        return { content: "second object answer", toolCalls: [], stopReason: "stop" };
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });
    const chatRequest = (sessionId: Record<string, unknown>, content: string) => worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        session_id: sessionId,
        messages: [{ role: "user", content }],
      },
    }));

    const firstResponsePromise = chatRequest({ alpha: 1 }, "first");
    await Promise.resolve();
    const secondResponsePromise = chatRequest({ beta: 1 }, "second");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(providerCalls).toBe(2);
    firstCompletion.resolve({ content: "first object answer", toolCalls: [], stopReason: "stop" });
    await expect(firstResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "first object answer" } }] },
      },
    });
    await expect(secondResponsePromise).resolves.toMatchObject({
      result: {
        status: 200,
        body: { choices: [{ message: { content: "second object answer" } }] },
      },
    });
  });

  test("returns OpenAI-compatible timeout errors for slow chat completions", async () => {
    const provider: ModelProvider = {
      complete: async () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ content: "late answer", toolCalls: [], stopReason: "stop" }), 20);
        }),
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: async () => ({
          api: { timeout: 0.001 },
          agents: { defaults: { provider: "openai", model: "openai/gpt-4o-mini" } },
        }),
        patchConfig: async () => ({ config: {}, updatedFields: [] }),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/chat/completions",
      body: {
        model: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "slow" }],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 504,
        body: {
          error: {
            message: "Request timed out after 0.001s",
            type: "invalid_request_error",
            code: 504,
          },
        },
      },
    });
  });

  test("serves WebUI providers route through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      listProviderCatalog: async () => ({
        providers: [
          {
            id: "dashscope",
            displayName: "DashScope",
            status: "ready",
          },
        ],
      }),
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "providers", method: "GET", path: "/api/providers", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/providers",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          providers: [
            {
              id: "dashscope",
              displayName: "DashScope",
              status: "ready",
            },
          ],
        },
      },
    });
  });

  test("serves WebUI provider models route through TS worker RPC", async () => {
    const requests: ProviderModelsListRequest[] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      listProviderModels: (request) => {
        requests.push(request);
        return {
          providerId: request.providerId,
          models: ["qwen-max", "qwen-manual"],
          modelSources: {
            "qwen-max": ["curated"],
            "qwen-manual": ["manual"],
          },
          sourceCounts: { curated: 1, profile: 0, live: 0, manual: 1 },
          warning: null,
          url: null,
        };
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "provider_models", method: "POST", path: "/api/provider-models", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/provider-models",
      body: { provider: "dashscope", manual_models: "qwen-manual", refresh_live: true },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          ok: true,
          models: ["qwen-max", "qwen-manual"],
          model_sources: {
            "qwen-max": ["curated"],
            "qwen-manual": ["manual"],
          },
          sources: { curated: 1, profile: 0, live: 0, manual: 1 },
          warning: null,
          url: null,
        },
      },
    });
    expect(requests).toEqual([
      {
        providerId: "dashscope",
        manualModelIds: ["qwen-manual"],
        refreshLive: true,
      },
    ]);
  });

  test("serves WebUI pending approvals control route through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      approvalBridge: {
        requestApproval: async () => ({}),
        resolveApproval: async () => ({}),
        listPendingApprovals: async (sessionId: string, traceId: string) => ({
          session_key: sessionId,
          trace_id: traceId,
          approvals: [
            {
              id: "approval-1",
              tool_name: "shell",
              category: "command",
              risk: "high",
              reason: "Deletes files",
              summary: "Run risky command",
              created_at: "2026-06-13T10:00:00.000Z",
            },
          ],
        }),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "get_approvals", method: "GET", path: "/api/approvals", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/approvals?session_key=websocket%3Achat-1",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session_key: "websocket:chat-1",
          approvals: [
            {
              id: "approval-1",
              tool_name: "shell",
              category: "command",
              risk: "high",
              reason: "Deletes files",
              summary: "Run risky command",
              created_at: "2026-06-13T10:00:00.000Z",
            },
          ],
        },
      },
    });
  });

  test("serves WebUI approval resolution routes through TS worker RPC", async () => {
    const resolved: Array<{ sessionId: string; approvalId: string; approved: boolean; scope?: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      approvalBridge: {
        requestApproval: async () => ({}),
        listPendingApprovals: async () => ({ approvals: [] }),
        resolveApproval: async (params) => {
          resolved.push(params);
          return {
            approval: {
              id: params.approvalId,
              tool_name: "shell",
              category: "command",
              risk: "high",
              reason: "Deletes files",
              summary: params.approved ? "Approved command" : "Denied command",
              created_at: "2026-06-13T10:00:00.000Z",
            },
          };
        },
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "approve_approval", method: "POST", path: "/api/approvals/{approval_id}/approve", public: false },
          { key: "deny_approval", method: "POST", path: "/api/approvals/{approval_id}/deny", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/approvals/approval%2F1/approve",
      body: { session_key: "websocket:chat-1", scope: "session", auto_retry: false },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          approved: true,
          approval: { id: "approval/1", summary: "Approved command" },
          scope: "session",
          auto_retry: false,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/approvals/approval%2F1/deny",
      body: { session_key: "websocket:chat-1" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          denied: true,
          approval: { id: "approval/1", summary: "Denied command" },
        },
      },
    });
    expect(resolved).toEqual([
      { sessionId: "websocket:chat-1", approvalId: "approval/1", approved: true, scope: "session" },
      { sessionId: "websocket:chat-1", approvalId: "approval/1", approved: false },
    ]);
  });

  test("serves WebUI Agent UI form continuation routes through TS worker RPC", async () => {
    const clearedSessions: string[] = [];
    const appendedMessages: AgentMessage[][] = [];
    const checkpointForForm = (sessionId: string, formId: string) => ({
      sessionId,
      runId: `run-${formId}`,
      phase: "tools_completed",
      model: "test-model",
      maxIterations: 2,
      stream: false,
      messages: [
        { role: "user", content: "collect preferences" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: `form-call-${formId}`, name: "request_form", argumentsJson: "{}" }],
        },
        {
          role: "tool",
          content: "Waiting for form submission.",
          toolCallId: `form-call-${formId}`,
          name: "request_form",
          metadata: {
            awaitingUserInput: true,
            stopReason: "awaiting_form",
            formId,
          },
        },
      ],
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([
        { content: "Submitted values received.", toolCalls: [], stopReason: "stop" },
        { content: "Cancelled form acknowledged.", toolCalls: [], stopReason: "stop" },
      ]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async (sessionId) =>
          checkpointForForm(sessionId, sessionId.endsWith("cancel") ? "travel_cancel" : "travel_plan"),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "submit_agent_ui_form", method: "POST", path: "/api/agent-ui/forms/{form_id}/submit", public: false },
          { key: "cancel_agent_ui_form", method: "POST", path: "/api/agent-ui/forms/{form_id}/cancel", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/agent-ui/forms/travel_plan/submit",
      body: {
        correlation: { session_key: "websocket:chat-forms" },
        values: { destination: "Paris", nights: 3 },
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          submitted: true,
          form_id: "travel_plan",
          values: { destination: "Paris", nights: 3 },
          event: {
            event_type: "ui.form.submitted",
            payload: {
              form_id: "travel_plan",
              values: { destination: "Paris", nights: 3 },
            },
          },
          continuation: {
            mode: "resume",
            delivered: true,
            target: "agent_loop",
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/agent-ui/forms/travel_cancel/cancel",
      body: {
        correlation: { session_id: "websocket:chat-cancel" },
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          cancelled: true,
          form_id: "travel_cancel",
          event: {
            event_type: "ui.form.cancelled",
            payload: {
              form_id: "travel_cancel",
            },
          },
          continuation: {
            mode: "resume",
            delivered: true,
            target: "agent_loop",
          },
        },
      },
    });
    expect(clearedSessions).toEqual(["websocket:chat-forms", "websocket:chat-cancel"]);
    expect(appendedMessages.flat()).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "Submitted values received." }),
      expect.objectContaining({ role: "assistant", content: "Cancelled form acknowledged." }),
    ]));
  });

  test("serves WebUI workspace file routes through TS worker RPC", async () => {
    const calls: Array<{ method: string; path?: string; contents?: string; expectedUpdatedAt?: string | null }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      workspaceBridge: {
        listFiles: async (traceId: string) => {
          calls.push({ method: `list:${traceId}` });
          return [
            { path: "AGENTS.md", sizeBytes: 32 },
            { path: "docs/notes.md", sizeBytes: 64 },
          ];
        },
        readFile: async (path: string, traceId: string) => {
          calls.push({ method: `read:${traceId}`, path });
          return { path, content: `# ${path}\n`, exists: true, updatedAt: null };
        },
        writeFile: async (path: string, contents: string, traceId: string, expectedUpdatedAt?: string | null) => {
          calls.push({ method: `write:${traceId}`, path, contents, expectedUpdatedAt });
          if (expectedUpdatedAt === "stale") {
            throw new Error("version conflict");
          }
          return { path, updatedAt: null };
        },
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "list_workspace_files", method: "GET", path: "/api/workspace/files", public: false },
          { key: "get_workspace_file", method: "GET", path: "/api/workspace/files/{path:.+}", public: false },
          { key: "put_workspace_file", method: "PUT", path: "/api/workspace/files/{path:.+}", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/workspace/files",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          items: [
            { path: "AGENTS.md", exists: true, updated_at: null },
            { path: "docs/notes.md", exists: true, updated_at: null },
          ],
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/workspace/files/docs%2Fnotes.md",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          path: "docs/notes.md",
          content: "# docs/notes.md\n",
          exists: true,
          updated_at: null,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "PUT",
      path: "/api/workspace/files/docs%2Fnotes.md",
      body: { content: "# Updated\n", expected_updated_at: null },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          saved: true,
          path: "docs/notes.md",
          updated_at: null,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "PUT",
      path: "/api/workspace/files/docs%2Fnotes.md",
      body: { content: "# Stale\n", expected_updated_at: "stale" },
    }))).resolves.toMatchObject({
      result: {
        status: 409,
        body: {
          error: "version conflict",
        },
      },
    });
    expect(calls).toEqual([
      { method: "list:trace-webui.handle_request" },
      { method: "read:trace-webui.handle_request", path: "docs/notes.md" },
      { method: "write:trace-webui.handle_request", path: "docs/notes.md", contents: "# Updated\n", expectedUpdatedAt: null },
      { method: "write:trace-webui.handle_request", path: "docs/notes.md", contents: "# Stale\n", expectedUpdatedAt: "stale" },
    ]);
  });

  test("serves Knowledge API document, query, and stats routes through TS worker RPC", async () => {
    const calls: Array<{ method: string; traceId: string; params?: unknown }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiConfigProvider: {
        getConfig: () => ({ knowledge: { graphragCommunityLevel: 2 } }),
        patchConfig: () => ({}),
      },
      knowledgeProvider: {
        listDocuments: async (params, traceId) => {
          calls.push({ method: "list", traceId, params });
          return {
            documents: [{
              id: "doc-1",
              name: "Desktop Knowledge",
              file_path: "knowledge/files/doc-1.md",
              file_type: "md",
              category: "docs",
              tags: ["desktop"],
              chunk_count: 2,
              content: "# Desktop Knowledge\n",
              created_at: "2026-06-13T00:00:00Z",
            }],
          };
        },
        addDocument: async (body, traceId) => {
          calls.push({ method: "add", traceId, params: body });
          return {
            document: {
              id: body.name === "Async Added" ? "doc-async" : "doc-2",
              name: body.name,
            },
          };
        },
        getDocument: async (docId, traceId) => {
          calls.push({ method: "get", traceId, params: { docId } });
          return {
            document: {
              id: docId,
              name: docId === "doc-2" ? "Upload.md" : "Desktop Knowledge",
              file_path: docId === "doc-2" ? "knowledge/files/doc-2.md" : "knowledge/files/doc-1.md",
              file_type: "md",
              category: "docs",
              tags: ["desktop"],
              chunk_count: 2,
              created_at: "2026-06-13T00:00:00Z",
            },
            content: "# Desktop Knowledge\n",
          };
        },
        deleteDocument: async (docId, traceId) => {
          calls.push({ method: "delete", traceId, params: { docId } });
          return { deleted: true, doc_id: docId };
        },
        query: async (body, traceId) => {
          calls.push({ method: "query", traceId, params: body });
          return {
            results: [{
              id: "chunk-1",
              doc_id: "doc-1",
              doc_name: "Desktop Knowledge",
              content: "TS native knowledge API route.",
              score: 3,
              sparse_rank: 1,
            }],
          };
        },
        stats: async (traceId) => {
          calls.push({ method: "stats", traceId });
          return { total_documents: 1, total_chunks: 2, retrieval_ready: true };
        },
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "knowledge_list_documents", method: "GET", path: "/v1/knowledge/documents", public: true },
          { key: "knowledge_add_document", method: "POST", path: "/v1/knowledge/documents", public: true },
          { key: "knowledge_upload_document", method: "POST", path: "/v1/knowledge/documents/upload", public: true },
          { key: "knowledge_get_document", method: "GET", path: "/v1/knowledge/documents/{doc_id}", public: true },
          { key: "knowledge_delete_document", method: "DELETE", path: "/v1/knowledge/documents/{doc_id}", public: true },
          { key: "knowledge_query", method: "POST", path: "/v1/knowledge/query", public: true },
          { key: "knowledge_stats", method: "GET", path: "/v1/knowledge/stats", public: true },
          { key: "knowledge_job", method: "GET", path: "/v1/knowledge/jobs/{job_id}", public: true },
          { key: "knowledge_rebuild_index", method: "POST", path: "/v1/knowledge/rebuild-index", public: true },
          { key: "knowledge_graph", method: "GET", path: "/v1/knowledge/graph", public: true },
          { key: "knowledge_graphrag", method: "GET", path: "/v1/knowledge/graphrag", public: true },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/documents?category=docs&limit=10",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "list",
          total: 1,
          data: [expect.objectContaining({
            id: "doc-1",
            name: "Desktop Knowledge",
            content_length: 20,
          })],
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/documents",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "list",
          total: 1,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { name: "Defaulted", content: "Body" },
    }))).resolves.toMatchObject({
      result: { status: 200, body: { id: "doc-2", name: "Defaulted", message: "Document 'Defaulted' added successfully" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { name: "Added", content: "Body", file_type: "md" },
    }))).resolves.toMatchObject({
      result: { status: 200, body: { id: "doc-2", name: "Added", message: "Document 'Added' added successfully" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { name: "Async Added", content: "Body", file_type: "md", async_index: true },
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          id: "doc-async",
          name: "Async Added",
          message: "Document 'Async Added' saved; knowledge indexing is running",
          job_id: "kjob_doc-async",
          job: {
            id: "kjob_doc-async",
            doc_id: "doc-async",
            name: "Async Added",
            status: "completed",
            stage: "completed",
            message: "Knowledge indexing completed in native TS worker",
            processed: 1,
            total: 1,
            created_at: expect.any(String),
            updated_at: expect.any(String),
            completed_at: expect.any(String),
            retrieval_ready: true,
            graph_ready: false,
            partial_availability: true,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents/upload?async_index=true",
      body: {
        name: "Upload.md",
        content: "# Upload\n",
        file_type: "md",
        size_bytes: 9,
        category: "docs",
        tags: ["desktop", "native"],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          id: "doc-2",
          name: "Upload.md",
          file_type: "md",
          size_bytes: 9,
          message: "File 'Upload.md' uploaded; knowledge indexing is running",
          job_id: "kjob_doc-2",
          job: {
            id: "kjob_doc-2",
            doc_id: "doc-2",
            name: "Upload.md",
            status: "completed",
            stage: "completed",
            message: "Knowledge indexing completed in native TS worker",
            processed: 1,
            total: 1,
            created_at: expect.any(String),
            updated_at: expect.any(String),
            completed_at: expect.any(String),
            retrieval_ready: true,
            graph_ready: false,
            partial_availability: true,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents/upload?async_index=true",
      body: {
        name: "Upload.markdown",
        content: "# Markdown Upload\n",
        size_bytes: 18,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          id: expect.any(String),
          name: "Upload.markdown",
          file_type: "md",
          size_bytes: 18,
          job_id: expect.any(String),
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents/upload?async_index=true",
      body: {
        name: "Upload.json",
        content: "{\"topic\":\"desktop native\"}\n",
        file_type: "json",
        size_bytes: 27,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          id: expect.any(String),
          name: "Upload.json",
          file_type: "json",
          size_bytes: 27,
          job_id: expect.any(String),
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents/upload?async_index=true",
      body: {
        name: "Upload.csv",
        content: "name,value\ndesktop,native\n",
        file_type: "csv",
        size_bytes: 26,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          id: expect.any(String),
          name: "Upload.csv",
          file_type: "csv",
          size_bytes: 26,
          job_id: expect.any(String),
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/jobs/kjob_doc-2",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          id: "kjob_doc-2",
          doc_id: "doc-2",
          name: "Upload.md",
          status: "completed",
          stage: "completed",
          created_at: expect.any(String),
          updated_at: expect.any(String),
          completed_at: expect.any(String),
          retrieval_ready: true,
          graph_ready: false,
          partial_availability: true,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/documents/doc-1",
    }))).resolves.toMatchObject({
      result: { status: 200, body: { id: "doc-1", content: "# Desktop Knowledge\n" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "DELETE",
      path: "/v1/knowledge/documents/doc-1",
    }))).resolves.toMatchObject({
      result: { status: 200, body: { id: "doc-1", message: "Document doc-1 deleted successfully" } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/query",
      body: { query: "native knowledge", mode: "sparse", top_k: 3 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "list",
          query: "native knowledge",
          mode: "sparse",
          total: 1,
          data: [expect.objectContaining({ id: "chunk-1", doc_id: "doc-1", score: 3 })],
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/query",
      body: { query: "default query" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "list",
          query: "default query",
          mode: "hybrid",
          total: 1,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/query",
      body: { query: "explicit query", mode: 404, top_k: null },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "list",
          query: "explicit query",
          mode: 404,
          total: 1,
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/stats",
    }))).resolves.toMatchObject({
      result: { status: 200, body: { total_documents: 1, total_chunks: 2, retrieval_ready: true } },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graph?doc_id=doc-1&limit=20&edge_limit=40&min_confidence=0.2&include_orphans=true",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "knowledge_graph",
          nodes: [],
          edges: [],
          stats: {
            node_count: 0,
            edge_count: 0,
            total_entities: 0,
            total_relations: 0,
            total_mentions: 0,
            doc_id: "doc-1",
            limit: 20,
            edge_limit: 40,
            min_confidence: 0.2,
            include_orphans: true,
          },
          readiness: {
            retrieval_ready: true,
            claims_ready: false,
            relations_ready: false,
            graph_ready: false,
            partial_availability: true,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graph?limit=not-a-number",
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Invalid graph query params",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graph?limit=1.7",
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Invalid graph query params",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graph?min_confidence=inf",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          stats: {
            min_confidence: 1,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graphrag?doc_id=doc-1&min_confidence=0.2&level=1&include_reports=false&include_covariates=true",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "graphrag_index",
          documents: [],
          text_units: [],
          entities: [],
          relationships: [],
          covariates: [],
          communities: [],
          community_reports: [],
          stats: {
            document_count: 1,
            text_unit_count: 2,
            entity_count: 0,
            relationship_count: 0,
            covariate_count: 0,
            community_count: 0,
            community_report_count: 0,
            doc_id: "doc-1",
            min_confidence: 0.2,
            level: 1,
            include_reports: false,
            include_covariates: true,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graphrag?level=not-a-number",
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Invalid GraphRAG query params",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graphrag?min_confidence=nan",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          stats: {
            min_confidence: 0,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graphrag?level=1.7",
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Invalid GraphRAG query params",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graphrag?min_confidence=0.1",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          stats: {
            min_confidence: 0.1,
            level: 2,
            include_reports: true,
            include_covariates: true,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graphrag?level=7",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          stats: {
            level: 7,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/rebuild-index?type=bm25&async_index=true",
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          message: "Knowledge index rebuild started",
          job_id: "kjob_rebuild_bm25",
          type: "bm25",
          job: {
            id: "kjob_rebuild_bm25",
            name: "rebuild:bm25",
            status: "completed",
            stage: "completed",
            message: "BM25 index is available in native TS worker",
            processed: 2,
            total: 2,
            created_at: expect.any(String),
            updated_at: expect.any(String),
            completed_at: expect.any(String),
            retrieval_ready: true,
            graph_ready: false,
            partial_availability: true,
            result: {
              chunks_indexed: 2,
              terms_created: 0,
              total_docs: 1,
            },
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/jobs/kjob_rebuild_bm25",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          id: "kjob_rebuild_bm25",
          name: "rebuild:bm25",
          status: "completed",
          stage: "completed",
          created_at: expect.any(String),
          updated_at: expect.any(String),
          completed_at: expect.any(String),
          result: {
            chunks_indexed: 2,
            terms_created: 0,
            total_docs: 1,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/rebuild-index?type=all&async_index=true",
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          message: "Knowledge index rebuild started",
          job_id: "kjob_rebuild_all",
          type: "all",
          job: {
            id: "kjob_rebuild_all",
            name: "rebuild:all",
            status: "completed",
            stage: "completed",
            message: "Native available knowledge indexes are rebuilt; semantic index is not available natively",
            processed: 3,
            total: 3,
            created_at: expect.any(String),
            updated_at: expect.any(String),
            completed_at: expect.any(String),
            retrieval_ready: true,
            graph_ready: false,
            partial_availability: true,
            result: {
              bm25: {
                chunks_indexed: 2,
                terms_created: 0,
                total_docs: 1,
              },
              semantic: {
                skipped: true,
                available: false,
              },
            },
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/jobs/kjob_rebuild_all",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          id: "kjob_rebuild_all",
          name: "rebuild:all",
          status: "completed",
          stage: "completed",
          created_at: expect.any(String),
          updated_at: expect.any(String),
          completed_at: expect.any(String),
          result: {
            bm25: {
              chunks_indexed: 2,
              terms_created: 0,
              total_docs: 1,
            },
            semantic: {
              skipped: true,
              available: false,
            },
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/rebuild-index?type=semantic&async_index=true",
    }))).resolves.toMatchObject({
      result: {
        status: 202,
        body: {
          message: "Knowledge index rebuild started",
          job_id: "kjob_rebuild_semantic",
          type: "semantic",
          job: {
            id: "kjob_rebuild_semantic",
            name: "rebuild:semantic",
            status: "completed",
            stage: "completed",
            message: "Semantic index is not available in native TS worker",
            processed: 2,
            total: 2,
            created_at: expect.any(String),
            updated_at: expect.any(String),
            completed_at: expect.any(String),
            retrieval_ready: true,
            graph_ready: false,
            partial_availability: true,
            result: {
              skipped: true,
              available: false,
            },
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/jobs/kjob_rebuild_semantic",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          id: "kjob_rebuild_semantic",
          name: "rebuild:semantic",
          status: "completed",
          stage: "completed",
          created_at: expect.any(String),
          updated_at: expect.any(String),
          completed_at: expect.any(String),
          result: {
            skipped: true,
            available: false,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/rebuild-index?type=vector",
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Invalid rebuild type 'vector'. Valid options: bm25, semantic, all",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    expect(calls).toEqual([
      { method: "list", traceId: "trace-webui.handle_request", params: { category: "docs", limit: 10 } },
      { method: "list", traceId: "trace-webui.handle_request", params: { limit: 20 } },
      {
        method: "add",
        traceId: "trace-webui.handle_request",
        params: { name: "Defaulted", content: "Body", tags: [], category: "", file_type: "txt" },
      },
      { method: "add", traceId: "trace-webui.handle_request", params: { name: "Added", content: "Body", file_type: "md", tags: [], category: "" } },
      {
        method: "add",
        traceId: "trace-webui.handle_request",
        params: { name: "Async Added", content: "Body", file_type: "md", async_index: true, tags: [], category: "" },
      },
      {
        method: "add",
        traceId: "trace-webui.handle_request",
        params: {
          name: "Upload.md",
          content: "# Upload\n",
          file_type: "md",
          category: "docs",
          tags: ["desktop", "native"],
          source: "file_upload",
        },
      },
      {
        method: "add",
        traceId: "trace-webui.handle_request",
        params: {
          name: "Upload.markdown",
          content: "# Markdown Upload\n",
          file_type: "md",
          source: "file_upload",
          category: "",
          tags: [],
        },
      },
      {
        method: "add",
        traceId: "trace-webui.handle_request",
        params: {
          name: "Upload.json",
          content: "{\"topic\":\"desktop native\"}\n",
          file_type: "json",
          source: "file_upload",
          category: "",
          tags: [],
        },
      },
      {
        method: "add",
        traceId: "trace-webui.handle_request",
        params: {
          name: "Upload.csv",
          content: "name,value\ndesktop,native\n",
          file_type: "csv",
          source: "file_upload",
          category: "",
          tags: [],
        },
      },
      { method: "get", traceId: "trace-webui.handle_request", params: { docId: "doc-2" } },
      { method: "get", traceId: "trace-webui.handle_request", params: { docId: "doc-1" } },
      { method: "delete", traceId: "trace-webui.handle_request", params: { docId: "doc-1" } },
      { method: "query", traceId: "trace-webui.handle_request", params: { query: "native knowledge", mode: "sparse", top_k: 3 } },
      { method: "query", traceId: "trace-webui.handle_request", params: { query: "default query", mode: "hybrid", top_k: 5 } },
      { method: "query", traceId: "trace-webui.handle_request", params: { query: "explicit query", mode: 404, top_k: null } },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
      { method: "stats", traceId: "trace-webui.handle_request" },
    ]);
  });

  test("returns Python-compatible Knowledge API error envelopes through TS worker RPC", async () => {
    const calls: string[] = [];
    const workerWithoutKnowledge = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });
    await expect(workerWithoutKnowledge.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/stats",
    }))).resolves.toMatchObject({
      result: {
        status: 503,
        body: {
          error: {
            message: "Knowledge store not initialized",
            type: "invalid_request_error",
            code: 503,
          },
        },
      },
    });

    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      knowledgeProvider: {
        listDocuments: () => ({ documents: [] }),
        addDocument: () => {
          calls.push("add");
          return { document: { id: "doc-1", name: "Doc" } };
        },
        getDocument: () => undefined,
        deleteDocument: () => ({ deleted: false }),
        query: () => {
          calls.push("query");
          return { results: [] };
        },
        stats: () => ({ total_documents: 0, total_chunks: 0 }),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { content: "body" },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Document name is required",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { name: "Blank", content: "   ", file_type: "md" },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Document content cannot be empty",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    expect(calls).toEqual([]);
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/query",
      body: { query: "   ", mode: "sparse" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          object: "list",
          query: "   ",
          mode: "sparse",
          data: [],
          total: 0,
        },
      },
    });
    expect(calls).toEqual([]);
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/query",
      body: undefined,
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Invalid JSON body",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/jobs/missing",
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          error: {
            message: "Knowledge job missing not found",
            type: "invalid_request_error",
            code: 404,
          },
        },
      },
    });
  });

  test("wraps Knowledge API provider failures as Python-compatible server errors", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      knowledgeProvider: {
        listDocuments: () => {
          throw new Error("list failed");
        },
        addDocument: () => {
          throw new Error("add failed");
        },
        getDocument: () => {
          throw new Error("get failed");
        },
        deleteDocument: () => {
          throw new Error("delete failed");
        },
        query: () => {
          throw new Error("query failed");
        },
        stats: () => {
          throw new Error("stats failed");
        },
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/documents",
    }))).resolves.toMatchObject({
      result: {
        status: 500,
        body: {
          error: {
            message: "Error listing documents: list failed",
            type: "server_error",
            code: 500,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/query",
      body: { query: "native" },
    }))).resolves.toMatchObject({
      result: {
        status: 500,
        body: {
          error: {
            message: "Error querying knowledge: query failed",
            type: "server_error",
            code: 500,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/stats",
    }))).resolves.toMatchObject({
      result: {
        status: 500,
        body: {
          error: {
            message: "Error getting stats: stats failed",
            type: "server_error",
            code: 500,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/v1/knowledge/graph",
    }))).resolves.toMatchObject({
      result: {
        status: 500,
        body: {
          error: {
            message: "Error getting knowledge graph: stats failed",
            type: "server_error",
            code: 500,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/rebuild-index",
    }))).resolves.toMatchObject({
      result: {
        status: 500,
        body: {
          error: {
            message: "Error rebuilding index: stats failed",
            type: "server_error",
            code: 500,
          },
        },
      },
    });
  });

  test("maps Knowledge API document ValueError failures to Python-compatible invalid requests", async () => {
    const valueError = (message: string) => {
      const error = new Error(message);
      error.name = "ValueError";
      return error;
    };
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      knowledgeProvider: {
        listDocuments: () => ({ documents: [] }),
        addDocument: (body) => {
          if (body.source === "file_upload") {
            throw valueError("Uploaded document is invalid");
          }
          throw valueError("Document already exists");
        },
        getDocument: () => undefined,
        deleteDocument: () => ({ deleted: false }),
        query: () => ({ results: [] }),
        stats: () => ({ total_documents: 0, total_chunks: 0 }),
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents",
      body: { name: "Existing", content: "Body", file_type: "md" },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Document already exists",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/v1/knowledge/documents/upload",
      body: { name: "Upload.md", content: "# Upload\n", file_type: "md" },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: {
            message: "Uploaded document is invalid",
            type: "invalid_request_error",
            code: 400,
          },
        },
      },
    });
  });

  test("serves WebUI session list control route through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [
          {
            sessionId: "websocket:chat-2",
            title: "Fallback title",
            createdAt: "2026-06-13T08:00:00.000Z",
            updatedAt: "2026-06-13T09:00:00.000Z",
            extra: {
              messages: [
                { role: "assistant", content: "not used" },
                { role: "user", content: "  # Investigate native session list route with a long title  " },
              ],
            },
          },
          {
            sessionId: "cli:chat-1",
            title: "CLI session",
            createdAt: "2026-06-13T07:00:00.000Z",
            updatedAt: "2026-06-13T07:30:00.000Z",
          },
        ],
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "list_sessions", method: "GET", path: "/api/sessions", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/sessions",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          items: [
            {
              key: "websocket:chat-2",
              chat_id: "chat-2",
              title: "Investigate native session list rout...",
              created_at: "2026-06-13T08:00:00.000Z",
              updated_at: "2026-06-13T09:00:00.000Z",
            },
          ],
        },
      },
    });
  });

  test("serves WebUI session messages control route through TS worker RPC", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        getSessionMessages: (sessionId: string) => ({
          sessionId,
          messages: [
            { role: "user", content: "Hello", timestamp: "2026-06-13T08:00:00.000Z" },
            {
              role: "assistant",
              content: "Working",
              reasoning_content: "private chain",
              _memory_references: [{ id: "mem-1" }],
            },
            {
              role: "tool",
              name: "request_form",
              content: "Agent UI form `f1` requested asynchronously for WebUI chat. Wait for the form response continuation.",
            },
            {
              role: "user",
              content: "## Plan:\n1. internal",
              _task_event: true,
              _task_plan_id: "plan-1",
            },
          ],
        }),
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "get_messages", method: "GET", path: "/api/sessions/{key}/messages", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/sessions/websocket%3Achat-1/messages",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          key: "websocket:chat-1",
          messages: [
            { role: "user", content: "Hello", timestamp: "2026-06-13T08:00:00.000Z" },
            {
              role: "assistant",
              content: "Working",
              reasoning_content: "private chain",
              _memory_references: [{ id: "mem-1" }],
            },
          ],
        },
      },
    });
  });

  test("serves WebUI session clear control route through TS worker RPC", async () => {
    const clearRequests: Array<{ sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        clearSession: (sessionId: string, traceId: string) => {
          clearRequests.push({ sessionId, traceId });
          return {
            sessionId,
            messagesBefore: 3,
            messagesAfter: 0,
            checkpointCleared: true,
          };
        },
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "clear_session", method: "POST", path: "/api/sessions/{key}/clear", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/sessions/websocket%3Achat-1/clear",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          key: "websocket:chat-1",
          cleared: true,
          messages_before: 3,
          messages_after: 0,
          checkpoint_cleared: true,
        },
      },
    });
    expect(clearRequests).toEqual([{ sessionId: "websocket:chat-1", traceId: "trace-webui.handle_request" }]);
  });

  test("serves WebUI session delete control route through TS worker RPC", async () => {
    const deleteRequests: Array<{ sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        deleteSession: (sessionId: string, traceId: string) => {
          deleteRequests.push({ sessionId, traceId });
          return { sessionId, deleted: true };
        },
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "delete_session", method: "DELETE", path: "/api/sessions/{key}", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "DELETE",
      path: "/api/sessions/websocket%3Achat-1",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          key: "websocket:chat-1",
          deleted: true,
        },
      },
    });
    expect(deleteRequests).toEqual([{ sessionId: "websocket:chat-1", traceId: "trace-webui.handle_request" }]);
  });

  test("serves WebUI session profile control route through TS worker RPC", async () => {
    const profileRequests: Array<{ sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        getSessionProfile: (sessionId: string, traceId: string) => {
          profileRequests.push({ sessionId, traceId });
          return {
            sessionId,
            profile: { display_name: "Ada", role: "developer" },
          };
        },
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "get_profile", method: "GET", path: "/api/sessions/{key}/profile", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/sessions/websocket%3Achat-1/profile",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          key: "websocket:chat-1",
          profile: { display_name: "Ada", role: "developer" },
        },
      },
    });
    expect(profileRequests).toEqual([{ sessionId: "websocket:chat-1", traceId: "trace-webui.handle_request" }]);
  });

  test("serves WebUI session metadata patch control route through TS worker RPC", async () => {
    const patchRequests: Array<{ sessionId: string; metadata: Record<string, unknown>; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        patchSessionMetadata: (
          sessionId: string,
          metadata: Record<string, unknown>,
          traceId: string,
        ) => {
          patchRequests.push({ sessionId, metadata, traceId });
          return {
            sessionId,
            metadata: { pinned: true, topic: "native-route" },
            updatedAt: "2026-06-13T10:00:00.000Z",
          };
        },
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "patch_session", method: "PATCH", path: "/api/sessions/{key}", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "PATCH",
      path: "/api/sessions/websocket%3Achat-1",
      body: { metadata: { pinned: true } },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          key: "websocket:chat-1",
          metadata: { pinned: true, topic: "native-route" },
          updated_at: "2026-06-13T10:00:00.000Z",
        },
      },
    });
    expect(patchRequests).toEqual([
      {
        sessionId: "websocket:chat-1",
        metadata: { pinned: true },
        traceId: "trace-webui.handle_request",
      },
    ]);
  });

  test("serves WebUI session temporary files list control route through TS worker RPC", async () => {
    const temporaryFileRequests: Array<{ sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        listTemporaryFiles: (sessionId: string, traceId: string) => {
          temporaryFileRequests.push({ sessionId, traceId });
          return {
            sessionId,
            items: [
              {
                id: "tmp-1",
                name: "context.md",
                file_type: "md",
                chunk_count: 2,
                temporary: true,
              },
            ],
          };
        },
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "list_temporary_files", method: "GET", path: "/api/sessions/{key}/temporary-files", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/sessions/websocket%3Achat-1/temporary-files",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          items: [
            {
              id: "tmp-1",
              name: "context.md",
              file_type: "md",
              chunk_count: 2,
              temporary: true,
            },
          ],
        },
      },
    });
    expect(temporaryFileRequests).toEqual([
      { sessionId: "websocket:chat-1", traceId: "trace-webui.handle_request" },
    ]);
  });

  test("serves WebUI session temporary file upload route through TS worker RPC", async () => {
    const uploadRequests: Array<{
      sessionId: string;
      upload: { name: string; fileType: string; content: string; sizeBytes: number };
      traceId: string;
    }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        uploadTemporaryFile: (
          sessionId: string,
          upload: { name: string; fileType: string; content: string; sizeBytes: number },
          traceId: string,
        ) => {
          uploadRequests.push({ sessionId, upload, traceId });
          return {
            id: "session_doc_1",
            name: upload.name,
            file_type: upload.fileType,
            chunk_count: 1,
            size_bytes: upload.sizeBytes,
            temporary: true,
          };
        },
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "upload_temporary_file", method: "POST", path: "/api/sessions/{key}/temporary-files", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/sessions/websocket%3Achat-1/temporary-files",
      body: {
        name: "note.txt",
        content: "hello",
        file_type: "txt",
        size_bytes: 5,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          id: "session_doc_1",
          name: "note.txt",
          file_type: "txt",
          chunk_count: 1,
          size_bytes: 5,
          temporary: true,
        },
      },
    });
    expect(uploadRequests).toEqual([
      {
        sessionId: "websocket:chat-1",
        upload: { name: "note.txt", fileType: "txt", content: "hello", sizeBytes: 5 },
        traceId: "trace-webui.handle_request",
      },
    ]);
  });

  test("serves WebUI session temporary file clear route through TS worker RPC", async () => {
    const clearRequests: Array<{ sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      webuiSessionProvider: {
        listSessions: () => [],
        clearTemporaryFiles: (sessionId: string, traceId: string) => {
          clearRequests.push({ sessionId, traceId });
          return {
            sessionId,
            cleared: 2,
            items: [],
          };
        },
      },
    } as any);

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "clear_temporary_files", method: "DELETE", path: "/api/sessions/{key}/temporary-files", public: false },
        ]),
      },
    });
    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "DELETE",
      path: "/api/sessions/websocket%3Achat-1/temporary-files",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          items: [],
          cleared: 2,
        },
      },
    });
    expect(clearRequests).toEqual([
      { sessionId: "websocket:chat-1", traceId: "trace-webui.handle_request" },
    ]);
  });

  test("returns Python-compatible cowork route unavailable errors", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: "/api/cowork/sessions",
    }))).resolves.toMatchObject({
      result: {
        status: 503,
        body: { error: "cowork is not available" },
      },
    });
  });

  test("bridges WebUI cowork API requests through the injected CoworkService", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    await expect(worker.handleRequest(webuiRequest("webui.route_specs"))).resolves.toMatchObject({
      result: {
        routes: expect.arrayContaining([
          { key: "cowork_route", method: "GET", path: "/api/cowork/{path:.+}", public: false },
          { key: "cowork_route", method: "POST", path: "/api/cowork/{path:.+}", public: false },
        ]),
      },
    });

    const create = await worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Bridge Cowork WebUI",
        title: "WebUI Cowork",
        workflow_mode: "team",
        agents: [{ id: "lead", role: "Lead" }],
        tasks: [{ id: "plan", title: "Plan", assigned_agent_id: "lead" }],
      },
    }));

    expect(create).toMatchObject({
      result: {
        status: 200,
        body: {
          result: "started cw_1",
          session: expect.objectContaining({
            id: "cw_1",
            title: "WebUI Cowork",
          }),
        },
      },
    });

    await expect(worker.handleRequest(webuiRequest("webui.handle_request", {
      method: "GET",
      path: "/api/cowork/sessions?include_completed=true",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          items: [expect.objectContaining({ id: "cw_1", title: "WebUI Cowork" })],
        },
      },
    });
  });

  test("emits Python-compatible WebUI cowork update events for websocket-origin sessions", async () => {
    const emitted: WorkerEvent[] = [];
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: (event) => emitted.push(event),
      coworkService,
    });

    const create = await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Broadcast Cowork updates",
        title: "Broadcast Cowork",
        runtime_state: {
          origin_channel: "websocket",
          origin_chat_id: "chat-1",
          origin_session_key: "websocket:chat-1",
          origin_surface: "main_chat",
        },
      },
    }));
    expect(create).toMatchObject({ result: expect.objectContaining({ status: 200 }) });
    expect(await coworkService.getSession("cw_1", "assert")).toMatchObject({
      runtime_state: expect.objectContaining({
        origin_chat_id: "chat-1",
      }),
    });

    expect(emitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: "cowork_updated",
        payload: expect.objectContaining({
          event: "cowork_updated",
          session_id: "cw_1",
          event_id: "evt_1",
          event_type: "session.created",
          message: "Created cowork session 'Broadcast Cowork'",
          updated_at: "2026-06-12T08:00:00.000Z",
        }),
      }),
      expect.objectContaining({
        event: "cowork_state",
        payload: expect.objectContaining({
          event: "cowork_state",
          chat_id: "chat-1",
          session_id: "cw_1",
          change_type: "session.created",
          status: "active",
          updated_at: "2026-06-12T08:00:00.000Z",
        }),
      }),
    ]));
  });

  test("preserves Python-compatible direct blueprint default goals", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.preview_blueprint", {
      blueprint: {},
      default_goal: 404,
    }))).resolves.toMatchObject({
      result: {
        ok: true,
        blueprint: expect.objectContaining({
          goal: "404",
          title: "404",
        }),
      },
    });
  });

  test("routes cowork create/list/get/delete requests through the injected CoworkService", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Wire Cowork RPCs",
      title: "Cowork RPC",
      workflow_mode: "team",
      agents: [{ id: "lead", role: "Lead" }],
      tasks: [{ id: "plan", title: "Plan", assigned_agent_id: "lead" }],
    }));

    expect(create).toMatchObject({
      protocol_version: "1",
      id: "cowork.create_session-1",
      result: {
        session: {
          id: "cw_1",
          title: "Cowork RPC",
          workflow_mode: "team",
        },
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.list_sessions"))).resolves.toMatchObject({
      result: {
        sessions: [expect.objectContaining({ id: "cw_1" })],
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_session", { session_id: "cw_1" }))).resolves.toMatchObject({
      result: {
        session: expect.objectContaining({ id: "cw_1" }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.delete_session", { session_id: "cw_1" }))).resolves.toMatchObject({
      result: { deleted: true },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_session", { session_id: "cw_1" }))).resolves.toMatchObject({
      result: { session: null },
    });
  });

  test("auto-runs direct cowork create_session RPCs with Python-compatible limits", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });

    await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Direct auto-run",
      workflow_mode: "team",
      agents: [{ id: "lead", role: "Lead" }],
      auto_run: true,
      max_rounds: "2",
      max_agents: "2",
      max_agent_calls: "3",
    }));

    const saved = await store.readSnapshot("cw_1", "trace-1");
    const runSpan = saved?.trace_spans.find((span) => span.name === "Cowork run");

    expect(runSpan?.input_ref).toBe("max_rounds=2, max_agents=2, max_agent_calls=3");
  });

  test("routes Python-compatible cowork API requests through the injected CoworkService", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/blueprints/preview",
      body: {
        blueprint: {
          goal: "Preview route",
          agents: [{ id: "lead", role: "Lead", tools: ["cowork_internal"] }],
        },
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: expect.objectContaining({
          ok: true,
          blueprint: expect.objectContaining({ goal: "Preview route" }),
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/blueprints/validate",
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/blueprints/validate",
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    const create = await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Route Cowork API",
        title: "Route API",
        workflow_mode: "team",
        agents: [{ id: "lead", name: "Lead", role: "Lead" }, { id: "123_5", name: "Numeric", role: "Worker" }],
        tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
      },
    }));
    const createdSession = (((create.result as Record<string, unknown>).body as Record<string, unknown>).session as CoworkSession);
    expect(create).toMatchObject({
      result: {
        status: 200,
        body: {
          result: "started cw_1",
          session: expect.objectContaining({
            id: "cw_1",
            title: "Route API",
            agents: expect.arrayContaining([expect.objectContaining({ id: "lead", private_summary: "" })]),
            messages: expect.arrayContaining([expect.objectContaining({ id: "msg_1", content: "Goal: Route Cowork API" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: "/api/cowork/sessions?include_completed=true",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          items: [expect.objectContaining({
            id: "cw_1",
            title: "Route API",
            agents: expect.arrayContaining([expect.objectContaining({ id: "lead", private_summary: "" })]),
            messages: [],
            trace_spans: [],
          })],
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}/messages`,
      body: {
        content: "Continue",
        recipient_ids: ["lead"],
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Sent message msg_2.",
          message: expect.objectContaining({ id: "msg_2", content: "Continue" }),
          session: expect.objectContaining({
            messages: expect.arrayContaining([expect.objectContaining({ id: "msg_2", content: "Continue" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session: expect.objectContaining({
            id: "cw_1",
            title: "Route API",
            agents: expect.arrayContaining([expect.objectContaining({ id: "lead" })]),
            messages: expect.arrayContaining([expect.objectContaining({ id: "msg_1", content: "Goal: Route Cowork API" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
            trace: expect.any(Array),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}/tasks`,
      body: {
        title: "Review",
        description: "Review answer",
        assigned_agent_id: "lead",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Added task task_1: Review",
          task: expect.objectContaining({ id: "task_1", title: "Review" }),
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "task_1", title: "Review" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}/tasks/task_1/assign`,
      body: {
        assigned_agent_id: "lead",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Task 'Review' assigned to Lead.",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "task_1", assigned_agent_id: "lead" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}/tasks/task_1/review`,
      body: { reviewer_agent_id: 123.5 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          review_task_id: "task_2",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "task_2", title: "Review Review", assigned_agent_id: "123_5" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    const summaryResponse = await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}/summary`,
    }));
    expect(summaryResponse.result).toMatchObject({ status: 200 });
    const summaryBody = summaryResponse.result.body as { summary?: unknown };
    expect(typeof summaryBody.summary).toBe("string");
    expect(summaryBody.summary).toContain("## Route API (cw_1)");
    expect(summaryBody.summary).toContain("Status: active");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}/branches/derive`,
      body: {
        target_architecture: "team",
        title: "Follow-up branch",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          branch: expect.objectContaining({ id: "br_1", title: "Follow-up branch" }),
          session: expect.objectContaining({ current_branch_id: "br_1" }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "DELETE",
      path: `/api/cowork/sessions/${encodeURIComponent(createdSession.id)}`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: { deleted: true },
      },
    });
  });

  test("filters cowork session list with Python-compatible include_completed aliases and trimmed origin chat ids", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    const active = await coworkService.createSession({
      traceId: "trace-1",
      goal: "Active chat",
      runtimeState: { origin_chat_id: "chat-1" },
    });
    const completed = await coworkService.createSession({
      traceId: "trace-1",
      goal: "Completed chat",
      runtimeState: { origin_chat_id: " chat-1 " },
    });
    await coworkService.createSession({
      traceId: "trace-1",
      goal: "Other chat",
      runtimeState: { origin_chat_id: "chat-2" },
    });
    await store.writeSnapshot({ ...completed, status: "completed" });

    const response = await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: "/api/cowork/sessions?include_completed=yes&origin_chat_id=%20chat-1%20",
    }));
    const items = (((response.result as Record<string, unknown>).body as Record<string, unknown>).items as Array<{ id: string }>);

    expect(items.map((session) => session.id)).toEqual([active.id, completed.id]);
  });

  test("accepts Python route architecture aliases when creating cowork sessions", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: { goal: "Architecture alias", architecture: "team" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session: expect.objectContaining({ workflow_mode: "team" }),
        },
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: { goal: "Mode alias", mode: "team" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session: expect.objectContaining({ workflow_mode: "team" }),
        },
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: { goal: "Architecture precedence", workflow_mode: "swarm", architecture: "team" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session: expect.objectContaining({ workflow_mode: "team" }),
        },
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: { goal: "Numeric architecture alias", workflow_mode: "swarm", architecture: 404 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session: expect.objectContaining({ workflow_mode: "adaptive_starter" }),
        },
      },
    });
  });

  test("returns Python-compatible create-session route error when goal is missing", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: { title: "Missing goal" },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "goal is required" },
      },
    });
  });

  test("ignores non-object create-session route blueprints when a goal is present", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Use goal path",
        title: "Goal session",
        blueprint: "ignored",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "started cw_1",
          session: expect.objectContaining({
            id: "cw_1",
            title: "Goal session",
            goal: "Use goal path",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: 404,
        title: 505,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "started cw_2",
          session: expect.objectContaining({
            id: "cw_2",
            title: "505",
            goal: "404",
          }),
        },
      },
    });
  });

  test("returns Python-compatible create-session route error for non-object bodies", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });
  });

  test("auto-runs cowork sessions created through the Python-compatible route when requested", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Auto-run route",
        workflow_mode: "team",
        auto_run: true,
        max_rounds: 1,
        parallel_width: 2,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "started cw_1",
          session: expect.objectContaining({
            id: "cw_1",
            stop_reason: "idle",
            run_metrics: [expect.objectContaining({ status: "stopped", stop_reason: "idle" })],
          }),
        },
      },
    });
  });

  test("accepts Python blueprint create auto-run rounds alias", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });

    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        blueprint: {
          goal: "Blueprint rounds alias",
          agents: [{ id: "lead", role: "Lead", tools: ["cowork_internal"] }],
        },
        auto_run: true,
        maxRounds: "",
        rounds: "2",
        parallel_width: "2",
        max_agent_calls: "3",
      },
    }));
    const saved = await store.readSnapshot("cw_1", "trace-1");
    const runSpan = saved?.trace_spans.find((span) => span.name === "Cowork run");

    expect(runSpan?.input_ref).toBe("max_rounds=2, max_agents=2, max_agent_calls=3");
  });

  test("accepts Python-compatible truthy strings for create-session auto-run flags", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });

    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "String auto-run route",
        workflow_mode: "team",
        auto_run: "false",
        max_rounds: 1,
        run_until_idle: "false",
        stop_on_blocker: "false",
      },
    }));
    const saved = await store.readSnapshot("cw_1", "trace-1");
    const runSpan = saved?.trace_spans.find((span) => span.name === "Cowork run");

    expect(runSpan?.input_ref).toBe("max_rounds=20, max_agents=3, max_agent_calls=30");
    expect(runSpan?.data).toMatchObject({
      run_until_idle: true,
      stop_on_blocker: true,
    });

    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Snake auto-run route",
        workflow_mode: "team",
        autoRun: "",
        auto_run: true,
        max_rounds: 1,
      },
    }));
    const savedSnake = await store.readSnapshot("cw_2", "trace-1");
    const snakeRunSpan = savedSnake?.trace_spans.find((span) => span.name === "Cowork run");

    expect(snakeRunSpan?.input_ref).toBe("max_rounds=1, max_agents=3, max_agent_calls=30");
  });

  test("routes Python-compatible cowork run requests through the injected CoworkScheduler", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });
    const session = await coworkService.createSession({
      traceId: "seed",
      goal: "Route Cowork scheduler",
      title: "Scheduler route",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/run`,
      body: { max_rounds: 2, max_agents: 2 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: expect.stringContaining("Round 1: no ready agents."),
          session: expect.objectContaining({
            id: "cw_1",
            stop_reason: "idle",
            tasks: expect.arrayContaining([
              expect.objectContaining({ id: "draft", title: "Draft" }),
            ]),
            run_metrics: [expect.objectContaining({ status: "stopped", stop_reason: "idle" })],
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions/missing/run",
      body: { max_rounds: 1 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Error: cowork session 'missing' not found",
          session: null,
        },
      },
    });
  });

  test("accepts Python route parallel_width alias for cowork run max agents", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });
    const session = await coworkService.createSession({
      traceId: "seed",
      goal: "Parallel alias",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
    });

    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/run`,
      body: { max_rounds: 1, parallel_width: 2 },
    }));
    const saved = await store.readSnapshot(session.id, "trace-1");
    const runSpan = saved?.trace_spans.find((span) => span.name === "Cowork run");

    expect(runSpan?.input_ref).toContain("max_agents=2");
  });

  test("accepts Python-compatible numeric strings for cowork run route limits", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });
    const session = await coworkService.createSession({
      traceId: "seed",
      goal: "Numeric string route limits",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
    });

    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/run`,
      body: {
        maxRounds: "",
        max_rounds: "2",
        maxAgents: "",
        max_agents: "2",
        maxAgentCalls: "",
        max_agent_calls: "3",
      },
    }));
    const saved = await store.readSnapshot(session.id, "trace-1");
    const runSpan = saved?.trace_spans.find((span) => span.name === "Cowork run");

    expect(runSpan?.input_ref).toBe("max_rounds=2, max_agents=2, max_agent_calls=3");

    const defaultLimitSession = await coworkService.createSession({
      traceId: "seed-zero",
      goal: "Zero-valued route limits",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
    });
    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(defaultLimitSession.id)}/run`,
      body: { max_rounds: "2", max_agents: "0", max_agent_calls: "0" },
    }));
    const zeroLimitSaved = await store.readSnapshot(defaultLimitSession.id, "trace-1");
    const zeroLimitRunSpan = zeroLimitSaved?.trace_spans.find((span) => span.name === "Cowork run");

    expect(zeroLimitRunSpan?.input_ref).toBe("max_rounds=2, max_agents=3, max_agent_calls=30");
  });

  test("accepts Python-compatible truthy strings for cowork run route flags", async () => {
    const store = createMemoryCoworkStore();
    const idGenerator = (() => {
      const counters = new Map<string, number>();
      return (prefix: string) => {
        const next = (counters.get(prefix) ?? 0) + 1;
        counters.set(prefix, next);
        return `${prefix}_${next}`;
      };
    })();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const coworkScheduler = new CoworkScheduler({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator,
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
      coworkScheduler,
    });
    const session = await coworkService.createSession({
      traceId: "seed",
      goal: "Truthy string route flags",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
    });

    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/run`,
      body: { max_rounds: 1, run_until_idle: "false", stop_on_blocker: "false" },
    }));
    const saved = await store.readSnapshot(session.id, "trace-1");
    const runSpan = saved?.trace_spans.find((span) => span.name === "Cowork run");

    expect(runSpan?.input_ref).toBe("max_rounds=20, max_agents=3, max_agent_calls=30");
    expect(runSpan?.data).toMatchObject({
      run_until_idle: true,
      stop_on_blocker: true,
    });

    const snakeAliasSession = await coworkService.createSession({
      traceId: "seed-snake-alias",
      goal: "Snake alias route flags",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
    });
    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(snakeAliasSession.id)}/run`,
      body: {
        max_rounds: 1,
        runUntilIdle: "",
        run_until_idle: "false",
        stopOnBlocker: "",
        stop_on_blocker: "false",
      },
    }));
    const savedSnakeAlias = await store.readSnapshot(snakeAliasSession.id, "trace-1");
    const snakeAliasRunSpan = savedSnakeAlias?.trace_spans.find((span) => span.name === "Cowork run");

    expect(snakeAliasRunSpan?.input_ref).toBe("max_rounds=20, max_agents=3, max_agent_calls=30");
    expect(snakeAliasRunSpan?.data).toMatchObject({
      run_until_idle: true,
      stop_on_blocker: true,
    });
  });

  test("routes desktop cowork action API paths through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    const create = await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Desktop action route",
        title: "Desktop Actions",
        blueprint: null,
        architecture: "team",
        workflow_mode: "team",
        agents: [{ id: "lead", name: "Lead" }, { id: "reviewer", name: "Reviewer", role: "Reviewer" }],
        tasks: [{ id: "answer", title: "Answer", description: "Answer task", assigned_agent_id: "lead" }],
      },
    }));
    const session = (((create.result as Record<string, unknown>).body as Record<string, unknown>).session as CoworkSession);
    expect(create).toMatchObject({
      result: {
        status: 200,
        body: {
          result: "started cw_1",
          session: expect.objectContaining({
            id: "cw_1",
            title: "Desktop Actions",
            workflow_mode: "team",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/pause`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Paused cowork session cw_1.",
          session: expect.objectContaining({
            status: "paused",
            tasks: expect.arrayContaining([expect.objectContaining({ id: "answer" })]),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/resume`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Resumed cowork session cw_1.",
          session: expect.objectContaining({
            status: "active",
            tasks: expect.arrayContaining([expect.objectContaining({ id: "answer" })]),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions/missing-session/pause",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Error: cowork session 'missing-session' not found",
          session: null,
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions/missing-session/resume",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Error: cowork session 'missing-session' not found",
          session: null,
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions/missing-session/tasks",
      body: { title: "Missing session task" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Error: cowork session 'missing-session' not found",
          session: null,
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/tasks/answer/assign`,
      body: { assigned_agent_id: "reviewer" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Task 'Answer' assigned to Reviewer.",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "answer", assigned_agent_id: "reviewer" })]),
          }),
        },
      },
    });

    const failed = await store.readSnapshot(session.id, "seed-failed");
    if (!failed) {
      throw new Error("missing desktop route session");
    }
    failed.tasks.answer.status = "failed";
    failed.tasks.answer.error = "Needs another pass";
    await store.writeSnapshot(failed, "seed-failed");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/tasks/answer/retry`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Task 'Answer' queued for retry.",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "answer", status: "pending", error: null })]),
          }),
        },
      },
    });

    const completed = await store.readSnapshot(session.id, "seed-completed");
    if (!completed) {
      throw new Error("missing retried desktop route session");
    }
    completed.tasks.answer.status = "completed";
    completed.tasks.answer.result = "answer";
    await store.writeSnapshot(completed, "seed-completed");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/tasks/answer/review`,
      body: { reviewer_agent_id: "reviewer" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          review_task_id: "task_1",
          reviewTask: expect.objectContaining({
            title: "Review Answer",
            assigned_agent_id: "reviewer",
          }),
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "task_1", title: "Review Answer" })]),
          }),
        },
      },
    });

    const branchSeed = await store.readSnapshot(session.id, "seed-branch");
    if (!branchSeed) {
      throw new Error("missing branch seed session");
    }
    branchSeed.status = "completed";
    branchSeed.final_draft = "Default branch result";
    branchSeed.artifacts = ["default.md"];
    branchSeed.tasks.answer.status = "completed";
    branchSeed.tasks.answer.confidence = 0.6;
    await store.writeSnapshot(branchSeed, "seed-branch");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/derive`,
      body: {
        target_architecture: "team",
        title: "Team branch",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          branch: expect.objectContaining({ id: "br_1", current: true, architecture: "team" }),
          session: expect.objectContaining({
            branches: expect.arrayContaining([expect.objectContaining({ id: "br_1", current: true })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });
    const derived = await store.readSnapshot(session.id, "seed-team-result");
    if (!derived) {
      throw new Error("missing derived desktop route session");
    }
    derived.branches.br_1.status = "completed";
    derived.branches.br_1.branch_result = {
      id: "brres_team",
      source_branch_id: "br_1",
      source_architecture: "team",
      summary: "Team branch result",
      artifacts: ["team.md"],
      decision: { team: true },
      confidence: 0.8,
      result_type: "branch",
      source_result_ids: [],
      created_at: "2026-06-12T08:00:00.000Z",
    };
    await store.writeSnapshot(derived, "seed-team-result");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/default/select`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          branch: expect.objectContaining({ id: "default", current: true }),
          session: expect.objectContaining({
            current_branch_id: "default",
            branches: expect.arrayContaining([expect.objectContaining({ id: "default", current: true })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/br_1/result/select-final`,
      body: { result_id: "brres_team" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session_final_result: expect.objectContaining({
            source: "selected_branch_result",
            selected_branch_id: "br_1",
            selected_result_id: "brres_team",
          }),
          session: expect.objectContaining({
            branches: expect.arrayContaining([expect.objectContaining({ id: "br_1" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branch-results/merge`,
      body: { branch_ids: ["default", "br_1"], summary: 404 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session_final_result: expect.objectContaining({
            source: "branch_merge",
            source_branch_ids: ["default", "br_1"],
            summary: "404",
          }),
          session: expect.objectContaining({
            branches: expect.arrayContaining([expect.objectContaining({ id: "br_1" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/final-result/select`,
      body: { branch_id: "br_1", result_id: "brres_team" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session_final_result: expect.objectContaining({
            source: "selected_branch_result",
            selected_branch_id: "br_1",
            selected_result_id: "brres_team",
          }),
          session: expect.objectContaining({
            branches: expect.arrayContaining([expect.objectContaining({ id: "br_1" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/final-result/merge`,
      body: { branch_ids: ["default", "br_1"] },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session_final_result: expect.objectContaining({
            source: "branch_merge",
            source_branch_ids: ["default", "br_1"],
          }),
          session: expect.objectContaining({
            branches: expect.arrayContaining([expect.objectContaining({ id: "br_1" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/emergency-stop`,
      body: { reason: "Unsafe to continue" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          agent_step: expect.objectContaining({ action_kind: "emergency_stop" }),
          session: expect.objectContaining({
            status: "paused",
            stop_reason: "emergency_stop",
            tasks: expect.arrayContaining([expect.objectContaining({ id: "answer" })]),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/emergency-stop`,
      body: { reason: 404 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          agent_step: expect.objectContaining({
            action_kind: "emergency_stop",
            scheduler_reason: "404",
          }),
        },
      },
    });
  });

  test("routes remaining non-run cowork API compatibility paths through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });

    const created = await coworkService.createSession({
      traceId: "seed-compat-routes",
      goal: "Compatibility routes",
      title: "Compatibility",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", assigned_agent_id: "lead" }],
      budgets: { max_tokens: 100 },
      blueprint: {
        goal: "Compatibility routes",
        title: "Compatibility",
        agents: [{ id: "lead", role: "Lead" }],
        tasks: [{ id: "draft", title: "Draft", assigned_agent_id: "lead" }],
        budgets: { max_tokens: 100 },
      },
    });
    created.artifacts = ["answer.md"];
    await store.writeSnapshot(created, "seed-compat-route-artifacts");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/blueprint`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          blueprint: expect.objectContaining({
            schema_version: "cowork.blueprint.v1",
            goal: "Compatibility routes",
            budgets: expect.objectContaining({ max_tokens: 100 }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/branches`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          current_branch_id: "default",
          branches: [
            expect.objectContaining({
              id: "default",
              current: true,
              architecture: "team",
            }),
          ],
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/graph`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          trace: expect.any(Array),
          architecture_topology: expect.objectContaining({ schema_version: "cowork.architecture_topology.v1" }),
          organization_projection: expect.objectContaining({ schema_version: "cowork.organization_projection.v1" }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/dag`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          task_dag: expect.objectContaining({
            nodes: expect.arrayContaining([expect.objectContaining({ id: "task:draft" })]),
          }),
          artifact_index: [expect.objectContaining({ path_or_url: "answer.md" })],
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/artifacts`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          artifact_index: [expect.objectContaining({ path_or_url: "answer.md" })],
          large_swarm_summary: expect.any(Object),
          swarm_organization: expect.any(Object),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/organization`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          swarm_organization: expect.any(Object),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/queues`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          swarm_queues: expect.any(Object),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/budget`,
      body: { budgets: { max_tokens: 250 } },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          budget: expect.objectContaining({
            limits: expect.objectContaining({ max_tokens: 250 }),
          }),
          session: expect.objectContaining({
            agents: expect.arrayContaining([expect.objectContaining({ id: "lead" })]),
            budget_state: expect.objectContaining({
              limits: expect.objectContaining({ max_tokens: 250 }),
            }),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "PATCH",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/budget`,
      body: { budgets: { max_tokens: 275 } },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          budget: expect.objectContaining({
            limits: expect.objectContaining({ max_tokens: 275 }),
          }),
          session: expect.objectContaining({
            agents: expect.arrayContaining([expect.objectContaining({ id: "lead" })]),
            budget_state: expect.objectContaining({
              limits: expect.objectContaining({ max_tokens: 275 }),
            }),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/branches/default/derive`,
      body: {
        target_architecture: "adaptive_starter",
        title: "Adaptive branch",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          branch: expect.objectContaining({
            id: "br_1",
            title: "Adaptive branch",
            source_branch_id: "default",
          }),
          session: expect.objectContaining({ current_branch_id: "br_1" }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/budget`,
      body: { budgets: { max_tokens: 300 }, budget: "ignored" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          budget: expect.objectContaining({
            limits: expect.objectContaining({ max_tokens: 300 }),
          }),
          session: expect.objectContaining({
            budget_state: expect.objectContaining({
              limits: expect.objectContaining({ max_tokens: 300 }),
            }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/branches/default/derive`,
      body: {
        architecture: "team",
        title: "Team alias branch",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          branch: expect.objectContaining({
            id: "br_2",
            title: "Team alias branch",
            architecture: "team",
            source_branch_id: "default",
          }),
          session: expect.objectContaining({ current_branch_id: "br_2" }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/branches/default/derive`,
      body: {
        target_architecture: "orchestrator",
        derivation_reason: 404,
        title: 505,
        inherited_context_summary: 606,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          branch: expect.objectContaining({
            id: "br_3",
            architecture: "orchestrator",
            title: "505",
            derivation_reason: "404",
            inherited_context_summary: "606",
            source_branch_id: "default",
          }),
          session: expect.objectContaining({
            current_branch_id: "br_3",
            stage_records: expect.arrayContaining([
              expect.objectContaining({
                target_branch_id: "br_3",
                derivation_reason: "404",
              }),
            ]),
          }),
        },
      },
    });
  });

  test("routes cowork work-unit lifecycle requests through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const session = await coworkService.createSession({
      traceId: "seed-work-units",
      goal: "Work unit lifecycle",
      title: "Work Units",
      workflowMode: "swarm",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [
        { id: "wu_retry_task", title: "Retry task", assigned_agent_id: "lead" },
        { id: "wu_retry_numeric_task", title: "Retry numeric task", assigned_agent_id: "lead" },
        { id: "wu_retry_route_task", title: "Retry route task", assigned_agent_id: "lead" },
        { id: "wu_skip_invalid_task", title: "Skip invalid task", assigned_agent_id: "lead" },
        { id: "wu_skip_task", title: "Skip task", assigned_agent_id: "lead" },
        { id: "wu_cancel_invalid_task", title: "Cancel invalid task", assigned_agent_id: "lead" },
        { id: "wu_cancel_task", title: "Cancel task", assigned_agent_id: "lead" },
      ],
    });
    const seeded = await store.readSnapshot(session.id, "seed-work-units");
    if (!seeded) {
      throw new Error("missing work unit session");
    }
    seeded.tasks.wu_retry_task.status = "failed";
    seeded.tasks.wu_retry_task.error = "Needs retry";
    seeded.tasks.wu_retry_numeric_task.status = "failed";
    seeded.tasks.wu_retry_numeric_task.error = "Needs numeric retry";
    seeded.tasks.wu_retry_route_task.status = "failed";
    seeded.tasks.wu_retry_route_task.error = "Needs route retry";
    seeded.tasks.wu_skip_task.status = "pending";
    seeded.tasks.wu_cancel_task.status = "in_progress";
    seeded.swarm_plan = {
      work_units: [
        {
          id: "wu_retry",
          title: "Retry unit",
          source_task_id: "wu_retry_task",
          status: "failed",
          attempts: 1,
          max_attempts: 3,
          priority: 2,
          error: "Needs retry",
        },
        {
          id: "wu_retry_numeric",
          title: "Retry numeric unit",
          source_task_id: "wu_retry_numeric_task",
          status: "failed",
          attempts: 1,
          max_attempts: 3,
          priority: 2,
          error: "Needs numeric retry",
        },
        {
          id: "wu_retry_route",
          title: "Retry route unit",
          source_task_id: "wu_retry_route_task",
          status: "failed",
          attempts: 1,
          max_attempts: 3,
          priority: 2,
          error: "Needs route retry",
        },
        {
          id: "wu_skip_invalid",
          title: "Skip invalid unit",
          source_task_id: "wu_skip_invalid_task",
          status: "ready",
          attempts: 0,
          max_attempts: 2,
        },
        {
          id: "wu_skip",
          title: "Skip unit",
          source_task_id: "wu_skip_task",
          status: "ready",
          attempts: 0,
          max_attempts: 2,
        },
        {
          id: "wu_cancel_invalid",
          title: "Cancel invalid unit",
          source_task_id: "wu_cancel_invalid_task",
          status: "in_progress",
          attempts: 1,
          max_attempts: 2,
        },
        {
          id: "wu_cancel",
          title: "Cancel unit",
          source_task_id: "wu_cancel_task",
          status: "in_progress",
          attempts: 1,
          max_attempts: 2,
        },
      ],
    };
    await store.writeSnapshot(seeded, "seed-work-units");

    await expect(worker.handleRequest(coworkRequest("cowork.retry_work_unit", {
      session_id: session.id,
      work_unit_id: 404,
      reason: 505,
    }))).resolves.toMatchObject({
      result: {
        result: "Error: work unit '404' not found",
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.retry_work_unit", {
      session_id: session.id,
      work_unit_id: "wu_retry",
      reason: "User retry",
    }))).resolves.toMatchObject({
      result: {
        result: "Work unit 'Retry unit' queued for retry.",
        session: expect.objectContaining({
          tasks: expect.objectContaining({
            wu_retry_task: expect.objectContaining({ status: "pending", error: null }),
          }),
          swarm_plan: expect.objectContaining({
            work_units: expect.arrayContaining([
              expect.objectContaining({
                id: "wu_retry",
                status: "ready",
                attempts: 2,
                error: null,
                priority_boost_reason: "User retry",
              }),
            ]),
          }),
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.retry_work_unit", {
      session_id: session.id,
      work_unit_id: "wu_retry_numeric",
      reason: 404,
    }))).resolves.toMatchObject({
      result: {
        result: "Work unit 'Retry numeric unit' queued for retry.",
        session: expect.objectContaining({
          tasks: expect.objectContaining({
            wu_retry_numeric_task: expect.objectContaining({ status: "pending", error: null }),
          }),
          swarm_plan: expect.objectContaining({
            work_units: expect.arrayContaining([
              expect.objectContaining({
                id: "wu_retry_numeric",
                status: "ready",
                attempts: 2,
                error: null,
                priority_boost_reason: "404",
              }),
            ]),
          }),
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/work-units/wu_retry_route/retry`,
      body: { reason: "Route retry" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Work unit 'Retry route unit' queued for retry.",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([
              expect.objectContaining({ id: "wu_retry_route_task", status: "pending", error: null }),
            ]),
            swarm_plan: expect.objectContaining({
              work_units: expect.arrayContaining([
                expect.objectContaining({
                  id: "wu_retry_route",
                  status: "ready",
                  attempts: 2,
                  error: null,
                  priority_boost_reason: "Route retry",
                }),
              ]),
            }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/work-units/wu_skip_invalid/skip`,
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/work-units/wu_skip/skip`,
      body: { reason: 404 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Work unit 'Skip unit' skipped.",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([
              expect.objectContaining({ id: "wu_skip_task", status: "skipped", result: "404" }),
            ]),
            swarm_plan: expect.objectContaining({
              work_units: expect.arrayContaining([
                expect.objectContaining({
                  id: "wu_skip",
                  status: "skipped",
                  skip_reason: "404",
                }),
              ]),
            }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/work-units/wu_cancel_invalid/cancel`,
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/work-units/wu_cancel/cancel`,
      body: { reason: 505 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Work unit 'Cancel unit' cancelled.",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([
              expect.objectContaining({ id: "wu_cancel_task", status: "skipped", result: "505" }),
            ]),
            swarm_plan: expect.objectContaining({
              work_units: expect.arrayContaining([
                expect.objectContaining({
                  id: "wu_cancel",
                  status: "cancelled",
                  cancel_reason: "505",
                }),
              ]),
            }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/work-units/missing/retry`,
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          result: "Error: work unit 'missing' not found",
          session: expect.objectContaining({
            id: session.id,
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });
  });

  test("routes desktop cowork read-only detail API paths through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const session = await coworkService.createSession({
      traceId: "seed-read-only",
      goal: "Read details",
      title: "Read Details",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
    });
    session.agent_steps = [{
      id: "step_1",
      session_id: session.id,
      branch_id: "default",
      architecture: "team",
      agent_id: "lead",
      action_kind: "tool_call",
      status: "completed",
      started_at: "2026-06-12T08:00:00.000Z",
      ended_at: "2026-06-12T08:00:01.000Z",
      duration_ms: 1000,
      task_id: null,
      work_unit_id: null,
      input_summary: "Read file",
      output_summary: "Read result",
      error: null,
      linked_message_ids: [],
      linked_artifact_refs: [],
      linked_task_ids: [],
      linked_envelope_ids: [],
      tool_observations: [{ id: "tool_1", name: "read_file", status: "completed" }],
      browser_observations: [],
      summary: null,
      detail_ref: "detail_1",
      source_span_id: null,
      source_event_id: null,
      projected: false,
    }];
    session.observation_details.detail_1 = {
      id: "detail_1",
      session_id: session.id,
      subject_type: "tool_observation",
      subject_id: "tool_1",
      visibility: "public",
      content: "Tool detail",
    };
    await store.writeSnapshot(session, "seed-detail");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/agents/lead/activity`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          activity: expect.objectContaining({
            recent_steps: expect.arrayContaining([
              expect.objectContaining({ id: "step_1", agent_id: "lead" }),
            ]),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/observations/detail_1`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          detail: expect.objectContaining({
            id: "detail_1",
            subject_id: "tool_1",
            visibility: "public",
          }),
        },
      },
    });
  });

  test("returns Python-sized scheduler decision history from the cowork trace route", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const session = await coworkService.createSession({
      traceId: "seed-trace-decisions",
      goal: "Trace decisions",
      title: "Trace Decisions",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
    });
    session.scheduler_decisions = Array.from({ length: 81 }, (_, index) => ({
      id: `decision_${index + 1}`,
      round: index + 1,
      reason: `decision ${index + 1}`,
    }));
    await store.writeSnapshot(session, "seed-trace-decisions");

    const response = await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/trace`,
    }));

    const decisions = ((response.result as {
      body: { scheduler_decisions: Array<{ id: string }> };
    }).body.scheduler_decisions);
    expect(decisions).toHaveLength(80);
    expect(decisions[0]?.id).toBe("decision_2");
    expect(decisions.at(-1)?.id).toBe("decision_81");
  });

  test("returns Python-shaped empty scheduler queues for non-swarm sessions", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const session = await coworkService.createSession({
      traceId: "seed-non-swarm-queues",
      goal: "Inspect queues",
      title: "Inspect Queues",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
      budgets: { parallel_width: 2 },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/queues`,
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          swarm_queues: expect.objectContaining({
            schema_version: "cowork.swarm_queues.v1",
            parallel_width: 2,
            available_slots: 2,
            counts: {
              ready: 0,
              blocked: 0,
              running: 0,
              completed: 0,
              failed_retry: 0,
              cancelled: 0,
            },
          }),
        },
      },
    });
  });

  test("defaults malformed Python agent-activity route limits before clamping", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const session = await coworkService.createSession({
      traceId: "seed-agent-activity-limit",
      goal: "Read activity",
      title: "Read Activity",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
    });
    session.agent_steps = Array.from({ length: 3 }, (_, index) => ({
      id: `step_${index + 1}`,
      session_id: session.id,
      agent_id: "lead",
      action_kind: "tool_call",
      status: "completed",
      started_at: `2026-06-12T08:00:0${index}.000Z`,
      ended_at: `2026-06-12T08:00:0${index + 1}.000Z`,
      linked_message_ids: [],
      linked_artifact_refs: [],
      linked_task_ids: [],
      tool_observations: [],
      browser_observations: [],
    }));
    await store.writeSnapshot(session, "seed-agent-activity-limit");

    const response = await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/agents/lead/activity?limit=2.5`,
    }));

    expect(response).toMatchObject({
      result: {
        status: 200,
        body: {
          activity: expect.objectContaining({
            recent_steps: [
              expect.objectContaining({ id: "step_1" }),
              expect.objectContaining({ id: "step_2" }),
              expect.objectContaining({ id: "step_3" }),
            ],
          }),
        },
      },
    });
  });

  test("returns Python-compatible status codes for cowork route errors", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const session = await coworkService.createSession({
      traceId: "seed-observability-status",
      goal: "Observability route status",
      title: "Observability Status",
      workflowMode: "team",
      agents: [{ id: "lead", name: "Lead" }],
    });
    const seeded = await store.readSnapshot(session.id, "seed-sensitive-detail");
    if (!seeded) {
      throw new Error("missing observability status session");
    }
    seeded.observation_details["secret-detail"] = {
      id: "secret-detail",
      subject_id: "secret-detail",
      subject_type: "tool",
      state: "available",
      summary: "Secret tool output",
      content: "sensitive output",
      sensitivity: "high",
      permitted_agent_ids: ["lead"],
    };
    await store.writeSnapshot(seeded, "seed-sensitive-detail");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/agents/missing/activity`,
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          activity: expect.objectContaining({
            available: false,
            error: "agent not found",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/observations/missing-detail`,
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          detail: expect.objectContaining({
            state: "unavailable",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/observations/secret-detail?agent_id=reviewer`,
    }))).resolves.toMatchObject({
      result: {
        status: 403,
        body: {
          detail: expect.objectContaining({
            state: "unauthorized",
            content: "",
            redacted: true,
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "DELETE",
      path: "/api/cowork/sessions/missing-session",
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          error: "cowork session not found",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: "/api/cowork/sessions/missing-session",
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          error: "cowork session not found",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: "/api/cowork/sessions/missing-session/summary",
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          summary: "Error: cowork session 'missing-session' not found",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: "/api/cowork/sessions/missing-session/trace",
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          error: "cowork session not found",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "GET",
      path: "/api/cowork/sessions/missing-session/branches",
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          error: "cowork session not found",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/budget`,
      body: { budgets: "invalid" },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "budgets must be an object",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/budget`,
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "invalid json body",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/missing-branch/select`,
    }))).resolves.toMatchObject({
      result: {
        status: 404,
        body: {
          error: "Error: branch 'missing-branch' not found.",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/missing-branch/derive`,
      body: {},
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "Error: source branch 'missing-branch' not found.",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/missing-branch/result/select-final`,
      body: {},
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "Error: branch 'missing-branch' not found.",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/default/result/select-final`,
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "invalid json body",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/final-result/select`,
      body: { branch_id: 404, result_id: 505 },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "Error: branch '404' not found.",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branch-results/merge`,
      body: {},
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "branch_ids must be a list",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/final-result/merge`,
      body: {},
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "branch_ids must be a list",
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branch-results/merge`,
      body: { branch_ids: ["default"] },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "Error: at least two existing branches are required to merge branch results.",
        },
      },
    });
  });

  test("routes cowork message and task mutation requests through the injected CoworkService", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Mutate Cowork session",
      title: "Mutation",
      agents: [
        { id: "lead", name: "Lead" },
        { id: "reviewer", name: "Reviewer" },
        { id: "123_5", name: "Numeric Reviewer" },
      ],
      tasks: [{ id: "open", title: "Open", description: "Open task" }],
    }));
    const sessionId = ((create.result as Record<string, unknown>).session as Record<string, unknown>).id;

    const messageResponse = await worker.handleRequest(coworkRequest("cowork.send_message", {
      session_id: sessionId,
      sender_id: 404,
      recipient_ids: ["reviewer"],
      content: 12345,
      thread_id: 101.5,
      topic: 202,
      event_type: 303,
    }));
    const messageResult = messageResponse.result as { message: Record<string, unknown>; session: { agents: Record<string, { inbox: string[] }> } };
    expect(messageResult.message).toMatchObject({
      id: "msg_2",
      sender_id: "404",
      content: "12345",
      thread_id: "101.5",
      topic: "202",
      event_type: "303",
    });
    expect(messageResult.session.agents.reviewer.inbox).toEqual(["msg_2"]);

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/messages`,
      body: {
        content: "Route message",
        recipient_ids: ["reviewer"],
        thread_id: 101,
        topic: 202,
        event_type: 303,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          message: expect.objectContaining({
            id: "msg_3",
            content: "Route message",
            thread_id: "101",
          }),
          session: expect.objectContaining({
            threads: expect.arrayContaining([
              expect.objectContaining({
                id: "101",
                topic: "202",
              }),
            ]),
            mailbox: expect.arrayContaining([
              expect.objectContaining({
                id: "env_1",
                message_id: "msg_3",
                thread_id: "101",
                topic: "202",
                event_type: "303",
                status: "delivered",
              }),
            ]),
            trace: expect.arrayContaining([
              expect.objectContaining({
                type: "mailbox.queued",
                payload: expect.objectContaining({
                  envelope_id: "env_1",
                  topic: "202",
                  event_type: "303",
                }),
              }),
            ]),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/messages`,
      body: { content: 12345 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          message: expect.objectContaining({
            content: "12345",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/messages`,
      body: { content: "   " },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "content is required" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: "/api/cowork/sessions/missing-session/messages",
      body: { content: "Hello missing session" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Error: cowork session 'missing-session' not found",
          session: null,
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/messages`,
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.add_task", {
      session_id: sessionId,
      title: 42,
      description: 9001,
      assigned_agent_id: 123.5,
      expected_output: 707,
      fanout_group_id: 808,
      merge_task_id: 909,
      dependencies: ["open"],
    }))).resolves.toMatchObject({
      result: {
        task: expect.objectContaining({
          id: "task_1",
          title: "42",
          description: "9001",
          assigned_agent_id: "123_5",
          expected_output: "707",
          fanout_group_id: "808",
          merge_task_id: "909",
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks`,
      body: { title: 42 },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          task: expect.objectContaining({
            id: "task_2",
            title: "42",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks`,
      body: { title: "Route assigned", assignedAgentId: "", assigned_agent_id: "lead" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          task: expect.objectContaining({
            id: "task_3",
            title: "Route assigned",
            assigned_agent_id: "lead",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks`,
      body: {
        title: "Numeric description",
        description: 9001,
        expected_output: "direct-only expected output",
        review_required: true,
        reviewer_agent_ids: ["reviewer"],
        fanout_group_id: "direct-only fanout",
        merge_task_id: "direct-only merge",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          task: expect.objectContaining({
            id: "task_4",
            title: "Numeric description",
            description: "9001",
            expected_output: "",
            review_required: false,
            reviewer_agent_ids: [],
            fanout_group_id: "",
            merge_task_id: "",
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks`,
      body: { title: "   " },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "title is required" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks`,
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks/open/assign`,
      body: { agentId: "", assigned_agent_id: "lead" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Task 'Open' assigned to Lead.",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "open", assigned_agent_id: "lead" })]),
          }),
        },
      },
    });

    const assignResponse = await worker.handleRequest(coworkRequest("cowork.assign_task", {
      session_id: sessionId,
      task_id: "open",
      assigned_agent_id: 123.5,
    }));
    const assignResult = assignResponse.result as { result: string; session: { tasks: Record<string, { assigned_agent_id: string }> } };
    expect(assignResult.result).toBe("Task 'Open' assigned to Numeric Reviewer.");
    expect(assignResult.session.tasks.open.assigned_agent_id).toBe("123_5");

    await expect(worker.handleRequest(coworkRequest("cowork.assign_task", {
      session_id: sessionId,
      task_id: 404,
      assigned_agent_id: 123.5,
    }))).resolves.toMatchObject({
      result: {
        result: "Error: task '404' not found",
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks/open/assign`,
      body: {},
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          result: "Error: agent 'item' not found",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "open", assigned_agent_id: "123_5" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks/open/assign`,
      body: { assigned_agent_id: 123 },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          result: "Error: agent '123' not found",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "open", assigned_agent_id: "123_5" })]),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks/open/assign`,
      body: ["not", "an", "object"],
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: { error: "invalid json body" },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks/missing/retry`,
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          result: "Error: task 'missing' not found",
          session: expect.objectContaining({
            tasks: expect.arrayContaining([expect.objectContaining({ id: "open", assigned_agent_id: "123_5" })]),
            graph: expect.objectContaining({ schema_version: "cowork.graph.v2" }),
          }),
        },
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(String(sessionId))}/tasks/missing/review`,
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "Error: task 'missing' not found",
        },
      },
    });
  });

  test("routes recipient-less swarm messages as user steering instructions", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const created = await coworkService.createSession({
      traceId: "seed-swarm-steering",
      goal: "Coordinate swarm steering",
      title: "Swarm Steering",
      workflowMode: "swarm",
      agents: [
        { id: "lead", name: "Lead" },
        { id: "researcher", name: "Researcher" },
      ],
      tasks: [{ id: "research", title: "Research", assigned_agent_id: "researcher" }],
    });
    const seeded = await store.readSnapshot(created.id, "seed-swarm-steering");
    if (!seeded) {
      throw new Error("missing swarm session");
    }
    seeded.swarm_plan = {
      id: "swarm_1",
      status: "blocked",
      work_units: [],
    };
    await store.writeSnapshot(seeded, "seed-swarm-steering");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(created.id)}/messages`,
      body: { content: "Prioritize the browser findings" },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          result: "Steering instruction routed to lead.",
          session: expect.objectContaining({
            status: "active",
            messages: expect.arrayContaining([
              expect.objectContaining({
                id: "msg_2",
                sender_id: "user",
                recipient_ids: ["lead"],
                content: "Prioritize the browser findings",
              }),
            ]),
            agents: expect.arrayContaining([
              expect.objectContaining({ id: "lead", inbox_count: 2 }),
              expect.objectContaining({ id: "researcher", inbox_count: 0 }),
            ]),
            swarm_plan: expect.objectContaining({
              status: "active",
              user_steering: [
                expect.objectContaining({
                  instruction: "Prioritize the browser findings",
                  actor_id: "user",
                }),
              ],
            }),
            events: expect.arrayContaining([
              expect.objectContaining({
                type: "swarm.user_steered",
                data: expect.objectContaining({ lead_agent_id: "lead" }),
              }),
            ]),
            trace_spans: expect.arrayContaining([
              expect.objectContaining({
                kind: "swarm",
                name: "User steering",
                status: "completed",
              }),
            ]),
          }),
        },
      },
    });
  });

  test("routes cowork mailbox lifecycle requests through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Mailbox worker path",
      title: "Mailbox Worker",
      agents: [
        { id: "coordinator", name: "Coordinator", role: "Lead" },
        { id: "researcher", name: "Researcher", role: "Research" },
        { id: "reviewer", name: "Reviewer", role: "Quality reviewer", responsibilities: ["Verify risk"] },
      ],
      tasks: [],
    }));
    const session = (create.result as { session: CoworkSession }).session;

    await expect(worker.handleRequest(coworkRequest("cowork.deliver_envelope", {
      session_id: session.id,
      envelope: {
        sender_id: 404,
        recipient_ids: ["researcher"],
        content: 505,
        topic: 606,
        event_type: 707,
        request_type: 808,
        thread_id: 909,
        blocking_task_id: 1001,
        requires_reply: true,
      },
    }))).resolves.toMatchObject({
      result: {
        message: expect.objectContaining({
          id: "msg_2",
          sender_id: "404",
          recipient_ids: ["researcher"],
          content: "505",
          thread_id: "909",
        }),
        record: expect.objectContaining({
          id: "env_1",
          status: "delivered",
          sender_id: "404",
          content: "505",
          topic: "606",
          event_type: "707",
          request_type: "808",
          thread_id: "909",
          blocking_task_id: "1001",
        }),
        session: expect.objectContaining({
          agents: expect.objectContaining({
            researcher: expect.objectContaining({ inbox: ["msg_2"] }),
          }),
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.mark_messages_read", {
      session_id: session.id,
      agent_id: 404,
    }))).resolves.toMatchObject({
      result: {
        messages: [],
        session: expect.objectContaining({
          agents: expect.objectContaining({
            researcher: expect.objectContaining({ inbox: ["msg_2"] }),
          }),
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.mark_messages_read", {
      session_id: session.id,
      agent_id: "researcher",
    }))).resolves.toMatchObject({
      result: {
        messages: [expect.objectContaining({ id: "msg_2", read_by: ["404", "researcher"] })],
        session: expect.objectContaining({
          mailbox: expect.objectContaining({
            env_1: expect.objectContaining({ status: "read", read_by: ["researcher"] }),
          }),
        }),
      },
    });

    const stale = await coworkService.deliverEnvelope({
      traceId: "seed-stale",
      sessionId: session.id,
      envelope: {
        sender_id: "researcher",
        recipient_ids: ["coordinator"],
        content: "Blocked on verification.",
        requires_reply: true,
        blocking_task_id: "task_x",
        escalate_after_rounds: 1,
      },
    });
    stale.session.rounds = 1;
    await store.writeSnapshot(stale.session, "seed-round");

    await expect(worker.handleRequest(coworkRequest("cowork.escalate_stale_blockers", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        records: [expect.objectContaining({ id: "env_2", escalated_at: "2026-06-12T08:00:00.000Z" })],
        session: expect.objectContaining({
          messages: expect.objectContaining({
            msg_4: expect.objectContaining({
              sender_id: "user",
              recipient_ids: ["reviewer"],
            }),
          }),
        }),
      },
    });

    const expiring = await coworkService.deliverEnvelope({
      traceId: "seed-expiring",
      sessionId: session.id,
      envelope: {
        sender_id: "coordinator",
        recipient_ids: ["researcher"],
        content: "Deadline.",
        requires_reply: true,
        deadline_round: 1,
        correlation_id: "deadline-1",
      },
    });
    expiring.session.rounds = 1;
    await store.writeSnapshot(expiring.session, "seed-deadline");

    await expect(worker.handleRequest(coworkRequest("cowork.expire_mailbox_records", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        records: [expect.objectContaining({ id: "env_3", status: "expired" })],
        session: expect.objectContaining({
          mailbox: expect.objectContaining({
            env_3: expect.objectContaining({ status: "expired", correlation_id: "deadline-1" }),
          }),
        }),
      },
    });
  });

  test("routes cowork retry and review task requests through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Review retry path",
      title: "Review Retry",
      agents: [
        { id: "lead", name: "Lead" },
        { id: "reviewer", name: "Reviewer", role: "Reviewer" },
        { id: "123_5", name: "Numeric Reviewer", role: "Reviewer" },
      ],
      tasks: [{ id: "answer", title: "Answer", description: "Answer task", assigned_agent_id: "lead" }],
    }));
    const session = ((create.result as Record<string, unknown>).session as CoworkSession);
    session.tasks.answer.status = "failed";
    session.tasks.answer.error = "bad result";
    await store.writeSnapshot(session, "seed-failed");

    await expect(worker.handleRequest(coworkRequest("cowork.retry_task", {
      session_id: session.id,
      task_id: 404,
    }))).resolves.toMatchObject({
      result: {
        result: "Error: task '404' not found",
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.retry_task", {
      session_id: session.id,
      task_id: "answer",
    }))).resolves.toMatchObject({
      result: {
        result: "Task 'Answer' queued for retry.",
        session: expect.objectContaining({
          tasks: {
            answer: expect.objectContaining({ status: "pending", error: null }),
          },
        }),
      },
    });

    const retried = await store.readSnapshot(session.id, "seed-completed");
    if (!retried) {
      throw new Error("missing retried session");
    }
    retried.tasks.answer.status = "completed";
    retried.tasks.answer.result = "answer";
    await store.writeSnapshot(retried, "seed-completed");

    await expect(worker.handleRequest(coworkRequest("cowork.request_task_review", {
      session_id: session.id,
      task_id: 505,
      reviewer_agent_id: 123.5,
    }))).resolves.toMatchObject({
      error: {
        message: "Error: task '505' not found",
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.request_task_review", {
      session_id: session.id,
      task_id: "answer",
      reviewer_agent_id: 123.5,
    }))).resolves.toMatchObject({
      result: {
        review_task_id: "task_1",
        reviewTask: expect.objectContaining({
          title: "Review Answer",
          assigned_agent_id: "123_5",
          dependencies: ["answer"],
        }),
      },
    });
  });

  test("honors Python reviewer_agent_id precedence over blank reviewerAgentId on task review routes", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Review route alias precedence",
      title: "Review Route Alias",
      agents: [
        { id: "lead", name: "Lead", role: "Lead" },
        { id: "123_5", name: "Numeric Assignee", role: "Analyst" },
      ],
      tasks: [{ id: "answer", title: "Answer", description: "Answer task", assigned_agent_id: "lead" }],
    }));
    const session = ((create.result as Record<string, unknown>).session as CoworkSession);
    session.tasks.answer.status = "completed";
    session.tasks.answer.result = "answer";
    await store.writeSnapshot(session, "seed-completed");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/tasks/answer/review`,
      body: {
        reviewerAgentId: "",
        reviewer_agent_id: 123.5,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          review_task_id: "task_1",
          reviewTask: expect.objectContaining({
            title: "Review Answer",
            assigned_agent_id: "123_5",
            dependencies: ["answer"],
          }),
        },
      },
    });
  });

  test("honors Python target_architecture precedence over blank targetArchitecture on branch derive routes", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Branch route alias precedence",
      title: "Branch Route Alias",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    }));
    const session = ((create.result as Record<string, unknown>).session as CoworkSession);

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/derive`,
      body: {
        targetArchitecture: "",
        target_architecture: "team",
        derivationReason: "",
        derivation_reason: 404,
        inheritedContextSummary: "",
        inherited_context_summary: 505,
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          branch: expect.objectContaining({
            id: "br_1",
            architecture: "team",
            derivation_reason: "404",
            inherited_context_summary: "505",
          }),
        },
      },
    });
  });

  test("honors Python result_id precedence over blank resultId on branch final-result routes", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Final result route alias precedence",
      title: "Final Result Alias",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    }));
    const session = ((create.result as Record<string, unknown>).session as CoworkSession);
    session.branches.default.branch_result = {
      id: "brres_default",
      source_branch_id: "default",
      source_architecture: "adaptive_starter",
      summary: "Default result",
      artifacts: [],
      decision: {},
      confidence: 0.7,
      result_type: "branch",
      source_result_ids: [],
      created_at: "2026-06-12T08:00:00.000Z",
    };
    await store.writeSnapshot(session, "seed-default-result");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/default/result/select-final`,
      body: {
        resultId: "",
        result_id: "missing",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 400,
        body: {
          error: "Error: branch result 'missing' not found on branch 'default'.",
        },
      },
    });
  });

  test("honors Python branch_ids precedence over blank branchIds on final-result merge routes", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Merge route alias precedence",
      title: "Merge Route Alias",
      agents: [{ id: "lead", name: "Lead", role: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    }));
    const session = ((create.result as Record<string, unknown>).session as CoworkSession);
    await worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/branches/derive`,
      body: { target_architecture: "team" },
    }));
    const seeded = await store.readSnapshot(session.id, "seed-merge-results");
    if (!seeded) {
      throw new Error("missing merge alias session");
    }
    seeded.branches.default.branch_result = {
      id: "brres_default",
      source_branch_id: "default",
      source_architecture: "adaptive_starter",
      summary: "Default result",
      artifacts: ["default.md"],
      decision: { default: true },
      confidence: 0.7,
      result_type: "branch",
      source_result_ids: [],
      created_at: "2026-06-12T08:00:00.000Z",
    };
    seeded.branches.br_1.branch_result = {
      id: "brres_team",
      source_branch_id: "br_1",
      source_architecture: "team",
      summary: "Team result",
      artifacts: ["team.md"],
      decision: { team: true },
      confidence: 0.8,
      result_type: "branch",
      source_result_ids: [],
      created_at: "2026-06-12T08:00:00.000Z",
    };
    await store.writeSnapshot(seeded, "seed-merge-results");

    await expect(worker.handleRequest(coworkRequest("cowork.route_request", {
      method: "POST",
      path: `/api/cowork/sessions/${encodeURIComponent(session.id)}/final-result/merge`,
      body: {
        branchIds: [],
        branch_ids: ["default", "br_1"],
        summary: "Merged summary",
      },
    }))).resolves.toMatchObject({
      result: {
        status: 200,
        body: {
          session_final_result: expect.objectContaining({
            source: "branch_merge",
            source_branch_ids: ["default", "br_1"],
            source_result_ids: ["brres_default", "brres_team"],
            summary: "Merged summary",
          }),
        },
      },
    });
  });

  test("routes cowork session control and budget requests through the injected CoworkService", async () => {
    const coworkService = new CoworkService({
      store: createMemoryCoworkStore(),
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Control session",
      title: "Control",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [],
    }));
    const sessionId = ((create.result as Record<string, unknown>).session as CoworkSession).id;

    await expect(worker.handleRequest(coworkRequest("cowork.pause_session", {
      session_id: sessionId,
    }))).resolves.toMatchObject({
      result: {
        result: `Paused cowork session ${sessionId}.`,
        session: expect.objectContaining({
          status: "paused",
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.resume_session", {
      session_id: sessionId,
    }))).resolves.toMatchObject({
      result: {
        result: `Resumed cowork session ${sessionId}.`,
        session: expect.objectContaining({
          status: "active",
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.update_budget", {
      session_id: sessionId,
      budgets: { max_tokens: 500 },
    }))).resolves.toMatchObject({
      result: {
        budget: expect.objectContaining({
          limits: expect.objectContaining({ max_tokens: 500 }),
          remaining: expect.objectContaining({ max_tokens: 500 }),
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.emergency_stop_session", {
      session_id: sessionId,
      reason: "Unsafe to continue",
    }))).resolves.toMatchObject({
      result: {
        agentStep: expect.objectContaining({
          action_kind: "emergency_stop",
          status: "stopped",
        }),
        session: expect.objectContaining({
          status: "paused",
          stop_reason: "emergency_stop",
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.emergency_stop_session", {
      session_id: sessionId,
      reason: 404,
    }))).resolves.toMatchObject({
      result: {
        agentStep: expect.objectContaining({
          action_kind: "emergency_stop",
          scheduler_reason: "404",
        }),
      },
    });
  });

  test("routes cowork branch and final-result requests through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Branch worker path",
      title: "Branches",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
    }));
    const session = (create.result as { session: CoworkSession }).session;
    session.status = "completed";
    session.final_draft = "Default branch result";
    session.artifacts = ["default.md"];
    session.tasks.draft.status = "completed";
    session.tasks.draft.confidence = 0.6;
    await store.writeSnapshot(session, "seed-completed-default");

    await expect(worker.handleRequest(coworkRequest("cowork.derive_branch", {
      session_id: session.id,
      source_branch_id: "default",
      target_architecture: "team",
      reason: 404,
      title: 505,
      inherited_context_summary: 606,
    }))).resolves.toMatchObject({
      result: {
        branch: expect.objectContaining({
          id: "br_1",
          title: "505",
          architecture: "team",
          derivation_reason: "404",
          inherited_context_summary: "606",
          source_branch_id: "default",
        }),
        session: expect.objectContaining({
          current_branch_id: "br_1",
          branches: expect.objectContaining({
            default: expect.objectContaining({
              branch_result: expect.objectContaining({ id: "brres_1" }),
            }),
          }),
          stage_records: expect.arrayContaining([
            expect.objectContaining({
              target_branch_id: "br_1",
              derivation_reason: "404",
              inherited_context_summary: "606",
            }),
          ]),
        }),
      },
    });

    const derived = await store.readSnapshot(session.id, "seed-team-result");
    if (!derived) {
      throw new Error("missing derived session");
    }
    derived.branches.br_1.status = "completed";
    derived.branches.br_1.branch_result = {
      id: "brres_team",
      source_branch_id: "br_1",
      source_architecture: "team",
      summary: "Team branch result",
      artifacts: ["team.md"],
      decision: { team: true },
      confidence: 0.8,
      result_type: "branch",
      source_result_ids: [],
      created_at: "2026-06-12T08:00:00.000Z",
    };
    await store.writeSnapshot(derived, "seed-team-result");

    await expect(worker.handleRequest(coworkRequest("cowork.select_branch", {
      session_id: session.id,
      branch_id: "default",
    }))).resolves.toMatchObject({
      result: {
        branch: expect.objectContaining({ id: "default" }),
        session: expect.objectContaining({ current_branch_id: "default" }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.select_branch_result", {
      session_id: session.id,
      branch_id: 404,
      result_id: "missing",
    }))).resolves.toMatchObject({
      result: {
        finalResult: null,
        result: "Error: branch '404' not found.",
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.select_branch_result", {
      session_id: session.id,
      branch_id: "br_1",
      result_id: 505,
    }))).resolves.toMatchObject({
      result: {
        finalResult: null,
        result: "Error: branch result '505' not found on branch 'br_1'.",
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.select_branch_result", {
      session_id: session.id,
      branch_id: "br_1",
      result_id: "brres_team",
    }))).resolves.toMatchObject({
      result: {
        finalResult: expect.objectContaining({
          id: "final_1",
          source: "selected_branch_result",
          selected_branch_id: "br_1",
          selected_result_id: "brres_team",
        }),
      },
    });

    await expect(worker.handleRequest(coworkRequest("cowork.merge_branch_results", {
      session_id: session.id,
      branch_ids: ["default", "br_1"],
      summary: 707,
    }))).resolves.toMatchObject({
      result: {
        finalResult: expect.objectContaining({
          id: "final_2",
          source: "branch_merge",
          summary: "707",
          source_branch_ids: ["default", "br_1"],
          source_result_ids: ["brres_1", "brres_team"],
          artifacts: ["default.md", "team.md"],
        }),
      },
    });
  });

  test("routes cowork read-only observability requests through the injected CoworkService", async () => {
    const store = createMemoryCoworkStore();
    const coworkService = new CoworkService({
      store,
      now: () => "2026-06-12T08:00:00.000Z",
      idGenerator: (() => {
        const counters = new Map<string, number>();
        return (prefix: string) => {
          const next = (counters.get(prefix) ?? 0) + 1;
          counters.set(prefix, next);
          return `${prefix}_${next}`;
        };
      })(),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      coworkService,
    });
    const create = await worker.handleRequest(coworkRequest("cowork.create_session", {
      goal: "Inspect worker facade",
      title: "Worker Facade",
      workflow_mode: "team",
      agents: [{ id: "lead", name: "Lead" }],
      tasks: [{ id: "draft", title: "Draft", description: "Draft answer", assigned_agent_id: "lead" }],
      budgets: { max_tokens: 300 },
    }));
    const session = (create.result as { session: CoworkSession }).session;
    session.agents["404"] = {
      ...session.agents.lead,
      id: "404",
      name: "Numeric Agent",
    };
    session.agent_steps = [{
      id: "step_1",
      session_id: session.id,
      agent_id: "404",
      task_id: "draft",
      status: "completed",
      linked_message_ids: ["msg_1"],
      linked_task_ids: ["draft"],
      linked_artifact_refs: ["answer.md"],
      tool_observations: [{ id: "tool_1", name: "read_file", status: "completed" }],
      browser_observations: [],
    }];
    session.observation_details["505"] = {
      id: "505",
      subject_id: "tool_1",
      subject_type: "tool_observation",
      state: "available",
      summary: "Read result",
      content: "full content",
      content_type: "text/plain",
      redacted: false,
      sensitivity: "",
      permitted_agent_ids: [],
      artifact_refs: ["answer.md"],
    };
    session.artifacts = ["answer.md"];
    await store.writeSnapshot(session, "seed-worker-observability");

    await expect(worker.handleRequest(coworkRequest("cowork.export_blueprint", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        blueprint: expect.objectContaining({
          schema_version: "cowork.blueprint.v1",
          goal: "Inspect worker facade",
          title: "Worker Facade",
          budgets: expect.objectContaining({ max_tokens: 300 }),
        }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_graph", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        graph: expect.objectContaining({
          schema_version: "cowork.graph.v2",
        }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_trace", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        trace: expect.any(Array),
        trace_spans: expect.any(Array),
        agent_steps: [expect.objectContaining({ id: "step_1" })],
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_agent_activity", {
      session_id: session.id,
      agent_id: 404,
      limit: 5,
    }))).resolves.toMatchObject({
      result: {
        activity: expect.objectContaining({
          available: true,
          session_id: session.id,
          agent: expect.objectContaining({ id: "404" }),
        }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_observation_detail", {
      session_id: session.id,
      detail_id: 505,
      agent_id: 404,
    }))).resolves.toMatchObject({
      result: {
        detail: expect.objectContaining({
          id: "505",
          state: "available",
          content: "full content",
        }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_summary", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        summary: expect.objectContaining({
          session_id: session.id,
          counts: expect.objectContaining({ agents: 2, tasks: 1, artifacts: 1 }),
        }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_dag", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        task_dag: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({ id: "task:draft" }),
          ]),
        }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_artifacts", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        artifacts: [expect.objectContaining({ path_or_url: "answer.md" })],
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_organization", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        organization: expect.objectContaining({
          schema_version: "cowork.organization_projection.v1",
          architecture: "team",
        }),
      },
    });
    await expect(worker.handleRequest(coworkRequest("cowork.get_queues", {
      session_id: session.id,
    }))).resolves.toMatchObject({
      result: {
        queues: {},
      },
    });
  });

  test("routes agent.run through AgentRunner and emits completion event", async () => {
    const events: WorkerEvent[] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(response).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: {
        finalContent: "done",
        stopReason: "final_response",
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.done",
      payload: expect.objectContaining({
        runId: "run-1",
        stopReason: "final_response",
      }),
    }));
  });

  test("runs due cron agent-turn jobs through the AgentRunner", async () => {
    const events: WorkerEvent[] = [];
    const provider = new QueueProvider([{ content: "cron completed", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const response = await worker.handleRequest(cronRunDueRequest({
      model: "fixture-model",
      maxIterations: 2,
      stream: false,
      jobs: [
        {
          id: "job-1",
          name: "Check status",
          enabled: true,
          schedule: { kind: "every", everyMs: 60000 },
          payload: {
            kind: "agent_turn",
            message: "Check system status",
            deliver: true,
            channel: "desktop",
            to: "chat-1",
          },
          state: { nextRunAtMs: 1000 },
          createdAtMs: 1,
          updatedAtMs: 1,
          deleteAfterRun: false,
        },
      ],
    }));

    expect(response).toMatchObject({
      protocol_version: "1",
      id: "cron-run-due-1",
      trace_id: "trace-cron-run-due",
      result: {
        records: [
          expect.objectContaining({
            jobId: "job-1",
            status: "ok",
            runId: "cron-job-1-cron-run-due-1",
            finalContent: "cron completed",
            stopReason: "final_response",
          }),
        ],
      },
    });
    expect(provider.messages[0]).toEqual([
      {
        role: "user",
        content: "[Scheduled Task] Timer finished.\n\nTask 'Check status' has been triggered.\nScheduled instruction: Check system status",
      },
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.done",
      payload: expect.objectContaining({ runId: "cron-job-1-cron-run-due-1" }),
    }));
  });

  test("routes heartbeat trigger and status requests to the heartbeat runtime", async () => {
    const heartbeatRuntime = {
      triggerNow: vi.fn(async () => ({
        status: "executed" as const,
        tasks: "Review heartbeat task.",
        response: "Heartbeat complete.",
      })),
      getStatus: vi.fn(() => ({
        enabled: true,
        running: false,
        executing: false,
        intervalMs: 1800000,
        lastResult: null,
        lastError: null,
      })),
      start: vi.fn(async () => true),
      stop: vi.fn(() => undefined),
    };
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => {},
      heartbeatRuntime,
    });

    await expect(worker.handleRequest(heartbeatRequest("heartbeat.trigger_now"))).resolves.toMatchObject({
      protocol_version: "1",
      id: "heartbeat.trigger_now-1",
      trace_id: "trace-heartbeat.trigger_now",
      result: {
        status: "executed",
        tasks: "Review heartbeat task.",
        response: "Heartbeat complete.",
      },
    });
    await expect(worker.handleRequest(heartbeatRequest("heartbeat.status"))).resolves.toMatchObject({
      result: {
        enabled: true,
        running: false,
        executing: false,
        intervalMs: 1800000,
        lastResult: null,
        lastError: null,
      },
    });
    await expect(worker.handleRequest(heartbeatRequest("heartbeat.start"))).resolves.toMatchObject({
      result: {
        started: true,
        status: {
          enabled: true,
          running: false,
          executing: false,
          intervalMs: 1800000,
          lastResult: null,
          lastError: null,
        },
      },
    });
    await expect(worker.handleRequest(heartbeatRequest("heartbeat.stop"))).resolves.toMatchObject({
      result: {
        stopped: true,
        status: {
          enabled: true,
          running: false,
          executing: false,
          intervalMs: 1800000,
          lastResult: null,
          lastError: null,
        },
      },
    });
    expect(heartbeatRuntime.triggerNow).toHaveBeenCalledTimes(1);
    expect(heartbeatRuntime.getStatus).toHaveBeenCalledTimes(3);
    expect(heartbeatRuntime.start).toHaveBeenCalledTimes(1);
    expect(heartbeatRuntime.stop).toHaveBeenCalledTimes(1);
  });

  test("routes channel lifecycle requests to the native channel manager", async () => {
    const channelManager = {
      startAll: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      login: vi.fn(async () => false),
      status: vi.fn(() => ({
        running: true,
        channels: [
          { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
        ],
        diagnostics: [],
      })),
    };
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => {},
      channelManager,
    });

    await expect(worker.handleRequest(channelRequest("channel.start"))).resolves.toMatchObject({
      protocol_version: "1",
      id: "channel.start-1",
      trace_id: "trace-channel.start",
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
    await expect(worker.handleRequest(channelRequest("channel.login", {
      channel: "feishu",
      force: true,
    }))).resolves.toMatchObject({
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
    await expect(worker.handleRequest(channelRequest("channel.status"))).resolves.toMatchObject({
      result: {
        running: true,
        channels: [
          { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
        ],
        diagnostics: [],
      },
    });
    await expect(worker.handleRequest(channelRequest("channel.stop"))).resolves.toMatchObject({
      result: {
        stopped: true,
        status: {
          running: true,
          channels: [
            { name: "feishu", displayName: "Feishu", supportsStreaming: true, running: true },
          ],
          diagnostics: [],
        },
      },
    });
    expect(channelManager.startAll).toHaveBeenCalledTimes(1);
    expect(channelManager.login).toHaveBeenCalledWith("feishu", { force: true });
    expect(channelManager.stopAll).toHaveBeenCalledTimes(1);
    expect(channelManager.status).toHaveBeenCalledTimes(4);
  });

  test("returns an explicit error when channel manager is unavailable", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => {},
    });

    await expect(worker.handleRequest(channelRequest("channel.status"))).resolves.toMatchObject({
      error: {
        code: "worker_error",
        message: "channel.status requires a channel manager",
      },
    });
    await expect(worker.handleRequest(channelRequest("channel.start"))).resolves.toMatchObject({
      error: {
        code: "worker_error",
        message: "channel.start requires a channel manager",
      },
    });
    await expect(worker.handleRequest(channelRequest("channel.login", { channel: "feishu" }))).resolves.toMatchObject({
      error: {
        code: "worker_error",
        message: "channel.login requires a channel manager",
      },
    });
  });

  test("returns an explicit error when heartbeat runtime is unavailable", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => {},
    });

    await expect(worker.handleRequest(heartbeatRequest("heartbeat.status"))).resolves.toMatchObject({
      error: {
        code: "worker_error",
        message: "heartbeat.status requires a heartbeat runtime",
      },
    });
    await expect(worker.handleRequest(heartbeatRequest("heartbeat.start"))).resolves.toMatchObject({
      error: {
        code: "worker_error",
        message: "heartbeat.start requires a heartbeat runtime",
      },
    });
  });

  test("evaluates cron deliver jobs before emitting outbound delivery", async () => {
    const events: WorkerEvent[] = [];
    const provider = new QueueProvider([
      { content: "routine heartbeat ok", toolCalls: [], stopReason: "stop" },
      {
        content: "",
        toolCalls: [{
          id: "eval-1",
          name: "evaluate_notification",
          argumentsJson: JSON.stringify({ should_notify: false, reason: "routine" }),
        }],
        stopReason: "tool_calls",
      },
    ]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const response = await worker.handleRequest(cronRunDueRequest({
      model: "fixture-model",
      maxIterations: 2,
      stream: false,
      jobs: [
        {
          id: "job-1",
          name: "Check status",
          enabled: true,
          schedule: { kind: "every", everyMs: 60000 },
          payload: {
            kind: "agent_turn",
            message: "Check system status",
            deliver: true,
            channel: "desktop",
            to: "chat-1",
          },
          state: { nextRunAtMs: 1000 },
          createdAtMs: 1,
          updatedAtMs: 1,
          deleteAfterRun: false,
        },
      ],
    }));

    expect(response).toMatchObject({
      result: {
        records: [
          expect.objectContaining({
            jobId: "job-1",
            status: "ok",
            finalContent: "routine heartbeat ok",
            delivered: false,
            deliveryReason: "routine",
          }),
        ],
      },
    });
    expect(provider.messages).toHaveLength(2);
    expect(provider.messages[1]?.[1]).toMatchObject({
      role: "user",
      content: expect.stringContaining("## Agent response\nroutine heartbeat ok"),
    });
    expect(provider.options[1]).toMatchObject({
      model: "fixture-model",
      maxTokens: 256,
      temperature: 0,
      toolChoice: { type: "function", function: { name: "evaluate_notification" } },
    });
    expect(events).not.toContainEqual(expect.objectContaining({ event: "cron.delivery" }));
  });

  test("runs dream system cron jobs through the dream bridge", async () => {
    const provider = new QueueProvider([]);
    const dreamBridge = {
      runDream: vi.fn(async () => ({ content: "Dream applied 1 provider memory note operation.", metadata: { changed: true } })),
      getDreamLog: vi.fn(),
      restoreDream: vi.fn(),
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => {},
      dreamBridge,
    });

    const response = await worker.handleRequest(cronRunDueRequest({
      model: "fixture-model",
      jobs: [
        {
          id: "dream",
          name: "dream",
          enabled: true,
          payload: { kind: "system_event", message: "dream" },
        },
      ],
    }));

    expect(response).toMatchObject({
      result: {
        records: [
          expect.objectContaining({
            jobId: "dream",
            status: "ok",
            runId: "cron-dream-cron-run-due-1",
            finalContent: "Dream applied 1 provider memory note operation.",
            dreamMetadata: { changed: true },
          }),
        ],
      },
    });
    expect(dreamBridge.runDream).toHaveBeenCalledWith({
      traceId: "trace-cron-run-due",
      sessionId: "cron:dream",
    });
    expect(provider.messages).toEqual([]);
  });

  test("reports skipped and failed cron job records without aborting the due batch", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => {},
    });

    const response = await worker.handleRequest(cronRunDueRequest({
      model: "fixture-model",
      jobs: [
        {
          id: "disabled",
          name: "Disabled",
          enabled: false,
          payload: { kind: "agent_turn", message: "Skip me" },
        },
        {
          id: "system",
          name: "Dream",
          enabled: true,
          payload: { kind: "system_event", message: "dream" },
        },
        {
          id: "failing",
          name: "Failing",
          enabled: true,
          payload: { kind: "agent_turn", message: "Run me" },
        },
      ],
    }));

    expect(response).toMatchObject({
      result: {
        records: [
          expect.objectContaining({ jobId: "disabled", status: "skipped", error: "job is disabled" }),
          expect.objectContaining({ jobId: "system", status: "skipped", error: expect.stringContaining("system_event") }),
          expect.objectContaining({ jobId: "failing", status: "error", runId: "cron-failing-cron-run-due-1", error: "no queued model response" }),
        ],
      },
    });
  });

  test("handles backend slash help before calling the provider", async () => {
    const events: WorkerEvent[] = [];
    const provider = new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "  /HELP  " }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(provider.messages).toEqual([]);
    expect(response).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: {
        finalContent: expect.stringContaining("/help"),
        stopReason: "command",
        metadata: {
          command: "/help",
          render_as: "text",
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.done",
      payload: expect.objectContaining({ runId: "run-1", stopReason: "command" }),
    }));
  });

  test("preserves inbound message metadata on backend slash command results like Python", async () => {
    const provider = new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-command-metadata",
          messages: [
            {
              role: "user",
              content: "/help",
              metadata: {
                message_id: "msg-1",
                correlation_id: "corr-1",
                render_as: "markdown",
              },
            },
          ],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(provider.messages).toEqual([]);
    expect(response).toMatchObject({
      result: {
        stopReason: "command",
        metadata: {
          message_id: "msg-1",
          correlation_id: "corr-1",
          command: "/help",
          render_as: "text",
        },
      },
    });
  });

  test("handles backend slash stop as a priority command for the current session", async () => {
    const events: WorkerEvent[] = [];
    const completion = deferred<ModelResponse>();
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return completion.promise;
        }
        throw new Error("slash stop reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const runResponsePromise = worker.handleRequest(
      request({
        spec: {
          runId: "run-active-1",
          sessionId: "session-1",
          messages: [{ role: "user", content: "keep working" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    const stopResponse = await worker.handleRequest(
      request({
        spec: {
          runId: "run-stop-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/stop" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );
    completion.resolve({ content: "late answer", toolCalls: [], stopReason: "stop" });
    const runResponse = await runResponsePromise;

    expect(providerCalls).toBe(1);
    expect(stopResponse).toMatchObject({
      result: {
        finalContent: "Stopped 1 task(s).",
        stopReason: "command",
        metadata: {
          command: "/stop",
          render_as: "text",
          cancelled_count: 1,
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.cancelled",
      payload: expect.objectContaining({ runId: "run-active-1" }),
    }));
    expect(runResponse.result).toMatchObject({
      finalContent: "",
      stopReason: "cancelled",
      error: "cancelled",
    });
  });

  test("handles backend slash status without calling the provider", async () => {
    const completion = deferred<ModelResponse>();
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return completion.promise;
        }
        throw new Error("slash status reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    const runResponsePromise = worker.handleRequest(
      request({
        spec: {
          runId: "run-active-1",
          sessionId: "session-1",
          messages: [{ role: "user", content: "keep working" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    const statusResponse = await worker.handleRequest(
      request({
        spec: {
          runId: "run-status-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/status" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );
    completion.resolve({ content: "done", toolCalls: [], stopReason: "stop" });
    await runResponsePromise;

    expect(providerCalls).toBe(1);
    expect(statusResponse).toMatchObject({
      result: {
        finalContent: expect.stringContaining("Active runs: 1"),
        stopReason: "command",
        metadata: {
          command: "/status",
          render_as: "text",
          active_run_count: 1,
          active_session_run_count: 1,
        },
      },
    });
  });

  test("reports last run usage and context in backend slash status", async () => {
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        return {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cachedTokens: 60,
          },
        };
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-usage-source",
          sessionId: "session-1",
          messages: [
            { role: "system", content: "system context" },
            { role: "user", content: "hello" },
          ],
          model: "status-model",
          contextWindow: 8192,
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    const statusResponse = await worker.handleRequest(
      request({
        spec: {
          runId: "run-status-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/status" }],
          model: "status-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(providerCalls).toBe(1);
    expect(statusResponse).toMatchObject({
      result: {
        finalContent: expect.stringContaining("Model: status-model"),
        stopReason: "command",
        metadata: {
          command: "/status",
          render_as: "text",
          active_run_count: 0,
          active_session_run_count: 0,
        },
      },
    });
    expect(statusResponse.result?.finalContent).toContain("Tokens: 120 in / 30 out (50% cached)");
    expect(statusResponse.result?.finalContent).toContain("Context: 120/8k (1%)");
    expect(statusResponse.result?.finalContent).toContain("Session: 2 messages");
  });

  test("handles backend slash restart through the native restart bridge", async () => {
    const restartRequests: Array<{ traceId: string; runId?: string; sessionId?: string }> = [];
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        throw new Error("slash restart reached provider");
      },
    };
    const workerOptions = {
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      requestRestart: async (request: { traceId: string; runId?: string; sessionId?: string }) => {
        restartRequests.push(request);
      },
    };
    const worker = new AgentWorker(workerOptions);

    const restartResponse = await worker.handleRequest(
      request({
        spec: {
          runId: "run-restart-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: " /restart " }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(providerCalls).toBe(0);
    expect(restartRequests).toEqual([{ traceId: "trace-1", runId: "run-restart-command", sessionId: "session-1" }]);
    expect(restartResponse).toMatchObject({
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

  test("handles backend slash new by clearing the current session", async () => {
    const clearCalls: Array<{ sessionId: string; traceId: string }> = [];
    const temporaryFileClearCalls: Array<{ sessionId: string; traceId: string }> = [];
    const archiveCalls: Array<{ sessionId: string; traceId: string; messages: Array<{ role: string; content: string }>; startIndex: number }> = [];
    const operationOrder: string[] = [];
    let providerCalls = 0;
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        throw new Error("slash new reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async () => undefined,
        getCheckpoint: async () => null,
        getSessionMessages: async (sessionId: string, traceId: string) => {
          operationOrder.push("archive-snapshot");
          expect({ sessionId, traceId }).toEqual({ sessionId: "session-1", traceId: "trace-1" });
          return {
            sessionId,
            messages: [
              { role: "system", content: "runtime context" },
              { role: "user", content: "Remember native preferences" },
              { role: "assistant", content: "Noted." },
              { role: "tool", content: "side effect" },
            ],
          };
        },
        clearSession: async (sessionId, traceId) => {
          operationOrder.push("clear-session");
          clearCalls.push({ sessionId, traceId });
          return { sessionId, messagesBefore: 3, messagesAfter: 0, checkpointCleared: true };
        },
        clearTemporaryFiles: async (sessionId, traceId) => {
          operationOrder.push("clear-temporary-files");
          temporaryFileClearCalls.push({ sessionId, traceId });
          return { cleared: 2 };
        },
      },
      memoryBridge: {
        captureEvidence: async (sessionId, request, traceId) => {
          operationOrder.push("capture-evidence");
          archiveCalls.push({
            sessionId,
            traceId,
            messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
            startIndex: request.startIndex,
          });
          return { evidence: [{ id: "ev-1" }, { id: "ev-2" }] };
        },
      },
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-new-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/new" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(providerCalls).toBe(0);
    expect(operationOrder).toEqual(["archive-snapshot", "capture-evidence", "clear-session", "clear-temporary-files"]);
    expect(archiveCalls).toEqual([{
      sessionId: "session-1",
      traceId: "trace-1",
      messages: [
        { role: "user", content: "Remember native preferences" },
        { role: "assistant", content: "Noted." },
      ],
      startIndex: 0,
    }]);
    expect(clearCalls).toEqual([{ sessionId: "session-1", traceId: "trace-1" }]);
    expect(temporaryFileClearCalls).toEqual([{ sessionId: "session-1", traceId: "trace-1" }]);
    expect(response).toMatchObject({
      result: {
        finalContent: "New session started.",
        stopReason: "command",
        metadata: {
          command: "/new",
          render_as: "text",
          session_id: "session-1",
          messages_before: 3,
          messages_after: 0,
          checkpoint_cleared: true,
          temporary_files_cleared: 2,
          memory_archive_evidence_count: 2,
          memory_archive_message_count: 2,
        },
      },
    });
  });

  test("handles backend slash approvals by listing pending approvals", async () => {
    let providerCalls = 0;
    const listCalls: Array<{ sessionId: string; traceId: string }> = [];
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        throw new Error("slash approvals reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      approvalBridge: {
        requestApproval: async () => ({}),
        resolveApproval: async () => ({}),
        listPendingApprovals: async (sessionId: string, traceId: string) => {
          listCalls.push({ sessionId, traceId });
          return {
            approvals: [
              {
                id: "approval-1",
                summary: "write_file path=\"notes.md\"",
                risk: "medium",
                category: "filesystem_write",
                reason: "File write/edit/delete tools can modify workspace state.",
              },
            ],
          };
        },
      } as any,
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-approvals-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/approvals" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(providerCalls).toBe(0);
    expect(listCalls).toEqual([{ sessionId: "session-1", traceId: "trace-1" }]);
    expect(response).toMatchObject({
      result: {
        finalContent: expect.stringContaining("## Pending Approvals"),
        stopReason: "command",
        metadata: {
          command: "/approvals",
          render_as: "text",
          pending_count: 1,
        },
      },
    });
    expect(response.result?.finalContent).toContain("`approval-1` write_file path=\"notes.md\"");
    expect(response.result?.finalContent).toContain("Approve once: `/approve <id> once`");
  });

  test("handles backend slash approve by resolving a pending approval", async () => {
    let providerCalls = 0;
    const resolveCalls: Array<{ sessionId: string; approvalId: string; approved: boolean; scope?: string; traceId: string }> = [];
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        throw new Error("slash approve reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      approvalBridge: {
        requestApproval: async () => ({}),
        listPendingApprovals: async () => ({ approvals: [] }),
        resolveApproval: async (params, traceId) => {
          resolveCalls.push({ ...params, traceId });
          return {
            id: params.approvalId,
            summary: "write_file path=\"notes.md\"",
            decision: "allow",
            scope: params.scope,
          };
        },
      },
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-approve-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/approve approval-1 session" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(providerCalls).toBe(0);
    expect(resolveCalls).toEqual([
      {
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: true,
        scope: "session",
        traceId: "trace-1",
      },
    ]);
    expect(response).toMatchObject({
      result: {
        finalContent: "Approved `approval-1` for this session: write_file path=\"notes.md\"\n\nMatching operations in this session will not ask again. Retrying now.",
        stopReason: "command",
        metadata: {
          command: "/approve",
          render_as: "text",
          approval_id: "approval-1",
          approved: true,
          scope: "session",
        },
      },
    });
  });

  test("resumes approved checkpoint after backend slash approve command", async () => {
    const events: WorkerEvent[] = [];
    const writtenFiles: Array<Record<string, unknown>> = [];
    const appendedMessages: AgentMessage[][] = [];
    const clearedSessions: string[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "Write a file",
      parameters: { type: "object" },
      execute: async (args) => {
        writtenFiles.push(args);
        return { content: `wrote ${String(args.path)}` };
      },
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "file written", toolCalls: [], stopReason: "stop" }]),
      tools,
      emitEvent: (event) => {
        events.push(event);
      },
      approvalBridge: {
        requestApproval: async () => ({}),
        listPendingApprovals: async () => ({ approvals: [] }),
        resolveApproval: async (params) => ({
          approvalId: params.approvalId,
          approved: params.approved,
          scope: params.scope,
          summary: "write_file path=\"notes/today.md\"",
          status: "approved",
        }),
      },
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-awaiting-approval",
          phase: "tools_completed",
          model: "test-model",
          iteration: 1,
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
          assistantMessage: {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "approval-call-1", name: "request_approval", argumentsJson: "{}" }],
          },
          completedToolResults: [
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
          pendingToolCalls: [],
        }),
      },
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-approve-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/approve approval-1 once" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({
        event: "agent.done",
        payload: expect.objectContaining({ runId: "run-awaiting-approval" }),
      }));
    });

    expect(response).toMatchObject({
      result: {
        stopReason: "command",
        metadata: {
          command: "/approve",
          approval_id: "approval-1",
          retry_scheduled: true,
        },
      },
    });
    expect(writtenFiles).toEqual([{ path: "notes/today.md", contents: "hello" }]);
    expect(appendedMessages.at(-1)).toContainEqual({
      role: "tool",
      content: "wrote notes/today.md",
      toolCallId: "approval-call-1",
      name: "request_approval",
    });
    expect(clearedSessions).toEqual(["session-1"]);
  });

  test("handles backend slash deny by resolving a pending approval", async () => {
    let providerCalls = 0;
    const resolveCalls: Array<{ sessionId: string; approvalId: string; approved: boolean; scope?: string; traceId: string }> = [];
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        throw new Error("slash deny reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      approvalBridge: {
        requestApproval: async () => ({}),
        listPendingApprovals: async () => ({ approvals: [] }),
        resolveApproval: async (params, traceId) => {
          resolveCalls.push({ ...params, traceId });
          return {
            id: params.approvalId,
            summary: "write_file path=\"notes.md\"",
            decision: "deny",
          };
        },
      },
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-deny-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/deny approval-1" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(providerCalls).toBe(0);
    expect(resolveCalls).toEqual([
      {
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: false,
        traceId: "trace-1",
      },
    ]);
    expect(response).toMatchObject({
      result: {
        finalContent: "Denied `approval-1`: write_file path=\"notes.md\"",
        stopReason: "command",
        metadata: {
          command: "/deny",
          render_as: "text",
          approval_id: "approval-1",
          approved: false,
        },
      },
    });
  });

  test("handles backend slash dream log through the dream bridge", async () => {
    let providerCalls = 0;
    const calls: Array<{ traceId: string; sessionId?: string; sha?: string }> = [];
    const provider: ModelProvider = {
      complete: async () => {
        providerCalls += 1;
        throw new Error("slash dream log reached provider");
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      dreamBridge: {
        runDream: async () => ({ content: "unused" }),
        getDreamLog: async (request) => {
          calls.push(request);
          return { content: "## Dream Update\n\n- Commit: `abc123`" };
        },
        restoreDream: async () => ({ content: "unused" }),
      },
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-dream-log-command",
          sessionId: "session-1",
          messages: [{ role: "user", content: "/dream-log abc123" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(providerCalls).toBe(0);
    expect(calls).toEqual([{ traceId: "trace-1", sessionId: "session-1", sha: "abc123" }]);
    expect(response).toMatchObject({
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

  test("routes skills WebUI list and detail requests through the skills bridge", async () => {
    const calls: Array<{ type: string; traceId: string; name?: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      skillsBridge: {
        listWebuiSkills: async (traceId) => {
          calls.push({ type: "list", traceId });
          return { skills: [{ name: "planner", available: true }] };
        },
        getWebuiSkillDetail: async (name, traceId) => {
          calls.push({ type: "detail", traceId, name });
          return { name, content: "Plan." };
        },
      },
    });

    await expect(worker.handleRequest(skillsWebuiListRequest())).resolves.toMatchObject({
      id: "skills-list-1",
      trace_id: "trace-skills-list",
      result: { skills: [{ name: "planner", available: true }] },
    });
    await expect(worker.handleRequest(skillsWebuiDetailRequest({ name: "planner" }))).resolves.toMatchObject({
      id: "skills-detail-1",
      trace_id: "trace-skills-detail",
      result: { name: "planner", content: "Plan." },
    });
    expect(calls).toEqual([
      { type: "list", traceId: "trace-skills-list" },
      { type: "detail", traceId: "trace-skills-detail", name: "planner" },
    ]);
  });

  test("routes skills WebUI mutations through the skills bridge", async () => {
    const calls: Array<{ type: string; traceId: string; name?: string; body?: unknown }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "unused", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      skillsBridge: {
        listWebuiSkills: async () => ({}),
        getWebuiSkillDetail: async () => ({}),
        createWebuiSkill: async (body, traceId) => {
          calls.push({ type: "create", traceId, body });
          return { created: true, name: "planner" };
        },
        updateWebuiSkill: async (name, body, traceId) => {
          calls.push({ type: "update", traceId, name, body });
          return { updated: true, name };
        },
        deleteWebuiSkill: async (name, traceId) => {
          calls.push({ type: "delete", traceId, name });
          return { deleted: true, name };
        },
        validateWebuiSkill: async (name, traceId) => {
          calls.push({ type: "validate", traceId, name });
          return { name, valid: true, message: "Skill is valid" };
        },
      },
    });

    await expect(worker.handleRequest(skillsWebuiMutationRequest("skills.webui_create", {
      body: { name: "Planner", content: "Plan." },
    }))).resolves.toMatchObject({ result: { created: true, name: "planner" } });
    await expect(worker.handleRequest(skillsWebuiMutationRequest("skills.webui_update", {
      name: "planner",
      body: { content: "Updated." },
    }))).resolves.toMatchObject({ result: { updated: true, name: "planner" } });
    await expect(worker.handleRequest(skillsWebuiMutationRequest("skills.webui_delete", {
      name: "planner",
    }))).resolves.toMatchObject({ result: { deleted: true, name: "planner" } });
    await expect(worker.handleRequest(skillsWebuiMutationRequest("skills.webui_validate", {
      name: "planner",
    }))).resolves.toMatchObject({ result: { name: "planner", valid: true } });
    expect(calls).toEqual([
      { type: "create", traceId: "trace-skills.webui_create", body: { name: "Planner", content: "Plan." } },
      { type: "update", traceId: "trace-skills.webui_update", name: "planner", body: { content: "Updated." } },
      { type: "delete", traceId: "trace-skills.webui_delete", name: "planner" },
      { type: "validate", traceId: "trace-skills.webui_validate", name: "planner" },
    ]);
  });

  test("routes agent.run_input through context assembly before AgentRunner", async () => {
    const events: WorkerEvent[] = [];
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const loadedInputs: Array<{ runId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
      contextBridge: {
        loadContextInput: async (input, traceId) => {
          loadedInputs.push({ runId: input.runId, traceId });
          return {
            input: {
              identity: "Identity",
              currentMessage: input.input.content,
              history: [
                { role: "user", content: "Earlier" },
                { role: "assistant", content: "Earlier answer" },
              ],
              bootstrapFiles: [{ path: "AGENTS.md", contents: "Agent rules" }],
              runtime: {
                currentTime: "2026-06-10 09:00:00 Asia/Shanghai",
                channel: input.channel,
                chatId: input.chatId,
              },
            },
            metadata: {
              missingSession: false,
              malformedHistoryCount: 0,
              missingBootstrapFiles: [],
              bootstrapFallbackUsed: false,
            },
          };
        },
      },
    });

    const response = await worker.handleRequest(
      runInputRequest({
        input: {
          runId: "run-input-1",
          sessionId: "session-1",
          input: { content: "Continue" },
          channel: "desktop",
          chatId: "chat-1",
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(loadedInputs).toEqual([{ runId: "run-input-1", traceId: "trace-run-input" }]);
    expect(provider.messages[0]?.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(provider.messages[0]?.[0].content).toContain("## AGENTS.md\n\nAgent rules");
    expect(provider.messages[0]?.at(-1)?.content).toContain("Current Time: 2026-06-10 09:00:00 Asia/Shanghai");
    expect(response).toMatchObject({
      protocol_version: "1",
      id: "run-input-1",
      trace_id: "trace-run-input",
      result: {
        finalContent: "done",
        stopReason: "final_response",
        contextMetadata: {
          historyMessageCount: 2,
          bootstrapFiles: ["AGENTS.md"],
          bridge: {
            missingSession: false,
            malformedHistoryCount: 0,
            missingBootstrapFiles: [],
            bootstrapFallbackUsed: false,
          },
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-run-input",
      event: "agent.context",
      payload: expect.objectContaining({
        runId: "run-input-1",
        run_id: "run-input-1",
        metadata: expect.objectContaining({
          historyMessageCount: 2,
        }),
      }),
    }));
  });

  test("appends only new run_input messages to session history", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const appendedSessions: Array<{ sessionId: string; messages: AgentMessage[] }> = [];
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async (sessionId, messages) => {
          appendedSessions.push({ sessionId, messages });
        },
        getCheckpoint: async () => null,
      },
      contextBridge: {
        loadContextInput: async (input) => ({
          input: {
            identity: "Identity",
            currentMessage: input.input.content,
            history: [{ role: "user", content: "Earlier" }],
            runtime: { currentTime: "now" },
          },
          metadata: {
            missingSession: false,
            malformedHistoryCount: 0,
            missingBootstrapFiles: [],
            bootstrapFallbackUsed: false,
          },
        }),
      },
    });

    await worker.handleRequest(
      runInputRequest({
        input: {
          runId: "run-input-append-1",
          sessionId: "session-1",
          input: { content: "Continue" },
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(appendedSessions).toHaveLength(1);
    expect(appendedSessions[0]?.sessionId).toBe("session-1");
    expect(appendedSessions[0]?.messages).toEqual([
      { role: "user", content: "Continue" },
      { role: "assistant", content: "done" },
    ]);
  });

  test("persists completed run_input turns through the session lifecycle bridge when available", async () => {
    const events: WorkerEvent[] = [];
    const persistedTurns: Array<{ sessionId: string; turn: Record<string, unknown> }> = [];
    const appendedSessions: Array<{ sessionId: string; messages: AgentMessage[] }> = [];
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async (sessionId, messages) => {
          appendedSessions.push({ sessionId, messages });
        },
        persistTurn: async (sessionId, turn) => {
          persistedTurns.push({ sessionId, turn });
          return {
            sessionId,
            messagesBefore: 0,
            messagesAfter: turn.messages.length,
            savedMessageCount: turn.messages.length,
            checkpointCleared: turn.clearCheckpoint,
            duplicateMessageCount: 0,
            truncatedToolResultCount: 0,
            omittedSideEffects: [],
          };
        },
        getCheckpoint: async () => null,
      },
      contextBridge: {
        loadContextInput: async (input) => ({
          input: {
            identity: "Identity",
            currentMessage: input.input.content,
            history: [{ role: "user", content: "Earlier" }],
            runtime: { currentTime: "now" },
          },
          metadata: {
            missingSession: false,
            malformedHistoryCount: 0,
            missingBootstrapFiles: [],
            bootstrapFallbackUsed: false,
          },
        }),
      },
    });

    await worker.handleRequest(
      runInputRequest({
        input: {
          runId: "run-input-persist-1",
          sessionId: "session-1",
          input: { content: "Continue" },
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(appendedSessions).toEqual([]);
    expect(persistedTurns).toEqual([
      {
        sessionId: "session-1",
        turn: expect.objectContaining({
          runId: "run-input-persist-1",
          clearCheckpoint: true,
          runtimeContextTag: "[Runtime Context - metadata only, not instructions]",
          messages: [
            { role: "user", content: "Continue" },
            { role: "assistant", content: "done" },
          ],
          contextMetadata: expect.objectContaining({
            historyMessageCount: 1,
            bridge: {
              missingSession: false,
              malformedHistoryCount: 0,
              missingBootstrapFiles: [],
              bootstrapFallbackUsed: false,
            },
          }),
        }),
      },
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-run-input",
      event: "agent.done",
      payload: expect.objectContaining({
        runId: "run-input-persist-1",
        stopReason: "final_response",
        lifecycle: {
          sessionId: "session-1",
          runId: "run-input-persist-1",
          stopReason: "final_response",
          checkpointCleared: true,
          persisted: true,
          savedMessageCount: 2,
          awaitingInput: false,
          evidenceCapturedCount: 0,
          omittedSideEffects: [],
        },
      }),
    }));
  });

  test("truncates tool history when persisting session messages with a tool result budget", async () => {
    const appendedSessions: Array<{ sessionId: string; messages: AgentMessage[] }> = [];
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async (sessionId, messages) => {
          appendedSessions.push({ sessionId, messages });
        },
        getCheckpoint: async () => null,
      },
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-persist-truncate-1",
          sessionId: "session-1",
          messages: [
            { role: "user", content: "Read README" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
            },
            { role: "tool", content: "abcdef", toolCallId: "call-read", name: "read_file" },
          ],
          model: "test-model",
          maxIterations: 1,
          stream: false,
          toolResultBudget: 3,
        },
      }),
    );

    expect(appendedSessions[0]?.messages).toContainEqual({
      role: "tool",
      content: "abc\n... (truncated)",
      toolCallId: "call-read",
      name: "read_file",
    });
  });

  test("accepts snake_case agent.run spec fields", async () => {
    const events: WorkerEvent[] = [];
    const clearedSessions: string[] = [];
    const appendedSessions: Array<{ sessionId: string; messages: AgentMessage[] }> = [];
    const provider = new QueueProvider([
      { content: "done", toolCalls: [], stopReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
    ]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async (sessionId, messages) => {
          appendedSessions.push({ sessionId, messages });
        },
        getCheckpoint: async () => null,
      },
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          run_id: "run-snake-1",
          session_id: "session-snake-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          max_iterations: 2,
          stream: false,
          context_window: 100,
          tool_result_budget: 12,
          temperature: 0.2,
          max_tokens: 2048,
          reasoning_effort: "medium",
          fail_on_tool_error: true,
        },
      }),
    );

    expect(response).toMatchObject({
      protocol_version: "1",
      id: "req-1",
      trace_id: "trace-1",
      result: {
        finalContent: "done",
        stopReason: "final_response",
      },
    });
    expect(events).toContainEqual({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.usage",
      payload: expect.objectContaining({
        runId: "run-snake-1",
        contextWindowTokens: 100,
      }),
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.done",
      payload: expect.objectContaining({
        runId: "run-snake-1",
        stopReason: "final_response",
      }),
    }));
    expect(clearedSessions).toEqual(["session-snake-1"]);
    expect(appendedSessions[0]?.sessionId).toBe("session-snake-1");
    expect(provider.options[0]).toMatchObject({
      temperature: 0.2,
      maxTokens: 2048,
      reasoningEffort: "medium",
    });
  });

  test("accepts snake_case reasoning content on agent.run messages", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "previous", reasoning_content: "prior reasoning" },
            { role: "user", content: "continue" },
          ],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(provider.messages[0]?.[1]).toMatchObject({
      role: "assistant",
      content: "previous",
      reasoningContent: "prior reasoning",
    });
  });

  test("accepts snake_case thinking blocks on agent.run messages", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });
    const thinkingBlocks = [{ type: "thinking", text: "prior trace" }];

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "previous", thinking_blocks: thinkingBlocks },
            { role: "user", content: "continue" },
          ],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(provider.messages[0]?.[1]).toMatchObject({
      role: "assistant",
      content: "previous",
      thinkingBlocks,
    });
  });

  test("parses run spec tool definitions for the provider request", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
          tools: [
            {
              name: "read_file",
              description: "Read a workspace file",
              parameters: { type: "object", properties: { path: { type: "string" } } },
            },
          ],
        },
      }),
    );

    expect(provider.options[0]?.tools).toEqual([
      {
        name: "read_file",
        description: "Read a workspace file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
  });

  test("normalizes native snake_case tool history in run specs before provider requests", async () => {
    const provider = new QueueProvider([{ content: "continued", toolCalls: [], stopReason: "stop" }]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [
            { role: "user", content: "Read README" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call-read",
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
              tool_call_id: "call-read",
              name: "read_file",
            },
          ],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(provider.messages[0]).toEqual([
      { role: "user", content: "Read README" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-read", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        toolCallId: undefined,
        name: undefined,
        metadata: undefined,
      },
      {
        role: "tool",
        content: "README contents",
        toolCallId: "call-read",
        name: "read_file",
        toolCalls: undefined,
        metadata: undefined,
      },
    ]);
  });

  test("emits usage protocol event when the run returns token usage", async () => {
    const events: WorkerEvent[] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12, cachedTokens: 3 },
        },
      ]),
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(response).toMatchObject({
      result: {
        usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12, cachedTokens: 3 },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.usage",
      payload: expect.objectContaining({
        runId: "run-1",
        usage: {
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
          cachedTokens: 3,
          prompt_tokens: 7,
          completion_tokens: 5,
          total_tokens: 12,
          cached_tokens: 3,
        },
      }),
    }));
  });

  test("emits runner context usage protocol events with native aliases", async () => {
    const events: WorkerEvent[] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
        },
      ]),
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
          contextWindow: 100,
        },
      }),
    );

    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.usage",
      payload: expect.objectContaining({
        runId: "run-1",
        run_id: "run-1",
        phase: "before_request",
        iteration: 0,
        source: "heuristic",
        tokens: expect.any(Number),
        budget: 100,
        messageCount: 1,
        message_count: 1,
        estimated: true,
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.usage",
      payload: expect.objectContaining({
        runId: "run-1",
        run_id: "run-1",
        phase: "after_response",
        iteration: 0,
        source: "provider_usage",
        tokens: 7,
        estimated: false,
      }),
    }));
  });

  test("emits native snake_case context window on usage events", async () => {
    const events: WorkerEvent[] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "done",
          toolCalls: [],
          stopReason: "stop",
          usage: { inputTokens: 7, outputTokens: 5, totalTokens: 12 },
        },
      ]),
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
          contextWindow: 100,
        },
      }),
    );

    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.usage",
      payload: expect.objectContaining({
        runId: "run-1",
        usage: expect.objectContaining({
          inputTokens: 7,
          outputTokens: 5,
          totalTokens: 12,
          prompt_tokens: 7,
          completion_tokens: 5,
          total_tokens: 12,
        }),
        contextWindowTokens: 100,
        context_window_tokens: 100,
      }),
    }));
  });

  test("includes run id on agent.error events from failed runs", async () => {
    const events: WorkerEvent[] = [];
    const worker = new AgentWorker({
      provider: {
        complete: async () => {
          throw new Error("provider unavailable");
        },
      },
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(response).toMatchObject({
      error: { message: "provider unavailable" },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.error",
      payload: expect.objectContaining({ runId: "run-1", message: "provider unavailable" }),
    }));
  });

  test("forwards runner tool events and checkpoints as protocol events", async () => {
    const events: WorkerEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object" },
      execute: async (args) => ({ content: `echo:${String(args.text)}` }),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "",
          toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"from tool\"}" }],
          stopReason: "tool_calls",
        },
        { content: "done", toolCalls: [], stopReason: "stop" },
      ]),
      tools,
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    const lifecycleEvents = events.filter((event) => event.event !== "agent.usage");
    expect(lifecycleEvents.map((event) => event.event)).toEqual([
      "agent.checkpoint",
      "agent.tool.start",
      "agent.tool.result",
      "agent.checkpoint",
      "agent.checkpoint",
      "agent.done",
    ]);
    expect(lifecycleEvents[1]).toMatchObject({
      event: "agent.tool.start",
      payload: { runId: "run-1", toolCallId: "call-1", toolName: "echo" },
    });
    expect(lifecycleEvents[2]).toMatchObject({
      event: "agent.tool.result",
      payload: { runId: "run-1", toolCallId: "call-1", toolName: "echo", content: "echo:from tool" },
    });
    expect(lifecycleEvents[0]).toMatchObject({
      event: "agent.checkpoint",
      payload: {
        runId: "run-1",
        run_id: "run-1",
        phase: "awaiting_tools",
        assistant_message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: {
                name: "echo",
                arguments: "{\"text\":\"from tool\"}",
              },
            },
          ],
        },
        pendingToolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"from tool\"}" }],
        pending_tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: {
              name: "echo",
              arguments: "{\"text\":\"from tool\"}",
            },
          },
        ],
        completedToolResults: [],
        completed_tool_results: [],
      },
    });
  });

  test("emits snake_case aliases for native lifecycle event payloads", async () => {
    const events: WorkerEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object" },
      execute: async (args) => ({ content: `echo:${String(args.text)}` }),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "",
          toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"from tool\"}" }],
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          stopReason: "tool_calls",
        },
        {
          content: "done",
          toolCalls: [],
          usage: { inputTokens: 4, outputTokens: 6, totalTokens: 10 },
          stopReason: "stop",
        },
      ]),
      tools,
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.tool.start",
      payload: expect.objectContaining({
        runId: "run-1",
        run_id: "run-1",
        toolCallId: "call-1",
        tool_call_id: "call-1",
        toolName: "echo",
        tool_name: "echo",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.tool.result",
      payload: expect.objectContaining({
        runId: "run-1",
        run_id: "run-1",
        toolCallId: "call-1",
        tool_call_id: "call-1",
        toolName: "echo",
        tool_name: "echo",
        content: "echo:from tool",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.usage",
      payload: expect.objectContaining({
        runId: "run-1",
        run_id: "run-1",
        usage: expect.objectContaining({
          inputTokens: 6,
          outputTokens: 9,
          totalTokens: 15,
          prompt_tokens: 6,
          completion_tokens: 9,
          total_tokens: 15,
        }),
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      event: "agent.done",
      payload: {
        runId: "run-1",
        run_id: "run-1",
        stopReason: "final_response",
        stop_reason: "final_response",
      },
    }));
  });

  test("forwards memory reference tool metadata as protocol events", async () => {
    const events: WorkerEvent[] = [];
    const memoryReferences = [
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
    ];
    const tools = new ToolRegistry();
    tools.register({
      name: "search_memory_notes",
      description: "Search memory",
      parameters: { type: "object" },
      execute: async () => ({
        content: "## Memory Notes\n- [mem_1] user/preference/active\n  User prefers concise implementation handoffs.",
        metadata: { _memory_references: memoryReferences },
      }),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "",
          toolCalls: [{ id: "call-1", name: "search_memory_notes", argumentsJson: "{\"query\":\"handoff\"}" }],
          stopReason: "tool_calls",
        },
        { content: "done", toolCalls: [], stopReason: "stop" },
      ]),
      tools,
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "recall memory" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.memory_reference",
      payload: expect.objectContaining({
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "search_memory_notes",
        references: memoryReferences,
      }),
    }));
  });

  test("forwards task progress tool metadata as protocol events", async () => {
    const events: WorkerEvent[] = [];
    const tools = new ToolRegistry();
    const taskProgress = {
      plan_id: "plan-1",
      progress: { completed: 1, total: 3, pending: 2 },
      subtasks: [{ id: "draft", title: "Draft answer", status: "completed" }],
    };
    tools.register({
      name: "task",
      description: "Task status",
      parameters: { type: "object" },
      execute: async () => ({
        content: "Task progress updated.",
        metadata: {
          _task_event: true,
          _task_plan_id: "plan-1",
          _task_progress: taskProgress,
        },
      }),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "",
          toolCalls: [{ id: "call-1", name: "task", argumentsJson: "{\"action\":\"status\"}" }],
          stopReason: "tool_calls",
        },
        { content: "done", toolCalls: [], stopReason: "stop" },
      ]),
      tools,
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "check task" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.task_progress",
      payload: expect.objectContaining({
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "task",
        planId: "plan-1",
        progress: taskProgress,
      }),
    }));
  });

  test("forwards provider retry wait callbacks as protocol events", async () => {
    const events: WorkerEvent[] = [];
    const provider = new QueueProvider([
      { content: "done", toolCalls: [], stopReason: "stop" },
    ]);
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
          provider_retry_mode: "persistent",
        },
      }),
    );

    expect(provider.options[0]).toMatchObject({ retryMode: "persistent" });
    provider.options[0]?.onRetryWait?.({ attempt: 1, delaySeconds: 3, message: "rate limit" });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.provider_retry",
      payload: expect.objectContaining({
        runId: "run-1",
        run_id: "run-1",
        attempt: 1,
        delaySeconds: 3,
        delay_seconds: 3,
        message: "rate limit",
      }),
    }));
  });

  test("emits awaiting form event when a tool pauses for user input", async () => {
    const events: WorkerEvent[] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "request_form",
      description: "Request structured user input",
      parameters: { type: "object" },
      execute: async () => ({
        content: "Waiting for form submission.",
        metadata: {
          awaitingUserInput: true,
          stopReason: "awaiting_form",
          formId: "form-1",
        },
      }),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "",
          toolCalls: [{ id: "call-1", name: "request_form", argumentsJson: "{}" }],
          stopReason: "tool_calls",
        },
      ]),
      tools,
      emitEvent: (event) => events.push(event),
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "collect details" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(response.result).toMatchObject({
      finalContent: "",
      stopReason: "awaiting_form",
      toolsUsed: ["request_form"],
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.awaiting_form",
      payload: expect.objectContaining({
        runId: "run-1",
        stopReason: "awaiting_form",
        formId: "form-1",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.done",
      payload: expect.objectContaining({ runId: "run-1", stopReason: "awaiting_form" }),
    }));
  });

  test("keeps the session checkpoint when a run pauses for user input", async () => {
    const checkpointWrites: Record<string, unknown>[] = [];
    const clearedSessions: string[] = [];
    const appendedMessages: AgentMessage[][] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "request_approval",
      description: "Request approval",
      parameters: { type: "object" },
      execute: async () => ({
        content: "Waiting for approval.",
        metadata: {
          awaitingUserInput: true,
          stopReason: "awaiting_approval",
          approvalId: "approval-1",
        },
      }),
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([
        {
          content: "",
          toolCalls: [{ id: "call-1", name: "request_approval", argumentsJson: "{}" }],
          stopReason: "tool_calls",
        },
      ]),
      tools,
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async (_sessionId, checkpoint) => {
          checkpointWrites.push(checkpoint);
        },
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async () => null,
      },
    });

    const response = await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          sessionId: "session-1",
          messages: [{ role: "user", content: "write a file" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    expect(response.result).toMatchObject({ stopReason: "awaiting_approval" });
    expect(checkpointWrites.at(-1)).toMatchObject({
      runId: "run-1",
      phase: "tools_completed",
      completedToolResults: [
        expect.objectContaining({
          role: "tool",
          name: "request_approval",
          metadata: expect.objectContaining({ stopReason: "awaiting_approval" }),
        }),
      ],
    });
    expect(clearedSessions).toEqual([]);
    expect(appendedMessages).toHaveLength(1);
  });

  test("forwards provider streaming callbacks as protocol events", async () => {
    const events: WorkerEvent[] = [];
    const provider: ModelProvider = {
      complete: async (_messages, callbacks) => {
        callbacks?.onContentDelta?.("content");
        callbacks?.onReasoningDelta?.("reasoning");
        callbacks?.onToolCallDelta?.({
          index: 0,
          deltaText: "{\"query\"",
          toolCallId: "call-1",
          toolName: "search",
        });
        return { content: "done", toolCalls: [], stopReason: "stop" };
      },
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: true,
        },
      }),
    );

    const streamEvents = events.filter((event) => (
      event.event === "agent.delta"
      || event.event === "agent.reasoning_delta"
      || event.event === "agent.tool_call.delta"
    ));
    expect(streamEvents).toMatchObject([
      {
        protocol_version: "1",
        trace_id: "trace-1",
        event: "agent.delta",
        payload: { runId: "run-1", delta: "content" },
      },
      {
        protocol_version: "1",
        trace_id: "trace-1",
        event: "agent.reasoning_delta",
        payload: { runId: "run-1", delta: "reasoning" },
      },
      {
        protocol_version: "1",
        trace_id: "trace-1",
        event: "agent.tool_call.delta",
        payload: {
          runId: "run-1",
          index: 0,
          deltaText: "{\"query\"",
          toolCallId: "call-1",
          toolName: "search",
        },
      },
    ]);
  });

  test("cancels an active agent.run by runId", async () => {
    const events: WorkerEvent[] = [];
    const completion = deferred<ModelResponse>();
    const provider: ModelProvider = {
      complete: async () => completion.promise,
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    const runResponsePromise = worker.handleRequest(
      request({
        spec: {
          runId: "run-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    const cancelResponse = await worker.handleRequest(cancelRequest("run-1"));
    completion.resolve({ content: "late answer", toolCalls: [], stopReason: "stop" });
    const runResponse = await runResponsePromise;

    expect(cancelResponse).toMatchObject({
      protocol_version: "1",
      id: "cancel-1",
      trace_id: "trace-cancel",
      result: { ok: true, runId: "run-1" },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.cancelled",
      payload: expect.objectContaining({ runId: "run-1" }),
    }));
    expect(runResponse.result).toMatchObject({
      finalContent: "",
      stopReason: "cancelled",
      error: "cancelled",
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.done",
      payload: expect.objectContaining({ runId: "run-1", stopReason: "cancelled" }),
    }));
  });

  test("accepts snake_case run_id for agent.cancel", async () => {
    const completion = deferred<ModelResponse>();
    const provider: ModelProvider = {
      complete: async () => completion.promise,
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
    });

    const runResponsePromise = worker.handleRequest(
      request({
        spec: {
          runId: "run-snake-1",
          messages: [{ role: "user", content: "hello" }],
          model: "test-model",
          maxIterations: 2,
          stream: false,
        },
      }),
    );

    const cancelResponse = await worker.handleRequest(snakeCancelRequest("run-snake-1"));
    completion.resolve({ content: "late answer", toolCalls: [], stopReason: "stop" });
    await runResponsePromise;

    expect(cancelResponse).toMatchObject({
      protocol_version: "1",
      id: "cancel-snake-1",
      trace_id: "trace-cancel-snake",
      result: { ok: true, runId: "run-snake-1" },
    });
  });

  test("restores checkpoint state for a session through the session bridge", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async () => undefined,
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-1",
          phase: "awaiting_tools",
          iteration: 1,
          model: "test-model",
          pendingToolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
        }),
      },
    });

    const response = await worker.handleRequest(restoreCheckpointRequest("session-1"));

    expect(response).toMatchObject({
      protocol_version: "1",
      id: "restore-1",
      trace_id: "trace-restore",
      result: {
        sessionId: "session-1",
        session_id: "session-1",
        restoredMessageCount: 1,
        restored_message_count: 1,
        checkpoint: {
          runId: "run-1",
          phase: "awaiting_tools",
          iteration: 1,
          model: "test-model",
          pendingToolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
        },
      },
    });
  });

  test("materializes restored checkpoint messages and clears the checkpoint", async () => {
    const appended: Array<{ sessionId: string; messages: AgentMessage[]; traceId: string }> = [];
    const cleared: Array<{ sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
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
            toolCalls: [
              { id: "call-pending", name: "echo", argumentsJson: "{\"text\":\"pending\"}" },
            ],
          },
          completedToolResults: [
            { role: "tool", content: "finished", toolCallId: "call-done", name: "done_tool" },
          ],
          pendingToolCalls: [
            { id: "call-pending", name: "echo", argumentsJson: "{\"text\":\"pending\"}" },
          ],
        }),
      },
    });

    const response = await worker.handleRequest(restoreCheckpointRequest("session-1"));

    expect(response.result).toMatchObject({ restored: true });
    expect(appended).toEqual([
      {
        sessionId: "session-1",
        traceId: "trace-restore",
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call-pending", name: "echo", argumentsJson: "{\"text\":\"pending\"}" }],
          },
          { role: "tool", content: "finished", toolCallId: "call-done", name: "done_tool" },
          {
            role: "tool",
            content: "Error: Task interrupted before this tool finished.",
            toolCallId: "call-pending",
            name: "echo",
          },
        ],
      },
    ]);
    expect(cleared).toEqual([{ sessionId: "session-1", traceId: "trace-restore" }]);
  });

  test("keeps awaiting-input checkpoint after restore without re-appending pending transcript", async () => {
    const appended: Array<{ sessionId: string; messages: AgentMessage[]; traceId: string }> = [];
    const cleared: Array<{ sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId, traceId) => {
          cleared.push({ sessionId, traceId });
        },
        appendMessages: async (sessionId, messages, traceId) => {
          appended.push({ sessionId, messages, traceId });
        },
        getCheckpoint: async () => ({
          runId: "run-1",
          phase: "tools_completed",
          iteration: 1,
          model: "test-model",
          messages: [
            { role: "user", content: "collect details" },
            {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "call-form", name: "request_form", argumentsJson: "{}" }],
            },
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
      },
    });

    const response = await worker.handleRequest(restoreCheckpointRequest("session-1"));

    expect(response.result).toMatchObject({ restored: true });
    expect(appended).toEqual([]);
    expect(cleared).toEqual([]);
  });

  test("accepts snake_case session_id for agent.restore_checkpoint", async () => {
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async () => undefined,
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-1",
          phase: "awaiting_tools",
          iteration: 1,
          model: "test-model",
        }),
      },
    });

    const response = await worker.handleRequest(snakeRestoreCheckpointRequest("session-snake-1"));

    expect(response).toMatchObject({
      protocol_version: "1",
      id: "restore-snake-1",
      trace_id: "trace-restore-snake",
      result: {
        sessionId: "session-snake-1",
        checkpoint: {
          sessionId: "session-snake-1",
          runId: "run-1",
          phase: "awaiting_tools",
        },
      },
    });
  });

  test("resolves approval and returns the current session checkpoint", async () => {
    const resolvedApprovals: Array<{ approvalId: string; approved: boolean; scope?: string; sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      approvalBridge: {
        resolveApproval: async (params, traceId) => {
          resolvedApprovals.push({ ...params, traceId });
          return { approvalId: params.approvalId, approved: params.approved, scope: params.scope, status: "approved" };
        },
      },
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async () => undefined,
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
        }),
      },
    });

    const response = await worker.handleRequest(
      resumeApprovalRequest({
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: true,
        scope: "once",
      }),
    );

    expect(resolvedApprovals).toEqual([
      {
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: true,
        scope: "once",
        traceId: "trace-resume-approval",
      },
    ]);
    expect(response).toMatchObject({
      protocol_version: "1",
      id: "resume-approval-1",
      trace_id: "trace-resume-approval",
      result: {
        sessionId: "session-1",
        approval: {
          approvalId: "approval-1",
          approved: true,
          scope: "once",
          status: "approved",
        },
        checkpoint: {
          sessionId: "session-1",
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
        },
      },
    });
  });

  test("accepts snake_case ids for agent.resume_approval", async () => {
    const resolvedApprovals: Array<{ approvalId: string; approved: boolean; scope?: string; sessionId: string; traceId: string }> = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      approvalBridge: {
        resolveApproval: async (params, traceId) => {
          resolvedApprovals.push({ ...params, traceId });
          return { approvalId: params.approvalId, approved: params.approved, scope: params.scope, status: "approved" };
        },
      },
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async () => undefined,
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-1",
          phase: "tools_completed",
          model: "test-model",
        }),
      },
    });

    const response = await worker.handleRequest(
      resumeApprovalRequest({
        session_id: "session-snake-1",
        approval_id: "approval-snake-1",
        approved: true,
        scope: "session",
      }),
    );

    expect(resolvedApprovals).toEqual([
      {
        sessionId: "session-snake-1",
        approvalId: "approval-snake-1",
        approved: true,
        scope: "session",
        traceId: "trace-resume-approval",
      },
    ]);
    expect(response.result).toMatchObject({
      sessionId: "session-snake-1",
      approval: {
        approvalId: "approval-snake-1",
        approved: true,
        scope: "session",
      },
    });
  });

  test("executes the approved operation from checkpoint and continues the run", async () => {
    const writtenFiles: Array<Record<string, unknown>> = [];
    const clearedSessions: string[] = [];
    const appendedMessages: AgentMessage[][] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "Write a file",
      parameters: { type: "object" },
      execute: async (args) => {
        writtenFiles.push(args);
        return { content: `wrote ${String(args.path)}` };
      },
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "file written", toolCalls: [], stopReason: "stop" }]),
      tools,
      emitEvent: () => undefined,
      approvalBridge: {
        resolveApproval: async (params) => ({
          approvalId: params.approvalId,
          approved: params.approved,
          scope: params.scope,
          status: "approved",
        }),
      },
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async (sessionId) => ({
          sessionId,
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
        }),
      },
    });

    const response = await worker.handleRequest(
      resumeApprovalRequest({
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: true,
        scope: "once",
      }),
    );

    expect(writtenFiles).toEqual([{ path: "notes/today.md", contents: "hello" }]);
    expect(response.result).toMatchObject({
      approval: { approvalId: "approval-1", approved: true, scope: "once", status: "approved" },
      result: {
        finalContent: "file written",
        stopReason: "final_response",
        toolsUsed: [],
      },
    });
    expect(appendedMessages.at(-1)).toContainEqual({
      role: "tool",
      content: "wrote notes/today.md",
      toolCallId: "approval-call-1",
      name: "request_approval",
    });
    expect(clearedSessions).toEqual(["session-1"]);
  });

  test("continues the run with a denied approval result without executing the operation", async () => {
    const executedOperations: Array<Record<string, unknown>> = [];
    const clearedSessions: string[] = [];
    const appendedMessages: AgentMessage[][] = [];
    const tools = new ToolRegistry();
    tools.register({
      name: "write_file",
      description: "Write a file",
      parameters: { type: "object" },
      execute: async (args) => {
        executedOperations.push(args);
        return { content: "should not execute" };
      },
    });
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "I will not write the file.", toolCalls: [], stopReason: "stop" }]),
      tools,
      emitEvent: () => undefined,
      approvalBridge: {
        resolveApproval: async (params) => ({
          approvalId: params.approvalId,
          approved: params.approved,
          scope: params.scope,
          status: "denied",
        }),
      },
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async (sessionId) => ({
          sessionId,
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
        }),
      },
    });

    const response = await worker.handleRequest(
      resumeApprovalRequest({
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: false,
        scope: "once",
      }),
    );

    expect(executedOperations).toEqual([]);
    expect(response.result).toMatchObject({
      approval: { approvalId: "approval-1", approved: false, scope: "once", status: "denied" },
      result: {
        finalContent: "I will not write the file.",
        stopReason: "final_response",
        toolsUsed: [],
      },
    });
    expect(appendedMessages.at(-1)).toContainEqual({
      role: "tool",
      content: "Approval denied: approval-1",
      toolCallId: "approval-call-1",
      name: "request_approval",
      metadata: {
        approvalId: "approval-1",
        approved: false,
        status: "denied",
      },
    });
    expect(clearedSessions).toEqual(["session-1"]);
  });

  test("submits a pending form from checkpoint and continues the run", async () => {
    const clearedSessions: string[] = [];
    const appendedMessages: AgentMessage[][] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "Thanks, Paris works.", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async (sessionId) => ({
          sessionId,
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
        }),
      },
    });

    const response = await worker.handleRequest(
      submitFormRequest({
        sessionId: "session-1",
        formId: "travel_plan",
        values: { destination: "Paris", nights: 3 },
      }),
    );

    expect(response.result).toMatchObject({
      sessionId: "session-1",
      form: {
        formId: "travel_plan",
        action: "submitted",
        values: { destination: "Paris", nights: 3 },
      },
      result: {
        finalContent: "Thanks, Paris works.",
        stopReason: "final_response",
      },
    });
    expect(appendedMessages.at(-1)).toContainEqual({
      role: "tool",
      content: "Agent UI form submitted: travel_plan\n{\"destination\":\"Paris\",\"nights\":3}",
      toolCallId: "form-call-1",
      name: "request_form",
      metadata: {
        formId: "travel_plan",
        action: "submitted",
        values: { destination: "Paris", nights: 3 },
      },
    });
    expect(clearedSessions).toEqual(["session-1"]);
  });

  test("cancels a resumed form submission run by checkpoint runId", async () => {
    const events: WorkerEvent[] = [];
    const completion = deferred<ModelResponse>();
    const provider: ModelProvider = {
      complete: async () => completion.promise,
    };
    const worker = new AgentWorker({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async () => undefined,
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-resumed-form-1",
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
        }),
      },
    });

    const resumeResponsePromise = worker.handleRequest(
      submitFormRequest({
        sessionId: "session-1",
        formId: "travel_plan",
        values: { destination: "Paris" },
      }),
    );
    await Promise.resolve();

    const cancelResponse = await worker.handleRequest(cancelRequest("run-resumed-form-1"));
    completion.resolve({ content: "late resumed answer", toolCalls: [], stopReason: "stop" });
    const resumeResponse = await resumeResponsePromise;

    expect(cancelResponse).toMatchObject({
      protocol_version: "1",
      id: "cancel-1",
      trace_id: "trace-cancel",
      result: { ok: true, runId: "run-resumed-form-1" },
    });
    expect(resumeResponse.result).toMatchObject({
      result: {
        finalContent: "",
        stopReason: "cancelled",
        error: "cancelled",
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      event: "agent.cancelled",
      payload: expect.objectContaining({ runId: "run-resumed-form-1" }),
    }));
  });

  test("treats a cancel form action as a cancelled submission when resuming", async () => {
    const appendedMessages: AgentMessage[][] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "No changes made.", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-form-cancel-1",
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
        }),
      },
    });

    const response = await worker.handleRequest(
      submitFormRequest({
        sessionId: "session-1",
        formId: "travel_plan",
        action: "cancel",
      }),
    );

    expect(response.result).toMatchObject({
      sessionId: "session-1",
      form: {
        formId: "travel_plan",
        action: "cancelled",
        values: {},
      },
      result: {
        finalContent: "No changes made.",
        stopReason: "final_response",
      },
    });
    expect(appendedMessages.at(-1)).toContainEqual({
      role: "tool",
      content: "Agent UI form cancelled: travel_plan",
      toolCallId: "form-call-1",
      name: "request_form",
      metadata: {
        formId: "travel_plan",
        action: "cancelled",
        values: {},
      },
    });
  });

  test("accepts snake_case ids for agent.submit_form", async () => {
    const appendedMessages: AgentMessage[][] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([{ content: "Thanks, Paris works.", toolCalls: [], stopReason: "stop" }]),
      tools: new ToolRegistry(),
      emitEvent: () => undefined,
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async () => undefined,
        appendMessages: async (_sessionId, messages) => {
          appendedMessages.push(messages);
        },
        getCheckpoint: async (sessionId) => ({
          sessionId,
          runId: "run-form-snake-1",
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
        }),
      },
    });

    const response = await worker.handleRequest(
      submitFormRequest({
        session_id: "session-snake-1",
        form_id: "travel_plan",
        values: { destination: "Paris" },
      }),
    );

    expect(response.result).toMatchObject({
      sessionId: "session-snake-1",
      form: {
        formId: "travel_plan",
        action: "submitted",
        values: { destination: "Paris" },
      },
      result: {
        finalContent: "Thanks, Paris works.",
        stopReason: "final_response",
      },
    });
    expect(appendedMessages.at(-1)).toContainEqual({
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
  });

  test("resumes from snake_case checkpoint run spec fields", async () => {
    const events: WorkerEvent[] = [];
    const clearedSessions: string[] = [];
    const worker = new AgentWorker({
      provider: new QueueProvider([
        { content: "Thanks, Paris works.", toolCalls: [], stopReason: "stop", usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } },
      ]),
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
      sessionBridge: {
        setCheckpoint: async () => undefined,
        clearCheckpoint: async (sessionId) => {
          clearedSessions.push(sessionId);
        },
        appendMessages: async () => undefined,
        getCheckpoint: async (sessionId) => ({
          session_id: sessionId,
          run_id: "run-form-checkpoint-snake-1",
          phase: "tools_completed",
          model: "test-model",
          max_iterations: 2,
          stream: false,
          context_window: 100,
          tool_result_budget: 12,
          fail_on_tool_error: true,
          messages: [
            { role: "user", content: "plan a trip" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "form-call-1",
                  type: "function",
                  function: { name: "request_form", arguments: "{}" },
                },
              ],
            },
            {
              role: "tool",
              content: "Waiting for form submission.",
              tool_call_id: "form-call-1",
              name: "request_form",
              metadata: {
                awaitingUserInput: true,
                stopReason: "awaiting_form",
                formId: "travel_plan",
              },
            },
          ],
        }),
      },
    });

    const response = await worker.handleRequest(
      submitFormRequest({
        session_id: "session-snake-1",
        form_id: "travel_plan",
        values: { destination: "Paris" },
      }),
    );

    expect(response.result).toMatchObject({
      sessionId: "session-snake-1",
      result: {
        finalContent: "Thanks, Paris works.",
        stopReason: "final_response",
      },
    });
    expect(events).toContainEqual({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      event: "agent.usage",
      payload: expect.objectContaining({
        runId: "run-form-checkpoint-snake-1",
        contextWindowTokens: 100,
      }),
    });
    expect(events).toContainEqual(expect.objectContaining({
      protocol_version: "1",
      trace_id: "trace-submit-form",
      event: "agent.done",
      payload: expect.objectContaining({
        runId: "run-form-checkpoint-snake-1",
        stopReason: "final_response",
      }),
    }));
    expect(clearedSessions).toEqual(["session-snake-1"]);
  });
});
