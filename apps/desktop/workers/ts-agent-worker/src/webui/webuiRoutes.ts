import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import type { HeartbeatStatus } from "../heartbeat/heartbeatTypes.ts";
import type { McpRuntimeDiagnostics } from "../mcp/mcpRuntimeManager.ts";
import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../support/runtimeHelpers.ts";
import {
  areKnowledgeGraphPlansWithinJobBudget,
  buildKnowledgeGraphBatchEstimateBody,
  buildKnowledgeGraphExtractionProgress,
  buildKnowledgeGraphExtractionPlan,
  buildKnowledgeGraphSingleEstimateBody,
  findExistingKnowledgeGraphExtractionSkips,
  resolveKnowledgeGraphExtractionDocIds,
  runKnowledgeGraphExtractionPlan,
  runKnowledgeGraphExtractionPlans,
} from "../knowledge/knowledgeGraphExtraction.ts";

export type WebuiRouteSpec = {
  key: string;
  method: string;
  path: string;
  public: boolean;
};

export type WebuiRouteMigrationDiagnostic = {
  key: string;
  method: string;
  path: string;
  public: boolean;
  owner: "ts-worker";
  route_group:
    | "health"
    | "openai"
    | "knowledge"
    | "bootstrap"
    | "status"
    | "tools"
    | "config"
    | "providers"
    | "approvals"
    | "sessions"
    | "skills"
    | "agent-ui"
    | "workspace"
    | "cowork";
};

export type WebuiRouteRequest = {
  method: string;
  path: string;
  headers?: Record<string, unknown>;
  body?: unknown;
};

export type WebuiRouteResponse = {
  status: number;
  body: unknown;
};

export type WebuiStatusSnapshot = {
  channelRunning: boolean;
  heartbeat?: HeartbeatStatus | null;
  mcp?: McpRuntimeDiagnostics | null;
  provider: Record<string, unknown> | null;
  model: string | null;
};

export type WebuiStatusProvider =
  | WebuiStatusSnapshot
  | (() => Promise<WebuiStatusSnapshot> | WebuiStatusSnapshot);

export type WebuiBootstrapResponse = {
  token: string;
  ws_path: string;
  token_ttl_s: number;
  refresh_token_path: string;
  sessions_path: string;
  workspace_files_path: string;
  cowork_path: string;
};

export type WebuiBootstrapProvider = {
  bootstrap(traceId: string): Promise<WebuiBootstrapResponse> | WebuiBootstrapResponse;
  refreshToken?(
    token: string,
    traceId: string,
  ): Promise<{ token: string; token_ttl_s: number } | null> | { token: string; token_ttl_s: number } | null;
};

export type WebuiSessionMetadata = {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  extra: Record<string, unknown>;
};

export type WebuiSessionMessages = {
  sessionId: string;
  messages: Record<string, unknown>[];
};

export type WebuiSessionProfile = {
  sessionId: string;
  profile: Record<string, unknown>;
};

export type WebuiPatchSessionResult = {
  sessionId: string;
  metadata: Record<string, unknown>;
  updatedAt: string;
};

export type WebuiSessionTemporaryFiles = {
  sessionId: string;
  items: Record<string, unknown>[];
  cleared?: number;
};

export type WebuiTemporaryFileUpload = {
  name: string;
  fileType: string;
  content: string;
  sizeBytes: number;
};

export type WebuiClearSessionResult = {
  sessionId: string;
  messagesBefore: number;
  messagesAfter: number;
  checkpointCleared: boolean;
};

export type WebuiDeleteSessionResult = {
  sessionId: string;
  deleted: boolean;
};

