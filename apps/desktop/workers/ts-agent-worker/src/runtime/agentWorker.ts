import { AgentRunner, type AgentRunnerCheckpoint, type AgentRunnerEvent } from "../agent/agentRunner.ts";
import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import { buildContextMessages } from "../agent/contextBuilder.ts";
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
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import type { ContextBridge } from "./contextBridge.ts";

export type AgentWorkerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  emitEvent: (event: WorkerEvent) => void;
  approvalBridge?: ApprovalBridge;
  sessionBridge?: SessionBridge;
  contextBridge?: ContextBridge;
};

type ActiveRun = {
  traceId: string;
  cancelled: boolean;
};

export type SessionBridge = {
  setCheckpoint(sessionId: string, checkpoint: Record<string, unknown>, traceId: string): Promise<void>;
  clearCheckpoint(sessionId: string, traceId: string): Promise<void>;
  appendMessages(sessionId: string, messages: AgentMessage[], traceId: string): Promise<void>;
  getCheckpoint(sessionId: string, traceId: string): Promise<Record<string, unknown> | null>;
};

export type ApprovalBridge = {
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
  private readonly approvalBridge?: ApprovalBridge;
  private readonly sessionBridge?: SessionBridge;
  private readonly contextBridge?: ContextBridge;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly checkpointWrites = new Map<string, Promise<void>>();

  constructor(options: AgentWorkerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.emitEvent = options.emitEvent;
    this.approvalBridge = options.approvalBridge;
    this.sessionBridge = options.sessionBridge;
    this.contextBridge = options.contextBridge;
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
      const context = buildContextMessages(loaded.input);
      const contextMetadata = {
        ...context.metadata,
        bridge: loaded.metadata,
      };
      this.emitContextMetadata(request.trace_id, input.runId, contextMetadata);
      const spec: AgentRunSpec = {
        runId: input.runId,
        traceId: request.trace_id,
        sessionId: input.sessionId,
        messages: context.messages,
        model: input.model ?? "gpt-4.1-mini",
        maxIterations: input.maxIterations ?? 2,
        stream: input.stream ?? false,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        reasoningEffort: input.reasoningEffort,
        contextWindow: input.contextWindow,
        toolResultBudget: input.toolResultBudget,
        failOnToolError: input.failOnToolError,
        metadata: {
          ...(input.metadata ?? {}),
          _contextInitialMessageCount: context.messages.length,
          _contextSessionAppendMessages: context.sessionAppendMessages,
        },
      };
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
      await this.appendMessages(request.trace_id, spec, result);
      this.emitAwaitingInput(request.trace_id, spec.runId, result);
      this.emitUsage(request.trace_id, spec, result);
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: request.trace_id,
        event: "agent.done",
        payload: withNativePayloadAliases({
          runId: spec.runId,
          stopReason: result.stopReason,
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
      const checkpoint = await this.sessionBridge.getCheckpoint(sessionId, request.trace_id);
      let restored = false;
      let restoredMessageCount = 0;
      if (checkpoint) {
        const shouldKeepCheckpointForResume = checkpointRequiresUserInputResume(checkpoint);
        const restoredMessages = shouldKeepCheckpointForResume ? [] : materializeCheckpointMessages(checkpoint);
        if (restoredMessages.length > 0) {
          await this.sessionBridge.appendMessages(sessionId, restoredMessages, request.trace_id);
          restoredMessageCount = restoredMessages.length;
        }
        if (!shouldKeepCheckpointForResume) {
          await this.sessionBridge.clearCheckpoint(sessionId, request.trace_id);
        }
        restored = true;
      }
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
    if (!this.sessionBridge || !spec.sessionId) {
      return;
    }
    await this.sessionBridge.setCheckpoint(spec.sessionId, {
      runId: spec.runId,
      phase: checkpoint.phase,
      iteration: checkpoint.iteration,
      model: checkpoint.model,
      maxIterations: spec.maxIterations,
      stream: spec.stream,
      temperature: spec.temperature,
      maxTokens: spec.maxTokens,
      reasoningEffort: spec.reasoningEffort,
      contextWindow: spec.contextWindow,
      toolResultBudget: spec.toolResultBudget,
      failOnToolError: spec.failOnToolError,
      messages: checkpoint.messages,
      assistantMessage: checkpoint.assistantMessage,
      completedToolResults: checkpoint.completedToolResults,
      pendingToolCalls: checkpoint.pendingToolCalls,
    }, traceId);
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
    if (!this.sessionBridge || !spec.sessionId) {
      return;
    }
    await this.sessionBridge.clearCheckpoint(spec.sessionId, traceId);
  }

  private async appendMessages(traceId: string, spec: AgentRunSpec, result: AgentRunResult): Promise<void> {
    if (!this.sessionBridge || !spec.sessionId) {
      return;
    }
    await this.sessionBridge.appendMessages(spec.sessionId, sessionAppendMessages(spec, result), traceId);
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
    const messages = parseCheckpointMessages(checkpoint.messages);
    const approvalToolIndex = findApprovalToolMessageIndex(messages, approval.approvalId);
    if (approvalToolIndex < 0) {
      throw new Error("approval checkpoint does not contain a matching awaiting approval tool result");
    }
    const approvalToolMessage = messages[approvalToolIndex];
    const operation = parseApprovedOperation(approvalToolMessage.metadata);
    const toolResult = await this.tools.execute(operation.toolName, operation.arguments, {
      runId: checkpointRunId(checkpoint),
      traceId,
      sessionId: approval.sessionId,
    });
    const replacement: AgentMessage = {
      role: "tool",
      content: toolResult.content,
      toolCallId: approvalToolMessage.toolCallId,
      name: approvalToolMessage.name,
      ...(toolResult.metadata ? { metadata: toolResult.metadata } : {}),
    };
    const resumedMessages = messages.map((message, index) => (index === approvalToolIndex ? replacement : message));
    return this.runResumedSpec(traceId, resumedSpecFromCheckpoint(checkpoint, approval.sessionId, resumedMessages));
  }

  private async resumeSubmittedFormCheckpoint(
    traceId: string,
    submission: FormSubmissionRequest,
    checkpoint: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    const messages = parseCheckpointMessages(checkpoint.messages);
    const formToolIndex = findFormToolMessageIndex(messages, submission.formId);
    if (formToolIndex < 0) {
      throw new Error("form checkpoint does not contain a matching awaiting form tool result");
    }
    const formToolMessage = messages[formToolIndex];
    const formResultMessage: AgentMessage = {
      role: "tool",
      content: formatFormSubmissionContent(submission),
      toolCallId: formToolMessage.toolCallId,
      name: formToolMessage.name,
      metadata: {
        formId: submission.formId,
        action: submission.action,
        values: submission.values,
      },
    };
    const resumedMessages = messages.map((message, index) => (index === formToolIndex ? formResultMessage : message));
    return this.runResumedSpec(traceId, resumedSpecFromCheckpoint(checkpoint, submission.sessionId, resumedMessages));
  }

  private async resumeDeniedApprovalCheckpoint(
    traceId: string,
    approval: ApprovalResolutionRequest,
    checkpoint: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    const messages = parseCheckpointMessages(checkpoint.messages);
    const approvalToolIndex = findApprovalToolMessageIndex(messages, approval.approvalId);
    if (approvalToolIndex < 0) {
      throw new Error("approval checkpoint does not contain a matching awaiting approval tool result");
    }
    const approvalToolMessage = messages[approvalToolIndex];
    const denialMessage: AgentMessage = {
      role: "tool",
      content: `Approval denied: ${approval.approvalId}`,
      toolCallId: approvalToolMessage.toolCallId,
      name: approvalToolMessage.name,
      metadata: {
        approvalId: approval.approvalId,
        approved: false,
        status: "denied",
      },
    };
    const resumedMessages = messages.map((message, index) => (index === approvalToolIndex ? denialMessage : message));
    return this.runResumedSpec(traceId, resumedSpecFromCheckpoint(checkpoint, approval.sessionId, resumedMessages));
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
    await this.appendMessages(traceId, spec, result);
    this.emitAwaitingInput(traceId, spec.runId, result);
    this.emitUsage(traceId, spec, result);
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: "agent.done",
      payload: withNativePayloadAliases({
        runId: spec.runId,
        stopReason: result.stopReason,
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

function resumedSpecFromCheckpoint(
  checkpoint: Record<string, unknown>,
  sessionId: string,
  messages: AgentMessage[],
): AgentRunSpec {
  return {
    runId: checkpointRunId(checkpoint),
    sessionId,
    messages,
    model: checkpointString(checkpoint.model, "checkpoint.model"),
    maxIterations: numberParam(checkpoint, "maxIterations", "max_iterations") ?? 2,
    stream: booleanParam(checkpoint, "stream", "stream") ?? false,
    temperature: numberParam(checkpoint, "temperature", "temperature"),
    maxTokens: numberParam(checkpoint, "maxTokens", "max_tokens"),
    reasoningEffort: stringParam(checkpoint, "reasoningEffort", "reasoning_effort"),
    contextWindow: numberParam(checkpoint, "contextWindow", "context_window"),
    toolResultBudget: numberParam(checkpoint, "toolResultBudget", "tool_result_budget"),
    failOnToolError: booleanParam(checkpoint, "failOnToolError", "fail_on_tool_error"),
  };
}

function checkpointRunId(checkpoint: Record<string, unknown>): string {
  return checkpointString(checkpoint.runId ?? checkpoint.run_id, "checkpoint.runId");
}

function sessionAppendMessages(spec: AgentRunSpec, result: AgentRunResult): AgentMessage[] {
  const contextMessages = internalContextAppendMessages(spec.metadata?._contextSessionAppendMessages);
  const initialMessageCount = spec.metadata?._contextInitialMessageCount;
  if (!contextMessages || typeof initialMessageCount !== "number") {
    return result.messages;
  }
  return [
    ...contextMessages,
    ...result.messages.slice(initialMessageCount),
  ];
}

function internalContextAppendMessages(value: unknown): AgentMessage[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const messages = value.map((item) => {
    if (!isJsonObject(item) || !isAgentRole(item.role) || typeof item.content !== "string") {
      return null;
    }
    return {
      role: item.role,
      content: item.content,
    };
  });
  return messages.every((message) => message !== null) ? (messages as AgentMessage[]) : null;
}

function isAgentRole(value: unknown): value is AgentMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
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

function numberParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): number | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "number" ? value : undefined;
}

function booleanParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): boolean | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "boolean" ? value : undefined;
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

function materializeCheckpointMessages(checkpoint: Record<string, unknown>): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const assistantMessage = parseCheckpointAgentMessage(checkpoint.assistantMessage ?? checkpoint.assistant_message);
  if (assistantMessage) {
    messages.push(assistantMessage);
  }
  const completedToolResults = checkpoint.completedToolResults ?? checkpoint.completed_tool_results;
  if (Array.isArray(completedToolResults)) {
    for (const message of completedToolResults) {
      const parsed = parseCheckpointAgentMessage(message);
      if (parsed) {
        messages.push(parsed);
      }
    }
  }
  const pendingToolCalls = checkpoint.pendingToolCalls ?? checkpoint.pending_tool_calls;
  if (Array.isArray(pendingToolCalls)) {
    messages.push(...pendingToolCalls.map(pendingToolCallInterruptedMessage).filter((message) => message !== undefined));
  }
  return messages;
}

function parseCheckpointAgentMessage(value: unknown): AgentMessage | undefined {
  try {
    return parseAgentMessage(value);
  } catch {
    return undefined;
  }
}

function pendingToolCallInterruptedMessage(value: unknown): AgentMessage | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const functionPayload = isJsonObject(value.function) ? value.function : {};
  const toolCallId = typeof value.id === "string" ? value.id : undefined;
  const name = typeof value.name === "string"
    ? value.name
    : typeof functionPayload.name === "string"
      ? functionPayload.name
      : "tool";
  return {
    role: "tool",
    content: "Error: Task interrupted before this tool finished.",
    toolCallId,
    name,
  };
}

function parseCheckpointMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("approval checkpoint requires messages");
  }
  return value.map(parseAgentMessage);
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

