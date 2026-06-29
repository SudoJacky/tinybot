import type { JsonObject } from "../protocol/messages.ts";
import { AgentRunner } from "../agent/agentRunner.ts";
import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { BackgroundRunReader, BackgroundRunRegistry, BackgroundTraceJournal } from "../background/backgroundRegistryBridge.ts";
import {
  DelegatedRunManager,
  type DelegatedContextPack,
  type DelegatedPermissionProfile,
  type DelegatedRunEventName,
} from "../background/delegatedRun.ts";
import { createDelegatedAgentTools, createSpawnTool } from "../background/spawnTool.ts";
import { SubagentRuntime, type SubagentRunRequest } from "../background/subagentRuntime.ts";
import { NativeCronBridge } from "../cron/cronBridge.ts";
import { createCronTool } from "../cron/cronTool.ts";
import { formatKnowledgeQueryResults, normalizeKnowledgeQueryResults } from "../knowledge/knowledgeFormatting.ts";
import type { ModelProvider } from "../model/provider.ts";
import { resolveRuntimeModel, type RuntimeModel } from "../model/runtimeModel.ts";
import { NativeTaskStoreBridge } from "../task/taskStoreBridge.ts";
import type { TaskNotificationBridge, TaskProgressCardBridge } from "../task/taskNotificationBridge.ts";
import { TaskPlanner } from "../task/taskPlanner.ts";
import { TaskProviderSubagentExecutor } from "../task/taskSubagentExecutor.ts";
import { createTaskTool } from "../task/taskTool.ts";
import type { TaskProgressPublisher } from "../task/taskRuntime.ts";
import { sessionCheckpointFromRunner } from "../runtime/checkpoint.ts";
import type { Tool, ToolContext } from "./tool.ts";
import { ToolRegistry } from "./toolRegistry.ts";

export type NativeRpcClient = {
  request(traceId: string, method: string, params: JsonObject): Promise<unknown>;
};

export function createNativeReadOnlyTools(rpcClient: NativeRpcClient): Tool[] {
  return [createReadFileTool(rpcClient), createListDirTool(rpcClient)];
}

export function createNativeWriteTools(rpcClient: NativeRpcClient): Tool[] {
  return [createWriteFileTool(rpcClient), createEditFileTool(rpcClient), createDeleteFileTool(rpcClient)];
}

export function createNativeShellTools(rpcClient: NativeRpcClient): Tool[] {
  return [createExecTool(rpcClient)];
}

export function createNativeApprovalTools(rpcClient: NativeRpcClient): Tool[] {
  return [createRequestApprovalTool(rpcClient)];
}

export function createNativeFormTools(rpcClient: NativeRpcClient): Tool[] {
  return [createRequestFormTool(rpcClient)];
}

export function createNativeMemoryTools(rpcClient: NativeRpcClient): Tool[] {
  return [
    createSearchMemoryNotesTool(rpcClient),
    createSaveMemoryNoteTool(rpcClient),
    createTraceMemoryNoteTool(rpcClient),
    createRejectMemoryNoteTool(rpcClient),
    createSupersedeMemoryNoteTool(rpcClient),
  ];
}

export function createNativeRagTools(rpcClient: NativeRpcClient): Tool[] {
  return [
    createAddDocumentTool(rpcClient),
    createQueryKnowledgeTool(rpcClient),
    createListDocumentsTool(rpcClient),
    createGetDocumentTool(rpcClient),
    createDeleteDocumentTool(rpcClient),
    createQueryRagTool(rpcClient),
  ];
}

export function createNativeMcpTools(rpcClient: NativeRpcClient): Tool[] {
  return [createCallMcpTool(rpcClient)];
}

export function createNativeCronTools(
  rpcClient: NativeRpcClient,
  options: { defaultTimezone?: string | (() => string | Promise<string>) } = {},
): Tool[] {
  return [createCronTool({ bridge: new NativeCronBridge(rpcClient), defaultTimezone: options.defaultTimezone ?? "UTC" })];
}

export function createNativeSpawnTools(
  rpcClient: NativeRpcClient,
  options: {
    provider: ModelProvider;
    model?: RuntimeModel;
    maxConcurrent?: number;
    timeoutMs?: number;
    idGenerator?: () => string;
    backgroundRegistry?: BackgroundRunRegistry;
    emitDelegatedEvent?: (eventName: DelegatedRunEventName, payload: Record<string, unknown>, traceId?: string) => void;
    maxIterations?: number;
    toolResultBudget?: number;
  },
): Tool[] {
  const runtime = new SubagentRuntime({
    maxConcurrent: options.maxConcurrent,
    timeoutMs: options.timeoutMs,
    idGenerator: options.idGenerator,
    registry: options.backgroundRegistry,
    source: "subagent",
    runner: (request) => runSpawnedSubagent(request, {
      provider: options.provider,
      model: options.model,
      rpcClient,
      emitDelegatedEvent: options.emitDelegatedEvent,
      maxIterations: options.maxIterations,
      toolResultBudget: options.toolResultBudget,
    }),
  });
  const manager = new DelegatedRunManager({
    runtime,
    runStore: isBackgroundRunReader(options.backgroundRegistry) ? options.backgroundRegistry : undefined,
    traceJournal: isBackgroundTraceJournal(options.backgroundRegistry) ? options.backgroundRegistry : undefined,
    emitEvent: (event) => options.emitDelegatedEvent?.(event.eventName, event.payload, event.traceId),
  });
  return [createSpawnTool({ manager }), ...createDelegatedAgentTools({ manager })];
}

export function createNativeTaskTools(
  rpcClient: NativeRpcClient,
  options: {
    provider?: ModelProvider;
    model?: RuntimeModel;
    workspace?: string;
    backgroundRegistry?: BackgroundRunRegistry;
    notifier?: TaskNotificationBridge;
    progressPublisher?: TaskProgressPublisher;
    progressCard?: TaskProgressCardBridge;
  } = {},
): Tool[] {
  const planner = options.provider
    ? new TaskPlanner({
      provider: options.provider,
      model: options.model,
      workspace: options.workspace,
    })
    : undefined;
  const executor = options.provider
    ? new TaskProviderSubagentExecutor({
      provider: options.provider,
      model: options.model,
      runnerTools: createNativeSubagentToolRegistry(rpcClient),
      registry: options.backgroundRegistry,
    })
    : undefined;
  return [createTaskTool({
    store: new NativeTaskStoreBridge(rpcClient),
    planner,
    executor,
    notifier: options.notifier,
    progressPublisher: options.progressPublisher,
    progressCard: options.progressCard,
  })];
}