export type WebuiSessionProvider = {
  channelName?: string;
  listSessions(traceId: string): Promise<WebuiSessionMetadata[]> | WebuiSessionMetadata[];
  getSessionMessages?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiSessionMessages | null> | WebuiSessionMessages | null;
  getTaskProgressCard?(
    planId: string,
    traceId: string,
  ): Promise<Record<string, unknown> | null> | Record<string, unknown> | null;
  getSessionProfile?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiSessionProfile | null> | WebuiSessionProfile | null;
  patchSessionMetadata?(
    sessionId: string,
    metadata: Record<string, unknown>,
    traceId: string,
  ): Promise<WebuiPatchSessionResult | null> | WebuiPatchSessionResult | null;
  listTemporaryFiles?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiSessionTemporaryFiles> | WebuiSessionTemporaryFiles;
  uploadTemporaryFile?(
    sessionId: string,
    upload: WebuiTemporaryFileUpload,
    traceId: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  clearTemporaryFiles?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiSessionTemporaryFiles> | WebuiSessionTemporaryFiles;
  clearSession?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiClearSessionResult> | WebuiClearSessionResult;
  deleteSession?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiDeleteSessionResult> | WebuiDeleteSessionResult;
};

export type WebuiApprovalProvider = {
  channelName?: string;
  listPendingApprovals?(
    sessionId: string,
    traceId: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
  resolveApproval?(
    params: WebuiApprovalResolution,
    traceId: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WebuiApprovalResolution = {
  sessionId: string;
  approvalId: string;
  approved: boolean;
  scope?: string;
};

export type WebuiProviderModelsRequest = {
  providerId?: string;
  profileName?: string;
  model?: string;
  apiKey?: string;
  apiBase?: string;
  manualModelIds: string[];
  refreshLive: boolean;
};

export type WebuiProviderModelsProvider = {
  listProviderModels(
    request: WebuiProviderModelsRequest,
    traceId: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WebuiConfigProvider = {
  getConfig(traceId: string): Promise<Record<string, unknown>> | Record<string, unknown>;
  patchConfig(
    body: Record<string, unknown>,
    traceId: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WebuiProvidersProvider = {
  listProviders(traceId: string): Promise<unknown> | unknown;
};

export type WebuiSkillsProvider = {
  listSkills(traceId: string): Promise<unknown> | unknown;
  getSkillDetail(name: string, traceId: string): Promise<unknown> | unknown;
  createSkill(body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  updateSkill(name: string, body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  deleteSkill(name: string, traceId: string): Promise<unknown> | unknown;
  validateSkill(name: string, traceId: string): Promise<unknown> | unknown;
};

export type WebuiAgentUiFormAction = "submitted" | "cancelled";

export type WebuiAgentUiFormRequest = {
  formId: string;
  sessionId: string;
  action: WebuiAgentUiFormAction;
  values: Record<string, unknown>;
  correlation: Record<string, unknown>;
};

export type WebuiAgentUiFormProvider = {
  continueForm(
    request: WebuiAgentUiFormRequest,
    traceId: string,
  ): Promise<Record<string, unknown>> | Record<string, unknown>;
};

export type WebuiWorkspaceFileEntry = {
  path: string;
  exists?: boolean;
  updatedAt?: string | null;
};

export type WebuiWorkspaceFileContent = {
  path: string;
  content: string;
  exists?: boolean;
  updatedAt?: string | null;
};

export type WebuiWorkspaceWriteResult = {
  path: string;
  updatedAt?: string | null;
};

export type WebuiWorkspaceProvider = {
  listFiles(traceId: string): Promise<WebuiWorkspaceFileEntry[]> | WebuiWorkspaceFileEntry[];
  readFile(path: string, traceId: string): Promise<WebuiWorkspaceFileContent | null> | WebuiWorkspaceFileContent | null;
  writeFile(
    path: string,
    contents: string,
    traceId: string,
    expectedUpdatedAt?: string | null,
  ): Promise<WebuiWorkspaceWriteResult> | WebuiWorkspaceWriteResult;
};

export type WebuiKnowledgeListRequest = {
  category?: string;
  limit?: number;
};

type KnowledgeRebuildType = "bm25" | "semantic" | "tree" | "all";

export type WebuiKnowledgeProvider = {
  listDocuments(
    request: WebuiKnowledgeListRequest,
    traceId: string,
  ): Promise<unknown> | unknown;
  addDocument(body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  startIndexJob?(docId: string, traceId: string): Promise<unknown> | unknown;
  getJob?(jobId: string, traceId: string): Promise<unknown> | unknown;
  rebuildIndex?(type: KnowledgeRebuildType, traceId: string): Promise<unknown> | unknown;
  graph?(request: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  saveEntityGraphExtraction?(body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  getDocument(docId: string, traceId: string): Promise<unknown> | unknown;
  deleteDocument(docId: string, traceId: string): Promise<unknown> | unknown;
  query(body: Record<string, unknown>, traceId: string): Promise<unknown> | unknown;
  stats(traceId: string): Promise<unknown> | unknown;
};

export type WebuiDiagnosticsLogger = (diagnostic: {
  stream: "stdout" | "stderr";
  line: string;
}) => void;

export type WebuiOpenAiChatRequest = {
  content: string;
  sessionKey: string;
  chatId: string;
  model: string;
  timeoutSeconds: number;
};

export type WebuiOpenAiCompatProvider = {
  completeChat(
    request: WebuiOpenAiChatRequest,
    traceId: string,
  ): Promise<string> | string;
};

export type WebuiCoworkRouteRequest = {
  method: string;
  path: string;
  headers?: Record<string, unknown>;
  body?: unknown;
};

export type WebuiCoworkProvider = {
  route(
    request: WebuiCoworkRouteRequest,
    traceId: string,
  ): Promise<WebuiRouteResponse> | WebuiRouteResponse;
};

export class WebuiOpenAiRequestTimeoutError extends Error {
  readonly timeoutSeconds: number;

  constructor(timeoutSeconds: number) {
    super(`Request timed out after ${formatOpenAiTimeoutSeconds(timeoutSeconds)}s`);
    this.name = "WebuiOpenAiRequestTimeoutError";
    this.timeoutSeconds = timeoutSeconds;
  }
}

const WEBUI_ROUTE_SPECS: WebuiRouteSpec[] = [
  { key: "health", method: "GET", path: "/health", public: true },
  { key: "openai_models", method: "GET", path: "/v1/models", public: true },
  { key: "openai_chat_completions", method: "POST", path: "/v1/chat/completions", public: true },
  { key: "knowledge_list_documents", method: "GET", path: "/v1/knowledge/documents", public: true },
  { key: "knowledge_add_document", method: "POST", path: "/v1/knowledge/documents", public: true },
  { key: "knowledge_upload_document", method: "POST", path: "/v1/knowledge/documents/upload", public: true },
  { key: "knowledge_get_document", method: "GET", path: "/v1/knowledge/documents/{doc_id}", public: true },
  { key: "knowledge_delete_document", method: "DELETE", path: "/v1/knowledge/documents/{doc_id}", public: true },
  { key: "knowledge_query", method: "POST", path: "/v1/knowledge/query", public: true },
  { key: "knowledge_stats", method: "GET", path: "/v1/knowledge/stats", public: true },
  { key: "knowledge_job", method: "GET", path: "/v1/knowledge/jobs/{job_id}", public: true },
  { key: "knowledge_rebuild_index", method: "POST", path: "/v1/knowledge/rebuild-index", public: true },
  { key: "knowledge_extract_graph", method: "POST", path: "/v1/knowledge/graph/extract", public: true },
  { key: "knowledge_graph", method: "GET", path: "/v1/knowledge/graph", public: true },
  { key: "knowledge_graphrag", method: "GET", path: "/v1/knowledge/graphrag", public: true },
  { key: "bootstrap", method: "GET", path: "/webui/bootstrap", public: true },
  { key: "refresh_token", method: "POST", path: "/webui/refresh-token", public: true },
  { key: "get_status", method: "GET", path: "/api/status", public: false },
  { key: "get_tools", method: "GET", path: "/api/tools", public: false },
  { key: "get_config", method: "GET", path: "/api/config", public: false },
  { key: "patch_config", method: "PATCH", path: "/api/config", public: false },
  { key: "providers", method: "GET", path: "/api/providers", public: false },
  { key: "provider_models", method: "POST", path: "/api/provider-models", public: false },
  { key: "get_approvals", method: "GET", path: "/api/approvals", public: false },
  { key: "approve_approval", method: "POST", path: "/api/approvals/{approval_id}/approve", public: false },
  { key: "deny_approval", method: "POST", path: "/api/approvals/{approval_id}/deny", public: false },
  { key: "list_sessions", method: "GET", path: "/api/sessions", public: false },
  { key: "get_messages", method: "GET", path: "/api/sessions/{key}/messages", public: false },
  { key: "get_profile", method: "GET", path: "/api/sessions/{key}/profile", public: false },
  { key: "patch_session", method: "PATCH", path: "/api/sessions/{key}", public: false },
  { key: "delete_session", method: "DELETE", path: "/api/sessions/{key}", public: false },
  { key: "clear_session", method: "POST", path: "/api/sessions/{key}/clear", public: false },
  { key: "list_temporary_files", method: "GET", path: "/api/sessions/{key}/temporary-files", public: false },
  { key: "upload_temporary_file", method: "POST", path: "/api/sessions/{key}/temporary-files", public: false },
  { key: "clear_temporary_files", method: "DELETE", path: "/api/sessions/{key}/temporary-files", public: false },
  { key: "get_skills", method: "GET", path: "/api/skills", public: false },
  { key: "create_skill", method: "POST", path: "/api/skills", public: false },
  { key: "get_skill_detail", method: "GET", path: "/api/skills/{name}", public: false },
  { key: "update_skill", method: "PATCH", path: "/api/skills/{name}", public: false },
  { key: "delete_skill", method: "DELETE", path: "/api/skills/{name}", public: false },
  { key: "validate_skill", method: "POST", path: "/api/skills/{name}/validate", public: false },
  { key: "submit_agent_ui_form", method: "POST", path: "/api/agent-ui/forms/{form_id}/submit", public: false },
  { key: "cancel_agent_ui_form", method: "POST", path: "/api/agent-ui/forms/{form_id}/cancel", public: false },
  { key: "list_workspace_files", method: "GET", path: "/api/workspace/files", public: false },
  { key: "get_workspace_file", method: "GET", path: "/api/workspace/files/{path:.+}", public: false },
  { key: "put_workspace_file", method: "PUT", path: "/api/workspace/files/{path:.+}", public: false },
  { key: "cowork_route", method: "GET", path: "/api/cowork/{path:.+}", public: false },
  { key: "cowork_route", method: "POST", path: "/api/cowork/{path:.+}", public: false },
  { key: "cowork_route", method: "PATCH", path: "/api/cowork/{path:.+}", public: false },
  { key: "cowork_route", method: "DELETE", path: "/api/cowork/{path:.+}", public: false },
];

export function webuiRouteSpecs(): WebuiRouteSpec[] {
  return WEBUI_ROUTE_SPECS.map((spec) => ({ ...spec }));
}

export function webuiRouteMigrationDiagnostics(): WebuiRouteMigrationDiagnostic[] {
  return WEBUI_ROUTE_SPECS.map((spec) => ({
    ...spec,
    owner: "ts-worker",
    route_group: webuiRouteGroup(spec),
  }));
}

function webuiRouteGroup(spec: WebuiRouteSpec): WebuiRouteMigrationDiagnostic["route_group"] {
  if (spec.path === "/health") {
    return "health";
  }
  if (spec.path.startsWith("/v1/knowledge/")) {
    return "knowledge";
  }
  if (spec.path.startsWith("/v1/")) {
    return "openai";
  }
  if (spec.path.startsWith("/webui/")) {
    return "bootstrap";
  }
  if (spec.path === "/api/status") {
    return "status";
  }
  if (spec.path === "/api/tools") {
    return "tools";
  }
  if (spec.path === "/api/config") {
    return "config";
  }
  if (spec.path === "/api/providers" || spec.path === "/api/provider-models") {
    return "providers";
  }
  if (spec.path.startsWith("/api/approvals")) {
    return "approvals";
  }
  if (spec.path.startsWith("/api/sessions")) {
    return "sessions";
  }
  if (spec.path.startsWith("/api/skills")) {
    return "skills";
  }
  if (spec.path.startsWith("/api/agent-ui/")) {
    return "agent-ui";
  }
  if (spec.path.startsWith("/api/workspace/")) {
    return "workspace";
  }
  return "cowork";
}

export async function handleWebuiRouteRequest(
  request: WebuiRouteRequest,
  statusProvider: WebuiStatusProvider | undefined,
  bootstrapProvider?: WebuiBootstrapProvider,
  sessionProvider?: WebuiSessionProvider,
  tools?: ToolRegistry,
  approvalProvider?: WebuiApprovalProvider,
  providerModelsProvider?: WebuiProviderModelsProvider,
  configProvider?: WebuiConfigProvider,
  providersProvider?: WebuiProvidersProvider,
  skillsProvider?: WebuiSkillsProvider,
  agentUiFormProvider?: WebuiAgentUiFormProvider,
  workspaceProvider?: WebuiWorkspaceProvider,
  openAiCompatProvider?: WebuiOpenAiCompatProvider,
  knowledgeProvider?: WebuiKnowledgeProvider,
  coworkProvider?: WebuiCoworkProvider,
  traceId = "webui-route",
  diagnosticsLogger?: WebuiDiagnosticsLogger,
): Promise<WebuiRouteResponse> {
  const method = request.method.toUpperCase();
  const url = new URL(request.path, "http://worker.local");
  const path = url.pathname;
  if (method === "GET" && path === "/health") {
    return { status: 200, body: { status: "ok" } };
  }
  if (method === "GET" && path === "/v1/models") {
    const config = configProvider ? await configProvider.getConfig(traceId) : {};
    return { status: 200, body: openAiModelsBody(config) };
  }
  if (method === "POST" && path === "/v1/chat/completions") {
    const config = configProvider ? await configProvider.getConfig(traceId) : {};
    return openAiChatCompletionsResponse(request.body, config, openAiCompatProvider, traceId);
  }
  if (method === "GET" && path === "/v1/knowledge/documents") {
    return knowledgeListDocumentsResponse(url.searchParams, knowledgeProvider, traceId, diagnosticsLogger);
  }
  if (method === "POST" && path === "/v1/knowledge/documents") {
    return knowledgeAddDocumentResponse(request.body, url.searchParams, knowledgeProvider, traceId, diagnosticsLogger);
  }
  if (method === "POST" && path === "/v1/knowledge/documents/upload") {
    const config = configProvider ? await configProvider.getConfig(traceId) : {};
    return knowledgeUploadDocumentResponse(request.body, url.searchParams, config, knowledgeProvider, openAiCompatProvider, traceId, diagnosticsLogger);
  }
  const knowledgeDocument = knowledgeDocumentPath(method, path);
  if (knowledgeDocument) {
    return knowledgeDocumentResponse(knowledgeDocument.docId, method, knowledgeProvider, traceId);
  }
  if (method === "POST" && path === "/v1/knowledge/query") {
    return knowledgeQueryResponse(request.body, knowledgeProvider, traceId, diagnosticsLogger);
  }
  if (method === "GET" && path === "/v1/knowledge/stats") {
    if (!knowledgeProvider) {
      return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
    }
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.stats.start");
    try {
      const body = knowledgeStatsBody(await knowledgeProvider.stats(traceId));
      logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.stats.complete", knowledgeStatsDiagnostic(body));
      return { status: 200, body };
    } catch (error) {
      logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.stats.failed", { error: errorMessage(error) });
      return knowledgeServerError("Error getting stats", error);
    }
  }
  const knowledgeJobId = knowledgeJobPath(method, path);
  if (knowledgeJobId !== undefined) {
    return knowledgeJobResponse(knowledgeJobId, knowledgeProvider, traceId);
  }
  if (method === "POST" && path === "/v1/knowledge/rebuild-index") {
    return knowledgeRebuildIndexResponse(url.searchParams, knowledgeProvider, traceId, diagnosticsLogger);
  }
  if (method === "POST" && path === "/v1/knowledge/graph/extract") {
    const config = configProvider ? await configProvider.getConfig(traceId) : {};
    return knowledgeGraphExtractResponse(request.body, config, knowledgeProvider, openAiCompatProvider, traceId, diagnosticsLogger);
  }
  if (method === "GET" && path === "/v1/knowledge/graph") {
    return knowledgeGraphResponse(url.searchParams, knowledgeProvider, traceId);
  }
  if (method === "GET" && path === "/v1/knowledge/graphrag") {
    return knowledgeGraphRagResponse(url.searchParams, knowledgeProvider, configProvider, traceId);
  }
  if (method === "GET" && path === "/webui/bootstrap") {
    if (!bootstrapProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "bootstrap" } };
    }
    return { status: 200, body: await bootstrapProvider.bootstrap(traceId) };
  }
  if (method === "POST" && path === "/webui/refresh-token") {
    return webuiRefreshTokenResponse(request.headers, bootstrapProvider, traceId);
  }
  if (method === "GET" && path === "/api/status") {
    return { status: 200, body: webuiStatusBody(await resolveStatus(statusProvider)) };
  }
  if (method === "GET" && path === "/api/tools") {
    return { status: 200, body: webuiToolsBody(tools) };
  }
  if (method === "GET" && path === "/api/config") {
    if (!configProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "get_config" } };
    }
    return { status: 200, body: await configProvider.getConfig(traceId) };
  }
  if (method === "PATCH" && path === "/api/config") {
    if (!configProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "patch_config" } };
    }
    if (!isJsonObject(request.body)) {
      return { status: 400, body: { error: "invalid config patch" } };
    }
    return { status: 200, body: await configProvider.patchConfig(request.body, traceId) };
  }
  if (method === "GET" && path === "/api/providers") {
    if (!providersProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "providers" } };
    }
    return { status: 200, body: await providersProvider.listProviders(traceId) };
  }
  if (method === "GET" && path === "/api/skills") {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "get_skills" } };
    }
    return webuiSkillRouteResponse(() => skillsProvider.listSkills(traceId));
  }
  if (method === "POST" && path === "/api/skills") {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "create_skill" } };
    }
    if (!isJsonObject(request.body)) {
      return { status: 400, body: { error: "invalid json body" } };
    }
    return webuiSkillRouteResponse(() => skillsProvider.createSkill(request.body as JsonObject, traceId));
  }
  const skillValidationName = skillValidatePath(method, path);
  if (skillValidationName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "validate_skill" } };
    }
    return webuiSkillRouteResponse(() => skillsProvider.validateSkill(skillValidationName, traceId));
  }
  const skillUpdateName = skillUpdatePath(method, path);
  if (skillUpdateName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "update_skill" } };
    }
    if (!isJsonObject(request.body)) {
      return { status: 400, body: { error: "invalid json body" } };
    }
    return webuiSkillRouteResponse(() => skillsProvider.updateSkill(skillUpdateName, request.body as JsonObject, traceId));
  }
  const skillDeleteName = skillDeletePath(method, path);
  if (skillDeleteName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "delete_skill" } };
    }
    return webuiSkillRouteResponse(() => skillsProvider.deleteSkill(skillDeleteName, traceId));
  }
  const skillName = skillDetailPath(method, path);
  if (skillName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "get_skill_detail" } };
    }
    return webuiSkillRouteResponse(() => skillsProvider.getSkillDetail(skillName, traceId));
  }
  if (method === "POST" && path === "/api/provider-models") {
    return webuiProviderModelsResponse(request.body, providerModelsProvider, traceId);
  }
  if (method === "GET" && path === "/api/approvals") {
    return webuiApprovalsResponse(url.searchParams, approvalProvider, traceId);
  }
  const approvalResolution = approvalResolutionPath(method, path);
  if (approvalResolution) {
    return webuiApprovalResolutionResponse(
      approvalResolution.approvalId,
      approvalResolution.approved,
      url.searchParams,
      request.body,
      approvalProvider,
      traceId,
    );
  }
  const agentUiFormAction = agentUiFormActionPath(method, path);
  if (agentUiFormAction) {
    return webuiAgentUiFormResponse(request.body, agentUiFormAction, agentUiFormProvider, traceId);
  }
  if (method === "GET" && path === "/api/workspace/files") {
    if (!workspaceProvider) {
      return { status: 404, body: { error: "workspace not available" } };
    }
    return { status: 200, body: webuiWorkspaceFileListBody(await workspaceProvider.listFiles(traceId)) };
  }
  const workspaceFilePath = workspaceFileRoutePath(method, path);
  if (workspaceFilePath !== undefined) {
    return webuiWorkspaceFileResponse(method, workspaceFilePath, request.body, workspaceProvider, traceId);
  }
  if (coworkRoutePath(method, path)) {
    if (!coworkProvider) {
      return { status: 503, body: { error: "cowork is not available" } };
    }
    return coworkProvider.route({
      method,
      path: `${path}${url.search}`,
      headers: request.headers,
      body: request.body,
    }, traceId);
  }
  if (method === "GET" && path === "/api/sessions") {
    if (!sessionProvider) {
      return { status: 503, body: { error: "session manager not available" } };
    }
    return {
      status: 200,
      body: webuiSessionListBody(await sessionProvider.listSessions(traceId), sessionProvider.channelName ?? "websocket"),
    };
  }
  const sessionMessagesKey = sessionMessagesPathKey(method, path);
  if (sessionMessagesKey !== undefined) {
    if (!sessionProvider?.getSessionMessages) {
      return { status: 503, body: { error: "session manager not available" } };
    }
    const session = await sessionProvider.getSessionMessages(sessionMessagesKey, traceId);
    if (!session) {
      return { status: 404, body: { error: "session not found" } };
    }
    return { status: 200, body: await webuiSessionMessagesBody(session, sessionProvider, traceId) };
  }
  const sessionProfileKey = sessionProfilePathKey(method, path);
  if (sessionProfileKey !== undefined) {
    if (!sessionProvider?.getSessionProfile) {
      return { status: 503, body: { error: "session manager not available" } };
    }
    const session = await sessionProvider.getSessionProfile(sessionProfileKey, traceId);
    if (!session) {
      return { status: 404, body: { error: "session not found" } };
    }
    return { status: 200, body: webuiSessionProfileBody(session) };
  }
  const patchSessionKey = patchSessionPathKey(method, path);
  if (patchSessionKey !== undefined) {
    if (!sessionProvider?.patchSessionMetadata) {
      return { status: 503, body: { error: "session manager not available" } };
    }
    if (!isJsonObject(request.body)) {
      return { status: 400, body: { error: "invalid json body" } };
    }
    const metadata = isJsonObject(request.body.metadata) ? request.body.metadata : {};
    const session = await sessionProvider.patchSessionMetadata(patchSessionKey, metadata, traceId);
    if (!session) {
      return { status: 404, body: { error: "session not found" } };
    }
    return { status: 200, body: webuiPatchSessionBody(session) };
  }
  const temporaryFilesKey = temporaryFilesPathKey(method, path);
  if (temporaryFilesKey !== undefined) {
    if (method === "POST") {
      return webuiTemporaryFileUploadResponse(temporaryFilesKey, request.body, sessionProvider, traceId);
    }
    if (method === "DELETE") {
      return webuiTemporaryFilesClearResponse(temporaryFilesKey, sessionProvider, traceId);
    }
    if (!sessionProvider?.listTemporaryFiles) {
      return { status: 200, body: { items: [] } };
    }
    return {
      status: 200,
      body: webuiTemporaryFilesBody(await sessionProvider.listTemporaryFiles(temporaryFilesKey, traceId)),
    };
  }
  const clearSessionKey = clearSessionPathKey(method, path);
  if (clearSessionKey !== undefined) {
    if (!sessionProvider?.clearSession) {
      return { status: 503, body: { error: "session manager not available" } };
    }
    return {
      status: 200,
      body: webuiClearSessionBody(await sessionProvider.clearSession(clearSessionKey, traceId)),
    };
  }
  const deleteSessionKey = deleteSessionPathKey(method, path);
  if (deleteSessionKey !== undefined) {
    if (!sessionProvider?.deleteSession) {
      return { status: 503, body: { error: "session manager not available" } };
    }
    const result = await sessionProvider.deleteSession(deleteSessionKey, traceId);
    if (!result.deleted) {
      return { status: 404, body: { error: "session not found" } };
    }
    return { status: 200, body: webuiDeleteSessionBody(result) };
  }
  return {
    status: 404,
    body: {
      error: "webui control route unavailable",
      route: routeKey(method, path),
    },
  };
}

