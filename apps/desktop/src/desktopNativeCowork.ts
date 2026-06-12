import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeCoworkApi, NativeCoworkRouteRequest } from "./gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeCoworkApi(options: { invoke?: TauriInvoke } = {}): NativeCoworkApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    route: async (request: NativeCoworkRouteRequest) => unwrapCoworkRouteResponse(
      await invoke("worker_cowork_route", { input: request }),
    ),
  };
}

function unwrapCoworkRouteResponse(value: unknown): unknown {
  if (!isRecord(value) || typeof value.status !== "number") {
    return value;
  }
  if (value.status >= 200 && value.status < 300) {
    return value.body;
  }
  throw new Error(`Native Cowork route failed: HTTP ${value.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