async function runSpawnedSubagent(
  request: SubagentRunRequest,
  options: {
    provider: ModelProvider;
    model?: RuntimeModel;
    rpcClient: NativeRpcClient;
    emitDelegatedEvent?: (eventName: DelegatedRunEventName, payload: Record<string, unknown>, traceId?: string) => void;
    maxIterations?: number;
    toolResultBudget?: number;
  },
) {
  let childSpec: Parameters<AgentRunner["run"]>[0] | undefined;
  let childCheckpoint: Record<string, unknown> | undefined;
  const childTraceSteps: Array<Record<string, unknown>> = [];
  const contextPack = delegatedContextPackFromMetadata(request.metadata);
  const tools = createNativeSubagentToolRegistry(
    options.rpcClient,
    contextPack?.runtimePolicy.permissionProfile ?? "read_only",
  );
  const runner = new AgentRunner({
    provider: options.provider,
    tools,
    emitEvent: (event) => emitDelegatedChildEvent(request, event, options.emitDelegatedEvent, childTraceSteps),
    checkpoint: (checkpoint) => {
      if (childSpec) {
        childCheckpoint = sessionCheckpointFromRunner(childSpec, checkpoint);
      }
    },
    isCancelled: () => request.signal.aborted,
  });
  childSpec = {
    runId: request.id,
    traceId: typeof request.metadata?.traceId === "string" ? request.metadata.traceId : undefined,
    sessionId: request.sessionKey,
    messages: spawnedSubagentMessages(request),
    model: await resolveRuntimeModel(options.model),
    maxIterations: options.maxIterations ?? 15,
    stream: true,
    toolResultBudget: options.toolResultBudget,
    failOnToolError: true,
  };
  const result = await runner.run(childSpec);
  if (result.stopReason === "awaiting_approval") {
    return {
      status: "awaiting_approval",
      result: "Waiting for approval.",
      metadata: delegatedAwaitingApprovalMetadata(
        request,
        result,
        childCheckpoint,
        delegatedTracePayload(delegatedTraceBase(request), "awaiting_approval", childTraceSteps),
      ),
    } as const;
  }
  if (result.stopReason === "tool_error" || result.stopReason === "error") {
    const error = result.error || result.finalContent || "Error: subagent execution failed.";
    upsertDelegatedTraceStep(childTraceSteps, delegatedFinalTraceStep(request, "failed", error));
    return {
      status: "failed",
      result: error,
      error,
      metadata: {
        _delegate_trace: delegatedTracePayload(delegatedTraceBase(request), "failed", childTraceSteps),
      },
    } as const;
  }
  const finalResult = result.finalContent || "Task completed but no final response was generated.";
  upsertDelegatedTraceStep(childTraceSteps, delegatedFinalTraceStep(request, "completed", finalResult));
  return {
    status: "completed",
    result: finalResult,
    metadata: {
      _delegate_trace: delegatedTracePayload(delegatedTraceBase(request), "completed", childTraceSteps),
    },
  } as const;
}

function isBackgroundRunReader(value: BackgroundRunRegistry | undefined): value is BackgroundRunRegistry & BackgroundRunReader {
  return Boolean(value && "listRuns" in value && typeof value.listRuns === "function");
}

function isBackgroundTraceJournal(value: BackgroundRunRegistry | undefined): value is BackgroundRunRegistry & BackgroundTraceJournal {
  return Boolean(value && "appendTraceEvent" in value && typeof value.appendTraceEvent === "function");
}

function delegatedAwaitingApprovalMetadata(
  request: SubagentRunRequest,
  result: Awaited<ReturnType<AgentRunner["run"]>>,
  childCheckpoint: Record<string, unknown> | undefined,
  trace: Record<string, unknown>,
): Record<string, unknown> {
  const awaiting = result.awaitingInput ?? {};
  const approvalId = stringValue(awaiting.approvalId ?? awaiting.approval_id);
  const operation = asObject(awaiting.operation) ?? {};
  const checkpointTool = approvalToolFromCheckpoint(childCheckpoint, approvalId);
  return {
    ...awaiting,
    awaitingUserInput: true,
    stopReason: "awaiting_approval",
    ...(approvalId ? { approvalId } : {}),
    approvalStatus: "approval_required",
    _delegate_id: request.id,
    _delegate_child_run_id: request.id,
    _delegate_child_tool_call_id: stringValue(awaiting.toolCallId ?? awaiting.tool_call_id) || checkpointTool.toolCallId,
    _delegate_child_tool_name: stringValue(operation.toolName ?? operation.tool_name) || stringValue(awaiting.toolName ?? awaiting.tool_name) || checkpointTool.toolName,
    _delegate_child_checkpoint: childCheckpoint,
    _delegate_operation_preview: approvalArgsPreview(awaiting),
    _delegate_trace: trace,
  };
}

function approvalToolFromCheckpoint(
  checkpoint: Record<string, unknown> | undefined,
  approvalId: string,
): { toolCallId: string; toolName: string } {
  const messages = Array.isArray(checkpoint?.messages) ? checkpoint.messages : [];
  for (const message of messages) {
    const row = asObject(message);
    const metadata = asObject(row?.metadata);
    if (
      row?.role === "tool"
      && metadata?.awaitingUserInput === true
      && metadata?.stopReason === "awaiting_approval"
      && stringValue(metadata.approvalId ?? metadata.approval_id) === approvalId
    ) {
      return {
        toolCallId: stringValue(row.toolCallId ?? row.tool_call_id),
        toolName: stringValue(row.name),
      };
    }
  }
  return { toolCallId: "", toolName: "" };
}