async function webuiSkillRouteResponse(action: () => Promise<unknown> | unknown): Promise<WebuiRouteResponse> {
  try {
    const body = await action();
    if (body === null) {
      return { status: 404, body: { error: "skill not found" } };
    }
    return { status: 200, body };
  } catch (error) {
    const status = webuiSkillErrorStatus(error);
    return {
      status,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function webuiSkillErrorStatus(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      return status;
    }
  }
  return 500;
}

export function parseWebuiRouteRequest(params: JsonObject | undefined): WebuiRouteRequest {
  if (!isJsonObject(params)) {
    throw new Error("webui.handle_request requires object params");
  }
  const method = stringParam(params.method)?.toUpperCase();
  const path = stringParam(params.path);
  if (!method || !path) {
    throw new Error("webui.handle_request requires params.method and params.path");
  }
  const request: WebuiRouteRequest = { method, path };
  if (params.headers !== undefined && isJsonObject(params.headers)) {
    request.headers = params.headers;
  }
  if (params.body !== undefined) {
    request.body = params.body;
  }
  return request;
}

async function resolveStatus(provider: WebuiStatusProvider | undefined): Promise<WebuiStatusSnapshot> {
  if (!provider) {
    return { channelRunning: true, provider: null, model: null };
  }
  return typeof provider === "function" ? provider() : provider;
}

function webuiStatusBody(status: WebuiStatusSnapshot): Record<string, unknown> {
  return {
    channels: { websocket: { enabled: true, running: status.channelRunning } },
    ...(status.heartbeat ? { heartbeat: heartbeatStatusBody(status.heartbeat) } : {}),
    ...(status.mcp ? { mcp: status.mcp } : {}),
    provider: status.provider,
    model: status.model,
  };
}

function heartbeatStatusBody(status: HeartbeatStatus): Record<string, unknown> {
  return {
    enabled: status.enabled,
    running: status.running,
    executing: status.executing,
    interval_ms: status.intervalMs,
    last_result: status.lastResult,
    last_error: status.lastError,
  };
}

function openAiModelsBody(config: Record<string, unknown>): Record<string, unknown> {
  const model = openAiConfiguredModel(config);
  return {
    object: "list",
    data: [
      {
        id: model,
        object: "model",
        created: 0,
        owned_by: "tinybot",
      },
    ],
  };
}

function openAiConfiguredModel(config: Record<string, unknown>): string {
  const agents = isJsonObject(config.agents) ? config.agents : {};
  const defaults = isJsonObject(agents.defaults) ? agents.defaults : {};
  return stringParam(defaults.model) ?? stringParam(agents.model) ?? "tinybot";
}

async function openAiChatCompletionsResponse(
  body: unknown,
  config: Record<string, unknown>,
  openAiCompatProvider: WebuiOpenAiCompatProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!isJsonObject(body)) {
    return openAiError(400, "Invalid JSON body");
  }
  const parsed = parseOpenAiChatRequest(body, openAiConfiguredModel(config));
  if (!parsed.ok) {
    return openAiError(400, parsed.message);
  }
  if (!openAiCompatProvider) {
    return openAiError(503, "OpenAI-compatible runtime unavailable", "server_error");
  }
  try {
    const completionRequest: WebuiOpenAiChatRequest = {
      content: parsed.content,
      sessionKey: parsed.sessionKey,
      chatId: "default",
      model: parsed.model,
      timeoutSeconds: openAiRequestTimeoutSeconds(config),
    };
    let content = await openAiCompatProvider.completeChat(completionRequest, traceId);
    if (content.trim().length === 0) {
      content = await openAiCompatProvider.completeChat(completionRequest, traceId);
      if (content.trim().length === 0) {
        content = EMPTY_FINAL_RESPONSE_MESSAGE;
      }
    }
    return { status: 200, body: openAiChatCompletionBody(content, parsed.model) };
  } catch (error) {
    if (error instanceof WebuiOpenAiRequestTimeoutError) {
      return openAiError(504, error.message);
    }
    return openAiError(500, "Internal server error", "server_error");
  }
}

function parseOpenAiChatRequest(
  body: JsonObject,
  configuredModel: string,
): { ok: true; content: string; sessionKey: string; model: string } | { ok: false; message: string } {
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  if (!messages || messages.length !== 1) {
    return { ok: false, message: "Only a single user message is supported" };
  }
  if (pythonTruthy(body.stream)) {
    return { ok: false, message: "stream=true is not supported yet. Set stream=false or omit it." };
  }
  if (!isJsonObject(messages[0]) || messages[0].role !== "user") {
    return { ok: false, message: "Only a single user message is supported" };
  }
  const requestedModel = pythonTruthy(body.model) ? pythonFormatString(body.model) : undefined;
  if (requestedModel && requestedModel !== configuredModel) {
    return { ok: false, message: `Only configured model '${configuredModel}' is available` };
  }
  const content = openAiMessageContent(messages[0].content);
  const sessionId = pythonTruthy(body.session_id) ? pythonFormatString(body.session_id) : undefined;
  return {
    ok: true,
    content,
    sessionKey: sessionId ? `api:${sessionId}` : "api:default",
    model: configuredModel,
  };
}

function openAiMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => isJsonObject(part) && part.type === "text" ? stringParam(part.text) ?? "" : undefined)
      .filter((text): text is string => text !== undefined)
      .join(" ");
  }
  return "";
}

function pythonFormatString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return pythonRepr(value);
}

