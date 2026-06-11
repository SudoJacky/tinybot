import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import type { WorkerEvent, WorkerRequest } from "../protocol/messages";
import { ToolRegistry } from "../tools/toolRegistry";
import { AgentWorker } from "./agentWorker";

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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("AgentWorker", () => {
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
