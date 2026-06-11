import { AgentRunner, type AgentRunnerCheckpoint, type AgentRunnerEvent } from "../agent/agentRunner.ts";
import type { AgentMessage, AgentRunResult, AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { AgentRunInput, ContextBuildMetadata, ContextBridgeMetadata } from "../agent/contextTypes.ts";
import { createDefaultCommandRouter } from "../command/commandRegistry.ts";
import type { CommandRouter } from "../command/commandRouter.ts";
import type {
  DreamCommandRequest,
  DreamCommandResult,
  DreamLogCommandRequest,
  DreamRestoreCommandRequest,
  ResolvePendingApprovalRequest,
  ResolvePendingApprovalResult,
  RestartCommandRequest,
} from "../command/commandTypes.ts";
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
import { TurnLifecycle, type ClearSessionResult, type MemoryEvidenceBridge, type SessionBridge } from "./turnLifecycle.ts";

export type { PersistTurnRequest, PersistTurnResult, SessionBridge } from "./turnLifecycle.ts";
export type { ClearSessionResult } from "./turnLifecycle.ts";

export type AgentWorkerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  emitEvent: (event: WorkerEvent) => void;
  prepareTools?: PrepareToolsHandler;
  reloadProvider?: ProviderReloadHandler;
  listProviderModels?: ProviderModelsListHandler;
  listProviderCatalog?: ProviderCatalogListHandler;
  resolveProviderRuntime?: ProviderRuntimeResolveHandler;
  validateProviderModel?: ProviderModelValidateHandler;
  skillsBridge?: SkillsBridge;
  approvalBridge?: ApprovalBridge;
  dreamBridge?: DreamCommandBridge;
  sessionBridge?: SessionBridge;
  memoryBridge?: MemoryEvidenceBridge;
  contextBridge?: ContextBridge;
  commandRouter?: CommandRouter;
  requestRestart?: RestartRequestHandler;
};

export type PrepareToolsHandler = (traceId: string) => Promise<unknown> | unknown;
export type ProviderReloadHandler = () => Promise<ProviderReloadResult> | ProviderReloadResult;
export type RestartRequestHandler = (request: RestartCommandRequest) => Promise<void> | void;

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

export type ProviderRuntimeResolveRequest = {
  providerId?: string;
  model?: string;
};

export type ProviderModelValidateRequest = {
  providerId: string;
  model: string;
};

export type ProviderCatalogListHandler = () => Promise<unknown> | unknown;
export type ProviderRuntimeResolveHandler = (request: ProviderRuntimeResolveRequest) => Promise<unknown> | unknown;
export type ProviderModelValidateHandler = (request: ProviderModelValidateRequest) => Promise<unknown> | unknown;

