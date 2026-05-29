import { invoke } from "@tauri-apps/api/core";
import webUiHtml from "../../../webui/index.html?raw";
import { ensureGatewayReady } from "./desktopGatewayStartup";
import { installDesktopGatewayBridge } from "./desktopGatewayBridge";
import { installWebUiRenderGlobals } from "./desktopMarkdownGlobals";
import { bindStartupRetry, setStartupState } from "./desktopStartupView";
import { installWebUiShell } from "./desktopWebUiShell";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "./gatewayConfig";

const gatewayConfig = resolveGatewayConfig(DEFAULT_GATEWAY_CONFIG);
const WEBUI_ENTRY = "/assets/src/main.js";

document.addEventListener("DOMContentLoaded", () => {
  bindStartupRetry(document, () => {
    void bootDesktopWebUi();
  });
  void bootDesktopWebUi();
});

async function bootDesktopWebUi(): Promise<void> {
  setStartupState(document, "Starting local gateway...", null, false);
  try {
    const status = await ensureGatewayReady(gatewayConfig, { invoke, hasTauriRuntime });
    installDesktopGatewayBridge({ config: gatewayConfig });
    installWebUiRenderGlobals();
    installWebUiShell(webUiHtml);
    await import(/* @vite-ignore */ WEBUI_ENTRY);
    console.info("Tinybot desktop WebUI initialized", status);
  } catch (error) {
    setStartupState(
      document,
      "Tinybot gateway is not ready.",
      `${stringifyError(error)}\n\nGateway: ${gatewayConfig.httpBaseUrl}`,
      true,
    );
  }
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