function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "string") {
    return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(pythonRepr).join(", ")}]`;
  }
  if (isJsonObject(value)) {
    return `{${Object.entries(value).map(([key, item]) => `${pythonRepr(key)}: ${pythonRepr(item)}`).join(", ")}}`;
  }
  return String(value);
}

function pythonTruthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length > 0;
  }
  return true;
}

function openAiRequestTimeoutSeconds(config: Record<string, unknown>): number {
  const api = isJsonObject(config.api) ? config.api : {};
  const timeout = typeof api.timeout === "number" && Number.isFinite(api.timeout) && api.timeout > 0
    ? api.timeout
    : 120.0;
  return timeout;
}

function formatOpenAiTimeoutSeconds(timeoutSeconds: number): string {
  return Number.isInteger(timeoutSeconds) ? timeoutSeconds.toFixed(1) : String(timeoutSeconds);
}

function openAiChatCompletionBody(content: string, model: string): Record<string, unknown> {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function openAiError(
  status: number,
  message: string,
  type = "invalid_request_error",
): WebuiRouteResponse {
  return {
    status,
    body: {
      error: {
        message,
        type,
        code: status,
      },
    },
  };
}

function webuiToolsBody(tools: ToolRegistry | undefined): Record<string, unknown> {
  return {
    tools: (tools?.toolNames ?? [])
      .map((name) => {
        const tool = tools?.get(name);
        return tool ? { name, description: (tool.description || "").slice(0, 200) } : undefined;
      })
      .filter((tool): tool is { name: string; description: string } => tool !== undefined),
  };
}

async function webuiRefreshTokenResponse(
  headers: Record<string, unknown> | undefined,
  bootstrapProvider: WebuiBootstrapProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!bootstrapProvider?.refreshToken) {
    return { status: 503, body: { error: "webui control route unavailable", route: "refresh_token" } };
  }
  const refreshed = await bootstrapProvider.refreshToken(bearerToken(headers) ?? "", traceId);
  if (!refreshed) {
    return { status: 401, body: { error: "unauthorized" } };
  }
  return { status: 200, body: refreshed };
}

function bearerToken(headers: Record<string, unknown> | undefined): string | undefined {
  const header = stringValue(headers?.Authorization) ?? stringValue(headers?.authorization);
  const match = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return match?.[1] ? match[1] : undefined;
}

async function webuiProviderModelsResponse(
  body: unknown,
  providerModelsProvider: WebuiProviderModelsProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (body === undefined) {
    return { status: 400, body: { ok: false, error: "invalid json body" } };
  }
  if (!isJsonObject(body)) {
    return { status: 400, body: { ok: false, error: "payload must be a dict" } };
  }
  const payload = body;
  const providerId = stringValue(payload.provider) ?? stringValue(payload.providerId) ?? stringValue(payload.provider_id);
  const profileName = stringValue(payload.profile) ?? stringValue(payload.profileName) ?? stringValue(payload.profile_id);
  if (!providerId && !profileName) {
    return { status: 200, body: { ok: false, error: "provider is required" } };
  }
  if (!providerModelsProvider) {
    return { status: 200, body: { ok: false, error: "config is required" } };
  }
  try {
    const result = await providerModelsProvider.listProviderModels(
      {
        ...(providerId ? { providerId: providerId.trim().toLowerCase() } : {}),
        ...(profileName ? { profileName: profileName.trim() } : {}),
        ...(stringValue(payload.model) ? { model: stringValue(payload.model) } : {}),
        ...(stringValue(payload.apiKey ?? payload.api_key) ? { apiKey: stringValue(payload.apiKey ?? payload.api_key) } : {}),
        ...(stringValue(payload.apiBase ?? payload.api_base) ? { apiBase: stringValue(payload.apiBase ?? payload.api_base) } : {}),
        manualModelIds: manualModelIdsFromPayload(payload),
        refreshLive: Boolean(payload.refresh ?? payload.refresh_live ?? payload.refreshLive),
      },
      traceId,
    );
    return { status: 200, body: webuiProviderModelsBody(result) };
  } catch (error) {
    return { status: 200, body: { ok: false, error: error instanceof Error ? error.message : "no models available" } };
  }
}

function webuiProviderModelsBody(result: Record<string, unknown>): Record<string, unknown> {
  const models = Array.isArray(result.models) ? result.models.filter((model): model is string => typeof model === "string") : [];
  const warning = result.warning ?? null;
  if (result.ok === false) {
    return {
      ok: false,
      error: stringValue(result.error) ?? stringValue(warning) ?? "no models available",
      models: [],
      sources: isJsonObject(result.sources) ? result.sources : isJsonObject(result.sourceCounts) ? result.sourceCounts : {},
      warning,
      url: result.url ?? null,
    };
  }
  return {
    ok: true,
    models,
    model_sources: isJsonObject(result.model_sources)
      ? result.model_sources
      : isJsonObject(result.modelSources)
        ? result.modelSources
        : {},
    sources: isJsonObject(result.sources)
      ? result.sources
      : isJsonObject(result.sourceCounts)
        ? result.sourceCounts
        : {},
    warning,
    url: result.url ?? null,
  };
}

function manualModelIdsFromPayload(payload: Record<string, unknown>): string[] {
  const raw = payload.manual_models ?? payload.manualModels ?? payload.manualModelIds;
  if (typeof raw === "string") {
    return raw.replace(/\n/g, ",").split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item).trim()).filter(Boolean);
  }
  return [];
}

async function knowledgeListDocumentsResponse(
  query: URLSearchParams,
  provider: WebuiKnowledgeProvider | undefined,
  traceId: string,
  diagnosticsLogger?: WebuiDiagnosticsLogger,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  const request: WebuiKnowledgeListRequest = {};
  const category = query.get("category");
  if (category) {
    request.category = category;
  }
  const limitParam = query.get("limit");
  const limit = limitParam === null ? 20 : integerFromString(limitParam);
  if (limit !== undefined) {
    request.limit = limit;
  }
  logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.list_documents.start", request);
  try {
    const result = await provider.listDocuments(request, traceId);
    const documents = arrayFromResult(result, "documents");
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.list_documents.complete", {
      total: documents.length,
      category: request.category ?? "",
      limit: request.limit ?? 20,
    });
    return {
      status: 200,
      body: {
        object: "list",
        data: documents.map(knowledgeDocumentSummary),
        total: documents.length,
      },
    };
  } catch (error) {
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.list_documents.failed", { error: errorMessage(error) });
    return knowledgeServerError("Error listing documents", error);
  }
}

async function knowledgeAddDocumentResponse(
  body: unknown,
  query: URLSearchParams,
  provider: WebuiKnowledgeProvider | undefined,
  traceId: string,
  diagnosticsLogger?: WebuiDiagnosticsLogger,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  if (!isJsonObject(body)) {
    return { status: 400, body: knowledgeApiError(400, "Invalid JSON body") };
  }
  const name = stringValue(body.name);
  const content = stringValue(body.content);
  if (!name) {
    return { status: 400, body: knowledgeApiError(400, "Document name is required") };
  }
  if (!content) {
    return { status: 400, body: knowledgeApiError(400, "Document content is required") };
  }
  if (!content.trim()) {
    return { status: 400, body: knowledgeApiError(400, "Document content cannot be empty") };
  }
  const providerBody = knowledgeAddDocumentProviderBody(body);
  const asyncIndex = booleanQuery(query.get("async_index")) || body.async_index === true;
  logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.add_document.start", {
    name,
    file_type: stringValue(providerBody.file_type) ?? "txt",
    async_index: asyncIndex,
    content_chars: content.length,
  });
  try {
    const result = await provider.addDocument(providerBody, traceId);
    const document = documentFromResult(result);
    const id = stringValue(document?.id) ?? "";
    const resultName = stringValue(document?.name) ?? name;
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.add_document.complete", {
      id,
      name: resultName,
      chunk_count: numberValue(document?.chunk_count ?? document?.chunks) ?? 0,
      async_index: asyncIndex,
    });
    const responseBody: Record<string, unknown> = {
      id,
      name: resultName,
      message: asyncIndex
        ? `Document '${resultName}' saved; knowledge indexing is running`
        : `Document '${resultName}' added successfully`,
    };
    if (asyncIndex) {
      const job = await knowledgeStartIndexJob(provider, id, traceId)
        ?? completedKnowledgeUploadJob(id, resultName, numberValue(document?.chunk_count ?? document?.chunks) ?? 1);
      responseBody.job = job;
      responseBody.job_id = job.id;
    }
    return {
      status: asyncIndex ? 202 : 200,
      body: responseBody,
    };
  } catch (error) {
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.add_document.failed", {
      name,
      error: errorMessage(error),
    });
    return knowledgeValueError(error) ?? knowledgeServerError("Error adding document", error);
  }
}

function knowledgeAddDocumentProviderBody(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    tags: hasOwn(body, "tags") ? body.tags : [],
    category: hasOwn(body, "category") ? body.category : "",
    file_type: hasOwn(body, "file_type") ? body.file_type : "txt",
  };
}

async function knowledgeUploadDocumentResponse(
  body: unknown,
  query: URLSearchParams,
  config: Record<string, unknown>,
  provider: WebuiKnowledgeProvider | undefined,
  openAiCompatProvider: WebuiOpenAiCompatProvider | undefined,
  traceId: string,
  diagnosticsLogger?: WebuiDiagnosticsLogger,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  if (!isJsonObject(body)) {
    return { status: 400, body: knowledgeApiError(400, "No file uploaded") };
  }
  const name = stringValue(body.name) ?? stringValue(body.filename);
  const content = stringValue(body.content);
  if (!name || content === undefined) {
    return { status: 400, body: knowledgeApiError(400, "No file uploaded") };
  }
  const fileType = canonicalTextFileType(stringValue(body.file_type) ?? stringValue(body.fileType) ?? extensionFromName(name));
  if (!isTextLikeKnowledgeUploadType(fileType)) {
    return { status: 400, body: knowledgeApiError(400, `Unsupported file type '${fileType}'. Supported: csv, json, md, txt`) };
  }
  if (!content.trim()) {
    return { status: 400, body: knowledgeApiError(400, "File content is empty") };
  }
  const uploadBody: Record<string, unknown> = {
    name,
    content,
    file_type: fileType,
    source: "file_upload",
    category: stringValue(body.category) ?? "",
    tags: knowledgeTags(body.tags),
  };
  const sizeBytes = numberValue(body.size_bytes) ?? numberValue(body.sizeBytes) ?? new TextEncoder().encode(content).length;
  const asyncIndex = booleanQuery(query.get("async_index"));
  logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.upload_document.start", {
    name,
    file_type: fileType,
    size_bytes: sizeBytes,
    async_index: asyncIndex,
  });
  try {
    const result = await provider.addDocument(uploadBody, traceId);
    const document = documentFromResult(result);
    const id = stringValue(document?.id) ?? "";
    const resultName = stringValue(document?.name) ?? name;
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.upload_document.complete", {
      id,
      name: resultName,
      file_type: fileType,
      size_bytes: sizeBytes,
      chunk_count: numberValue(document?.chunk_count ?? document?.chunks) ?? 0,
      async_index: asyncIndex,
    });
    const responseBody: Record<string, unknown> = {
      id,
      name: resultName,
      file_type: fileType,
      size_bytes: sizeBytes,
      message: asyncIndex
        ? `File '${resultName}' uploaded; knowledge indexing is running`
        : `File '${resultName}' uploaded and indexed successfully`,
    };
    if (asyncIndex) {
      const job = await knowledgeStartIndexJob(provider, id, traceId)
        ?? completedKnowledgeUploadJob(id, resultName, numberValue(document?.chunk_count ?? document?.chunks) ?? 1);
      responseBody.job = job;
      responseBody.job_id = job.id;
    }
    if (id && knowledgeGraphAutoExtractEnabled(config)) {
      const extractionResponse = await knowledgeGraphExtractResponse(
        { doc_id: id },
        config,
        provider,
        openAiCompatProvider,
        traceId,
        diagnosticsLogger,
      );
      const extractionBody = asObject(extractionResponse.body);
      const extractionJob = asObject(extractionBody?.job);
      if (extractionResponse.status === 202 && extractionJob) {
        responseBody.graph_extraction_job = extractionJob;
        responseBody.graph_extraction_job_id = extractionJob.id;
      } else {
        responseBody.graph_extraction_error = extractionBody?.error ?? extractionResponse.body;
      }
    }
    return {
      status: asyncIndex ? 202 : 200,
      body: responseBody,
    };
  } catch (error) {
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.upload_document.failed", {
      name,
      file_type: fileType,
      error: errorMessage(error),
    });
    return knowledgeValueError(error) ?? knowledgeServerError("Error uploading file", error);
  }
}

async function knowledgeDocumentResponse(
  docId: string,
  method: string,
  provider: WebuiKnowledgeProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  try {
    if (method === "DELETE") {
      const result = asObject(await provider.deleteDocument(docId, traceId));
      if (result?.deleted !== true) {
        return { status: 404, body: knowledgeApiError(404, `Document ${docId} not found`) };
      }
      return { status: 200, body: { id: docId, message: `Document ${docId} deleted successfully` } };
    }
    const result = await provider.getDocument(docId, traceId);
    const document = documentFromResult(result);
    if (!document) {
      return { status: 404, body: knowledgeApiError(404, `Document ${docId} not found`) };
    }
    return {
      status: 200,
      body: {
        ...knowledgeDocumentSummary(document),
        content: stringValue(asObject(result)?.content) ?? stringValue(document.content) ?? "",
      },
    };
  } catch (error) {
    return knowledgeServerError(method === "DELETE" ? "Error deleting document" : "Error getting document", error);
  }
}

async function knowledgeJobResponse(
  jobId: string,
  provider: WebuiKnowledgeProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  if (provider.getJob) {
    try {
      const job = asObject(await provider.getJob(jobId, traceId));
      if (!job) {
        return { status: 404, body: knowledgeApiError(404, `Knowledge job ${jobId} not found`) };
      }
      return { status: 200, body: job };
    } catch (error) {
      if (errorMessage(error).toLowerCase().includes("not found")) {
        return { status: 404, body: knowledgeApiError(404, `Knowledge job ${jobId} not found`) };
      }
      return knowledgeServerError("Error getting knowledge job", error);
    }
  }
  if (jobId === "kjob_rebuild_bm25") {
    try {
      const stats = knowledgeStatsBody(await provider.stats(traceId));
      return { status: 200, body: completedKnowledgeBm25RebuildJob(stats, knowledgeBm25RebuildResult(stats)) };
    } catch (error) {
      return knowledgeServerError("Error getting knowledge job", error);
    }
  }
  if (jobId === "kjob_rebuild_all") {
    try {
      const stats = knowledgeStatsBody(await provider.stats(traceId));
      return { status: 200, body: completedKnowledgeAllRebuildJob(stats, knowledgeAllRebuildResult(stats)) };
    } catch (error) {
      return knowledgeServerError("Error getting knowledge job", error);
    }
  }
  if (jobId === "kjob_rebuild_semantic") {
    try {
      const stats = knowledgeStatsBody(await provider.stats(traceId));
      return { status: 200, body: completedKnowledgeSemanticRebuildJob(stats) };
    } catch (error) {
      return knowledgeServerError("Error getting knowledge job", error);
    }
  }
  if (jobId === "kjob_rebuild_tree") {
    try {
      const stats = knowledgeStatsBody(await provider.stats(traceId));
      return { status: 200, body: completedKnowledgeTreeRebuildJob(stats, knowledgeTreeRebuildResult(stats)) };
    } catch (error) {
      return knowledgeServerError("Error getting knowledge job", error);
    }
  }
  const docId = knowledgeUploadJobDocumentId(jobId);
  if (!docId) {
    return { status: 404, body: knowledgeApiError(404, `Knowledge job ${jobId} not found`) };
  }
  try {
    const result = await provider.getDocument(docId, traceId);
    const document = documentFromResult(result);
    if (!document) {
      return { status: 404, body: knowledgeApiError(404, `Knowledge job ${jobId} not found`) };
    }
    const name = stringValue(document.name) ?? docId;
    return { status: 200, body: completedKnowledgeUploadJob(docId, name, numberValue(document.chunk_count ?? document.chunks) ?? 1) };
  } catch (error) {
    return knowledgeServerError("Error getting knowledge job", error);
  }
}

async function knowledgeRebuildIndexResponse(
  query: URLSearchParams,
  provider: WebuiKnowledgeProvider | undefined,
  traceId: string,
  diagnosticsLogger?: WebuiDiagnosticsLogger,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  const rebuildTypeRaw = query.get("type") ?? "bm25";
  if (!isKnowledgeRebuildType(rebuildTypeRaw)) {
    return {
      status: 400,
      body: knowledgeApiError(400, `Invalid rebuild type '${rebuildTypeRaw}'. Valid options: bm25, semantic, tree, all`),
    };
  }
  const rebuildType = rebuildTypeRaw;

  const asyncIndex = booleanQuery(query.get("async_index"));
  logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.rebuild_index.start", {
    type: rebuildType,
    async_index: asyncIndex,
  });
  try {
    if (provider.rebuildIndex) {
      const job = asObject(await provider.rebuildIndex(rebuildType, traceId)) ?? {};
      logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.rebuild_index.complete", {
        type: rebuildType,
        async_index: asyncIndex,
      });
      const result = asObject(job.result) ?? {};
      if (!asyncIndex) {
        return {
          status: 200,
          body: knowledgeRebuildSuccessBody(rebuildType, result),
        };
      }
      return {
        status: 202,
        body: {
          message: "Knowledge index rebuild started",
          job,
          job_id: job.id,
          type: rebuildType,
        },
      };
    }
    const stats = knowledgeStatsBody(await provider.stats(traceId));
    const result = rebuildType === "all"
      ? knowledgeAllRebuildResult(stats)
      : rebuildType === "semantic"
        ? knowledgeSemanticUnavailableResult()
        : rebuildType === "tree"
          ? knowledgeTreeRebuildResult(stats)
        : knowledgeBm25RebuildResult(stats);
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.rebuild_index.complete", {
      type: rebuildType,
      async_index: asyncIndex,
      ...knowledgeStatsDiagnostic(stats),
    });
    if (!asyncIndex) {
      return {
        status: 200,
        body: knowledgeRebuildSuccessBody(rebuildType, result),
      };
    }

    const job = rebuildType === "all"
      ? completedKnowledgeAllRebuildJob(stats, result)
      : rebuildType === "semantic"
        ? completedKnowledgeSemanticRebuildJob(stats)
        : rebuildType === "tree"
          ? completedKnowledgeTreeRebuildJob(stats, result)
      : completedKnowledgeBm25RebuildJob(stats, result);
    return {
      status: 202,
      body: {
        message: "Knowledge index rebuild started",
        job,
        job_id: job.id,
        type: rebuildType,
      },
    };
  } catch (error) {
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.rebuild_index.failed", {
      type: rebuildType,
      async_index: asyncIndex,
      error: errorMessage(error),
    });
    return knowledgeServerError("Error rebuilding index", error);
  }
}

async function knowledgeGraphExtractResponse(
  body: unknown,
  config: Record<string, unknown>,
  provider: WebuiKnowledgeProvider | undefined,
  openAiCompatProvider: WebuiOpenAiCompatProvider | undefined,
  traceId: string,
  diagnosticsLogger?: WebuiDiagnosticsLogger,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  if (!isJsonObject(body)) {
    return { status: 400, body: knowledgeApiError(400, "Invalid JSON body") };
  }
  const docIds = await resolveKnowledgeGraphExtractionDocIds(body, provider, traceId);
  if (!docIds.length) {
    return { status: 400, body: knowledgeApiError(400, "doc_id is required") };
  }
  logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.graph_extract.start", {
    doc_id: docIds[0] ?? "",
    document_count: docIds.length,
    dry_run: body.dry_run === true,
  });
  try {
    const model = knowledgeExtractionModel(config);
    const maxTokens = knowledgeGraphExtractionMaxTokens(config);
    const maxJobTokens = knowledgeGraphExtractionMaxJobTokens(config);
    const maxChunks = knowledgeGraphExtractionMaxChunks(config);
    const plans = [];
    for (const docId of docIds) {
      const plan = await buildKnowledgeGraphExtractionPlan(provider, docId, maxTokens, maxChunks, traceId);
      if (!plan) {
        return { status: 404, body: knowledgeApiError(404, `Document ${docId} not found`) };
      }
      plans.push(plan);
    }
    if (body.dry_run === true || body.estimate_only === true) {
      const skippedDocs = body.force === true ? [] : await findExistingKnowledgeGraphExtractionSkips(plans, provider, traceId);
      if (plans.length === 1) {
        const plan = plans[0]!;
        const skipped = skippedDocs.find((item) => item.doc_id === plan.docId);
        return {
          status: 200,
          body: buildKnowledgeGraphSingleEstimateBody(plan, skipped),
        };
      }
      return {
        status: 200,
        body: buildKnowledgeGraphBatchEstimateBody(plans, maxTokens, maxJobTokens, stringValue(body.scope) ?? "selected", skippedDocs),
      };
    }
    if (!knowledgeGraphExtractionEnabled(config)) {
      return { status: 403, body: knowledgeApiError(403, "Knowledge graph extraction is disabled", "forbidden") };
    }
    const skippedDocs = body.force === true ? [] : await findExistingKnowledgeGraphExtractionSkips(plans, provider, traceId);
    const skippedDocIds = new Set(skippedDocs.map((item) => item.doc_id));
    const runnablePlans = plans.filter((plan) => !skippedDocIds.has(plan.docId));
    if (!runnablePlans.length) {
      return {
        status: 200,
        body: {
          message: "Knowledge graph extraction skipped",
          skipped: true,
          document_count: plans.length,
          runnable_document_count: 0,
          skipped_count: skippedDocs.length,
          skipped_docs: skippedDocs,
          progress: buildKnowledgeGraphExtractionProgress(plans, skippedDocs, "skipped"),
        },
      };
    }
    if (!openAiCompatProvider) {
      return { status: 503, body: knowledgeApiError(503, "OpenAI-compatible runtime unavailable", "server_error") };
    }
    if (!provider.saveEntityGraphExtraction) {
      return { status: 503, body: knowledgeApiError(503, "Knowledge entity graph store not initialized", "server_error") };
    }
    if (runnablePlans.some((plan) => plan.tokenEstimate.within_budget === false)) {
      return { status: 400, body: knowledgeApiError(400, "Graph extraction token estimate exceeds configured budget") };
    }
    if (!areKnowledgeGraphPlansWithinJobBudget(runnablePlans, maxJobTokens)) {
      return { status: 400, body: knowledgeApiError(400, "Graph extraction token estimate exceeds configured job budget") };
    }
    const jobs: Record<string, unknown>[] = await runKnowledgeGraphExtractionPlans(
      runnablePlans,
      knowledgeGraphExtractionConcurrency(config),
      async (plan) => runKnowledgeGraphExtractionPlan({
        plan,
        provider,
        openAiCompatProvider,
        model,
        maxTokens,
        timeoutSeconds: knowledgeSemanticTimeoutSeconds(config),
        traceId,
      }),
    );
    const completedProgress = buildKnowledgeGraphExtractionProgress(plans, skippedDocs, "completed", jobs);
    const progressByDocId = new Map(
      (Array.isArray(completedProgress.documents) ? completedProgress.documents : [])
        .map((item) => asObject(item))
        .filter((item): item is Record<string, unknown> => Boolean(item?.doc_id))
        .map((item) => [String(item.doc_id), item]),
    );
    const jobsWithProgress: Record<string, unknown>[] = jobs.map((job, index) => {
      const docId = stringValue(job.doc_id) ?? runnablePlans[index]?.docId;
      const documentProgress = docId ? progressByDocId.get(docId) : undefined;
      return {
        ...job,
        ...(documentProgress
          ? {
            progress: {
              stage: completedProgress.stage,
              completed: documentProgress.completed,
              total: documentProgress.total,
              documents: [documentProgress],
            },
          }
          : {}),
      };
    });
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.graph_extract.complete", {
      document_count: runnablePlans.length,
      job_count: jobs.length,
      skipped_count: skippedDocs.length,
    });
    if (jobs.length === 1 && skippedDocs.length === 0) {
      const job = jobsWithProgress[0] ?? {};
      return {
        status: 202,
        body: {
          message: "Knowledge graph extraction completed",
          job,
          job_id: job["id"],
          progress: completedProgress,
        },
      };
    }
    return {
      status: 202,
      body: {
        message: "Knowledge graph extraction completed",
        document_count: plans.length,
        runnable_document_count: jobsWithProgress.length,
        skipped_count: skippedDocs.length,
        jobs: jobsWithProgress,
        job_ids: jobsWithProgress.map((job) => job["id"]).filter(Boolean),
        progress: completedProgress,
        ...(skippedDocs.length ? { skipped_docs: skippedDocs } : {}),
      },
    };
  } catch (error) {
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.graph_extract.failed", {
      doc_id: docIds[0] ?? "",
      error: errorMessage(error),
    });
    return knowledgeValueError(error) ?? knowledgeServerError("Error extracting knowledge graph", error);
  }
}

async function knowledgeGraphResponse(
  query: URLSearchParams,
  provider: WebuiKnowledgeProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  const params = parseKnowledgeGraphQuery(query);
  if (!params.ok) {
    return { status: 400, body: knowledgeApiError(400, "Invalid graph query params") };
  }
  try {
    if (provider.graph) {
      return { status: 200, body: asObject(await provider.graph(knowledgeGraphProviderRequest(params.value), traceId)) ?? {} };
    }
    const stats = knowledgeStatsBody(await provider.stats(traceId));
    return { status: 200, body: knowledgeGraphBody(stats, params.value) };
  } catch (error) {
    return knowledgeServerError("Error getting knowledge graph", error);
  }
}

async function knowledgeQueryResponse(
  body: unknown,
  provider: WebuiKnowledgeProvider | undefined,
  traceId: string,
  diagnosticsLogger?: WebuiDiagnosticsLogger,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  if (!isJsonObject(body)) {
    return { status: 400, body: knowledgeApiError(400, "Invalid JSON body") };
  }
  const query = stringValue(body.query);
  if (!query) {
    return { status: 400, body: knowledgeApiError(400, "Query text is required") };
  }
  const mode = Object.prototype.hasOwnProperty.call(body, "mode") ? body.mode : "hybrid";
  if (!query.trim()) {
    return {
      status: 200,
      body: {
        object: "list",
        query,
        mode,
        data: [],
        total: 0,
      },
    };
  }
  const request = knowledgeQueryProviderRequest(body, query, mode);
  logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.query.start", {
    mode: stringValue(request.mode) ?? "hybrid",
    top_k: numberValue(request.top_k) ?? 5,
    query_chars: query.length,
  });
  try {
    const result = await provider.query(request, traceId);
    const resultObject = asObject(result) ?? {};
    const data = arrayFromResult(result, "results");
    const retrievalPlan = isJsonObject(resultObject.retrieval_plan) ? resultObject.retrieval_plan : undefined;
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.query.complete", {
      mode: stringValue(request.mode) ?? "hybrid",
      top_k: numberValue(request.top_k) ?? 5,
      total: data.length,
      retrieval_plan_classification: retrievalPlan ? stringValue(retrievalPlan.classification) : undefined,
      selected_routes: retrievalPlan && Array.isArray(retrievalPlan.selected_routes)
        ? retrievalPlan.selected_routes
        : undefined,
    });
    return {
      status: 200,
      body: {
        object: "list",
        query,
        mode,
        ...(retrievalPlan ? { retrieval_plan: retrievalPlan } : {}),
        data: data.map(knowledgeQueryItem),
        total: data.length,
      },
    };
  } catch (error) {
    logKnowledgeDiagnostic(diagnosticsLogger, traceId, "knowledge.query.failed", {
      mode: stringValue(request.mode) ?? "hybrid",
      error: errorMessage(error),
    });
    return knowledgeServerError("Error querying knowledge", error);
  }
}

function knowledgeQueryProviderRequest(
  body: Record<string, unknown>,
  query: string,
  mode: unknown,
): Record<string, unknown> {
  return {
    ...body,
    query,
    mode,
    top_k: Object.prototype.hasOwnProperty.call(body, "top_k") ? body.top_k : 5,
  };
}

function knowledgeStatsBody(result: unknown): Record<string, unknown> {
  const stats = asObject(result) ?? {};
  return {
    total_documents: numberValue(stats.total_documents) ?? numberValue(stats.document_count) ?? 0,
    total_chunks: numberValue(stats.total_chunks) ?? numberValue(stats.chunk_count) ?? 0,
    total_chars: numberValue(stats.total_chars) ?? 0,
    categories: isJsonObject(stats.categories) ? stats.categories : {},
    indexed_dense: numberValue(stats.indexed_dense) ?? 0,
    indexed_sparse: numberValue(stats.indexed_sparse) ?? numberValue(stats.chunk_count) ?? 0,
    entity_count: numberValue(stats.entity_count) ?? 0,
    claim_count: numberValue(stats.claim_count) ?? 0,
    relation_count: numberValue(stats.relation_count) ?? 0,
    community_count: numberValue(stats.community_count) ?? 0,
    community_count_by_level: isJsonObject(stats.community_count_by_level) ? stats.community_count_by_level : {},
    community_report_count: numberValue(stats.community_report_count) ?? 0,
    stage_details: Array.isArray(stats.stage_details) ? stats.stage_details : [],
    stage_readiness: isJsonObject(stats.stage_readiness) ? stats.stage_readiness : {},
    stage_coverage: isJsonObject(stats.stage_coverage) ? stats.stage_coverage : {},
    failed_stage_count: numberValue(stats.failed_stage_count) ?? 0,
    stale_stage_count: numberValue(stats.stale_stage_count) ?? 0,
    retrieval_ready: Boolean(stats.retrieval_ready),
    claims_ready: Boolean(stats.claims_ready),
    relations_ready: Boolean(stats.relations_ready),
    graph_ready: Boolean(stats.graph_ready),
    partial_availability: Boolean(stats.partial_availability),
  };
}

function knowledgeStatsDiagnostic(stats: Record<string, unknown>): Record<string, unknown> {
  return {
    total_documents: numberValue(stats.total_documents) ?? 0,
    total_chunks: numberValue(stats.total_chunks) ?? 0,
    indexed_sparse: numberValue(stats.indexed_sparse) ?? 0,
    indexed_dense: numberValue(stats.indexed_dense) ?? 0,
    retrieval_ready: stats.retrieval_ready === true,
    graph_ready: stats.graph_ready === true,
    partial_availability: stats.partial_availability === true,
    failed_stage_count: numberValue(stats.failed_stage_count) ?? 0,
    stale_stage_count: numberValue(stats.stale_stage_count) ?? 0,
  };
}

function logKnowledgeDiagnostic(
  diagnosticsLogger: WebuiDiagnosticsLogger | undefined,
  traceId: string,
  stage: string,
  details: Record<string, unknown> = {},
): void {
  if (!diagnosticsLogger) {
    return;
  }
  diagnosticsLogger({
    stream: "stderr",
    line: `[knowledge] ${JSON.stringify(compactDiagnosticDetails({ stage, trace_id: traceId, ...details }))}`,
  });
}

function compactDiagnosticDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, compactDiagnosticValue(value)]),
  );
}

function compactDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 160)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 8).map(compactDiagnosticValue);
  }
  if (isJsonObject(value)) {
    return compactDiagnosticDetails(value);
  }
  return value;
}

function knowledgeBm25RebuildResult(stats: Record<string, unknown>): Record<string, unknown> {
  return {
    chunks_indexed: numberValue(stats.total_chunks) ?? 0,
    terms_created: numberValue(stats.terms_created) ?? 0,
    total_docs: numberValue(stats.total_documents) ?? 0,
  };
}

function knowledgeSemanticUnavailableResult(): Record<string, unknown> {
  return {
    skipped: true,
    available: false,
    entities: 0,
    claims: 0,
    relations: 0,
    mentions: 0,
    communities: 0,
    community_reports: 0,
  };
}

function knowledgeTreeRebuildResult(stats: Record<string, unknown>): Record<string, unknown> {
  const stageReadiness = asObject(stats.stage_readiness) ?? {};
  const treeIndex = asObject(stageReadiness.tree_index) ?? {};
  const sectionsIndexed = numberValue(treeIndex.processed) ?? numberValue(stats.total_chunks) ?? 0;
  return {
    available: true,
    documents_scanned: numberValue(stats.total_documents) ?? 0,
    sections_indexed: sectionsIndexed,
    tree_ready: Boolean(treeIndex.ready) || sectionsIndexed > 0,
  };
}

function knowledgeAllRebuildResult(stats: Record<string, unknown>): Record<string, unknown> {
  return {
    bm25: knowledgeBm25RebuildResult(stats),
    tree: knowledgeTreeRebuildResult(stats),
    semantic: knowledgeSemanticUnavailableResult(),
  };
}

function knowledgeRebuildSuccessBody(
  rebuildType: KnowledgeRebuildType,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (rebuildType === "all") {
    return {
      message: "All available native knowledge indexes rebuilt successfully",
      ...result,
    };
  }
  if (rebuildType === "semantic") {
    return {
      message: "Semantic index is not available in native TS worker",
      ...result,
    };
  }
  if (rebuildType === "tree") {
    return {
      message: "Knowledge tree index rebuilt successfully",
      ...result,
    };
  }
  return {
    message: "BM25 index rebuilt successfully",
    ...result,
  };
}

type KnowledgeGraphQuery = {
  docId: string;
  graphType: string;
  limit: number;
  edgeLimit: number;
  minConfidence: number;
  includeOrphans: boolean;
};

type KnowledgeGraphRagQuery = {
  docId: string;
  minConfidence: number;
  level: number;
  includeReports: boolean;
  includeCovariates: boolean;
};

function parseKnowledgeGraphQuery(query: URLSearchParams): { ok: true; value: KnowledgeGraphQuery } | { ok: false } {
  const limit = clampedNumberQuery(query.get("limit"), 80, 1, 500, true);
  if (limit === undefined) {
    return { ok: false };
  }
  const edgeLimit = clampedNumberQuery(query.get("edge_limit"), limit * 2, 1, 1000, true);
  if (edgeLimit === undefined) {
    return { ok: false };
  }
  const minConfidence = clampedNumberQuery(query.get("min_confidence"), 0, 0, 1, false);
  if (minConfidence === undefined) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      docId: query.get("doc_id") ?? "",
      graphType: query.get("graph_type") ?? "document",
      limit,
      edgeLimit,
      minConfidence,
      includeOrphans: booleanQuery(query.get("include_orphans")),
    },
  };
}

function parseKnowledgeGraphRagQuery(
  query: URLSearchParams,
  defaultLevel: number,
): { ok: true; value: KnowledgeGraphRagQuery } | { ok: false } {
  const minConfidence = clampedNumberQuery(query.get("min_confidence"), 0, 0, 1, false);
  const level = clampedNumberQuery(query.get("level"), defaultLevel, 0, Number.MAX_SAFE_INTEGER, true);
  if (minConfidence === undefined || level === undefined) {
    return { ok: false };
  }
  return {
    ok: true,
    value: {
      docId: query.get("doc_id") ?? "",
      minConfidence,
      level,
      includeReports: booleanQueryDefault(query.get("include_reports"), true),
      includeCovariates: booleanQueryDefault(query.get("include_covariates"), true),
    },
  };
}

function knowledgeExtractionModel(config: Record<string, unknown>): string {
  const knowledge = asObject(config.knowledge);
  return stringValue(knowledge?.graphExtractionModel)
    ?? stringValue(knowledge?.graph_extraction_model)
    ?? stringValue(knowledge?.semanticLlmModel)
    ?? stringValue(knowledge?.semantic_llm_model)
    ?? openAiConfiguredModel(config);
}

function knowledgeGraphExtractionMaxTokens(config: Record<string, unknown>): number {
  const knowledge = asObject(config.knowledge);
  return Math.max(
    1,
    Math.trunc(
      numberValue(knowledge?.graphExtractionMaxTokens)
        ?? numberValue(knowledge?.graph_extraction_max_tokens)
        ?? numberValue(knowledge?.semanticLlmMaxTokens)
        ?? numberValue(knowledge?.semantic_llm_max_tokens)
        ?? 1200,
    ),
  );
}

function knowledgeSemanticTimeoutSeconds(config: Record<string, unknown>): number {
  const knowledge = asObject(config.knowledge);
  const timeout = numberValue(knowledge?.semanticLlmTimeout)
    ?? numberValue(knowledge?.semantic_llm_timeout)
    ?? openAiRequestTimeoutSeconds(config);
  return Math.max(1, timeout);
}

function knowledgeGraphExtractionEnabled(config: Record<string, unknown>): boolean {
  const knowledge = asObject(config.knowledge);
  return knowledge?.graphExtractionEnabled !== false && knowledge?.graph_extraction_enabled !== false;
}

function knowledgeGraphAutoExtractEnabled(config: Record<string, unknown>): boolean {
  const knowledge = asObject(config.knowledge);
  return (knowledge?.graphAutoExtract === true || knowledge?.graph_auto_extract === true) && knowledgeGraphExtractionEnabled(config);
}

function knowledgeGraphExtractionMaxChunks(config: Record<string, unknown>): number {
  const knowledge = asObject(config.knowledge);
  return Math.max(
    1,
    Math.trunc(
      numberValue(knowledge?.graphExtractionMaxChunks)
        ?? numberValue(knowledge?.graph_extraction_max_chunks)
        ?? numberValue(knowledge?.maxChunks)
        ?? numberValue(knowledge?.max_chunks)
        ?? 5,
    ),
  );
}

function knowledgeGraphExtractionMaxJobTokens(config: Record<string, unknown>): number | null {
  const knowledge = asObject(config.knowledge);
  const value = numberValue(knowledge?.graphExtractionMaxJobTokens)
    ?? numberValue(knowledge?.graph_extraction_max_job_tokens);
  if (value === undefined || value <= 0) {
    return null;
  }
  return Math.max(1, Math.trunc(value));
}

function knowledgeGraphExtractionConcurrency(config: Record<string, unknown>): number {
  const knowledge = asObject(config.knowledge);
  return Math.max(
    1,
    Math.trunc(
      numberValue(knowledge?.graphExtractionConcurrency)
        ?? numberValue(knowledge?.graph_extraction_concurrency)
        ?? 1,
    ),
  );
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function knowledgeGraphProviderRequest(query: KnowledgeGraphQuery): Record<string, unknown> {
  return {
    doc_id: query.docId,
    graph_type: query.graphType,
    limit: query.limit,
    edge_limit: query.edgeLimit,
    min_confidence: query.minConfidence,
    include_orphans: query.includeOrphans,
  };
}

function knowledgeGraphBody(
  stats: Record<string, unknown>,
  query: KnowledgeGraphQuery,
): Record<string, unknown> {
  const retrievalReady = Boolean(stats.retrieval_ready);
  const graphReady = Boolean(stats.graph_ready);
  return {
    object: "knowledge_graph",
    nodes: [],
    edges: [],
    communities: [],
    reports: [],
    claims: [],
    conflicts: [],
    stats: {
      node_count: 0,
      edge_count: 0,
      total_entities: numberValue(stats.entity_count) ?? 0,
      total_relations: numberValue(stats.relation_count) ?? 0,
      total_mentions: 0,
      doc_id: query.docId,
      limit: query.limit,
      edge_limit: query.edgeLimit,
      min_confidence: query.minConfidence,
      include_orphans: query.includeOrphans,
    },
    readiness: {
      retrieval_ready: retrievalReady,
      claims_ready: Boolean(stats.claims_ready),
      relations_ready: Boolean(stats.relations_ready),
      graph_ready: graphReady,
      partial_availability: Boolean(stats.partial_availability) || (retrievalReady && !graphReady),
    },
    stage_readiness: isJsonObject(stats.stage_readiness) ? stats.stage_readiness : {},
    stage_coverage: isJsonObject(stats.stage_coverage) ? stats.stage_coverage : {},
  };
}

async function knowledgeGraphRagResponse(
  query: URLSearchParams,
  provider: WebuiKnowledgeProvider | undefined,
  configProvider: WebuiConfigProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!provider) {
    return { status: 503, body: knowledgeApiError(503, "Knowledge store not initialized") };
  }
  const config = configProvider ? await configProvider.getConfig(traceId) : {};
  const params = parseKnowledgeGraphRagQuery(query, graphRagCommunityLevel(config));
  if (!params.ok) {
    return { status: 400, body: knowledgeApiError(400, "Invalid GraphRAG query params") };
  }
  try {
    const stats = knowledgeStatsBody(await provider.stats(traceId));
    return { status: 200, body: knowledgeGraphRagBody(stats, params.value) };
  } catch (error) {
    return knowledgeServerError("Error getting GraphRAG index", error);
  }
}

function knowledgeGraphRagBody(
  stats: Record<string, unknown>,
  query: KnowledgeGraphRagQuery,
): Record<string, unknown> {
  const covariates: unknown[] = [];
  const communityReports: unknown[] = [];
  return {
    object: "graphrag_index",
    documents: [],
    text_units: [],
    entities: [],
    relationships: [],
    covariates: query.includeCovariates ? covariates : [],
    communities: [],
    community_reports: query.includeReports ? communityReports : [],
    stats: {
      document_count: numberValue(stats.total_documents) ?? 0,
      text_unit_count: numberValue(stats.total_chunks) ?? 0,
      entity_count: numberValue(stats.entity_count) ?? 0,
      relationship_count: numberValue(stats.relation_count) ?? 0,
      covariate_count: query.includeCovariates ? covariates.length : 0,
      community_count: numberValue(stats.community_count) ?? 0,
      community_report_count: query.includeReports ? numberValue(stats.community_report_count) ?? 0 : 0,
      doc_id: query.docId,
      min_confidence: query.minConfidence,
      level: query.level,
      include_reports: query.includeReports,
      include_covariates: query.includeCovariates,
    },
  };
}

function knowledgeDocumentSummary(value: Record<string, unknown>): Record<string, unknown> {
  const content = stringValue(value.content) ?? "";
  return {
    id: value.id,
    name: value.name,
    file_path: value.file_path ?? value.filePath,
    file_type: value.file_type ?? value.fileType,
    category: value.category ?? "",
    tags: Array.isArray(value.tags) ? value.tags : [],
    chunk_count: numberValue(value.chunk_count) ?? numberValue(value.chunkCount) ?? 0,
    content_length: numberValue(value.content_length) ?? content.length,
    created_at: value.created_at ?? value.createdAt,
  };
}

function knowledgeQueryItem(value: Record<string, unknown>): Record<string, unknown> {
  const score = value.score
    ?? value.rerank_score
    ?? value.semantic_fusion_score
    ?? value.semantic_score
    ?? value.rrf_score
    ?? value.bm25_score
    ?? value.distance;
  return {
    id: value.id,
    parent_id: value.parent_id,
    chunk_type: value.chunk_type,
    content: value.content,
    matched_child_ids: Array.isArray(value.matched_child_ids) ? value.matched_child_ids : [],
    matched_child_snippets: Array.isArray(value.matched_child_snippets) ? value.matched_child_snippets : [],
    doc_id: value.doc_id,
    doc_name: value.doc_name,
    file_path: value.file_path,
    start_char: value.start_char,
    end_char: value.end_char,
    line_start: value.line_start,
    line_end: value.line_end,
    section_path: value.section_path,
    block_type: value.block_type,
    score,
    rerank_score: value.rerank_score,
    rerank_rank: value.rerank_rank,
    rerank_model: value.rerank_model,
    pre_rerank_score: value.pre_rerank_score,
    rrf_score: value.rrf_score,
    semantic_score: value.semantic_score,
    semantic_rank: value.semantic_rank,
    semantic_fusion_score: value.semantic_fusion_score,
    bm25_score: value.bm25_score,
    dense_distance: value.dense_distance ?? value.distance,
    dense_rank: value.dense_rank,
    sparse_rank: value.sparse_rank,
    dense_contribution: value.dense_contribution,
    sparse_contribution: value.sparse_contribution,
    method: value.method,
    retrieval_method: value.retrieval_method ?? value.method,
    score_metadata: isJsonObject(value.score_metadata) ? value.score_metadata : {},
    structure_context: isJsonObject(value.structure_context) ? value.structure_context : {},
    source_snippets: Array.isArray(value.source_snippets) ? value.source_snippets : [],
    matched_methods: Array.isArray(value.matched_methods) ? value.matched_methods : [],
    matched_entities: Array.isArray(value.matched_entities) ? value.matched_entities : [],
    matched_claims: Array.isArray(value.matched_claims) ? value.matched_claims : [],
    matched_claim_evidence: Array.isArray(value.matched_claim_evidence) ? value.matched_claim_evidence : [],
    matched_relations: Array.isArray(value.matched_relations) ? value.matched_relations : [],
    matched_relation_evidence: Array.isArray(value.matched_relation_evidence) ? value.matched_relation_evidence : [],
    matched_communities: Array.isArray(value.matched_communities) ? value.matched_communities : [],
    conflict_metadata: Array.isArray(value.conflict_metadata) ? value.conflict_metadata : [],
    projection_metadata: Array.isArray(value.projection_metadata) ? value.projection_metadata : [],
  };
}

function documentFromResult(result: unknown): Record<string, unknown> | undefined {
  const object = asObject(result);
  return asObject(object?.document) ?? object;
}

function arrayFromResult(result: unknown, key: string): Record<string, unknown>[] {
  const object = asObject(result);
  const keyed = object?.[key];
  const items = Array.isArray(keyed) ? keyed : Array.isArray(result) ? result : [];
  return items.filter(isJsonObject);
}

function knowledgeTags(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return [];
}

function isTextLikeKnowledgeUploadType(fileType: string): boolean {
  return ["txt", "md", "json", "csv"].includes(fileType);
}

function booleanQuery(value: string | null): boolean {
  return value !== null && ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function isKnowledgeRebuildType(value: string): value is KnowledgeRebuildType {
  return value === "bm25" || value === "semantic" || value === "tree" || value === "all";
}

function booleanQueryDefault(value: string | null, fallback: boolean): boolean {
  if (value === null) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function graphRagCommunityLevel(config: Record<string, unknown>): number {
  const knowledge = asObject(config.knowledge);
  const value = knowledge?.graphragCommunityLevel ?? knowledge?.graphrag_community_level;
  return clampedConfigInteger(value, 0, 0, Number.MAX_SAFE_INTEGER);
}

function clampedConfigInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

async function knowledgeStartIndexJob(
  provider: WebuiKnowledgeProvider,
  docId: string,
  traceId: string,
): Promise<Record<string, unknown> | undefined> {
  if (!docId || !provider.startIndexJob) {
    return undefined;
  }
  return asObject(await provider.startIndexJob(docId, traceId));
}

function knowledgeUploadJobDocumentId(jobId: string): string | undefined {
  return jobId.startsWith("kjob_doc") ? jobId.slice("kjob_".length) : undefined;
}

function completedKnowledgeUploadJob(docId: string, name: string, chunkCount = 1): Record<string, unknown> {
  const lifecycle = completedKnowledgeJobLifecycle();
  const chunksIndexed = Math.max(1, Math.trunc(chunkCount));
  return {
    id: `kjob_${docId || "upload"}`,
    doc_id: docId,
    name,
    status: "completed",
    stage: "retrieval_indexed",
    message: "Native retrieval index is available; semantic graph indexing is not available in native TS worker",
    processed: chunksIndexed,
    total: chunksIndexed,
    error: "",
    ...lifecycle,
    stage_details: [],
    failed_stage_count: 0,
    stale_stage_count: 0,
    retrieval_ready: true,
    graph_ready: false,
    partial_availability: true,
  };
}

function completedKnowledgeBm25RebuildJob(
  stats: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const chunksIndexed = numberValue(result.chunks_indexed) ?? 0;
  const retrievalReady = Boolean(stats.retrieval_ready) || chunksIndexed > 0;
  const graphReady = Boolean(stats.graph_ready);
  const lifecycle = completedKnowledgeJobLifecycle();
  return {
    id: "kjob_rebuild_bm25",
    name: "rebuild:bm25",
    status: "completed",
    stage: "completed",
    message: "BM25 index is available in native TS worker",
    processed: chunksIndexed,
    total: chunksIndexed,
    error: "",
    ...lifecycle,
    stage_details: Array.isArray(stats.stage_details) ? stats.stage_details : [],
    failed_stage_count: numberValue(stats.failed_stage_count) ?? 0,
    stale_stage_count: numberValue(stats.stale_stage_count) ?? 0,
    retrieval_ready: retrievalReady,
    graph_ready: graphReady,
    partial_availability: retrievalReady && !graphReady,
    result,
  };
}

function completedKnowledgeAllRebuildJob(
  stats: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const bm25 = asObject(result.bm25) ?? {};
  const chunksIndexed = numberValue(bm25.chunks_indexed) ?? 0;
  const retrievalReady = Boolean(stats.retrieval_ready) || chunksIndexed > 0;
  const graphReady = Boolean(stats.graph_ready);
  const lifecycle = completedKnowledgeJobLifecycle();
  return {
    id: "kjob_rebuild_all",
    name: "rebuild:all",
    status: "completed",
    stage: "completed",
    message: "Native available knowledge indexes are rebuilt; semantic index is not available natively",
    processed: 3,
    total: 3,
    error: "",
    ...lifecycle,
    stage_details: Array.isArray(stats.stage_details) ? stats.stage_details : [],
    failed_stage_count: numberValue(stats.failed_stage_count) ?? 0,
    stale_stage_count: numberValue(stats.stale_stage_count) ?? 0,
    retrieval_ready: retrievalReady,
    graph_ready: graphReady,
    partial_availability: retrievalReady && !graphReady,
    result,
  };
}

function completedKnowledgeTreeRebuildJob(
  stats: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const sectionsIndexed = numberValue(result.sections_indexed) ?? 0;
  const retrievalReady = Boolean(stats.retrieval_ready) || sectionsIndexed > 0;
  const graphReady = Boolean(stats.graph_ready);
  const lifecycle = completedKnowledgeJobLifecycle();
  return {
    id: "kjob_rebuild_tree",
    name: "rebuild:tree",
    status: "completed",
    stage: "completed",
    message: "Knowledge tree index rebuilt successfully",
    processed: sectionsIndexed,
    total: sectionsIndexed,
    error: "",
    ...lifecycle,
    stage_details: Array.isArray(stats.stage_details) ? stats.stage_details : [],
    failed_stage_count: numberValue(stats.failed_stage_count) ?? 0,
    stale_stage_count: numberValue(stats.stale_stage_count) ?? 0,
    retrieval_ready: retrievalReady,
    graph_ready: graphReady,
    partial_availability: retrievalReady && !graphReady,
    result,
  };
}

function completedKnowledgeSemanticRebuildJob(stats: Record<string, unknown>): Record<string, unknown> {
  const retrievalReady = Boolean(stats.retrieval_ready) || (numberValue(stats.total_chunks) ?? 0) > 0;
  const graphReady = Boolean(stats.graph_ready);
  const lifecycle = completedKnowledgeJobLifecycle();
  return {
    id: "kjob_rebuild_semantic",
    name: "rebuild:semantic",
    status: "completed",
    stage: "completed",
    message: "Semantic index is not available in native TS worker",
    processed: 2,
    total: 2,
    error: "",
    ...lifecycle,
    stage_details: Array.isArray(stats.stage_details) ? stats.stage_details : [],
    failed_stage_count: numberValue(stats.failed_stage_count) ?? 0,
    stale_stage_count: numberValue(stats.stale_stage_count) ?? 0,
    retrieval_ready: retrievalReady,
    graph_ready: graphReady,
    partial_availability: retrievalReady && !graphReady,
    result: knowledgeSemanticUnavailableResult(),
  };
}

function completedKnowledgeJobLifecycle(): Record<string, unknown> {
  const timestamp = new Date().toISOString();
  return {
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: timestamp,
  };
}

function knowledgeApiError(status: number, message: string, type = "invalid_request_error"): Record<string, unknown> {
  return {
    error: {
      message,
      type,
      code: status,
    },
  };
}

function knowledgeServerError(message: string, error: unknown): WebuiRouteResponse {
  return {
    status: 500,
    body: knowledgeApiError(500, `${message}: ${errorMessage(error)}`, "server_error"),
  };
}

function knowledgeValueError(error: unknown): WebuiRouteResponse | undefined {
  if (!isNamedError(error, "ValueError")) {
    return undefined;
  }
  return {
    status: 400,
    body: knowledgeApiError(400, errorMessage(error)),
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (isJsonObject(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

function isNamedError(error: unknown, name: string): boolean {
  if (error instanceof Error) {
    return error.name === name;
  }
  return isJsonObject(error) && error.name === name;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function webuiApprovalsResponse(
  query: URLSearchParams,
  approvalProvider: WebuiApprovalProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  const sessionId = approvalSessionId(query, approvalProvider?.channelName ?? "websocket");
  if (!sessionId) {
    return { status: 400, body: { error: "session_key or chat_id is required" } };
  }
  if (!approvalProvider?.listPendingApprovals) {
    return { status: 404, body: { error: "session_key or chat_id is required" } };
  }
  const result = await approvalProvider.listPendingApprovals(sessionId, traceId);
  const approvals = Array.isArray(result.approvals) ? result.approvals.filter(isJsonObject) : [];
  return {
    status: 200,
    body: {
      session_key: typeof result.session_key === "string" ? result.session_key : sessionId,
      approvals,
    },
  };
}

function approvalSessionId(query: URLSearchParams, fallbackChannel: string): string | undefined {
  const sessionKey = query.get("session_key");
  if (sessionKey) {
    return sessionKey;
  }
  const chatId = query.get("chat_id");
  if (!chatId) {
    return undefined;
  }
  const channel = query.get("channel") || fallbackChannel;
  return `${channel}:${chatId}`;
}

async function webuiApprovalResolutionResponse(
  approvalId: string,
  approved: boolean,
  query: URLSearchParams,
  body: unknown,
  approvalProvider: WebuiApprovalProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  const payload = body === undefined ? {} : body;
  if (!isJsonObject(payload)) {
    return { status: 400, body: { error: "payload must be a dict" } };
  }
  const sessionId = approvalSessionIdFromPayload(query, payload, approvalProvider?.channelName ?? "websocket");
  if (!sessionId) {
    return { status: 400, body: { error: "session_key or chat_id is required" } };
  }
  if (!approvalProvider?.resolveApproval) {
    return { status: 404, body: { error: "approval not found" } };
  }
  const scope = approved ? stringValue(payload.scope)?.toLowerCase() ?? "once" : undefined;
  if (approved && scope !== "once" && scope !== "session") {
    return { status: 400, body: { error: "scope must be 'once' or 'session'" } };
  }
  try {
    const result = await approvalProvider.resolveApproval(
      {
        sessionId,
        approvalId,
        approved,
        ...(approved ? { scope } : {}),
      },
      traceId,
    );
    const approval = webuiApprovalFromResult(result, approvalId);
    if (!approval) {
      return { status: 404, body: { error: "approval not found" } };
    }
    if (!approved) {
      return { status: 200, body: { denied: true, approval } };
    }
    return {
      status: 200,
      body: {
        approved: true,
        approval,
        scope,
        auto_retry: payload.auto_retry === undefined ? true : Boolean(payload.auto_retry),
      },
    };
  } catch {
    return { status: 404, body: { error: "approval not found" } };
  }
}

function approvalSessionIdFromPayload(
  query: URLSearchParams,
  payload: Record<string, unknown>,
  fallbackChannel: string,
): string | undefined {
  const sessionKey = stringValue(payload.session_key) ?? query.get("session_key");
  if (sessionKey) {
    return sessionKey;
  }
  const chatId = stringValue(payload.chat_id) ?? query.get("chat_id");
  if (!chatId) {
    return undefined;
  }
  const channel = stringValue(payload.channel) ?? query.get("channel") ?? fallbackChannel;
  return `${channel}:${chatId}`;
}

function webuiApprovalFromResult(result: Record<string, unknown>, fallbackId: string): Record<string, unknown> | undefined {
  if (isJsonObject(result.approval)) {
    return result.approval;
  }
  const id = stringValue(result.approvalId) ?? stringValue(result.id) ?? fallbackId;
  if (!id) {
    return undefined;
  }
  const operation = isJsonObject(result.operation) ? result.operation : {};
  return {
    id,
    tool_name: stringValue(operation.toolName) ?? stringValue(operation.tool_name) ?? "",
    category: stringValue(result.category) ?? "",
    risk: stringValue(result.risk) ?? "",
    reason: stringValue(result.reason) ?? "",
    summary: stringValue(result.summary) ?? "",
    created_at: stringValue(result.created_at) ?? stringValue(result.createdAt) ?? "",
  };
}

async function webuiAgentUiFormResponse(
  body: unknown,
  formAction: { formId: string; action: WebuiAgentUiFormAction },
  agentUiFormProvider: WebuiAgentUiFormProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  const payload = body === undefined ? {} : body;
  if (!isJsonObject(payload)) {
    return { status: 400, body: { error: "payload must be a dict" } };
  }
  const correlation = payload.correlation === undefined ? {} : payload.correlation;
  if (!isJsonObject(correlation)) {
    return { status: 400, body: { error: "correlation must be a dict" } };
  }
  const sessionId = agentUiFormSessionId(payload, correlation);
  if (!sessionId) {
    return { status: 400, body: { error: "session_key or session_id is required" } };
  }
  const rawValues = payload.values === undefined ? {} : payload.values;
  if (formAction.action === "submitted" && !isJsonObject(rawValues)) {
    return { status: 400, body: { error: "values must be a dict" } };
  }
  const values = formAction.action === "submitted"
    ? rawValues as Record<string, unknown>
    : {};
  if (!agentUiFormProvider) {
    return { status: 503, body: { error: "webui control route unavailable", route: agentUiFormRouteKey(formAction.action) } };
  }
  try {
    const result = await agentUiFormProvider.continueForm(
      {
        formId: formAction.formId,
        sessionId,
        action: formAction.action,
        values,
        correlation,
      },
      traceId,
    );
    return {
      status: agentUiFormResultStatus(result),
      body: result,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "form correlation mismatch") {
      return { status: 409, body: { error: "form correlation mismatch" } };
    }
    return {
      status: 409,
      body: {
        error: "form continuation unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function agentUiFormResultStatus(result: Record<string, unknown>): number {
  if (result.error === "invalid form values") {
    return 400;
  }
  if (result.error === "form expired") {
    return 409;
  }
  return 200;
}

function agentUiFormSessionId(payload: Record<string, unknown>, correlation: Record<string, unknown>): string | undefined {
  return stringValue(correlation.session_id)
    ?? stringValue(correlation.sessionId)
    ?? stringValue(correlation.session_key)
    ?? stringValue(correlation.sessionKey)
    ?? stringValue(payload.session_id)
    ?? stringValue(payload.sessionId)
    ?? stringValue(payload.session_key)
    ?? stringValue(payload.sessionKey);
}

function agentUiFormRouteKey(action: WebuiAgentUiFormAction): string {
  return action === "cancelled" ? "cancel_agent_ui_form" : "submit_agent_ui_form";
}

async function webuiWorkspaceFileResponse(
  method: string,
  path: string,
  body: unknown,
  workspaceProvider: WebuiWorkspaceProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!workspaceProvider) {
    return { status: 404, body: { error: "workspace not available" } };
  }
  try {
    if (method === "GET") {
      const file = await workspaceProvider.readFile(path, traceId);
      if (!file) {
        return { status: 404, body: { error: "file is not editable" } };
      }
      return { status: 200, body: webuiWorkspaceFileBody(file) };
    }
    const payload = body === undefined ? {} : body;
    if (!isJsonObject(payload)) {
      return { status: 400, body: { error: "invalid json body" } };
    }
    if (typeof payload.content !== "string") {
      return { status: 400, body: { error: "content must be a string" } };
    }
    const result = await workspaceProvider.writeFile(
      path,
      payload.content,
      traceId,
      workspaceExpectedUpdatedAt(payload),
    );
    return { status: 200, body: webuiWorkspaceWriteBody(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "version conflict") {
      return { status: 409, body: { error: message, path } };
    }
    return { status: 404, body: { error: message } };
  }
}

function workspaceExpectedUpdatedAt(payload: Record<string, unknown>): string | null | undefined {
  if (Object.prototype.hasOwnProperty.call(payload, "expected_updated_at")) {
    const value = payload.expected_updated_at;
    return value === null || typeof value === "string" ? value : undefined;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "expectedUpdatedAt")) {
    const value = payload.expectedUpdatedAt;
    return value === null || typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function webuiWorkspaceFileListBody(files: WebuiWorkspaceFileEntry[]): Record<string, unknown> {
  return {
    items: files.map((file) => ({
      path: file.path,
      exists: file.exists ?? true,
      updated_at: file.updatedAt ?? null,
    })),
  };
}

function webuiWorkspaceFileBody(file: WebuiWorkspaceFileContent): Record<string, unknown> {
  return {
    path: file.path,
    content: file.content,
    updated_at: file.updatedAt ?? null,
    exists: file.exists ?? true,
  };
}

function webuiWorkspaceWriteBody(result: WebuiWorkspaceWriteResult): Record<string, unknown> {
  return {
    saved: true,
    path: result.path,
    updated_at: result.updatedAt ?? null,
  };
}

function webuiSessionListBody(
  sessions: WebuiSessionMetadata[],
  channelName: string,
): Record<string, unknown> {
  const prefix = `${channelName}:`;
  return {
    items: sessions
      .filter((session) => session.sessionId.startsWith(prefix))
      .map((session) => ({
        key: session.sessionId,
        chat_id: session.sessionId.slice(prefix.length),
        title: compactSessionTitle(sessionMessages(session.extra)),
        created_at: session.createdAt,
        updated_at: session.updatedAt,
      })),
  };
}

function webuiDeleteSessionBody(result: WebuiDeleteSessionResult): Record<string, unknown> {
  return {
    key: result.sessionId,
    deleted: result.deleted,
  };
}

function webuiClearSessionBody(result: WebuiClearSessionResult): Record<string, unknown> {
  return {
    key: result.sessionId,
    cleared: true,
    messages_before: result.messagesBefore,
    messages_after: result.messagesAfter,
    checkpoint_cleared: result.checkpointCleared,
  };
}

async function webuiSessionMessagesBody(
  session: WebuiSessionMessages,
  sessionProvider: WebuiSessionProvider,
  traceId: string,
): Promise<Record<string, unknown>> {
  const emittedTaskPlanIds = new Set(
    session.messages
      .filter((message) => isInternalTaskNotification(message))
      .map(taskPlanIdFromMetadata)
      .filter((planId): planId is string => !!planId),
  );
  const messages: Record<string, unknown>[] = [];
  for (const message of session.messages) {
    if (isInternalAgentUiToolResult(message)) {
      continue;
    }
    if (isInternalTaskNotification(message)) {
      const planId = extractTaskPlanId(message);
      if (planId && !emittedTaskPlanIds.has(planId) && sessionProvider.getTaskProgressCard) {
        const progressCard = await sessionProvider.getTaskProgressCard(planId, traceId);
        if (progressCard) {
          messages.push(serializeWebuiMessage(progressCard));
          emittedTaskPlanIds.add(planId);
        }
      }
      continue;
    }
    messages.push(serializeWebuiMessage(message));
  }
  return {
    key: session.sessionId,
    messages,
  };
}

function webuiSessionProfileBody(session: WebuiSessionProfile): Record<string, unknown> {
  return {
    key: session.sessionId,
    profile: session.profile,
  };
}

function webuiPatchSessionBody(session: WebuiPatchSessionResult): Record<string, unknown> {
  return {
    key: session.sessionId,
    metadata: session.metadata,
    updated_at: session.updatedAt,
  };
}

function webuiTemporaryFilesBody(session: WebuiSessionTemporaryFiles): Record<string, unknown> {
  return {
    items: session.items,
    ...(typeof session.cleared === "number" ? { cleared: session.cleared } : {}),
  };
}

async function webuiTemporaryFilesClearResponse(
  sessionId: string,
  sessionProvider: WebuiSessionProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!isTemporaryFileSession(sessionId, sessionProvider)) {
    return { status: 400, body: { error: "temporary files are only supported for websocket sessions" } };
  }
  if (!sessionProvider?.clearTemporaryFiles) {
    return { status: 503, body: { error: "temporary knowledge store is not available" } };
  }
  return {
    status: 200,
    body: webuiTemporaryFilesBody(await sessionProvider.clearTemporaryFiles(sessionId, traceId)),
  };
}

async function webuiTemporaryFileUploadResponse(
  sessionId: string,
  body: unknown,
  sessionProvider: WebuiSessionProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!isTemporaryFileSession(sessionId, sessionProvider)) {
    return { status: 400, body: { error: "temporary files are only supported for websocket sessions" } };
  }
  if (!sessionProvider?.uploadTemporaryFile) {
    return { status: 503, body: { error: "temporary knowledge store is not available" } };
  }
  if (!isJsonObject(body)) {
    return { status: 400, body: { error: "file is required" } };
  }
  const upload = temporaryFileUploadFromBody(body);
  if (!upload) {
    return { status: 400, body: { error: "file is required" } };
  }
  if (!isSupportedTemporaryFileType(upload.fileType)) {
    return { status: 400, body: { error: "supported temporary file types: txt, md, pdf" } };
  }
  try {
    return { status: 200, body: await sessionProvider.uploadTemporaryFile(sessionId, upload, traceId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("supported temporary file types:")
      || message === "file is required"
      || message.includes("no extractable text")
      ? 400
      : 500;
    return { status, body: { error: status === 500 ? `failed to upload temporary file: ${message}` : message } };
  }
}

function isTemporaryFileSession(sessionId: string, sessionProvider: WebuiSessionProvider | undefined): boolean {
  const channelName = sessionProvider?.channelName ?? "websocket";
  return sessionId.startsWith(`${channelName}:`);
}

function temporaryFileUploadFromBody(body: Record<string, unknown>): WebuiTemporaryFileUpload | undefined {
  const name = stringValue(body.name) ?? stringValue(body.filename) ?? stringValue(body.file_name);
  if (!name || typeof body.content !== "string") {
    return undefined;
  }
  const content = body.content;
  const fileType = canonicalTextFileType(stringValue(body.file_type) ?? stringValue(body.fileType) ?? extensionFromName(name));
  const sizeBytes = numberValue(body.size_bytes) ?? numberValue(body.sizeBytes) ?? new TextEncoder().encode(content).length;
  return { name, fileType, content, sizeBytes };
}

function extensionFromName(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match?.[1] ?? "";
}

function canonicalTextFileType(fileType: string | undefined): string {
  const normalized = (fileType ?? "").toLowerCase().replace(/^\./, "");
  return normalized === "markdown" ? "md" : normalized;
}

function isSupportedTemporaryFileType(fileType: string): boolean {
  return fileType === "txt" || fileType === "md" || fileType === "pdf";
}

function serializeWebuiMessage(message: Record<string, unknown>): Record<string, unknown> {
  const metadata = isJsonObject(message.metadata) ? message.metadata : {};
  const payload: Record<string, unknown> = {
    role: typeof message.role === "string" ? message.role : "",
    content: message.content ?? "",
    timestamp: message.timestamp,
  };
  for (const key of WEBUI_MESSAGE_METADATA_KEYS) {
    if (key in message) {
      payload[key] = message[key];
    } else if (key in metadata) {
      payload[key] = metadata[key];
    }
  }
  return payload;
}

function compactSessionTitle(messages: Record<string, unknown>[]): string {
  for (const message of messages) {
    if (message.role !== "user" || isInternalTaskNotification(message)) {
      continue;
    }
    const content = typeof message.content === "string" ? message.content : "";
    const text = content.replace(/\s+/g, " ").trim().replace(/^[`#*_>\s-]+|[`#*_>\s-]+$/g, "");
    if (text.length === 0) {
      continue;
    }
    return text.length > 36 ? `${text.slice(0, 36).trimEnd()}...` : text;
  }
  return "";
}

