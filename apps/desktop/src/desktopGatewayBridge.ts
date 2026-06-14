import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig, type GatewayConfig } from "./gatewayConfig";
import {
  createDesktopNativeWebSocket,
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
    const nativeResponse = nativeWebui
      ? await nativeWebuiFetchResponse(input, init, nativeWebui, pageOrigin)
      : undefined;
    if (nativeResponse) {
      return nativeResponse;
    }
    return originalFetch(rewriteGatewayRequest(input, config, pageOrigin), init);
  }) as FetchLike;

  function DesktopGatewayWebSocket(url: string | URL, protocols?: string | string[]) {
    if (nativeTransport && isGatewayWebSocketPath(url, pageOrigin)) {
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

async function nativeWebuiFetchResponse(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  nativeWebui: DesktopNativeWebuiFetchApi,
  pageOrigin: string,
): Promise<Response | undefined> {
  const request = await nativeWebuiRouteRequest(input, init, pageOrigin);
  if (!request) {
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
  } catch {
    return undefined;
  }
}

async function nativeWebuiRouteRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  pageOrigin: string,
): Promise<NativeWebuiRouteRequest | undefined> {
  const sourceUrl = requestUrl(input, pageOrigin);
  if (!sourceUrl || sourceUrl.origin !== pageOrigin || !isGatewayHttpPath(sourceUrl.pathname)) {
    return undefined;
  }
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
  const body = status === 204 || status === 205 || status === 304
    ? null
    : JSON.stringify(response.body ?? null);
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
