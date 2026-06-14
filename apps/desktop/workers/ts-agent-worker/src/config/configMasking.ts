export type SecretMaskMode = "public-rpc-null" | "ui-placeholder";

export const UI_SECRET_PLACEHOLDER = "********";

export function maskConfigSecrets(value: unknown, mode: SecretMaskMode = "public-rpc-null"): unknown {
  return maskValue(value, mode);
}

export function isSensitiveConfigPath(path: string | readonly string[]): boolean {
  const segments = typeof path === "string" ? normalizeConfigPath(path) : path;
  return segments.some(isSensitiveConfigKey);
}

export function normalizeConfigPath(path: string): string[] {
  if (!path || path.includes("\0")) {
    throw new Error("invalid config path");
  }
  const segments = path.split(".");
  if (segments.some((segment) => !segment)) {
    throw new Error("invalid config path");
  }
  return segments;
}

export function isSensitiveConfigKey(key: string): boolean {
  const parts = splitConfigKey(key);
  if (!parts.length) {
    return false;
  }
  const last = parts.at(-1);
  if (last === "token" || last === "secret" || last === "password" || last === "authorization" || last === "credentials") {
    return true;
  }
  if (last === "apikey") {
    return true;
  }
  return parts.length >= 2 && parts.at(-2) === "api" && last === "key";
}

function maskValue(value: unknown, mode: SecretMaskMode, key = ""): unknown {
  if (key && isSensitiveConfigKey(key)) {
    if (mode === "public-rpc-null") {
      return null;
    }
    return isPresentSecretValue(value) ? UI_SECRET_PLACEHOLDER : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, mode, key));
  }
  if (isRecord(value)) {
    const masked: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      masked[childKey] = maskValue(childValue, mode, childKey);
    }
    return masked;
  }
  return value;
}

function splitConfigKey(key: string): string[] {
  return key
    .replace(/-/g, "_")
    .replace(/(?<=[a-z0-9])(?=[A-Z])/g, "_")
    .toLowerCase()
    .split("_")
    .filter(Boolean);
}

function isPresentSecretValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
