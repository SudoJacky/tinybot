import { AgentRunner, type AgentRunnerCheckpoint, type AgentRunnerEvent } from "../agent/agentRunner.ts";
import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunInput, ContextBuildMetadata, ContextBridgeMetadata } from "../agent/contextTypes.ts";
import type { ModelProvider, ToolDefinition } from "../model/provider.ts";
import {
  isJsonObject,
  workerError,
  WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
  type WorkerRequest,
  type WorkerResponse,
} from "../protocol/messages.ts";
import type { ApprovalRequestPayload } from "../security/approvalTypes.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import {
  approvalOperationFromCheckpoint,
  canResumeApprovalCheckpoint,
  resumedSpecFromApprovedToolResult,
  resumedSpecFromDeniedApproval,
  resumedSpecFromSubmittedForm,
} from "./checkpoint.ts";
import type { ContextBridge } from "./contextBridge.ts";
import { buildRunInputSpec } from "./runInputContext.ts";
import { TurnLifecycle, type SessionBridge } from "./turnLifecycle.ts";

export type { PersistTurnRequest, PersistTurnResult, SessionBridge } from "./turnLifecycle.ts";

export type AgentWorkerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  emitEvent: (event: WorkerEvent) => void;
  reloadProvider?: ProviderReloadHandler;
  listProviderModels?: ProviderModelsListHandler;
  approvalBridge?: ApprovalBridge;
  sessionBridge?: SessionBridge;
  contextBridge?: ContextBridge;
};

export type ProviderReloadHandler = () => Promise<ProviderReloadResult> | ProviderReloadResult;

export type ProviderReloadResult = {
  reloaded: boolean;
};

export type ProviderModelsListRequest = {
  providerId: string;
  model?: string;
  manualModelIds: string[];
  refreshLive: boolean;
};

export type ProviderModelsListHandler = (request: ProviderModelsListRequest) => Promise<unknown> | unknown;

type ActiveRun = {
  traceId: string;
  cancelled: boolean;
};

export type ApprovalBridge = {
  requestApproval(params: ApprovalRequestPayload, traceId: string): Promise<Record<string, unknown>>;
  resolveApproval(params: ApprovalResolutionRequest, traceId: string): Promise<Record<string, unknown>>;
};

export type ApprovalResolutionRequest = {
  sessionId: string;
  approvalId: string;
  approved: boolean;
  scope?: string;
};

type FormSubmissionRequest = {
  sessionId: string;
  formId: string;
  values: Record<string, unknown>;
  action: "submitted" | "cancelled";
};

export class AgentWorker {
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly emitEvent: (event: WorkerEvent) => void;
  private readonly reloadProvider?: ProviderReloadHandler;
  private readonly listProviderModels?: ProviderModelsListHandler;
  private readonly approvalBridge?: ApprovalBridge;
  private readonly sessionBridge?: SessionBridge;
  private readonly contextBridge?: ContextBridge;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly checkpointWrites = new Map<string, Promise<void>>();

  constructor(options: AgentWorkerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.emitEvent = options.emitEvent;
    this.reloadProvider = options.reloadProvider;
    this.listProviderModels = options.listProviderModels;
    this.approvalBridge = options.approvalBridge;
    this.sessionBridge = options.sessionBridge;
    this.contextBridge = options.contextBridge;
    this.turnLifecycle = new TurnLifecycle(options.sessionBridge);
  }

  async handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (request.protocol_version !== WORKER_PROTOCOL_VERSION) {
      return this.failure(
        request,
        `Unsupported worker protocol version '${request.protocol_version}'.`,
        {
          actual: request.protocol_version,
          expected: WORKER_PROTOCOL_VERSION,
        },
        "incompatible_protocol_version",
      );
    }

    if (request.method === "agent.cancel") {
      return this.handleCancelRequest(request);
    }

    if (request.method === "agent.restore_checkpoint") {
      return this.handleRestoreCheckpointRequest(request);
    }

