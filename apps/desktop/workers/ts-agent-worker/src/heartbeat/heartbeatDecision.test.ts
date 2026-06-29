import { describe, expect, test } from "vitest";

import type { AgentMessage } from "../agent/agentRunSpec";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider";
import { decideHeartbeat } from "./heartbeatDecision";

class QueueProvider implements ModelProvider {
  readonly messages: AgentMessage[][] = [];
  readonly options: Array<ModelRequestOptions | undefined> = [];

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    this.messages.push(messages);
    this.options.push(options);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("no queued model response");
    }
    return response;
  }
}

describe("heartbeat decision", () => {
  test("asks the provider to choose skip or run with the legacy-compatible heartbeat tool", async () => {
    const provider = new QueueProvider([{
      content: "",
      stopReason: "tool_calls",
      toolCalls: [{
        id: "heartbeat-1",
        name: "heartbeat",
        argumentsJson: JSON.stringify({
          action: "run",
          tasks: "Review overdue follow-ups.",
        }),
      }],
    }]);

    await expect(decideHeartbeat({
      provider,
      model: "fixture-model",
      content: "- [ ] Review overdue follow-ups.",
      currentTime: "2026-06-13 09:30 CST",
    })).resolves.toEqual({
      action: "run",
      tasks: "Review overdue follow-ups.",
    });

    expect(provider.messages).toEqual([[
      {
        role: "system",
        content: "You are a heartbeat agent. Call the heartbeat tool to report your decision.",
      },
      {
        role: "user",
        content: [
          "Current Time: 2026-06-13 09:30 CST",
          "",
          "Review the following HEARTBEAT.md and decide whether there are active tasks.",
          "",
          "- [ ] Review overdue follow-ups.",
        ].join("\n"),
      },
    ]]);
    expect(provider.options[0]).toMatchObject({
      model: "fixture-model",
      tools: [{
        name: "heartbeat",
        description: "Report heartbeat decision after reviewing tasks.",
        parameters: {
          type: "object",
          required: ["action"],
        },
      }],
    });
  });

  test("defaults to skip when the heartbeat tool call is missing or unsafe", async () => {
    await expect(decideHeartbeat({
      provider: new QueueProvider([{ content: "no tool", stopReason: "stop", toolCalls: [] }]),
      model: "fixture-model",
      content: "active tasks",
      currentTime: "now",
    })).resolves.toEqual({ action: "skip", tasks: "" });

    await expect(decideHeartbeat({
      provider: new QueueProvider([{
        content: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "heartbeat-1", name: "heartbeat", argumentsJson: "{\"action\":\"wait\",\"tasks\":\"later\"}" }],
      }]),
      model: "fixture-model",
      content: "active tasks",
      currentTime: "now",
    })).resolves.toEqual({ action: "skip", tasks: "" });

    await expect(decideHeartbeat({
      provider: new QueueProvider([{
        content: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "heartbeat-1", name: "heartbeat", argumentsJson: "{\"action\":\"run\",\"tasks\":\"   \"}" }],
      }]),
      model: "fixture-model",
      content: "active tasks",
      currentTime: "now",
    })).resolves.toEqual({ action: "skip", tasks: "" });
  });
});
