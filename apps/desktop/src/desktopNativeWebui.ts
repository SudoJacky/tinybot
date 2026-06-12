import type { NativeWebuiRouteRequest } from "./gatewayHttpClient";

type InvokeFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeWebuiApi(options: { invoke: InvokeFn }) {
  return {
    route: (request: NativeWebuiRouteRequest) =>
      options.invoke("worker_webui_route", { input: request }).then(unwrapWebuiRouteResponse),
  };
}

function unwrapWebuiRouteResponse(value: unknown): unknown {
  if (!isRecord(value) || typeof value.status !== "number") {
    return value;
  }
  if (value.status >= 200 && value.status < 300) {
    return value.body;
  }
  throw new Error(`Native WebUI route failed: HTTP ${value.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
