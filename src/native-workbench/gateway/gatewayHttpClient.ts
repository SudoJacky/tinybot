import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gatewayConfig";
import { logDesktopNativeDebug } from "../native/desktopNativeChatDebug";

type FetchFn = typeof fetch;

type ClientOptions = {
  config?: GatewayConfig;
  fetchFn?: FetchFn;
  nativeConfig?: NativeConfigApi;
  nativeKnowledge?: NativeKnowledgeApi;
  nativeSessions?: NativeSessionsApi;
  nativeSkills?: NativeSkillsApi;
  nativeWorkspace?: NativeWorkspaceApi;
  nativeCowork?: NativeCoworkApi;
  nativeWebui?: NativeWebuiApi;
  tsCoworkRuntime?: TsCoworkRuntimeRollout;
};

export type TsCoworkRuntimeRollout = {
  enabled?: boolean;
  readOnlySnapshot?: boolean;
  mutations?: boolean;
  scheduler?: boolean;
  swarm?: boolean;
};

export const DEFAULT_TS_COWORK_RUNTIME_ROLLOUT: Required<TsCoworkRuntimeRollout> = {
  enabled: true,
  readOnlySnapshot: true,
  mutations: true,
  scheduler: true,
  swarm: true,
};

export function resolveTsCoworkRuntimeRollout(config: unknown): Required<TsCoworkRuntimeRollout> {
  const desktop = asRecord(config)?.desktop;
  const rollout = asRecord(asRecord(desktop)?.tsCoworkRuntime ?? asRecord(desktop)?.ts_cowork_runtime);
  return {
    enabled: booleanValue(rollout?.enabled, DEFAULT_TS_COWORK_RUNTIME_ROLLOUT.enabled),
    readOnlySnapshot: booleanValue(
      rollout?.readOnlySnapshot ?? rollout?.read_only_snapshot,
      DEFAULT_TS_COWORK_RUNTIME_ROLLOUT.readOnlySnapshot,
    ),
    mutations: booleanValue(rollout?.mutations, DEFAULT_TS_COWORK_RUNTIME_ROLLOUT.mutations),
    scheduler: booleanValue(rollout?.scheduler, DEFAULT_TS_COWORK_RUNTIME_ROLLOUT.scheduler),
    swarm: booleanValue(rollout?.swarm, DEFAULT_TS_COWORK_RUNTIME_ROLLOUT.swarm),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export type NativeSkillsApi = {
  list: () => Promise<unknown>;
  detail: (name: string) => Promise<unknown>;
  create: (body: unknown) => Promise<unknown>;
  update: (name: string, body: unknown) => Promise<unknown>;
  delete: (name: string) => Promise<unknown>;
  validate: (name: string) => Promise<unknown>;
};

export type NativeSessionsApi = {
  list: () => Promise<unknown>;
  messages: (key: string) => Promise<unknown>;
  temporaryFiles?: (key: string) => Promise<unknown>;
  uploadTemporaryFile?: (key: string, body: unknown) => Promise<unknown>;
  clearTemporaryFiles?: (key: string) => Promise<unknown>;
  delete?: (key: string) => Promise<unknown>;
  patch?: (key: string, body: unknown) => Promise<unknown>;
  branch?: (body: unknown) => Promise<unknown>;
  clear?: (key: string) => Promise<unknown>;
  upsertTaskProgress?: (key: string, body: unknown) => Promise<unknown>;
};

export type NativeConfigApi = {
  get: () => Promise<unknown>;
};

export type NativeKnowledgeApi = {
  documents: (options?: KnowledgeDocumentsOptions) => Promise<unknown>;
  addDocument: (body: unknown) => Promise<unknown>;
  document: (documentId: string) => Promise<unknown>;
  deleteDocument: (documentId: string) => Promise<unknown>;
  job: (jobId: string) => Promise<unknown>;
  rebuildIndex: (type?: string) => Promise<unknown>;
  stats: () => Promise<unknown>;
  graph: (options?: KnowledgeGraphOptions) => Promise<unknown>;
};

export type NativeWorkspaceApi = {
  files: () => Promise<unknown>;
  file: (path: string) => Promise<unknown>;
  putFile: (path: string, body: unknown) => Promise<unknown>;
};

export type NativeCoworkRouteRequest = {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
};

export type NativeCoworkApi = {
  route: (request: NativeCoworkRouteRequest) => Promise<unknown>;
};

export type NativeWebuiRouteRequest = {
  method: string;
  path: string;
  headers?: Record<string, unknown>;
  body?: unknown;
};

export type NativeWebuiRouteResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, unknown>;
};

export type NativeWebuiApi = {
  route: (request: NativeWebuiRouteRequest) => Promise<unknown>;
  routeResponse?: (request: NativeWebuiRouteRequest) => Promise<NativeWebuiRouteResponse>;
};

export type WebuiApprovalsListOptions = {
  sessionKey?: string;
  chatId?: string;
  channel?: string;
};

export type KnowledgeDocumentsOptions = {
  category?: string;
  limit?: number;
};

export type KnowledgeGraphOptions = {
  docId?: string;
  graphType?: "document" | "entity";
  limit?: number;
  edgeLimit?: number;
  minConfidence?: number;
  includeOrphans?: boolean;
};

export type KnowledgeGraphExtractionOptions = {
  docId?: string;
  docIds?: string[];
  scope?: "all" | "selected";
  dryRun?: boolean;
  force?: boolean;
};

export type KnowledgeGraphRagOptions = {
  docId?: string;
  minConfidence?: number;
  level?: number;
  includeReports?: boolean;
  includeCovariates?: boolean;
};

type WebSocketProbe = (url: string, timeoutMs: number) => Promise<ProbeResult>;

type BootstrapSession = {
  token: string;
  wsPath: string;
  refreshTokenPath: string;
  tokenTtlS: number;
};

type TrackedSession = BootstrapSession & {
  expiresAtMs: number;
};

type ProbeResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: string;
    };

