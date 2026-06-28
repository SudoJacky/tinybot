import type { SubagentRuntime, SubagentSpawnRequest } from "./subagentRuntime.ts";

export type DelegatedRunStatus =
  | "created"
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "closed";

export type DelegatedPermissionProfile =
  | "read_only"
  | "workspace_write"
  | "shell_sandboxed"
  | "network_allowlist"
  | "full_access"
  | string;

export type DelegatedApprovalStatus = "approval_required" | "approved" | "denied";

export interface DelegatedApprovalState {
  approvalId: string;
  delegateId: string;
  childRunId: string;
  childToolCallId: string;
  toolName: string;
  status: DelegatedApprovalStatus;
  operationPreview?: string;
  reason?: string;
  checkpoint?: Record<string, unknown>;
}

export interface DelegatedRunResult {
  status: Extract<DelegatedRunStatus, "completed" | "failed" | "cancelled" | "closed">;
  summary: string;
  error?: string;
  artifacts?: Array<Record<string, unknown>>;
}

export interface DelegatedRunMessage {
  id: string;
  message: string;
  createdAt: string;
  triggerFollowup: boolean;
}

export type DelegatedTraceStepKind =
  | "reasoning"
  | "message"
  | "tool_call"
  | "approval"
  | "form"
  | "artifact"
  | "error";

export type DelegatedTraceStepStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "cancelled";

export interface DelegatedTraceStep {
  id: string;
  kind: DelegatedTraceStepKind;
  status: DelegatedTraceStepStatus;
  title: string;
  summary?: string;
  toolName?: string;
  toolCallId?: string;
  approvalId?: string;
  argsPreview?: string;
  resultPreview?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DelegatedRunTrace {
  delegateId: string;
  childRunId: string;
  parentRunId: string;
  parentSessionKey: string;
  status: DelegatedRunStatus;
  steps: DelegatedTraceStep[];
  finalMessage?: {
    id: string;
    text: string;
    createdAt: string;
  };
  approvals: DelegatedApprovalState[];
  artifacts: Array<Record<string, unknown>>;
  updatedAt: string;
}

export interface DelegatedRun {
  delegateId: string;
  taskName: string;
  agentPath: string;
  parentRunId: string;
  parentTurnId: string;
  parentSessionKey: string;
  childRunId: string;
  label: string;
  task: string;
  status: DelegatedRunStatus;
  model?: string;
  permissionProfile: DelegatedPermissionProfile;
  approvalPolicy: string;
  approvalReviewer?: string;
  cwd?: string;
  workspace?: string;
  toolLimits?: Record<string, unknown>;
  forkTurns: "none" | "all" | `${number}`;
  traceRef: string;
  createdAt: string;
  updatedAt: string;
  queued: boolean;
  runningCount: number;
  queuedCount: number;
  startMessage: string;
  result?: DelegatedRunResult;
  approvalState?: DelegatedApprovalState;
  messages: DelegatedRunMessage[];
  trace?: DelegatedRunTrace;
}

export interface SpawnAgentRequest {
  taskName: string;
  message: string;
  label?: string;
  forkTurns?: "none" | "all" | `${number}`;
  permissionProfile?: DelegatedPermissionProfile;
  approvalPolicy?: string;
  approvalReviewer?: string;
  cwd?: string;
  workspace?: string;
  toolLimits?: Record<string, unknown>;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface DelegatedParentContext {
  runId: string;
  turnId?: string;
  sessionKey?: string;
  traceId?: string;
  model?: string;
  permissionProfile?: DelegatedPermissionProfile;
  approvalPolicy?: string;
  approvalReviewer?: string;
  cwd?: string;
  workspace?: string;
  toolLimits?: Record<string, unknown>;
}

export interface DelegatedContextPack {
  kind: "delegated_context_pack";
  taskName: string;
  message: string;
  parentRunId: string;
  parentTurnId: string;
  parentSessionKey: string;
  forkTurns: "none" | "all" | `${number}`;
  runtimePolicy: {
    model?: string;
    permissionProfile: DelegatedPermissionProfile;
    approvalPolicy: string;
    approvalReviewer?: string;
    cwd?: string;
    workspace?: string;
    toolLimits?: Record<string, unknown>;
  };
  outputContract: string;
}

export type DelegatedRunEventName =
  | "agent.delegate.started"
  | "agent.delegate.running"
  | "agent.delegate.message_queued"
  | "agent.delegate.awaiting_approval"
  | "agent.delegate.tool.approval_required"
  | "agent.delegate.tool.completed"
  | "agent.delegate.trace.updated"
  | "agent.delegate.completed"
  | "agent.delegate.failed"
  | "agent.delegate.closed";

export interface DelegatedRunEvent {
  eventName: DelegatedRunEventName;
  payload: Record<string, unknown>;
  run: DelegatedRun;
  traceId?: string;
}

export interface WaitAgentResult {
  runs: DelegatedRun[];
  timedOut: string[];
  active: string[];
}

export interface DelegatedRunRegistryListFilter {
  parentSessionKey?: string;
  parentRunId?: string;
  status?: DelegatedRunStatus;
}

export class DelegatedRunRegistry {
  private readonly runs = new Map<string, DelegatedRun>();