export type SkillsBridge = {
  listWebuiSkills(traceId: string): Promise<unknown> | unknown;
  getWebuiSkillDetail(name: string, traceId: string): Promise<unknown> | unknown;
  createWebuiSkill(body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  updateWebuiSkill(name: string, body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  deleteWebuiSkill(name: string, traceId: string): Promise<unknown> | unknown;
  validateWebuiSkill(name: string, traceId: string): Promise<unknown> | unknown;
};

export type DreamCommandBridge = {
  runDream(request: DreamCommandRequest): Promise<DreamCommandResult> | DreamCommandResult;
  getDreamLog(request: DreamLogCommandRequest): Promise<DreamCommandResult> | DreamCommandResult;
  restoreDream(request: DreamRestoreCommandRequest): Promise<DreamCommandResult> | DreamCommandResult;
};

type ActiveRun = {
  traceId: string;
  sessionId?: string;
  cancelled: boolean;
};

type CronRunDueJob = {
  id: string;
  name: string;
  enabled: boolean;
  payload: {
    kind: "agent_turn" | "system_event";
    message: string;
    deliver?: boolean;
    channel?: string | null;
    to?: string | null;
  };
};

type CronRunDueParams = {
  jobs: CronRunDueJob[];
  model: string;
  maxIterations: number;
  stream: boolean;
};

export type ApprovalBridge = {
  requestApproval(params: ApprovalRequestPayload, traceId: string): Promise<Record<string, unknown>>;
  resolveApproval(params: ApprovalResolutionRequest, traceId: string): Promise<Record<string, unknown>>;
  listPendingApprovals?(sessionId: string, traceId: string): Promise<Record<string, unknown>>;
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
  private readonly prepareTools?: PrepareToolsHandler;
  private readonly reloadProvider?: ProviderReloadHandler;
  private readonly listProviderModels?: ProviderModelsListHandler;
  private readonly listProviderCatalog?: ProviderCatalogListHandler;
  private readonly resolveProviderRuntime?: ProviderRuntimeResolveHandler;
  private readonly validateProviderModel?: ProviderModelValidateHandler;
  private readonly skillsBridge?: SkillsBridge;
  private readonly approvalBridge?: ApprovalBridge;
  private readonly dreamBridge?: DreamCommandBridge;
  private readonly sessionBridge?: SessionBridge;
  private readonly memoryBridge?: MemoryEvidenceBridge;
  private readonly contextBridge?: ContextBridge;
  private readonly commandRouter: CommandRouter;
  private readonly turnLifecycle: TurnLifecycle;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly checkpointWrites = new Map<string, Promise<void>>();

  constructor(options: AgentWorkerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.emitEvent = options.emitEvent;
    this.prepareTools = options.prepareTools;
    this.reloadProvider = options.reloadProvider;
    this.listProviderModels = options.listProviderModels;
    this.listProviderCatalog = options.listProviderCatalog;
    this.resolveProviderRuntime = options.resolveProviderRuntime;
    this.validateProviderModel = options.validateProviderModel;
    this.skillsBridge = options.skillsBridge;
    this.approvalBridge = options.approvalBridge;
    this.dreamBridge = options.dreamBridge;
    this.sessionBridge = options.sessionBridge;
    this.memoryBridge = options.memoryBridge;
    this.contextBridge = options.contextBridge;
    this.commandRouter = options.commandRouter ?? createDefaultCommandRouter({
      cancelActiveRunsForSession: (sessionId) => this.cancelActiveRunsForSession(sessionId),
      getStatusSnapshot: (context) => this.statusSnapshot(context.sessionId),
      requestRestart: options.requestRestart,
      ...(options.sessionBridge?.clearSession
        ? { clearSession: (sessionId, traceId) => this.clearSessionForCommand(sessionId, traceId) }
        : {}),
      ...(options.approvalBridge?.listPendingApprovals
        ? { listPendingApprovals: (sessionId, traceId) => this.listPendingApprovalsForCommand(sessionId, traceId) }
        : {}),
      ...(options.approvalBridge
        ? { resolvePendingApproval: (request) => this.resolvePendingApprovalForCommand(request) }
        : {}),
      ...(options.dreamBridge
        ? {
          runDream: (request) => this.runDreamForCommand(request),
          getDreamLog: (request) => this.getDreamLogForCommand(request),
          restoreDream: (request) => this.restoreDreamForCommand(request),
        }
        : {}),
    });
    this.turnLifecycle = new TurnLifecycle(options.sessionBridge, options.memoryBridge);
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

    if (request.method === "cron.run_due") {
      return this.handleCronRunDueRequest(request);
    }

    if (request.method === "worker.provider.reload") {
      return this.handleProviderReloadRequest(request);
    }

    if (request.method === "provider.models.list") {
      return this.handleProviderModelsListRequest(request);
    }

    if (request.method === "provider.catalog.list") {
      return this.handleProviderCatalogListRequest(request);
    }

    if (request.method === "provider.runtime.resolve") {
      return this.handleProviderRuntimeResolveRequest(request);
    }

    if (request.method === "provider.model.validate") {
      return this.handleProviderModelValidateRequest(request);
    }

    if (request.method === "skills.webui_list") {
      return this.handleSkillsWebuiListRequest(request);
    }

    if (request.method === "skills.webui_detail") {
      return this.handleSkillsWebuiDetailRequest(request);
    }

    if (request.method === "skills.webui_create") {
      return this.handleSkillsWebuiCreateRequest(request);
    }

    if (request.method === "skills.webui_update") {
      return this.handleSkillsWebuiUpdateRequest(request);
    }

    if (request.method === "skills.webui_delete") {
      return this.handleSkillsWebuiDeleteRequest(request);
    }

    if (request.method === "skills.webui_validate") {
      return this.handleSkillsWebuiValidateRequest(request);
    }

    if (request.method !== "agent.run") {
      return this.failure(request, "unknown worker method", { method: request.method }, "invalid_protocol");
    }

    return this.handleRunRequest(request);
  }

  private async handleCronRunDueRequest(request: WorkerRequest): Promise<WorkerResponse> {
    try {
      const params = parseCronRunDueParams(request.params);
      const records: Array<Record<string, unknown>> = [];
      for (const job of params.jobs) {
        records.push(await this.runCronJobForRequest(request, job, params));
      }
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { records },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async runCronJobForRequest(
    request: WorkerRequest,
    job: CronRunDueJob,
    params: CronRunDueParams,
  ): Promise<Record<string, unknown>> {
    const runAtMs = Date.now();
    if (!job.enabled) {
      return cronRunRecord(job, "skipped", runAtMs, Date.now() - runAtMs, {
        error: "job is disabled",
      });
    }
    if (job.payload.kind !== "agent_turn") {
      return cronRunRecord(job, "skipped", runAtMs, Date.now() - runAtMs, {
        error: "system_event cron payloads are not handled by the TS worker yet",
      });
    }

    const runId = `cron-${sanitizeCronRunId(job.id)}-${sanitizeCronRunId(request.id)}`;
    const spec: AgentRunSpec = {
      runId,
      traceId: request.trace_id,
      sessionId: `cron:${job.id}`,
      messages: [{ role: "user", content: scheduledTaskPrompt(job) }],
      model: params.model,
      maxIterations: params.maxIterations,
      stream: params.stream,
      metadata: {
        source: "cron",
        cronJobId: job.id,
        cronJobName: job.name,
        deliver: job.payload.deliver === true,
        channel: job.payload.channel ?? undefined,
        to: job.payload.to ?? undefined,
      },
    };

    try {
      const response = await this.runSpecForRequest(request, spec);
      if (response.error) {
        throw new Error(response.error.message);
      }
      const result = isJsonObject(response.result) ? response.result : {};
      const stopReason = typeof result.stopReason === "string" ? result.stopReason : "error";
      const status = stopReason === "error" || stopReason === "tool_error" ? "error" : "ok";
      return cronRunRecord(job, status, runAtMs, Date.now() - runAtMs, {
        runId,
        finalContent: typeof result.finalContent === "string" ? result.finalContent : "",
        stopReason,
        ...(typeof result.error === "string" ? { error: result.error } : {}),
      });
    } catch (error) {
      return cronRunRecord(job, "error", runAtMs, Date.now() - runAtMs, {
        runId,
        error: errorMessage(error),
      });
    }
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
    if (hasCommandMessage(spec.messages)) {
      const commandResult = await this.tryHandleCommand(request.trace_id, spec);
      if (commandResult) {
        this.emitUsage(request.trace_id, spec, commandResult);
        this.emitEvent({
          protocol_version: WORKER_PROTOCOL_VERSION,
          trace_id: request.trace_id,
          event: "agent.done",
          payload: withNativePayloadAliases({
            runId: spec.runId,
            stopReason: commandResult.stopReason,
          }),
        });
        return {
          protocol_version: WORKER_PROTOCOL_VERSION,
          id: request.id,
          trace_id: request.trace_id,
          result: commandResult,
        };
      }
    }
    if (this.prepareTools) {
      await this.prepareTools(request.trace_id);
    }
    const activeRun: ActiveRun = { traceId: request.trace_id, sessionId: spec.sessionId, cancelled: false };
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
      const cancelled = this.cancelActiveRun(runId);
      if (!cancelled) {
        return {
          protocol_version: WORKER_PROTOCOL_VERSION,
          id: request.id,
          trace_id: request.trace_id,
          result: { ok: false, runId, reason: "not_found" },
        };
      }
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

  private cancelActiveRun(runId: string): boolean {
    const activeRun = this.activeRuns.get(runId);
    if (!activeRun) {
      return false;
    }
    activeRun.cancelled = true;
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: activeRun.traceId,
      event: "agent.cancelled",
      payload: withNativePayloadAliases({ runId }),
    });
    return true;
  }

  private cancelActiveRunsForSession(sessionId: string | undefined): { cancelledCount: number; runIds: string[] } {
    if (!sessionId) {
      return { cancelledCount: 0, runIds: [] };
    }
    const runIds: string[] = [];
    for (const [runId, activeRun] of this.activeRuns.entries()) {
      if (activeRun.sessionId === sessionId && this.cancelActiveRun(runId)) {
        runIds.push(runId);
      }
    }
    return { cancelledCount: runIds.length, runIds };
  }

  private statusSnapshot(sessionId: string | undefined): {
    activeRunCount: number;
    activeSessionRunCount: number;
    sessionId?: string;
  } {
    let activeSessionRunCount = 0;
    for (const activeRun of this.activeRuns.values()) {
      if (activeRun.sessionId === sessionId) {
        activeSessionRunCount += 1;
      }
    }
    return {
      activeRunCount: this.activeRuns.size,
      activeSessionRunCount,
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private async clearSessionForCommand(sessionId: string | undefined, traceId: string): Promise<ClearSessionResult> {
    if (!sessionId || !this.sessionBridge?.clearSession) {
      return {
        sessionId: sessionId ?? "",
        messagesBefore: 0,
        messagesAfter: 0,
        checkpointCleared: false,
      };
    }
    return this.sessionBridge.clearSession(sessionId, traceId);
  }

  private async listPendingApprovalsForCommand(
    sessionId: string | undefined,
    traceId: string,
  ): Promise<{ approvals: Array<{ id: string; summary: string; risk: string; category: string; reason: string }> }> {
    if (!sessionId || !this.approvalBridge?.listPendingApprovals) {
      return { approvals: [] };
    }
    const result = await this.approvalBridge.listPendingApprovals(sessionId, traceId);
    const approvals = Array.isArray(result.approvals) ? result.approvals : [];
    return {
      approvals: approvals
        .filter(isPendingApprovalSummary)
        .map((item) => ({
          id: item.id,
          summary: item.summary,
          risk: item.risk,
          category: item.category,
          reason: item.reason,
        })),
    };
  }

  private async resolvePendingApprovalForCommand(
    request: ResolvePendingApprovalRequest,
  ): Promise<ResolvePendingApprovalResult> {
    if (!request.sessionId || !this.approvalBridge) {
      return {
        resolved: false,
        approvalId: request.approvalId,
        approved: request.approved,
        scope: request.scope,
      };
    }
    try {
      const result = await this.approvalBridge.resolveApproval({
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        approved: request.approved,
        scope: request.scope,
      }, request.traceId);
      return {
        resolved: true,
        approvalId: stringField(result, "approvalId", "id") ?? request.approvalId,
        approved: request.approved,
        summary: typeof result.summary === "string" ? result.summary : undefined,
        scope: approvalScopeField(result) ?? request.scope,
      };
    } catch {
      return {
        resolved: false,
        approvalId: request.approvalId,
        approved: request.approved,
        scope: request.scope,
      };
    }
  }

  private runDreamForCommand(request: DreamCommandRequest): Promise<DreamCommandResult> | DreamCommandResult {
    return this.dreamBridge?.runDream(request) ?? { content: "Dream commands are unavailable in this runtime." };
  }

  private getDreamLogForCommand(request: DreamLogCommandRequest): Promise<DreamCommandResult> | DreamCommandResult {
    return this.dreamBridge?.getDreamLog(request) ?? { content: "Dream commands are unavailable in this runtime." };
  }

  private restoreDreamForCommand(request: DreamRestoreCommandRequest): Promise<DreamCommandResult> | DreamCommandResult {
    return this.dreamBridge?.restoreDream(request) ?? { content: "Dream commands are unavailable in this runtime." };
  }

  private async tryHandleCommand(traceId: string, spec: AgentRunSpec): Promise<AgentRunResult | undefined> {
    const message = lastUserMessage(spec.messages);
    if (!message) {
      return undefined;
    }
    const result = await this.commandRouter.dispatch(message.content, {
      traceId,
      runId: spec.runId,
      sessionId: spec.sessionId,
    });
    if (!result.handled) {
      return undefined;
    }
    const commandMessage: AgentMessage = {
      role: "assistant",
      content: result.output ?? "",
      metadata: result.metadata,
    };
    return {
      finalContent: commandMessage.content,
      messages: [...spec.messages, commandMessage],
      toolsUsed: [],
      stopReason: "command",
      ...(result.metadata ? { metadata: result.metadata } : {}),
    };
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

  private async handleProviderCatalogListRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.listProviderCatalog) {
      return this.failure(request, "provider.catalog.list requires a provider catalog handler");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.listProviderCatalog(),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error));
    }
  }

  private async handleProviderRuntimeResolveRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.resolveProviderRuntime) {
      return this.failure(request, "provider.runtime.resolve requires a provider runtime handler");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.resolveProviderRuntime(parseProviderRuntimeResolveRequest(request.params)),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleProviderModelValidateRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.validateProviderModel) {
      return this.failure(request, "provider.model.validate requires a provider model validation handler");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.validateProviderModel(parseProviderModelValidateRequest(request.params)),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleSkillsWebuiListRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.skillsBridge) {
      return this.failure(request, "skills.webui_list requires a skills bridge");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.skillsBridge.listWebuiSkills(request.trace_id),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error));
    }
  }

  private async handleSkillsWebuiDetailRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.skillsBridge) {
      return this.failure(request, "skills.webui_detail requires a skills bridge");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.skillsBridge.getWebuiSkillDetail(parseSkillDetailName(request.params), request.trace_id),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleSkillsWebuiCreateRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.skillsBridge) {
      return this.failure(request, "skills.webui_create requires a skills bridge");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.skillsBridge.createWebuiSkill(parseSkillMutationBody(request.params, "skills.webui_create"), request.trace_id),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleSkillsWebuiUpdateRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.skillsBridge) {
      return this.failure(request, "skills.webui_update requires a skills bridge");
    }
    try {
      const { name, body } = parseNamedSkillMutation(request.params, "skills.webui_update");
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.skillsBridge.updateWebuiSkill(name, body, request.trace_id),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleSkillsWebuiDeleteRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.skillsBridge) {
      return this.failure(request, "skills.webui_delete requires a skills bridge");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.skillsBridge.deleteWebuiSkill(parseSkillDetailName(request.params), request.trace_id),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleSkillsWebuiValidateRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.skillsBridge) {
      return this.failure(request, "skills.webui_validate requires a skills bridge");
    }
    try {
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: await this.skillsBridge.validateWebuiSkill(parseSkillDetailName(request.params), request.trace_id),
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
    const activeRun: ActiveRun = { traceId, sessionId: spec.sessionId, cancelled: false };
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

function lastUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return message;
    }
  }
  return undefined;
}

