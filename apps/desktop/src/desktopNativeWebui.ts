import type { NativeWebuiRouteRequest, NativeWebuiRouteResponse } from "./gatewayHttpClient";

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeWebuiApi(options: { invoke: InvokeFn }) {
  const routeResponse = (request: NativeWebuiRouteRequest) =>
    options.invoke("worker_webui_route", { input: request }).then(normalizeWebuiRouteResponse);
  return {
    route: (request: NativeWebuiRouteRequest) => routeResponse(request).then(unwrapWebuiRouteResponse),
    routeResponse,
  };
}

function normalizeWebuiRouteResponse(value: unknown): NativeWebuiRouteResponse {
  if (!isRecord(value) || typeof value.status !== "number") {
    return { status: 200, body: value };
  }
  return { status: value.status, body: value.body };
}

function unwrapWebuiRouteResponse(response: NativeWebuiRouteResponse): unknown {
  if (response.status >= 200 && response.status < 300) {
    return response.body;
  }
  throw new Error(`Native WebUI route failed: HTTP ${response.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