function findApprovalToolMessageIndex(messages: AgentMessage[], approvalId: string): number {
  return messages.findIndex((message) => (
    message.role === "tool" &&
    message.metadata?.awaitingUserInput === true &&
    message.metadata?.stopReason === "awaiting_approval" &&
    message.metadata?.approvalId === approvalId
  ));
}

function canResumeApprovalCheckpoint(checkpoint: Record<string, unknown>, approvalId: string): boolean {
  if (!Array.isArray(checkpoint.messages)) {
    return false;
  }
  try {
    return findApprovalToolMessageIndex(parseCheckpointMessages(checkpoint.messages), approvalId) >= 0;
  } catch {
    return false;
  }
}

function findFormToolMessageIndex(messages: AgentMessage[], formId: string): number {
  return messages.findIndex((message) => (
    message.role === "tool" &&
    message.metadata?.awaitingUserInput === true &&
    message.metadata?.stopReason === "awaiting_form" &&
    message.metadata?.formId === formId
  ));
}

function formatFormSubmissionContent(submission: FormSubmissionRequest): string {
  if (submission.action === "cancelled") {
    return `Agent UI form cancelled: ${submission.formId}`;
  }
  return `Agent UI form submitted: ${submission.formId}\n${JSON.stringify(submission.values)}`;
}