function hasCommandMessage(messages: AgentMessage[]): boolean {
  return lastUserMessage(messages)?.content.trim().startsWith("/") === true;
}

function isPendingApprovalSummary(value: unknown): value is {
  id: string;
  summary: string;
  risk: string;
  category: string;
  reason: string;
} {
  return isJsonObject(value)
    && typeof value.id === "string"
    && typeof value.summary === "string"
    && typeof value.risk === "string"
    && typeof value.category === "string"
    && typeof value.reason === "string";
}

function stringField(object: Record<string, unknown>, camelKey: string, snakeKey: string): string | undefined {
  const value = object[camelKey] ?? object[snakeKey];
  return typeof value === "string" ? value : undefined;
}

function approvalScopeField(object: Record<string, unknown>): "once" | "session" | undefined {
  const value = stringField(object, "scope", "scope");
  return value === "once" || value === "session" ? value : undefined;
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
    case "provider_retry":
      return "agent.provider_retry";
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
    ...(payload.delaySeconds !== undefined ? { delay_seconds: payload.delaySeconds } : {}),
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
    providerRetryMode: providerRetryModeParam(raw),
    contextWindow: numberParam(raw, "contextWindow", "context_window"),
    toolResultBudget: numberParam(raw, "toolResultBudget", "tool_result_budget"),
    failOnToolError: booleanParam(raw, "failOnToolError", "fail_on_tool_error"),
    metadata: isJsonObject(raw.metadata) ? raw.metadata : undefined,
  };
}