  create(run: DelegatedRun): DelegatedRun {
    this.runs.set(run.delegateId, cloneRun(run));
    return cloneRun(run);
  }

  get(delegateId: string): DelegatedRun | undefined {
    const run = this.runs.get(delegateId);
    return run ? cloneRun(run) : undefined;
  }

  require(delegateId: string): DelegatedRun {
    const run = this.get(delegateId);
    if (!run) {
      throw new Error(`delegated run not found: ${delegateId}`);
    }
    return run;
  }

  update(delegateId: string, patch: Partial<DelegatedRun>): DelegatedRun {
    const current = this.runs.get(delegateId);
    if (!current) {
      throw new Error(`delegated run not found: ${delegateId}`);
    }
    const next = {
      ...current,
      ...patch,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
      messages: patch.messages ? [...patch.messages] : current.messages,
    };
    this.runs.set(delegateId, cloneRun(next));
    return cloneRun(next);
  }

  list(filter: DelegatedRunRegistryListFilter = {}): DelegatedRun[] {
    return [...this.runs.values()]
      .filter((run) => !filter.parentSessionKey || run.parentSessionKey === filter.parentSessionKey)
      .filter((run) => !filter.parentRunId || run.parentRunId === filter.parentRunId)
      .filter((run) => !filter.status || run.status === filter.status)
      .map(cloneRun);
  }

  close(delegateId: string, summary = "Delegated run closed."): DelegatedRun {
    return this.update(delegateId, {
      status: "closed",
      result: {
        status: "closed",
        summary,
      },
    });
  }

  appendMessage(
    delegateId: string,
    message: Omit<DelegatedRunMessage, "id" | "createdAt"> & { id?: string; createdAt?: string },
  ): DelegatedRun {
    const current = this.runs.get(delegateId);
    if (!current) {
      throw new Error(`delegated run not found: ${delegateId}`);
    }
    const nextMessage: DelegatedRunMessage = {
      id: message.id ?? `msg-${current.messages.length + 1}`,
      message: message.message,
      triggerFollowup: message.triggerFollowup,
      createdAt: message.createdAt ?? new Date().toISOString(),
    };
    return this.update(delegateId, {
      messages: [...current.messages, nextMessage],
    });
  }

  appendTraceStep(delegateId: string, step: DelegatedTraceStep): DelegatedRun {
    const current = this.runs.get(delegateId);
    if (!current) {
      throw new Error(`delegated run not found: ${delegateId}`);
    }
    const trace = current.trace ?? createEmptyTrace(current);
    const existingIndex = trace.steps.findIndex((item) => item.id === step.id);
    const steps = [...trace.steps];
    if (existingIndex >= 0) {
      steps[existingIndex] = { ...steps[existingIndex], ...step };
    } else {
      steps.push({ ...step });
    }
    return this.update(delegateId, {
      trace: {
        ...trace,
        status: current.status,
        steps,
        approvals: current.approvalState
          ? mergeApprovals(trace.approvals, current.approvalState)
          : trace.approvals,
        updatedAt: step.updatedAt,
      },
    });
  }
}

export interface DelegatedRunManagerOptions {
  runtime: Pick<SubagentRuntime, "spawn">;
  registry?: DelegatedRunRegistry;
  emitEvent?: (event: DelegatedRunEvent) => void;
  now?: () => string;
}

const MAX_ACTIVE_DELEGATED_RUNS_PER_PARENT = 8;

export class DelegatedRunManager {
  private readonly runtime: Pick<SubagentRuntime, "spawn">;
  private readonly registry: DelegatedRunRegistry;
  private readonly emitEvent: (event: DelegatedRunEvent) => void;
  private readonly now: () => string;

