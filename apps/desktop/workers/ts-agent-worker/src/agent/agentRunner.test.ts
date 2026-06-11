import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { AgentRunner } from "./agentRunner";
import type { AgentRunnerCheckpoint } from "./agentRunner";
import type { AgentMessage, AgentRunSpec } from "./agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
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
  readonly options: Array<ModelRequestOptions | undefined> = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], callbacks?: ModelRequestOptions): Promise<ModelResponse> {
    this.requests.push(messages.map((message) => ({ ...message })));
    this.options.push(callbacks);
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

type ParityFixture = {
  runId: string;
  model: string;
  maxIterations: number;
  maxToolResultChars: number;
  failOnToolError?: boolean;
  messages: AgentRunSpec["messages"];
  responses: Array<{
    content: string;
    stopReason: string;
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    }>;
  }>;
  toolResults: Record<string, string>;
  toolErrors?: Record<string, string>;
  toolErrorStrings?: Record<string, string>;
  expected: {
    finalContent: string;
    stopReason: string;
    toolsUsed: string[];
    messageRoles: string[];
    checkpoints: string[];
    toolContents?: string[];
  };
};

function loadParityFixture(fixtureName: string): ParityFixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../../../tests/fixtures/agent_runner_parity/${fixtureName}`, import.meta.url),
      "utf8",
    ),
  ) as ParityFixture;
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

  test("preserves reasoning content on final assistant messages", async () => {
    const provider = new QueueProvider([
      {
        content: "done",
        reasoningContent: "thought summary",
        toolCalls: [],
        stopReason: "stop",
      } as ModelResponse,
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    const result = await runner.run(spec());

    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "done",
      reasoningContent: "thought summary",
    });
  });

  test("preserves thinking blocks on final assistant messages", async () => {
    const thinkingBlocks = [{ type: "thinking", text: "internal trace" }];
    const provider = new QueueProvider([
      {
        content: "done",
        thinkingBlocks,
        toolCalls: [],
        stopReason: "stop",
      } as ModelResponse,
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    const result = await runner.run(spec());

    expect(result.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "done",
      reasoningContent: "",
      thinkingBlocks,
    });
  });

  test("preserves reasoning content on assistant tool-call messages and checkpoints", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        reasoningContent: "need tool",
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
    const checkpoints: AgentRunnerCheckpoint[] = [];
    const runner = new AgentRunner({
      provider,
      tools,
      checkpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    const result = await runner.run(spec());

    expect(result.messages.find((message) => message.role === "assistant" && message.toolCalls)).toMatchObject({
      role: "assistant",
      content: "",
      reasoningContent: "need tool",
      toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"from tool\"}" }],
    });
    expect(checkpoints[0]?.assistantMessage).toMatchObject({
      role: "assistant",
      content: "",
      reasoningContent: "need tool",
    });
  });

  test("emits estimated and provider usage events around model requests", async () => {
    const provider = new QueueProvider([
      {
        content: "done",
        toolCalls: [],
        usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
        stopReason: "stop",
      },
    ]);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AgentRunner({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await runner.run(spec({ contextWindow: 200 }));

    expect(events).toContainEqual({
      type: "usage",
      payload: expect.objectContaining({
        runId: "run-1",
        phase: "before_request",
        iteration: 0,
        tokens: expect.any(Number),
        source: "heuristic",
        budget: 200,
        messageCount: 1,
        estimated: true,
      }),
    });
    expect(events).toContainEqual({
      type: "usage",
      payload: {
        runId: "run-1",
        phase: "after_response",
        iteration: 0,
        tokens: 7,
        source: "provider_usage",
        estimated: false,
      },
    });
  });

  test("reports the input context budget after reserving requested output tokens", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AgentRunner({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await runner.run(spec({ contextWindow: 200, maxTokens: 48 }));

    expect(events).toContainEqual({
      type: "usage",
      payload: expect.objectContaining({
        phase: "before_request",
        budget: 152,
      }),
    });
  });

  test("passes the run model to each provider request", async () => {
    const provider = new QueueProvider([
      { content: "   ", toolCalls: [], stopReason: "stop" },
      { content: "retry answer", toolCalls: [], stopReason: "stop" },
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    await runner.run(spec({ model: "gpt-run-model" }));

    expect(provider.options.map((option) => option?.model)).toEqual(["gpt-run-model", "gpt-run-model"]);
  });

  test("passes generation settings to each provider request", async () => {
    const provider = new QueueProvider([
      { content: "   ", toolCalls: [], stopReason: "stop" },
      { content: "retry answer", toolCalls: [], stopReason: "stop" },
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    await runner.run(spec({
      temperature: 0.2,
      maxTokens: 2048,
      reasoningEffort: "medium",
    }));

    expect(provider.options.map((option) => ({
      temperature: option?.temperature,
      maxTokens: option?.maxTokens,
      reasoningEffort: option?.reasoningEffort,
    }))).toEqual([
      { temperature: 0.2, maxTokens: 2048, reasoningEffort: "medium" },
      { temperature: 0.2, maxTokens: 2048, reasoningEffort: "medium" },
    ]);
  });

  test("limits provider tool definitions to the run spec tools", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (args) => ({ content: `echo:${String(args.text)}` }),
    });
    tools.register({
      name: "hidden",
      description: "Hidden tool",
      parameters: { type: "object" },
      execute: async () => ({ content: "hidden executed" }),
    });
    const runner = new AgentRunner({ provider, tools });

    await runner.run(spec({
      tools: [
        {
          name: "echo",
          description: "Only echo is available",
          parameters: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    }));

    expect(provider.options[0]?.tools).toEqual([
      {
        name: "echo",
        description: "Only echo is available",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
    ]);
  });

  test("does not execute registry tools omitted from the run spec tools", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "hidden", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      },
      { content: "recovered", toolCalls: [], stopReason: "stop" },
    ]);
    let hiddenExecutions = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "hidden",
      description: "Hidden tool",
      parameters: { type: "object" },
      execute: async () => {
        hiddenExecutions += 1;
        return { content: "hidden executed" };
      },
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec({
      tools: [
        {
          name: "echo",
          description: "Only echo is available",
          parameters: { type: "object" },
        },
      ],
    }));

    expect(hiddenExecutions).toBe(0);
    expect(result.messages).toContainEqual({
      role: "tool",
      content: "Error: Tool 'hidden' not found. Available: echo\n\n[Analyze the error above and try a different approach. Consider using `query_experience` to search for past solutions to similar problems.]",
      toolCallId: "call-1",
      name: "hidden",
      metadata: undefined,
    });
  });

  test("treats malformed tool call arguments as a recoverable tool result", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":" }],
        stopReason: "tool_calls",
      },
      { content: "recovered", toolCalls: [], stopReason: "stop" },
    ]);
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object" },
      execute: async () => {
        executions += 1;
        return { content: "should not run" };
      },
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec());

    expect(executions).toBe(0);
    expect(result.stopReason).toBe("final_response");
    expect(result.finalContent).toBe("recovered");
    expect(result.messages).toContainEqual({
      role: "tool",
      content: expect.stringContaining("Error: Invalid arguments for tool 'echo'"),
      toolCallId: "call-1",
      name: "echo",
      metadata: undefined,
    });
    expect(provider.requests).toHaveLength(2);
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

  test.each([
    "one_tool_then_final.json",
    "max_iterations_after_tools.json",
    "provider_error_final.json",
    "provider_error_blank.json",
    "tool_error_then_final.json",
    "tool_error_string_then_final.json",
    "tool_error_string_fatal.json",
    "unknown_tool_then_final.json",
    "invalid_tool_params_then_final.json",
    "invalid_tool_enum_then_final.json",
    "tool_integer_string_cast_then_final.json",
    "tool_array_integer_string_cast_then_final.json",
  ])(
    "matches the shared Python parity fixture %s",
    async (fixtureName) => {
      const fixture = loadParityFixture(fixtureName);
      const provider = new QueueProvider(
        fixture.responses.map((response) => ({
          content: response.content,
          stopReason: response.stopReason,
          toolCalls: response.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            argumentsJson: JSON.stringify(toolCall.arguments),
          })),
        })),
      );
      const tools = new ToolRegistry();
      tools.register({
        name: "echo",
        description: "Echo text",
        parameters: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        execute: async (args) => ({
          content: fixture.toolResults.echo.replace("{text}", String(args.text)),
        }),
      });
      if (fixture.toolErrors?.fail) {
        tools.register({
          name: "fail",
          description: "Fail with an Error",
          parameters: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
          execute: async (args) => {
            const error = new Error(String(args.reason));
            error.name = "ValueError";
            throw error;
          },
        });
      }
      if (fixture.toolErrorStrings?.error_string) {
        tools.register({
          name: "error_string",
          description: "Return an Error string",
          parameters: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
          execute: async (args) => ({
            content: fixture.toolErrorStrings?.error_string.replace("{reason}", String(args.reason)) ?? "",
          }),
        });
      }
      if (fixtureName === "tool_integer_string_cast_then_final.json") {
        tools.register({
          name: "count",
          description: "Return a count",
          parameters: {
            type: "object",
            properties: { count: { type: "integer" } },
            required: ["count"],
          },
          execute: async (args) => ({
            content: typeof args.count === "number" && Number.isInteger(args.count)
              ? `count:${String(args.count)}`
              : `count-type:${typeof args.count}`,
          }),
        });
      }
      if (fixtureName === "tool_array_integer_string_cast_then_final.json") {
        tools.register({
          name: "sum_numbers",
          description: "Sum integer values",
          parameters: {
            type: "object",
            properties: {
              values: {
                type: "array",
                items: { type: "integer" },
              },
            },
            required: ["values"],
          },
          execute: async (args) => {
            const values = Array.isArray(args.values) ? args.values : [];
            const allIntegers = values.every((value) => typeof value === "number" && Number.isInteger(value));
            return {
              content: allIntegers
                ? `sum:${String(values.reduce((total, value) => total + Number(value), 0))}`
                : `sum-types:${values.map((value) => typeof value).join(",")}`,
            };
          },
        });
      }
      if (fixtureName === "invalid_tool_enum_then_final.json") {
        tools.register({
          name: "mode",
          description: "Return a mode",
          parameters: {
            type: "object",
            properties: { mode: { type: "string", enum: ["fast", "slow"] } },
            required: ["mode"],
          },
          execute: async (args) => ({
            content: `mode:${String(args.mode)}`,
          }),
        });
      }
      const checkpoints: Array<{ phase: string }> = [];
      const runner = new AgentRunner({
        provider,
        tools,
        checkpoint: (checkpoint) => checkpoints.push(checkpoint),
      });

      const result = await runner.run(
        spec({
          runId: fixture.runId,
          messages: fixture.messages,
          model: fixture.model,
          maxIterations: fixture.maxIterations,
          toolResultBudget: fixture.maxToolResultChars,
          failOnToolError: fixture.failOnToolError,
        }),
      );

      const actual: Record<string, unknown> = {
        finalContent: result.finalContent,
        stopReason: result.stopReason,
        toolsUsed: result.toolsUsed,
        messageRoles: result.messages.map((message) => message.role),
        checkpoints: checkpoints.map((checkpoint) => checkpoint.phase),
      };
      if (fixture.expected.toolContents) {
        actual.toolContents = result.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.content);
      }
      expect(actual).toEqual(fixture.expected);
    },
  );

  test("applies tool result budget before sending tool output back to the model", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"abcdefghijklmnopqrstuvwxyz\"}" }],
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
      execute: async (args) => ({ content: String(args.text) }),
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec({ toolResultBudget: 8 }));

    const expectedContent = "abcdefgh\n... (truncated)";
    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: expectedContent,
      toolCallId: "call-1",
      name: "echo",
    });
    expect(result.messages).toContainEqual({
      role: "tool",
      content: expectedContent,
      toolCallId: "call-1",
      name: "echo",
    });
  });

  test("replaces empty live tool results with a prompt-safe marker", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      },
      { content: "done", toolCalls: [], stopReason: "stop" },
    ]);
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object" },
      execute: async () => ({ content: "   " }),
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec());

    const marker = "(echo completed with no output)";
    expect(provider.requests[1]).toContainEqual({
      role: "tool",
      content: marker,
      toolCallId: "call-1",
      name: "echo",
    });
    expect(result.messages).toContainEqual({
      role: "tool",
      content: marker,
      toolCallId: "call-1",
      name: "echo",
      metadata: undefined,
    });
  });

  test("applies tool result budget to restored tool messages before the first provider request", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    await runner.run(
      spec({
        toolResultBudget: 4,
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }] },
          { role: "tool", content: "existing long result", toolCallId: "call-1", name: "echo" },
        ],
      }),
    );

    expect(provider.requests[0]).toContainEqual({
      role: "tool",
      content: "exis\n... (truncated)",
      toolCallId: "call-1",
      name: "echo",
    });
  });

  test("replaces empty restored tool messages before the first provider request", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    await runner.run(
      spec({
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }] },
          { role: "tool", content: "   ", toolCallId: "call-1", name: "echo" },
        ],
      }),
    );

    expect(provider.requests[0]).toContainEqual({
      role: "tool",
      content: "(echo completed with no output)",
      toolCallId: "call-1",
      name: "echo",
    });
  });

  test("snips over-budget history while preserving the core system message and latest user turn", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });
    const coreSystem = { role: "system" as const, content: "core contract" };
    const recentUser = { role: "user" as const, content: "recent question" };

    await runner.run(
      spec({
        contextWindow: 72,
        messages: [
          coreSystem,
          { role: "user", content: "old user ".repeat(30) },
          { role: "assistant", content: "old assistant ".repeat(30) },
          { role: "system", content: "dynamic retrieval block ".repeat(20) },
          recentUser,
        ],
      }),
    );

    expect(provider.requests[0]).toEqual([
      { ...coreSystem, toolCalls: undefined },
      { ...recentUser, toolCalls: undefined },
    ]);
  });

  test("reserves requested output tokens when snipping history", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });
    const coreSystem = { role: "system" as const, content: "core contract" };
    const recentUser = { role: "user" as const, content: "recent question" };

    await runner.run(
      spec({
        contextWindow: 180,
        maxTokens: 96,
        messages: [
          coreSystem,
          { role: "user", content: "old user ".repeat(4) },
          { role: "assistant", content: "old answer ".repeat(4) },
          recentUser,
        ],
      }),
    );

    expect(provider.requests[0]).toEqual([
      { ...coreSystem, toolCalls: undefined },
      { ...recentUser, toolCalls: undefined },
    ]);
  });

  test("snips history to a legal message start when old assistant tool calls are dropped", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });
    const recentUser = { role: "user" as const, content: "continue from here" };

    await runner.run(
      spec({
        contextWindow: 92,
        messages: [
          { role: "system", content: "core contract" },
          {
            role: "assistant",
            content: "tool setup ".repeat(20),
            toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{}" }],
          },
          { role: "tool", content: "orphaned result", toolCallId: "call-1", name: "echo" },
          recentUser,
        ],
      }),
    );

    expect(provider.requests[0]).toEqual([
      { role: "system", content: "core contract", toolCalls: undefined },
      { ...recentUser, toolCalls: undefined },
    ]);
  });

  test("counts reasoning content when snipping history", async () => {
    const provider = new QueueProvider([{ content: "done", toolCalls: [], stopReason: "stop" }]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });
    const recentUser = { role: "user" as const, content: "continue from here" };

    await runner.run(
      spec({
        contextWindow: 120,
        messages: [
          { role: "user", content: "old question" },
          { role: "assistant", content: "old answer", reasoningContent: "x".repeat(400) },
          recentUser,
        ],
      }),
    );

    expect(provider.requests[0]).toEqual([{ ...recentUser, toolCalls: undefined }]);
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

    expect(events.filter((event) => event.type === "tool_start" || event.type === "tool_result")).toEqual([
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

  test("emits task progress events from tool metadata", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "task", argumentsJson: "{\"action\":\"status\"}" }],
        stopReason: "tool_calls",
      },
      {
        content: "progress checked",
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const tools = new ToolRegistry();
    const taskProgress = {
      plan_id: "plan-1",
      progress: { completed: 1, total: 3, pending: 2 },
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
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AgentRunner({
      provider,
      tools,
      emitEvent: (event) => events.push(event),
    });

    await runner.run(spec({ messages: [{ role: "user", content: "check task" }] }));

    expect(events).toContainEqual({
      type: "task_progress",
      payload: {
        runId: "run-1",
        toolCallId: "call-1",
        toolName: "task",
        planId: "plan-1",
        progress: taskProgress,
      },
    });
  });

  test("stops when a tool returns an awaiting user input result", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "request_form", argumentsJson: "{}" }],
        stopReason: "tool_calls",
      },
      {
        content: "should not be requested",
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
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
    const checkpoints: Array<{ phase: string }> = [];
    const runner = new AgentRunner({
      provider,
      tools,
      checkpoint: (checkpoint) => checkpoints.push(checkpoint),
    });

    const result = await runner.run(spec());

    expect(result.stopReason).toBe("awaiting_form");
    expect(result.finalContent).toBe("");
    expect(result.toolsUsed).toEqual(["request_form"]);
    expect(provider.requests).toHaveLength(1);
    expect(result.messages.at(-1)).toEqual({
      role: "tool",
      content: "Waiting for form submission.",
      toolCallId: "call-1",
      name: "request_form",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_form",
        formId: "form-1",
      },
    });
    expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(["awaiting_tools", "tools_completed"]);
  });

  test("requests approval before executing a tool that requires approval", async () => {
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "write_file",
            argumentsJson: "{\"path\":\"notes/today.md\",\"content\":\"hello\"}",
          },
        ],
        stopReason: "tool_calls",
      },
      {
        content: "should not be requested",
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const tools = new ToolRegistry();
    const executedWrites: Record<string, unknown>[] = [];
    const approvalRequests: Record<string, unknown>[] = [];
    tools.register({
      name: "write_file",
      description: "Write a file",
      parameters: { type: "object" },
      capabilities: ["fs.workspace.write"],
      requiresApproval: true,
      execute: async (args) => {
        executedWrites.push(args);
        return { content: "written" };
      },
    });
    tools.register({
      name: "request_approval",
      description: "Request approval",
      parameters: { type: "object" },
      execute: async (args) => {
        approvalRequests.push(args);
        return {
          content: "Waiting for approval.",
          metadata: {
            awaitingUserInput: true,
            stopReason: "awaiting_approval",
            approvalId: "approval-1",
            operation: args.operation,
          },
        };
      },
    });
    const runner = new AgentRunner({ provider, tools });

    const result = await runner.run(spec());

    expect(executedWrites).toEqual([]);
    expect(approvalRequests).toEqual([
      {
        operation: {
          toolName: "write_file",
          arguments: { path: "notes/today.md", content: "hello" },
        },
        classification: {
          action: "require_approval",
          category: "filesystem_write",
          risk: "medium",
          reason: "File write/edit/delete tools can modify workspace state.",
        },
        fingerprint: "write_file:notes/today.md",
        sessionFingerprint: "write_file:notes/today.md",
        summary: "write_file path=\"notes/today.md\"",
      },
    ]);
    expect(result.stopReason).toBe("awaiting_approval");
    expect(result.finalContent).toBe("");
    expect(result.toolsUsed).toEqual(["write_file"]);
    expect(provider.requests).toHaveLength(1);
    expect(result.messages.at(-1)).toEqual({
      role: "tool",
      content: "Waiting for approval.",
      toolCallId: "call-1",
      name: "write_file",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: "approval-1",
        operation: {
          toolName: "write_file",
          arguments: { path: "notes/today.md", content: "hello" },
        },
      },
    });
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

    expect(events.filter((event) => (
      event.type === "content_delta"
      || event.type === "reasoning_delta"
      || event.type === "tool_call_delta"
    ))).toEqual([
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

    expect(result.finalContent).toBe(
      "I reached the maximum number of tool call iterations (2) without completing the task. You can try breaking the task into smaller steps.",
    );
    expect(result.stopReason).toBe("max_iterations");
    expect(result.toolsUsed).toEqual(["echo", "echo"]);
    expect(provider.requests).toHaveLength(2);
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content:
        "I reached the maximum number of tool call iterations (2) without completing the task. You can try breaking the task into smaller steps.",
    });
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

  test("preserves retry response reasoning on finalization", async () => {
    const thinkingBlocks = [{ type: "thinking", text: "retry reasoning trace" }];
    const provider = new QueueProvider([
      { content: "   ", reasoningContent: "stale empty reasoning", toolCalls: [], stopReason: "stop" },
      {
        content: "retry answer",
        reasoningContent: "retry reasoning",
        thinkingBlocks,
        toolCalls: [],
        stopReason: "stop",
      },
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    const result = await runner.run(spec());

    expect(result.finalContent).toBe("retry answer");
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: "retry answer",
      reasoningContent: "retry reasoning",
      thinkingBlocks,
    });
  });

  test("merges cached token usage across finalization retries", async () => {
    const provider = new QueueProvider([
      {
        content: "   ",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11, cachedTokens: 6 },
        stopReason: "stop",
      },
      {
        content: "retry answer",
        toolCalls: [],
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12, cachedTokens: 3 },
        stopReason: "stop",
      },
    ]);
    const runner = new AgentRunner({ provider, tools: new ToolRegistry() });

    const result = await runner.run(spec());

    expect(result.usage).toEqual({
      inputTokens: 18,
      outputTokens: 5,
      totalTokens: 23,
      cachedTokens: 9,
    });
  });

  test("emits usage events around finalization retries", async () => {
    const provider = new QueueProvider([
      {
        content: "   ",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 },
        stopReason: "stop",
      },
      {
        content: "retry answer",
        toolCalls: [],
        usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
        stopReason: "stop",
      },
    ]);
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const runner = new AgentRunner({
      provider,
      tools: new ToolRegistry(),
      emitEvent: (event) => events.push(event),
    });

    await runner.run(spec({ contextWindow: 200 }));

    const usageEvents = events.filter((event) => event.type === "usage");
    expect(usageEvents).toMatchObject([
      {
        payload: {
          phase: "before_request",
          iteration: 0,
          source: "heuristic",
          messageCount: 1,
          estimated: true,
        },
      },
      {
        payload: {
          phase: "after_response",
          iteration: 0,
          tokens: 10,
          source: "provider_usage",
          estimated: false,
        },
      },
      {
        payload: {
          phase: "before_finalization_retry",
          iteration: 0,
          source: "heuristic",
          messageCount: 2,
          estimated: true,
        },
      },
      {
        payload: {
          phase: "after_finalization_retry",
          iteration: 0,
          tokens: 8,
          source: "provider_usage",
          estimated: false,
        },
      },
    ]);
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

  test("stops as cancelled after a provider boundary observes cancellation", async () => {
    const provider = new QueueProvider([{ content: "ignored", toolCalls: [], stopReason: "stop" }]);
    const runner = new AgentRunner({
      provider,
      tools: new ToolRegistry(),
      isCancelled: () => true,
    });

    const result = await runner.run(spec());

    expect(result.stopReason).toBe("cancelled");
    expect(result.finalContent).toBe("");
    expect(result.error).toBe("cancelled");
    expect(result.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  test("preserves a completed tool result when cancellation is observed after execution", async () => {
    let cancelled = false;
    const provider = new QueueProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", argumentsJson: "{\"text\":\"done\"}" }],
        stopReason: "tool_calls",
      },
    ]);
    const tools = new ToolRegistry();
    tools.register({
      name: "echo",
      description: "Echo text",
      parameters: { type: "object" },
      execute: async (args) => {
        cancelled = true;
        return { content: `echo:${String(args.text)}` };
      },
    });
    const runner = new AgentRunner({
      provider,
      tools,
      isCancelled: () => cancelled,
    });

    const result = await runner.run(spec());

    expect(result.stopReason).toBe("cancelled");
    expect(result.messages).toContainEqual({
      role: "tool",
      content: "echo:done",
      toolCallId: "call-1",
      name: "echo",
      metadata: undefined,
    });
  });
});