function parseCronRunDueParams(params: Record<string, unknown> | undefined): CronRunDueParams {
  if (!isJsonObject(params) || !Array.isArray(params.jobs)) {
    throw new Error("cron.run_due requires array params.jobs");
  }
  const model = stringParam(params, "model", "model");
  if (!model) {
    throw new Error("cron.run_due params.model must be a string");
  }
  return {
    jobs: params.jobs.map(parseCronRunDueJob),
    model,
    maxIterations: numberParam(params, "maxIterations", "max_iterations") ?? 4,
    stream: booleanParam(params, "stream", "stream") ?? false,
  };
}

function parseCronRunDueJob(value: unknown): CronRunDueJob {
  if (!isJsonObject(value)) {
    throw new Error("cron.run_due jobs must be objects");
  }
  const id = stringParam(value, "id", "id");
  const name = stringParam(value, "name", "name");
  const payload = isJsonObject(value.payload) ? value.payload : undefined;
  if (!id || !name || !payload) {
    throw new Error("cron.run_due job.id, job.name, and job.payload are required");
  }
  const message = stringParam(payload, "message", "message");
  if (!message) {
    throw new Error("cron.run_due job.payload.message must be a string");
  }
  return {
    id,
    name,
    enabled: value.enabled !== false,
    payload: {
      kind: payload.kind === "system_event" ? "system_event" : "agent_turn",
      message,
      deliver: payload.deliver === true,
      channel: stringParam(payload, "channel", "channel") ?? null,
      to: stringParam(payload, "to", "to") ?? null,
    },
  };
}

