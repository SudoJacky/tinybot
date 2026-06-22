import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig, type GatewayConfig } from "./gatewayConfig";
import {
  createDesktopNativeWebSocket,
  type DesktopNativeWebSocketAgentEventName,
  type DesktopNativeWebSocketAgentEventListener,
} from "./desktopNativeWebSocketBridge";
import type { NativeTransportApi } from "./desktopNativeTransport";
import type {
  NativeWebuiApi,
  NativeWebuiRouteRequest,
  NativeWebuiRouteResponse,
} from "./gatewayHttpClient";

type FetchLike = typeof fetch;
type WebSocketCtor = typeof WebSocket;
type DesktopNativeWebuiFetchApi = {
  route?: NativeWebuiApi["route"];
  routeResponse?: NativeWebuiApi["routeResponse"];
};

const GATEWAY_PATH_PREFIXES = ["/webui/", "/api/", "/v1/"];
const GATEWAY_PATHS = new Set(["/health", "/webui/bootstrap", "/webui/refresh-token"]);

export type DesktopGatewayBridgeOptions = {
  config?: GatewayConfig;
  pageOrigin?: string;
  fetchTarget?: typeof globalThis;
  webSocketTarget?: typeof globalThis;
  nativeTransport?: NativeTransportApi;
  nativeWebui?: DesktopNativeWebuiFetchApi;
  resolveNativeWebSocketSessionExists?: (sessionId: string) => Promise<boolean | undefined> | boolean | undefined;
  listenToNativeAgentEvent?: DesktopNativeWebSocketAgentEventListener;
};

export type DesktopGatewayBridge = {
  restore: () => void;
};