    if (request.method === "agent.resume_approval") {
      return this.handleResumeApprovalRequest(request);
    }

    if (request.method === "agent.submit_form") {
      return this.handleSubmitFormRequest(request);
    }

    if (request.method === "agent.run_input") {
      return this.handleRunInputRequest(request);
    }

    if (request.method === "worker.provider.reload") {
      return this.handleProviderReloadRequest(request);
    }

    if (request.method === "provider.models.list") {
      return this.handleProviderModelsListRequest(request);
    }

    if (request.method !== "agent.run") {
      return this.failure(request, "unknown worker method", { method: request.method }, "invalid_protocol");
    }

    return this.handleRunRequest(request);
  }

  private async handleRunRequest(request: WorkerRequest): Promise<WorkerResponse> {
    let runId: string | undefined;
    try {
      const spec = parseRunSpec(request.params);
      runId = spec.runId;
      spec.traceId = request.trace_id;
      return await this.runSpecForRequest(request, spec);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: request.trace_id,
        event: "agent.error",
        payload: withNativePayloadAliases(runId ? { runId, message } : { message }),
      });
      return this.failure(request, message);
    }
  }

  private async handleRunInputRequest(request: WorkerRequest): Promise<WorkerResponse> {
    let runId: string | undefined;
    try {
      const input = parseRunInput(request.params);
      runId = input.runId;
      if (!this.contextBridge) {
        throw new Error("agent.run_input requires a context bridge");
      }
      const loaded = await this.contextBridge.loadContextInput(input, request.trace_id);
      const { spec, contextMetadata } = buildRunInputSpec(request.trace_id, input, loaded);
      this.emitContextMetadata(request.trace_id, input.runId, contextMetadata);
      return await this.runSpecForRequest(request, spec, contextMetadata);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: request.trace_id,
        event: "agent.error",
        payload: withNativePayloadAliases(runId ? { runId, message } : { message }),
      });
      return this.failure(request, message);
    }
  }

  private async runSpecForRequest(
    request: WorkerRequest,
    spec: AgentRunSpec,
    contextMetadata?: ContextBuildMetadata & { bridge?: ContextBridgeMetadata },
  ): Promise<WorkerResponse> {
      const activeRun: ActiveRun = { traceId: request.trace_id, cancelled: false };
      this.activeRuns.set(spec.runId, activeRun);
      const runner = new AgentRunner({
        provider: this.provider,
        tools: this.tools,
        emitEvent: (event) => this.emitRunnerEvent(request.trace_id, event),
        checkpoint: (checkpoint) => {
          this.emitCheckpoint(request.trace_id, spec.runId, checkpoint);
          this.queueCheckpointWrite(spec.runId, () => this.persistCheckpoint(request.trace_id, spec, checkpoint));
        },
        isCancelled: () => activeRun.cancelled,
      });
      const result = await this.runAndClearActiveState(runner, spec);
      await this.drainCheckpointWrites(spec.runId);
      if (!isAwaitingInputResult(result)) {
        await this.clearCheckpoint(request.trace_id, spec);
      }
      const resultForLifecycle = contextMetadata ? { ...result, contextMetadata } : result;
      const lifecycle = await this.turnLifecycle.finalizeTurn(request.trace_id, spec, resultForLifecycle);
      this.emitAwaitingInput(request.trace_id, spec.runId, result);
      this.emitUsage(request.trace_id, spec, result);
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: request.trace_id,
        event: "agent.done",
        payload: withNativePayloadAliases({
          runId: spec.runId,
          stopReason: result.stopReason,
          ...(lifecycle ? { lifecycle } : {}),
        }),
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: contextMetadata ? { ...result, contextMetadata } : result,
      };
  }

  private handleCancelRequest(request: WorkerRequest): WorkerResponse {
    try {
      const runId = parseCancelRunId(request.params);
      const activeRun = this.activeRuns.get(runId);
      if (!activeRun) {
        return {
          protocol_version: WORKER_PROTOCOL_VERSION,
          id: request.id,
          trace_id: request.trace_id,
          result: { ok: false, runId, reason: "not_found" },
        };
      }
      activeRun.cancelled = true;
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: activeRun.traceId,
        event: "agent.cancelled",
        payload: withNativePayloadAliases({ runId }),
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { ok: true, runId },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleProviderReloadRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.reloadProvider) {
      return this.failure(request, "worker.provider.reload requires a reloadable provider");
    }
    try {
      const result = await this.reloadProvider();
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result,
      };
    } catch (error) {
      return this.failure(request, errorMessage(error));
    }
  }

  private async handleProviderModelsListRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.listProviderModels) {
      return this.failure(request, "provider.models.list requires a provider model list handler");
    }
    try {
      const result = await this.listProviderModels(parseProviderModelsListRequest(request.params));
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result,
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleRestoreCheckpointRequest(request: WorkerRequest): Promise<WorkerResponse> {
    try {
      const sessionId = parseRestoreCheckpointSessionId(request.params);
      if (!this.sessionBridge) {
        return this.failure(
          request,
          "agent.restore_checkpoint requires a session bridge",
          { sessionId },
          "worker_error",
        );
      }
      const { checkpoint, restored, restoredMessageCount } = await this.turnLifecycle.restoreCheckpoint(request.trace_id, sessionId);
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: withNativePayloadAliases({ sessionId, checkpoint, restored, restoredMessageCount }),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleResumeApprovalRequest(request: WorkerRequest): Promise<WorkerResponse> {
    try {
      const params = parseResumeApprovalParams(request.params);
      if (!this.approvalBridge) {
        return this.failure(
          request,
          "agent.resume_approval requires an approval bridge",
          { sessionId: params.sessionId, approvalId: params.approvalId },
          "worker_error",
        );
      }
      if (!this.sessionBridge) {
        return this.failure(
          request,
          "agent.resume_approval requires a session bridge",
          { sessionId: params.sessionId, approvalId: params.approvalId },
          "worker_error",
        );
      }
      const approval = await this.approvalBridge.resolveApproval(params, request.trace_id);
      const checkpoint = await this.sessionBridge.getCheckpoint(params.sessionId, request.trace_id);
      const result = checkpoint && canResumeApprovalCheckpoint(checkpoint, params.approvalId)
        ? params.approved
          ? await this.resumeApprovedCheckpoint(request.trace_id, params, checkpoint)
          : await this.resumeDeniedApprovalCheckpoint(request.trace_id, params, checkpoint)
        : undefined;
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { sessionId: params.sessionId, approval, checkpoint, result },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleSubmitFormRequest(request: WorkerRequest): Promise<WorkerResponse> {
    try {
      const params = parseSubmitFormParams(request.params);
      if (!this.sessionBridge) {
        return this.failure(
          request,
          "agent.submit_form requires a session bridge",
          { sessionId: params.sessionId, formId: params.formId },
          "worker_error",
        );
      }
      const checkpoint = await this.sessionBridge.getCheckpoint(params.sessionId, request.trace_id);
      if (!checkpoint) {
        return this.failure(
          request,
          "agent.submit_form requires a checkpoint",
          { sessionId: params.sessionId, formId: params.formId },
          "worker_error",
        );
      }
      const form = {
        formId: params.formId,
        action: params.action,
        values: params.values,
      };
      const result = await this.resumeSubmittedFormCheckpoint(request.trace_id, params, checkpoint);
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { sessionId: params.sessionId, form, checkpoint, result },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async runAndClearActiveState(runner: AgentRunner, spec: AgentRunSpec): Promise<Awaited<ReturnType<AgentRunner["run"]>>> {
    try {
      return await runner.run(spec);
    } finally {
      this.activeRuns.delete(spec.runId);
    }
  }

  private async persistCheckpoint(traceId: string, spec: AgentRunSpec, checkpoint: AgentRunnerCheckpoint): Promise<void> {
    await this.turnLifecycle.writeCheckpoint(traceId, spec, checkpoint);
  }

  private queueCheckpointWrite(runId: string, write: () => Promise<void>): void {
    const previous = this.checkpointWrites.get(runId) ?? Promise.resolve();
    const next = previous.then(write, write);
    this.checkpointWrites.set(runId, next);
  }

  private async drainCheckpointWrites(runId: string): Promise<void> {
    const pending = this.checkpointWrites.get(runId);
    if (!pending) {
      return;
    }
    try {
      await pending;
    } finally {
      this.checkpointWrites.delete(runId);
    }
  }

  private async clearCheckpoint(traceId: string, spec: AgentRunSpec): Promise<void> {
    await this.turnLifecycle.clearCheckpoint(traceId, spec);
  }

  private emitAwaitingInput(traceId: string, runId: string, result: AgentRunResult): void {
    if (!result.awaitingInput) {
      return;
    }
    const stopReason = result.stopReason;
    const event = stopReason === "awaiting_form"
      ? "agent.awaiting_form"
      : stopReason === "awaiting_approval"
        ? "agent.awaiting_approval"
        : "agent.awaiting_user_input";
    const { awaitingUserInput: _internalAwaitingUserInput, ...awaitingPayload } = result.awaitingInput;
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event,
      payload: withNativePayloadAliases({
        runId,
        ...awaitingPayload,
        stopReason,
      }),
    });
  }

  private emitUsage(traceId: string, spec: AgentRunSpec, result: AgentRunResult): void {
    if (!result.usage) {
      return;
    }
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: "agent.usage",
      payload: withNativePayloadAliases({
        runId: spec.runId,
        usage: withNativeUsageAliases(result.usage),
        ...(spec.contextWindow
          ? { contextWindowTokens: spec.contextWindow, context_window_tokens: spec.contextWindow }
          : {}),
      }),
    });
  }

  private emitContextMetadata(
    traceId: string,
    runId: string,
    metadata: ContextBuildMetadata & { bridge?: ContextBridgeMetadata },
  ): void {
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: "agent.context",
      payload: withNativePayloadAliases({ runId, metadata }),
    });
  }

  private failure(
    request: WorkerRequest,
    message: string,
    details: Record<string, unknown> = {},
    code: "invalid_protocol" | "incompatible_protocol_version" | "capability_denied" | "worker_error" = "worker_error",
  ): WorkerResponse {
    return {
      protocol_version: WORKER_PROTOCOL_VERSION,
      id: request.id,
      trace_id: request.trace_id,
      error: workerError(message, details, code),
    };
  }

  private emitRunnerEvent(traceId: string, event: AgentRunnerEvent): void {
    const protocolEvent = protocolEventName(event);
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: protocolEvent,
      payload: withNativePayloadAliases(event.payload),
    });
  }

  private emitCheckpoint(traceId: string, runId: string, checkpoint: AgentRunnerCheckpoint): void {
    const assistantMessage = nativeCheckpointMessage(checkpoint.assistantMessage);
    const completedToolResults = checkpoint.completedToolResults.map(nativeCheckpointMessage);
    const pendingToolCalls = checkpoint.pendingToolCalls.map(nativeCheckpointToolCall);
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: "agent.checkpoint",
      payload: {
        runId,
        run_id: runId,
        phase: checkpoint.phase,
        iteration: checkpoint.iteration,
        model: checkpoint.model,
        assistantMessage: checkpoint.assistantMessage,
        assistant_message: assistantMessage,
        completedToolResults: checkpoint.completedToolResults,
        completed_tool_results: completedToolResults,
        pendingToolCalls: checkpoint.pendingToolCalls,
        pending_tool_calls: pendingToolCalls,
      },
    });
  }

  private async resumeApprovedCheckpoint(
    traceId: string,
    approval: ApprovalResolutionRequest,
    checkpoint: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    const operation = approvalOperationFromCheckpoint(checkpoint, approval.approvalId);
    const toolResult = await this.tools.execute(operation.toolName, operation.arguments, {
      runId: operation.runId,
      traceId,
      sessionId: approval.sessionId,
    });
    return this.runResumedSpec(traceId, resumedSpecFromApprovedToolResult(checkpoint, {
      sessionId: approval.sessionId,
      approvalId: approval.approvalId,
      content: toolResult.content,
      ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
    }));
  }

  private async resumeSubmittedFormCheckpoint(
    traceId: string,
    submission: FormSubmissionRequest,
    checkpoint: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    return this.runResumedSpec(traceId, resumedSpecFromSubmittedForm(checkpoint, submission));
  }

  private async resumeDeniedApprovalCheckpoint(
    traceId: string,
    approval: ApprovalResolutionRequest,
    checkpoint: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    return this.runResumedSpec(traceId, resumedSpecFromDeniedApproval(checkpoint, approval));
  }

  private async runResumedSpec(traceId: string, spec: AgentRunSpec): Promise<AgentRunResult> {
    const activeRun: ActiveRun = { traceId, cancelled: false };
    this.activeRuns.set(spec.runId, activeRun);
    const runner = new AgentRunner({
      provider: this.provider,
      tools: this.tools,
      emitEvent: (event) => this.emitRunnerEvent(traceId, event),
      checkpoint: (nextCheckpoint) => {
        this.emitCheckpoint(traceId, spec.runId, nextCheckpoint);
        this.queueCheckpointWrite(spec.runId, () => this.persistCheckpoint(traceId, spec, nextCheckpoint));
      },
      isCancelled: () => activeRun.cancelled,
    });
    const result = await this.runAndClearActiveState(runner, spec);
    await this.drainCheckpointWrites(spec.runId);
    if (!isAwaitingInputResult(result)) {
      await this.clearCheckpoint(traceId, spec);
    }
    const lifecycle = await this.turnLifecycle.finalizeTurn(traceId, spec, result);
    this.emitAwaitingInput(traceId, spec.runId, result);
    this.emitUsage(traceId, spec, result);
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: "agent.done",
      payload: withNativePayloadAliases({
        runId: spec.runId,
        stopReason: result.stopReason,
        ...(lifecycle ? { lifecycle } : {}),
      }),
    });
    return result;
  }
}