function sessionMessages(extra: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(extra.messages) ? extra.messages.filter(isJsonObject) : [];
}

function isInternalTaskNotification(message: Record<string, unknown>): boolean {
  const metadata = isJsonObject(message.metadata) ? message.metadata : {};
  return message._task_event === true || metadata._task_event === true;
}

function taskPlanIdFromMetadata(message: Record<string, unknown>): string {
  const metadata = isJsonObject(message.metadata) ? message.metadata : {};
  const planId = message._task_plan_id ?? metadata._task_plan_id;
  return typeof planId === "string" ? planId : "";
}

function extractTaskPlanId(message: Record<string, unknown>): string {
  const content = typeof message.content === "string" ? message.content : "";
  return /\*\*Plan ID:\*\*\s*([A-Za-z0-9_-]+)/.exec(content)?.[1] ?? "";
}

function isInternalAgentUiToolResult(message: Record<string, unknown>): boolean {
  const metadata = isJsonObject(message.metadata) ? message.metadata : {};
  if (message._agent_ui_internal === true || metadata._agent_ui_internal === true) {
    return true;
  }
  if (message.role !== "tool" || message.name !== "request_form") {
    return false;
  }
  const content = typeof message.content === "string" ? message.content : "";
  return (
    content.includes("Agent UI form `") &&
    content.includes("requested asynchronously for WebUI chat") &&
    content.includes("Wait for the form response continuation")
  );
}

