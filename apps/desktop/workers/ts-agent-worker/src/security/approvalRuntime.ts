import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import { classifyToolCall } from "./approvalClassifier.ts";
import { buildApprovalFingerprint, buildSessionApprovalFingerprint } from "./approvalFingerprint.ts";
import { normalizeCommand } from "./approvalPolicy.ts";
import type { ApprovalRequestPayload } from "./approvalTypes.ts";

export type ApprovalRequestBridge = {
  requestApproval(payload: ApprovalRequestPayload, traceId: string): Promise<Record<string, unknown>>;
};

export type ApprovalRuntimeOptions = {
  bridge: ApprovalRequestBridge;
};

export class ApprovalRuntime {
  private readonly bridge: ApprovalRequestBridge;

  constructor(options: ApprovalRuntimeOptions) {
    this.bridge = options.bridge;
  }

  async evaluateToolCall(
    tool: Tool,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult | undefined> {
    const classification = classifyToolCall({
      toolName: tool.name,
      args,
      readOnly: tool.readOnly,
      requiresApproval: tool.requiresApproval,
      approvalCategory: tool.approvalCategory,
      approvalRisk: tool.approvalRisk,
    });
    if (classification.action === "allow") {
      return undefined;
    }

    const payload: ApprovalRequestPayload = {
      runId: context.runId,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      ...buildApprovalToolRequest(tool, args),
    };
    const result = await this.bridge.requestApproval(payload, context.traceId ?? context.runId);
    if (result.decision === "allow") {
      return undefined;
    }
    const { content: rawContent, ...rawMetadata } = result;
    return {
      content: typeof rawContent === "string" ? rawContent : "Waiting for approval.",
      metadata: {
        awaitingUserInput: true,
        stopReason: "awaiting_approval",
        operation: payload.operation,
        fingerprint: payload.fingerprint,
        sessionFingerprint: payload.sessionFingerprint,
        ...rawMetadata,
      },
    };
  }
}

export function buildApprovalToolRequest(
  tool: Tool,
  args: Record<string, unknown>,
): Omit<ApprovalRequestPayload, "runId" | "sessionId"> {
  const classification = classifyToolCall({
    toolName: tool.name,
    args,
    readOnly: tool.readOnly,
    requiresApproval: tool.requiresApproval,
    approvalCategory: tool.approvalCategory,
    approvalRisk: tool.approvalRisk,
  });
  if (classification.action === "allow") {
    throw new Error(`Tool '${tool.name}' does not require approval.`);
  }
  return {
    operation: {
      toolName: tool.name,
      arguments: args,
    },
    classification,
    fingerprint: buildApprovalFingerprint(tool.name, args, classification.category),
    sessionFingerprint: buildSessionApprovalFingerprint(tool.name, args, classification.category),
    summary: approvalSummary(tool.name, args),
  };
}

function approvalSummary(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "exec") {
    return `exec command="${normalizeCommand(String(args.command ?? "")).slice(0, 160)}"`;
  }
  if (toolName === "write_file" || toolName === "edit_file" || toolName === "delete_file" || toolName === "read_file") {
    return `${toolName} path="${String(args.path ?? "")}"`;
  }
  return `${toolName}(${stableJson(args).slice(0, 160)})`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }
  return value;
}
