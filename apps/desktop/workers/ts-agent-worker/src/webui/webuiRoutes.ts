import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";

export type WebuiRouteSpec = {
  key: string;
  method: string;
  path: string;
  public: boolean;
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
  providerId: string;
  model?: string;
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
  ): Promise<WebuiWorkspaceWriteResult> | WebuiWorkspaceWriteResult;
};

const WEBUI_ROUTE_SPECS: WebuiRouteSpec[] = [
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
];

export function webuiRouteSpecs(): WebuiRouteSpec[] {
  return WEBUI_ROUTE_SPECS.map((spec) => ({ ...spec }));
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
  traceId = "webui-route",
): Promise<WebuiRouteResponse> {
  const method = request.method.toUpperCase();
  const url = new URL(request.path, "http://worker.local");
  const path = url.pathname;
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
    return { status: 200, body: await skillsProvider.listSkills(traceId) };
  }
  if (method === "POST" && path === "/api/skills") {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "create_skill" } };
    }
    const body = isJsonObject(request.body) ? request.body : {};
    return { status: 200, body: await skillsProvider.createSkill(body, traceId) };
  }
  const skillValidationName = skillValidatePath(method, path);
  if (skillValidationName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "validate_skill" } };
    }
    return { status: 200, body: await skillsProvider.validateSkill(skillValidationName, traceId) };
  }
  const skillUpdateName = skillUpdatePath(method, path);
  if (skillUpdateName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "update_skill" } };
    }
    const body = isJsonObject(request.body) ? request.body : {};
    return { status: 200, body: await skillsProvider.updateSkill(skillUpdateName, body, traceId) };
  }
  const skillDeleteName = skillDeletePath(method, path);
  if (skillDeleteName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "delete_skill" } };
    }
    return { status: 200, body: await skillsProvider.deleteSkill(skillDeleteName, traceId) };
  }
  const skillName = skillDetailPath(method, path);
  if (skillName !== undefined) {
    if (!skillsProvider) {
      return { status: 503, body: { error: "webui control route unavailable", route: "get_skill_detail" } };
    }
    return { status: 200, body: await skillsProvider.getSkillDetail(skillName, traceId) };
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
    return { status: 200, body: webuiSessionMessagesBody(session) };
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
    provider: status.provider,
    model: status.model,
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
  if (body !== undefined && !isJsonObject(body)) {
    return { status: 400, body: { ok: false, error: "payload must be a dict" } };
  }
  const payload = isJsonObject(body) ? body : {};
  const providerId = stringValue(payload.provider) ?? stringValue(payload.providerId) ?? stringValue(payload.provider_id);
  if (!providerId) {
    return { status: 200, body: { ok: false, error: "provider is required" } };
  }
  if (!providerModelsProvider) {
    return { status: 200, body: { ok: false, error: "config is required" } };
  }
  try {
    const result = await providerModelsProvider.listProviderModels(
      {
        providerId: providerId.trim().toLowerCase(),
        ...(stringValue(payload.model) ? { model: stringValue(payload.model) } : {}),
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
  const values = payload.values === undefined ? {} : payload.values;
  if (!isJsonObject(values)) {
    return { status: 400, body: { error: "values must be a dict" } };
  }
  if (!agentUiFormProvider) {
    return { status: 503, body: { error: "webui control route unavailable", route: agentUiFormRouteKey(formAction.action) } };
  }
  try {
    return {
      status: 200,
      body: await agentUiFormProvider.continueForm(
        {
          formId: formAction.formId,
          sessionId,
          action: formAction.action,
          values,
          correlation,
        },
        traceId,
      ),
    };
  } catch (error) {
    return {
      status: 409,
      body: {
        error: "form continuation unavailable",
        detail: error instanceof Error ? error.message : String(error),
      },
    };
  }
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
    const result = await workspaceProvider.writeFile(path, payload.content, traceId);
    return { status: 200, body: webuiWorkspaceWriteBody(result) };
  } catch (error) {
    return { status: 404, body: { error: error instanceof Error ? error.message : String(error) } };
  }
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

function webuiSessionMessagesBody(session: WebuiSessionMessages): Record<string, unknown> {
  return {
    key: session.sessionId,
    messages: session.messages
      .filter((message) => !isInternalAgentUiToolResult(message))
      .filter((message) => !isInternalTaskNotification(message))
      .map(serializeWebuiMessage),
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
  };
}

async function webuiTemporaryFileUploadResponse(
  sessionId: string,
  body: unknown,
  sessionProvider: WebuiSessionProvider | undefined,
  traceId: string,
): Promise<WebuiRouteResponse> {
  if (!sessionId.startsWith("websocket:")) {
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

function temporaryFileUploadFromBody(body: Record<string, unknown>): WebuiTemporaryFileUpload | undefined {
  const name = stringValue(body.name) ?? stringValue(body.filename) ?? stringValue(body.file_name);
  const content = stringValue(body.content);
  if (!name || content === undefined) {
    return undefined;
  }
  const fileType = (stringValue(body.file_type) ?? stringValue(body.fileType) ?? extensionFromName(name)).toLowerCase().replace(/^\./, "");
  const sizeBytes = numberValue(body.size_bytes) ?? numberValue(body.sizeBytes) ?? new TextEncoder().encode(content).length;
  return { name, fileType, content, sizeBytes };
}

function extensionFromName(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match?.[1] ?? "";
}

function isSupportedTemporaryFileType(fileType: string): boolean {
  return fileType === "txt" || fileType === "md" || fileType === "pdf";
}

function serializeWebuiMessage(message: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    role: typeof message.role === "string" ? message.role : "",
    content: message.content ?? "",
    timestamp: message.timestamp,
  };
  for (const key of WEBUI_MESSAGE_METADATA_KEYS) {
    if (key in message) {
      payload[key] = message[key];
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

function isInternalAgentUiToolResult(message: Record<string, unknown>): boolean {
  if (message._agent_ui_internal === true) {
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
    return method === "POST" ? "upload_temporary_file" : "list_temporary_files";
  }
  if (clearSessionPathKey(method, path) !== undefined) {
    return "clear_session";
  }
  if (deleteSessionPathKey(method, path) !== undefined) {
    return "delete_session";
  }
  const spec = WEBUI_ROUTE_SPECS.find((entry) => entry.method === method && entry.path === path);
  return spec?.key ?? `${method} ${path}`;
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
  if (method !== "GET" && method !== "POST") {
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