function emitDelegatedChildEvent(
  request: SubagentRunRequest,
  event: { type: string; payload: Record<string, unknown> },
  emitDelegatedEvent: ((eventName: DelegatedRunEventName, payload: Record<string, unknown>, traceId?: string) => void) | undefined,
  traceSteps?: Array<Record<string, unknown>>,
): void {
  if (!emitDelegatedEvent) {
    return;
  }
  const metadata = request.metadata ?? {};
  const parentRunId = stringMetadata(metadata, "parentRunId");
  if (!parentRunId) {
    return;
  }
  const base = {
    runId: parentRunId,
    run_id: parentRunId,
    parentRunId,
    parent_run_id: parentRunId,
    parentTurnId: stringMetadata(metadata, "parentTurnId") || parentRunId,
    parent_turn_id: stringMetadata(metadata, "parentTurnId") || parentRunId,
    delegateId: request.id,
    delegate_id: request.id,
    childRunId: request.id,
    child_run_id: request.id,
    childToolCallId: stringValue(event.payload.toolCallId ?? event.payload.tool_call_id),
    child_tool_call_id: stringValue(event.payload.toolCallId ?? event.payload.tool_call_id),
    toolName: stringValue(event.payload.toolName ?? event.payload.tool_name),
    tool_name: stringValue(event.payload.toolName ?? event.payload.tool_name),
    delegate_type: "spawn",
    title: request.label,
    taskName: stringMetadata(metadata, "taskName") || request.label,
    task_name: stringMetadata(metadata, "taskName") || request.label,
    task: request.task,
    traceRef: stringMetadata(metadata, "traceId") || `trace-delegate-${request.id}`,
    trace_ref: stringMetadata(metadata, "traceId") || `trace-delegate-${request.id}`,
    workflow: "Spawned agent workflow",
  };
  if (event.type === "reasoning_delta" || event.type === "content_delta" || event.type === "tool_call_delta") {
    const step = delegatedStreamTraceStep(request, event);
    upsertDelegatedTraceStep(traceSteps, step);
    emitDelegatedEvent("agent.delegate.trace.updated", {
      ...base,
      status: "running",
      latest_activity: step.summary,
      trace: delegatedTracePayload(base, "running", traceSteps ?? [step]),
    }, stringMetadata(metadata, "traceId"));
    return;
  }
  if (event.type !== "tool_start" && event.type !== "tool_result") {
    return;
  }
  if (event.type === "tool_start") {
    const step = delegatedToolTraceStep(base, {
      kind: "tool_call",
      status: "running",
      title: base.toolName || "tool",
      argsPreview: safeJsonStringify(event.payload.args ?? {}),
    });
    upsertDelegatedTraceStep(traceSteps, step);
    emitDelegatedEvent("agent.delegate.running", {
      ...base,
      status: "running",
      latest_activity: `Child tool ${base.toolName || "tool"} started.`,
      operation_preview: safeJsonStringify(event.payload.args ?? {}),
    }, stringMetadata(metadata, "traceId"));
    emitDelegatedEvent("agent.delegate.trace.updated", {
      ...base,
      status: "running",
      latest_activity: step.summary,
      trace: delegatedTracePayload(base, "running", [step]),
    }, stringMetadata(metadata, "traceId"));
    return;
  }
  const resultMetadata = asObject(event.payload.metadata) ?? {};
  const content = stringValue(event.payload.content ?? event.payload.result ?? event.payload.output);
  const awaitingApproval = isAwaitingApprovalToolResult(resultMetadata, content);
  if (awaitingApproval) {
    const approvalId = stringValue(resultMetadata.approvalId ?? resultMetadata.approval_id);
    const payload = {
      ...base,
      ...(approvalId ? { approvalId, approval_id: approvalId } : {}),
      status: "blocked",
      latest_activity: content || "Waiting for approval.",
      operation_preview: approvalArgsPreview(resultMetadata),
      reason: stringValue(resultMetadata.reason),
    };
    const step = delegatedToolTraceStep(base, {
      kind: "approval",
      status: "blocked",
      title: `${base.toolName || "tool"} approval required`,
      approvalId,
      argsPreview: approvalArgsPreview(resultMetadata),
      resultPreview: content || "Waiting for approval.",
    });
    upsertDelegatedTraceStep(traceSteps, step);
    emitDelegatedEvent("agent.delegate.tool.approval_required", payload, stringMetadata(metadata, "traceId"));
    emitDelegatedEvent("agent.delegate.awaiting_approval", payload, stringMetadata(metadata, "traceId"));
    emitDelegatedEvent("agent.delegate.trace.updated", {
      ...payload,
      trace: delegatedTracePayload(base, "awaiting_approval", [step]),
    }, stringMetadata(metadata, "traceId"));
    return;
  }
  const step = delegatedToolTraceStep(base, {
    kind: "tool_call",
    status: "completed",
    title: base.toolName || "tool",
    resultPreview: content,
  });
  upsertDelegatedTraceStep(traceSteps, step);
  emitDelegatedEvent("agent.delegate.tool.completed", {
    ...base,
    status: "running",
    latest_activity: content,
    result_preview: content,
  }, stringMetadata(metadata, "traceId"));
  emitDelegatedEvent("agent.delegate.trace.updated", {
    ...base,
    status: "running",
    latest_activity: step.summary,
    trace: delegatedTracePayload(base, "running", [step]),
  }, stringMetadata(metadata, "traceId"));
}

function delegatedStreamTraceStep(
  request: SubagentRunRequest,
  event: { type: string; payload: Record<string, unknown> },
): Record<string, unknown> {
  const now = new Date().toISOString();
  if (event.type === "reasoning_delta") {
    const summary = stringValue(event.payload.delta);
    return {
      id: `reasoning:${request.id}`,
      kind: "reasoning",
      status: "running",
      title: "Thinking",
      summary,
      createdAt: now,
      updatedAt: now,
    };
  }
  if (event.type === "tool_call_delta") {
    const toolCallId = stringValue(event.payload.toolCallId ?? event.payload.tool_call_id ?? event.payload.id) || "tool-call-delta";
    return {
      id: `tool-delta:${toolCallId}`,
      kind: "tool_call",
      status: "running",
      title: stringValue(event.payload.toolName ?? event.payload.tool_name ?? event.payload.name) || "Tool call",
      summary: stringValue(event.payload.delta ?? event.payload.argumentsDelta ?? event.payload.arguments_delta),
      toolCallId,
      createdAt: now,
      updatedAt: now,
    };
  }
  const summary = stringValue(event.payload.delta);
  return {
    id: `message:${request.id}`,
    kind: "message",
    status: "running",
    title: "Assistant message",
    summary,
    createdAt: now,
    updatedAt: now,
  };
}

function delegatedTracePayload(
  base: Record<string, string>,
  status: string,
  steps: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    delegateId: base.delegateId,
    delegate_id: base.delegateId,
    childRunId: base.childRunId,
    child_run_id: base.childRunId,
    parentRunId: base.parentRunId,
    parent_run_id: base.parentRunId,
    parentSessionKey: "",
    parent_session_key: "",
    status,
    steps,
    approvals: steps.filter((step) => step.kind === "approval"),
    artifacts: [],
    updatedAt: now,
    updated_at: now,
  };
}

function delegatedTraceBase(request: SubagentRunRequest): Record<string, string> {
  const metadata = request.metadata ?? {};
  const parentRunId = stringMetadata(metadata, "parentRunId") || "";
  return {
    delegateId: request.id,
    childRunId: request.id,
    parentRunId,
    parentSessionKey: request.sessionKey ?? "",
  };
}

function upsertDelegatedTraceStep(
  steps: Array<Record<string, unknown>> | undefined,
  step: Record<string, unknown>,
): void {
  if (!steps) {
    return;
  }
  const id = stringValue(step.id);
  const index = id ? steps.findIndex((item) => stringValue(item.id) === id) : -1;
  if (index >= 0) {
    steps[index] = mergeDelegatedTraceStep(steps[index], step);
  } else {
    steps.push(step);
  }
}

function mergeDelegatedTraceStep(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const kind = stringValue(next.kind);
  const currentStatus = stringValue(current.status);
  const nextStatus = stringValue(next.status);
  const currentSummary = stringValue(current.summary);
  const nextSummary = stringValue(next.summary);
  const shouldAppendStreamingSummary = Boolean(
    nextSummary
    && currentStatus === "running"
    && nextStatus === "running"
    && (kind === "reasoning" || kind === "message" || kind === "tool_call")
  );
  return {
    ...current,
    ...next,
    ...(shouldAppendStreamingSummary
      ? { summary: `${currentSummary}${nextSummary}` }
      : {}),
  };
}

