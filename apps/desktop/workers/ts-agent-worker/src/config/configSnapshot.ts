import {
  isSensitiveConfigPath,
  maskConfigSecrets,
  normalizeConfigPath,
  type SecretMaskMode,
} from "./configMasking.ts";

export type ConfigSnapshotAccessErrorCode = "invalid_config_path" | "sensitive_config_path";

export class ConfigSnapshotAccessError extends Error {
  constructor(
    readonly code: ConfigSnapshotAccessErrorCode,
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigSnapshotAccessError";
  }
}

export type ConfigPathReadResult = {
  path: string;
  value: unknown;
};

export function createPublicConfigSnapshot(
  snapshot: unknown,
  mode: SecretMaskMode = "public-rpc-null",
): Record<string, unknown> {
  const masked = maskConfigSecrets(snapshot, mode);
  return isRecord(masked) ? masked : {};
}

export function readPublicConfigPath(snapshot: unknown, path: string): ConfigPathReadResult {
  const segments = safeNormalizeConfigPath(path);
  if (isSensitiveConfigPath(segments)) {
    throw new ConfigSnapshotAccessError("sensitive_config_path", path, "worker config path is sensitive");
  }
  const value = getPathValue(snapshot, segments);
  return {
    path: segments.join("."),
    value: value === undefined ? null : maskConfigSecrets(value, "public-rpc-null"),
  };
}

function safeNormalizeConfigPath(path: string): string[] {
  try {
    return normalizeConfigPath(path);
  } catch {
    throw new ConfigSnapshotAccessError("invalid_config_path", path, "invalid config path");
  }
}

function getPathValue(snapshot: unknown, segments: readonly string[]): unknown {
  let current: unknown = snapshot;
  for (const segment of segments) {
    const object = isRecord(current) ? current : undefined;
    if (!object) {
      return undefined;
    }
    current = object[segment];
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
