import { createHash } from "node:crypto";

import type { ApprovalCategory } from "./approvalTypes.ts";
import { normalizeCommand } from "./approvalPolicy.ts";

export function buildApprovalFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  category: ApprovalCategory,
): string {
  if (toolName === "exec") {
    return `exec:${normalizeCommand(String(args.command ?? "")).toLowerCase()}`;
  }
  if (isFileWriteTool(toolName)) {
    return `${toolName}:${normalizePathValue(args.path)}`;
  }
  if (toolName.startsWith("mcp_")) {
    return `${toolName}:${shortHash(stableJson(args))}`;
  }
  return `${category}:${toolName}:${shortHash(stableJson(args))}`;
}

export function buildSessionApprovalFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  category: ApprovalCategory,
): string {
  if (toolName === "exec") {
    return buildApprovalFingerprint(toolName, args, category);
  }
  if (isFileWriteTool(toolName)) {
    return `${toolName}:${normalizePathValue(args.path)}`;
  }
  return `${category}:${toolName}`;
}

function isFileWriteTool(toolName: string): boolean {
  return toolName === "write_file" || toolName === "edit_file" || toolName === "delete_file";
}

function normalizePathValue(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "/").toLowerCase();
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right)
    );
    return Object.fromEntries(entries.map(([key, item]) => [key, sortJsonValue(item)]));
  }
  return value;
}

function shortHash(value: string, length = 12): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}