function routeKey(method: string, path: string): string {
  const knowledgeDocument = knowledgeDocumentPath(method, path);
  if (knowledgeDocument) {
    return method === "DELETE" ? "knowledge_delete_document" : "knowledge_get_document";
  }
  const approvalResolution = approvalResolutionPath(method, path);
  if (approvalResolution) {
    return approvalResolution.approved ? "approve_approval" : "deny_approval";
  }
  if (sessionMessagesPathKey(method, path) !== undefined) {
    return "get_messages";
  }
  if (sessionProfilePathKey(method, path) !== undefined) {
    return "get_profile";
  }
  if (patchSessionPathKey(method, path) !== undefined) {
    return "patch_session";
  }
  if (temporaryFilesPathKey(method, path) !== undefined) {
    if (method === "POST") {
      return "upload_temporary_file";
    }
    return method === "DELETE" ? "clear_temporary_files" : "list_temporary_files";
  }
  if (clearSessionPathKey(method, path) !== undefined) {
    return "clear_session";
  }
  if (deleteSessionPathKey(method, path) !== undefined) {
    return "delete_session";
  }
  if (coworkRoutePath(method, path)) {
    return "cowork_route";
  }
  const spec = WEBUI_ROUTE_SPECS.find((entry) => entry.method === method && entry.path === path);
  return spec?.key ?? `${method} ${path}`;
}

