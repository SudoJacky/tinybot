import type { GatewayConfig } from "./gatewayConfig";

export type GatewayRuntimeStatus = {
  state: "running" | "starting" | "offline" | "failed";
  owner: "shell" | "external" | "none";
  http_ok: boolean;
  gateway_http: string;
  gateway_ws: string;
  command: string;
  port?: number | string | null;
  repo_root: string;
  logs: string[];
  last_error: string | null;
  exit_policy?: "stop_on_exit" | "keep_running" | string | null;
  bootstrap_status?: "ready" | "offline" | "incompatible" | "bootstrap_error" | string | null;
  response_class?: string | null;
  recovery_hint?: string | null;
  worker_runtime?: DesktopWorkerRuntimeStatus | null;
};

export type DesktopWorkerRuntimeStatus = {
  state: "stopped" | "starting" | "running" | "failed" | "incompatible" | string;
  transport_mode?: "stdio" | "local_pipe" | string | null;
  diagnostics?: Array<{ stream: string; line: string }>;
  last_error?: string | null;
  recovery_hint?: string | null;
  gateway_compatibility_available?: boolean;
};

type BootstrapResult = { ok: true } | { ok: false; error: string };

export type GatewayStartupDeps = {
  fetchFn?: typeof fetch;
  invoke: (command: "gateway_status" | "start_gateway") => Promise<GatewayRuntimeStatus>;
  hasTauriRuntime?: () => boolean;
  setTimeoutFn?: typeof window.setTimeout;
  clearTimeoutFn?: typeof window.clearTimeout;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
};

export async function ensureGatewayReady(
  config: GatewayConfig,
  deps: GatewayStartupDeps,
): Promise<GatewayRuntimeStatus | null> {
  if ((deps.hasTauriRuntime ?? hasTauriRuntime)()) {
    const status = await deps.invoke("gateway_status");
    if (status.state === "running") {
      return status;
    }
    return deps.invoke("start_gateway");
  }

  const externalBootstrap = await fetchBootstrap(config, deps);
  if (externalBootstrap.ok) {
    return null;
  }

  throw new Error(`Gateway is unreachable and Tauri runtime commands are unavailable: ${externalBootstrap.error}`);
}

async function fetchBootstrap(config: GatewayConfig, deps: GatewayStartupDeps): Promise<BootstrapResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const controller = new AbortController();
  const setTimeoutFn = deps.setTimeoutFn ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = deps.clearTimeoutFn ?? globalThis.clearTimeout.bind(globalThis);
  const timeout = setTimeoutFn(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetchFn(`${config.httpBaseUrl}/webui/bootstrap`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const text = await response.text();
    let payload: { token?: unknown };
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, error: "bootstrap response is not valid JSON" };
    }
    if (typeof payload?.token !== "string" || !payload.token) {
      return { ok: false, error: "bootstrap response missing token" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: stringifyError(error) };
  } finally {
    clearTimeoutFn(timeout);
  }
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in globalThis;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
