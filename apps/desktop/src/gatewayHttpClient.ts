import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gatewayConfig";
import { logDesktopNativeDebug } from "./desktopNativeChatDebug";

type FetchFn = typeof fetch;

type ClientOptions = {
  config?: GatewayConfig;
  fetchFn?: FetchFn;
  nativeSkills?: NativeSkillsApi;
};

export type NativeSkillsApi = {
  list: () => Promise<unknown>;
  detail: (name: string) => Promise<unknown>;
  create: (body: unknown) => Promise<unknown>;
  update: (name: string, body: unknown) => Promise<unknown>;
  delete: (name: string) => Promise<unknown>;
  validate: (name: string) => Promise<unknown>;
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
  const getSession = async (options: { forceBootstrap?: boolean } = {}) => {
    if (options.forceBootstrap) {
      sessionPromise = startBootstrap();
      return sessionPromise;
    }
    sessionPromise ??= startBootstrap();
    const session = await sessionPromise;
    if (!shouldRefreshSession(session)) {
      return session;
    }
    refreshPromise ??= refreshGateway(config, fetchFn, session)
      .then((result) => {
        if (result.ok) {
          return trackSession(result.session);
        }
        return startBootstrap();
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
      status: () => request("/api/status"),
    },
    sessions: {
      list: () => request("/api/sessions"),
      messages: (key: string) => request(`/api/sessions/${encodePathSegment(key)}/messages`),
      temporaryFiles: (key: string) => request(`/api/sessions/${encodePathSegment(key)}/temporary-files`),
      uploadTemporaryFile: (key: string, body: FormData) =>
        request(`/api/sessions/${encodePathSegment(key)}/temporary-files`, formRequest("POST", body)),
      delete: (key: string) => request(`/api/sessions/${encodePathSegment(key)}`, { method: "DELETE" }),
      patch: (key: string, body: unknown) =>
        request(`/api/sessions/${encodePathSegment(key)}`, jsonRequest("PATCH", body)),
      clear: (key: string) => request(`/api/sessions/${encodePathSegment(key)}/clear`, { method: "POST" }),
    },
    config: {
      get: () => request("/api/config"),
      patch: (body: unknown) => request("/api/config", jsonRequest("PATCH", body)),
      providers: () => request("/api/providers"),
      providerModels: (body: unknown) => request("/api/provider-models", jsonRequest("POST", body)),
    },
    tools: {
      list: () => request("/api/tools"),
      approvals: () => request("/api/approvals"),
      approveApproval: (approvalId: string, body: unknown) =>
        request(`/api/approvals/${encodePathSegment(approvalId)}/approve`, jsonRequest("POST", body)),
      denyApproval: (approvalId: string, body: unknown) =>
        request(`/api/approvals/${encodePathSegment(approvalId)}/deny`, jsonRequest("POST", body)),
    },
    skills: {
      list: () => nativeOrGateway(
        () => options.nativeSkills?.list(),
        () => request("/api/skills"),
        "skills.list",
      ),
      detail: (name: string) => nativeOrGateway(
        () => options.nativeSkills?.detail(name),
        () => request(`/api/skills/${encodePathSegment(name)}`),
        "skills.detail",
      ),
      create: (body: unknown) => nativeOrGateway(
        () => options.nativeSkills?.create(body),
        () => request("/api/skills", jsonRequest("POST", body)),
        "skills.create",
      ),
      update: (name: string, body: unknown) =>
        nativeOrGateway(
          () => options.nativeSkills?.update(name, body),
          () => request(`/api/skills/${encodePathSegment(name)}`, jsonRequest("PATCH", body)),
          "skills.update",
        ),
      delete: (name: string) => nativeOrGateway(
        () => options.nativeSkills?.delete(name),
        () => request(`/api/skills/${encodePathSegment(name)}`, { method: "DELETE" }),
        "skills.delete",
      ),
      validate: (name: string) => nativeOrGateway(
        () => options.nativeSkills?.validate(name),
        () => request(`/api/skills/${encodePathSegment(name)}/validate`, { method: "POST" }),
        "skills.validate",
      ),
    },
    agentUi: {
      submitForm: (formId: string, body: unknown) =>
        request(`/api/agent-ui/forms/${encodePathSegment(formId)}/submit`, jsonRequest("POST", body)),
      cancelForm: (formId: string, body: unknown) =>
        request(`/api/agent-ui/forms/${encodePathSegment(formId)}/cancel`, jsonRequest("POST", body)),
    },
    knowledge: {
      documents: () => request("/v1/knowledge/documents"),
      uploadDocument: (body: FormData) => request("/v1/knowledge/documents/upload?async_index=true", formRequest("POST", body)),
      deleteDocument: (documentId: string) => request(`/v1/knowledge/documents/${encodePathSegment(documentId)}`, { method: "DELETE" }),
      job: (jobId: string) => request(`/v1/knowledge/jobs/${encodePathSegment(jobId)}`),
      rebuildIndex: (type: string = "all") =>
        request(`/v1/knowledge/rebuild-index?type=${encodeURIComponent(type)}&async_index=true`, { method: "POST" }),
      stats: () => request("/v1/knowledge/stats"),
      graph: () => request("/v1/knowledge/graph"),
      graphrag: () => request("/v1/knowledge/graphrag?min_confidence=0&include_reports=true&include_covariates=true"),
      query: (body: unknown) => request("/v1/knowledge/query", jsonRequest("POST", body)),
    },
    workspace: {
      files: () => request("/api/workspace/files"),
      file: (path: string) => request(`/api/workspace/files/${encodePathSegment(path)}`),
      putFile: (path: string, body: unknown) =>
        request(`/api/workspace/files/${encodePathSegment(path)}`, jsonRequest("PUT", body)),
    },
    cowork: {
      sessions: (options: { includeCompleted?: boolean; originChatId?: string } = {}) => {
        const params = new URLSearchParams();
        if (options.includeCompleted) {
          params.set("include_completed", "true");
        }
        if (options.originChatId) {
          params.set("origin_chat_id", options.originChatId);
        }
        return request(`/api/cowork/sessions${params.toString() ? `?${params}` : ""}`);
      },
      session: (sessionId: string) => request(`/api/cowork/sessions/${encodePathSegment(sessionId)}`),
      summary: (sessionId: string) => request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/summary`),
      graph: (sessionId: string) => request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/graph`),
      agentActivity: (sessionId: string, agentId: string) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/agents/${encodePathSegment(agentId)}/activity`),
      observation: (sessionId: string, detailRef: string) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/observations/${encodePathSegment(detailRef)}`),
      create: (body: unknown) => request("/api/cowork/sessions", jsonRequest("POST", body)),
      run: (sessionId: string, body: unknown) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/run`, jsonRequest("POST", body)),
      action: (sessionId: string, action: "pause" | "resume" | "emergency-stop") =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/${action}`, { method: "POST" }),
      delete: (sessionId: string) => request(`/api/cowork/sessions/${encodePathSegment(sessionId)}`, { method: "DELETE" }),
      message: (sessionId: string, body: unknown) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/messages`, jsonRequest("POST", body)),
      addTask: (sessionId: string, body: unknown) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/tasks`, jsonRequest("POST", body)),
      taskAction: (sessionId: string, taskId: string, action: "assign" | "retry" | "review", body: unknown = {}) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/tasks/${encodePathSegment(taskId)}/${action}`, jsonRequest("POST", body)),
      workUnitAction: (sessionId: string, workUnitId: string, action: "retry" | "skip" | "cancel", body: unknown = {}) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/work-units/${encodePathSegment(workUnitId)}/${action}`, jsonRequest("POST", body)),
      selectBranch: (sessionId: string, branchId: string) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/branches/${encodePathSegment(branchId)}/select`, { method: "POST" }),
      selectBranchResult: (sessionId: string, branchId: string, body: unknown) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/branches/${encodePathSegment(branchId)}/result/select-final`, jsonRequest("POST", body)),
      mergeBranchResults: (sessionId: string, body: unknown) =>
        request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/branch-results/merge`, jsonRequest("POST", body)),
      validateBlueprint: (body: unknown, options: { preview?: boolean } = {}) =>
        request(`/api/cowork/blueprints/${options.preview ? "preview" : "validate"}`, jsonRequest("POST", body)),
    },
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
    const token = typeof payload.token === "string" ? payload.token : "";
    if (!token) {
      logDesktopNativeDebug("gateway.refresh.error", {
        error: "missing token",
      });
      return { ok: false, error: "refresh response missing token" };
    }
    const nextSession = {
      token,
      wsPath: typeof payload.ws_path === "string" ? payload.ws_path : session.wsPath,
      refreshTokenPath:
        typeof payload.refresh_token_path === "string" ? payload.refresh_token_path : session.refreshTokenPath,
      tokenTtlS: typeof payload.token_ttl_s === "number" ? payload.token_ttl_s : session.tokenTtlS,
    };
    logDesktopNativeDebug("gateway.refresh.complete", {
      refreshTokenPath: nextSession.refreshTokenPath,
      tokenReady: true,
      tokenTtlS: nextSession.tokenTtlS,
      wsPath: nextSession.wsPath,
    });
    return {
      ok: true,
      session: nextSession,
    };
  } catch (error) {
    logDesktopNativeDebug("gateway.refresh.error", {
      error: stringifyError(error),
    });
    return { ok: false, error: stringifyError(error) };
  } finally {
    globalThis.clearTimeout(timeout);
  }
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
): Promise<unknown> {
  const request = nativeRequest();
  if (!request) {
    return gatewayRequest();
  }
  try {
    return await request;
  } catch (error) {
    logDesktopNativeDebug(`${label}.nativeFallback`, { error: stringifyError(error) });
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

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
