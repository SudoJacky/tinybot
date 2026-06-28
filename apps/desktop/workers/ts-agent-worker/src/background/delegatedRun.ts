import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { BackgroundRunReader, BackgroundRunRecord, BackgroundTraceJournal } from "./backgroundRegistryBridge.ts";
import type { SubagentCompletion, SubagentRuntime, SubagentSpawnRequest } from "./subagentRuntime.ts";

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
  contextPack?: DelegatedContextPack;
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
  parentMessages?: AgentMessage[];
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
  forkedMessages: AgentMessage[];
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
  | "agent.delegate.interrupted"
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
  awaitingApproval: string[];
}

export interface DelegatedRunRegistryListFilter {
  pathPrefix?: string;
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
      .filter((run) => !filter.pathPrefix || run.agentPath.startsWith(filter.pathPrefix))
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
  runtime: Pick<SubagentRuntime, "spawn" | "runExisting" | "cancel">;
  registry?: DelegatedRunRegistry;
  runStore?: BackgroundRunReader;
  traceJournal?: BackgroundTraceJournal;
  emitEvent?: (event: DelegatedRunEvent) => void;
  now?: () => string;
}

const MAX_ACTIVE_DELEGATED_RUNS_PER_PARENT = 8;

export class DelegatedRunManager {
  private readonly runtime: Pick<SubagentRuntime, "spawn" | "runExisting" | "cancel">;
  private readonly registry: DelegatedRunRegistry;
  private readonly runStore?: BackgroundRunReader;
  private readonly traceJournal?: BackgroundTraceJournal;
  private readonly emitEvent: (event: DelegatedRunEvent) => void;
  private readonly now: () => string;
  private readonly traceSequences = new Map<string, number>();

