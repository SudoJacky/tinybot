import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { TaskPlanner } from "./taskPlanner";

class RecordingProvider implements ModelProvider {
  readonly requests: Array<{ messages: AgentMessage[]; options?: ModelRequestOptions }> = [];

  constructor(private readonly response: ModelResponse) {}

  async complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    this.requests.push({ messages, options });
    return this.response;
  }
}

describe("TaskPlanner", () => {
  test("creates a task plan from submit_plan tool call and records DAG errors", async () => {
    const provider = new RecordingProvider({
      content: "",
      stopReason: "tool_calls",
      toolCalls: [
        {
          id: "call-plan",
          name: "submit_plan",
          argumentsJson: JSON.stringify({
            title: "Backend migration",
            subtasks: [
              {
                id: "inspect",
                title: "Inspect legacy runtime",
                description: "Read legacy implementation",
                dependencies: [],
                parallel_safe: true,
              },
              {
                id: "port",
                title: "Port runtime",
                description: "Move behavior to TS",
                dependencies: ["missing"],
                parallel_safe: false,
              },
            ],
          }),
        },
      ],
    });
    const planner = new TaskPlanner({
      provider,
      model: "test-model",
      workspace: "D:/Code/tinybot/tinybot",
      planIdGenerator: () => "plan-1",
      now: () => "2026-06-12T00:00:00.000Z",
      planningStrategy: () => "[PLANNING STRATEGY]\nUse prior workflow.",
    });

    const plan = await planner.createPlan(
      "Move task planning to TS",
      { channel: "desktop", chatId: "chat-1" },
      "trace-1",
    );

    expect(plan).toMatchObject({
      id: "plan-1",
      title: "Backend migration",
      originalRequest: "Move task planning to TS",
      status: "planning",
      createdAt: "2026-06-12T00:00:00.000Z",
      updatedAt: "2026-06-12T00:00:00.000Z",
      context: {
        channel: "desktop",
        chatId: "chat-1",
        sessionKey: "desktop:chat-1",
        dagErrors: ["Subtask 'port' depends on non-existent 'missing'"],
      },
    });
    expect(plan.subtasks).toEqual([
      expect.objectContaining({ id: "inspect", title: "Inspect legacy runtime", parallelSafe: true }),
      expect.objectContaining({ id: "port", title: "Port runtime", dependencies: ["missing"], parallelSafe: false }),
    ]);
    expect(provider.requests[0]?.messages[1]?.content).toContain("[PLANNING STRATEGY]");
    expect(provider.requests[0]?.messages[1]?.content).toContain("Workspace: D:/Code/tinybot/tinybot");
    expect(provider.requests[0]?.options?.tools?.[0]?.name).toBe("submit_plan");
    expect(provider.requests[0]?.options?.toolChoice).toEqual({ type: "function", function: { name: "submit_plan" } });
  });

  test("falls back to a single subtask when the model does not submit a plan", async () => {
    const provider = new RecordingProvider({ content: "plain text", toolCalls: [], stopReason: "stop" });
    const planner = new TaskPlanner({
      provider,
      model: "test-model",
      planIdGenerator: () => "plan-fallback",
      now: () => "2026-06-12T00:00:00.000Z",
    });

    const plan = await planner.createPlan(
      "Review migration status and propose the next slice",
      { channel: "cli", chatId: "session-1" },
      "trace-fallback",
    );

    expect(plan).toMatchObject({
      id: "plan-fallback",
      title: "Review migration status and propose the next slice",
      context: { channel: "cli", chatId: "session-1", sessionKey: "cli:session-1" },
    });
    expect(plan.subtasks).toEqual([
      expect.objectContaining({
        id: "1",
        title: "Review migration status and pr",
        description: "Review migration status and propose the next slice",
        dependencies: [],
      }),
    ]);
  });
});
