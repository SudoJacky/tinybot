import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import { previewBlueprint, validateBlueprint } from "./coworkBlueprint.ts";
import type { CoworkScheduler } from "./coworkScheduler.ts";
import { type CoworkService } from "./coworkService.ts";
import type { CoworkAgentInput, CoworkTaskInput } from "./coworkService.ts";
import type { CoworkTeamPlanner } from "./coworkTeamPlanner.ts";
import type { CoworkSession, CoworkTask } from "./coworkTypes.ts";

const COWORK_ACTIONS = [
  "start",
  "status",
  "list",
  "send_message",
  "add_task",
  "assign_task",
  "run",
  "pause",
  "resume",
  "summary",
  "export_blueprint",
  "validate_blueprint",
  "preview_blueprint",
] as const;

type CoworkAction = typeof COWORK_ACTIONS[number];

export type CoworkToolOptions = {
  service: CoworkService;
  planner?: CoworkTeamPlanner;
  scheduler?: CoworkScheduler;
};

export function createCoworkTool(options: CoworkToolOptions): Tool {
  return {
    name: "cowork",
    description: [
      "Create and manage dynamic multi-agent cowork sessions.",
      "Native TS currently supports session creation from explicit input or blueprint, status/list, messages, tasks, pause/resume, summary, and blueprint export.",
      "Native TS scheduler runs currently record scheduling state and stop before agent execution until Cowork agent runtime migration is complete.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: COWORK_ACTIONS },
        goal: { type: "string" },
        workflow_mode: { type: "string" },
        architecture: { type: "string" },
        session_id: { type: "string" },
        recipient_ids: { type: "array", items: { type: "string" } },
        content: { type: "string" },
        thread_id: { type: "string" },
        topic: { type: "string" },
        event_type: { type: "string" },
        title: { type: "string" },
        task_id: { type: "string" },
        description: { type: "string" },
        assigned_agent_id: { type: "string" },
        dependencies: { type: "array", items: { type: "string" } },
        auto_run: { type: "boolean", default: false },
        max_rounds: { type: "integer", minimum: 1, maximum: 20 },
        max_agents: { type: "integer", minimum: 1, maximum: 50 },
        max_agent_calls: { type: "integer", minimum: 1, maximum: 500 },
        run_until_idle: { type: "boolean", default: false },
        stop_on_blocker: { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        blueprint: { type: "object" },
        agents: { type: "array", items: { type: "object" } },
        tasks: { type: "array", items: { type: "object" } },
      },
      required: ["action"],
    },
    concurrencySafe: false,
    capabilities: ["cowork.read", "cowork.write"],
    execute: async (args, context) => executeCoworkAction(options, args, context),
  };
}

async function executeCoworkAction(
  options: CoworkToolOptions,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  const service = options.service;
  const action = stringArg(args, "action") as CoworkAction;
  switch (action) {
    case "validate_blueprint":
      return { content: JSON.stringify(validateBlueprint(objectArg(args, "blueprint") ?? args), null, 2) };
    case "preview_blueprint":
      return { content: JSON.stringify(previewBlueprint(objectArg(args, "blueprint") ?? args), null, 2) };
    case "start":
      return startSession(options, args, context);
    case "list":
      return listSessions(service, args, context);
    case "status":
      return sessionResult(service, args, context, async (session) => ({ content: formatStatus(session, booleanArg(args, "verbose")) }));
    case "summary":
      return summaryResult(service, args, context);
    case "export_blueprint":
      return exportBlueprintResult(service, args, context);
    case "pause":
      return controlResult(service, args, context, "pause");
    case "resume":
      return controlResult(service, args, context, "resume");
    case "send_message":
      return sendMessageResult(service, args, context);
    case "add_task":
      return addTaskResult(service, args, context);
    case "assign_task":
      return assignTaskResult(service, args, context);
    case "run":
      return runSessionResult(options, args, context);
    default:
      return { content: `Error: unknown action '${String(args.action)}'` };
  }
}