export type GatewayHealth = {
  state: "running" | "degraded" | "offline";
  httpBaseUrl: string;
  wsUrl: string;
  tokenReady: boolean;
  http: ProbeResult & {
    payload?: unknown;
  };
  webSocket: ProbeResult;
  checkedAt: string;
};

type HealthOptions = {
  config?: GatewayConfig;
  fetchFn?: FetchFn;
  webSocketProbe?: WebSocketProbe;
};

const TOKEN_REFRESH_MARGIN_MS = 60_000;

export async function checkGatewayHealth(options: HealthOptions = {}): Promise<GatewayHealth> {
  const config = options.config ?? DEFAULT_GATEWAY_CONFIG;
  const fetchFn = options.fetchFn ?? fetch;
  const bootstrap = await bootstrapGateway(config, fetchFn);
  const http = bootstrap.ok
    ? await checkHttpStatus(config, fetchFn, bootstrap.session.token)
    : { ok: false as const, error: bootstrap.error };
  const wsUrl = bootstrap.ok ? authenticatedWsUrl(config, bootstrap.session) : config.wsUrl;
  const webSocket =
    http.ok && options.webSocketProbe
      ? await options.webSocketProbe(wsUrl, config.requestTimeoutMs)
      : http.ok
        ? await probeWebSocket(wsUrl, config.requestTimeoutMs)
        : { ok: false as const, error: "HTTP status unavailable" };

  return {
    state: http.ok && webSocket.ok ? "running" : http.ok ? "degraded" : "offline",
    httpBaseUrl: config.httpBaseUrl,
    wsUrl,
    tokenReady: bootstrap.ok,
    http,
    webSocket,
    checkedAt: new Date().toISOString(),
  };
}

async function checkHttpStatus(
  config: GatewayConfig,
  fetchFn: FetchFn,
  token: string,
): Promise<GatewayHealth["http"]> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetchFn(`${config.httpBaseUrl}/api/status`, {
      headers: authHeaders(token),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true, payload: await response.json().catch(() => null) };
  } catch (error) {
    return { ok: false, error: stringifyError(error) };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function probeWebSocket(url: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timeout = globalThis.setTimeout(() => {
      socket.close();
      resolve({ ok: false, error: "WebSocket probe timed out" });
    }, timeoutMs);

    socket.addEventListener(
      "open",
      () => {
        globalThis.clearTimeout(timeout);
        socket.close();
        resolve({ ok: true });
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        globalThis.clearTimeout(timeout);
        resolve({ ok: false, error: "WebSocket connection failed" });
      },
      { once: true },
    );
  });
}