function delegatedFinalTraceStep(
  request: SubagentRunRequest,
  status: "completed" | "failed",
  summary: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: `final:${request.id}`,
    kind: status === "failed" ? "error" : "message",
    status,
    title: status === "failed" ? "Error" : "Final answer",
    summary,
    error: status === "failed" ? summary : undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function delegatedToolTraceStep(
  base: Record<string, string>,
  input: {
    approvalId?: string;
    argsPreview?: string;
    kind: "tool_call" | "approval";
    resultPreview?: string;
    status: "running" | "blocked" | "completed";
    title: string;
  },
): Record<string, unknown> {
  const now = new Date().toISOString();
  const summary = input.kind === "approval"
    ? input.resultPreview || "Waiting for approval."
    : input.status === "running"
      ? `Child tool ${base.toolName || "tool"} started.`
      : input.resultPreview || `Child tool ${base.toolName || "tool"} completed.`;
  return {
    id: input.approvalId ? `approval:${input.approvalId}` : `tool:${base.childToolCallId}:${input.status}`,
    kind: input.kind,
    status: input.status,
    title: input.title,
    summary,
    toolName: base.toolName,
    toolCallId: base.childToolCallId,
    approvalId: input.approvalId,
    argsPreview: input.argsPreview,
    resultPreview: input.resultPreview,
    createdAt: now,
    updatedAt: now,
  };
}

function isAwaitingApprovalToolResult(metadata: Record<string, unknown>, content: string): boolean {
  return Boolean(
    metadata.awaitingUserInput === true && stringValue(metadata.stopReason ?? metadata.stop_reason) === "awaiting_approval"
    || stringValue(metadata.approvalStatus ?? metadata.approval_status) === "approval_required"
    || content.trim() === "Waiting for approval.",
  );
}

function approvalArgsPreview(metadata: Record<string, unknown>): string {
  const explicit = stringValue(metadata.argsPreview ?? metadata.args_preview);
  if (explicit) {
    return explicit;
  }
  const operation = asObject(metadata.operation) ?? {};
  const args = operation.arguments ?? operation.args;
  return typeof args === "string" ? args : safeJsonStringify(args ?? {});
}

function stringMetadata(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function spawnedSubagentMessages(request: Pick<SubagentRunRequest, "task" | "metadata">): AgentMessage[] {
  const contextPack = delegatedContextPackFromMetadata(request.metadata);
  if (contextPack) {
    const forkedMessages = Array.isArray(contextPack.forkedMessages) ? contextPack.forkedMessages : [];
    return [
      {
        role: "system",
        content: [
          "You are a focused delegated subagent.",
          "Complete only the assigned delegated task.",
          "Do not copy raw child trace into the parent response; return a compact result summary.",
          `Parent run: ${contextPack.parentRunId}`,
          `Parent turn: ${contextPack.parentTurnId}`,
          `Permission profile: ${contextPack.runtimePolicy.permissionProfile}`,
          `Approval policy: ${contextPack.runtimePolicy.approvalPolicy}`,
          contextPack.runtimePolicy.cwd ? `Working directory: ${contextPack.runtimePolicy.cwd}` : null,
          contextPack.runtimePolicy.workspace ? `Workspace: ${contextPack.runtimePolicy.workspace}` : null,
          `Fork policy: ${formatForkPolicy(contextPack.forkTurns)}`,
          contextPack.outputContract,
        ].filter((line): line is string => line !== null).join("\n"),
      },
      ...forkedMessages.map(cloneAgentMessage),
      {
        role: "user",
        content: [
          `Task name: ${contextPack.taskName}`,
          "Delegated task:",
          contextPack.message,
        ].join("\n"),
      },
    ];
  }
  return [
    {
      role: "system",
      content: [
        "You are a focused task execution subagent.",
        "Complete only the assigned task and return a concise result summary.",
      ].join("\n"),
    },
    { role: "user", content: request.task },
  ];
}

function cloneAgentMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    toolCalls: message.toolCalls?.map((toolCall) => ({ ...toolCall })),
    thinkingBlocks: message.thinkingBlocks?.map((block) => ({ ...block })),
    metadata: message.metadata ? { ...message.metadata } : undefined,
  };
}

function delegatedContextPackFromMetadata(metadata: Record<string, unknown> | undefined): DelegatedContextPack | null {
  const pack = asObject(metadata?.delegatedContextPack);
  if (!pack || pack.kind !== "delegated_context_pack") {
    return null;
  }
  const runtimePolicy = asObject(pack.runtimePolicy);
  if (
    typeof pack.taskName !== "string"
    || typeof pack.message !== "string"
    || typeof pack.parentRunId !== "string"
    || typeof pack.parentTurnId !== "string"
    || typeof pack.parentSessionKey !== "string"
    || typeof pack.forkTurns !== "string"
    || typeof pack.outputContract !== "string"
    || !runtimePolicy
    || typeof runtimePolicy.permissionProfile !== "string"
    || typeof runtimePolicy.approvalPolicy !== "string"
  ) {
    return null;
  }
  return pack as unknown as DelegatedContextPack;
}

function formatForkPolicy(forkTurns: DelegatedContextPack["forkTurns"]): string {
  if (forkTurns === "none") {
    return "no parent conversation turns were forked";
  }
  if (forkTurns === "all") {
    return "full parent conversation requested";
  }
  return `recent ${forkTurns} parent turn(s) requested`;
}

function createNativeSubagentToolRegistry(
  rpcClient: NativeRpcClient,
  permissionProfile: DelegatedPermissionProfile = "read_only",
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createNativeApprovalTools(rpcClient)) {
    registry.register(tool);
  }
  for (const tool of delegatedChildToolsForProfile(rpcClient, permissionProfile)) {
    registry.register(tool);
  }
  return registry;
}

function delegatedChildToolsForProfile(rpcClient: NativeRpcClient, permissionProfile: DelegatedPermissionProfile): Tool[] {
  const readOnlyTools = createNativeReadOnlyTools(rpcClient);
  if (permissionProfile === "workspace_write") {
    return [...readOnlyTools, ...createNativeWriteTools(rpcClient)];
  }
  if (
    permissionProfile === "shell_sandboxed"
    || permissionProfile === "network_allowlist"
    || permissionProfile === "full_access"
  ) {
    return [...readOnlyTools, ...createNativeWriteTools(rpcClient), ...createNativeShellTools(rpcClient)];
  }
  return readOnlyTools;
}

function nativeApprovalContextParams(context: ToolContext): JsonObject {
  const params: JsonObject = { run_id: context.runId };
  if (context.sessionId) {
    params.session_id = context.sessionId;
  }
  return params;
}

function normalizeApprovalPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function createReadFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "read_file",
    description: "Read the contents of a file. Returns numbered lines. Use offset and limit to paginate through large files.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["fs.workspace.read"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The workspace-relative file path to read" },
        offset: { type: "integer", minimum: 1, description: "Line number to start reading from (1-indexed, default 1)" },
        limit: { type: "integer", minimum: 1, description: "Maximum number of lines to read (default 2000)" },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const offset = optionalIntegerArg(args, "offset");
      const limit = optionalIntegerArg(args, "limit");
      const params: JsonObject = { path, format: "numbered_lines" };
      if (offset !== undefined) {
        params.offset = offset;
      }
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = await rpcClient.request(requireTraceId(context.traceId), "workspace.read_file", params);
      const file = asObject(result);
      const contents = typeof file?.content === "string"
        ? file.content
        : typeof file?.contents === "string"
          ? file.contents
          : "";
      return { content: contents };
    },
  };
}

function createListDirTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "list_dir",
    description: "List the contents of a directory. Set recursive=true to explore nested structure.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["fs.workspace.read"],
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "The workspace-relative directory path to list" },
        recursive: { type: "boolean", description: "Recursively list all files (default false)" },
        max_entries: { type: "integer", minimum: 1, description: "Maximum entries to return (default 200)" },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const recursive = optionalBooleanArg(args, "recursive");
      const maxEntries = optionalIntegerArg(args, "max_entries");
      const params: JsonObject = { path };
      if (recursive !== undefined) {
        params.recursive = recursive;
      }
      if (maxEntries !== undefined) {
        params.max_entries = maxEntries;
      }
      const result = await rpcClient.request(requireTraceId(context.traceId), "workspace.list_dir", params);
      const response = asObject(result);
      const entries = Array.isArray(response?.entries) ? response.entries : Array.isArray(result) ? result : [];
      return {
        content: entries
          .map((entry) => {
            const object = asObject(entry);
            if (typeof object?.path !== "string") {
              return null;
            }
            return object.kind === "dir" && !object.path.endsWith("/") ? `${object.path}/` : object.path;
          })
          .filter((path): path is string => path !== null)
          .join("\n"),
      };
    },
  };
}

function createWriteFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "write_file",
    description: "Write content to a file at the given path. Creates parent directories if needed.",
    capabilities: ["fs.workspace.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const content = stringArgAllowEmpty(args, "content");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "workspace.write_file", {
        path,
        contents: content,
        ...nativeApprovalContextParams(context),
      })) ?? {};
      const resultPath = asString(result.path) ?? path;
      const bytesWritten = typeof result.bytes_written === "number" ? result.bytes_written : content.length;
      return { content: `Wrote ${bytesWritten} bytes to ${resultPath}.` };
    },
  };
}

function createEditFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "edit_file",
    description: "Edit a file by replacing old_text with new_text. Set replace_all=true to replace every occurrence.",
    capabilities: ["fs.workspace.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_text: { type: "string" },
        new_text: { type: "string" },
        replace_all: { type: "boolean" },
      },
      required: ["path", "old_text", "new_text"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const oldText = stringArgAllowEmpty(args, "old_text");
      const newText = stringArgAllowEmpty(args, "new_text");
      const replaceAll = optionalBooleanArg(args, "replace_all") ?? false;
      const traceId = requireTraceId(context.traceId);
      const file = asObject(await rpcClient.request(traceId, "workspace.read_file", { path, format: "raw" })) ?? {};
      const rawContent = typeof file.content === "string"
        ? file.content
        : typeof file.contents === "string"
          ? file.contents
          : "";
      const edit = applyTextEdit(rawContent, oldText, newText, replaceAll, path);
      if (!edit.ok) {
        return { content: edit.content };
      }
      await rpcClient.request(traceId, "workspace.write_file", {
        path,
        contents: edit.content,
        approval_fingerprint: `edit_file:${normalizeApprovalPath(path)}`,
        approval_session_fingerprint: `edit_file:${normalizeApprovalPath(path)}`,
        ...nativeApprovalContextParams(context),
      });
      return { content: `Edited ${path}.` };
    },
  };
}

function createDeleteFileTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "delete_file",
    description: "Delete a file or directory. Directories must be empty unless recursive=true.",
    capabilities: ["fs.workspace.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
      required: ["path"],
    },
    execute: async (args, context) => {
      const path = stringArg(args, "path");
      const recursive = optionalBooleanArg(args, "recursive") ?? false;
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "workspace.delete_file", {
        path,
        recursive,
        ...nativeApprovalContextParams(context),
      })) ?? {};
      const resultPath = asString(result.path) ?? path;
      const kind = asString(result.kind) ?? "path";
      return { content: `Deleted ${kind} ${resultPath}.` };
    },
  };
}

function createExecTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "exec",
    description: "Execute a shell command in the workspace and return output. Use with caution.",
    exclusive: true,
    capabilities: ["shell.execute"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        working_dir: { type: "string" },
        timeout: { type: "integer", minimum: 1, maximum: 600 },
      },
      required: ["command"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        command: stringArg(args, "command"),
        restrict_to_workspace: true,
        ...nativeApprovalContextParams(context),
      };
      const workingDir = optionalStringArg(args, "working_dir");
      const timeout = optionalIntegerArg(args, "timeout");
      if (workingDir !== undefined) {
        params.working_dir = workingDir;
      }
      if (timeout !== undefined) {
        params.timeout = timeout;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "shell.execute", params)) ?? {};
      return {
        content: asString(result.content) ?? formatShellResult(result),
        metadata: {
          exitCode: typeof result.exit_code === "number" ? result.exit_code : undefined,
          timedOut: result.timed_out === true,
          blocked: result.blocked === true,
          truncated: result.truncated === true,
        },
      };
    },
  };
}

function createRequestFormTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "request_form",
    description: "Request structured user input through the native Agent UI form renderer.",
    capabilities: ["form.request"],
    parameters: {
      type: "object",
      properties: {
        form: {
          type: "object",
          description: "Agent UI form schema containing form_id, title, and fields.",
        },
        continuation_mode: {
          type: "string",
          enum: ["structured_message", "resume"],
          description: "How the submitted form should continue the conversation.",
        },
      },
      required: ["form"],
    },
    execute: async (args, context) => {
      const form = objectArg(args, "form");
      const continuationMode = optionalStringArg(args, "continuation_mode") ?? "structured_message";
      const params: JsonObject = {
        run_id: context.runId,
        form,
        continuation_mode: continuationMode,
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "form.request", params)) ?? {};
      const { content: rawContent, ...rawMetadata } = result;
      const metadata = {
        awaitingUserInput: true,
        stopReason: "awaiting_form",
        formId: asString(rawMetadata.formId) ?? asString(form.form_id),
        form: asObject(rawMetadata.form) ?? form,
        continuationMode: asString(rawMetadata.continuationMode) ?? continuationMode,
        ...rawMetadata,
      };
      return {
        content: asString(rawContent) ?? `Waiting for form submission${metadata.formId ? `: ${metadata.formId}` : ""}.`,
        metadata,
      };
    },
  };
}

function createRequestApprovalTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "request_approval",
    description: "Request user approval for a pending native operation before it is executed.",
    capabilities: ["approval.request"],
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "object",
          description: "Operation metadata including toolName, arguments, category, risk, and reason.",
        },
      },
      required: ["operation"],
    },
    execute: async (args, context) => {
      const operation = objectArg(args, "operation");
      const params: JsonObject = {
        run_id: context.runId,
        operation,
      };
      const classification = asObject(args.classification);
      if (classification) {
        params.classification = classification;
      }
      const fingerprint = asString(args.fingerprint);
      if (fingerprint) {
        params.fingerprint = fingerprint;
      }
      const sessionFingerprint = asString(args.sessionFingerprint);
      if (sessionFingerprint) {
        params.session_fingerprint = sessionFingerprint;
      }
      const summary = asString(args.summary);
      if (summary) {
        params.summary = summary;
      }
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "approval.request", params)) ?? {};
      const { content: rawContent, ...rawMetadata } = result;
      const metadata = approvalRequestAlreadyAllowed(rawMetadata)
        ? {
          operation: asObject(rawMetadata.operation) ?? operation,
          ...rawMetadata,
        }
        : {
          awaitingUserInput: true,
          stopReason: "awaiting_approval",
          operation: asObject(rawMetadata.operation) ?? operation,
          ...rawMetadata,
        };
      return {
        content: asString(rawContent) ?? "Waiting for approval.",
        metadata,
      };
    },
  };
}

function approvalRequestAlreadyAllowed(metadata: Record<string, unknown>): boolean {
  return metadata.decision === "allow"
    || metadata.status === "approved"
    || metadata.approvalStatus === "approved"
    || metadata.approved === true;
}

function createSearchMemoryNotesTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "search_memory_notes",
    description: "Search Memory Notes by query, type, status, and limit without mixing in Experience or Knowledge Base.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["memory.read"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional lexical query over Memory Notes." },
        note_type: { type: "string", enum: ["preference", "instruction", "project", "decision", "fix", "followup"] },
        scope: { type: "string", enum: ["user", "assistant", "project", "session"] },
        status: { type: "string", enum: ["active", "superseded", "rejected"] },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
    execute: async (args, context) => {
      const params: JsonObject = {};
      copyOptionalStringArg(args, params, "query");
      copyOptionalStringArg(args, params, "note_type");
      copyOptionalStringArg(args, params, "scope");
      copyOptionalStringArg(args, params, "status");
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.search", params)) ?? {};
      const notes = Array.isArray(result.notes) ? result.notes : [];
      return {
        content: formatMemoryNotes(notes),
        metadata: { _memory_references: notes.map(formatMemoryReference).filter((reference): reference is JsonObject => reference !== null) },
      };
    },
  };
}

function createAddDocumentTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "add_document",
    description: "Add a document to the native Knowledge Base for future retrieval.",
    capabilities: ["knowledge.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1 },
        content: { type: "string", minLength: 1 },
        tags: { type: "string", description: "Optional comma-separated tags." },
        category: { type: "string" },
        file_type: { type: "string", enum: ["txt", "md"] },
        original_path: { type: "string" },
      },
      required: ["name", "content"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        name: stringArg(args, "name"),
        content: stringArg(args, "content"),
      };
      copyOptionalStringArg(args, params, "category");
      copyOptionalStringArg(args, params, "file_type");
      copyOptionalStringArg(args, params, "original_path");
      const tags = optionalStringListArg(args, "tags");
      if (tags.length > 0) {
        params.tags = tags;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.add_document", params)) ?? {};
      const document = asObject(result.document) ?? {};
      const name = asString(document.name) ?? stringArg(args, "name");
      const id = asString(document.id) ?? "unknown";
      return { content: `Successfully added document '${name}' to knowledge base (ID: ${id})\nDocument saved locally and indexed for sparse retrieval.` };
    },
  };
}

function createQueryKnowledgeTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "query_knowledge",
    description: "Query the native Knowledge Base for contextual evidence relevant to the current task.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["knowledge.read"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Natural-language knowledge retrieval query." },
        category: { type: "string", description: "Optional knowledge document category filter." },
        tags: { type: "string", description: "Optional comma-separated tags filter." },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        query: stringArg(args, "query"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "category");
      const tags = optionalStringListArg(args, "tags");
      if (tags.length > 0) {
        params.tags = tags;
      }
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.query", params)) ?? {};
      const rawResults = Array.isArray(result.results)
        ? result.results
        : Array.isArray(result.documents)
          ? result.documents
          : [];
      return { content: formatKnowledgeQueryResults(normalizeKnowledgeQueryResults(rawResults)) };
    },
  };
}

function createListDocumentsTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "list_documents",
    description: "List documents in the native Knowledge Base.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["knowledge.read"],
    parameters: {
      type: "object",
      properties: {
        category: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    execute: async (args, context) => {
      const params: JsonObject = {};
      copyOptionalStringArg(args, params, "category");
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.list_documents", params)) ?? {};
      const documents = Array.isArray(result.documents) ? result.documents : [];
      return { content: formatKnowledgeDocuments(documents) };
    },
  };
}

function createGetDocumentTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "get_document",
    description: "Get the full content of a Knowledge Base document by ID.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["knowledge.read"],
    parameters: {
      type: "object",
      properties: {
        doc_id: { type: "string", minLength: 1 },
      },
      required: ["doc_id"],
    },
    execute: async (args, context) => {
      const docId = stringArg(args, "doc_id");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.get_document", { doc_id: docId })) ?? {};
      const content = typeof result.content === "string" ? result.content : "";
      return { content: `## Document Content (ID: ${docId})\n\n${content}` };
    },
  };
}

function createDeleteDocumentTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "delete_document",
    description: "Delete a document and its chunks from the native Knowledge Base.",
    capabilities: ["knowledge.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        doc_id: { type: "string", minLength: 1 },
      },
      required: ["doc_id"],
    },
    execute: async (args, context) => {
      const docId = stringArg(args, "doc_id");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "knowledge.delete_document", { doc_id: docId })) ?? {};
      return {
        content: result.deleted === true
          ? `Successfully deleted document ${docId} and all associated data.`
          : `Error: Document ${docId} not found`,
      };
    },
  };
}

function createQueryRagTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "query_rag",
    description: "Compatibility alias for query_knowledge. Query the native retrieval index for workspace knowledge.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["fs.workspace.read"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Natural-language retrieval query." },
        collection: { type: "string", description: "Optional native RAG collection or workspace area to query." },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        query: stringArg(args, "query"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "collection");
      const limit = optionalIntegerArg(args, "limit");
      if (limit !== undefined) {
        params.limit = limit;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "rag.query", params)) ?? {};
      const documents = Array.isArray(result.documents) ? result.documents : [];
      return { content: formatRagDocuments(documents) };
    },
  };
}

function createSaveMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "save_memory_note",
    description:
      "Save durable agent-side memory as a typed Memory Note. Use this only for durable preferences, instructions, project facts, decisions, fixes, or followups.",
    capabilities: ["memory.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", minLength: 1 },
        note_type: { type: "string", enum: ["preference", "instruction", "project", "decision", "fix", "followup"] },
        scope: { type: "string", enum: ["user", "assistant", "project", "session"] },
        priority: { type: "number", minimum: 0, maximum: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        tags: { type: "string", description: "Optional comma-separated tags." },
        metadata: { type: "string", description: "Optional JSON object metadata." },
        message_start: { type: "integer", minimum: 0 },
        message_end: { type: "integer", minimum: 0 },
      },
      required: ["content", "note_type"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        content: stringArg(args, "content"),
        note_type: stringArg(args, "note_type"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "scope");
      const priority = optionalNumberArg(args, "priority");
      if (priority !== undefined) {
        params.priority = priority;
      }
      const confidence = optionalNumberArg(args, "confidence");
      if (confidence !== undefined) {
        params.confidence = confidence;
      }
      const tags = optionalStringArg(args, "tags");
      if (tags !== undefined) {
        params.tags = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      }
      const metadata = optionalStringArg(args, "metadata");
      if (metadata !== undefined) {
        const parsed = JSON.parse(metadata);
        if (!asObject(parsed)) {
          throw new Error("metadata must be a JSON object");
        }
        params.metadata = parsed;
      }
      const messageStart = optionalIntegerArg(args, "message_start");
      if (messageStart !== undefined) {
        params.message_start = messageStart;
      }
      const messageEnd = optionalIntegerArg(args, "message_end");
      if (messageEnd !== undefined) {
        params.message_end = messageEnd;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.save", params)) ?? {};
      const note = asObject(result.note) ?? {};
      return {
        content: `Memory Note saved: ${asString(note.id) ?? "unknown"} (${asString(note.type) ?? "unknown"}, ${asString(note.status) ?? "unknown"})`,
      };
    },
  };
}

function createTraceMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "trace_memory_note",
    description: "Trace a Memory Note to its canonical JSONL row and rendered memory view location.",
    readOnly: true,
    concurrencySafe: true,
    capabilities: ["memory.read"],
    parameters: {
      type: "object",
      properties: {
        note_id: { type: "string", minLength: 1 },
      },
      required: ["note_id"],
    },
    execute: async (args, context) => {
      const noteId = stringArg(args, "note_id");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.trace", {
        note_id: noteId,
      })) ?? {};
      return { content: formatMemoryTrace(result) };
    },
  };
}

function createRejectMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "reject_memory_note",
    description: "Mark a Memory Note as rejected so it no longer appears in active memory recall or managed views.",
    capabilities: ["memory.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        note_id: { type: "string", minLength: 1 },
        reason: { type: "string" },
      },
      required: ["note_id"],
    },
    execute: async (args, context) => {
      const params: JsonObject = { note_id: stringArg(args, "note_id") };
      copyOptionalStringArg(args, params, "reason");
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.reject", params)) ?? {};
      const note = asObject(result.note) ?? {};
      return { content: `Memory Note rejected: ${asString(note.id) ?? params.note_id}` };
    },
  };
}

function createSupersedeMemoryNoteTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "supersede_memory_note",
    description: "Replace an existing Memory Note with a new active note and mark the old note as superseded.",
    capabilities: ["memory.write"],
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        note_id: { type: "string", minLength: 1 },
        replacement_content: { type: "string", minLength: 1 },
        note_type: { type: "string", enum: ["preference", "instruction", "project", "decision", "fix", "followup"] },
        scope: { type: "string", enum: ["user", "assistant", "project", "session"] },
        priority: { type: "number", minimum: 0, maximum: 1 },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        tags: { type: "string", description: "Optional comma-separated tags." },
        metadata: { type: "string", description: "Optional JSON object metadata." },
        message_start: { type: "integer", minimum: 0 },
        message_end: { type: "integer", minimum: 0 },
      },
      required: ["note_id", "replacement_content"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        note_id: stringArg(args, "note_id"),
        replacement_content: stringArg(args, "replacement_content"),
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      copyOptionalStringArg(args, params, "note_type");
      copyOptionalStringArg(args, params, "scope");
      const priority = optionalNumberArg(args, "priority");
      if (priority !== undefined) {
        params.priority = priority;
      }
      const confidence = optionalNumberArg(args, "confidence");
      if (confidence !== undefined) {
        params.confidence = confidence;
      }
      const tags = optionalStringArg(args, "tags");
      if (tags !== undefined) {
        params.tags = tags
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag.length > 0);
      }
      const metadata = optionalStringArg(args, "metadata");
      if (metadata !== undefined) {
        const parsed = JSON.parse(metadata);
        if (!asObject(parsed)) {
          throw new Error("metadata must be a JSON object");
        }
        params.metadata = parsed;
      }
      const messageStart = optionalIntegerArg(args, "message_start");
      if (messageStart !== undefined) {
        params.message_start = messageStart;
      }
      const messageEnd = optionalIntegerArg(args, "message_end");
      if (messageEnd !== undefined) {
        params.message_end = messageEnd;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "memory.supersede", params)) ?? {};
      const oldNote = asObject(result.old_note) ?? {};
      const replacement = asObject(result.note) ?? {};
      return {
        content: `Memory Note superseded: ${asString(oldNote.id) ?? params.note_id} -> ${asString(replacement.id) ?? "unknown"}`,
      };
    },
  };
}

function createCallMcpTool(rpcClient: NativeRpcClient): Tool {
  return {
    name: "call_mcp_tool",
    description: "Call an allowlisted tool on a configured native MCP server.",
    capabilities: ["mcp.call"],
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", minLength: 1, description: "Configured MCP server name." },
        tool: { type: "string", minLength: 1, description: "Raw MCP tool name on that server." },
        arguments: {
          type: "object",
          description: "JSON object arguments to pass to the MCP tool.",
        },
      },
      required: ["server", "tool"],
    },
    execute: async (args, context) => {
      const params: JsonObject = {
        server: stringArg(args, "server"),
        tool: stringArg(args, "tool"),
        arguments: asObject(args.arguments) ?? {},
      };
      if (context.sessionId) {
        params.session_id = context.sessionId;
      }
      const result = asObject(await rpcClient.request(requireTraceId(context.traceId), "mcp.call_tool", params)) ?? {};
      return { content: formatMcpToolResult(result) };
    },
  };
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a string when provided`);
  }
  return value;
}

function stringArgAllowEmpty(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function objectArg(args: Record<string, unknown>, key: string): JsonObject {
  const value = args[key];
  const object = asObject(value);
  if (!object) {
    throw new Error(`${key} must be an object`);
  }
  return object;
}

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a number when provided`);
  }
  return value;
}

function optionalIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = optionalNumberArg(args, key);
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
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

function copyOptionalStringArg(args: Record<string, unknown>, params: JsonObject, key: string): void {
  const value = optionalStringArg(args, key);
  if (value !== undefined) {
    params[key] = value;
  }
}

function requireTraceId(traceId: string | undefined): string {
  if (!traceId) {
    throw new Error("native tool requires traceId");
  }
  return traceId;
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function applyTextEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean,
  path: string,
): { ok: true; content: string } | { ok: false; content: string } {
  const usesCrLf = content.includes("\r\n");
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const normalizedOld = oldText.replace(/\r\n/g, "\n");
  const normalizedNew = newText.replace(/\r\n/g, "\n");
  const match = findTextMatch(normalizedContent, normalizedOld);
  if (!match.fragment) {
    return { ok: false, content: `Error: old_text not found in ${path}. Verify the file content.` };
  }
  if (match.count > 1 && !replaceAll) {
    return {
      ok: false,
      content: `Warning: old_text appears ${match.count} times. Provide more context to make it unique, or set replace_all=true.`,
    };
  }
  const updated = replaceAll
    ? normalizedContent.split(match.fragment).join(normalizedNew)
    : normalizedContent.replace(match.fragment, normalizedNew);
  return { ok: true, content: usesCrLf ? updated.replace(/\n/g, "\r\n") : updated };
}

function findTextMatch(content: string, oldText: string): { fragment: string | null; count: number } {
  if (oldText.length > 0 && content.includes(oldText)) {
    return { fragment: oldText, count: content.split(oldText).length - 1 };
  }
  const oldLines = oldText.split("\n");
  if (oldLines.length === 0) {
    return { fragment: null, count: 0 };
  }
  const strippedOld = oldLines.map((line) => line.trim());
  const contentLines = content.split("\n");
  const candidates: string[] = [];
  for (let index = 0; index <= contentLines.length - strippedOld.length; index += 1) {
    const window = contentLines.slice(index, index + strippedOld.length);
    if (window.map((line) => line.trim()).join("\n") === strippedOld.join("\n")) {
      candidates.push(window.join("\n"));
    }
  }
  return { fragment: candidates[0] ?? null, count: candidates.length };
}

function formatShellResult(result: JsonObject): string {
  const parts: string[] = [];
  if (typeof result.stdout === "string" && result.stdout.length > 0) {
    parts.push(result.stdout);
  }
  if (typeof result.stderr === "string" && result.stderr.trim().length > 0) {
    parts.push(`STDERR:\n${result.stderr}`);
  }
  if (typeof result.exit_code === "number") {
    parts.push(`Exit code: ${result.exit_code}`);
  }
  return parts.join("\n").trim() || "(no output)";
}

function formatMemoryNotes(notes: unknown[]): string {
  const formatted = notes.map(formatMemoryNote).filter((line): line is string => line !== null);
  if (formatted.length === 0) {
    return "No Memory Notes found.";
  }
  return `## Memory Notes\n${formatted.join("\n")}`;
}

