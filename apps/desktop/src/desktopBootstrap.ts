import { invoke } from "@tauri-apps/api/core";
import webUiHtml from "../../../webui/index.html?raw";
import { installDesktopGatewayBridge } from "./desktopGatewayBridge";
import { installWebUiRenderGlobals } from "./desktopMarkdownGlobals";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig, type GatewayConfig } from "./gatewayConfig";

type GatewayRuntimeStatus = {
  state: "running" | "starting" | "offline";
  owner: "shell" | "external" | "none";
  http_ok: boolean;
  gateway_http: string;
  gateway_ws: string;
  command: string;
  repo_root: string;
  logs: string[];
  last_error: string | null;
};

const gatewayConfig = resolveGatewayConfig(DEFAULT_GATEWAY_CONFIG);
const WEBUI_ENTRY = "/assets/src/main.js";

document.addEventListener("DOMContentLoaded", () => {
  bindRetry();
  void bootDesktopWebUi();
});

async function bootDesktopWebUi(): Promise<void> {
  setStartupState("Starting local gateway...", null, false);
  try {
    const status = await ensureGatewayReady(gatewayConfig);
    installDesktopGatewayBridge({ config: gatewayConfig });
    installWebUiRenderGlobals();
    installWebUiShell(webUiHtml);
    await import(/* @vite-ignore */ WEBUI_ENTRY);
    console.info("Tinybot desktop WebUI initialized", status);
  } catch (error) {
    setStartupState(
      "Tinybot gateway is not ready.",
      `${stringifyError(error)}\n\nGateway: ${gatewayConfig.httpBaseUrl}`,
      true,
    );
  }
}

async function ensureGatewayReady(config: GatewayConfig): Promise<GatewayRuntimeStatus | null> {
  const externalBootstrap = await fetchBootstrap(config);
  if (externalBootstrap.ok) {
    return null;
  }

  if (!hasTauriRuntime()) {
    throw new Error(`Gateway is unreachable and Tauri runtime commands are unavailable: ${externalBootstrap.error}`);
  }

  const beforeStart = await invoke<GatewayRuntimeStatus>("gateway_status");
  if (beforeStart.http_ok) {
    return beforeStart;
  }

  const started = await invoke<GatewayRuntimeStatus>("start_gateway");
  const ready = await waitForBootstrap(config, 30_000);
  if (!ready.ok) {
    throw new Error(
      `Gateway did not become ready after start_gateway. Last status: ${started.state}/${started.owner}. ${ready.error}`,
    );
  }
  return invoke<GatewayRuntimeStatus>("gateway_status");
}

async function waitForBootstrap(
  config: GatewayConfig,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const startedAt = Date.now();
  let lastError = "not checked";
  while (Date.now() - startedAt < timeoutMs) {
    const result = await fetchBootstrap(config);
    if (result.ok) {
      return { ok: true };
    }
    lastError = result.error;
    await delay(500);
  }
  return { ok: false, error: lastError };
}

async function fetchBootstrap(config: GatewayConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetch(`${config.httpBaseUrl}/webui/bootstrap`, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: stringifyError(error) };
  } finally {
    window.clearTimeout(timeout);
  }
}

function installWebUiShell(html: string): void {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.documentElement.lang = parsed.documentElement.lang || "zh-CN";
  document.documentElement.dataset.theme = parsed.documentElement.dataset.theme || "light";
  installWebUiHeadAssets(parsed);
  document.body.replaceChildren(...withoutScripts(parsed.body.childNodes));
}

function withoutScripts(nodes: NodeListOf<ChildNode>): ChildNode[] {
  return [...nodes].filter((node) => !(node instanceof HTMLScriptElement));
}

function installWebUiHeadAssets(source: Document): void {
  for (const link of source.head.querySelectorAll<HTMLLinkElement>("link[rel='stylesheet'], link[rel='icon']")) {
    if (link.id.startsWith("hljs-") || link.href.startsWith("http")) {
      continue;
    }
    const href = link.getAttribute("href");
    if (href && document.head.querySelector(`link[href='${href}']`)) {
      continue;
    }
    document.head.append(link.cloneNode(true));
  }
}

function bindRetry(): void {
  document.querySelector("#desktop-startup-retry")?.addEventListener("click", () => {
    void bootDesktopWebUi();
  });
}

function setStartupState(message: string, diagnostics: string | null, recoverable: boolean): void {
  const status = document.querySelector<HTMLElement>("#desktop-startup-status");
  const detail = document.querySelector<HTMLElement>("#desktop-startup-diagnostics");
  const retry = document.querySelector<HTMLButtonElement>("#desktop-startup-retry");
  if (status) {
    status.textContent = message;
  }
  if (detail) {
    detail.textContent = diagnostics ?? "";
    detail.hidden = !diagnostics;
  }
  if (retry) {
    retry.hidden = !recoverable;
  }
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
