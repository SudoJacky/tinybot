import type { Tool } from "../tools/tool.ts";
import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type {
  DelegatedPermissionProfile,
  DelegatedParentContext,
  DelegatedRun,
  DelegatedRunManager,
  DelegatedRunRegistryListFilter,
  DelegatedRunStatus,
  SpawnAgentRequest,
  WaitAgentResult,
} from "./delegatedRun.ts";

export type DelegatedAgentToolManager = Pick<
  DelegatedRunManager,
  "spawnAgent" | "waitAgent" | "listAgents" | "sendMessage" | "followupTask" | "interruptAgent" | "closeAgent"
>;

export function createSpawnTool(options: { manager: DelegatedAgentToolManager }): Tool {
  return {
    name: "spawn",
    description: [
      "Compatibility tool: delegate a task to a focused subagent and wait for its compact final result.",
      "Use this for complex or time-consuming tasks that benefit from an independent context.",
      "Internally this creates a delegated run and waits for it, like spawn_agent followed by wait_agent.",
      "For deliverables or existing projects, inspect the workspace first and use a dedicated subdirectory when helpful.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task for the subagent to complete" },
        label: { type: "string", description: "Optional short label for the task (for display)" },
        permission_profile: {
          type: "string",
          description: "Delegated tool access profile: read_only, workspace_write, shell_sandboxed, network_allowlist, or full_access",
        },
      },
      required: ["task"],
    },
    capabilities: ["background.write"],
    requiresApproval: true,
    approvalCategory: "agent_control",
    approvalRisk: "high",
    concurrencySafe: true,
    execute: async (args, context) => {
      const task = stringArg(args, "task")?.trim();
      if (!task) {
        return { content: "Error: task is required for spawn action" };
      }
      const label = cleanOptionalString(args.label);
      const run = await options.manager.spawnAgent({
        taskName: label ?? "spawn",
        message: task,
        label,
        permissionProfile: delegatedPermissionProfileArg(args.permission_profile) ?? "read_only",
        metadata: {
          ...(context.traceId ? { traceId: context.traceId } : {}),
          runId: context.runId,
          origin: "legacy_spawn_tool",
        },
      }, parentContext(context));
      const result = await options.manager.waitAgent([run.delegateId]);
      return spawnToolResult(result.runs[0] ?? run);
    },
  };
}

export function createDelegatedAgentTools(options: { manager: DelegatedAgentToolManager }): Tool[] {
  return [
    createSpawnAgentTool(options.manager),
    createWaitAgentTool(options.manager),
    createListAgentsTool(options.manager),
    createSendMessageTool(options.manager),
    createFollowupTaskTool(options.manager),
    createInterruptAgentTool(options.manager),
    createCloseAgentTool(options.manager),
  ];
}

function createSpawnAgentTool(manager: DelegatedAgentToolManager): Tool {
  return {
    name: "spawn_agent",
    description: [
      "Start a delegated subagent and return a handle immediately.",
      "Use wait_agent to wait for final compact results; the child transcript stays outside the parent context.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        task_name: { type: "string", description: "Short stable task name for identifying the delegated run" },
        message: { type: "string", description: "The task contract/instructions for the delegated agent" },
        label: { type: "string", description: "Optional display label for the delegated run" },
        agent_type: { type: "string", description: "Optional Codex-compatible agent role hint used as a fallback task name" },
        model: { type: "string", description: "Optional model override for the delegated run" },
        reasoning_effort: { type: "string", description: "Optional Codex-compatible reasoning hint recorded in metadata" },
        fork_context: {
          type: "boolean",
          description: "Codex-compatible full-context fork flag. Ignored when fork_turns is provided.",
        },
        fork_turns: {
          type: "string",
          description: "Parent context fork policy: none, all, or a positive integer string",
        },
        permission_profile: {
          type: "string",
          description: "Delegated tool access profile: read_only, workspace_write, shell_sandboxed, network_allowlist, or full_access",
        },
      },
      required: ["task_name", "message"],
    },
    capabilities: ["background.write"],
    requiresApproval: true,
    approvalCategory: "agent_control",
    approvalRisk: "high",
    concurrencySafe: true,
    execute: async (args, context) => {
      const message = nonEmptyStringArg(args, "message");
      const label = cleanOptionalString(args.label);
      const agentType = cleanOptionalString(args.agent_type);
      const reasoningEffort = cleanOptionalString(args.reasoning_effort);
      const request: SpawnAgentRequest = {
        taskName: requiredSpawnAgentTaskName(args),
        message,
        label,
        forkTurns: forkTurnsArg(args.fork_turns) ?? forkTurnsFromForkContext(args.fork_context),
        permissionProfile: delegatedPermissionProfileArg(args.permission_profile) ?? "read_only",
        model: cleanOptionalString(args.model),
        metadata: {
          ...(context.traceId ? { traceId: context.traceId } : {}),
          runId: context.runId,
          origin: "spawn_agent_tool",
          ...(agentType ? { agentType } : {}),
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(args.fork_context === true ? { forkContext: true } : {}),
        },
      };
      const run = await manager.spawnAgent(request, parentContext(context));
      return {
        content: jsonContent({ delegatedRun: delegatedRunHandle(run) }),
        metadata: delegatedRunMetadata(run),
      };
    },
  };
}