  constructor(options: DelegatedRunManagerOptions) {
    this.runtime = options.runtime;
    this.registry = options.registry ?? new DelegatedRunRegistry();
    this.runStore = options.runStore;
    this.traceJournal = options.traceJournal;
    this.emitEvent = options.emitEvent ?? (() => undefined);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async spawnAgent(request: SpawnAgentRequest, parent: DelegatedParentContext): Promise<DelegatedRun> {
    const taskName = normalizeTaskName(request.taskName);
    const parentTurnId = parent.turnId ?? parent.runId;
    const parentSessionKey = parent.sessionKey ?? "";
    await this.restoreRunsFromStore({ parentRunId: parent.runId, parentSessionKey });
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
      forkedMessages: buildForkedParentMessages(parent.parentMessages ?? [], forkTurns),
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
      onComplete: (completion) => this.handleRuntimeCompletion(completion),
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
      contextPack,
      messages: [],
    });
    this.emitDelegatedEvent("agent.delegate.started", run, { latest_activity: spawned.message });
    if (run.status === "running") {
      this.emitDelegatedEvent("agent.delegate.running", run, { latest_activity: spawned.message });
    }
    return run;
  }

  async waitAgent(delegateIds: string[], options: { timeoutMs?: number } = {}): Promise<WaitAgentResult> {
    await this.restoreRunsFromStore({}, new Set(delegateIds));
    const deadline = options.timeoutMs === undefined ? null : Date.now() + Math.max(0, options.timeoutMs);
    while (true) {
      const runs = delegateIds.map((id) => this.registry.require(id));
      const active = runs
        .filter((run) => !isFinalDelegatedStatus(run.status) && run.status !== "awaiting_approval")
        .map((run) => run.delegateId);
      if (active.length === 0) {
        return {
          runs,
          active: [],
          timedOut: [],
          awaitingApproval: runs
            .filter((run) => run.status === "awaiting_approval")
            .map((run) => run.delegateId),
        };
      }
      if (deadline !== null && Date.now() >= deadline) {
        return {
          runs,
          active,
          timedOut: active,
          awaitingApproval: runs
            .filter((run) => run.status === "awaiting_approval")
            .map((run) => run.delegateId),
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  async listAgents(filter: DelegatedRunRegistryListFilter = {}): Promise<DelegatedRun[]> {
    await this.restoreRunsFromStore(filter);
    return this.registry.list(filter);
  }

  async sendMessage(delegateId: string, message: string, options: { triggerFollowup?: boolean } = {}): Promise<DelegatedRun> {
    if (!message.trim()) {
      throw new Error("delegated message must be non-empty");
    }
    await this.restoreRunsFromStore({}, new Set([delegateId]));
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

  async followupTask(delegateId: string, message: string): Promise<DelegatedRun> {
    if (!message.trim()) {
      throw new Error("delegated follow-up message must be non-empty");
    }
    await this.restoreRunsFromStore({}, new Set([delegateId]));
    const current = this.registry.require(delegateId);
    if (current.status === "closed") {
      throw new Error(`delegated run is closed: ${delegateId}`);
    }
    if (!isFinalDelegatedStatus(current.status)) {
      throw new Error(`delegated run is already active: ${delegateId}`);
    }
    const queuedMessage = await this.sendMessage(delegateId, message, { triggerFollowup: true });
    const contextPack = createDelegatedContextPack({
      taskName: queuedMessage.taskName,
      message,
      parentRunId: queuedMessage.parentRunId,
      parentTurnId: queuedMessage.parentTurnId,
      parentSessionKey: queuedMessage.parentSessionKey,
      forkTurns: queuedMessage.forkTurns,
      forkedMessages: queuedMessage.contextPack?.forkedMessages.map(cloneAgentMessage) ?? [],
      runtimePolicy: {
        model: queuedMessage.model,
        permissionProfile: queuedMessage.permissionProfile,
        approvalPolicy: queuedMessage.approvalPolicy,
        approvalReviewer: queuedMessage.approvalReviewer,
        cwd: queuedMessage.cwd,
        workspace: queuedMessage.workspace,
        toolLimits: queuedMessage.toolLimits,
      },
    });
    const spawned = await this.runtime.runExisting(delegateId, {
      task: message,
      label: queuedMessage.label,
      sessionKey: queuedMessage.parentSessionKey,
      metadata: {
        traceId: queuedMessage.traceRef,
        parentRunId: queuedMessage.parentRunId,
        parentTurnId: queuedMessage.parentTurnId,
        origin: "delegated_followup",
        taskName: queuedMessage.taskName,
        delegatedContextPack: contextPack,
      },
      onComplete: (completion) => this.handleRuntimeCompletion(completion),
    } satisfies SubagentSpawnRequest);
    const running = this.registry.update(delegateId, {
      status: spawned.queued ? "queued" : "running",
      result: undefined,
      approvalState: undefined,
      queued: spawned.queued,
      runningCount: spawned.runningCount,
      queuedCount: spawned.queuedCount,
      startMessage: spawned.message,
    });
    this.emitDelegatedEvent("agent.delegate.running", running, {
      latest_activity: spawned.message,
      followup: true,
    });
    return running;
  }

  async closeAgent(delegateId: string): Promise<DelegatedRun> {
    await this.restoreRunsFromStore({}, new Set([delegateId]));
    const run = this.registry.close(delegateId);
    this.emitDelegatedEvent("agent.delegate.closed", run, { latest_activity: run.result?.summary ?? "Delegated run closed." });
    return run;
  }

  async interruptAgent(delegateId: string): Promise<DelegatedRun> {
    await this.restoreRunsFromStore({}, new Set([delegateId]));
    const current = this.registry.require(delegateId);
    if (isFinalDelegatedStatus(current.status)) {
      return current;
    }
    this.runtime.cancel(delegateId);
    let interrupted = this.registry.update(delegateId, {
      status: "cancelled",
      result: {
        status: "cancelled",
        summary: "Delegated run interrupted.",
      },
    });
    interrupted = this.registry.appendTraceStep(delegateId, {
      id: `interrupted:${delegateId}`,
      kind: "error",
      status: "cancelled",
      title: "Interrupted",
      summary: "Delegated run interrupted.",
      createdAt: this.now(),
      updatedAt: this.now(),
    });
    this.emitDelegatedEvent("agent.delegate.trace.updated", interrupted, {
      latest_activity: "Delegated run interrupted.",
      trace: interrupted.trace,
    });
    this.emitDelegatedEvent("agent.delegate.interrupted", interrupted, {
      latest_activity: "Delegated run interrupted.",
    });
    return interrupted;
  }

  private async restoreRunsFromStore(
    filter: DelegatedRunRegistryListFilter = {},
    delegateIds?: Set<string>,
  ): Promise<void> {
    if (!this.runStore) {
      return;
    }
    const records = await this.runStore.listRuns("trace-delegated-run-restore").catch(() => []);
    for (const record of records) {
      if (delegateIds && !delegateIds.has(record.id)) {
        continue;
      }
      const current = this.registry.get(record.id);
      const restored = delegatedRunFromBackgroundRunRecord(record, { orphanedActive: !current });
      if (!restored || !matchesDelegatedRunFilter(restored, filter)) {
        continue;
      }
      if (current) {
        this.registry.update(restored.delegateId, {
          ...restored,
          messages: current.messages.length ? current.messages : restored.messages,
        });
      } else {
        this.registry.create(restored);
      }
    }
  }

  appendTraceStep(delegateId: string, step: DelegatedTraceStep): DelegatedRun {
    const run = this.registry.appendTraceStep(delegateId, step);
    this.emitDelegatedEvent("agent.delegate.trace.updated", run, {
      latest_activity: step.summary ?? step.title,
      trace: run.trace,
    });
    return run;
  }

  private async handleRuntimeCompletion(completion: SubagentCompletion): Promise<void> {
    const existing = this.registry.get(completion.id);
    if (existing?.status === "cancelled" || existing?.status === "closed") {
      return;
    }
    const metadataTrace = delegatedTraceFromMetadata(completion.metadata);
    if (metadataTrace) {
      this.registry.update(completion.id, { trace: metadataTrace });
    }
    const approvalState = delegatedApprovalStateFromMetadata(completion.id, completion.metadata);
    if (completion.status === "awaiting_approval" || approvalState) {
      const nextApprovalState = approvalState ?? {
        approvalId: "",
        delegateId: completion.id,
        childRunId: completion.id,
        childToolCallId: "",
        toolName: "tool",
        status: "approval_required",
      } satisfies DelegatedApprovalState;
      const awaiting = this.registry.update(completion.id, {
        status: "awaiting_approval",
        approvalState: nextApprovalState,
      });
      this.emitDelegatedEvent("agent.delegate.awaiting_approval", awaiting, {
        approvalId: nextApprovalState.approvalId,
        approval_id: nextApprovalState.approvalId,
        childToolCallId: nextApprovalState.childToolCallId,
        child_tool_call_id: nextApprovalState.childToolCallId,
        toolName: nextApprovalState.toolName,
        tool_name: nextApprovalState.toolName,
        latest_activity: "Waiting for approval.",
        operation_preview: nextApprovalState.operationPreview,
        reason: nextApprovalState.reason,
        status: "blocked",
      });
      return;
    }
    const status = completion.status === "completed" ? "completed" : "failed";
    const current = this.registry.get(completion.id);
    if (current?.approvalState?.status === "approval_required") {
      const resolution = delegatedApprovalResolutionFromMetadata(completion.metadata) ?? "approved";
      const resolutionLabel = resolution === "denied" ? "Denied" : "Approved";
      const resolvedApproval: DelegatedApprovalState = {
        ...current.approvalState,
        status: resolution,
      };
      this.registry.update(completion.id, { approvalState: resolvedApproval });
      const resolved = this.registry.appendTraceStep(completion.id, {
        id: `approval:${resolvedApproval.approvalId}`,
        kind: "approval",
        status: "completed",
        title: `${resolvedApproval.toolName || "tool"} approval resolved`,
        summary: `${resolutionLabel}: ${resolvedApproval.approvalId}`,
        approvalId: resolvedApproval.approvalId,
        toolName: resolvedApproval.toolName,
        toolCallId: resolvedApproval.childToolCallId,
        resultPreview: `${resolutionLabel}.`,
        createdAt: this.now(),
        updatedAt: this.now(),
      });
      this.emitDelegatedEvent("agent.delegate.trace.updated", resolved, {
        latest_activity: `${resolutionLabel}: ${resolvedApproval.approvalId}`,
        trace: resolved.trace,
      });
    }
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
  }

  private emitDelegatedEvent(eventName: DelegatedRunEventName, run: DelegatedRun, extra: Record<string, unknown> = {}): void {
    const payload = {
      ...delegatedRunEventPayload(run),
      ...extra,
    };
    this.emitEvent({
      eventName,
      payload,
      run,
      traceId: run.traceRef,
    });
    this.appendTraceJournalEvent(eventName, run, payload);
  }

  private appendTraceJournalEvent(
    eventName: DelegatedRunEventName,
    run: DelegatedRun,
    payload: Record<string, unknown>,
  ): void {
    if (!this.traceJournal) {
      return;
    }
    const sequence = this.nextTraceSequence(run.traceRef || run.delegateId);
    void this.traceJournal.appendTraceEvent({
      eventId: `${run.delegateId}:${sequence}:${eventName}`,
      eventType: eventName,
      sessionKey: run.parentSessionKey,
      turnId: run.parentTurnId,
      delegateId: run.delegateId,
      childRunId: run.childRunId,
      traceRef: run.traceRef,
      sequence,
      createdAt: this.now(),
      payload,
    }, run.traceRef).catch(() => {});
    this.appendChildTraceJournalEvents(eventName, run, payload);
  }

  private nextTraceSequence(traceRef: string): number {
    const next = (this.traceSequences.get(traceRef) ?? 0) + 1;
    this.traceSequences.set(traceRef, next);
    return next;
  }

  private appendChildTraceJournalEvents(
    eventName: DelegatedRunEventName,
    run: DelegatedRun,
    payload: Record<string, unknown>,
  ): void {
    if (!this.traceJournal || eventName !== "agent.delegate.trace.updated") {
      return;
    }
    const trace = recordValue(payload.trace);
    const steps = Array.isArray(trace?.steps)
      ? trace.steps.filter(isDelegatedTraceStep)
      : [];
    for (const step of steps) {
      const childEventType = childTraceEventType(step);
      if (childEventType) {
        this.appendChildTraceJournalEvent(run, step, childEventType);
      }
      if (step.kind === "tool_call" && step.argsPreview) {
        this.appendChildTraceJournalEvent(run, step, "child.tool.arguments.delta");
      }
    }
  }

  private appendChildTraceJournalEvent(
    run: DelegatedRun,
    step: DelegatedTraceStep,
    eventType: string,
  ): void {
    if (!this.traceJournal) {
      return;
    }
    const sequence = this.nextTraceSequence(run.traceRef || run.delegateId);
    void this.traceJournal.appendTraceEvent({
      eventId: `${run.delegateId}:${sequence}:${eventType}:${step.id}`,
      eventType,
      sessionKey: run.parentSessionKey,
      turnId: run.parentTurnId,
      delegateId: run.delegateId,
      childRunId: run.childRunId,
      childStepId: step.id,
      traceRef: run.traceRef,
      sequence,
      createdAt: step.updatedAt || step.createdAt || this.now(),
      payload: {
        ...delegatedRunEventPayload(run),
        child_step_id: step.id,
        childStepId: step.id,
        step,
        step_kind: step.kind,
        step_status: step.status,
        summary: step.summary,
        tool_call_id: step.toolCallId,
        tool_name: step.toolName,
        approval_id: step.approvalId,
        args_preview: step.argsPreview,
        result_preview: step.resultPreview,
        error: step.error,
      },
    }, run.traceRef).catch(() => {});
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

function delegatedApprovalResolutionFromMetadata(
  metadata: Record<string, unknown> | undefined,
): "approved" | "denied" | undefined {
  if (!metadata) {
    return undefined;
  }
  const status = stringMetadata(metadata, "approvalStatus")
    ?? stringMetadata(metadata, "approval_status")
    ?? stringMetadata(metadata, "_delegate_approval_status")
    ?? stringMetadata(metadata, "status");
  if (status === "approved" || status === "denied") {
    return status;
  }
  if (metadata.approved === true) {
    return "approved";
  }
  if (metadata.approved === false) {
    return "denied";
  }
  return undefined;
}

function delegatedRunFromBackgroundRunRecord(
  record: BackgroundRunRecord,
  options: { orphanedActive?: boolean } = {},
): DelegatedRun | undefined {
  if (record.kind !== "subagent") {
    return undefined;
  }
  const metadata = recordValue(record.metadata) ?? {};
  const contextPack = delegatedContextPackFromMetadata(metadata);
  const taskName = normalizeTaskName(
    stringMetadata(metadata, "taskName")
      ?? contextPack?.taskName
      ?? record.label
      ?? record.id,
  );
  const storedStatus = isDelegatedRunStatus(record.status) ? record.status : "running";
  const status = options.orphanedActive && (storedStatus === "running" || storedStatus === "queued")
    ? "failed"
    : storedStatus;
  const parentRunId = stringMetadata(metadata, "parentRunId") ?? contextPack?.parentRunId ?? "";
  const parentTurnId = stringMetadata(metadata, "parentTurnId") ?? contextPack?.parentTurnId ?? parentRunId;
  const parentSessionKey = contextPack?.parentSessionKey ?? record.sessionKey ?? "";
  const traceRef = stringMetadata(metadata, "traceId") ?? stringMetadata(metadata, "traceRef") ?? `trace-delegate-${record.id}`;
  const approvalState = delegatedApprovalStateFromMetadata(record.id, metadata) ?? undefined;
  const trace = delegatedTraceFromMetadata(metadata);
  return {
    delegateId: record.id,
    childRunId: stringMetadata(metadata, "childRunId") ?? stringMetadata(metadata, "_delegate_child_run_id") ?? record.id,
    taskName,
    agentPath: `/${taskName}`,
    parentRunId,
    parentTurnId,
    parentSessionKey,
    label: record.label ?? taskName,
    task: contextPack?.message ?? stringMetadata(metadata, "task") ?? record.label ?? taskName,
    status,
    model: contextPack?.runtimePolicy.model ?? stringMetadata(metadata, "model"),
    permissionProfile: contextPack?.runtimePolicy.permissionProfile ?? "read_only",
    approvalPolicy: contextPack?.runtimePolicy.approvalPolicy ?? "ask_on_sensitive_action",
    approvalReviewer: contextPack?.runtimePolicy.approvalReviewer,
    cwd: contextPack?.runtimePolicy.cwd,
    workspace: contextPack?.runtimePolicy.workspace,
    toolLimits: contextPack?.runtimePolicy.toolLimits,
    forkTurns: contextPack?.forkTurns ?? "none",
    traceRef,
    createdAt: new Date(record.startedAtMs).toISOString(),
    updatedAt: new Date(record.updatedAtMs).toISOString(),
    queued: status === "queued",
    runningCount: 0,
    queuedCount: 0,
    startMessage: record.result ?? record.label ?? `Delegated run [${taskName}] restored.`,
    contextPack,
    result: finalResultFromBackgroundRunRecord(record, status),
    approvalState,
    messages: [],
    trace,
  };
}

function finalResultFromBackgroundRunRecord(
  record: BackgroundRunRecord,
  status: DelegatedRunStatus,
): DelegatedRunResult | undefined {
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    return undefined;
  }
  const orphanedActiveSummary = (
    status === "failed"
    && (record.status === "running" || record.status === "queued")
  )
    ? `Delegated run ${record.id} was restored from a persisted ${record.status} state, but no live delegated runtime owns it.`
    : undefined;
  const summary = orphanedActiveSummary ?? record.result ?? record.error ?? "";
  return {
    status,
    summary,
    ...(record.error || orphanedActiveSummary ? { error: record.error ?? orphanedActiveSummary } : {}),
  };
}

function delegatedContextPackFromMetadata(metadata: Record<string, unknown>): DelegatedContextPack | undefined {
  const raw = recordValue(metadata.delegatedContextPack);
  if (!raw || raw.kind !== "delegated_context_pack") {
    return undefined;
  }
  const taskName = stringMetadata(raw, "taskName");
  const message = stringMetadata(raw, "message");
  const parentRunId = stringMetadata(raw, "parentRunId");
  const parentTurnId = stringMetadata(raw, "parentTurnId");
  const parentSessionKey = stringMetadata(raw, "parentSessionKey");
  const runtimePolicy = recordValue(raw.runtimePolicy);
  if (!taskName || !message || !parentRunId || !parentTurnId || !parentSessionKey || !runtimePolicy) {
    return undefined;
  }
  const forkTurns = isForkTurnsValue(raw.forkTurns) ? normalizeForkTurns(raw.forkTurns) : "none";
  return {
    kind: "delegated_context_pack",
    taskName,
    message,
    parentRunId,
    parentTurnId,
    parentSessionKey,
    forkTurns,
    forkedMessages: Array.isArray(raw.forkedMessages)
      ? raw.forkedMessages.filter(isAgentMessage).map(cloneAgentMessage)
      : [],
    runtimePolicy: {
      model: stringMetadata(runtimePolicy, "model"),
      permissionProfile: stringMetadata(runtimePolicy, "permissionProfile") ?? "read_only",
      approvalPolicy: stringMetadata(runtimePolicy, "approvalPolicy") ?? "ask_on_sensitive_action",
      approvalReviewer: stringMetadata(runtimePolicy, "approvalReviewer"),
      cwd: stringMetadata(runtimePolicy, "cwd"),
      workspace: stringMetadata(runtimePolicy, "workspace"),
      toolLimits: recordValue(runtimePolicy.toolLimits),
    },
    outputContract: stringMetadata(raw, "outputContract")
      ?? "Return only a concise result summary suitable for the parent agent; keep raw trace details behind the trace reference.",
  };
}

function isAgentMessage(value: unknown): value is AgentMessage {
  const message = recordValue(value);
  return Boolean(
    message
    && (message.role === "system" || message.role === "user" || message.role === "assistant" || message.role === "tool")
    && typeof message.content === "string",
  );
}

function matchesDelegatedRunFilter(run: DelegatedRun, filter: DelegatedRunRegistryListFilter): boolean {
  return (!filter.parentSessionKey || run.parentSessionKey === filter.parentSessionKey)
    && (!filter.parentRunId || run.parentRunId === filter.parentRunId)
    && (!filter.pathPrefix || run.agentPath.startsWith(filter.pathPrefix))
    && (!filter.status || run.status === filter.status);
}

function isForkTurnsValue(value: unknown): value is "none" | "all" | `${number}` {
  return value === "none" || value === "all" || (typeof value === "string" && /^[1-9][0-9]*$/.test(value));
}

function cloneRun(run: DelegatedRun): DelegatedRun {
  return {
    ...run,
    result: run.result ? { ...run.result, artifacts: run.result.artifacts ? [...run.result.artifacts] : undefined } : undefined,
    approvalState: run.approvalState ? { ...run.approvalState } : undefined,
    contextPack: run.contextPack ? cloneContextPack(run.contextPack) : undefined,
    messages: run.messages.map((message) => ({ ...message })),
    trace: run.trace ? cloneTrace(run.trace) : undefined,
  };
}

function cloneContextPack(pack: DelegatedContextPack): DelegatedContextPack {
  return {
    ...pack,
    forkedMessages: pack.forkedMessages.map(cloneAgentMessage),
    runtimePolicy: {
      ...pack.runtimePolicy,
      toolLimits: pack.runtimePolicy.toolLimits ? { ...pack.runtimePolicy.toolLimits } : undefined,
    },
  };
}

function cloneAgentMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    thinkingBlocks: message.thinkingBlocks?.map((block) => ({ ...block })),
    metadata: message.metadata ? { ...message.metadata } : undefined,
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

function delegatedTraceFromMetadata(metadata: Record<string, unknown> | undefined): DelegatedRunTrace | undefined {
  const trace = recordValue(metadata?._delegate_trace);
  if (!trace) {
    return undefined;
  }
  const steps = Array.isArray(trace.steps)
    ? trace.steps.filter(isDelegatedTraceStep)
    : [];
  return {
    delegateId: stringMetadata(trace, "delegateId") || stringMetadata(trace, "delegate_id") || "",
    childRunId: stringMetadata(trace, "childRunId") || stringMetadata(trace, "child_run_id") || "",
    parentRunId: stringMetadata(trace, "parentRunId") || stringMetadata(trace, "parent_run_id") || "",
    parentSessionKey: stringMetadata(trace, "parentSessionKey") || stringMetadata(trace, "parent_session_key") || "",
    status: isDelegatedRunStatus(trace.status) ? trace.status : "running",
    steps,
    approvals: Array.isArray(trace.approvals)
      ? trace.approvals.filter(isDelegatedApprovalState)
      : [],
    artifacts: Array.isArray(trace.artifacts) ? trace.artifacts.filter(isRecord) : [],
    updatedAt: stringMetadata(trace, "updatedAt") || stringMetadata(trace, "updated_at") || new Date().toISOString(),
  };
}

function isDelegatedRunStatus(value: unknown): value is DelegatedRunStatus {
  return value === "created"
    || value === "queued"
    || value === "running"
    || value === "awaiting_approval"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "closed";
}

function isDelegatedTraceStep(value: unknown): value is DelegatedTraceStep {
  const step = recordValue(value);
  return Boolean(
    step
    && typeof step.id === "string"
    && typeof step.kind === "string"
    && typeof step.status === "string"
    && typeof step.title === "string"
  );
}

function childTraceEventType(step: DelegatedTraceStep): string | null {
  if (step.kind === "reasoning") {
    return step.status === "completed" ? "child.reasoning.completed" : "child.reasoning.delta";
  }
  if (step.kind === "message") {
    return step.status === "completed" ? "child.message.completed" : "child.message.delta";
  }
  if (step.kind === "tool_call") {
    if (step.status === "completed") {
      return "child.tool.completed";
    }
    if (step.status === "failed") {
      return "child.tool.failed";
    }
    return "child.tool.started";
  }
  if (step.kind === "approval") {
    return step.status === "completed" ? "child.approval.resolved" : "child.approval.requested";
  }
  if (step.kind === "artifact") {
    return "child.artifact.created";
  }
  return null;
}

function isDelegatedApprovalState(value: unknown): value is DelegatedApprovalState {
  const approval = recordValue(value);
  return Boolean(
    approval
    && typeof approval.approvalId === "string"
    && typeof approval.delegateId === "string"
    && typeof approval.childRunId === "string"
    && typeof approval.childToolCallId === "string"
    && typeof approval.toolName === "string"
    && typeof approval.status === "string"
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildForkedParentMessages(
  parentMessages: AgentMessage[],
  forkTurns: "none" | "all" | `${number}`,
): AgentMessage[] {
  if (forkTurns === "none") {
    return [];
  }
  const sanitized = parentMessages
    .map(sanitizeForkedParentMessage)
    .filter((message): message is AgentMessage => message !== undefined);
  if (forkTurns === "all") {
    return sanitized;
  }
  const turnCount = Number.parseInt(forkTurns, 10);
  if (!Number.isFinite(turnCount) || turnCount <= 0) {
    return [];
  }
  const userTurnIndexes = sanitized
    .map((message, index) => message.role === "user" ? index : -1)
    .filter((index) => index >= 0);
  const keepIndex = userTurnIndexes.length > turnCount
    ? userTurnIndexes[userTurnIndexes.length - turnCount]
    : 0;
  return sanitized.slice(keepIndex);
}

function sanitizeForkedParentMessage(message: AgentMessage): AgentMessage | undefined {
  const content = message.content.trim();
  if (!content) {
    return undefined;
  }
  if (message.role === "system" || message.role === "user") {
    return { role: message.role, content };
  }
  if (message.role === "assistant" && !message.toolCalls?.length && !message.toolCallId && !message.name) {
    return { role: "assistant", content };
  }
  return undefined;
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