function parseCancelRunId(params: Record<string, unknown> | undefined): string {
  const runId = stringParam(params, "runId", "run_id");
  if (!runId) {
    throw new Error("agent.cancel requires string params.runId");
  }
  return runId;
}

function parseRestoreCheckpointSessionId(params: Record<string, unknown> | undefined): string {
  const sessionId = stringParam(params, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error("agent.restore_checkpoint requires string params.sessionId");
  }
  return sessionId;
}

function parseResumeApprovalParams(params: Record<string, unknown> | undefined): ApprovalResolutionRequest {
  const sessionId = stringParam(params, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error("agent.resume_approval requires string params.sessionId");
  }
  const approvalId = stringParam(params, "approvalId", "approval_id");
  if (!approvalId) {
    throw new Error("agent.resume_approval requires string params.approvalId");
  }
  const object = params ?? {};
  if (typeof object.approved !== "boolean") {
    throw new Error("agent.resume_approval requires boolean params.approved");
  }
  return {
    sessionId,
    approvalId,
    approved: object.approved,
    scope: typeof object.scope === "string" ? object.scope : undefined,
  };
}

function parseSubmitFormParams(params: Record<string, unknown> | undefined): FormSubmissionRequest {
  const sessionId = stringParam(params, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error("agent.submit_form requires string params.sessionId");
  }
  const formId = stringParam(params, "formId", "form_id");
  if (!formId) {
    throw new Error("agent.submit_form requires string params.formId");
  }
  const object = params ?? {};
  if (object.values !== undefined && !isJsonObject(object.values)) {
    throw new Error("agent.submit_form params.values must be an object when provided");
  }
  const action = parseFormSubmissionAction(object.action);
  return {
    sessionId,
    formId,
    values: isJsonObject(object.values) ? object.values : {},
    action,
  };
}

