import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelResponse, ModelStreamCallbacks } from "../model/provider";
import type { WorkerEvent, WorkerRequest } from "../protocol/messages";
import { ToolRegistry } from "../tools/toolRegistry";
import { AgentWorker } from "./agentWorker";

class QueueProvider implements ModelProvider {
  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_messages: AgentMessage[], _callbacks?: ModelStreamCallbacks): Promise<ModelResponse> {
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
    expect(events).toContainEqual({
      protocol_version: "1",
      trace_id: "trace-1",
      event: "agent.done",
      payload: {
        runId: "run-1",
        stopReason: "final_response",
      },
    });
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

    expect(events.map((event) => event.event)).toEqual([
      "agent.checkpoint",
      "agent.tool.start",
      "agent.tool.result",
      "agent.checkpoint",
      "agent.checkpoint",
      "agent.done",
    ]);
    expect(events[1]).toMatchObject({
      event: "agent.tool.start",
      payload: { runId: "run-1", toolCallId: "call-1", toolName: "echo" },
    });
    expect(events[2]).toMatchObject({
      event: "agent.tool.result",
      payload: { runId: "run-1", toolCallId: "call-1", toolName: "echo", content: "echo:from tool" },
    });
    expect(events[0]).toMatchObject({
      event: "agent.checkpoint",
      payload: { runId: "run-1", phase: "awaiting_tools" },
    });
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

    expect(events.slice(0, 3)).toEqual([
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
});