function createWaitAgentTool(manager: DelegatedAgentToolManager): Tool {
  return {
    name: "wait_agent",
    description: "Wait for one or more delegated agents to finish and return compact statuses and summaries.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Single delegated run id to wait for" },
        targets: {
          type: "array",
          items: { type: "string" },
          description: "Delegated run ids to wait for",
        },
        timeout_ms: { type: "integer", minimum: 0, description: "Optional wait timeout in milliseconds" },
      },
    },
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["background.read"],
    execute: async (args) => {
      const result = await manager.waitAgent(targetArgs(args), { timeoutMs: optionalIntegerArg(args, "timeout_ms") });
      return {
        content: jsonContent(formatWaitAgentResult(result)),
        metadata: {
          _delegated_wait: true,
          _delegated_runs: result.runs.map(delegatedRunMetadata),
          _delegated_active: result.active,
          _delegated_awaiting_approval: result.awaitingApproval,
          _delegated_completed: delegatedRunIdsByStatus(result, "completed"),
          _delegated_failed: delegatedRunIdsByStatus(result, "failed"),
          _delegated_timed_out: result.timedOut,
        },
      };
    },
  };
}

function createListAgentsTool(manager: DelegatedAgentToolManager): Tool {
  return {
    name: "list_agents",
    description: "List delegated agents visible to the current desktop chat session.",
    parameters: {
      type: "object",
      properties: {
        path_prefix: { type: "string", description: "Optional agent path prefix, such as /review" },
        status: { type: "string", description: "Optional delegated run status filter" },
      },
    },
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["background.read"],
    execute: async (args, context) => {
      const status = delegatedStatusArg(args.status);
      const pathPrefix = pathPrefixArg(args.path_prefix);
      const filter: DelegatedRunRegistryListFilter = {
        ...(context.sessionId ? { parentSessionKey: context.sessionId } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
        ...(status ? { status } : {}),
      };
      const runs = await manager.listAgents(filter);
      return {
        content: jsonContent({ delegatedRuns: runs.map(delegatedRunHandle) }),
        metadata: {
          _delegated_list: true,
          _delegated_runs: runs.map(delegatedRunMetadata),
        },
      };
    },
  };
}

function createSendMessageTool(manager: DelegatedAgentToolManager): Tool {
  return {
    name: "send_message",
    description: "Queue a follow-up message for an active delegated agent.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Delegated run id" },
        message: { type: "string", description: "Message to queue for the delegated agent" },
      },
      required: ["target", "message"],
    },
    capabilities: ["background.write"],
    concurrencySafe: true,
    execute: async (args) => {
      const run = await manager.sendMessage(
        nonEmptyStringArg(args, "target"),
        nonEmptyStringArg(args, "message"),
      );
      return {
        content: jsonContent({ delegatedRun: delegatedRunHandle(run), queuedMessages: run.messages }),
        metadata: delegatedRunMetadata(run),
      };
    },
  };
}

