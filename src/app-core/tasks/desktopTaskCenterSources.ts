import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

export interface DesktopProviderModelTaskInput {
  provider: string;
  profile?: string;
  status: string;
  models?: string[];
  error?: string;
  updatedAt?: string;
}

export interface DesktopFileTaskInput {
  id: string;
  title: string;
  status: string;
  path?: string;
  detail?: string;
  error?: string;
  retryable?: boolean;
  updatedAt?: string;
}

export function buildDesktopProviderModelDiscoveryTaskOperation(
  input: DesktopProviderModelTaskInput,
): DesktopTaskSourceOperation {
  const provider = stringValue(input.provider) || "provider";
  const profile = stringValue(input.profile) || "default";
  const models = Array.isArray(input.models) ? input.models.filter(Boolean) : [];
  const failed = normalizeStatus(input.status) === "failed";
  return {
    id: `provider:${provider}:${profile}:models`,
    title: `Refresh ${providerDisplayName(provider)} models`,
    status: input.status || "refreshing",
    detail: models.length ? `${models.length} ${models.length === 1 ? "model" : "models"} loaded` : `Profile ${profile}`,
    canonical: { module: "settings", entityId: provider, href: "/settings" },
    diagnostics: stringValue(input.error),
    retryable: failed,
    updatedAt: stringValue(input.updatedAt),
  };
}

export function buildDesktopFileTaskOperation(input: DesktopFileTaskInput): DesktopTaskSourceOperation {
  const path = stringValue(input.path);
  const failed = normalizeStatus(input.status) === "failed";
  return {
    id: `file:${input.id}`,
    title: input.title || "File operation",
    status: input.status || "active",
    detail: input.detail || (path ? path : "File operation"),
    canonical: { module: "files", entityId: path || input.id, href: "/files" },
    diagnostics: stringValue(input.error),
    retryable: input.retryable ?? failed,
    updatedAt: stringValue(input.updatedAt),
  };
}

function providerDisplayName(provider: string): string {
  const known: Record<string, string> = {
    openai: "OpenAI",
    deepseek: "Deepseek",
    anthropic: "Anthropic",
  };
  return known[provider.toLowerCase()] || provider.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeStatus(value: unknown): string {
  const raw = stringValue(value).toLowerCase();
  if (["failed", "error", "timeout"].includes(raw)) {
    return "failed";
  }
  return raw;
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
