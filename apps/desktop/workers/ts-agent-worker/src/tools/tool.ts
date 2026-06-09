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

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
