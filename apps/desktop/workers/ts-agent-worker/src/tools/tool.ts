import type { ApprovalCategory, ApprovalRisk } from "../security/approvalTypes.ts";

export type JsonSchema = Record<string, unknown>;

export type ToolContext = {
  runId: string;
  traceId?: string;
  sessionId?: string;
};

export type ToolResult = {
  content: string;
  metadata?: Record<string, unknown>;
};

export type ToolMetadata = {
  readOnly?: boolean;
  exclusive?: boolean;
  concurrencySafe?: boolean;
  capabilities?: string[];
  requiresApproval?: boolean;
  approvalCategory?: ApprovalCategory;
  approvalRisk?: ApprovalRisk;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: JsonSchema;
};

export type ToolExecutionErrorKind = "unknown_tool" | "invalid_params" | "native_error" | "exception";

export type ToolExecutionError = {
  kind: ToolExecutionErrorKind;
  message: string;
  details?: Record<string, unknown>;
};

export type ToolExecutionResult = ToolResult & {
  ok: boolean;
  error?: ToolExecutionError;
};

export type PreparedToolCall =
  | { ok: true; tool: Tool; args: Record<string, unknown> }
  | {
      ok: false;
      content: string;
      tool?: Tool;
      args: Record<string, unknown>;
      error: ToolExecutionError;
    };

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  readOnly?: boolean;
  exclusive?: boolean;
  concurrencySafe?: boolean;
  capabilities?: string[];
  requiresApproval?: boolean;
  approvalCategory?: ApprovalCategory;
  approvalRisk?: ApprovalRisk;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
