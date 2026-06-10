import { AgentRunner, type AgentRunnerCheckpoint, type AgentRunnerEvent } from "../agent/agentRunner.ts";
import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
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

export type AgentWorkerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  emitEvent: (event: WorkerEvent) => void;
  approvalBridge?: ApprovalBridge;
  sessionBridge?: SessionBridge;
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
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly checkpointWrites = new Map<string, Promise<void>>();

  constructor(options: AgentWorkerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.emitEvent = options.emitEvent;
    this.approvalBridge = options.approvalBridge;
    this.sessionBridge = options.sessionBridge;
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

    if (request.method !== "agent.run") {
      return this.failure(request, "unknown worker method", { method: request.method }, "invalid_protocol");
    }

    try {
      const spec = parseRunSpec(request.params);
      spec.traceId = request.trace_id;
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
        payload: {
          runId: spec.runId,
          stopReason: result.stopReason,
        },
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: request.trace_id,
        event: "agent.error",
        payload: { message },
      });
      return this.failure(request, message);
    }
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
        payload: { runId },
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
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { sessionId, checkpoint },
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
      const result = params.approved && checkpoint && canResumeApprovedCheckpoint(checkpoint, params.approvalId)
        ? await this.resumeApprovedCheckpoint(request.trace_id, params, checkpoint)
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
    await this.sessionBridge.appendMessages(spec.sessionId, result.messages, traceId);
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
      payload: {
        runId,
        ...awaitingPayload,
        stopReason,
      },
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
      payload: {
        runId: spec.runId,
        usage: result.usage,
        ...(spec.contextWindow ? { contextWindowTokens: spec.contextWindow } : {}),
      },
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
      payload: event.payload,
    });
  }

  private emitCheckpoint(traceId: string, runId: string, checkpoint: AgentRunnerCheckpoint): void {
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: "agent.checkpoint",
      payload: {
        runId,
        phase: checkpoint.phase,
        iteration: checkpoint.iteration,
        model: checkpoint.model,
        assistantMessage: checkpoint.assistantMessage,
        completedToolResults: checkpoint.completedToolResults,
        pendingToolCalls: checkpoint.pendingToolCalls,
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
      runId: checkpointString(checkpoint.runId, "checkpoint.runId"),
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
    const spec: AgentRunSpec = {
      runId: checkpointString(checkpoint.runId, "checkpoint.runId"),
      sessionId: approval.sessionId,
      messages: resumedMessages,
      model: checkpointString(checkpoint.model, "checkpoint.model"),
      maxIterations: typeof checkpoint.maxIterations === "number" ? checkpoint.maxIterations : 2,
      stream: typeof checkpoint.stream === "boolean" ? checkpoint.stream : false,
      contextWindow: typeof checkpoint.contextWindow === "number" ? checkpoint.contextWindow : undefined,
      toolResultBudget: typeof checkpoint.toolResultBudget === "number" ? checkpoint.toolResultBudget : undefined,
      failOnToolError: typeof checkpoint.failOnToolError === "boolean" ? checkpoint.failOnToolError : undefined,
    };
    return this.runResumedSpec(traceId, spec);
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
    const spec: AgentRunSpec = {
      runId: checkpointString(checkpoint.runId, "checkpoint.runId"),
      sessionId: submission.sessionId,
      messages: resumedMessages,
      model: checkpointString(checkpoint.model, "checkpoint.model"),
      maxIterations: typeof checkpoint.maxIterations === "number" ? checkpoint.maxIterations : 2,
      stream: typeof checkpoint.stream === "boolean" ? checkpoint.stream : false,
      contextWindow: typeof checkpoint.contextWindow === "number" ? checkpoint.contextWindow : undefined,
      toolResultBudget: typeof checkpoint.toolResultBudget === "number" ? checkpoint.toolResultBudget : undefined,
      failOnToolError: typeof checkpoint.failOnToolError === "boolean" ? checkpoint.failOnToolError : undefined,
    };
    return this.runResumedSpec(traceId, spec);
  }

  private async runResumedSpec(traceId: string, spec: AgentRunSpec): Promise<AgentRunResult> {
    const runner = new AgentRunner({
      provider: this.provider,
      tools: this.tools,
      emitEvent: (event) => this.emitRunnerEvent(traceId, event),
      checkpoint: (nextCheckpoint) => {
        this.emitCheckpoint(traceId, spec.runId, nextCheckpoint);
        this.queueCheckpointWrite(spec.runId, () => this.persistCheckpoint(traceId, spec, nextCheckpoint));
      },
    });
    const result = await runner.run(spec);
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
      payload: {
        runId: spec.runId,
        stopReason: result.stopReason,
      },
    });
    return result;
  }
}

