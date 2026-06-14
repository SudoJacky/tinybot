import { UI_SECRET_PLACEHOLDER, isSensitiveConfigKey } from "./configMasking.ts";
import { parseTinybotConfig } from "./configSchema.ts";
import type { JsonRecord, TinybotConfig } from "./configTypes.ts";

export type ConfigPatchResult =
  | {
      ok: true;
      config: TinybotConfig;
      updatedFields: string[];
      sideEffects: ConfigPatchSideEffects;
    }
  | {
      ok: false;
      config: TinybotConfig;
      error: string;
      updatedFields: string[];
      sideEffects: ConfigPatchSideEffects;
    };

export type ConfigPatchSideEffects = {
  applied: string[];
  restartRequired: string[];
  warnings: string[];
};

export function applyConfigPatch(
  current: TinybotConfig,
  patch: JsonRecord,
  options: { maskedSecret?: string } = {},
): ConfigPatchResult {
  const updatedFields: string[] = [];
  const candidate = structuredClone(current) as JsonRecord;
  mergePatch(candidate, patch, [], updatedFields, options.maskedSecret ?? UI_SECRET_PLACEHOLDER);

  try {
    return {
      ok: true,
      config: parseTinybotConfig(candidate),
      updatedFields,
      sideEffects: planConfigPatchSideEffects(updatedFields),
    };
  } catch (error) {
    return {
      ok: false,
      config: current,
      error: error instanceof Error ? error.message : String(error),
      updatedFields: [],
      sideEffects: emptySideEffects(),
    };
  }
}

export function planConfigPatchSideEffects(updatedFields: readonly string[]): ConfigPatchSideEffects {
  const applied: string[] = [];
  const restartRequired: string[] = [];
  const warnings: string[] = [];

  for (const field of updatedFields) {
    if (isProviderRuntimeField(field)) {
      pushUnique(applied, "providerRuntimeChanged");
    }
    if (field.startsWith("agents.defaults.embedding.")) {
      pushUnique(applied, "embeddingConfigChanged");
    }
    if (field.startsWith("tools.mcpServers.")) {
      pushUnique(applied, "mcpConfigChanged");
    }
    if (field === "tools.ssrfWhitelist" || field.startsWith("tools.ssrfWhitelist.")) {
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

function mergePatch(
  target: JsonRecord,
  patch: JsonRecord,
  path: string[],
  updatedFields: string[],
  maskedSecret: string,
): void {
  for (const [key, patchValue] of Object.entries(patch)) {
    if (isMaskedSecretPlaceholder(key, patchValue, maskedSecret)) {
      continue;
    }

    const currentValue = target[key];
    const fieldPath = [...path, key];
    if (!isRecord(currentValue) && isRecord(patchValue)) {
      target[key] = cloneJsonValue(patchValue);
      collectUpdatedLeafPaths(patchValue, fieldPath, updatedFields);
      continue;
    }

    if (isRecord(currentValue) && isRecord(patchValue)) {
      mergePatch(currentValue, patchValue, fieldPath, updatedFields, maskedSecret);
      continue;
    }

    if (!jsonEqual(currentValue, patchValue)) {
      target[key] = cloneJsonValue(patchValue);
      updatedFields.push(fieldPath.join("."));
    }
  }
}

function collectUpdatedLeafPaths(value: JsonRecord, path: string[], updatedFields: string[]): void {
  const entries = Object.entries(value);
  if (entries.length === 0) {
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

function isMaskedSecretPlaceholder(key: string, value: unknown, maskedSecret: string): boolean {
  return value === maskedSecret && isSensitiveConfigKey(key);
}

function isProviderRuntimeField(field: string): boolean {
  return field === "agents.defaults.model"
    || field === "agents.defaults.provider"
    || field === "agents.defaults.activeProfile"
    || field.startsWith("providers.");
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function emptySideEffects(): ConfigPatchSideEffects {
  return { applied: [], restartRequired: [], warnings: [] };
}

function cloneJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
