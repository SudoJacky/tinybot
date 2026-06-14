import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider, ToolDefinition } from "../model/provider.ts";
import { normalizeTaskPlan, validateTaskDag } from "./taskDag.ts";
import type { SubTaskInput, TaskPlan } from "./taskTypes.ts";

export interface TaskPlanContext {
  channel: string;
  chatId: string;
  sessionKey?: string;
}

export interface TaskPlannerOptions {
  provider: ModelProvider;
  model?: string;
  workspace?: string;
  planIdGenerator?: () => string;
  subtaskIdGenerator?: () => string;
  now?: () => string;
  planningStrategy?: (request: string) => string;
}

export class TaskPlanner {
  private readonly provider: ModelProvider;
  private readonly model?: string;
  private readonly workspace: string;
  private readonly planIdGenerator: () => string;
  private readonly subtaskIdGenerator: () => string;
  private readonly now: () => string;
  private readonly planningStrategy: (request: string) => string;

  constructor(options: TaskPlannerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.workspace = options.workspace ?? process.cwd();
    this.planIdGenerator = options.planIdGenerator ?? randomPlanId;
    this.subtaskIdGenerator = options.subtaskIdGenerator ?? randomSubtaskId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.planningStrategy = options.planningStrategy ?? (() => "");
  }

  async createPlan(request: string, context: TaskPlanContext, traceId: string): Promise<TaskPlan> {
    void traceId;
    const response = await this.provider.complete(this.messagesFor(request), {
      model: this.model,
      tools: [SUBMIT_PLAN_TOOL],
      toolChoice: { type: "function", function: { name: "submit_plan" } },
    });
    const submitted = this.parseSubmittedPlan(response.toolCalls.find((toolCall) => toolCall.name === "submit_plan")?.argumentsJson);
    const timestamp = this.now();
    const subtasks = submitted.subtasks.length > 0
      ? submitted.subtasks
      : [fallbackSubtask(request)];
    const plan = normalizeTaskPlan({
      id: this.planIdGenerator(),
      title: submitted.title || request.slice(0, 50),
      originalRequest: request,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "planning",
      currentSubtaskIds: [],
      context: {
        channel: context.channel,
        chatId: context.chatId,
        sessionKey: context.sessionKey ?? `${context.channel}:${context.chatId}`,
      },
      subtasks,
    });
    const dagErrors = validateTaskDag(plan);
    if (dagErrors.length > 0) {
      plan.context = { ...plan.context, dagErrors };
    }
    return plan;
  }

  private messagesFor(request: string): AgentMessage[] {
    const strategy = this.planningStrategy(request).trim();
    const userContent = [
      strategy,
      `Workspace: ${this.workspace}`,
      `Request: ${request}`,
    ].filter(Boolean).join("\n\n");
    return [
      {
        role: "system",
        content: [
          "Decompose the user's request into a concise task plan.",
          "Return the plan by calling submit_plan. Keep dependencies as subtask IDs.",
        ].join("\n"),
      },
      { role: "user", content: userContent },
    ];
  }

  private parseSubmittedPlan(argumentsJson: string | undefined): { title: string; subtasks: SubTaskInput[] } {
    const payload = parseJsonObject(argumentsJson);
    const rawSubtasks = Array.isArray(payload?.subtasks) ? payload.subtasks : [];
    return {
      title: typeof payload?.title === "string" ? payload.title : "",
      subtasks: rawSubtasks
        .map((subtask) => asSubtaskInput(subtask, this.subtaskIdGenerator))
        .filter((subtask): subtask is SubTaskInput => subtask !== null),
    };
  }
}

const SUBMIT_PLAN_TOOL: ToolDefinition = {
  name: "submit_plan",
  description: "Submit a decomposed task plan.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      subtasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            dependencies: { type: "array", items: { type: "string" } },
            parallel_safe: { type: "boolean" },
          },
          required: ["title", "description"],
        },
      },
    },
    required: ["title", "subtasks"],
  },
};

function asSubtaskInput(value: unknown, fallbackId: () => string): SubTaskInput | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : "Untitled";
  const description = typeof record.description === "string" ? record.description : "";
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : fallbackId();
  const dependencies = Array.isArray(record.dependencies)
    ? record.dependencies.filter((dependency): dependency is string => typeof dependency === "string")
    : [];
  return {
    id,
    title,
    description,
    dependencies,
    parallel_safe: typeof record.parallel_safe === "boolean" ? record.parallel_safe : true,
  };
}

function fallbackSubtask(request: string): SubTaskInput {
  return {
    id: "1",
    title: request.slice(0, 30),
    description: request,
    dependencies: [],
    parallel_safe: true,
  };
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function randomPlanId(): string {
  return Math.random().toString(16).slice(2, 10);
}

function randomSubtaskId(): string {
  return Math.random().toString(16).slice(2, 6);
}