function coworkRoutePath(method: string, path: string): boolean {
  return (
    (method === "GET" || method === "POST" || method === "PATCH" || method === "DELETE") &&
    path.startsWith("/api/cowork/")
  );
}

function knowledgeDocumentPath(method: string, path: string): { docId: string } | undefined {
  if (method !== "GET" && method !== "DELETE") {
    return undefined;
  }
  const match = /^\/v1\/knowledge\/documents\/(.+)$/.exec(path);
  return match ? { docId: decodeURIComponent(match[1]) } : undefined;
}

function knowledgeJobPath(method: string, path: string): string | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/v1\/knowledge\/jobs\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function sessionMessagesPathKey(method: string, path: string): string | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function sessionProfilePathKey(method: string, path: string): string | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/api\/sessions\/([^/]+)\/profile$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function patchSessionPathKey(method: string, path: string): string | undefined {
  if (method !== "PATCH") {
    return undefined;
  }
  const match = /^\/api\/sessions\/([^/]+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function temporaryFilesPathKey(method: string, path: string): string | undefined {
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    return undefined;
  }
  const match = /^\/api\/sessions\/([^/]+)\/temporary-files$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function skillDetailPath(method: string, path: string): string | undefined {
  if (method !== "GET") {
    return undefined;
  }
  const match = /^\/api\/skills\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function skillUpdatePath(method: string, path: string): string | undefined {
  if (method !== "PATCH") {
    return undefined;
  }
  const match = /^\/api\/skills\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function skillDeletePath(method: string, path: string): string | undefined {
  if (method !== "DELETE") {
    return undefined;
  }
  const match = /^\/api\/skills\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function skillValidatePath(method: string, path: string): string | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/api\/skills\/(.+)\/validate$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function agentUiFormActionPath(
  method: string,
  path: string,
): { formId: string; action: WebuiAgentUiFormAction } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/api\/agent-ui\/forms\/([^/]+)\/(submit|cancel)$/.exec(path);
  if (!match) {
    return undefined;
  }
  return {
    formId: decodeURIComponent(match[1]),
    action: match[2] === "cancel" ? "cancelled" : "submitted",
  };
}

function workspaceFileRoutePath(method: string, path: string): string | undefined {
  if (method !== "GET" && method !== "PUT") {
    return undefined;
  }
  const match = /^\/api\/workspace\/files\/(.+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function clearSessionPathKey(method: string, path: string): string | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/api\/sessions\/([^/]+)\/clear$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function deleteSessionPathKey(method: string, path: string): string | undefined {
  if (method !== "DELETE") {
    return undefined;
  }
  const match = /^\/api\/sessions\/([^/]+)$/.exec(path);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function approvalResolutionPath(method: string, path: string): { approvalId: string; approved: boolean } | undefined {
  if (method !== "POST") {
    return undefined;
  }
  const match = /^\/api\/approvals\/([^/]+)\/(approve|deny)$/.exec(path);
  return match ? { approvalId: decodeURIComponent(match[1]), approved: match[2] === "approve" } : undefined;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function integerFromString(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampedNumberQuery(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
  integer: boolean,
): number | undefined {
  const parsed = queryNumberValue(value, fallback);
  if (parsed === undefined) {
    return undefined;
  }
  if (integer && (!Number.isFinite(parsed) || !Number.isInteger(parsed))) {
    return undefined;
  }
  const normalized = integer
    ? Math.trunc(parsed)
    : Number.isNaN(parsed)
      ? min
      : parsed;
  return Math.max(min, Math.min(max, normalized));
}

function queryNumberValue(value: string | null, fallback: number): number | undefined {
  if (value === null || value === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (/^[+-]?nan$/.test(normalized)) {
    return Number.NaN;
  }
  if (/^[+]?inf(?:inity)?$/.test(normalized)) {
    return Number.POSITIVE_INFINITY;
  }
  if (/^-inf(?:inity)?$/.test(normalized)) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const WEBUI_MESSAGE_METADATA_KEYS = [
  "tool_calls",
  "tool_call_id",
  "name",
  "reasoning_content",
  "_progress",
  "_tool_hint",
  "_tool_detail",
  "_tool_result",
  "_tool_name",
  "_approval_status",
  "_approval_id",
  "_task_event",
  "_task_progress",
  "_task_plan_id",
  "_memory_references",
  "_recent_context_references",
  "_agent_ui_form_id",
  "_agent_ui_form_status",
  "_agent_ui_form_display",
  "_agent_ui_form_response",
];
