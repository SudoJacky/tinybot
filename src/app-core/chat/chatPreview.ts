const SENSITIVE_KEYS = new Set([
  "api_key",
  "token",
  "secret",
  "password",
  "authorization",
  "cookie",
  "credential",
  "private_key",
]);
const UNSAFE_KEYS = new Set([
  "html",
  "script",
  "style",
  "component",
  "handler",
  "renderer",
  "template",
  "onClick",
  "onSubmit",
]);

export function safeArtifactPreview(value: unknown): string {
  return serialize(omitUnsafe(redactSensitive(value)));
}

export function sanitizeTextPreview(value: string): string {
  return value
    .replace(/<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "[unsafe omitted]")
    .replace(/<[^>]+>/g, "[unsafe omitted]")
    .replace(/\b(api_key|token|secret|password|authorization|cookie|credential|private_key)\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]");
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitive);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactSensitive(item),
  ]));
}

function omitUnsafe(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUnsafe);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    UNSAFE_KEYS.has(key) ? "[unsafe omitted]" : omitUnsafe(item),
  ]));
}

function serialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
