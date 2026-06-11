import type { PreparedToolCall, Tool, ToolContext, ToolDefinition, ToolResult } from "./tool.ts";
import { castJsonSchemaValue, validateJsonSchemaValue } from "./toolSchema.ts";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  definitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.requiresApproval
        ? `${tool.description}\nRequires user approval before execution.`
        : tool.description,
      parameters: tool.parameters,
    }));
  }

  filtered(options: { exclude?: Set<string> | string[] } = {}): ToolRegistry {
    const exclude = new Set(options.exclude ?? []);
    if (exclude.size === 0) {
      return this;
    }
    const registry = new ToolRegistry();
    for (const [name, tool] of this.tools.entries()) {
      if (!exclude.has(name)) {
        registry.register(tool);
      }
    }
    return registry;
  }

  prepareCall(name: string, args: Record<string, unknown>): PreparedToolCall {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        args,
        content: `Error: Tool '${name}' not found. Available: ${this.toolNames.join(", ")}`,
        error: {
          kind: "unknown_tool",
          message: `Tool '${name}' not found.`,
        },
      };
    }

    const preparedArgs = prepareToolArguments(tool, args);
    const errors = validateToolArguments(tool, preparedArgs);
    if (errors.length > 0) {
      const message = errors.join("; ");
      return {
        ok: false,
        tool,
        args: preparedArgs,
        content: `Error: Invalid parameters for tool '${name}': ${message}`,
        error: {
          kind: "invalid_params",
          message,
        },
      };
    }
    return {
      ok: true,
      tool,
      args: preparedArgs,
    };
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const prepared = this.prepareCall(name, args);
    if (!prepared.ok) {
      return { content: prepared.content };
    }
    return prepared.tool.execute(prepared.args, context);
  }

  get toolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}

function prepareToolArguments(tool: Tool, args: Record<string, unknown>): Record<string, unknown> {
  const schema = asRecord(tool.parameters);
  if (!schema || schema.type !== "object") {
    return args;
  }
  const castArgs = castJsonSchemaValue(args, schema);
  return asRecord(castArgs) ?? args;
}

function validateToolArguments(tool: Tool, args: Record<string, unknown>): string[] {
  const schema = asRecord(tool.parameters);
  if (!schema) {
    return [];
  }
  if (schema.type !== undefined && schema.type !== "object") {
    return [`parameters schema must be object type, got ${String(schema.type)}`];
  }
  return validateJsonSchemaValue(args, { ...schema, type: "object" });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
