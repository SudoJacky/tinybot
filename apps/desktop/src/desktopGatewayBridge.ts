import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig, type GatewayConfig } from "./gatewayConfig";
import {
  createDesktopNativeWebSocket,
  type DesktopNativeWebSocketAgentEventListener,
} from "./desktopNativeWebSocketBridge";
import type { NativeTransportApi } from "./desktopNativeTransport";

type FetchLike = typeof fetch;
type WebSocketCtor = typeof WebSocket;

const GATEWAY_PATH_PREFIXES = ["/webui/", "/api/", "/v1/"];
const GATEWAY_PATHS = new Set(["/health", "/webui/bootstrap", "/webui/refresh-token"]);

export type DesktopGatewayBridgeOptions = {
  config?: GatewayConfig;
  pageOrigin?: string;
  fetchTarget?: typeof globalThis;
  webSocketTarget?: typeof globalThis;
  nativeTransport?: NativeTransportApi;
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
  const listenToNativeAgentEvent = options.listenToNativeAgentEvent;

  fetchTarget.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    originalFetch(rewriteGatewayRequest(input, config, pageOrigin), init)) as FetchLike;

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
