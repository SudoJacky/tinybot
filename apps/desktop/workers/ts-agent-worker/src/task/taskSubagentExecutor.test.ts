import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import type { Tool } from "../tools/tool";
import { ToolRegistry } from "../tools/toolRegistry";
import { TaskProviderSubagentExecutor } from "./taskSubagentExecutor";
import type { SpawnSubtaskRequest } from "./taskRuntime";
import type { TaskPlan } from "./taskTypes";

class RecordingProvider implements ModelProvider {
  readonly requests: Array<{ messages: AgentMessage[]; options?: ModelRequestOptions }> = [];

  constructor(private readonly response: ModelResponse) {}

  async complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    this.requests.push({ messages, options });
    return this.response;
  }
}

function plan(): TaskPlan {
  return {
    id: "plan-1",
    title: "Backend migration",
    originalRequest: "Move backend runtime to TS",
    status: "executing",
    currentSubtaskIds: ["a"],
    context: {},
    subtasks: [
      {
        id: "a",
        title: "Inspect",
        description: "Inspect Python",
        status: "in_progress",
        dependencies: [],
        parallelSafe: true,
        result: null,
        error: null,
        startedAt: null,
        completedAt: null,
        retryCount: 0,
        maxRetries: 2,
      },
    ],
  };
}

