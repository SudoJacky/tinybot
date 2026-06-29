export type McpTransportType = "stdio" | "sse" | "streamableHttp";

export type McpServerConfigInput = {
  type?: McpTransportType | null;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolTimeout?: number;
  tool_timeout?: number;
  enabledTools?: string[];
  enabled_tools?: string[];
};

export type McpServerConfig = {
  name: string;
  safeName: string;
  type: McpTransportType;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  toolTimeout: number;
  enabledTools: string[];
};

export type McpServersConfig = Record<string, McpServerConfig>;

export type JsonSchema = Record<string, unknown>;
