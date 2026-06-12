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
  clearSession?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiClearSessionResult> | WebuiClearSessionResult;
  deleteSession?(
    sessionId: string,
    traceId: string,
  ): Promise<WebuiDeleteSessionResult> | WebuiDeleteSessionResult;
};

const WEBUI_ROUTE_SPECS: WebuiRouteSpec[] = [
  { key: "get_status", method: "GET", path: "/api/status", public: false },
  { key: "list_sessions", method: "GET", path: "/api/sessions", public: false },
  { key: "get_messages", method: "GET", path: "/api/sessions/{key}/messages", public: false },
  { key: "get_profile", method: "GET", path: "/api/sessions/{key}/profile", public: false },
  { key: "patch_session", method: "PATCH", path: "/api/sessions/{key}", public: false },
  { key: "delete_session", method: "DELETE", path: "/api/sessions/{key}", public: false },
  { key: "clear_session", method: "POST", path: "/api/sessions/{key}/clear", public: false },
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
  if (sessionMessagesPathKey(method, path) !== undefined) {
    return "get_messages";
  }
  if (sessionProfilePathKey(method, path) !== undefined) {
    return "get_profile";
  }
  if (patchSessionPathKey(method, path) !== undefined) {
    return "patch_session";
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

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
