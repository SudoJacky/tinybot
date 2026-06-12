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
import { previewBlueprint, validateBlueprint } from "../cowork/coworkBlueprint.ts";
import type { CoworkEnvelope } from "../cowork/coworkMailbox.ts";
import type { CoworkScheduler } from "../cowork/coworkScheduler.ts";
import type { CoworkService } from "../cowork/coworkService.ts";
import { coworkSessionSnapshot } from "../cowork/coworkSnapshot.ts";
import type { CoworkBranch, CoworkSession, JsonObject } from "../cowork/coworkTypes.ts";
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
  coworkService?: CoworkService;
  coworkScheduler?: CoworkScheduler;
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

type CoworkRouteRequest = {
  method: string;
  path: string;
  body?: unknown;
  query: URLSearchParams;
};

type CoworkRouteResponse = {
  status: number;
  body: unknown;
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
  private readonly coworkService?: CoworkService;
  private readonly coworkScheduler?: CoworkScheduler;
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
    this.coworkService = options.coworkService;
    this.coworkScheduler = options.coworkScheduler;
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

    if (request.method === "cowork.list_sessions") {
      return this.handleCoworkListSessionsRequest(request);
    }

    if (request.method === "cowork.get_session") {
      return this.handleCoworkGetSessionRequest(request);
    }

    if (request.method === "cowork.create_session") {
      return this.handleCoworkCreateSessionRequest(request);
    }

    if (request.method === "cowork.delete_session") {
      return this.handleCoworkDeleteSessionRequest(request);
    }

    if (request.method === "cowork.send_message") {
      return this.handleCoworkSendMessageRequest(request);
    }

    if (request.method === "cowork.add_task") {
      return this.handleCoworkAddTaskRequest(request);
    }

    if (request.method === "cowork.assign_task") {
      return this.handleCoworkAssignTaskRequest(request);
    }

    if (request.method === "cowork.retry_task") {
      return this.handleCoworkRetryTaskRequest(request);
    }

    if (request.method === "cowork.request_task_review") {
      return this.handleCoworkRequestTaskReviewRequest(request);
    }

    if (request.method === "cowork.retry_work_unit") {
      return this.handleCoworkRetryWorkUnitRequest(request);
    }

    if (request.method === "cowork.skip_work_unit") {
      return this.handleCoworkSkipWorkUnitRequest(request);
    }

    if (request.method === "cowork.cancel_work_unit") {
      return this.handleCoworkCancelWorkUnitRequest(request);
    }

    if (request.method === "cowork.pause_session") {
      return this.handleCoworkPauseSessionRequest(request);
    }

    if (request.method === "cowork.resume_session") {
      return this.handleCoworkResumeSessionRequest(request);
    }

    if (request.method === "cowork.emergency_stop_session") {
      return this.handleCoworkEmergencyStopSessionRequest(request);
    }

    if (request.method === "cowork.run_session") {
      return this.handleCoworkRunSessionRequest(request);
    }

    if (request.method === "cowork.update_budget") {
      return this.handleCoworkUpdateBudgetRequest(request);
    }

    if (request.method === "cowork.select_branch") {
      return this.handleCoworkSelectBranchRequest(request);
    }

    if (request.method === "cowork.derive_branch") {
      return this.handleCoworkDeriveBranchRequest(request);
    }

    if (request.method === "cowork.select_branch_result") {
      return this.handleCoworkSelectBranchResultRequest(request);
    }

    if (request.method === "cowork.merge_branch_results") {
      return this.handleCoworkMergeBranchResultsRequest(request);
    }

    if (request.method === "cowork.deliver_envelope") {
      return this.handleCoworkDeliverEnvelopeRequest(request);
    }

    if (request.method === "cowork.mark_messages_read") {
      return this.handleCoworkMarkMessagesReadRequest(request);
    }

    if (request.method === "cowork.expire_mailbox_records") {
      return this.handleCoworkExpireMailboxRecordsRequest(request);
    }

    if (request.method === "cowork.escalate_stale_blockers") {
      return this.handleCoworkEscalateStaleBlockersRequest(request);
    }

    if (request.method === "cowork.export_blueprint") {
      return this.handleCoworkExportBlueprintRequest(request);
    }

    if (request.method === "cowork.get_graph") {
      return this.handleCoworkGetGraphRequest(request);
    }

    if (request.method === "cowork.get_trace") {
      return this.handleCoworkGetTraceRequest(request);
    }

    if (request.method === "cowork.get_summary") {
      return this.handleCoworkGetSummaryRequest(request);
    }

    if (request.method === "cowork.get_dag") {
      return this.handleCoworkGetDagRequest(request);
    }

    if (request.method === "cowork.get_artifacts") {
      return this.handleCoworkGetArtifactsRequest(request);
    }

    if (request.method === "cowork.get_organization") {
      return this.handleCoworkGetOrganizationRequest(request);
    }

    if (request.method === "cowork.get_queues") {
      return this.handleCoworkGetQueuesRequest(request);
    }

    if (request.method === "cowork.get_agent_activity") {
      return this.handleCoworkGetAgentActivityRequest(request);
    }

    if (request.method === "cowork.get_observation_detail") {
      return this.handleCoworkGetObservationDetailRequest(request);
    }

    if (request.method === "cowork.validate_blueprint") {
      return this.handleCoworkValidateBlueprintRequest(request);
    }

    if (request.method === "cowork.preview_blueprint") {
      return this.handleCoworkPreviewBlueprintRequest(request);
    }

    if (request.method === "cowork.route_request") {
      return this.handleCoworkRouteRequest(request);
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

  private handleCoworkValidateBlueprintRequest(request: WorkerRequest): WorkerResponse {
    try {
      const params = parseCoworkBlueprintParams(request.params, "cowork.validate_blueprint");
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: validateBlueprint(params.blueprint, params.policy, params.defaultGoal),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private handleCoworkPreviewBlueprintRequest(request: WorkerRequest): WorkerResponse {
    try {
      const params = parseCoworkBlueprintParams(request.params, "cowork.preview_blueprint");
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: previewBlueprint(params.blueprint, params.policy, params.defaultGoal),
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkRouteRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const route = parseCoworkRouteRequest(request.params);
      const result = await this.dispatchCoworkRouteRequest(route, request.trace_id);
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result,
      };
    } catch (error) {
      const message = errorMessage(error);
      if (/^cowork session '.+' not found$/.test(message)) {
        return {
          protocol_version: WORKER_PROTOCOL_VERSION,
          id: request.id,
          trace_id: request.trace_id,
          result: { status: 404, body: { error: "cowork session not found" } },
        };
      }
      return this.failure(request, message, {}, "invalid_protocol");
    }
  }

  private async dispatchCoworkRouteRequest(route: CoworkRouteRequest, traceId: string): Promise<CoworkRouteResponse> {
    if (!this.coworkService) {
      return { status: 503, body: { error: "cowork service is unavailable" } };
    }
    const segments = coworkRouteSegments(route.path);
    const body = isJsonObject(route.body) ? route.body : {};

    if (segments.length === 2 && segments[0] === "blueprints" && route.method === "POST") {
      return this.dispatchCoworkBlueprintRoute(segments, body);
    }

    if (segments.length === 1 && segments[0] === "sessions" && route.method === "GET") {
      const sessions = await this.coworkService.listSessions(traceId, {
        includeCompleted: route.query.get("include_completed") === "true" || route.query.get("includeCompleted") === "true",
      });
      const originChatId = route.query.get("origin_chat_id") ?? route.query.get("originChatId");
      return {
        status: 200,
        body: {
          items: originChatId
            ? sessions.filter((session) => session.runtime_state?.origin_chat_id === originChatId)
            : sessions,
        },
      };
    }

    if (segments.length === 1 && segments[0] === "sessions" && route.method === "POST") {
      const params = parseCoworkCreateSessionParams(body);
      if (params.blueprint !== undefined) {
        const result = await this.coworkService.createSessionFromBlueprint({
          traceId,
          blueprint: params.blueprint,
          runtimeState: params.runtimeState,
        });
        return { status: result.session ? 200 : 400, body: result };
      }
      const session = await this.coworkService.createSession({
        traceId,
        goal: params.goal,
        title: params.title,
        workflowMode: params.workflowMode,
        agents: params.agents,
        tasks: params.tasks,
        budgets: params.budgets,
        runtimeState: params.runtimeState,
      });
      return { status: 200, body: { result: `started ${session.id}`, session } };
    }

    if (segments.length >= 2 && segments[0] === "sessions") {
      const sessionId = segments[1];
      return this.dispatchCoworkSessionRoute(route, segments, sessionId, body, traceId);
    }

    return unsupportedCoworkRoute(route);
  }

  private dispatchCoworkBlueprintRoute(segments: string[], body: Record<string, unknown>): CoworkRouteResponse {
    const action = segments[1];
    const params = "blueprint" in body ? body : { blueprint: body };
    if (action === "validate") {
      const parsed = parseCoworkBlueprintParams(params, "cowork.route_request");
      const result = validateBlueprint(parsed.blueprint, parsed.policy, parsed.defaultGoal);
      return { status: result.ok ? 200 : 400, body: result };
    }
    if (action === "preview") {
      const parsed = parseCoworkBlueprintParams(params, "cowork.route_request");
      const result = previewBlueprint(parsed.blueprint, parsed.policy, parsed.defaultGoal);
      return { status: result.ok ? 200 : 400, body: result };
    }
    return { status: 404, body: { error: "unsupported cowork route" } };
  }

  private async dispatchCoworkSessionRoute(
    route: CoworkRouteRequest,
    segments: string[],
    sessionId: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<CoworkRouteResponse> {
    if (!this.coworkService) {
      return { status: 503, body: { error: "cowork service is unavailable" } };
    }

    if (segments.length === 2 && route.method === "GET") {
      const session = await this.coworkService.getSession(sessionId, traceId);
      return session ? { status: 200, body: { session } } : { status: 404, body: { error: "cowork session not found" } };
    }

    if (segments.length === 2 && route.method === "DELETE") {
      const deleted = await this.coworkService.deleteSession(sessionId, traceId);
      return deleted ? { status: 200, body: { deleted } } : { status: 404, body: { error: "cowork session not found" } };
    }

    const resource = segments[2];
    if (["pause", "resume", "emergency-stop", "run"].includes(resource) && segments.length === 3 && route.method === "POST") {
      return this.dispatchCoworkSessionControlRoute(route, resource, sessionId, body, traceId);
    }

    if (resource === "messages" && segments.length === 3 && route.method === "POST") {
      const content = stringParam(body, "content", "content")?.trim() ?? "";
      if (!content) {
        return { status: 400, body: { error: "content is required" } };
      }
      const params = parseCoworkSendMessageParams({ ...body, session_id: sessionId, content });
      if (params.recipientIds.length === 0) {
        const session = await this.coworkService.getSession(params.sessionId, traceId);
        if (session?.workflow_mode === "swarm") {
          const result = await this.coworkService.steerSwarm({
            traceId,
            sessionId: params.sessionId,
            instruction: params.content,
          });
          return { status: result.result.startsWith("Error:") ? 400 : 200, body: result };
        }
      }
      const result = await this.coworkService.sendMessage({
        traceId,
        sessionId: params.sessionId,
        senderId: params.senderId,
        recipientIds: params.recipientIds,
        content: params.content,
        threadId: params.threadId,
        wakeRecipients: params.wakeRecipients,
      });
      return { status: 200, body: result };
    }

    if (resource === "tasks" && segments.length === 5 && route.method === "POST") {
      return this.dispatchCoworkTaskActionRoute(segments, sessionId, body, traceId);
    }

    if (resource === "tasks" && segments.length === 3 && route.method === "POST") {
      const title = stringParam(body, "title", "title")?.trim() ?? "";
      if (!title) {
        return { status: 400, body: { error: "title is required" } };
      }
      const params = parseCoworkAddTaskParams({ ...body, session_id: sessionId, title });
      const result = await this.coworkService.addTask({
        traceId,
        sessionId: params.sessionId,
        title: params.title,
        description: params.description,
        assignedAgentId: params.assignedAgentId,
        dependencies: params.dependencies,
        priority: params.priority,
        expectedOutput: params.expectedOutput,
        reviewRequired: params.reviewRequired,
        reviewerAgentIds: params.reviewerAgentIds,
        fanoutGroupId: params.fanoutGroupId,
        mergeTaskId: params.mergeTaskId,
      });
      return { status: 200, body: result };
    }

    if (resource === "work-units" && segments.length === 5 && route.method === "POST") {
      return this.dispatchCoworkWorkUnitActionRoute(segments, sessionId, body, traceId);
    }

    if (resource === "blueprint" && segments.length === 3 && route.method === "GET") {
      const blueprint = await this.coworkService.exportBlueprint({ traceId, sessionId });
      return { status: 200, body: { blueprint } };
    }

    if (resource === "budget" && segments.length === 3 && (route.method === "POST" || route.method === "PATCH")) {
      if (
        (Object.prototype.hasOwnProperty.call(body, "budgets") && !isJsonObject(body.budgets))
        || (Object.prototype.hasOwnProperty.call(body, "budget") && !isJsonObject(body.budget))
      ) {
        return { status: 400, body: { error: "budgets must be an object" } };
      }
      const params = parseCoworkUpdateBudgetParams({ ...body, session_id: sessionId });
      const result = await this.coworkService.updateBudget({
        traceId,
        sessionId: params.sessionId,
        budgets: params.budgets,
      });
      return { status: 200, body: result };
    }

    if (resource === "summary" && segments.length === 3 && route.method === "GET") {
      const summary = await this.coworkService.getSummary({ traceId, sessionId });
      return { status: 200, body: { summary } };
    }

    if (resource === "graph" && segments.length === 3 && route.method === "GET") {
      const session = await this.coworkService.getSession(sessionId, traceId);
      if (!session) {
        return { status: 404, body: { error: "cowork session not found" } };
      }
      const snapshot = coworkSessionSnapshot(session);
      return {
        status: 200,
        body: {
          graph: snapshot.graph ?? {},
          trace: snapshot.trace ?? [],
          architecture_topology: snapshot.architecture_topology ?? {},
          organization_projection: snapshot.organization_projection ?? {},
        },
      };
    }

    if (resource === "trace" && segments.length === 3 && route.method === "GET") {
      const result = await this.coworkService.getTrace({ traceId, sessionId });
      return { status: 200, body: result };
    }

    if (resource === "dag" && segments.length === 3 && route.method === "GET") {
      const session = await this.coworkService.getSession(sessionId, traceId);
      if (!session) {
        return { status: 404, body: { error: "cowork session not found" } };
      }
      const snapshot = coworkSessionSnapshot(session);
      return { status: 200, body: { task_dag: snapshot.task_dag ?? {}, artifact_index: snapshot.artifact_index ?? [] } };
    }

    if (resource === "artifacts" && segments.length === 3 && route.method === "GET") {
      const session = await this.coworkService.getSession(sessionId, traceId);
      if (!session) {
        return { status: 404, body: { error: "cowork session not found" } };
      }
      const snapshot = coworkSessionSnapshot(session);
      const artifactIndex = snapshot.artifact_index ?? [];
      return {
        status: 200,
        body: {
          artifacts: artifactIndex,
          artifact_index: artifactIndex,
          large_swarm_summary: snapshot.large_swarm_summary ?? {},
          swarm_organization: snapshot.swarm_organization ?? {},
        },
      };
    }

    if (resource === "organization" && segments.length === 3 && route.method === "GET") {
      const session = await this.coworkService.getSession(sessionId, traceId);
      if (!session) {
        return { status: 404, body: { error: "cowork session not found" } };
      }
      const snapshot = coworkSessionSnapshot(session);
      return {
        status: 200,
        body: {
          organization: snapshot.organization_projection ?? {},
          organization_projection: snapshot.organization_projection ?? {},
          swarm_organization: snapshot.swarm_organization ?? {},
        },
      };
    }

    if (resource === "queues" && segments.length === 3 && route.method === "GET") {
      const session = await this.coworkService.getSession(sessionId, traceId);
      if (!session) {
        return { status: 404, body: { error: "cowork session not found" } };
      }
      const snapshot = coworkSessionSnapshot(session);
      const queues = snapshot.swarm_queues ?? {};
      return { status: 200, body: { queues, swarm_queues: queues } };
    }

    if (resource === "agents" && segments.length === 5 && segments[4] === "activity" && route.method === "GET") {
      const activity = await this.coworkService.getAgentActivity({
        traceId,
        sessionId,
        agentId: segments[3],
        limit: route.query.has("limit") ? Number.parseInt(route.query.get("limit") ?? "", 10) : undefined,
      });
      return { status: activity.available === false ? 404 : 200, body: { activity } };
    }

    if (resource === "observations" && segments.length === 4 && route.method === "GET") {
      const detail = await this.coworkService.getObservationDetail({
        traceId,
        sessionId,
        detailId: segments[3],
        requesterAgentId: route.query.get("agent_id") ?? route.query.get("agentId") ?? undefined,
      });
      const state = typeof detail.state === "string" ? detail.state : "";
      const status = state === "unavailable" ? 404 : state === "unauthorized" ? 403 : 200;
      return { status, body: { detail } };
    }

    if (resource === "branches") {
      return this.dispatchCoworkBranchRoute(route, segments, sessionId, body, traceId);
    }

    if (resource === "final-result" && segments.length === 4 && route.method === "POST") {
      return this.dispatchCoworkFinalResultRoute(segments, sessionId, body, traceId);
    }

    if (resource === "branch-results" && segments.length === 4 && segments[3] === "merge" && route.method === "POST") {
      const params = parseCoworkMergeBranchResultsParams({ ...body, session_id: sessionId });
      const result = await this.coworkService.mergeBranchResults({
        traceId,
        sessionId: params.sessionId,
        branchIds: params.branchIds,
        summary: params.summary,
      });
      return result.finalResult
        ? { status: 200, body: result }
        : { status: 400, body: { error: result.result, session: result.session } };
    }

    return unsupportedCoworkRoute(route);
  }

  private async dispatchCoworkFinalResultRoute(
    segments: string[],
    sessionId: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<CoworkRouteResponse> {
    if (!this.coworkService) {
      return { status: 503, body: { error: "cowork service is unavailable" } };
    }
    const action = segments[3];
    if (action === "select") {
      const params = parseCoworkSelectBranchResultParams({ ...body, session_id: sessionId });
      const result = await this.coworkService.selectSessionFinalResult({
        traceId,
        sessionId: params.sessionId,
        branchId: params.branchId,
        resultId: params.resultId,
      });
      return result.finalResult
        ? { status: 200, body: result }
        : { status: 400, body: { error: result.result, session: result.session } };
    }
    if (action === "merge") {
      const params = parseCoworkMergeBranchResultsParams({ ...body, session_id: sessionId });
      const result = await this.coworkService.mergeBranchResults({
        traceId,
        sessionId: params.sessionId,
        branchIds: params.branchIds,
        summary: params.summary,
      });
      return result.finalResult
        ? { status: 200, body: result }
        : { status: 400, body: { error: result.result, session: result.session } };
    }
    return { status: 404, body: { error: "unsupported cowork final-result route", action } };
  }

  private async dispatchCoworkSessionControlRoute(
    route: CoworkRouteRequest,
    resource: string,
    sessionId: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<CoworkRouteResponse> {
    if (!this.coworkService) {
      return { status: 503, body: { error: "cowork service is unavailable" } };
    }
    if (resource === "pause") {
      return { status: 200, body: await this.coworkService.pauseSession({ traceId, sessionId }) };
    }
    if (resource === "resume") {
      return { status: 200, body: await this.coworkService.resumeSession({ traceId, sessionId }) };
    }
    if (resource === "emergency-stop") {
      const reason = stringParam(body, "reason", "reason");
      return { status: 200, body: await this.coworkService.emergencyStopSession({ traceId, sessionId, reason }) };
    }
    if (resource === "run") {
      if (!this.coworkScheduler) {
        return {
          status: 501,
          body: {
            error: "cowork route not migrated",
            method: route.method,
            path: route.path,
          },
        };
      }
      const params = parseCoworkRunSessionParams({ ...body, session_id: sessionId });
      const result = await this.coworkScheduler.runSession({
        traceId,
        sessionId: params.sessionId,
        maxRounds: params.maxRounds,
        maxAgents: params.maxAgents,
        maxAgentCalls: params.maxAgentCalls,
        runUntilIdle: params.runUntilIdle,
        stopOnBlocker: params.stopOnBlocker,
      });
      return { status: result.result.startsWith("Error:") ? 404 : 200, body: result };
    }
    return {
      status: 501,
      body: {
        error: "cowork route not migrated",
        method: route.method,
        path: route.path,
      },
    };
  }

  private async dispatchCoworkTaskActionRoute(
    segments: string[],
    sessionId: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<CoworkRouteResponse> {
    if (!this.coworkService) {
      return { status: 503, body: { error: "cowork service is unavailable" } };
    }
    const taskId = segments[3];
    const action = segments[4];
    if (action === "assign") {
      const agentId = stringParam(body, "agentId", "agent_id")
        ?? stringParam(body, "assignedAgentId", "assigned_agent_id")
        ?? "";
      const result = await this.coworkService.assignTask({
        traceId,
        sessionId,
        taskId,
        agentId,
      });
      return { status: result.result.startsWith("Error:") ? 400 : 200, body: result };
    }
    if (action === "retry") {
      const params = parseCoworkTaskMutationParams({ ...body, session_id: sessionId, task_id: taskId }, "cowork.route_request");
      const result = await this.coworkService.retryTask({
        traceId,
        sessionId: params.sessionId,
        taskId: params.taskId,
      });
      return { status: result.result.startsWith("Error:") ? 400 : 200, body: result };
    }
    if (action === "review") {
      const params = parseCoworkTaskMutationParams({ ...body, session_id: sessionId, task_id: taskId }, "cowork.route_request");
      try {
        const result = await this.coworkService.requestTaskReview({
          traceId,
          sessionId: params.sessionId,
          taskId: params.taskId,
          reviewerAgentId: params.reviewerAgentId,
        });
        return { status: 200, body: result };
      } catch (error) {
        const message = errorMessage(error);
        if (message.startsWith("Error:")) {
          return { status: 400, body: { error: message } };
        }
        throw error;
      }
    }
    return { status: 404, body: { error: "unsupported cowork task route", task_id: taskId, action } };
  }

  private async dispatchCoworkWorkUnitActionRoute(
    segments: string[],
    sessionId: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<CoworkRouteResponse> {
    if (!this.coworkService) {
      return { status: 503, body: { error: "cowork service is unavailable" } };
    }
    const workUnitId = segments[3];
    const action = segments[4];
    const params = parseCoworkWorkUnitActionParams({ ...body, session_id: sessionId, work_unit_id: workUnitId }, "cowork.route_request");
    let result: { session: unknown; result: string };
    if (action === "retry") {
      result = await this.coworkService.retryWorkUnit({
        traceId,
        sessionId: params.sessionId,
        workUnitId: params.workUnitId,
        reason: params.reason,
      });
    } else if (action === "skip") {
      result = await this.coworkService.skipWorkUnit({
        traceId,
        sessionId: params.sessionId,
        workUnitId: params.workUnitId,
        reason: params.reason,
      });
    } else if (action === "cancel") {
      result = await this.coworkService.cancelWorkUnit({
        traceId,
        sessionId: params.sessionId,
        workUnitId: params.workUnitId,
        reason: params.reason,
      });
    } else {
      return { status: 404, body: { error: "unsupported cowork work-unit route", work_unit_id: workUnitId, action } };
    }
    return { status: result.result.startsWith("Error:") ? 400 : 200, body: result };
  }

  private async dispatchCoworkBranchRoute(
    route: CoworkRouteRequest,
    segments: string[],
    sessionId: string,
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<CoworkRouteResponse> {
    if (!this.coworkService) {
      return { status: 503, body: { error: "cowork service is unavailable" } };
    }
    if (segments.length === 3 && route.method === "GET") {
      const session = await this.coworkService.getSession(sessionId, traceId);
      if (!session) {
        return { status: 404, body: { error: "cowork session not found" } };
      }
      return {
        status: 200,
        body: {
          current_branch_id: session.current_branch_id,
          branches: branchSnapshots(session),
        },
      };
    }

    if (segments.length === 4 && segments[3] === "derive" && route.method === "POST") {
      const params = parseCoworkDeriveBranchParams({ ...body, session_id: sessionId });
      const result = await this.coworkService.deriveBranch({
        traceId,
        sessionId: params.sessionId,
        sourceBranchId: params.sourceBranchId,
        targetArchitecture: params.targetArchitecture,
        reason: params.reason,
        title: params.title,
        inheritedContextSummary: params.inheritedContextSummary,
      });
      return result.branch
        ? { status: 200, body: result }
        : { status: 400, body: { error: result.result, session: result.session } };
    }

    if (segments.length === 5 && segments[4] === "derive" && route.method === "POST") {
      const params = parseCoworkDeriveBranchParams({ ...body, session_id: sessionId, source_branch_id: segments[3] });
      const result = await this.coworkService.deriveBranch({
        traceId,
        sessionId: params.sessionId,
        sourceBranchId: params.sourceBranchId,
        targetArchitecture: params.targetArchitecture,
        reason: params.reason,
        title: params.title,
        inheritedContextSummary: params.inheritedContextSummary,
      });
      return result.branch
        ? { status: 200, body: result }
        : { status: 400, body: { error: result.result, session: result.session } };
    }

    if (segments.length === 5 && segments[4] === "select" && route.method === "POST") {
      const branchId = segments[3];
      const result = await this.coworkService.selectBranch({ traceId, sessionId, branchId });
      return result.branch
        ? { status: 200, body: result }
        : { status: 404, body: { error: result.result, session: result.session } };
    }

    if (segments.length === 4 && segments[3] === "select" && route.method === "POST") {
      const branchId = stringParam(body, "branchId", "branch_id");
      if (!branchId) {
        return { status: 400, body: { error: "branch_id is required" } };
      }
      const result = await this.coworkService.selectBranch({ traceId, sessionId, branchId });
      return result.branch
        ? { status: 200, body: result }
        : { status: 404, body: { error: result.result, session: result.session } };
    }

    if (segments.length === 6 && segments[4] === "result" && segments[5] === "select-final" && route.method === "POST") {
      const result = await this.coworkService.selectSessionFinalResult({
        traceId,
        sessionId,
        branchId: segments[3],
        resultId: stringParam(body, "resultId", "result_id"),
      });
      return result.finalResult
        ? { status: 200, body: result }
        : { status: 400, body: { error: result.result, session: result.session } };
    }

    return unsupportedCoworkRoute(route);
  }

  private async handleCoworkListSessionsRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = isJsonObject(request.params) ? request.params : {};
      const sessions = await this.coworkService.listSessions(request.trace_id, {
        includeCompleted: booleanParam(params, "includeCompleted", "include_completed") === true,
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { sessions },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetSessionRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_session");
      const session = await this.coworkService.getSession(sessionId, request.trace_id);
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { session },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkCreateSessionRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkCreateSessionParams(request.params);
      if (params.blueprint !== undefined) {
        const result = await this.coworkService.createSessionFromBlueprint({
          traceId: request.trace_id,
          blueprint: params.blueprint,
          runtimeState: params.runtimeState,
        });
        return {
          protocol_version: WORKER_PROTOCOL_VERSION,
          id: request.id,
          trace_id: request.trace_id,
          result,
        };
      }
      const session = await this.coworkService.createSession({
        traceId: request.trace_id,
        goal: params.goal,
        title: params.title,
        workflowMode: params.workflowMode,
        agents: params.agents,
        tasks: params.tasks,
        budgets: params.budgets,
        runtimeState: params.runtimeState,
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { session },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkDeleteSessionRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.delete_session");
      const deleted = await this.coworkService.deleteSession(sessionId, request.trace_id);
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { deleted },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkSendMessageRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkSendMessageParams(request.params);
      const result = await this.coworkService.sendMessage({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        senderId: params.senderId,
        recipientIds: params.recipientIds,
        content: params.content,
        threadId: params.threadId,
        wakeRecipients: params.wakeRecipients,
      });
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

  private async handleCoworkAddTaskRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkAddTaskParams(request.params);
      const result = await this.coworkService.addTask({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        title: params.title,
        description: params.description,
        assignedAgentId: params.assignedAgentId,
        dependencies: params.dependencies,
        priority: params.priority,
        expectedOutput: params.expectedOutput,
        reviewRequired: params.reviewRequired,
        reviewerAgentIds: params.reviewerAgentIds,
        fanoutGroupId: params.fanoutGroupId,
        mergeTaskId: params.mergeTaskId,
      });
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

  private async handleCoworkAssignTaskRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkAssignTaskParams(request.params);
      const result = await this.coworkService.assignTask({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        taskId: params.taskId,
        agentId: params.agentId,
      });
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

  private async handleCoworkRetryTaskRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkTaskMutationParams(request.params, "cowork.retry_task");
      const result = await this.coworkService.retryTask({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        taskId: params.taskId,
      });
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

  private async handleCoworkRequestTaskReviewRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkTaskMutationParams(request.params, "cowork.request_task_review");
      const result = await this.coworkService.requestTaskReview({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        taskId: params.taskId,
        reviewerAgentId: params.reviewerAgentId,
      });
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

  private async handleCoworkRetryWorkUnitRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkWorkUnitActionParams(request.params, "cowork.retry_work_unit");
      const result = await this.coworkService.retryWorkUnit({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        workUnitId: params.workUnitId,
        reason: params.reason,
      });
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

  private async handleCoworkSkipWorkUnitRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkWorkUnitActionParams(request.params, "cowork.skip_work_unit");
      const result = await this.coworkService.skipWorkUnit({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        workUnitId: params.workUnitId,
        reason: params.reason,
      });
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

  private async handleCoworkCancelWorkUnitRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkWorkUnitActionParams(request.params, "cowork.cancel_work_unit");
      const result = await this.coworkService.cancelWorkUnit({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        workUnitId: params.workUnitId,
        reason: params.reason,
      });
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

  private async handleCoworkPauseSessionRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.pause_session");
      const result = await this.coworkService.pauseSession({ traceId: request.trace_id, sessionId });
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

  private async handleCoworkResumeSessionRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.resume_session");
      const result = await this.coworkService.resumeSession({ traceId: request.trace_id, sessionId });
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

  private async handleCoworkEmergencyStopSessionRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkEmergencyStopParams(request.params);
      const result = await this.coworkService.emergencyStopSession({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        reason: params.reason,
      });
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

  private async handleCoworkRunSessionRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkScheduler) {
      return this.failure(request, "cowork scheduler is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkRunSessionParams(request.params);
      const result = await this.coworkScheduler.runSession({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        maxRounds: params.maxRounds,
        maxAgents: params.maxAgents,
        maxAgentCalls: params.maxAgentCalls,
        runUntilIdle: params.runUntilIdle,
        stopOnBlocker: params.stopOnBlocker,
      });
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

  private async handleCoworkUpdateBudgetRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkUpdateBudgetParams(request.params);
      const result = await this.coworkService.updateBudget({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        budgets: params.budgets,
      });
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

  private async handleCoworkSelectBranchRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkBranchParams(request.params, "cowork.select_branch");
      const result = await this.coworkService.selectBranch({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        branchId: params.branchId,
      });
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

  private async handleCoworkDeriveBranchRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkDeriveBranchParams(request.params);
      const result = await this.coworkService.deriveBranch({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        sourceBranchId: params.sourceBranchId,
        targetArchitecture: params.targetArchitecture,
        reason: params.reason,
        title: params.title,
        inheritedContextSummary: params.inheritedContextSummary,
      });
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

  private async handleCoworkSelectBranchResultRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkSelectBranchResultParams(request.params);
      const result = await this.coworkService.selectSessionFinalResult({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        branchId: params.branchId,
        resultId: params.resultId,
      });
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

  private async handleCoworkMergeBranchResultsRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkMergeBranchResultsParams(request.params);
      const result = await this.coworkService.mergeBranchResults({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        branchIds: params.branchIds,
        summary: params.summary,
      });
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

  private async handleCoworkDeliverEnvelopeRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkDeliverEnvelopeParams(request.params);
      const result = await this.coworkService.deliverEnvelope({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        envelope: params.envelope,
      });
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

  private async handleCoworkMarkMessagesReadRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkMailboxAgentParams(request.params, "cowork.mark_messages_read");
      const result = await this.coworkService.markMailboxMessagesRead({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        agentId: params.agentId,
      });
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

  private async handleCoworkExpireMailboxRecordsRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.expire_mailbox_records");
      const result = await this.coworkService.expireMailboxRecords({
        traceId: request.trace_id,
        sessionId,
      });
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

  private async handleCoworkEscalateStaleBlockersRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.escalate_stale_blockers");
      const result = await this.coworkService.escalateStaleBlockers({
        traceId: request.trace_id,
        sessionId,
      });
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

  private async handleCoworkExportBlueprintRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.export_blueprint");
      const blueprint = await this.coworkService.exportBlueprint({ traceId: request.trace_id, sessionId });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { blueprint },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetGraphRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_graph");
      const graph = await this.coworkService.getGraph({ traceId: request.trace_id, sessionId });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { graph },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetTraceRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_trace");
      const result = await this.coworkService.getTrace({ traceId: request.trace_id, sessionId });
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

  private async handleCoworkGetSummaryRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_summary");
      const summary = await this.coworkService.getSummary({ traceId: request.trace_id, sessionId });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { summary },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetDagRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_dag");
      const taskDag = await this.coworkService.getTaskDag({ traceId: request.trace_id, sessionId });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { task_dag: taskDag },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetArtifactsRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_artifacts");
      const artifacts = await this.coworkService.getArtifacts({ traceId: request.trace_id, sessionId });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { artifacts },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetOrganizationRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_organization");
      const organization = await this.coworkService.getOrganization({ traceId: request.trace_id, sessionId });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { organization },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetQueuesRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const sessionId = parseRequiredSessionId(request.params, "cowork.get_queues");
      const queues = await this.coworkService.getQueues({ traceId: request.trace_id, sessionId });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { queues },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetAgentActivityRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkAgentActivityParams(request.params);
      const activity = await this.coworkService.getAgentActivity({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        agentId: params.agentId,
        limit: params.limit,
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { activity },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
  }

  private async handleCoworkGetObservationDetailRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (!this.coworkService) {
      return this.failure(request, "cowork service is unavailable", {}, "invalid_protocol");
    }
    try {
      const params = parseCoworkObservationDetailParams(request.params);
      const detail = await this.coworkService.getObservationDetail({
        traceId: request.trace_id,
        sessionId: params.sessionId,
        detailId: params.detailId,
        requesterAgentId: params.requesterAgentId,
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result: { detail },
      };
    } catch (error) {
      return this.failure(request, errorMessage(error), {}, "invalid_protocol");
    }
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

function parseCoworkBlueprintParams(
  params: Record<string, unknown> | undefined,
  method: string,
): { blueprint: unknown; policy?: Record<string, unknown>; defaultGoal: string } {
  if (!isJsonObject(params)) {
    throw new Error(`${method} requires object params`);
  }
  if (!("blueprint" in params)) {
    throw new Error(`${method} requires params.blueprint`);
  }
  return {
    blueprint: params.blueprint,
    policy: isJsonObject(params.policy) ? params.policy : undefined,
    defaultGoal: stringParam(params, "defaultGoal", "default_goal") ?? "",
  };
}

function parseCoworkRouteRequest(params: Record<string, unknown> | undefined): CoworkRouteRequest {
  if (!isJsonObject(params)) {
    throw new Error("cowork.route_request requires object params");
  }
  const method = stringParam(params, "method", "method")?.toUpperCase();
  const rawPath = stringParam(params, "path", "path");
  if (!method || !rawPath) {
    throw new Error("cowork.route_request requires params.method and params.path");
  }
  const url = new URL(rawPath, "http://worker.local");
  const query = new URLSearchParams(url.search);
  const rawQuery = params.query;
  if (isJsonObject(rawQuery)) {
    for (const [key, value] of Object.entries(rawQuery)) {
      if (value !== undefined && value !== null) {
        query.set(key, String(value));
      }
    }
  }
  return {
    method,
    path: `${url.pathname}${url.search}`,
    body: params.body,
    query,
  };
}

function coworkRouteSegments(path: string): string[] {
  const url = new URL(path, "http://worker.local");
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (segments[0] !== "api" || segments[1] !== "cowork") {
    return [];
  }
  return segments.slice(2);
}

function unsupportedCoworkRoute(route: CoworkRouteRequest): CoworkRouteResponse {
  return {
    status: 404,
    body: {
      error: "unsupported cowork route",
      method: route.method,
      path: route.path,
    },
  };
}

function branchSnapshots(session: CoworkSession): JsonObject[] {
  return Object.values(session.branches)
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .map((branch) => branchSnapshot(branch, branch.id === session.current_branch_id));
}

function branchSnapshot(branch: CoworkBranch, current: boolean): JsonObject {
  return {
    id: branch.id,
    title: branch.title,
    architecture: branch.architecture,
    status: branch.status,
    topology_reference: branch.topology_reference ?? {},
    source_branch_id: branch.source_branch_id,
    source_stage_record_id: branch.source_stage_record_id,
    derivation_event_id: branch.derivation_event_id,
    derivation_reason: branch.derivation_reason,
    inherited_context_summary: branch.inherited_context_summary,
    completion_decision: branch.completion_decision ?? {},
    runtime_state: branch.runtime_state ?? {},
    branch_result: branch.branch_result ?? {},
    created_at: branch.created_at,
    updated_at: branch.updated_at,
    current,
    derived: Boolean(branch.source_branch_id),
  };
}

function parseRequiredSessionId(params: Record<string, unknown> | undefined, method: string): string {
  if (!isJsonObject(params)) {
    throw new Error(`${method} requires object params`);
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error(`${method} requires params.session_id`);
  }
  return sessionId;
}

function parseCoworkCreateSessionParams(params: Record<string, unknown> | undefined): {
  blueprint?: unknown;
  goal: string;
  title?: string;
  workflowMode?: string;
  agents?: Record<string, unknown>[];
  tasks?: Record<string, unknown>[];
  budgets?: Record<string, unknown>;
  runtimeState?: Record<string, unknown>;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.create_session requires object params");
  }
  if (params.blueprint !== undefined && params.blueprint !== null) {
    return {
      blueprint: params.blueprint,
      goal: "",
      runtimeState: isJsonObject(params.runtimeState) ? params.runtimeState : isJsonObject(params.runtime_state) ? params.runtime_state : undefined,
    };
  }
  const goal = stringParam(params, "goal", "goal");
  if (!goal) {
    throw new Error("cowork.create_session requires params.goal or params.blueprint");
  }
  return {
    goal,
    title: stringParam(params, "title", "title"),
    workflowMode: stringParam(params, "workflowMode", "workflow_mode"),
    agents: objectArrayParam(params.agents),
    tasks: objectArrayParam(params.tasks),
    budgets: isJsonObject(params.budgets) ? params.budgets : isJsonObject(params.budget) ? params.budget : undefined,
    runtimeState: isJsonObject(params.runtimeState) ? params.runtimeState : isJsonObject(params.runtime_state) ? params.runtime_state : undefined,
  };
}

function parseCoworkSendMessageParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  senderId: string;
  recipientIds: string[];
  content: string;
  threadId?: string;
  wakeRecipients?: boolean;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.send_message requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const content = stringParam(params, "content", "content");
  if (!sessionId || !content) {
    throw new Error("cowork.send_message requires params.session_id and params.content");
  }
  return {
    sessionId,
    senderId: stringParam(params, "senderId", "sender_id") ?? "user",
    recipientIds: stringListParam(params, "recipientIds", "recipient_ids"),
    content,
    threadId: stringParam(params, "threadId", "thread_id"),
    wakeRecipients: booleanParam(params, "wakeRecipients", "wake_recipients"),
  };
}

function parseCoworkAddTaskParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  dependencies: string[];
  priority?: number;
  expectedOutput?: string;
  reviewRequired?: boolean;
  reviewerAgentIds: string[];
  fanoutGroupId?: string;
  mergeTaskId?: string;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.add_task requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const title = stringParam(params, "title", "title");
  if (!sessionId || !title) {
    throw new Error("cowork.add_task requires params.session_id and params.title");
  }
  return {
    sessionId,
    title,
    description: stringParam(params, "description", "description"),
    assignedAgentId: stringParam(params, "assignedAgentId", "assigned_agent_id"),
    dependencies: stringListParam(params, "dependencies", "dependencies"),
    priority: numberParam(params, "priority", "priority"),
    expectedOutput: stringParam(params, "expectedOutput", "expected_output"),
    reviewRequired: booleanParam(params, "reviewRequired", "review_required"),
    reviewerAgentIds: stringListParam(params, "reviewerAgentIds", "reviewer_agent_ids"),
    fanoutGroupId: stringParam(params, "fanoutGroupId", "fanout_group_id"),
    mergeTaskId: stringParam(params, "mergeTaskId", "merge_task_id"),
  };
}

function parseCoworkAssignTaskParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  taskId: string;
  agentId: string;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.assign_task requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const taskId = stringParam(params, "taskId", "task_id");
  const agentId = stringParam(params, "agentId", "agent_id") ?? stringParam(params, "assignedAgentId", "assigned_agent_id");
  if (!sessionId || !taskId || !agentId) {
    throw new Error("cowork.assign_task requires params.session_id, params.task_id, and params.assigned_agent_id");
  }
  return { sessionId, taskId, agentId };
}

function parseCoworkTaskMutationParams(params: Record<string, unknown> | undefined, method: string): {
  sessionId: string;
  taskId: string;
  reviewerAgentId?: string;
} {
  if (!isJsonObject(params)) {
    throw new Error(`${method} requires object params`);
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const taskId = stringParam(params, "taskId", "task_id");
  if (!sessionId || !taskId) {
    throw new Error(`${method} requires params.session_id and params.task_id`);
  }
  return {
    sessionId,
    taskId,
    reviewerAgentId: stringParam(params, "reviewerAgentId", "reviewer_agent_id"),
  };
}

function parseCoworkWorkUnitActionParams(params: Record<string, unknown> | undefined, method: string): {
  sessionId: string;
  workUnitId: string;
  reason?: string;
} {
  if (!isJsonObject(params)) {
    throw new Error(`${method} requires object params`);
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const workUnitId = stringParam(params, "workUnitId", "work_unit_id");
  if (!sessionId || !workUnitId) {
    throw new Error(`${method} requires params.session_id and params.work_unit_id`);
  }
  return {
    sessionId,
    workUnitId,
    reason: stringParam(params, "reason", "reason"),
  };
}

function parseCoworkEmergencyStopParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  reason?: string;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.emergency_stop_session requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error("cowork.emergency_stop_session requires params.session_id");
  }
  return {
    sessionId,
    reason: stringParam(params, "reason", "reason"),
  };
}

function parseCoworkRunSessionParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  maxRounds?: number;
  maxAgents?: number;
  maxAgentCalls?: number;
  runUntilIdle?: boolean;
  stopOnBlocker?: boolean;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.run_session requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error("cowork.run_session requires params.session_id");
  }
  return {
    sessionId,
    maxRounds: numberParam(params, "maxRounds", "max_rounds"),
    maxAgents: numberParam(params, "maxAgents", "max_agents"),
    maxAgentCalls: numberParam(params, "maxAgentCalls", "max_agent_calls"),
    runUntilIdle: booleanParam(params, "runUntilIdle", "run_until_idle"),
    stopOnBlocker: booleanParam(params, "stopOnBlocker", "stop_on_blocker"),
  };
}

function parseCoworkUpdateBudgetParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  budgets: Record<string, unknown>;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.update_budget requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const budgets = isJsonObject(params.budgets)
    ? params.budgets
    : isJsonObject(params.budget)
      ? params.budget
      : withoutSessionId(params);
  if (!sessionId) {
    throw new Error("cowork.update_budget requires params.session_id");
  }
  return { sessionId, budgets };
}

function parseCoworkBranchParams(params: Record<string, unknown> | undefined, method: string): {
  sessionId: string;
  branchId: string;
} {
  if (!isJsonObject(params)) {
    throw new Error(`${method} requires object params`);
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const branchId = stringParam(params, "branchId", "branch_id");
  if (!sessionId || !branchId) {
    throw new Error(`${method} requires params.session_id and params.branch_id`);
  }
  return { sessionId, branchId };
}

function parseCoworkDeriveBranchParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  sourceBranchId?: string;
  targetArchitecture?: string;
  reason?: string;
  title?: string;
  inheritedContextSummary?: string;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.derive_branch requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  if (!sessionId) {
    throw new Error("cowork.derive_branch requires params.session_id");
  }
  return {
    sessionId,
    sourceBranchId: stringParam(params, "sourceBranchId", "source_branch_id"),
    targetArchitecture: stringParam(params, "targetArchitecture", "target_architecture"),
    reason: stringParam(params, "reason", "reason"),
    title: stringParam(params, "title", "title"),
    inheritedContextSummary: stringParam(params, "inheritedContextSummary", "inherited_context_summary"),
  };
}

function parseCoworkSelectBranchResultParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  branchId: string;
  resultId?: string;
} {
  const parsed = parseCoworkBranchParams(params, "cowork.select_branch_result");
  return {
    ...parsed,
    resultId: isJsonObject(params) ? stringParam(params, "resultId", "result_id") : undefined,
  };
}

function parseCoworkMergeBranchResultsParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  branchIds: string[];
  summary?: string;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.merge_branch_results requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const branchIds = stringListParam(params, "branchIds", "branch_ids");
  if (!sessionId || branchIds.length === 0) {
    throw new Error("cowork.merge_branch_results requires params.session_id and params.branch_ids");
  }
  return {
    sessionId,
    branchIds,
    summary: stringParam(params, "summary", "summary"),
  };
}

function parseCoworkDeliverEnvelopeParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  envelope: CoworkEnvelope;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.deliver_envelope requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const rawEnvelope = params.envelope;
  if (!sessionId || !isJsonObject(rawEnvelope)) {
    throw new Error("cowork.deliver_envelope requires params.session_id and params.envelope");
  }
  const senderId = stringParam(rawEnvelope, "senderId", "sender_id");
  const content = stringParam(rawEnvelope, "content", "content");
  if (!senderId || !content) {
    throw new Error("cowork.deliver_envelope requires params.envelope.sender_id and params.envelope.content");
  }
  const envelope: CoworkEnvelope = {
    sender_id: senderId,
    content,
    recipient_ids: stringListParam(rawEnvelope, "recipientIds", "recipient_ids"),
    visibility: stringParam(rawEnvelope, "visibility", "visibility"),
    kind: stringParam(rawEnvelope, "kind", "kind"),
    topic: stringParam(rawEnvelope, "topic", "topic"),
    event_type: stringParam(rawEnvelope, "eventType", "event_type"),
    request_type: stringParam(rawEnvelope, "requestType", "request_type"),
    thread_id: stringParam(rawEnvelope, "threadId", "thread_id"),
    requires_reply: booleanParam(rawEnvelope, "requiresReply", "requires_reply"),
    priority: numberParam(rawEnvelope, "priority", "priority"),
    deadline_round: numberParam(rawEnvelope, "deadlineRound", "deadline_round"),
    correlation_id: stringParam(rawEnvelope, "correlationId", "correlation_id"),
    lineage_id: stringParam(rawEnvelope, "lineageId", "lineage_id"),
    reply_to_envelope_id: stringParam(rawEnvelope, "replyToEnvelopeId", "reply_to_envelope_id"),
    caused_by_envelope_id: stringParam(rawEnvelope, "causedByEnvelopeId", "caused_by_envelope_id"),
    expected_output_schema: isJsonObject(rawEnvelope.expectedOutputSchema)
      ? rawEnvelope.expectedOutputSchema
      : isJsonObject(rawEnvelope.expected_output_schema)
        ? rawEnvelope.expected_output_schema
        : undefined,
    blocking_task_id: stringParam(rawEnvelope, "blockingTaskId", "blocking_task_id"),
    escalate_after_rounds: numberParam(rawEnvelope, "escalateAfterRounds", "escalate_after_rounds"),
    wake_recipients: booleanParam(rawEnvelope, "wakeRecipients", "wake_recipients"),
    tool_call_id: stringParam(rawEnvelope, "toolCallId", "tool_call_id"),
    draft_id: stringParam(rawEnvelope, "draftId", "draft_id"),
  };
  return { sessionId, envelope };
}

function parseCoworkMailboxAgentParams(params: Record<string, unknown> | undefined, method: string): {
  sessionId: string;
  agentId: string;
} {
  if (!isJsonObject(params)) {
    throw new Error(`${method} requires object params`);
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const agentId = stringParam(params, "agentId", "agent_id");
  if (!sessionId || !agentId) {
    throw new Error(`${method} requires params.session_id and params.agent_id`);
  }
  return { sessionId, agentId };
}

function parseCoworkAgentActivityParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  agentId: string;
  limit?: number;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.get_agent_activity requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const agentId = stringParam(params, "agentId", "agent_id");
  if (!sessionId || !agentId) {
    throw new Error("cowork.get_agent_activity requires params.session_id and params.agent_id");
  }
  return {
    sessionId,
    agentId,
    limit: numberParam(params, "limit", "limit"),
  };
}

function parseCoworkObservationDetailParams(params: Record<string, unknown> | undefined): {
  sessionId: string;
  detailId: string;
  requesterAgentId?: string;
} {
  if (!isJsonObject(params)) {
    throw new Error("cowork.get_observation_detail requires object params");
  }
  const sessionId = stringParam(params, "sessionId", "session_id");
  const detailId = stringParam(params, "detailId", "detail_id");
  if (!sessionId || !detailId) {
    throw new Error("cowork.get_observation_detail requires params.session_id and params.detail_id");
  }
  return {
    sessionId,
    detailId,
    requesterAgentId: stringParam(params, "requesterAgentId", "requester_agent_id")
      ?? stringParam(params, "agentId", "agent_id"),
  };
}

function withoutSessionId(params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key !== "sessionId" && key !== "session_id") {
      result[key] = value;
    }
  }
  return result;
}

function objectArrayParam(value: unknown): Record<string, unknown>[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("cowork.create_session agents and tasks must be arrays when provided");
  }
  return value.map((item) => {
    if (!isJsonObject(item)) {
      throw new Error("cowork.create_session agents and tasks must contain objects");
    }
    return item;
  });
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