function parseFormSubmissionAction(value: unknown): FormSubmissionRequest["action"] {
  if (value === "cancel" || value === "cancelled" || value === "canceled") {
    return "cancelled";
  }
  return "submitted";
}

function stringParam(params: Record<string, unknown> | undefined, camelKey: string, snakeKey: string): string | undefined {
  if (!isJsonObject(params)) {
    return undefined;
  }
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "string" ? value : undefined;
}

function protocolEventName(event: AgentRunnerEvent): string {
  switch (event.type) {
    case "tool_start":
      return "agent.tool.start";
    case "tool_result":
      return "agent.tool.result";
    case "content_delta":
      return "agent.delta";
    case "reasoning_delta":
      return "agent.reasoning_delta";
    case "tool_call_delta":
      return "agent.tool_call.delta";
    case "memory_reference":
      return "agent.memory_reference";
    case "task_progress":
      return "agent.task_progress";
    case "usage":
      return "agent.usage";
  }
}

function withNativePayloadAliases(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    ...payload,
    ...(payload.runId !== undefined ? { run_id: payload.runId } : {}),
    ...(payload.toolCallId !== undefined ? { tool_call_id: payload.toolCallId } : {}),
    ...(payload.toolName !== undefined ? { tool_name: payload.toolName } : {}),
    ...(payload.sessionId !== undefined ? { session_id: payload.sessionId } : {}),
    ...(payload.stopReason !== undefined ? { stop_reason: payload.stopReason } : {}),
    ...(payload.approvalId !== undefined ? { approval_id: payload.approvalId } : {}),
    ...(payload.formId !== undefined ? { form_id: payload.formId } : {}),
    ...(payload.planId !== undefined ? { plan_id: payload.planId } : {}),
    ...(payload.contextWindowTokens !== undefined ? { context_window_tokens: payload.contextWindowTokens } : {}),
    ...(payload.messageCount !== undefined ? { message_count: payload.messageCount } : {}),
    ...(payload.restoredMessageCount !== undefined ? { restored_message_count: payload.restoredMessageCount } : {}),
  };
}