function createFollowupTaskTool(manager: DelegatedAgentToolManager): Tool {
  return {
    name: "followup_task",
    description: [
      "Send a follow-up instruction to an existing delegated agent and trigger a new child turn.",
      "Use send_message when you only want to queue a note without running the child.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Delegated run id" },
        message: { type: "string", description: "Follow-up instruction for the delegated agent" },
      },
      required: ["target", "message"],
    },
    capabilities: ["background.write"],
    concurrencySafe: true,
    execute: async (args) => {
      const run = await manager.followupTask(
        nonEmptyStringArg(args, "target"),
        nonEmptyStringArg(args, "message"),
      );
      return {
        content: jsonContent({ delegatedRun: delegatedRunHandle(run), queuedMessages: run.messages }),
        metadata: delegatedRunMetadata(run),
      };
    },
  };
}

function createInterruptAgentTool(manager: DelegatedAgentToolManager): Tool {
  return {
    name: "interrupt_agent",
    description: "Interrupt an active delegated agent run without closing its history.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Delegated run id" },
      },
      required: ["target"],
    },
    capabilities: ["background.write"],
    concurrencySafe: true,
    execute: async (args) => {
      const run = await manager.interruptAgent(nonEmptyStringArg(args, "target"));
      return {
        content: jsonContent({ delegatedRun: delegatedRunHandle(run) }),
        metadata: delegatedRunMetadata(run),
      };
    },
  };
}

function createCloseAgentTool(manager: DelegatedAgentToolManager): Tool {
  return {
    name: "close_agent",
    description: "Close a delegated agent handle and retire it from active work.",
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", description: "Delegated run id" },
      },
      required: ["target"],
    },
    capabilities: ["background.write"],
    concurrencySafe: true,
    execute: async (args) => {
      const run = await manager.closeAgent(nonEmptyStringArg(args, "target"));
      return {
        content: jsonContent({ delegatedRun: delegatedRunHandle(run) }),
        metadata: delegatedRunMetadata(run),
      };
    },
  };
}

function spawnToolResult(run: DelegatedRun) {
  if (run.status === "awaiting_approval" && run.approvalState) {
    return {
      content: "Waiting for approval.",
      metadata: {
        _background_event: true,
        _background_run_id: run.delegateId,
        _background_label: run.label,
        _background_task: run.task,
        _background_status: run.status,
        _background_message: "Waiting for approval.",
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        approvalId: run.approvalState.approvalId,
        approvalStatus: "approval_required",
        _delegate_approval_state: run.approvalState,
        _delegate_child_checkpoint: run.approvalState.checkpoint,
        _delegate_child_run_id: run.approvalState.childRunId,
        _delegate_child_tool_call_id: run.approvalState.childToolCallId,
        _delegate_child_tool_name: run.approvalState.toolName,
        _delegate_operation_preview: run.approvalState.operationPreview,
        ...delegatedRunMetadata(run),
      },
    };
  }
  const summary = run.result?.summary ?? run.startMessage;
  return {
    content: run.result?.status === "failed" ? (run.result.error ?? summary) : summary,
    metadata: {
      _background_event: true,
      _background_run_id: run.delegateId,
      _background_label: run.label,
      _background_task: run.task,
      _background_status: run.status,
      _background_message: run.startMessage,
      ...delegatedRunMetadata(run),
    },
  };
}

function parentContext(context: { runId: string; traceId?: string; sessionId?: string; parentMessages?: AgentMessage[] }): DelegatedParentContext {
  return {
    runId: context.runId,
    turnId: context.runId,
    sessionKey: context.sessionId,
    traceId: context.traceId,
    parentMessages: context.parentMessages,
    permissionProfile: "full_access",
  };
}

function delegatedRunHandle(run: DelegatedRun): Record<string, unknown> {
  return {
    delegateId: run.delegateId,
    taskName: run.taskName,
    agentPath: run.agentPath,
    status: run.status,
    traceRef: run.traceRef,
    label: run.label,
    result: run.result,
  };
}

