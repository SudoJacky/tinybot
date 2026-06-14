import type { McpServerConfig, McpServerConfigInput, McpServersConfig, McpTransportType } from "./mcpTypes.ts";

export function normalizeMcpServersConfig(input: unknown): McpServersConfig {
  const servers: McpServersConfig = {};
  const object = asRecord(input);
  for (const [name, value] of Object.entries(object ?? {})) {
    servers[name] = normalizeMcpServerConfig(name, value);
  }
  return servers;
}

export function normalizeMcpServerConfig(name: string, input: unknown): McpServerConfig {
  const raw = asRecord(input) as McpServerConfigInput | undefined;
  const command = stringValue(raw?.command);
  const url = stringValue(raw?.url);
  const type = normalizeTransportType(raw?.type, command, url, name);
  validateTransportInput(name, type, command, url);
  const toolTimeout = positiveInteger(raw?.toolTimeout ?? raw?.tool_timeout, 30, `tools.mcpServers.${name}.toolTimeout`);
  return {
    name,
    safeName: sanitizeMcpName(name),
    type,
    command,
    args: stringArray(raw?.args),
    env: stringRecord(raw?.env),
    url,
    headers: stringRecord(raw?.headers),
    toolTimeout,
    enabledTools: enabledTools(raw?.enabledTools ?? raw?.enabled_tools),
  };
}

export function wrappedMcpToolName(serverName: string, rawToolName: string): string {
  return `mcp_${sanitizeMcpName(serverName)}_${sanitizeMcpName(rawToolName)}`;
}

export function sanitizeMcpName(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "server";
}

function normalizeTransportType(
  value: unknown,
  command: string,
  url: string,
  name: string,
): McpTransportType {
  if (value === "stdio" || value === "sse" || value === "streamableHttp") {
    return value;
  }
  if (value !== undefined && value !== null && value !== "") {
    throw new Error(`MCP server '${name}' has unsupported type '${String(value)}'`);
  }
  if (command) {
    return "stdio";
  }
  if (url) {
    return url.replace(/\/+$/, "").endsWith("/sse") ? "sse" : "streamableHttp";
  }
  throw new Error(`MCP server '${name}' requires command or url`);
}

function validateTransportInput(name: string, type: McpTransportType, command: string, url: string): void {
  if (type === "stdio" && !command) {
    throw new Error(`stdio MCP server '${name}' requires command`);
  }
  if ((type === "sse" || type === "streamableHttp") && !url) {
    throw new Error(`${type} MCP server '${name}' requires url`);
  }
}

function enabledTools(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : ["*"];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringRecord(value: unknown): Record<string, string> {
  const object = asRecord(value);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(object ?? {})) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
