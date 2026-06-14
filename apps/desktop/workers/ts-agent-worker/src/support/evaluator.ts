import type { TemplateRegistry } from "./templates.ts";
import { renderTemplate } from "./templates.ts";
import type { ModelProvider, ToolDefinition } from "../model/provider.ts";

export const DEFAULT_EVALUATOR_TEMPLATES = {
  "agent/evaluator.md": [
    "{% if part == 'system' %}",
    "You are a notification gate for a background agent. You will be given the original task and the agent's response. Call the evaluate_notification tool to decide whether the user should be notified.",
    "",
    "Notify when the response contains actionable information, errors, completed deliverables, or anything the user explicitly asked to be reminded about.",
    "",
    "Suppress when the response is a routine status check with nothing new, a confirmation that everything is normal, or essentially empty.",
    "{% elif part == 'user' %}",
    "## Original task",
    "{{ task_context }}",
    "",
    "## Agent response",
    "{{ response }}",
    "{% endif %}",
  ].join("\n"),
};

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

export const EVALUATE_NOTIFICATION_TOOL_DEFINITION: ToolDefinition = {
  name: EVALUATE_NOTIFICATION_TOOL.function.name,
  description: EVALUATE_NOTIFICATION_TOOL.function.description,
  parameters: EVALUATE_NOTIFICATION_TOOL.function.parameters,
};

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

export async function evaluateNotificationDecision(input: {
  provider: ModelProvider;
  model: string;
  taskContext: string;
  response: string;
  templates?: TemplateRegistry;
}): Promise<{ shouldNotify: boolean; reason: string }> {
  try {
    const response = await input.provider.complete(buildEvaluatorMessages({
      templates: input.templates ?? DEFAULT_EVALUATOR_TEMPLATES,
      taskContext: input.taskContext,
      response: input.response,
    }), {
      model: input.model,
      tools: [EVALUATE_NOTIFICATION_TOOL_DEFINITION],
      toolChoice: { type: "function", function: { name: "evaluate_notification" } },
      maxTokens: 256,
      temperature: 0,
    });
    return parseEvaluatorDecision({ toolCalls: response.toolCalls });
  } catch {
    return { shouldNotify: true, reason: "evaluator_failed" };
  }
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