function formatMemoryNote(value: unknown): string | null {
  const note = asObject(value);
  if (!note) {
    return null;
  }
  const id = asString(note.id) ?? "unknown";
  const scope = asString(note.scope) ?? "project";
  const type = asString(note.type) ?? "project";
  const status = asString(note.status) ?? "active";
  const priority = typeof note.priority === "number" ? note.priority : 0.5;
  const confidence = typeof note.confidence === "number" ? note.confidence : 0.5;
  const tags = Array.isArray(note.tags) && note.tags.length > 0 ? ` tags=${note.tags.join(",")}` : "";
  const metadata = asObject(note.metadata) ? ` metadata=${JSON.stringify(note.metadata)}` : "";
  return `- [${id}] ${scope}/${type}/${status} priority=${formatMemoryNumber(priority)} confidence=${formatMemoryNumber(confidence)}${tags}${metadata}\n  ${asString(note.content) ?? ""}\n  sources: ${formatMemorySources(note.sources)}`;
}

function optionalStringListArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item !== "string" || !item.trim()) {
        throw new Error(`${key} must contain non-empty strings`);
      }
      return item.trim();
    });
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} must be a string or string array when provided`);
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function formatMemoryTrace(result: JsonObject): string {
  const note = asObject(result.note) ?? {};
  const locations = asObject(result.locations) ?? {};
  const noteId = asString(note.id) ?? "unknown";
  const status = asString(note.status) ?? "unknown";
  const noteType = asString(note.type) ?? "unknown";
  const scope = asString(note.scope) ?? "unknown";
  const file = asString(locations.file);
  const line = typeof locations.line === "number" ? locations.line : undefined;
  const viewFile = asString(locations.view_file);
  const viewLine = typeof locations.view_line === "number" ? locations.view_line : undefined;
  const location = file ? `${file}${line !== undefined ? `:${line}` : ""}` : "unknown";
  const viewLocation = viewFile ? `${viewFile}${viewLine !== undefined ? `:${viewLine}` : ""}` : "unknown";
  return [
    `Memory Note ${noteId} (${scope}/${noteType}/${status})`,
    asString(note.content) ?? "",
    `canonical: ${location}`,
    `view: ${viewLocation}`,
  ].filter((lineContent) => lineContent.length > 0).join("\n");
}

function formatMemoryNumber(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

function formatMemorySources(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "none";
  }
  return value.map(formatMemorySource).filter((line): line is string => line !== null).join("; ") || "none";
}

function formatMemorySource(value: unknown): string | null {
  const source = asObject(value);
  if (!source) {
    return null;
  }
  const fields = [asString(source.capture_origin) ?? "explicit"];
  const sessionKey = asString(source.session_key);
  if (sessionKey) {
    fields.push(`session=${sessionKey}`);
  }
  const sourceFile = asString(source.source_file);
  if (sourceFile) {
    fields.push(`file=${sourceFile}`);
  }
  const messageStart = typeof source.message_start === "number" ? source.message_start : null;
  const messageEnd = typeof source.message_end === "number" ? source.message_end : null;
  if (messageStart !== null || messageEnd !== null) {
    fields.push(`messages=${messageStart ?? ""}-${messageEnd ?? ""}`);
  }
  return fields.join(" ");
}

function formatMemoryReference(value: unknown): JsonObject | null {
  const note = asObject(value);
  if (!note) {
    return null;
  }
  return {
    note_id: asString(note.id) ?? "unknown",
    scope: asString(note.scope) ?? "project",
    type: asString(note.type) ?? "project",
    status: asString(note.status) ?? "active",
    content: asString(note.content) ?? "",
    priority: typeof note.priority === "number" ? note.priority : 0.5,
    confidence: typeof note.confidence === "number" ? note.confidence : 0.5,
    tags: Array.isArray(note.tags) ? note.tags.filter((tag): tag is string => typeof tag === "string") : [],
    metadata: asObject(note.metadata) ?? {},
    evidence_ids: memoryEvidenceIds(note.sources),
    file: asString(note.file),
    line: typeof note.line === "number" ? note.line : undefined,
    view_file: asString(note.view_file),
    view_line: typeof note.view_line === "number" ? note.view_line : undefined,
  };
}

function memoryEvidenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = new Set<string>();
  for (const source of value) {
    const object = asObject(source);
    const evidenceIds = Array.isArray(object?.evidence_ids) ? object.evidence_ids : [];
    for (const evidenceId of evidenceIds) {
      if (typeof evidenceId === "string") {
        ids.add(evidenceId);
      }
    }
  }
  return Array.from(ids).sort();
}

function formatRagDocuments(documents: unknown[]): string {
  const formatted = documents.map(formatRagDocument).filter((line): line is string => line !== null);
  if (formatted.length === 0) {
    return "No RAG results found.";
  }
  return `## RAG Results\n${formatted.join("\n")}`;
}

function formatKnowledgeDocuments(documents: unknown[]): string {
  const formatted = documents.map(formatKnowledgeDocument).filter((line): line is string => line !== null);
  if (formatted.length === 0) {
    return "Knowledge base is empty. Use add_document to add documents.";
  }
  return `## Knowledge Base Documents\n${formatted.join("\n")}`;
}

function formatKnowledgeDocument(value: unknown): string | null {
  const document = asObject(value);
  if (!document) {
    return null;
  }
  const name = asString(document.name) ?? "Unknown";
  const id = asString(document.id) ?? "unknown";
  const tags = Array.isArray(document.tags)
    ? document.tags.filter((tag): tag is string => typeof tag === "string").join(", ") || "none"
    : "none";
  const file = asString(document.file_path) ?? "";
  const fileType = asString(document.file_type) ?? "txt";
  const category = asString(document.category) ?? "uncategorized";
  const chunks = typeof document.chunk_count === "number" ? document.chunk_count : 0;
  const content = asString(document.content) ?? "";
  const created = asString(document.created_at) ?? "";
  return [
    `- **${name}** (ID: ${id})`,
    `  - File: ${file}`,
    `  - Type: ${fileType}`,
    `  - Category: ${category || "uncategorized"}`,
    `  - Tags: ${tags}`,
    `  - Chunks: ${chunks}`,
    `  - Length: ${content.length} chars`,
    `  - Created: ${created}`,
  ].join("\n");
}

function formatRagDocument(value: unknown): string | null {
  const document = asObject(value);
  if (!document) {
    return null;
  }
  const id = asString(document.id) ?? asString(document.path) ?? "unknown";
  const title = asString(document.title) ?? asString(document.path) ?? id;
  const path = asString(document.path);
  const score = typeof document.score === "number" ? ` score=${formatMemoryNumber(document.score)}` : "";
  const excerpt = asString(document.excerpt) ?? asString(document.content) ?? "";
  return `- [${id}] ${title}${path ? ` (${path})` : ""}${score}\n  ${excerpt}`;
}

function formatMcpToolResult(result: JsonObject): string {
  const content = result.content;
  if (typeof content === "string") {
    return content || "(no output)";
  }
  if (Array.isArray(content)) {
    const parts = content.map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const object = asObject(item);
      return asString(object?.text) ?? asString(object?.content) ?? JSON.stringify(item);
    });
    return parts.filter((part) => part.length > 0).join("\n") || "(no output)";
  }
  if (result.result !== undefined) {
    return typeof result.result === "string" ? result.result : JSON.stringify(result.result);
  }
  return "(no output)";
}
