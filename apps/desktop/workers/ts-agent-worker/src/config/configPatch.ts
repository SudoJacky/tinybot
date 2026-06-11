import { UI_SECRET_PLACEHOLDER, isSensitiveConfigKey } from "./configMasking.ts";
import { parseTinybotConfig } from "./configSchema.ts";
import type { JsonRecord, TinybotConfig } from "./configTypes.ts";

export type ConfigPatchResult =
  | {
      ok: true;
      config: TinybotConfig;
      updatedFields: string[];
    }
  | {
      ok: false;
      config: TinybotConfig;
      error: string;
      updatedFields: string[];
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
    };
  } catch (error) {
    return {
      ok: false,
      config: current,
      error: error instanceof Error ? error.message : String(error),
      updatedFields: [],
    };
  }
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

function cloneJsonValue(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