export function createGatewayApiClient(options: ClientOptions = {}) {
  const config = options.config ?? DEFAULT_GATEWAY_CONFIG;
  const fetchFn = options.fetchFn ?? fetch;
  let sessionPromise: Promise<TrackedSession> | null = null;
  let refreshPromise: Promise<TrackedSession> | null = null;
  const startBootstrap = () =>
    bootstrapGateway(config, fetchFn).then((result) => {
      if (!result.ok) {
        throw new Error(`Gateway bootstrap failed: ${result.error}`);
      }
      return trackSession(result.session);
    });
  const createBootstrapSessionPromise = () => {
    const next = startBootstrap().catch((error) => {
      if (sessionPromise === next) {
        sessionPromise = null;
      }
      throw error;
    });
    return next;
  };
  const getSession = async (sessionOptions: { forceBootstrap?: boolean } = {}) => {
    if (sessionOptions.forceBootstrap) {
      sessionPromise = createBootstrapSessionPromise();
      return sessionPromise;
    }
    sessionPromise ??= createBootstrapSessionPromise();
    const session = await sessionPromise;
    if (!shouldRefreshSession(session)) {
      return session;
    }
    refreshPromise ??= refreshGateway(config, fetchFn, session, options.nativeWebui)
      .then((result) => {
        if (result.ok) {
          return trackSession(result.session);
        }
        const nextSessionPromise = createBootstrapSessionPromise();
        sessionPromise = nextSessionPromise;
        return nextSessionPromise;
      })
      .then((nextSession) => {
        sessionPromise = Promise.resolve(nextSession);
        return nextSession;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };
  const request = async (path: string, init?: RequestInit) => {
    const session = await getSession();
    try {
      return await requestJson(config, fetchFn, path, withAuth(init, session.token));
    } catch (error) {
      if (!isGatewayUnauthorizedError(error)) {
        throw error;
      }
      const freshSession = await getSession({ forceBootstrap: true });
      return requestJson(config, fetchFn, path, withAuth(init, freshSession.token));
    }
  };

  return {
    runtime: {
      status: () => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "GET", path: "/api/status" }),
        () => request("/api/status"),
        "webui.status",
      ),
    },
    openAi: {
      health: () => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "GET", path: "/health" }),
        () => request("/health"),
        "openai.health",
      ),
      models: () => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "GET", path: "/v1/models" }),
        () => request("/v1/models"),
        "openai.models",
      ),
      chatCompletions: (body: unknown) => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "POST", path: "/v1/chat/completions", body }),
        () => request("/v1/chat/completions", jsonRequest("POST", body)),
        "openai.chatCompletions",
      ),
    },
    sessions: {
      list: () => nativeOrGateway(
        () => options.nativeSessions?.list() ?? options.nativeWebui?.route({ method: "GET", path: "/api/sessions" }),
        () => request("/api/sessions"),
        "webui.sessions.list",
      ),
      messages: (key: string) => nativeOrGateway(
        () => options.nativeSessions?.messages(key) ?? options.nativeWebui?.route({ method: "GET", path: `/api/sessions/${encodePathSegment(key)}/messages` }),
        () => request(`/api/sessions/${encodePathSegment(key)}/messages`),
        "webui.sessions.messages",
      ),
      profile: (key: string) => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "GET", path: `/api/sessions/${encodePathSegment(key)}/profile` }),
        () => request(`/api/sessions/${encodePathSegment(key)}/profile`),
        "webui.sessions.profile",
      ),
      temporaryFiles: (key: string) => nativeOrGateway(
        () => options.nativeSessions?.temporaryFiles?.(key) ?? options.nativeWebui?.route({
          method: "GET",
          path: `/api/sessions/${encodePathSegment(key)}/temporary-files`,
        }),
        () => request(`/api/sessions/${encodePathSegment(key)}/temporary-files`),
        "webui.sessions.temporaryFiles",
      ),
      uploadTemporaryFile: (key: string, body: FormData) => nativeOrGateway(
        () => {
          const uploadBody = nativeTemporaryFileUploadBody(body);
          if (!uploadBody) {
            return undefined;
          }
          if (options.nativeSessions?.uploadTemporaryFile) {
            return uploadBody.then((payload) => options.nativeSessions?.uploadTemporaryFile?.(key, payload));
          }
          return options.nativeWebui
            ? uploadBody.then((payload) => options.nativeWebui?.route({
              method: "POST",
              path: `/api/sessions/${encodePathSegment(key)}/temporary-files`,
              body: payload,
            }))
            : undefined;
        },
        () => request(`/api/sessions/${encodePathSegment(key)}/temporary-files`, formRequest("POST", body)),
        "webui.sessions.uploadTemporaryFile",
      ),
      clearTemporaryFiles: (key: string) => nativeOrGateway(
        () => options.nativeSessions?.clearTemporaryFiles?.(key) ?? options.nativeWebui?.route({
          method: "DELETE",
          path: `/api/sessions/${encodePathSegment(key)}/temporary-files`,
        }),
        () => request(`/api/sessions/${encodePathSegment(key)}/temporary-files`, { method: "DELETE" }),
        "webui.sessions.clearTemporaryFiles",
      ),
      delete: (key: string) => nativeOrGateway(
        () => options.nativeSessions?.delete?.(key) ?? options.nativeWebui?.route({ method: "DELETE", path: `/api/sessions/${encodePathSegment(key)}` }),
        () => request(`/api/sessions/${encodePathSegment(key)}`, { method: "DELETE" }),
        "webui.sessions.delete",
      ),
      patch: (key: string, body: unknown) => nativeOrGateway(
        () => options.nativeSessions?.patch?.(key, body) ?? options.nativeWebui?.route({
          method: "PATCH",
          path: `/api/sessions/${encodePathSegment(key)}`,
          body,
        }),
        () => request(`/api/sessions/${encodePathSegment(key)}`, jsonRequest("PATCH", body)),
        "webui.sessions.patch",
      ),
      branch: (body: unknown) => nativeOrGateway(
        () => options.nativeSessions?.branch?.(body) ?? options.nativeWebui?.route({
          method: "POST",
          path: "/api/sessions/branch",
          body,
        }),
        () => request("/api/sessions/branch", jsonRequest("POST", body)),
        "webui.sessions.branch",
      ),
      clear: (key: string) => nativeOrGateway(
        () => options.nativeSessions?.clear?.(key) ?? options.nativeWebui?.route({
          method: "POST",
          path: `/api/sessions/${encodePathSegment(key)}/clear`,
        }),
        () => request(`/api/sessions/${encodePathSegment(key)}/clear`, { method: "POST" }),
        "webui.sessions.clear",
      ),
    },
    config: {
      get: () => nativeOrGateway(
        () => options.nativeConfig?.get() ?? options.nativeWebui?.route({ method: "GET", path: "/api/config" }),
        () => request("/api/config"),
        "webui.config.get",
      ),
      patch: (body: unknown) => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "PATCH", path: "/api/config", body }),
        () => request("/api/config", jsonRequest("PATCH", body)),
        "webui.config.patch",
      ),
      providers: () => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "GET", path: "/api/providers" }),
        () => request("/api/providers"),
        "webui.providers",
      ),
      providerModels: (body: unknown) => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "POST", path: "/api/provider-models", body }),
        () => request("/api/provider-models", jsonRequest("POST", body)),
        "webui.providerModels",
      ),
    },
    tools: {
      list: () => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "GET", path: "/api/tools" }),
        () => request("/api/tools"),
        "webui.tools.list",
      ),
      approvals: (approvalOptions?: WebuiApprovalsListOptions) => {
        const path = approvalsListPath(approvalOptions);
        return nativeOrGateway(
          () => options.nativeWebui?.route({ method: "GET", path }),
          () => request(path),
          "webui.approvals.list",
        );
      },
      approveApproval: (approvalId: string, body: unknown) => {
        const path = `/api/approvals/${encodePathSegment(approvalId)}/approve`;
        return nativeOrGateway(
          () => options.nativeWebui?.route({ method: "POST", path, body: nativeWebuiApprovalBody(body) }),
          () => request(path, jsonRequest("POST", body)),
          "webui.approvals.approve",
        );
      },
      denyApproval: (approvalId: string, body: unknown) => {
        const path = `/api/approvals/${encodePathSegment(approvalId)}/deny`;
        return nativeOrGateway(
          () => options.nativeWebui?.route({ method: "POST", path, body: nativeWebuiApprovalBody(body) }),
          () => request(path, jsonRequest("POST", body)),
          "webui.approvals.deny",
        );
      },
    },
    skills: {
      list: () => nativeOrGateway(
        () => options.nativeSkills?.list() ?? options.nativeWebui?.route({ method: "GET", path: "/api/skills" }),
        () => request("/api/skills"),
        "skills.list",
      ),
      detail: (name: string) => nativeOrGateway(
        () => options.nativeSkills?.detail(name) ?? options.nativeWebui?.route({
          method: "GET",
          path: `/api/skills/${encodePathSegment(name)}`,
        }),
        () => request(`/api/skills/${encodePathSegment(name)}`),
        "skills.detail",
      ),
      create: (body: unknown) => nativeOrGateway(
        () => options.nativeSkills?.create(body)
          ?? options.nativeWebui?.route({ method: "POST", path: "/api/skills", body }),
        () => request("/api/skills", jsonRequest("POST", body)),
        "skills.create",
      ),
      update: (name: string, body: unknown) =>
        nativeOrGateway(
          () => options.nativeSkills?.update(name, body) ?? options.nativeWebui?.route({
            method: "PATCH",
            path: `/api/skills/${encodePathSegment(name)}`,
            body,
          }),
          () => request(`/api/skills/${encodePathSegment(name)}`, jsonRequest("PATCH", body)),
          "skills.update",
        ),
      delete: (name: string) => nativeOrGateway(
        () => options.nativeSkills?.delete(name) ?? options.nativeWebui?.route({
          method: "DELETE",
          path: `/api/skills/${encodePathSegment(name)}`,
        }),
        () => request(`/api/skills/${encodePathSegment(name)}`, { method: "DELETE" }),
        "skills.delete",
      ),
      validate: (name: string) => nativeOrGateway(
        () => options.nativeSkills?.validate(name) ?? options.nativeWebui?.route({
          method: "POST",
          path: `/api/skills/${encodePathSegment(name)}/validate`,
        }),
        () => request(`/api/skills/${encodePathSegment(name)}/validate`, { method: "POST" }),
        "skills.validate",
      ),
    },
    agentUi: {
      submitForm: (formId: string, body: unknown) => {
        const path = `/api/agent-ui/forms/${encodePathSegment(formId)}/submit`;
        return nativeOrGateway(
          () => options.nativeWebui?.route({ method: "POST", path, body }),
          () => request(path, jsonRequest("POST", body)),
          "webui.agentUi.submitForm",
        );
      },
      cancelForm: (formId: string, body: unknown) => {
        const path = `/api/agent-ui/forms/${encodePathSegment(formId)}/cancel`;
        return nativeOrGateway(
          () => options.nativeWebui?.route({ method: "POST", path, body }),
          () => request(path, jsonRequest("POST", body)),
          "webui.agentUi.cancelForm",
        );
      },
    },
    knowledge: {
      documents: (documentOptions: KnowledgeDocumentsOptions = {}) => {
        const path = knowledgeDocumentsPath(documentOptions);
        return nativeOrGateway(
          () => options.nativeKnowledge?.documents(documentOptions) ?? options.nativeWebui?.route({ method: "GET", path }),
          () => request(path),
          "knowledge.documents",
          false,
        );
      },
      addDocument: (body: unknown) => nativeOrGateway(
        () => options.nativeKnowledge?.addDocument(body)
          ?? options.nativeWebui?.route({ method: "POST", path: "/v1/knowledge/documents", body }),
        () => request("/v1/knowledge/documents", jsonRequest("POST", body)),
        "knowledge.addDocument",
        false,
      ),
      document: (documentId: string) => {
        const path = `/v1/knowledge/documents/${encodePathSegment(documentId)}`;
        return nativeOrGateway(
          () => options.nativeKnowledge?.document(documentId) ?? options.nativeWebui?.route({ method: "GET", path }),
          () => request(path),
          "knowledge.document",
          false,
        );
      },
      uploadDocument: (body: FormData) => nativeOrGateway(
        () => {
          if (options.nativeKnowledge) {
            const uploadBody = nativeKnowledgeUploadBody(body);
            return uploadBody
              ? uploadBody.then((payload) => options.nativeKnowledge?.addDocument(payload))
              : Promise.reject(new Error("Native Knowledge uploads only support txt, md, json, and csv files."));
          }
          if (!options.nativeWebui) {
            return undefined;
          }
          const uploadBody = nativeKnowledgeUploadBody(body);
          return uploadBody
            ? uploadBody.then((payload) => options.nativeWebui?.route({
              method: "POST",
              path: "/v1/knowledge/documents/upload?async_index=true",
              body: payload,
            }))
            : Promise.reject(new Error("Native Knowledge uploads only support txt, md, json, and csv files."));
        },
        () => request("/v1/knowledge/documents/upload?async_index=true", formRequest("POST", body)),
        "knowledge.uploadDocument",
        false,
      ),
      deleteDocument: (documentId: string) => {
        const path = `/v1/knowledge/documents/${encodePathSegment(documentId)}`;
        return nativeOrGateway(
          () => options.nativeKnowledge?.deleteDocument(documentId) ?? options.nativeWebui?.route({ method: "DELETE", path }),
          () => request(path, { method: "DELETE" }),
          "knowledge.deleteDocument",
          false,
        );
      },
      job: (jobId: string) => {
        const path = `/v1/knowledge/jobs/${encodePathSegment(jobId)}`;
        return nativeOrGateway(
          () => options.nativeKnowledge?.job(jobId) ?? options.nativeWebui?.route({ method: "GET", path }),
          () => request(path),
          "knowledge.job",
          false,
        );
      },
      rebuildIndex: (type: string = "all") => {
        const path = `/v1/knowledge/rebuild-index?type=${encodeURIComponent(type)}&async_index=true`;
        return nativeOrGateway(
          () => options.nativeKnowledge?.rebuildIndex(type) ?? options.nativeWebui?.route({ method: "POST", path }),
          () => request(path, { method: "POST" }),
          "knowledge.rebuildIndex",
          false,
        );
      },
      stats: () => nativeOrGateway(
        () => options.nativeKnowledge?.stats() ?? options.nativeWebui?.route({ method: "GET", path: "/v1/knowledge/stats" }),
        () => request("/v1/knowledge/stats"),
        "knowledge.stats",
        false,
      ),
      graph: (graphOptions: KnowledgeGraphOptions = {}) => {
        const path = knowledgeGraphPath(graphOptions);
        return nativeOrGateway(
          () => options.nativeKnowledge?.graph(graphOptions) ?? options.nativeWebui?.route({ method: "GET", path }),
          () => request(path),
          "knowledge.graph",
          false,
        );
      },
      extractGraph: (extractOptions: KnowledgeGraphExtractionOptions) => {
        const body = {
          ...(extractOptions.docId ? { doc_id: extractOptions.docId } : {}),
          ...(extractOptions.docIds?.length ? { doc_ids: extractOptions.docIds } : {}),
          ...(extractOptions.scope ? { scope: extractOptions.scope } : {}),
          ...(typeof extractOptions.dryRun === "boolean" ? { dry_run: extractOptions.dryRun } : {}),
          ...(typeof extractOptions.force === "boolean" ? { force: extractOptions.force } : {}),
        };
        return nativeOrGateway(
          () => options.nativeWebui?.route({
            method: "POST",
            path: "/v1/knowledge/graph/extract",
            body,
          }),
          () => request("/v1/knowledge/graph/extract", jsonRequest("POST", body)),
          "knowledge.extractGraph",
          false,
        );
      },
      graphrag: (graphRagOptions: KnowledgeGraphRagOptions = {}) => {
        const path = knowledgeGraphRagPath(graphRagOptions);
        return nativeOrGateway(
          () => options.nativeWebui?.route({
            method: "GET",
            path,
          }),
          () => request(path),
          "knowledge.graphrag",
          false,
        );
      },
      query: (body: unknown) => nativeOrGateway(
        () => options.nativeWebui?.route({ method: "POST", path: "/v1/knowledge/query", body }),
        () => request("/v1/knowledge/query", jsonRequest("POST", body)),
        "knowledge.query",
        false,
      ),
    },
    workspace: {
      files: () => nativeOrGateway(
        () => options.nativeWorkspace?.files() ?? options.nativeWebui?.route({ method: "GET", path: "/api/workspace/files" }),
        () => request("/api/workspace/files"),
        "webui.workspace.files",
      ),
      file: (path: string) => {
        const routePath = `/api/workspace/files/${encodePathSegment(path)}`;
        return nativeOrGateway(
          () => options.nativeWorkspace?.file(path) ?? options.nativeWebui?.route({ method: "GET", path: routePath }),
          () => request(routePath),
          "webui.workspace.file",
        );
      },
      putFile: (path: string, body: unknown) => {
        const routePath = `/api/workspace/files/${encodePathSegment(path)}`;
        return nativeOrGateway(
          () => options.nativeWorkspace?.putFile(path, body) ?? options.nativeWebui?.route({ method: "PUT", path: routePath, body }),
          () => request(routePath, jsonRequest("PUT", body)),
          "webui.workspace.putFile",
        );
      },
    },
    cowork: {
      sessions: (sessionOptions: { includeCompleted?: boolean; originChatId?: string } = {}) => {
        const params = new URLSearchParams();
        if (sessionOptions.includeCompleted) {
          params.set("include_completed", "true");
        }
        if (sessionOptions.originChatId) {
          params.set("origin_chat_id", sessionOptions.originChatId);
        }
        const path = `/api/cowork/sessions${params.toString() ? `?${params}` : ""}`;
        return coworkNativeOrGateway(
          options.nativeCowork,
          options.tsCoworkRuntime,
          request,
          "GET",
          path,
          undefined,
          "cowork.sessions",
        );
      },
      session: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}`,
        undefined,
        "cowork.session",
      ),
      summary: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/summary`,
        undefined,
        "cowork.summary",
      ),
      graph: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/graph`,
        undefined,
        "cowork.graph",
      ),
      agentActivity: (sessionId: string, agentId: string, activityOptions: { limit?: number } = {}) => {
        const params = new URLSearchParams();
        if (activityOptions.limit !== undefined) {
          params.set("limit", String(activityOptions.limit));
        }
        const path = `/api/cowork/sessions/${encodePathSegment(sessionId)}/agents/${encodePathSegment(agentId)}/activity${params.toString() ? `?${params}` : ""}`;
        return coworkNativeOrGateway(
          options.nativeCowork,
          options.tsCoworkRuntime,
          request,
          "GET",
          path,
          undefined,
          "cowork.agentActivity",
        );
      },
      observation: (sessionId: string, detailRef: string, observationOptions: { requesterAgentId?: string } = {}) => {
        const params = new URLSearchParams();
        if (observationOptions.requesterAgentId) {
          params.set("agent_id", observationOptions.requesterAgentId);
        }
        const path = `/api/cowork/sessions/${encodePathSegment(sessionId)}/observations/${encodePathSegment(detailRef)}${params.toString() ? `?${params}` : ""}`;
        return coworkNativeOrGateway(
          options.nativeCowork,
          options.tsCoworkRuntime,
          request,
          "GET",
          path,
          undefined,
          "cowork.observation",
        );
      },
      blueprint: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/blueprint`,
        undefined,
        "cowork.blueprint",
      ),
      trace: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/trace`,
        undefined,
        "cowork.trace",
      ),
      dag: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/dag`,
        undefined,
        "cowork.dag",
      ),
      artifacts: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/artifacts`,
        undefined,
        "cowork.artifacts",
      ),
      organization: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/organization`,
        undefined,
        "cowork.organization",
      ),
      queues: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/queues`,
        undefined,
        "cowork.queues",
      ),
      branches: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "GET",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/branches`,
        undefined,
        "cowork.branches",
      ),
      create: (body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        "/api/cowork/sessions",
        body,
        "cowork.create",
      ),
      run: (sessionId: string, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/run`,
        body,
        "cowork.run",
      ),
      updateBudget: (sessionId: string, body: unknown, budgetOptions: { method?: "POST" | "PATCH" } = {}) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        budgetOptions.method ?? "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/budget`,
        body,
        "cowork.updateBudget",
      ),
      action: (sessionId: string, action: "pause" | "resume" | "emergency-stop", body?: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/${action}`,
        body,
        `cowork.${action}`,
      ),
      delete: (sessionId: string) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "DELETE",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}`,
        undefined,
        "cowork.delete",
      ),
      message: (sessionId: string, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/messages`,
        body,
        "cowork.message",
      ),
      addTask: (sessionId: string, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/tasks`,
        body,
        "cowork.addTask",
      ),
      taskAction: (sessionId: string, taskId: string, action: "assign" | "retry" | "review", body: unknown = {}) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/tasks/${encodePathSegment(taskId)}/${action}`,
        body,
        `cowork.task.${action}`,
      ),
      workUnitAction: (sessionId: string, workUnitId: string, action: "retry" | "skip" | "cancel", body: unknown = {}) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/work-units/${encodePathSegment(workUnitId)}/${action}`,
        body,
        `cowork.workUnit.${action}`,
      ),
      selectBranch: (sessionId: string, branchId: string, body: unknown = undefined) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/branches/${encodePathSegment(branchId)}/select`,
        body,
        "cowork.selectBranch",
      ),
      deriveBranch: (sessionId: string, sourceBranchId: string | null, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        sourceBranchId
          ? `/api/cowork/sessions/${encodePathSegment(sessionId)}/branches/${encodePathSegment(sourceBranchId)}/derive`
          : `/api/cowork/sessions/${encodePathSegment(sessionId)}/branches/derive`,
        body,
        "cowork.deriveBranch",
      ),
      selectBranchResult: (sessionId: string, branchId: string, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/branches/${encodePathSegment(branchId)}/result/select-final`,
        body,
        "cowork.selectBranchResult",
      ),
      mergeBranchResults: (sessionId: string, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/branch-results/merge`,
        body,
        "cowork.mergeBranchResults",
      ),
      selectFinalResult: (sessionId: string, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/final-result/select`,
        body,
        "cowork.selectFinalResult",
      ),
      mergeFinalResult: (sessionId: string, body: unknown) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/sessions/${encodePathSegment(sessionId)}/final-result/merge`,
        body,
        "cowork.mergeFinalResult",
      ),
      validateBlueprint: (body: unknown, validateOptions: { preview?: boolean } = {}) => coworkNativeOrGateway(
        options.nativeCowork,
        options.tsCoworkRuntime,
        request,
        "POST",
        `/api/cowork/blueprints/${validateOptions.preview ? "preview" : "validate"}`,
        body,
        "cowork.validateBlueprint",
      ),
    },
  };
}

function coworkNativeOrGateway(
  nativeCowork: NativeCoworkApi | undefined,
  _rollout: TsCoworkRuntimeRollout | undefined,
  request: (path: string, init?: RequestInit) => Promise<unknown>,
  method: string,
  path: string,
  body: unknown,
  label: string,
): Promise<unknown> {
  const nativeRequest = nativeCoworkRouteRequest(method, path, body);
  const gatewayInit = method === "GET"
    ? undefined
    : body === undefined
      ? { method }
      : jsonRequest(method, body);
  if (!nativeCowork) {
    return request(path, gatewayInit);
  }
  return nativeOrGateway(
    () => nativeCowork.route(nativeRequest),
    () => request(path, gatewayInit),
    label,
    false,
  );
}

function nativeCoworkRouteRequest(method: string, path: string, body: unknown): NativeCoworkRouteRequest {
  const url = new URL(path, "http://desktop.local");
  const query = Object.fromEntries(url.searchParams.entries());
  return {
    method,
    path: url.pathname,
    ...(Object.keys(query).length ? { query } : {}),
    ...(body === undefined ? {} : { body }),
  };
}

async function bootstrapGateway(
  config: GatewayConfig,
  fetchFn: FetchFn,
): Promise<
  | {
      ok: true;
      session: BootstrapSession;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), config.requestTimeoutMs);
  logDesktopNativeDebug("gateway.bootstrap.start", {
    httpBaseUrl: config.httpBaseUrl,
    timeoutMs: config.requestTimeoutMs,
  });
  try {
    const response = await fetchFn(`${config.httpBaseUrl}/webui/bootstrap`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      logDesktopNativeDebug("gateway.bootstrap.error", {
        status: response.status,
      });
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    const token = typeof payload.token === "string" ? payload.token : "";
    if (!token) {
      logDesktopNativeDebug("gateway.bootstrap.error", {
        error: "missing token",
      });
      return { ok: false, error: "bootstrap response missing token" };
    }
    logDesktopNativeDebug("gateway.bootstrap.complete", {
      refreshTokenPath: typeof payload.refresh_token_path === "string" ? payload.refresh_token_path : "/webui/refresh-token",
      tokenReady: true,
      tokenTtlS: typeof payload.token_ttl_s === "number" ? payload.token_ttl_s : 300,
      wsPath: typeof payload.ws_path === "string" ? payload.ws_path : "/ws",
    });
    return {
      ok: true,
      session: {
        token,
        wsPath: typeof payload.ws_path === "string" ? payload.ws_path : "/ws",
        refreshTokenPath:
          typeof payload.refresh_token_path === "string" ? payload.refresh_token_path : "/webui/refresh-token",
        tokenTtlS: typeof payload.token_ttl_s === "number" ? payload.token_ttl_s : 300,
      },
    };
  } catch (error) {
    logDesktopNativeDebug("gateway.bootstrap.error", {
      error: stringifyError(error),
    });
    return { ok: false, error: stringifyError(error) };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function refreshGateway(
  config: GatewayConfig,
  fetchFn: FetchFn,
  session: BootstrapSession,
  nativeWebui?: NativeWebuiApi,
): Promise<
  | {
      ok: true;
      session: BootstrapSession;
    }
  | {
      ok: false;
      error: string;
    }
> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), config.requestTimeoutMs);
  logDesktopNativeDebug("gateway.refresh.start", {
    refreshTokenPath: session.refreshTokenPath,
    timeoutMs: config.requestTimeoutMs,
  });
  try {
    if (nativeWebui) {
      try {
        const payload = await nativeWebui.route({
          method: "POST",
          path: session.refreshTokenPath,
          headers: { Authorization: `Bearer ${session.token}` },
        });
        const parsed = parseRefreshSessionPayload(payload, session);
        if (!parsed.ok) {
          logDesktopNativeDebug("gateway.refresh.nativeFallback", { error: parsed.error });
        } else {
          logDesktopNativeDebug("gateway.refresh.complete", {
            refreshTokenPath: parsed.session.refreshTokenPath,
            tokenReady: true,
            tokenTtlS: parsed.session.tokenTtlS,
            wsPath: parsed.session.wsPath,
          });
          return parsed;
        }
      } catch (error) {
        logDesktopNativeDebug("gateway.refresh.nativeFallback", { error: stringifyError(error) });
      }
    }
    const response = await fetchFn(`${config.httpBaseUrl}${session.refreshTokenPath}`, {
      method: "POST",
      headers: authHeaders(session.token),
      signal: controller.signal,
    });
    if (!response.ok) {
      logDesktopNativeDebug("gateway.refresh.error", {
        status: response.status,
      });
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    const parsed = parseRefreshSessionPayload(payload, session);
    if (!parsed.ok) {
      logDesktopNativeDebug("gateway.refresh.error", {
        error: parsed.error,
      });
      return parsed;
    }
    logDesktopNativeDebug("gateway.refresh.complete", {
      refreshTokenPath: parsed.session.refreshTokenPath,
      tokenReady: true,
      tokenTtlS: parsed.session.tokenTtlS,
      wsPath: parsed.session.wsPath,
    });
    return parsed;
  } catch (error) {
    logDesktopNativeDebug("gateway.refresh.error", {
      error: stringifyError(error),
    });
    return { ok: false, error: stringifyError(error) };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function parseRefreshSessionPayload(
  payload: unknown,
  previousSession: BootstrapSession,
): { ok: true; session: BootstrapSession } | { ok: false; error: string } {
  const record = asRecord(payload);
  const token = typeof record?.token === "string" ? record.token : "";
  if (!token) {
    return { ok: false, error: "refresh response missing token" };
  }
  return {
    ok: true,
    session: {
      token,
      wsPath: typeof record?.ws_path === "string" ? record.ws_path : previousSession.wsPath,
      refreshTokenPath: typeof record?.refresh_token_path === "string"
        ? record.refresh_token_path
        : previousSession.refreshTokenPath,
      tokenTtlS: typeof record?.token_ttl_s === "number" ? record.token_ttl_s : previousSession.tokenTtlS,
    },
  };
}

async function requestJson(config: GatewayConfig, fetchFn: FetchFn, path: string, init?: RequestInit): Promise<unknown> {
  const method = init?.method ?? "GET";
  logDesktopNativeDebug("gateway.http.request", {
    method,
    path,
  });
  const response = await fetchFn(`${config.httpBaseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    logDesktopNativeDebug("gateway.http.error", {
      method,
      path,
      status: response.status,
    });
    throw new GatewayRequestError(response.status);
  }
  const payload = await response.json();
  logDesktopNativeDebug("gateway.http.response", {
    method,
    path,
    status: response.status,
  });
  return payload;
}

