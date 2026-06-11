import type { TemplateRegistry } from "./templates.ts";
import { renderTemplate } from "./templates.ts";

export const EVALUATE_NOTIFICATION_TOOL = {
  type: "function",
  function: {
    name: "evaluate_notification",
    description: "Decide whether the user should be notified about this background task result.",
    parameters: {
      type: "object",
      properties: {
        should_notify: {
          type: "boolean",
          description:
            "true = result contains actionable/important info the user should see; false = routine or empty, safe to suppress",
        },
        reason: {
          type: "string",
          description: "One-sentence reason for the decision",
        },
      },
      required: ["should_notify"],
    },
  },
} as const;

export type EvaluatorMessage = {
  role: "system" | "user";
  content: string;
};

export type EvaluatorToolCall = {
  name?: string;
  arguments?: Record<string, unknown>;
  argumentsJson?: string;
  arguments_json?: string;
};

export function buildEvaluatorMessages(input: {
  templates: TemplateRegistry;
  taskContext: string;
  response: string;
}): EvaluatorMessage[] {
  return [
    {
      role: "system",
      content: renderTemplate("agent/evaluator.md", {
        templates: input.templates,
        strip: true,
        variables: { part: "system" },
      }),
    },
    {
      role: "user",
      content: renderTemplate("agent/evaluator.md", {
        templates: input.templates,
        strip: true,
        variables: {
          part: "user",
          task_context: input.taskContext,
          response: input.response,
        },
      }),
    },
  ];
}

export function parseEvaluatorDecision(input: {
  toolCalls?: EvaluatorToolCall[];
}): { shouldNotify: boolean; reason: string } {
  const toolCall = input.toolCalls?.find((call) => call.name === "evaluate_notification");
  if (!toolCall) {
    return { shouldNotify: true, reason: "missing_tool_call" };
  }
  const args = toolArguments(toolCall);
  if (!args) {
    return { shouldNotify: true, reason: "invalid_tool_arguments" };
  }
  return {
    shouldNotify: booleanValue(args.should_notify, true),
    reason: typeof args.reason === "string" ? args.reason : "",
  };
}

function toolArguments(toolCall: EvaluatorToolCall): Record<string, unknown> | undefined {
  if (toolCall.arguments && isRecord(toolCall.arguments)) {
    return toolCall.arguments;
  }
  const raw = toolCall.argumentsJson ?? toolCall.arguments_json;
  if (typeof raw !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
