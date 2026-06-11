import type { ToolContext, ToolExecutionErrorKind, ToolExecutionResult } from "./tool.ts";
import type { ToolRegistry } from "./toolRegistry.ts";
import type { ApprovalRuntime } from "../security/approvalRuntime.ts";

const TOOL_RETRY_HINT = "\n\n[Analyze the error above and try a different approach.]";

export class ToolRuntime {
  private readonly registry: ToolRegistry;
  private readonly approvalRuntime?: ApprovalRuntime;

  constructor(registry: ToolRegistry, options: { approvalRuntime?: ApprovalRuntime } = {}) {
    this.registry = registry;
    this.approvalRuntime = options.approvalRuntime;
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolExecutionResult> {
    const prepared = this.registry.prepareCall(name, args);
    if (!prepared.ok) {
      return {
        ok: false,
        content: appendRetryHint(prepared.content),
        error: prepared.error,
      };
    }

    try {
      const approvalResult = await this.approvalRuntime?.evaluateToolCall(prepared.tool, prepared.args, context);
      if (approvalResult) {
        return {
          ok: true,
          ...approvalResult,
        };
      }
      const result = await prepared.tool.execute(prepared.args, context);
      if (isErrorContent(result.content)) {
        return {
          ok: false,
          content: appendRetryHint(result.content),
          metadata: result.metadata,
          error: {
            kind: "native_error",
            message: result.content,
          },
        };
      }
      return {
        ok: true,
        ...result,
      };
    } catch (error) {
      const message = errorMessage(error);
      return errorResult("exception", `Error executing ${name}: ${message}`, message);
    }
  }
}

function errorResult(kind: ToolExecutionErrorKind, content: string, message: string): ToolExecutionResult {
  return {
    ok: false,
    content: appendRetryHint(content),
    error: {
      kind,
      message,
    },
  };
}

function isErrorContent(content: string): boolean {
  return content.startsWith("Error");
}

function appendRetryHint(content: string): string {
  return content.includes(TOOL_RETRY_HINT) ? content : `${content}${TOOL_RETRY_HINT}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
