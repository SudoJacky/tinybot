import type { NativePluginsApi } from "../../app-core/native/desktopNativePlugins";
import type { NativeWebuiRouteRequest } from "../../app-core/native/desktopNativeWebui";
import type {
  McpServerSummary,
  ToolCatalogSummary,
  ToolSummary,
  ToolsStore,
} from "../services";

type NativeToolsCatalogApi = {
  route(request: NativeWebuiRouteRequest): Promise<unknown>;
};

export function createDesktopToolsStore({
  initialize,
  nativePlugins,
  nativeWebui,
}: {
  initialize: () => Promise<void>;
  nativePlugins?: NativePluginsApi;
  nativeWebui?: NativeToolsCatalogApi;
}): ToolsStore {
  return {
    async loadCatalog() {
      await initialize();
      const payload = await requireNative(nativeWebui, "WebUI").route({ method: "GET", path: "/api/tools" });
      return normalizeToolCatalog(payload);
    },
    async listPlugins() {
      await initialize();
      return (await requireNative(nativePlugins, "Plugins").list()).plugins;
    },
    async installPlugin(path) {
      await initialize();
      return requireNative(nativePlugins, "Plugins").install(path);
    },
    async preparePluginMigration(path) {
      await initialize();
      return requireNative(nativePlugins, "Plugins").prepareMigration(path);
    },
    async installPluginMigration(jobId) {
      await initialize();
      return requireNative(nativePlugins, "Plugins").installMigration(jobId);
    },
    async setPluginEnabled(name, enabled) {
      await initialize();
      return requireNative(nativePlugins, "Plugins").setEnabled(name, enabled);
    },
    async uninstallPlugin(name) {
      await initialize();
      await requireNative(nativePlugins, "Plugins").uninstall(name);
    },
  };
}

function normalizeToolCatalog(payload: unknown): ToolCatalogSummary {
  return {
    tools: payloadItems(payload, ["tools", "items"]).map(normalizeToolSummary),
    mcpServers: payloadItems(payload, ["mcpServers", "servers"]).map(normalizeMcpServerSummary),
  };
}

function normalizeToolSummary(item: Record<string, unknown>): ToolSummary {
  const name = stringValue(item.name ?? item.id);
  return {
    id: stringValue(item.id) || name,
    name,
    displayName: stringValue(item.displayName ?? item.title) || name,
    description: stringValue(item.description),
    source: stringValue(item.source) || "builtin",
    serverId: stringValue(item.serverId) || undefined,
    enabled: item.enabled !== false,
    available: item.available !== false,
    reason: stringValue(item.reason) || undefined,
  };
}

function normalizeMcpServerSummary(item: Record<string, unknown>): McpServerSummary {
  const status = isRecord(item.status) ? item.status : {};
  return {
    id: stringValue(item.id),
    enabled: item.enabled !== false,
    transport: stringValue(item.transport) || "stdio",
    state: stringValue(status.state) || (item.enabled === false ? "disabled" : "unknown"),
    toolCount: numberValue(item.toolCount ?? status.toolCount) ?? 0,
    error: stringValue(item.error ?? status.lastError) || undefined,
  };
}

function requireNative<T>(value: T | undefined, capability: string): T {
  if (!value) throw new Error(`${capability} Native API is unavailable outside the Tauri runtime`);
  return value;
}

function payloadItems(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}
