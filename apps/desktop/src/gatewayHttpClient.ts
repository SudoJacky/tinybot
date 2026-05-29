import { DEFAULT_GATEWAY_CONFIG, type GatewayConfig } from "./gatewayConfig";

type FetchFn = typeof fetch;

type ClientOptions = {
  config?: GatewayConfig;
  fetchFn?: FetchFn;
};

type WebSocketProbe = (url: string, timeoutMs: number) => Promise<ProbeResult>;

type BootstrapSession = {
  token: string;
  wsPath: string;
  refreshTokenPath: string;
  tokenTtlS: number;
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
  let sessionPromise: Promise<BootstrapSession> | null = null;
  const getSession = async () => {
    sessionPromise ??= bootstrapGateway(config, fetchFn).then((result) => {
      if (!result.ok) {
        throw new Error(`Gateway bootstrap failed: ${result.error}`);
      }
      return result.session;
    });
    return sessionPromise;
  };
  const request = async (path: string, init?: RequestInit) => {
    const session = await getSession();
    return requestJson(config, fetchFn, path, withAuth(init, session.token));
  };

  return {
    runtime: {
      status: () => request("/api/status"),
    },
    sessions: {
      list: () => request("/api/sessions"),
      messages: (key: string) => request(`/api/sessions/${encodePathSegment(key)}/messages`),
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
    },
    skills: {
      list: () => request("/api/skills"),
      detail: (name: string) => request(`/api/skills/${encodePathSegment(name)}`),
    },
    agentUi: {
      submitForm: (formId: string, body: unknown) =>
        request(`/api/agent-ui/forms/${encodePathSegment(formId)}/submit`, jsonRequest("POST", body)),
      cancelForm: (formId: string, body: unknown) =>
        request(`/api/agent-ui/forms/${encodePathSegment(formId)}/cancel`, jsonRequest("POST", body)),
    },
    knowledge: {
      documents: () => request("/v1/knowledge/documents"),
      stats: () => request("/v1/knowledge/stats"),
      graph: () => request("/v1/knowledge/graph"),
      query: (body: unknown) => request("/v1/knowledge/query", jsonRequest("POST", body)),
    },
    workspace: {
      files: () => request("/api/workspace/files"),
      file: (path: string) => request(`/api/workspace/files/${encodePathSegment(path)}`),
      putFile: (path: string, body: unknown) =>
        request(`/api/workspace/files/${encodePathSegment(path)}`, jsonRequest("PUT", body)),
    },
    cowork: {
      sessions: () => request("/api/cowork/sessions"),
      session: (sessionId: string) => request(`/api/cowork/sessions/${encodePathSegment(sessionId)}`),
      summary: (sessionId: string) => request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/summary`),
      graph: (sessionId: string) => request(`/api/cowork/sessions/${encodePathSegment(sessionId)}/graph`),
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
  try {
    const response = await fetchFn(`${config.httpBaseUrl}/webui/bootstrap`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    const token = typeof payload.token === "string" ? payload.token : "";
    if (!token) {
      return { ok: false, error: "bootstrap response missing token" };
    }
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
    return { ok: false, error: stringifyError(error) };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function requestJson(config: GatewayConfig, fetchFn: FetchFn, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchFn(`${config.httpBaseUrl}${path}`, {
    headers: {
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!response.ok) {
    throw new Error(`Gateway request failed: HTTP ${response.status}`);
  }
  return response.json();
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

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