function withNativeUsageAliases(usage: AgentRunResult["usage"]): Record<string, unknown> | undefined {
  if (!usage) {
    return undefined;
  }
  const payload: Record<string, unknown> = {};
  if (usage.inputTokens !== undefined) {
    payload.inputTokens = usage.inputTokens;
    payload.prompt_tokens = usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    payload.outputTokens = usage.outputTokens;
    payload.completion_tokens = usage.outputTokens;
  }
  if (usage.totalTokens !== undefined) {
    payload.totalTokens = usage.totalTokens;
    payload.total_tokens = usage.totalTokens;
  }
  if (usage.cachedTokens !== undefined) {
    payload.cachedTokens = usage.cachedTokens;
    payload.cached_tokens = usage.cachedTokens;
  }
  return {
    ...payload,
  };
}

function nativeCheckpointMessage(message: AgentMessage): Record<string, unknown> {
  return {
    role: message.role,
    content: message.content,
    ...(message.toolCalls?.length
      ? {
          tool_calls: message.toolCalls.map(nativeCheckpointToolCall),
        }
      : {}),
    ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(message.role === "assistant" && message.reasoningContent !== undefined
      ? { reasoning_content: message.reasoningContent }
      : {}),
    ...(message.role === "assistant" && message.thinkingBlocks
      ? { thinking_blocks: message.thinkingBlocks }
      : {}),
    ...(message.metadata ? { metadata: message.metadata } : {}),
  };
}