function parseCancelRunId(params: Record<string, unknown> | undefined): string {
  if (!isJsonObject(params) || typeof params.runId !== "string") {
    throw new Error("agent.cancel requires string params.runId");
  }
  return params.runId;
}

function parseRestoreCheckpointSessionId(params: Record<string, unknown> | undefined): string {
  if (!isJsonObject(params) || typeof params.sessionId !== "string") {
    throw new Error("agent.restore_checkpoint requires string params.sessionId");
  }
  return params.sessionId;
}

function parseResumeApprovalParams(params: Record<string, unknown> | undefined): ApprovalResolutionRequest {
  if (!isJsonObject(params) || typeof params.sessionId !== "string") {
    throw new Error("agent.resume_approval requires string params.sessionId");
  }
  if (typeof params.approvalId !== "string") {
    throw new Error("agent.resume_approval requires string params.approvalId");
  }
  if (typeof params.approved !== "boolean") {
    throw new Error("agent.resume_approval requires boolean params.approved");
  }
  return {
    sessionId: params.sessionId,
    approvalId: params.approvalId,
    approved: params.approved,
    scope: typeof params.scope === "string" ? params.scope : undefined,
  };
}

function parseSubmitFormParams(params: Record<string, unknown> | undefined): FormSubmissionRequest {
  if (!isJsonObject(params) || typeof params.sessionId !== "string") {
    throw new Error("agent.submit_form requires string params.sessionId");
  }
  if (typeof params.formId !== "string") {
    throw new Error("agent.submit_form requires string params.formId");
  }
  if (params.values !== undefined && !isJsonObject(params.values)) {
    throw new Error("agent.submit_form params.values must be an object when provided");
  }
  const action = params.action === "cancelled" ? "cancelled" : "submitted";
  return {
    sessionId: params.sessionId,
    formId: params.formId,
    values: isJsonObject(params.values) ? params.values : {},
    action,
  };
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
  }
}

function parseRunSpec(params: Record<string, unknown> | undefined): AgentRunSpec {
  if (!isJsonObject(params) || !isJsonObject(params.spec)) {
    throw new Error("agent.run requires object params.spec");
  }
  const raw = params.spec;
  if (typeof raw.runId !== "string") {
    throw new Error("agent.run spec.runId must be a string");
  }
  if (!Array.isArray(raw.messages)) {
    throw new Error("agent.run spec.messages must be an array");
  }
  if (typeof raw.model !== "string") {
    throw new Error("agent.run spec.model must be a string");
  }
  if (typeof raw.maxIterations !== "number") {
    throw new Error("agent.run spec.maxIterations must be a number");
  }
  if (typeof raw.stream !== "boolean") {
    throw new Error("agent.run spec.stream must be a boolean");
  }
  return {
    runId: raw.runId,
    traceId: typeof raw.traceId === "string" ? raw.traceId : undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    messages: raw.messages.map(parseAgentMessage),
    tools: Array.isArray(raw.tools) ? raw.tools.map(parseToolDefinition) : undefined,
    model: raw.model,
    maxIterations: raw.maxIterations,
    stream: raw.stream,
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
    toolResultBudget: typeof raw.toolResultBudget === "number" ? raw.toolResultBudget : undefined,
    failOnToolError: typeof raw.failOnToolError === "boolean" ? raw.failOnToolError : undefined,
    metadata: isJsonObject(raw.metadata) ? raw.metadata : undefined,
  };
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
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls.map(parseToolCallRequest) : undefined,
    metadata: isJsonObject(value.metadata) ? value.metadata : undefined,
  };
}

function parseCheckpointMessages(value: unknown): AgentMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("approval checkpoint requires messages");
  }
  return value.map(parseAgentMessage);
}

function parseToolCallRequest(value: unknown): { id: string; name: string; argumentsJson: string } {
  if (!isJsonObject(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.argumentsJson !== "string") {
    throw new Error("checkpoint tool call is invalid");
  }
  return {
    id: value.id,
    name: value.name,
    argumentsJson: value.argumentsJson,
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

function canResumeApprovedCheckpoint(checkpoint: Record<string, unknown>, approvalId: string): boolean {
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
