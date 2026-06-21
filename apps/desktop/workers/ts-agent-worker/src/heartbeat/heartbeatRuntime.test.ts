import { describe, expect, test, vi } from "vitest";

import type { AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { HeartbeatRuntime } from "./heartbeatRuntime";

class QueueProvider implements ModelProvider {
  readonly options: Array<ModelRequestOptions | undefined> = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(_messages: unknown[], options?: ModelRequestOptions): Promise<ModelResponse> {
    this.options.push(options);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

describe("HeartbeatRuntime", () => {
  test("runs heartbeat tasks through AgentRunner with the heartbeat session and trims the session", async () => {
    const runnerCalls: AgentRunSpec[] = [];
    const trimHeartbeatSession = vi.fn();
    const runtime = new HeartbeatRuntime({
      model: "gpt-heartbeat",
      provider: new QueueProvider([heartbeatDecision("Review stalled task.")]),
      currentTime: () => "2026-06-13 10:00 CST",
      readHeartbeatFile: async () => "- [ ] Review stalled task.",
      selectTarget: () => ({ channel: "feishu", chatId: "chat-1", external: true }),
      runner: {
        run: async (spec) => {
          runnerCalls.push(spec);
          return agentResult("Heartbeat handled.");
        },
      },
      trimHeartbeatSession,
      keepRecentMessages: 6,
      idGenerator: () => "heartbeat-run-1",
    });

    await expect(runtime.triggerNow()).resolves.toEqual({
      status: "executed",
      tasks: "Review stalled task.",
      response: "Heartbeat handled.",
    });

    expect(runnerCalls).toHaveLength(1);
    expect(runnerCalls[0]).toMatchObject({
      runId: "heartbeat-run-1",
      traceId: "trace-heartbeat-run-1",
      sessionId: "heartbeat",
      model: "gpt-heartbeat",
      maxIterations: 4,
      stream: false,
      messages: [{ role: "user", content: "Review stalled task." }],
      metadata: {
        source: "heartbeat",
        channel: "feishu",
        chatId: "chat-1",
      },
    });
    expect(trimHeartbeatSession).toHaveBeenCalledWith(6);
  });

  test("resolves the heartbeat model at execution time", async () => {
    const runnerCalls: AgentRunSpec[] = [];
    const runtime = new HeartbeatRuntime({
      model: async () => "deepseek-v4-flash",
      provider: new QueueProvider([heartbeatDecision("Review configured model.")]),
      currentTime: () => "2026-06-13 10:00 CST",
      readHeartbeatFile: async () => "- [ ] Review configured model.",
      selectTarget: () => ({ channel: "feishu", chatId: "chat-1", external: true }),
      runner: {
        run: async (spec) => {
          runnerCalls.push(spec);
          return agentResult("Heartbeat handled.");
        },
      },
      idGenerator: () => "heartbeat-run-configured",
    });

    await expect(runtime.triggerNow()).resolves.toMatchObject({ status: "executed" });

    expect(runnerCalls[0]?.model).toBe("deepseek-v4-flash");
  });

  test("notifies the current external target after evaluator approval", async () => {
    const notifyExternal = vi.fn();
    const runtime = new HeartbeatRuntime({
      model: "gpt-heartbeat",
      provider: new QueueProvider([heartbeatDecision("Report important finding.")]),
      currentTime: () => "now",
      readHeartbeatFile: async () => "- [ ] Report important finding.",
      selectTarget: vi.fn()
        .mockReturnValueOnce({ channel: "websocket", chatId: "execute-chat", external: true })
        .mockReturnValueOnce({ channel: "feishu", chatId: "notify-chat", external: true }),
      runner: { run: async () => agentResult("Important finding.") },
      evaluateResponse: async () => true,
      notifyExternal,
      idGenerator: () => "heartbeat-run-2",
    });

    await expect(runtime.tick()).resolves.toEqual({
      status: "notified",
      tasks: "Report important finding.",
      response: "Important finding.",
    });
    expect(notifyExternal).toHaveBeenCalledWith({
      channel: "feishu",
      chatId: "notify-chat",
      content: "Important finding.",
      tasks: "Report important finding.",
    });
  });

  test("uses the Python-compatible evaluator by default before notifying", async () => {
    const notifyExternal = vi.fn();
    const provider = new QueueProvider([
      heartbeatDecision("Report routine heartbeat status."),
      {
        content: "",
        stopReason: "tool_calls",
        toolCalls: [{
          id: "evaluate-call",
          name: "evaluate_notification",
          argumentsJson: JSON.stringify({ should_notify: false, reason: "routine" }),
        }],
      },
    ]);
    const runtime = new HeartbeatRuntime({
      model: "gpt-heartbeat",
      provider,
      currentTime: () => "now",
      readHeartbeatFile: async () => "- [ ] Report routine heartbeat status.",
      selectTarget: () => ({ channel: "feishu", chatId: "notify-chat", external: true }),
      runner: { run: async () => agentResult("Routine heartbeat status.") },
      notifyExternal,
      idGenerator: () => "heartbeat-run-4",
    });

    await expect(runtime.tick()).resolves.toEqual({
      status: "silenced",
      tasks: "Report routine heartbeat status.",
      response: "Routine heartbeat status.",
    });
    expect(provider.options[1]).toMatchObject({
      model: "gpt-heartbeat",
      tools: [expect.objectContaining({ name: "evaluate_notification" })],
      toolChoice: { type: "function", function: { name: "evaluate_notification" } },
      maxTokens: 256,
      temperature: 0,
    });
    expect(notifyExternal).not.toHaveBeenCalled();
  });

  test("does not notify when the current target falls back to cli direct", async () => {
    const notifyExternal = vi.fn();
    const runtime = new HeartbeatRuntime({
      model: "gpt-heartbeat",
      provider: new QueueProvider([heartbeatDecision("Check important status.")]),
      currentTime: () => "now",
      readHeartbeatFile: async () => "- [ ] Check important status.",
      selectTarget: () => ({ channel: "cli", chatId: "direct", external: false }),
      runner: { run: async () => agentResult("Important status.") },
      evaluateResponse: async () => true,
      notifyExternal,
      idGenerator: () => "heartbeat-run-3",
    });

    await expect(runtime.tick()).resolves.toEqual({
      status: "executed",
      tasks: "Check important status.",
      response: "Important status.",
    });
    expect(notifyExternal).not.toHaveBeenCalled();
  });
});

function heartbeatDecision(tasks: string): ModelResponse {
  return {
    content: "",
    stopReason: "tool_calls",
    toolCalls: [{
      id: "heartbeat-call",
      name: "heartbeat",
      argumentsJson: JSON.stringify({ action: "run", tasks }),
    }],
  };
}

function agentResult(finalContent: string): AgentRunResult {
  return {
    finalContent,
    messages: [{ role: "assistant", content: finalContent }],
    toolsUsed: [],
    stopReason: "final_response",
  };
}