function formatWaitAgentResult(result: WaitAgentResult): Record<string, unknown> {
  return {
    delegatedRuns: result.runs.map(delegatedRunHandle),
    completed: delegatedRunIdsByStatus(result, "completed"),
    failed: delegatedRunIdsByStatus(result, "failed"),
    active: result.active,
    awaitingApproval: result.awaitingApproval,
    timedOut: result.timedOut,
  };
}

function delegatedRunIdsByStatus(result: WaitAgentResult, status: DelegatedRunStatus): string[] {
  return result.runs
    .filter((run) => run.status === status)
    .map((run) => run.delegateId);
}

function delegatedRunMetadata(run: DelegatedRun): Record<string, unknown> {
  return {
    _delegate_event: true,
    _delegate_id: run.delegateId,
    _delegate_task_name: run.taskName,
    _delegate_agent_path: run.agentPath,
    _delegate_status: run.status,
    _delegate_trace_ref: run.traceRef,
    _delegate_label: run.label,
    _delegate_task: run.task,
    _delegate_result: run.result,
    _delegate_trace: run.trace,
    _delegate_approval_state: run.approvalState,
    _delegate_parent_run_id: run.parentRunId,
    _delegate_parent_turn_id: run.parentTurnId,
    _delegate_parent_session_key: run.parentSessionKey,
  };
}

function jsonContent(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function targetArgs(args: Record<string, unknown>): string[] {
  const targets = optionalStringListArg(args, "targets");
  const target = cleanOptionalString(args.target);
  const allTargets = [...targets, ...(target ? [target] : [])];
  if (allTargets.length === 0) {
    throw new Error("target or targets is required");
  }
  return allTargets;
}

function requiredSpawnAgentTaskName(args: Record<string, unknown>): string {
  const taskName = cleanOptionalString(args.task_name);
  if (!taskName) {
    throw new Error("task_name is required for spawn_agent");
  }
  return taskName;
}

function forkTurnsArg(value: unknown): "none" | "all" | `${number}` | undefined {
  const cleaned = cleanOptionalString(value);
  if (!cleaned) {
    return undefined;
  }
  if (cleaned === "none" || cleaned === "all") {
    return cleaned;
  }
  if (/^[1-9][0-9]*$/.test(cleaned)) {
    return cleaned as `${number}`;
  }
  throw new Error("fork_turns must be none, all, or a positive integer string");
}

function forkTurnsFromForkContext(value: unknown): "all" | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value === true) {
    return "all";
  }
  throw new Error("fork_context must be a boolean when provided");
}

function delegatedPermissionProfileArg(value: unknown): DelegatedPermissionProfile | undefined {
  const cleaned = cleanOptionalString(value);
  if (!cleaned) {
    return undefined;
  }
  if (["read_only", "workspace_write", "shell_sandboxed", "network_allowlist", "full_access"].includes(cleaned)) {
    return cleaned;
  }
  throw new Error(
    "permission_profile must be read_only, workspace_write, shell_sandboxed, network_allowlist, or full_access",
  );
}

function delegatedStatusArg(value: unknown): DelegatedRunStatus | undefined {
  const cleaned = cleanOptionalString(value);
  if (!cleaned) {
    return undefined;
  }
  if (["created", "queued", "running", "awaiting_approval", "completed", "failed", "cancelled", "closed"].includes(cleaned)) {
    return cleaned as DelegatedRunStatus;
  }
  throw new Error("status must be a delegated run status");
}

function pathPrefixArg(value: unknown): string | undefined {
  const cleaned = cleanOptionalString(value);
  if (!cleaned) {
    return undefined;
  }
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

function nonEmptyStringArg(args: Record<string, unknown>, key: string): string {
  const value = stringArg(args, key)?.trim();
  if (!value) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer when provided`);
  }
  return value;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean when provided`);
  }
  return value;
}

function optionalStringListArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array when provided`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`${key} must contain non-empty strings`);
    }
    return item.trim();
  });
}
