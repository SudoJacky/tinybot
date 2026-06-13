import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider, ToolCallRequest, ToolDefinition } from "../model/provider.ts";
import type { HeartbeatDecision } from "./heartbeatTypes.ts";

export const HEARTBEAT_TOOL_DEFINITION: ToolDefinition = {
  name: "heartbeat",
  description: "Report heartbeat decision after reviewing tasks.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["skip", "run"],
        description: "skip = nothing to do, run = has active tasks",
      },
      tasks: {
        type: "string",
        description: "Natural-language summary of active tasks (required for run)",
      },
    },
    required: ["action"],
  },
};

export async function decideHeartbeat(input: {
  provider: ModelProvider;
  model: string;
  content: string;
  currentTime: string;
}): Promise<HeartbeatDecision> {
  const response = await input.provider.complete(heartbeatDecisionMessages(input), {
    model: input.model,
    tools: [HEARTBEAT_TOOL_DEFINITION],
  });
  return parseHeartbeatDecision(response.toolCalls);
}

export function heartbeatDecisionMessages(input: {
  content: string;
  currentTime: string;
}): AgentMessage[] {
  return [
    {
      role: "system",
      content: "You are a heartbeat agent. Call the heartbeat tool to report your decision.",
    },
    {
      role: "user",
      content: [
        `Current Time: ${input.currentTime}`,
        "",
        "Review the following HEARTBEAT.md and decide whether there are active tasks.",
        "",
        input.content,
      ].join("\n"),
    },
  ];
}

export function parseHeartbeatDecision(toolCalls: ToolCallRequest[] | undefined): HeartbeatDecision {
  const toolCall = toolCalls?.find((call) => call.name === "heartbeat");
  if (!toolCall) {
    return skipDecision();
  }
  const args = parseToolArguments(toolCall.argumentsJson);
  if (!args) {
    return skipDecision();
  }
  const action = args.action === "run" ? "run" : args.action === "skip" ? "skip" : undefined;
  if (action !== "run") {
    return skipDecision();
  }
  const tasks = typeof args.tasks === "string" ? args.tasks.trim() : "";
  if (!tasks) {
    return skipDecision();
  }
  return { action, tasks };
}

function parseToolArguments(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function skipDecision(): HeartbeatDecision {
  return { action: "skip", tasks: "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