function scheduledTaskPrompt(job: CronRunDueJob): string {
  return [
    "[Scheduled Task] Timer finished.",
    "",
    `Task '${job.name}' has been triggered.`,
    `Scheduled instruction: ${job.payload.message}`,
  ].join("\n");
}

function cronRunRecord(
  job: CronRunDueJob,
  status: "ok" | "error" | "skipped",
  runAtMs: number,
  durationMs: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jobId: job.id,
    jobName: job.name,
    status,
    runAtMs,
    durationMs,
    ...extra,
  };
}

function sanitizeCronRunId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-");
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
    providerRetryMode: providerRetryModeParam(raw),
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

function parseProviderRuntimeResolveRequest(params: Record<string, unknown> | undefined): ProviderRuntimeResolveRequest {
  if (params !== undefined && !isJsonObject(params)) {
    throw new Error("provider.runtime.resolve requires object params");
  }
  const raw = params ?? {};
  return {
    providerId: stringParam(raw, "providerId", "provider_id"),
    model: stringParam(raw, "model", "model"),
  };
}

function parseProviderModelValidateRequest(params: Record<string, unknown> | undefined): ProviderModelValidateRequest {
  if (!isJsonObject(params)) {
    throw new Error("provider.model.validate requires object params");
  }
  const providerId = stringParam(params, "providerId", "provider_id");
  if (!providerId) {
    throw new Error("provider.model.validate params.providerId must be a string");
  }
  const model = stringParam(params, "model", "model");
  if (!model) {
    throw new Error("provider.model.validate params.model must be a string");
  }
  return { providerId, model };
}

function parseSkillDetailName(params: Record<string, unknown> | undefined): string {
  if (!isJsonObject(params)) {
    throw new Error("skills.webui_detail requires object params");
  }
  const name = stringParam(params, "name", "name");
  if (!name) {
    throw new Error("skills.webui_detail params.name must be a string");
  }
  return name;
}

function parseSkillMutationBody(params: Record<string, unknown> | undefined, method: string): Record<string, unknown> {
  if (!isJsonObject(params) || !isJsonObject(params.body)) {
    throw new Error(`${method} requires object params.body`);
  }
  return params.body;
}

function parseNamedSkillMutation(
  params: Record<string, unknown> | undefined,
  method: string,
): { name: string; body: Record<string, unknown> } {
  return {
    name: parseSkillDetailName(params),
    body: parseSkillMutationBody(params, method),
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

function providerRetryModeParam(params: Record<string, unknown>): "standard" | "persistent" | undefined {
  const value = params.providerRetryMode ?? params.provider_retry_mode;
  return value === "standard" || value === "persistent" ? value : undefined;
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
