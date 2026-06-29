import type { AgentUiState } from "../agent-ui/agentUiEvents";
import { DEFAULT_NATIVE_BACKEND_COMMAND } from "../gateway/desktopGatewayStartup";
import type { GatewayRuntimeStatus } from "../gateway/desktopGatewayStartup";
import type { DesktopTaskSourceOperation } from "./desktopTaskCenter";

type UnknownRecord = Record<string, unknown>;

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

export function buildDesktopGatewayTaskOperation(
  action: "startup" | "restart" | "stop",
  status: GatewayRuntimeStatus | null,
): DesktopTaskSourceOperation {
  const gatewayStatus = status?.state === "offline" && status.last_error
    ? "failed"
    : status?.state === "running" || status === null
      ? "completed"
      : status?.state || "starting";
  const command = status?.command || DEFAULT_NATIVE_BACKEND_COMMAND;
  const owner = status?.owner || "external";
  const diagnostics = status?.last_error || (status?.logs ?? []).slice(-4).join("\n");
  return {
    id: `gateway:${action}`,
    title: gatewayTaskTitle(action),
    status: gatewayStatus,
    detail: `${owner} / ${command}`,
    canonical: { module: "gateway", href: "/api/status" },
    diagnostics,
    retryable: gatewayStatus === "failed",
    updatedAt: "",
  };
}

function gatewayTaskTitle(action: "startup" | "restart" | "stop"): string {
  if (action === "restart") {
    return "Restart Tinybot gateway";
  }
  if (action === "stop") {
    return "Stop Tinybot gateway";
  }
  return "Start Tinybot gateway";
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

export function buildDesktopApprovalTaskOperations(payload: unknown): DesktopTaskSourceOperation[] {
  return arrayFromPayload(payload, "approvals", "items").map((approval, index) => {
    const id = firstNonEmpty(approval.id, approval.approval_id, `approval-${index}`);
    const toolName = firstNonEmpty(approval.tool_name, approval.tool, approval.category, id);
    const sessionKey = firstNonEmpty(approval.session_key, approval.sessionKey, approval.chat_id);
    return {
      id: `approval:${id}`,
      title: `Approve ${toolName}`,
      status: firstNonEmpty(approval.status, "waiting"),
      detail: firstNonEmpty(approval.summary, approval.reason, "Approval required"),
      canonical: { module: "approvals", entityId: id, href: sessionKey ? `/chat/${encodeURIComponent(sessionKey)}` : "/chat" },
      diagnostics: firstNonEmpty(approval.diagnostics),
      retryable: false,
      updatedAt: firstNonEmpty(approval.updated_at, approval.updatedAt, approval.created_at),
      approval: { approvalId: id, sessionKey },
    };
  });
}

export function buildDesktopAgentUiApprovalTaskOperations(state: AgentUiState): DesktopTaskSourceOperation[] {
  return [...state.forms.values()]
    .filter((form) => !["submitted", "cancelled", "expired"].includes(stringValue(form.status)))
    .map((form) => ({
      id: `approval:form:${form.form_id}`,
      title: form.title || "Approval required",
      status: form.status === "pending" || !form.status ? "waiting" : form.status,
      detail: form.description || "Agent UI form approval required",
      canonical: {
        module: "approvals" as const,
        entityId: form.form_id,
        href: form.chat_id ? `/chat/${encodeURIComponent(form.chat_id)}` : "/chat",
      },
      diagnostics: "",
      retryable: false,
      updatedAt: form.updated_at || "",
    }));
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

function arrayFromPayload(payload: unknown, ...keys: string[]): UnknownRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  const record = asRecord(payload);
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return Object.keys(record).length ? [record] : [];
}

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const text = stringValue(value);
    if (text) {
      return text;
    }
  }
  return "";
}

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}