class GatewayRequestError extends Error {
  constructor(readonly status: number) {
    super(`Gateway request failed: HTTP ${status}`);
  }
}

function isGatewayUnauthorizedError(error: unknown): boolean {
  return error instanceof GatewayRequestError && error.status === 401;
}

function trackSession(session: BootstrapSession): TrackedSession {
  return {
    ...session,
    expiresAtMs: Date.now() + session.tokenTtlS * 1000,
  };
}

async function nativeOrGateway(
  nativeRequest: () => Promise<unknown> | undefined,
  gatewayRequest: () => Promise<unknown>,
  label: string,
  fallbackToGateway = true,
): Promise<unknown> {
  const request = nativeRequest();
  if (!request) {
    return gatewayRequest();
  }
  try {
    return await request;
  } catch (error) {
    logDesktopNativeDebug(`${label}.nativeFallback`, { error: stringifyError(error) });
    if (!fallbackToGateway) {
      throw error;
    }
    return gatewayRequest();
  }
}

function shouldRefreshSession(session: TrackedSession): boolean {
  return Date.now() + TOKEN_REFRESH_MARGIN_MS >= session.expiresAtMs;
}

function authenticatedWsUrl(config: GatewayConfig, session: BootstrapSession): string {
  const url = new URL(session.wsPath, config.httpBaseUrl);
  url.protocol = url.protocol.replace(/^http/, "ws");
  url.searchParams.set("token", session.token);
  return url.toString();
}

function authHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
  };
}

function withAuth(init: RequestInit = {}, token: string): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function formRequest(method: string, body: FormData): RequestInit {
  return {
    method,
    body,
  };
}

function nativeTemporaryFileUploadBody(body: FormData): Promise<Record<string, unknown>> | undefined {
  const file = body.get("file");
  if (!(file instanceof File)) {
    return undefined;
  }
  const fileType = canonicalNativeTextFileType(extensionFromName(file.name));
  if (!fileType || !["txt", "md"].includes(fileType)) {
    return undefined;
  }
  return file.text().then((content) => ({
    name: file.name,
    file_type: fileType,
    content,
    size_bytes: file.size,
  }));
}

function nativeKnowledgeUploadBody(body: FormData): Promise<Record<string, unknown>> | undefined {
  const file = body.get("file");
  if (!(file instanceof File)) {
    return undefined;
  }
  const fileType = canonicalNativeTextFileType(extensionFromName(file.name));
  if (!fileType) {
    return undefined;
  }
  return file.text().then((content) => {
    const payload: Record<string, unknown> = {
      name: file.name,
      file_type: fileType,
      content,
      size_bytes: file.size,
    };
    const category = formString(body.get("category"));
    if (category) {
      payload.category = category;
    }
    const tags = formString(body.get("tags"));
    if (tags) {
      payload.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    }
    return payload;
  });
}

