import { isJsonObject, type JsonObject } from "../protocol/messages.ts";

export type WebuiRouteSpec = {
  key: string;
  method: string;
  path: string;
  public: boolean;
};

export type WebuiRouteRequest = {
  method: string;
  path: string;
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

export type WebuiSessionMetadata = {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  extra: Record<string, unknown>;
};

export type WebuiSessionProvider = {
  channelName?: string;
  listSessions(traceId: string): Promise<WebuiSessionMetadata[]> | WebuiSessionMetadata[];
};

const WEBUI_ROUTE_SPECS: WebuiRouteSpec[] = [
  { key: "get_status", method: "GET", path: "/api/status", public: false },
  { key: "list_sessions", method: "GET", path: "/api/sessions", public: false },
];

export function webuiRouteSpecs(): WebuiRouteSpec[] {
  return WEBUI_ROUTE_SPECS.map((spec) => ({ ...spec }));
}

export async function handleWebuiRouteRequest(
  request: WebuiRouteRequest,
  statusProvider: WebuiStatusProvider | undefined,
  sessionProvider?: WebuiSessionProvider,
  traceId = "webui-route",
): Promise<WebuiRouteResponse> {
  const method = request.method.toUpperCase();
  const path = new URL(request.path, "http://worker.local").pathname;
  if (method === "GET" && path === "/api/status") {
    return { status: 200, body: webuiStatusBody(await resolveStatus(statusProvider)) };
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
  return params.body === undefined ? { method, path } : { method, path, body: params.body };
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

function routeKey(method: string, path: string): string {
  const spec = WEBUI_ROUTE_SPECS.find((entry) => entry.method === method && entry.path === path);
  return spec?.key ?? `${method} ${path}`;
}

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