  constructor(options: DelegatedRunManagerOptions) {
    this.runtime = options.runtime;
    this.registry = options.registry ?? new DelegatedRunRegistry();
    this.emitEvent = options.emitEvent ?? (() => undefined);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async spawnAgent(request: SpawnAgentRequest, parent: DelegatedParentContext): Promise<DelegatedRun> {
    const taskName = normalizeTaskName(request.taskName);
    const parentTurnId = parent.turnId ?? parent.runId;
    const parentSessionKey = parent.sessionKey ?? "";
    const activeForParent = this.registry.list({ parentRunId: parent.runId })
      .filter((run) => !isFinalDelegatedStatus(run.status)).length;
    if (activeForParent >= MAX_ACTIVE_DELEGATED_RUNS_PER_PARENT) {
      throw new Error(`parent run ${parent.runId} already has ${MAX_ACTIVE_DELEGATED_RUNS_PER_PARENT} active delegated runs`);
    }
    const permissionProfile = request.permissionProfile ?? parent.permissionProfile ?? "read_only";
    assertPermissionNarrowing(permissionProfile, parent.permissionProfile ?? "read_only");
    const approvalPolicy = request.approvalPolicy ?? parent.approvalPolicy ?? "ask_on_sensitive_action";
    const approvalReviewer = request.approvalReviewer ?? parent.approvalReviewer;
    const cwd = request.cwd ?? parent.cwd;
    const workspace = request.workspace ?? parent.workspace;
    const model = request.model ?? parent.model;
    const toolLimits = request.toolLimits ?? parent.toolLimits;
    const forkTurns = normalizeForkTurns(request.forkTurns ?? "none");
    const contextPack = createDelegatedContextPack({
      taskName,
      message: request.message,
      parentRunId: parent.runId,
      parentTurnId,
      parentSessionKey,
      forkTurns,
      runtimePolicy: {
        model,
        permissionProfile,
        approvalPolicy,
        approvalReviewer,
        cwd,
        workspace,
        toolLimits,
      },
    });
    const metadata = {
      ...(request.metadata ?? {}),
      ...(parent.traceId ? { traceId: parent.traceId } : {}),
      parentRunId: parent.runId,
      parentTurnId,
      origin: "delegated_run",
      taskName,
      delegatedContextPack: contextPack,
    };
    const spawned = await this.runtime.spawn({
      task: request.message,
      label: request.label ?? taskName,
      sessionKey: parent.sessionKey,
      metadata,
      onComplete: async (completion) => {
        const approvalState = delegatedApprovalStateFromMetadata(completion.id, completion.metadata);
        if (approvalState) {
          const awaiting = this.registry.update(completion.id, {
            status: "awaiting_approval",
            approvalState,
          });
          this.emitDelegatedEvent("agent.delegate.awaiting_approval", awaiting, {
            approvalId: approvalState.approvalId,
            approval_id: approvalState.approvalId,
            childToolCallId: approvalState.childToolCallId,
            child_tool_call_id: approvalState.childToolCallId,
            toolName: approvalState.toolName,
            tool_name: approvalState.toolName,
            latest_activity: "Waiting for approval.",
            operation_preview: approvalState.operationPreview,
            reason: approvalState.reason,
            status: "blocked",
          });
          return;
        }
        const status = completion.status === "completed" ? "completed" : "failed";
        let completed = this.registry.update(completion.id, {
          status,
          result: {
            status,
            summary: completion.result,
            ...(completion.error ? { error: completion.error } : {}),
          },
        });
        completed = this.registry.appendTraceStep(completion.id, {
          id: `final:${completion.id}`,
          kind: completion.error ? "error" : "message",
          status: completion.error ? "failed" : "completed",
          title: completion.error ? "Error" : "Final answer",
          summary: completion.error ?? completion.result,
          error: completion.error,
          createdAt: this.now(),
          updatedAt: this.now(),
        });
        this.emitDelegatedEvent("agent.delegate.trace.updated", completed, {
          latest_activity: completion.error ?? completion.result,
          trace: completed.trace,
        });
        this.emitDelegatedEvent(status === "completed" ? "agent.delegate.completed" : "agent.delegate.failed", completed, {
          final_output: completion.result,
          latest_activity: completion.error ?? completion.result,
        });
      },
    } satisfies SubagentSpawnRequest);
    const createdAt = this.now();
    const run = this.registry.create({
      delegateId: spawned.id,
      childRunId: spawned.id,
      taskName,
      agentPath: `/${taskName}`,
      parentRunId: parent.runId,
      parentTurnId,
      parentSessionKey,
      label: spawned.label,
      task: request.message,
      status: spawned.queued ? "queued" : "running",
      model,
      permissionProfile,
      approvalPolicy,
      approvalReviewer,
      cwd,
      workspace,
      toolLimits,
      forkTurns,
      traceRef: stringMetadata(metadata, "traceId") ?? `trace-delegate-${spawned.id}`,
      createdAt,
      updatedAt: createdAt,
      queued: spawned.queued,
      runningCount: spawned.runningCount,
      queuedCount: spawned.queuedCount,
      startMessage: spawned.message,
      messages: [],
    });
    this.emitDelegatedEvent("agent.delegate.started", run, { latest_activity: spawned.message });
    if (run.status === "running") {
      this.emitDelegatedEvent("agent.delegate.running", run, { latest_activity: spawned.message });
    }
    return run;
  }

  async waitAgent(delegateIds: string[], options: { timeoutMs?: number } = {}): Promise<WaitAgentResult> {
    const deadline = options.timeoutMs === undefined ? null : Date.now() + Math.max(0, options.timeoutMs);
    while (true) {
      const runs = delegateIds.map((id) => this.registry.require(id));
      const active = runs
        .filter((run) => !isFinalDelegatedStatus(run.status) && run.status !== "awaiting_approval")
        .map((run) => run.delegateId);
      if (active.length === 0) {
        return { runs, active: [], timedOut: [] };
      }
      if (deadline !== null && Date.now() >= deadline) {
        return { runs, active, timedOut: active };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  listAgents(filter: DelegatedRunRegistryListFilter = {}): DelegatedRun[] {
    return this.registry.list(filter);
  }

  sendMessage(delegateId: string, message: string, options: { triggerFollowup?: boolean } = {}): DelegatedRun {
    if (!message.trim()) {
      throw new Error("delegated message must be non-empty");
    }
    const run = this.registry.appendMessage(delegateId, {
      message,
      triggerFollowup: options.triggerFollowup ?? false,
      createdAt: this.now(),
    });
    this.emitDelegatedEvent("agent.delegate.message_queued", run, {
      latest_activity: message,
      message,
      trigger_followup: options.triggerFollowup ?? false,
    });
    return run;
  }

  closeAgent(delegateId: string): DelegatedRun {
    const run = this.registry.close(delegateId);
    this.emitDelegatedEvent("agent.delegate.closed", run, { latest_activity: run.result?.summary ?? "Delegated run closed." });
    return run;
  }

  appendTraceStep(delegateId: string, step: DelegatedTraceStep): DelegatedRun {
    const run = this.registry.appendTraceStep(delegateId, step);
    this.emitDelegatedEvent("agent.delegate.trace.updated", run, {
      latest_activity: step.summary ?? step.title,
      trace: run.trace,
    });
    return run;
  }

  private emitDelegatedEvent(eventName: DelegatedRunEventName, run: DelegatedRun, extra: Record<string, unknown> = {}): void {
    this.emitEvent({
      eventName,
      payload: {
        ...delegatedRunEventPayload(run),
        ...extra,
      },
      run,
      traceId: run.traceRef,
    });
  }
}

export function delegatedRunEventPayload(run: DelegatedRun): Record<string, unknown> {
  return {
    runId: run.parentRunId,
    run_id: run.parentRunId,
    parentRunId: run.parentRunId,
    parent_run_id: run.parentRunId,
    parentTurnId: run.parentTurnId,
    parent_turn_id: run.parentTurnId,
    parentSessionKey: run.parentSessionKey,
    parent_session_key: run.parentSessionKey,
    delegateId: run.delegateId,
    delegate_id: run.delegateId,
    childRunId: run.childRunId,
    child_run_id: run.childRunId,
    taskName: run.taskName,
    task_name: run.taskName,
    agentPath: run.agentPath,
    agent_path: run.agentPath,
    delegate_type: "spawn",
    title: run.label || run.taskName,
    task: run.task,
    status: run.status,
    workflow: "Spawned agent workflow",
    traceRef: run.traceRef,
    trace_ref: run.traceRef,
    permissionProfile: run.permissionProfile,
    permission_profile: run.permissionProfile,
    approvalPolicy: run.approvalPolicy,
    approval_policy: run.approvalPolicy,
    final_output: run.result?.summary,
    latest_activity: run.result?.summary ?? run.startMessage,
    trace: run.trace,
  };
}

function normalizeTaskName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "delegated_task";
}

function isFinalDelegatedStatus(status: DelegatedRunStatus): boolean {
  return ["completed", "failed", "cancelled", "closed"].includes(status);
}

function delegatedApprovalStateFromMetadata(
  delegateId: string,
  metadata: Record<string, unknown> | undefined,
): DelegatedApprovalState | null {
  if (!metadata || metadata.awaitingUserInput !== true || metadata.stopReason !== "awaiting_approval") {
    return null;
  }
  const approvalId = stringMetadata(metadata, "approvalId") ?? stringMetadata(metadata, "approval_id");
  if (!approvalId) {
    return null;
  }
  const childRunId = stringMetadata(metadata, "_delegate_child_run_id") ?? stringMetadata(metadata, "childRunId") ?? delegateId;
  const childToolCallId = stringMetadata(metadata, "_delegate_child_tool_call_id")
    ?? stringMetadata(metadata, "childToolCallId")
    ?? stringMetadata(metadata, "toolCallId")
    ?? "";
  const toolName = stringMetadata(metadata, "_delegate_child_tool_name")
    ?? stringMetadata(metadata, "toolName")
    ?? "tool";
  return {
    approvalId,
    delegateId,
    childRunId,
    childToolCallId,
    toolName,
    status: "approval_required",
    operationPreview: stringMetadata(metadata, "_delegate_operation_preview") ?? stringMetadata(metadata, "operationPreview"),
    reason: stringMetadata(metadata, "reason"),
    checkpoint: recordMetadata(metadata, "_delegate_child_checkpoint"),
  };
}

function cloneRun(run: DelegatedRun): DelegatedRun {
  return {
    ...run,
    result: run.result ? { ...run.result, artifacts: run.result.artifacts ? [...run.result.artifacts] : undefined } : undefined,
    approvalState: run.approvalState ? { ...run.approvalState } : undefined,
    messages: run.messages.map((message) => ({ ...message })),
    trace: run.trace ? cloneTrace(run.trace) : undefined,
  };
}

function createEmptyTrace(run: DelegatedRun): DelegatedRunTrace {
  return {
    delegateId: run.delegateId,
    childRunId: run.childRunId,
    parentRunId: run.parentRunId,
    parentSessionKey: run.parentSessionKey,
    status: run.status,
    steps: [],
    approvals: run.approvalState ? [{ ...run.approvalState }] : [],
    artifacts: [],
    updatedAt: run.updatedAt,
  };
}

function cloneTrace(trace: DelegatedRunTrace): DelegatedRunTrace {
  return {
    ...trace,
    finalMessage: trace.finalMessage ? { ...trace.finalMessage } : undefined,
    steps: trace.steps.map((step) => ({ ...step })),
    approvals: trace.approvals.map((approval) => ({ ...approval })),
    artifacts: trace.artifacts.map((artifact) => ({ ...artifact })),
  };
}

function mergeApprovals(approvals: DelegatedApprovalState[], next: DelegatedApprovalState): DelegatedApprovalState[] {
  const index = approvals.findIndex((approval) => approval.approvalId === next.approvalId);
  if (index < 0) {
    return [...approvals, { ...next }];
  }
  const merged = [...approvals];
  merged[index] = { ...merged[index], ...next };
  return merged;
}

function createDelegatedContextPack(
  input: Omit<DelegatedContextPack, "kind" | "outputContract">,
): DelegatedContextPack {
  return {
    kind: "delegated_context_pack",
    ...input,
    outputContract: "Return only a concise result summary suitable for the parent agent; keep raw trace details behind the trace reference.",
  };
}

function normalizeForkTurns(value: "none" | "all" | `${number}`): "none" | "all" | `${number}` {
  if (value === "none" || value === "all") {
    return value;
  }
  if (/^[1-9][0-9]*$/.test(value)) {
    return value;
  }
  throw new Error("forkTurns must be none, all, or a positive integer string");
}

function assertPermissionNarrowing(
  requested: DelegatedPermissionProfile,
  parent: DelegatedPermissionProfile,
): void {
  if (permissionRank(requested) > permissionRank(parent)) {
    throw new Error(`delegated permission profile ${requested} exceeds parent profile ${parent}`);
  }
}

function permissionRank(profile: DelegatedPermissionProfile): number {
  switch (profile) {
    case "read_only":
      return 0;
    case "workspace_write":
      return 1;
    case "shell_sandboxed":
    case "network_allowlist":
      return 2;
    case "full_access":
      return 3;
    default:
      return 0;
  }
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

function recordMetadata(metadata: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = metadata[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