function formString(value: FormDataEntryValue | null): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function canonicalNativeTextFileType(fileType: string): string | undefined {
  if (fileType === "markdown") {
    return "md";
  }
  if (["txt", "md", "json", "csv"].includes(fileType)) {
    return fileType;
  }
  return undefined;
}

function extensionFromName(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match?.[1]?.toLowerCase() ?? "";
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvalsListPath(options: WebuiApprovalsListOptions | undefined): string {
  const params = new URLSearchParams();
  if (options?.sessionKey) {
    params.set("session_key", options.sessionKey);
  }
  if (options?.chatId) {
    params.set("chat_id", options.chatId);
  }
  if (options?.channel) {
    params.set("channel", options.channel);
  }
  const query = params.toString();
  return query ? `/api/approvals?${query}` : "/api/approvals";
}

function nativeWebuiApprovalBody(body: unknown): unknown {
  if (!isRecord(body) || typeof body.session_key !== "string") {
    return body;
  }
  return {
    ...body,
    session_key: normalizeNativeWebuiSessionKey(body.session_key),
  };
}

function normalizeNativeWebuiSessionKey(sessionKey: string): string {
  return sessionKey.startsWith("WebSocket:")
    ? `websocket:${sessionKey.slice("WebSocket:".length)}`
    : sessionKey;
}

function knowledgeDocumentsPath(options: KnowledgeDocumentsOptions): string {
  const params = new URLSearchParams();
  if (options.category) {
    params.set("category", options.category);
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(options.limit));
  }
  const query = params.toString();
  return query ? `/v1/knowledge/documents?${query}` : "/v1/knowledge/documents";
}

