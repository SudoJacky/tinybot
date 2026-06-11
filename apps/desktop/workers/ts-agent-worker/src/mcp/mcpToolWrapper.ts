import type { Tool, ToolContext, ToolResult } from "../tools/tool.ts";
import { wrappedMcpToolName } from "./mcpConfig.ts";
import { normalizeMcpJsonSchema } from "./mcpSchema.ts";

export type McpRawToolDefinition = {
  name: string;
  description?: string | null;
  inputSchema?: unknown;
};

export type McpToolContentBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type McpToolCallResult = {
  content?: McpToolContentBlock[];
};

export type McpToolSession = {
  callTool(rawToolName: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
};

export type McpToolWrapperOptions = {
  session: McpToolSession;
  serverName: string;
  rawTool: McpRawToolDefinition;
  toolTimeout: number;
};

export class McpToolCallCancelledError extends Error {
  constructor(message = "MCP tool call was cancelled") {
    super(message);
    this.name = "McpToolCallCancelledError";
  }
}

export function createMcpToolWrapper(options: McpToolWrapperOptions): Tool {
  const name = wrappedMcpToolName(options.serverName, options.rawTool.name);
  const rawToolName = options.rawTool.name;
  const serverName = options.serverName;
  return {
    name,
    description: options.rawTool.description?.trim() || rawToolName,
    parameters: normalizeMcpJsonSchema(options.rawTool.inputSchema ?? { type: "object", properties: {} }),
    readOnly: false,
    concurrencySafe: false,
    capabilities: ["mcp"],
    requiresApproval: true,
    approvalCategory: "mcp",
    approvalRisk: "high",
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        const result = await withTimeout(
          options.session.callTool(rawToolName, args),
          options.toolTimeout,
        );
        return {
          content: formatMcpContent(result.content),
          metadata: {
            source: "mcp",
            serverName,
            rawToolName,
          },
        };
      } catch (error) {
        return {
          content: formatMcpError(error, options.toolTimeout),
          metadata: {
            source: "mcp",
            serverName,
            rawToolName,
          },
        };
      }
    },
  };
}

function formatMcpContent(content: McpToolContentBlock[] | undefined): string {
  const parts = (content ?? []).map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
    return `[MCP content:${block.type || "unknown"}] ${stableJsonStringify(block)}`;
  }).filter((part) => part.length > 0);
  return parts.join("\n") || "(no output)";
}

function formatMcpError(error: unknown, timeoutSeconds: number): string {
  if (error instanceof McpToolCallTimedOutError) {
    return `(MCP tool call timed out after ${formatTimeoutSeconds(timeoutSeconds)}s)`;
  }
  if (error instanceof McpToolCallCancelledError) {
    return "(MCP tool call was cancelled)";
  }
  return `(MCP tool call failed: ${errorTypeName(error)})`;
}

function withTimeout<T>(promise: Promise<T>, timeoutSeconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new McpToolCallTimedOutError()), timeoutSeconds * 1000);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

class McpToolCallTimedOutError extends Error {
  constructor() {
    super("MCP tool call timed out");
    this.name = "McpToolCallTimedOutError";
  }
}

function errorTypeName(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "Error";
}

function formatTimeoutSeconds(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

function stableJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