async function startSession(options: CoworkToolOptions, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const service = options.service;
  const blueprint = objectArg(args, "blueprint");
  const traceId = traceIdFrom(context);
  if (blueprint) {
    const result = await service.createSessionFromBlueprint({
      traceId,
      blueprint,
      runtimeState: originRuntimeState(context),
    });
    if (!result.session) {
      return { content: `Error: blueprint validation failed\n${JSON.stringify(result.diagnostics, null, 2)}` };
    }
    const run = booleanArg(args, "auto_run")
      ? await runSession(options, result.session.id, args, context)
      : undefined;
    return {
      content: [
        `Cowork session started from blueprint: ${result.session.id}`,
        "",
        formatStatus(result.session, true),
        ...(run ? ["", "Run Result", run.result] : []),
      ].join("\n"),
      metadata: {
        session_id: result.session.id,
        action: "start",
        ...(run ? { run_id: run.runId, deferred_run: false } : {}),
      },
    };
  }

  const goal = stringArg(args, "goal");
  if (!goal) {
    return { content: "Error: goal is required for cowork start" };
  }
  const explicitAgents = objectArrayArg<CoworkAgentInput>(args, "agents");
  const explicitTasks = objectArrayArg<CoworkTaskInput>(args, "tasks");
  const planned = !explicitAgents && !explicitTasks && options.planner
    ? await options.planner.plan(goal, stringArg(args, "architecture") || stringArg(args, "workflow_mode"))
    : undefined;
  const session = await service.createSession({
    traceId,
    goal,
    title: stringArg(args, "title") || planned?.title,
    workflowMode: stringArg(args, "architecture") || stringArg(args, "workflow_mode"),
    agents: explicitAgents ?? planned?.agents,
    tasks: explicitTasks ?? planned?.tasks,
    runtimeState: originRuntimeState(context),
  });
  const run = booleanArg(args, "auto_run")
    ? await runSession(options, session.id, args, context)
    : undefined;
  return {
    content: [
      `Cowork session started: ${session.id}`,
      "",
      formatStatus(session, true),
      ...(run ? ["", "Run Result", run.result] : []),
    ].join("\n"),
    metadata: {
      session_id: session.id,
      action: "start",
      deferred_run: Boolean(booleanArg(args, "auto_run") && !run?.runId),
      ...(run ? { run_id: run.runId } : {}),
    },
  };
}

async function runSessionResult(options: CoworkToolOptions, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const run = await runSession(options, sessionId, args, context);
  return {
    content: run.result,
    metadata: {
      session_id: sessionId,
      action: "run",
      ...(run.runId ? { run_id: run.runId } : {}),
      ...(run.deferred ? { deferred: true, reason: "cowork_scheduler" } : {}),
    },
  };
}

async function runSession(
  options: CoworkToolOptions,
  sessionId: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<{ result: string; runId?: string; deferred?: boolean }> {
  if (!options.scheduler) {
    return {
      result: "Cowork run is not available in the native TS runtime yet. Scheduler and agent runtime migration are still pending.",
      deferred: true,
    };
  }
  const result = await options.scheduler.runSession({
    traceId: traceIdFrom(context),
    sessionId,
    maxRounds: numberArg(args, "max_rounds"),
    maxAgents: numberArg(args, "max_agents"),
    maxAgentCalls: numberArg(args, "max_agent_calls"),
    runUntilIdle: booleanArg(args, "run_until_idle"),
    stopOnBlocker: booleanArg(args, "stop_on_blocker"),
  });
  return {
    result: result.result,
    runId: result.runId,
  };
}

async function listSessions(service: CoworkService, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const sessions = await service.listSessions(traceIdFrom(context), { includeCompleted: booleanArg(args, "verbose") });
  if (sessions.length === 0) {
    return { content: "No cowork sessions." };
  }
  return {
    content: sessions.map((session) => `- ${session.id}: ${session.title} [${session.status}] updated=${session.updated_at}`).join("\n"),
  };
}

async function summaryResult(service: CoworkService, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const summary = await service.formatSummary({ traceId: traceIdFrom(context), sessionId });
  return {
    content: summary,
    metadata: { session_id: sessionId, action: "summary" },
  };
}

async function exportBlueprintResult(service: CoworkService, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const blueprint = await service.exportBlueprint({ traceId: traceIdFrom(context), sessionId });
  return {
    content: JSON.stringify(blueprint, null, 2),
    metadata: { session_id: sessionId, action: "export_blueprint" },
  };
}

async function controlResult(
  service: CoworkService,
  args: Record<string, unknown>,
  context: ToolContext,
  action: "pause" | "resume",
): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const result = action === "pause"
    ? await service.pauseSession({ traceId: traceIdFrom(context), sessionId })
    : await service.resumeSession({ traceId: traceIdFrom(context), sessionId });
  return {
    content: result.result,
    metadata: { session_id: sessionId, action },
  };
}