function parseApprovedOperation(metadata: Record<string, unknown> | undefined): { toolName: string; arguments: Record<string, unknown> } {
  const operation = isJsonObject(metadata?.operation) ? metadata.operation : undefined;
  if (!operation || typeof operation.toolName !== "string" || !isJsonObject(operation.arguments)) {
    throw new Error("approval checkpoint does not contain an executable operation");
  }
  return {
    toolName: operation.toolName,
    arguments: operation.arguments,
  };
}

function checkpointString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`approval checkpoint requires ${field}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAwaitingInputResult(result: AgentRunResult): boolean {
  return result.stopReason === "awaiting_user_input" || result.stopReason === "awaiting_approval" || result.stopReason === "awaiting_form";
}

function checkpointRequiresUserInputResume(checkpoint: Record<string, unknown>): boolean {
  return checkpointContainsAwaitingInput(checkpoint.messages)
    || checkpointContainsAwaitingInput(checkpoint.completedToolResults ?? checkpoint.completed_tool_results)
    || checkpointContainsAwaitingInput(checkpoint.assistantMessage ?? checkpoint.assistant_message);
}

function checkpointContainsAwaitingInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(checkpointContainsAwaitingInput);
  }
  if (!isJsonObject(value)) {
    return false;
  }
  const metadata = isJsonObject(value.metadata) ? value.metadata : {};
  const awaitingUserInput = metadata.awaitingUserInput ?? metadata.awaiting_user_input;
  const stopReason = metadata.stopReason ?? metadata.stop_reason;
  return awaitingUserInput === true
    || stopReason === "awaiting_user_input"
    || stopReason === "awaiting_approval"
    || stopReason === "awaiting_form";
}