function nativeCheckpointToolCall(toolCall: { id: string; name: string; argumentsJson: string }): Record<string, unknown> {
  return {
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsJson,
    },
  };
}

function parseRunSpec(params: Record<string, unknown> | undefined): AgentRunSpec {
  if (!isJsonObject(params) || !isJsonObject(params.spec)) {
    throw new Error("agent.run requires object params.spec");
  }
  const raw = params.spec;
  const runId = stringParam(raw, "runId", "run_id");
  if (!runId) {
    throw new Error("agent.run spec.runId must be a string");
  }
  if (!Array.isArray(raw.messages)) {
    throw new Error("agent.run spec.messages must be an array");
  }
  if (typeof raw.model !== "string") {
    throw new Error("agent.run spec.model must be a string");
  }
  const maxIterations = numberParam(raw, "maxIterations", "max_iterations");
  if (maxIterations === undefined) {
    throw new Error("agent.run spec.maxIterations must be a number");
  }
  if (typeof raw.stream !== "boolean") {
    throw new Error("agent.run spec.stream must be a boolean");
  }
  return {
    runId,
    traceId: stringParam(raw, "traceId", "trace_id"),
    sessionId: stringParam(raw, "sessionId", "session_id"),
    messages: raw.messages.map(parseAgentMessage),
    tools: Array.isArray(raw.tools) ? raw.tools.map(parseToolDefinition) : undefined,
    model: raw.model,
    maxIterations,
    stream: raw.stream,
    temperature: numberParam(raw, "temperature", "temperature"),
    maxTokens: numberParam(raw, "maxTokens", "max_tokens"),
    reasoningEffort: stringParam(raw, "reasoningEffort", "reasoning_effort"),
    contextWindow: numberParam(raw, "contextWindow", "context_window"),
    toolResultBudget: numberParam(raw, "toolResultBudget", "tool_result_budget"),
    failOnToolError: booleanParam(raw, "failOnToolError", "fail_on_tool_error"),
    metadata: isJsonObject(raw.metadata) ? raw.metadata : undefined,
  };
}

