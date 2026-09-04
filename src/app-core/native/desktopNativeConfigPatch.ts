import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type JsonRecord = Record<string, unknown>;

export type DesktopNativeConfigPatchResponse = {
  ok: boolean;
  config: JsonRecord;
  revision?: string | null;
  updatedFields: string[];
  sideEffects: {
    applied: string[];
    restartRequired: string[];
    warnings: string[];
  };
  error?: string | null;
};

type DesktopConfigOperation =
  | { op: "replace"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "secretReplace"; path: string; value: unknown }
  | { op: "secretRemove"; path: string };

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type DesktopConfigReplaceValue = {
  __desktopConfigOperation: "replace";
  value: unknown;
};

type DesktopConfigRemoveValue = {
  __desktopConfigOperation: "remove";
  useJsonPointer: true;
};

export function replaceDesktopConfigValue(value: unknown): DesktopConfigReplaceValue {
  return { __desktopConfigOperation: "replace", value };
}

export function removeDesktopConfigValue(): DesktopConfigRemoveValue {
  return { __desktopConfigOperation: "remove", useJsonPointer: true };
}

export async function applyNativeConfigPatch(
  currentConfig: unknown,
  patch: unknown,
  options: { invoke?: TauriInvoke } = {},
): Promise<DesktopNativeConfigPatchResponse> {
  if (!isRecord(patch)) {
    throw new Error("desktop settings patch must be a JSON object");
  }
  const request = buildDesktopConfigOperationRequest(currentConfig, patch);
  return (options.invoke ?? tauriInvoke)<DesktopNativeConfigPatchResponse>("apply_config_operations", {
    request,
  });
}

function buildDesktopConfigOperationRequest(currentConfig: unknown, patch: JsonRecord) {
  return {
    expectedRevision: extractExpectedRevision(currentConfig),
    operations: buildDesktopConfigOperations(patch),
  };
}

function buildDesktopConfigOperations(patch: JsonRecord): DesktopConfigOperation[] {
  const operations: DesktopConfigOperation[] = [];
  collectDesktopConfigOperations(patch, [], operations);
  return operations;
}

function collectDesktopConfigOperations(
  patch: JsonRecord,
  path: string[],
  operations: DesktopConfigOperation[],
): void {
  for (const [key, patchValue] of Object.entries(patch)) {
    if (isSyntheticConfigMetadataKey(key)) {
      continue;
    }
    const fieldPath = [...path, key];
    if (isConfigRemoveOperation(patchValue)) {
      operations.push({
        op: isSensitiveConfigKey(key) ? "secretRemove" : "remove",
        path: patchValue.useJsonPointer ? canonicalConfigPointer(fieldPath) : canonicalConfigPath(fieldPath),
      });
      continue;
    }
    if (isConfigReplaceOperation(patchValue)) {
      operations.push({
        op: isSensitiveConfigKey(key) ? "secretReplace" : "replace",
        path: canonicalConfigPointer(fieldPath),
        value: patchValue.value,
      });
      continue;
    }
    if (isRecord(patchValue) && Object.entries(patchValue).length > 0) {
      collectDesktopConfigOperations(patchValue, fieldPath, operations);
      continue;
    }
    operations.push({
      op: isSensitiveConfigKey(key) ? "secretReplace" : "replace",
      path: canonicalConfigPath(fieldPath),
      value: structuredClone(patchValue),
    });
  }
}

function canonicalConfigPath(path: readonly string[]): string {
  const canonical: string[] = [];
  for (const segment of path) {
    canonical.push(canonicalConfigSegment(canonical, segment));
  }
  return canonical.join(".");
}

function canonicalConfigSegment(parent: readonly string[], segment: string): string {
  if (parent.length === 2 && parent[0] === "agents" && parent[1] === "defaults") {
    return ({
      active_profile: "activeProfile",
      max_tokens: "maxTokens",
      context_block_limit: "contextBlockLimit",
      context_window_strategy: "contextWindowStrategy",
      max_tool_result_chars: "maxToolResultChars",
      reasoning_effort: "reasoningEffort",
    } as Record<string, string>)[segment] ?? segment;
  }
  if (parent.length === 1 && parent[0] === "tools") {
    return ({
      mcp_servers: "mcpServers",
      ssrf_whitelist: "ssrfWhitelist",
    } as Record<string, string>)[segment] ?? segment;
  }
  if (parent.length === 1 && parent[0] === "channels" && segment === "send_progress") {
    return "sendProgress";
  }
  if (parent.length === 3 && parent[0] === "providers" && parent[1] === "profiles") {
    return ({
      api_mode: "apiMode",
    } as Record<string, string>)[segment] ?? segment;
  }
  if (parent.length === 1 && parent[0] === "memory" && segment === "active_profile") {
    return "activeProfile";
  }
  return segment;
}

function canonicalConfigPointer(path: readonly string[]): string {
  const canonical: string[] = [];
  for (const segment of path) {
    canonical.push(canonicalConfigSegment(canonical, segment));
  }
  return `/${canonical.map((segment) => segment.replace(/~/g, "~0").replace(/\//g, "~1")).join("/")}`;
}

function extractExpectedRevision(currentConfig: unknown): string | undefined {
  if (!isRecord(currentConfig)) {
    return undefined;
  }
  for (const key of ["revision", "configRevision", "config_revision"]) {
    const value = currentConfig[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  const metadata = currentConfig.configMetadata ?? currentConfig.config_metadata;
  if (isRecord(metadata)) {
    const value = metadata.revision;
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function isConfigRemoveOperation(value: unknown): value is { useJsonPointer?: boolean } {
  return isRecord(value)
    && (value.__desktopConfigOperation === "remove" || value.op === "remove")
    && Object.keys(value).every((key) => ["__desktopConfigOperation", "op", "useJsonPointer"].includes(key));
}

function isConfigReplaceOperation(value: unknown): value is DesktopConfigReplaceValue {
  return isRecord(value)
    && value.__desktopConfigOperation === "replace"
    && Object.prototype.hasOwnProperty.call(value, "value")
    && Object.keys(value).every((key) => ["__desktopConfigOperation", "value"].includes(key));
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

function isSyntheticConfigMetadataKey(key: string): boolean {
  return key
    .replace(/-/g, "_")
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
    .toLowerCase() === "api_key_configured";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
