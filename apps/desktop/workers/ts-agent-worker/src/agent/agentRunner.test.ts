import { describe, expect, test } from "vitest";

import { AgentRunner } from "./agentRunner";
import type { AgentMessage, AgentRunSpec } from "./agentRunSpec";
import type { ModelProvider, ModelResponse, ModelStreamCallbacks } from "../model/provider";
import { ToolRegistry } from "../tools/toolRegistry";

function spec(overrides: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    runId: "run-1",
    messages: [{ role: "user", content: "hello" }],
    model: "test-model",
    maxIterations: 4,
    stream: false,
    ...overrides,
  };
}

class QueueProvider implements ModelProvider {
  readonly requests: AgentMessage[][] = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], callbacks?: ModelStreamCallbacks): Promise<ModelResponse> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    callbacks?.onContentDelta?.("stream content");
    callbacks?.onReasoningDelta?.("stream reasoning");
    callbacks?.onToolCallDelta?.({
      index: 0,
      deltaText: "{\"streamed\":true}",
      toolCallId: "stream-call",
      toolName: "stream_tool",
    });
    return response;
  }
}

describe("AgentRunner", () => {
  test("returns a final response without calling tools", async () => {
    const provider = new QueueProvider([
      {
        content: "done",
        toolCalls: [],
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        stopReason: "stop",
      },
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    const result = await runner.run(spec());

    expect(result.finalContent).toBe("done");
    expect(result.stopReason).toBe("final_response");
    expect(result.toolsUsed).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    expect(provider.requests).toHaveLength(1);
  });

  test("executes a tool call and continues until the model returns final content", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "echo",
            argumentsJson: "{\"text\":\"from tool\"}",
          },
        ],
        stopReason: "tool_calls",
      },
      {
        content: "tool complete",
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      execute: async (args) => ({ content: `echo:${String(args.text)}` }),
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec());

    expect(result.finalContent).toBe("tool complete");
    expect(result.stopReason).toBe("final_response");
    expect(result.toolsUsed).toEqual(["echo"]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]).toContainEqual({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "echo",
          argumentsJson: "{\"text\":\"from tool\"}",
        },
      ],
    });
    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: "echo:from tool",
      toolCallId: "call-1",
      name: "echo",
    });
  });

  test("emits tool lifecycle events and checkpoints", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"from tool\"}" }],
        stopReason: "tool_calls",
      },
      {
        content: "tool complete",
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object" },
      execute: async (args) => ({ content: `echo:${String(args.text)}` }),
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const checkpoints: Array<{ phase: string }> = [];
    const runner = new AgentRunner({
      provider,
      tools,
      emitEvent: (event) => events.push(event),
      checkpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    await runner.run(spec());

    expect(events).toEqual([
      {
        type: "tool_start",
        payload: { runId: "run-1", toolCallId: "call-1", toolName: "echo" },
      },
      {
        type: "tool_result",
        payload: { runId: "run-1", toolCallId: "call-1", toolName: "echo", content: "echo:from tool" },
      },
    ]);
    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
      "awaiting_tools",
      "tools_completed",
      "final_response",
    ]);
  });

  test("forwards provider streaming deltas as runner events", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AgentRunner({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await runner.run(spec({ stream: true }));

    expect(events).toEqual([
      {
        type: "content_delta",
        payload: { runId: "run-1", delta: "stream content" },
      },
      {
        type: "reasoning_delta",
        payload: { runId: "run-1", delta: "stream reasoning" },
      },
      {
        type: "tool_call_delta",
        payload: {
          runId: "run-1",
          index: 0,
          deltaText: "{\"streamed\":true}",
          toolCallId: "stream-call",
          toolName: "stream_tool",
        },
      },
    ]);
  });

  test("stops when tool calls exhaust max iterations", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"first\"}" }],
        stopReason: "tool_calls",
      },
      {
        content: "",
        toolCalls: [{ id: "call-2", name: "echo", argumentsJson: "{\"text\":\"second\"}" }],
        stopReason: "tool_calls",
      },
    ]);
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object" },
      execute: async (args) => ({ content: `echo:${String(args.text)}` }),
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec({ maxIterations: 2 }));

    expect(result.finalContent).toBe("");
    expect(result.stopReason).toBe("max_iterations");
    expect(result.toolsUsed).toEqual(["echo", "echo"]);
    expect(provider.requests).toHaveLength(2);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  test("retries an empty final response with a finalization prompt", async () => {
    const provider = new QueueProvider([
      { content: "   ", toolCalls: [], stopReason: "stop" },
      { content: "retry answer", toolCalls: [], stopReason: "stop" },
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    const result = await runner.run(spec());

    expect(result.finalContent).toBe("retry answer");
    expect(result.stopReason).toBe("final_response");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]).toContainEqual({
      role: "user",
      content:
        "You have already finished the tool work. Do not call any more tools. Using only the conversation and tool results above, provide the final answer for the user now.",
    });
  });

  test("returns the empty final response message when the retry is still empty", async () => {
    const provider = new QueueProvider([
      { content: "", toolCalls: [], stopReason: "stop" },
      { content: "  ", toolCalls: [], stopReason: "stop" },
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    const result = await runner.run(spec());

    expect(result.finalContent).toBe("I completed the tool steps but couldn't produce a final answer. Please try again or narrow the task.");
    expect(result.stopReason).toBe("empty_final_response");
    expect(result.error).toBe(result.finalContent);
  });

  test("stops with a tool_error when failOnToolError is enabled", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "fail", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      },
    ]);
    const tools = new ToolRegistry();
    tools.register({
      name: "fail",
      description: "Fail",
      parameters: { type: "object" },
      execute: async () => {
        throw new Error("tool failed");
      },
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec({ failOnToolError: true }));

    expect(result.stopReason).toBe("tool_error");
    expect(result.finalContent).toBe("Error: Error: tool failed");
    expect(result.error).toBe("Error: Error: tool failed");
    expect(result.toolsUsed).toEqual(["fail"]);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: "Error: Error: tool failed",
    });
  });
});