async function sendMessageResult(service: CoworkService, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const content = stringArg(args, "content");
  if (!content) {
    return { content: "Error: content is required" };
  }
  const recipientIds = stringListArg(args, "recipient_ids");
  const result = await service.deliverEnvelope({
    traceId: traceIdFrom(context),
    sessionId,
    envelope: {
      sender_id: "user",
      recipient_ids: recipientIds,
      content,
      thread_id: stringArg(args, "thread_id"),
      visibility: recipientIds.length > 0 ? "direct" : "group",
      kind: "message",
      topic: stringArg(args, "topic"),
      event_type: stringArg(args, "event_type"),
    },
  });
  const messageId = typeof result.message.id === "string" ? result.message.id : "";
  return {
    content: `Sent message ${messageId}.`,
    metadata: { session_id: sessionId, message_id: messageId, action: "send_message" },
  };
}

async function addTaskResult(service: CoworkService, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const title = stringArg(args, "title");
  if (!title) {
    return { content: "Error: title is required" };
  }
  const result = await service.addTask({
    traceId: traceIdFrom(context),
    sessionId,
    title,
    description: stringArg(args, "description") || title,
    assignedAgentId: stringArg(args, "assigned_agent_id"),
    dependencies: stringListArg(args, "dependencies"),
  });
  return {
    content: `Added task ${result.task.id}: ${result.task.title}`,
    metadata: { session_id: sessionId, task_id: result.task.id, action: "add_task" },
  };
}

async function assignTaskResult(service: CoworkService, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const taskId = stringArg(args, "task_id");
  if (!taskId) {
    return { content: "Error: task_id is required" };
  }
  const assignedAgentId = stringArg(args, "assigned_agent_id");
  if (!assignedAgentId) {
    return { content: "Error: assigned_agent_id is required" };
  }
  const result = await service.assignTask({
    traceId: traceIdFrom(context),
    sessionId,
    taskId,
    agentId: assignedAgentId,
  });
  return {
    content: result.result,
    metadata: { session_id: sessionId, task_id: taskId, action: "assign_task" },
  };
}

async function sessionResult(
  service: CoworkService,
  args: Record<string, unknown>,
  context: ToolContext,
  render: (session: CoworkSession) => Promise<ToolResult>,
): Promise<ToolResult> {
  const sessionId = requiredSessionId(args);
  if (typeof sessionId !== "string") {
    return sessionId;
  }
  const session = await service.getSession(sessionId, traceIdFrom(context));
  if (!session) {
    return { content: `Error: cowork session '${sessionId}' not found` };
  }
  return render(session);
}

function formatStatus(session: CoworkSession, verbose: boolean): string {
  const tasks = Object.values(session.tasks);
  const agents = Object.values(session.agents);
  const lines = [
    `## ${session.title} (${session.id})`,
    `Status: ${session.status}`,
    `Goal: ${session.goal}`,
    `Workflow: ${session.workflow_mode}`,
    `Current branch: ${session.current_branch_id}`,
    `Tasks: ${taskStatusCounts(tasks)}`,
    `Agents: ${agents.map((agent) => `${agent.name}:${agent.status}`).join(", ") || "(none)"}`,
  ];
  if (session.current_focus_task) {
    lines.push(`Current focus: ${session.current_focus_task}`);
  }
  if (session.final_draft) {
    lines.push("", "### Final Draft", session.final_draft);
  }
  if (verbose && tasks.length > 0) {
    lines.push("", "### Tasks", ...tasks.map(formatTaskLine));
  }
  return lines.join("\n");
}

function taskStatusCounts(tasks: CoworkTask[]): string {
  if (tasks.length === 0) {
    return "none";
  }
  const counts = new Map<string, number>();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ");
}

function formatTaskLine(task: CoworkTask): string {
  const assignee = task.assigned_agent_id ? ` -> ${task.assigned_agent_id}` : "";
  return `- ${task.id}: ${task.title} [${task.status}]${assignee}`;
}

function requiredSessionId(args: Record<string, unknown>): string | ToolResult {
  const sessionId = stringArg(args, "session_id");
  return sessionId || { content: "Error: session_id is required" };
}

function traceIdFrom(context: ToolContext): string {
  return context.traceId ?? context.runId;
}

function originRuntimeState(context: ToolContext): JsonObject {
  if (!context.sessionId) {
    return {};
  }
  return {
    origin_channel: "native",
    origin_chat_id: context.sessionId,
    origin_session_key: `native:${context.sessionId}`,
    origin_surface: "main_chat",
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function booleanArg(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function objectArg(args: Record<string, unknown>, key: string): JsonObject | undefined {
  const value = args[key];
  return isJsonObject(value) ? value : undefined;
}

function objectArrayArg<T extends JsonObject>(args: Record<string, unknown>, key: string): T[] | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter(isJsonObject) as T[];
}

function stringListArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}
