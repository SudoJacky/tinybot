import { invoke as tauriInvoke } from "@tauri-apps/api/core";

const UI_SECRET_PLACEHOLDER = "********";

type JsonRecord = Record<string, unknown>;

export type DesktopNativeConfigPatchResponse = {
  ok: boolean;
  config: JsonRecord;
  updatedFields: string[];
  sideEffects: {
    applied: string[];
    restartRequired: string[];
    warnings: string[];
  };
  error?: string | null;
};

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export async function applyNativeConfigPatch(
  currentConfig: unknown,
  patch: unknown,
  options: { invoke?: TauriInvoke } = {},
): Promise<DesktopNativeConfigPatchResponse> {
  if (!isRecord(patch)) {
    throw new Error("desktop settings patch must be a JSON object");
  }
  if (!isRecord(currentConfig)) {
    throw new Error("desktop settings current config must be a JSON object");
  }
  const result = buildDesktopConfigPatchResult(currentConfig, patch);
  return (options.invoke ?? tauriInvoke)<DesktopNativeConfigPatchResponse>("apply_config_patch_result", {
    result,
  });
}

function buildDesktopConfigPatchResult(currentConfig: JsonRecord, patch: JsonRecord) {
  const updatedFields: string[] = [];
  const candidate = structuredClone(currentConfig) as JsonRecord;
  mergePatch(candidate, patch, [], updatedFields);
  return {
    ok: true,
    config: candidate,
    updatedFields,
    sideEffects: planConfigPatchSideEffects(updatedFields),
    error: null,
  };
}

function mergePatch(
  target: JsonRecord,
  patch: JsonRecord,
  path: string[],
  updatedFields: string[],
): void {
  for (const [key, patchValue] of Object.entries(patch)) {
    if (patchValue === UI_SECRET_PLACEHOLDER && isSensitiveConfigKey(key)) {
      continue;
    }
    const currentValue = target[key];
    const fieldPath = [...path, key];
    if (!isRecord(currentValue) && isRecord(patchValue)) {
      target[key] = structuredClone(patchValue);
      collectUpdatedLeafPaths(patchValue, fieldPath, updatedFields);
      continue;
    }
    if (isRecord(currentValue) && isRecord(patchValue)) {
      mergePatch(currentValue, patchValue, fieldPath, updatedFields);
      continue;
    }
    if (JSON.stringify(currentValue) !== JSON.stringify(patchValue)) {
      target[key] = structuredClone(patchValue);
      updatedFields.push(fieldPath.join("."));
    }
  }
}

function collectUpdatedLeafPaths(value: JsonRecord, path: string[], updatedFields: string[]): void {
  const entries = Object.entries(value);
  if (!entries.length) {
    updatedFields.push(path.join("."));
    return;
  }
  for (const [key, childValue] of entries) {
    const childPath = [...path, key];
    if (isRecord(childValue)) {
      collectUpdatedLeafPaths(childValue, childPath, updatedFields);
    } else {
      updatedFields.push(childPath.join("."));
    }
  }
}

function planConfigPatchSideEffects(updatedFields: readonly string[]): DesktopNativeConfigPatchResponse["sideEffects"] {
  const applied: string[] = [];
  const restartRequired: string[] = [];
  const warnings: string[] = [];
  for (const field of updatedFields) {
    if (
      field === "agents.defaults.model"
      || field === "agents.defaults.provider"
      || field === "agents.defaults.activeProfile"
      || field === "agents.defaults.active_profile"
      || field.startsWith("providers.")
    ) {
      pushUnique(applied, "providerRuntimeChanged");
    }
    if (field.startsWith("agents.defaults.embedding.")) {
      pushUnique(applied, "embeddingConfigChanged");
    }
    if (field.startsWith("tools.mcpServers.") || field.startsWith("tools.mcp_servers.")) {
      pushUnique(applied, "mcpConfigChanged");
    }
    if (field === "tools.ssrfWhitelist" || field.startsWith("tools.ssrfWhitelist.") || field === "tools.ssrf_whitelist" || field.startsWith("tools.ssrf_whitelist.")) {
      pushUnique(applied, "ssrfWhitelistChanged");
    }
    if (field.startsWith("channels.")) {
      pushUnique(applied, "channelConfigChanged");
    }
    if (field.startsWith("knowledge.")) {
      pushUnique(applied, "knowledgeConfigChanged");
    }
    if (field === "agents.defaults.workspace") {
      pushUnique(restartRequired, "workspaceReloadRequired");
      pushUnique(warnings, "agents.defaults.workspace requires an explicit workspace reload");
    }
    if (field === "gateway.host" || field === "gateway.port") {
      pushUnique(restartRequired, "gatewayRestartRequired");
      pushUnique(warnings, "gateway host or port changes require restart");
    }
  }
  return { applied, restartRequired, warnings };
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function isSensitiveConfigKey(key: string): boolean {
  const parts = key
    .replace(/-/g, "_")
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === "token" || last === "secret" || last === "password" || last === "authorization" || last === "credentials") {
    return true;
  }
  if (last === "apikey") {
    return true;
  }
  return parts.length >= 2 && parts[parts.length - 2] === "api" && last === "key";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
