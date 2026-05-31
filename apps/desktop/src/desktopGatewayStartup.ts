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
  const externalBootstrap = await fetchBootstrap(config, deps);
  if (externalBootstrap.ok) {
    return null;
  }

  if (!(deps.hasTauriRuntime ?? hasTauriRuntime)()) {
    throw new Error(`Gateway is unreachable and Tauri runtime commands are unavailable: ${externalBootstrap.error}`);
  }

  const beforeStart = await deps.invoke("gateway_status");
  if (beforeStart.http_ok) {
    return beforeStart;
  }

  const started = await deps.invoke("start_gateway");
  const ready = await waitForBootstrap(config, 30_000, deps);
  if (!ready.ok) {
    throw new Error(
      `Gateway did not become ready after start_gateway. Last status: ${started.state}/${started.owner}. ${ready.error}`,
    );
  }
  return deps.invoke("gateway_status");
}

async function waitForBootstrap(config: GatewayConfig, timeoutMs: number, deps: GatewayStartupDeps): Promise<BootstrapResult> {
  const now = deps.now ?? Date.now;
  const delay = deps.delay ?? defaultDelay;
  const startedAt = now();
  let lastError = "not checked";
  while (now() - startedAt < timeoutMs) {
    const result = await fetchBootstrap(config, deps);
    if (result.ok) {
      return { ok: true };
    }
    lastError = result.error;
    await delay(500);
  }
  return { ok: false, error: lastError };
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

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