function parseRunInput(params: Record<string, unknown> | undefined): AgentRunInput {
  if (!isJsonObject(params) || !isJsonObject(params.input)) {
    throw new Error("agent.run_input requires object params.input");
  }
  const raw = params.input;
  const runId = stringParam(raw, "runId", "run_id");
  if (!runId) {
    throw new Error("agent.run_input input.runId must be a string");
  }
  const sessionId = stringParam(raw, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error("agent.run_input input.sessionId must be a string");
  }
  if (!isJsonObject(raw.input) || typeof raw.input.content !== "string") {
    throw new Error("agent.run_input input.input.content must be a string");
  }
  const role = raw.input.role === "system" ? "system" : "user";
  return {
    runId,
    sessionId,
    input: {
      role,
      content: raw.input.content,
      media: Array.isArray(raw.input.media)
        ? raw.input.media.filter((item): item is string => typeof item === "string")
        : undefined,
    },
    channel: stringParam(raw, "channel", "channel"),
    chatId: stringParam(raw, "chatId", "chat_id"),
    model: stringParam(raw, "model", "model"),
    maxIterations: numberParam(raw, "maxIterations", "max_iterations"),
    stream: booleanParam(raw, "stream", "stream"),
    temperature: numberParam(raw, "temperature", "temperature"),
    maxTokens: numberParam(raw, "maxTokens", "max_tokens"),
    reasoningEffort: stringParam(raw, "reasoningEffort", "reasoning_effort"),
    contextWindow: numberParam(raw, "contextWindow", "context_window"),
    toolResultBudget: numberParam(raw, "toolResultBudget", "tool_result_budget"),
    failOnToolError: booleanParam(raw, "failOnToolError", "fail_on_tool_error"),
    metadata: isJsonObject(raw.metadata) ? raw.metadata : undefined,
  };
}