describe("TaskProviderSubagentExecutor", () => {
  test("runs a focused provider call and reports completed subtask result", async () => {
    const provider = new RecordingProvider({ content: "inspection complete", toolCalls: [], stopReason: "stop" });
    const executor = new TaskProviderSubagentExecutor({ provider, model: "test-model" });
    const completions: Array<{ status: string; result?: string | null; error?: string | null }> = [];
    const request: SpawnSubtaskRequest = {
      plan: plan(),
      subtask: plan().subtasks[0],
      label: "Inspect",
      task: "Execute subtask: Inspect",
      onComplete: async (completion) => {
        completions.push(completion);
      },
    };

    await executor.spawnSubtask(request, "trace-1");
    await waitFor(() => completions.length === 1);

    expect(provider.requests[0]).toMatchObject({
      options: { model: "test-model" },
    });
    expect(provider.requests[0]?.messages).toEqual([
      expect.objectContaining({ role: "system", content: expect.stringContaining("focused task execution subagent") }),
      expect.objectContaining({ role: "user", content: "Execute subtask: Inspect" }),
    ]);
    expect(completions).toEqual([{ status: "completed", result: "inspection complete" }]);
  });

  test("limits concurrent provider-backed subtasks", async () => {
    const first = deferred<ModelResponse>();
    const second = deferred<ModelResponse>();
    const provider = new QueueProvider([first.promise, second.promise]);
    const executor = new TaskProviderSubagentExecutor({
      provider,
      model: "test-model",
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `subagent-${index += 1}`;
      })(),
    });
    const completions: Array<{ status: string; result?: string | null }> = [];

    await executor.spawnSubtask(requestFor("a", "Inspect", completions), "trace-1");
    await executor.spawnSubtask(requestFor("b", "Implement", completions), "trace-1");
    await waitFor(() => provider.requests.length === 1);

    first.resolve({ content: "inspection complete", toolCalls: [], stopReason: "stop" });
    await waitFor(() => provider.requests.length === 2);
    second.resolve({ content: "implementation complete", toolCalls: [], stopReason: "stop" });
    await waitFor(() => completions.length === 2);

    expect(completions).toEqual([
      { status: "completed", result: "inspection complete" },
      { status: "completed", result: "implementation complete" },
    ]);
  });

  test("returns after spawning a task subagent without waiting for completion", async () => {
    const first = deferred<ModelResponse>();
    const provider = new QueueProvider([first.promise]);
    const executor = new TaskProviderSubagentExecutor({
      provider,
      model: "test-model",
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: () => "task-subagent-1",
    });
    const completions: Array<{ status: string; result?: string | null }> = [];

    await executor.spawnSubtask(requestFor("a", "Inspect", completions), "trace-1");

    expect(provider.requests).toHaveLength(1);
    expect(completions).toEqual([]);
    first.resolve({ content: "inspection complete", toolCalls: [], stopReason: "stop" });
    await waitFor(() => completions.length === 1);
    expect(completions).toEqual([{ status: "completed", result: "inspection complete" }]);
  });

  test("runs configured subagent tools through AgentRunner before completing", async () => {
    const provider = new QueueProvider([
      Promise.resolve({
        content: "",
        toolCalls: [{ id: "call-1", name: "inspect_file", argumentsJson: "{\"path\":\"AGENTS.md\"}" }],
        stopReason: "tool_calls",
      }),
      Promise.resolve({ content: "inspection used tool result", toolCalls: [], stopReason: "stop" }),
    ]);
    const tools = new ToolRegistry();
    const toolCalls: Array<Record<string, unknown>> = [];
    tools.register({
      name: "inspect_file",
      description: "Inspect a workspace file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      execute: async (args) => {
        toolCalls.push(args);
        return { content: "file contains migration instructions" };
      },
    } satisfies Tool);
    const executor = new TaskProviderSubagentExecutor({
      provider,
      model: "test-model",
      runnerTools: tools,
      maxIterations: 3,
    });
    const completions: Array<{ status: string; result?: string | null }> = [];

    await executor.spawnSubtask(requestFor("a", "Inspect", completions), "trace-1");
    await waitFor(() => completions.length === 1);

    expect(toolCalls).toEqual([{ path: "AGENTS.md" }]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.messages).toEqual([
      expect.objectContaining({ role: "system", content: expect.stringContaining("focused task execution subagent") }),
      expect.objectContaining({ role: "user", content: "Execute subtask: Inspect" }),
      expect.objectContaining({ role: "assistant", toolCalls: expect.any(Array) }),
      expect.objectContaining({ role: "tool", content: "file contains migration instructions", name: "inspect_file" }),
    ]);
    expect(completions).toEqual([{ status: "completed", result: "inspection used tool result" }]);
  });

  test("cancels queued and active subagents for a task plan", async () => {
    const first = deferred<ModelResponse>();
    const provider = new QueueProvider([first.promise]);
    const executor = new TaskProviderSubagentExecutor({
      provider,
      maxConcurrent: 1,
      timeoutMs: 1000,
      idGenerator: (() => {
        let index = 0;
        return () => `subagent-${index += 1}`;
      })(),
    });
    const completions: Array<{ status: string; result?: string | null; error?: string | null }> = [];

    await executor.spawnSubtask(requestFor("a", "Inspect", completions), "trace-1");
    await executor.spawnSubtask(requestFor("b", "Implement", completions), "trace-1");
    await waitFor(() => provider.requests.length === 1);

    await expect(executor.cancelPlan(plan())).resolves.toBe(2);
    await waitFor(() => completions.length === 1);

    expect(completions).toEqual([
      { status: "failed", result: "Subagent cancelled.", error: "Subagent cancelled." },
    ]);
  });
});

class QueueProvider implements ModelProvider {
  readonly requests: Array<{ messages: AgentMessage[]; options?: ModelRequestOptions }> = [];

  constructor(private readonly responses: Array<Promise<ModelResponse>>) {}

  async complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    this.requests.push({ messages, options });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("unexpected provider request");
    }
    return response;
  }
}

function requestFor(
  id: string,
  title: string,
  completions: Array<{ status: string; result?: string | null }>,
): SpawnSubtaskRequest {
  const taskPlan = plan();
  const subtask = { ...taskPlan.subtasks[0], id, title };
  return {
    plan: taskPlan,
    subtask,
    label: title,
    task: `Execute subtask: ${title}`,
    onComplete: async (completion) => {
      completions.push(completion);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, attempts = 20): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not met");
}
