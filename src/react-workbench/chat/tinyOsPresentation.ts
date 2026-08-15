import type { TFunction } from "i18next";
import type { ChatStepStatus } from "../../app-core/chat/chatTurnContracts";

export function boundedSelectionText(value: string): string {
  return value.length <= 16_384 ? value : `${value.slice(0, 16_384)}\n[selection truncated]`;
}

export function firstString(...values: unknown[]): string {
  return values.find((value): value is string => {
    if (typeof value !== "string" || !value.trim()) return false;
    return !["null", "undefined", "{}", "[]"].includes(value.trim().toLowerCase());
  }) ?? "";
}

export function jsonPreview(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function statusLabel(status: ChatStepStatus, t?: TFunction<"tinyos">): string {
  if (!t) return status.replace(/_/g, " ");
  switch (status) {
    case "completed": return t("shell.status.completed");
    case "running": return t("shell.status.running");
    case "blocked": return t("shell.status.blocked");
    case "failed": return t("shell.status.failed");
    case "cancelled": return t("shell.status.cancelled");
    default: return t("shell.status.pending");
  }
}