function knowledgeGraphPath(options: KnowledgeGraphOptions): string {
  const params = new URLSearchParams();
  if (options.docId) {
    params.set("doc_id", options.docId);
  }
  if (options.graphType) {
    params.set("graph_type", options.graphType);
  }
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(options.limit));
  }
  if (typeof options.edgeLimit === "number" && Number.isFinite(options.edgeLimit)) {
    params.set("edge_limit", String(options.edgeLimit));
  }
  if (typeof options.minConfidence === "number" && Number.isFinite(options.minConfidence)) {
    params.set("min_confidence", String(options.minConfidence));
  }
  if (typeof options.includeOrphans === "boolean") {
    params.set("include_orphans", String(options.includeOrphans));
  }
  const query = params.toString();
  return query ? `/v1/knowledge/graph?${query}` : "/v1/knowledge/graph";
}

function knowledgeGraphRagPath(options: KnowledgeGraphRagOptions): string {
  const params = new URLSearchParams();
  if (options.docId) {
    params.set("doc_id", options.docId);
  }
  const minConfidence = typeof options.minConfidence === "number" && Number.isFinite(options.minConfidence)
    ? options.minConfidence
    : 0;
  params.set("min_confidence", String(minConfidence));
  if (typeof options.level === "number" && Number.isFinite(options.level)) {
    params.set("level", String(options.level));
  }
  params.set("include_reports", String(options.includeReports ?? true));
  params.set("include_covariates", String(options.includeCovariates ?? true));
  return `/v1/knowledge/graphrag?${params}`;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