function parseProviderModelsListRequest(params: Record<string, unknown> | undefined): ProviderModelsListRequest {
  if (!isJsonObject(params)) {
    throw new Error("provider.models.list requires object params");
  }
  const providerId = stringParam(params, "providerId", "provider_id");
  if (!providerId) {
    throw new Error("provider.models.list params.providerId must be a string");
  }
  return {
    providerId,
    model: stringParam(params, "model", "model"),
    manualModelIds: stringListParam(params, "manualModelIds", "manual_model_ids"),
    refreshLive: booleanParam(params, "refreshLive", "refresh_live") ?? false,
  };
}

function numberParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): number | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "number" ? value : undefined;
}

function booleanParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): boolean | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "boolean" ? value : undefined;
}

function stringListParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): string[] {
  const value = params[camelKey] ?? params[snakeKey];
  if (typeof value === "string") {
    return value.replace(/\n/g, ",").split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return [];
}

function parseToolDefinition(value: unknown): ToolDefinition {
  if (!isJsonObject(value)) {
    throw new Error("agent.run spec.tools entries must be objects");
  }
  if (typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("agent.run spec.tools entries require string name");
  }
  if (typeof value.description !== "string") {
    throw new Error("agent.run spec.tools entries require string description");
  }
  if (!isJsonObject(value.parameters)) {
    throw new Error("agent.run spec.tools entries require object parameters");
  }
  return {
    name: value.name,
    description: value.description,
    parameters: value.parameters,
  };
}

function parseAgentMessage(value: unknown): AgentMessage {
  if (!isJsonObject(value)) {
    throw new Error("agent.run spec.messages entries must be objects");
  }
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant" && value.role !== "tool") {
    throw new Error("agent.run message.role is invalid");
  }
  if (typeof value.content !== "string") {
    throw new Error("agent.run message.content must be a string");
  }
  return {
    role: value.role,
    content: value.content,
    reasoningContent: typeof value.reasoningContent === "string"
      ? value.reasoningContent
      : typeof value.reasoning_content === "string"
        ? value.reasoning_content
        : undefined,
    thinkingBlocks: Array.isArray(value.thinkingBlocks)
      ? value.thinkingBlocks.filter(isJsonObject)
      : Array.isArray(value.thinking_blocks)
        ? value.thinking_blocks.filter(isJsonObject)
        : undefined,
    toolCallId: typeof value.toolCallId === "string"
      ? value.toolCallId
      : typeof value.tool_call_id === "string"
        ? value.tool_call_id
        : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls.map(parseToolCallRequest)
      : Array.isArray(value.tool_calls)
        ? value.tool_calls.map(parseToolCallRequest)
        : undefined,
    metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
  };
}

function parseToolCallRequest(value: unknown): { id: string; name: string; argumentsJson: string } {
  if (!isJsonObject(value) || typeof value.id !== "string") {
    throw new Error("checkpoint tool call is invalid");
  }
  const functionPayload = isJsonObject(value.function) ? value.function : {};
  const name = typeof value.name === "string"
    ? value.name
    : typeof functionPayload.name === "string"
      ? functionPayload.name
      : undefined;
  const argumentsJson = typeof value.argumentsJson === "string"
    ? value.argumentsJson
    : typeof value.arguments_json === "string"
      ? value.arguments_json
      : typeof functionPayload.arguments === "string"
        ? functionPayload.arguments
        : undefined;
  if (!name || argumentsJson === undefined) {
    throw new Error("checkpoint tool call is invalid");
  }
  return {
    id: value.id,
    name,
    argumentsJson,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAwaitingInputResult(result: AgentRunResult): boolean {
  return result.stopReason === "awaiting_user_input" || result.stopReason === "awaiting_approval" || result.stopReason === "awaiting_form";
}