export function isGatewayHttpPath(pathname: string): boolean {
  return GATEWAY_PATHS.has(pathname) || GATEWAY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function rewriteGatewayRequest(
  input: RequestInfo | URL,
  config: GatewayConfig = DEFAULT_GATEWAY_CONFIG,
  pageOrigin = globalThis.location?.origin ?? "http://localhost",
): RequestInfo | URL {
  const sourceUrl = requestUrl(input, pageOrigin);
  if (!sourceUrl || sourceUrl.origin !== pageOrigin || !isGatewayHttpPath(sourceUrl.pathname)) {
    return input;
  }

  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}${sourceUrl.hash}`, config.httpBaseUrl);
  if (input instanceof Request) {
    return new Request(targetUrl, input);
  }
  if (input instanceof URL) {
    return targetUrl;
  }
  return targetUrl.toString();
}

export function rewriteGatewayWebSocketUrl(
  input: string | URL,
  config: GatewayConfig = DEFAULT_GATEWAY_CONFIG,
  pageOrigin = globalThis.location?.origin ?? "http://localhost",
): string | URL {
  const sourceUrl = requestUrl(input, pageOrigin);
  if (!sourceUrl || !isSamePageEndpoint(sourceUrl, pageOrigin) || sourceUrl.pathname !== "/ws") {
    return input;
  }
  const wsBase = config.wsUrl.endsWith("/ws") ? config.wsUrl.slice(0, -3) : config.wsUrl;
  const targetUrl = new URL(`${sourceUrl.pathname}${sourceUrl.search}${sourceUrl.hash}`, wsBase);
  targetUrl.protocol = targetUrl.protocol.replace(/^http/, "ws");
  return input instanceof URL ? targetUrl : targetUrl.toString();
}

export function isGatewayWebSocketPath(
  input: string | URL,
  pageOrigin = globalThis.location?.origin ?? "http://localhost",
): boolean {
  const sourceUrl = requestUrl(input, pageOrigin);
  return Boolean(sourceUrl && isSamePageEndpoint(sourceUrl, pageOrigin) && sourceUrl.pathname === "/ws");
}

function isSamePageEndpoint(url: URL, pageOrigin: string): boolean {
  const pageUrl = new URL(pageOrigin);
  return url.hostname === pageUrl.hostname && url.port === pageUrl.port;
}

export function installDesktopGatewayBridge(options: DesktopGatewayBridgeOptions = {}): DesktopGatewayBridge {
  const config = resolveGatewayConfig(options.config ?? DEFAULT_GATEWAY_CONFIG);
  const pageOrigin = options.pageOrigin ?? globalThis.location.origin;
  const fetchTarget = options.fetchTarget ?? globalThis;
  const webSocketTarget = options.webSocketTarget ?? globalThis;
  const originalFetch = fetchTarget.fetch.bind(fetchTarget) as FetchLike;
  const OriginalWebSocket = webSocketTarget.WebSocket as WebSocketCtor;
  const nativeTransport = options.nativeTransport;
  const nativeWebui = options.nativeWebui;
  const listenToNativeAgentEvent = options.listenToNativeAgentEvent;

  fetchTarget.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const nativeStreamingResponse = nativeTransport && listenToNativeAgentEvent
      ? await nativeOpenAiStreamingFetchResponse(input, init, nativeTransport, listenToNativeAgentEvent, pageOrigin)
      : undefined;
    if (nativeStreamingResponse) {
      return nativeStreamingResponse;
    }
    const nativeResponse = nativeWebui
      ? await nativeWebuiFetchResponse(input, init, nativeWebui, pageOrigin)
      : undefined;
    if (nativeResponse) {
      return nativeResponse;
    }
    return originalFetch(rewriteGatewayRequest(input, config, pageOrigin), init);
  }) as FetchLike;

  function DesktopGatewayWebSocket(url: string | URL, protocols?: string | string[]) {
    if (nativeTransport && isNativeGatewayWebSocketTarget(url, pageOrigin, config)) {
      return createDesktopNativeWebSocket({
        url,
        protocols,
        nativeTransport,
        resolveSessionExists: options.resolveNativeWebSocketSessionExists,
        listenToAgentEvent: listenToNativeAgentEvent,
      });
    }
    return new OriginalWebSocket(rewriteGatewayWebSocketUrl(url, config, pageOrigin), protocols);
  }
  Object.assign(DesktopGatewayWebSocket, {
    CONNECTING: OriginalWebSocket.CONNECTING,
    OPEN: OriginalWebSocket.OPEN,
    CLOSING: OriginalWebSocket.CLOSING,
    CLOSED: OriginalWebSocket.CLOSED,
  });
  DesktopGatewayWebSocket.prototype = OriginalWebSocket.prototype;
  webSocketTarget.WebSocket = DesktopGatewayWebSocket as unknown as WebSocketCtor;

  return {
    restore: () => {
      fetchTarget.fetch = originalFetch;
      webSocketTarget.WebSocket = OriginalWebSocket;
    },
  };
}

function isNativeGatewayWebSocketTarget(
  input: string | URL,
  pageOrigin: string,
  config: GatewayConfig,
): boolean {
  const sourceUrl = requestUrl(input, pageOrigin);
  return Boolean(sourceUrl && (
    (isSamePageEndpoint(sourceUrl, pageOrigin) && sourceUrl.pathname === "/ws")
    || isConfiguredGatewayWebSocketUrl(sourceUrl, config)
  ));
}

function isConfiguredGatewayWebSocketUrl(sourceUrl: URL, config: GatewayConfig): boolean {
  const gatewayUrl = new URL(config.wsUrl);
  return sourceUrl.protocol === gatewayUrl.protocol
    && sourceUrl.hostname === gatewayUrl.hostname
    && sourceUrl.port === gatewayUrl.port
    && sourceUrl.pathname === gatewayUrl.pathname;
}

async function nativeWebuiFetchResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  nativeWebui: DesktopNativeWebuiFetchApi,
  pageOrigin: string,
): Promise<Response | undefined> {
  const sourceUrl = requestUrl(input, pageOrigin);
  if (!sourceUrl || sourceUrl.origin !== pageOrigin || !isGatewayHttpPath(sourceUrl.pathname)) {
    return undefined;
  }
  const request = await nativeWebuiRouteRequestForUrl(sourceUrl, input, init);
  if (!request) {
    if (isNativeOnlyGatewayPath(sourceUrl.pathname)) {
      return nativeOnlyGatewayErrorResponse(
        415,
        `Native WebUI route does not support this request body: ${sourceUrl.pathname}`,
      );
    }
    return undefined;
  }
  try {
    const response = nativeWebui.routeResponse
      ? await nativeWebui.routeResponse(request)
      : nativeWebui.route
        ? { status: 200, body: await nativeWebui.route(request) }
        : undefined;
    if (!response) {
      return undefined;
    }
    return webuiFetchResponse(response);
  } catch (error) {
    if (isNativeOnlyGatewayPath(sourceUrl.pathname)) {
      return nativeOnlyGatewayErrorResponse(
        502,
        `Native WebUI route failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return undefined;
  }
}

async function nativeOpenAiStreamingFetchResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  nativeTransport: NativeTransportApi,
  listenToAgentEvent: DesktopNativeWebSocketAgentEventListener,
  pageOrigin: string,
): Promise<Response | undefined> {
  const sourceUrl = requestUrl(input, pageOrigin);
  if (!sourceUrl || sourceUrl.origin !== pageOrigin || sourceUrl.pathname !== "/v1/chat/completions") {
    return undefined;
  }
  const request = await nativeWebuiRouteRequestForUrl(sourceUrl, input, init);
  if (!request || !isRecord(request.body) || request.body.stream !== true) {
    return undefined;
  }
  const content = openAiUserMessageContent(request.body.messages);
  if (!content) {
    return undefined;
  }
  const chatId = stringValue(request.body.session_id) || "default";
  const runId = `openai-chat-${sanitizeRunIdPart(chatId)}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  const model = stringValue(request.body.model);
  const encoder = new TextEncoder();
  const unlisteners: Array<() => void> = [];
  let closed = false;
  let emittedContent = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (text: string) => {
        if (!closed) {
          controller.enqueue(encoder.encode(text));
        }
      };
      const close = () => {
        if (!closed) {
          closed = true;
          controller.close();
          while (unlisteners.length) {
            unlisteners.pop()?.();
          }
        }
      };
      const listen = (eventName: DesktopNativeWebSocketAgentEventName, handler: (payload: Record<string, unknown>) => void) => {
        const unlisten = listenToAgentEvent(eventName, (payload) => {
          const record = isRecord(payload) ? payload : {};
          if ((stringValue(record.runId) || stringValue(record.run_id)) === runId) {
            handler(record);
          }
        });
        if (typeof unlisten === "function") {
          unlisteners.push(unlisten);
        } else if (unlisten && typeof (unlisten as Promise<() => void>).then === "function") {
          void (unlisten as Promise<() => void>).then((resolved) => {
            if (closed) {
              resolved();
            } else {
              unlisteners.push(resolved);
            }
          });
        }
      };

      listen("agent.delta", (payload) => {
        const delta = stringValue(payload.delta) || stringValue(payload.text) || stringValue(payload.content);
        if (!delta) {
          return;
        }
        emittedContent = true;
        enqueue(openAiSseData(openAiChatCompletionChunk(model, { content: delta })));
      });
      listen("agent.reasoning_delta", (payload) => {
        const delta = stringValue(payload.delta) || stringValue(payload.text) || stringValue(payload.content);
        if (delta) {
          enqueue(openAiSseData(openAiChatCompletionChunk(model, { reasoning_content: delta })));
        }
      });
      listen("agent.done", () => {
        enqueue(openAiSseData({
          ...openAiChatCompletionChunk(model, {}),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }));
        enqueue("data: [DONE]\n\n");
        close();
      });
      listen("agent.error", (payload) => {
        enqueue(openAiSseData({
          error: { message: stringValue(payload.message) || "agent error" },
        }));
        enqueue("data: [DONE]\n\n");
        close();
      });

      void nativeTransport.dispatchWebsocketMessage({
        clientId: "openai-sse",
        frame: { type: "message", chat_id: chatId, content },
        attachedChatId: chatId,
        sessionExists: true,
        model,
        runId,
        stream: true,
      }).then((result) => {
        if (closed) {
          return;
        }
        const agent = isRecord(result) && isRecord(result.agent) ? result.agent : {};
        const finalContent = stringValue(agent.finalContent) || stringValue(agent.final_content);
        if (!emittedContent && finalContent) {
          enqueue(openAiSseData(openAiChatCompletionChunk(model, { content: finalContent })));
        }
        enqueue(openAiSseData({
          ...openAiChatCompletionChunk(model, {}),
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        }));
        enqueue("data: [DONE]\n\n");
        close();
      }).catch((error) => {
        if (closed) {
          return;
        }
        enqueue(openAiSseData({
          error: { message: error instanceof Error ? error.message : String(error) },
        }));
        enqueue("data: [DONE]\n\n");
        close();
      });
    },
    cancel() {
      closed = true;
      while (unlisteners.length) {
        unlisteners.pop()?.();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

async function nativeWebuiRouteRequestForUrl(
  sourceUrl: URL,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<NativeWebuiRouteRequest | undefined> {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = headersRecord(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const body = await jsonFetchBody(input, init, headers);
  if (body.unsupported) {
    return undefined;
  }
  return {
    method,
    path: `${sourceUrl.pathname}${sourceUrl.search}`,
    ...(headers ? { headers } : {}),
    ...(body.value !== undefined ? { body: body.value } : {}),
  };
}

function isNativeOnlyGatewayPath(pathname: string): boolean {
  return pathname === "/v1/knowledge" || pathname.startsWith("/v1/knowledge/");
}

function nativeOnlyGatewayErrorResponse(status: number, message: string): Response {
  return webuiFetchResponse({
    status,
    body: {
      error: {
        message,
      },
    },
  });
}

async function jsonFetchBody(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Record<string, unknown> | undefined,
): Promise<{ value?: unknown; unsupported?: boolean }> {
  const rawBody = init?.body;
  if (rawBody === undefined || rawBody === null) {
    if (input instanceof Request && input.method !== "GET" && input.method !== "HEAD") {
      const text = await input.clone().text();
      return parseJsonFetchBody(text, headers);
    }
    return {};
  }
  if (typeof rawBody === "string") {
    return parseJsonFetchBody(rawBody, headers);
  }
  return { unsupported: true };
}

function parseJsonFetchBody(text: string, headers: Record<string, unknown> | undefined): { value?: unknown; unsupported?: boolean } {
  if (text.length === 0) {
    return {};
  }
  if (!hasJsonContentType(headers)) {
    return { unsupported: true };
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { unsupported: true };
  }
}

function hasJsonContentType(headers: Record<string, unknown> | undefined): boolean {
  const contentType = Object.entries(headers ?? {})
    .find(([key]) => key.toLowerCase() === "content-type")?.[1];
  return typeof contentType === "string" && contentType.toLowerCase().includes("json");
}

function headersRecord(headers: HeadersInit | undefined): Record<string, unknown> | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    const result: Record<string, unknown> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return Object.keys(result).length > 0 ? result : undefined;
  }
  if (Array.isArray(headers)) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = String(value);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function webuiFetchResponse(response: NativeWebuiRouteResponse): Response {
  const status = response.status;
  const responseHeaders = headersRecordFromUnknown(response.headers);
  const contentType = headerValue(responseHeaders, "content-type");
  const body = status === 204 || status === 205 || status === 304
    ? null
    : contentType?.toLowerCase().includes("text/event-stream") && typeof response.body === "string"
      ? response.body
      : JSON.stringify(response.body ?? null);
  return new Response(body, {
    status,
    headers: responseHeaders ?? { "Content-Type": "application/json" },
  });
}

function headersRecordFromUnknown(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = String(value);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function openAiUserMessageContent(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length !== 1 || !isRecord(messages[0]) || messages[0].role !== "user") {
    return "";
  }
  const content = messages[0].content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => isRecord(part) && part.type === "text" ? stringValue(part.text) : "")
    .filter(Boolean)
    .join(" ");
}

function openAiSseData(value: Record<string, unknown>): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

function openAiChatCompletionChunk(model: string, delta: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `chatcmpl-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };
}

function sanitizeRunIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-") || "default";
}

function requestUrl(input: RequestInfo | URL, pageOrigin: string): URL | null {
  try {
    if (input instanceof Request) {
      return new URL(input.url, pageOrigin);
    }
    return new URL(String(input), pageOrigin);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
