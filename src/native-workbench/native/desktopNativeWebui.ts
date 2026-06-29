import type { NativeWebuiRouteRequest, NativeWebuiRouteResponse } from "../gateway/gatewayHttpClient";
import { logDesktopNativeDebug } from "./desktopNativeChatDebug";

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeWebuiApi(options: { invoke: InvokeFn; now?: () => number }) {
  const now = options.now ?? readMonotonicNow;
  const routeResponse = async (request: NativeWebuiRouteRequest) => {
    const startedAt = now();
    logDesktopNativeDebug("nativeWebui.route.start", summarizeRouteRequest(request));
    try {
      const response = normalizeWebuiRouteResponse(await options.invoke("worker_webui_route", { input: request }));
      logDesktopNativeDebug("nativeWebui.route.complete", {
        ...summarizeRouteRequest(request),
        durationMs: roundedDuration(now() - startedAt),
        status: response.status,
      });
      return response;
    } catch (error) {
      logDesktopNativeDebug("nativeWebui.route.failed", {
        ...summarizeRouteRequest(request),
        durationMs: roundedDuration(now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  return {
    route: (request: NativeWebuiRouteRequest) => routeResponse(request).then(unwrapWebuiRouteResponse),
    routeResponse,
  };
}

function normalizeWebuiRouteResponse(value: unknown): NativeWebuiRouteResponse {
  if (!isRecord(value) || typeof value.status !== "number") {
    return { status: 200, body: value };
  }
  return {
    status: value.status,
    body: value.body,
    headers: isRecord(value.headers) ? value.headers : undefined,
  };
}

function unwrapWebuiRouteResponse(response: NativeWebuiRouteResponse): unknown {
  if (response.status >= 200 && response.status < 300) {
    return response.body;
  }
  throw new Error(nativeWebuiRouteErrorMessage(response));
}

function nativeWebuiRouteErrorMessage(response: NativeWebuiRouteResponse): string {
  const body = isRecord(response.body) ? response.body : {};
  const error = isRecord(body.error) ? body.error : {};
  return typeof error.message === "string" && error.message.trim()
    ? error.message
    : `Native WebUI route failed: HTTP ${response.status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeRouteRequest(request: NativeWebuiRouteRequest): Record<string, unknown> {
  return {
    method: request.method,
    path: request.path,
  };
}

function readMonotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function roundedDuration(value: number): number {
  return Math.round(value * 10) / 10;
}
