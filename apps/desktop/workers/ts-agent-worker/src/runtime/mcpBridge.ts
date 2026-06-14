import { sanitizeMcpName } from "../mcp/mcpConfig.ts";
import { McpRuntimeManager, type McpClientConnector, type McpRuntimeDiagnostics } from "../mcp/mcpRuntimeManager.ts";
import type { McpRawToolDefinition, McpToolCallResult, McpToolSession } from "../mcp/mcpToolWrapper.ts";
import type { McpServerConfig, McpServersConfig } from "../mcp/mcpTypes.ts";
import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { ToolContext } from "../tools/tool.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";

export type NativeMcpBridgeOptions = {
  rpcClient: NativeRpcClient;
  registry: ToolRegistry;
};

type NativeMcpServerTools = {
  name: string;
  tools: McpRawToolDefinition[];
};

type NativeMcpServerOverride = {
  enabledTools?: string[];
  toolTimeout?: number;
  connectionConfig: Record<string, unknown>;
};

export class NativeMcpBridge {
  private readonly rpcClient: NativeRpcClient;
  private readonly manager: McpRuntimeManager;
  private servers = new Map<string, NativeMcpServerTools>();
  private diagnostics: McpRuntimeDiagnostics | null = null;
  private activeConfigSignature: string | null = null;

  constructor(options: NativeMcpBridgeOptions) {
    this.rpcClient = options.rpcClient;
    const connector: McpClientConnector = {
      connect: async (server) => this.connect(server),
    };
    this.manager = new McpRuntimeManager({ registry: options.registry, connector });
  }

  async ensureConnected(traceId: string, configSnapshot?: unknown): Promise<McpRuntimeDiagnostics> {
    const overrides = nativeMcpServerOverrides(configSnapshot);
    const configSignature = overrides ? nativeMcpConfigSignature(overrides) : null;
    if (overrides && overrides.size === 0) {
      if (this.activeConfigSignature !== configSignature) {
        await this.close();
      }
      this.diagnostics = { servers: [] };
      this.activeConfigSignature = configSignature;
      return this.diagnostics;
    }
    if (this.diagnostics && this.activeConfigSignature === configSignature && configSignature !== null) {
      return this.diagnostics;
    }
    const discovery = parseNativeMcpListToolsResult(
      await this.rpcClient.request(traceId, "mcp.list_tools", {}),
    );
    this.servers = new Map(discovery.map((server) => [server.name, server]));
    this.diagnostics = await this.manager.connectAll(nativeMcpServersConfig(
      discovery,
      overrides,
    ));
    this.activeConfigSignature = configSignature;
    return this.diagnostics;
  }

  async close(): Promise<void> {
    await this.manager.close();
    this.servers.clear();
    this.diagnostics = null;
    this.activeConfigSignature = null;
  }

  getDiagnostics(): McpRuntimeDiagnostics | null {
    return this.diagnostics;
  }

  private async connect(server: McpServerConfig) {
    const discovered = this.servers.get(server.name);
    if (!discovered) {
      throw new Error(`native MCP server was not discovered: ${server.name}`);
    }
    return {
      session: new NativeMcpToolSession(this.rpcClient, server.name),
      tools: discovered.tools,
      close: async () => undefined,
    };
  }
}

class NativeMcpToolSession implements McpToolSession {
  private readonly rpcClient: NativeRpcClient;
  private readonly serverName: string;

  constructor(
    rpcClient: NativeRpcClient,
    serverName: string,
  ) {
    this.rpcClient = rpcClient;
    this.serverName = serverName;
  }

  async callTool(
    rawToolName: string,
    args: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<McpToolCallResult> {
    const params: JsonObject = {
      server: this.serverName,
      tool: rawToolName,
      arguments: args,
    };
    if (context?.sessionId) {
      params.session_id = context.sessionId;
    }
    const result = asRecord(await this.rpcClient.request(context?.traceId ?? context?.runId ?? "mcp", "mcp.call_tool", params));
    const content = result?.content;
    if (Array.isArray(content)) {
      return { content: content.filter(asRecord) };
    }
    return { content: [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(result ?? {}) }] };
  }
}

function nativeMcpServersConfig(
  servers: NativeMcpServerTools[],
  overrides?: Map<string, NativeMcpServerOverride>,
): McpServersConfig {
  return Object.fromEntries(servers
    .filter((server) => !overrides || overrides.has(server.name))
    .map((server) => [server.name, {
      name: server.name,
      safeName: sanitizeMcpName(server.name),
      type: "stdio",
      command: "native",
      args: [],
      env: {},
      url: "",
      headers: {},
      toolTimeout: overrides?.get(server.name)?.toolTimeout ?? 30,
      enabledTools: overrides?.get(server.name)?.enabledTools ?? ["*"],
    }]));
}

function nativeMcpServerOverrides(configSnapshot: unknown): Map<string, NativeMcpServerOverride> | undefined {
  if (configSnapshot === undefined) {
    return undefined;
  }
  const tools = asRecord(asRecord(configSnapshot)?.tools);
  const servers = asRecord(tools?.mcpServers ?? tools?.mcp_servers);
  const overrides = new Map<string, NativeMcpServerOverride>();
  for (const [name, value] of Object.entries(servers ?? {})) {
    const server = asRecord(value);
    if (!server) {
      continue;
    }
    const override: NativeMcpServerOverride = {
      connectionConfig: nativeMcpServerConnectionSignature(server),
    };
    const enabledTools = server.enabledTools ?? server.enabled_tools;
    if (Array.isArray(enabledTools)) {
      override.enabledTools = enabledTools.filter((tool): tool is string => typeof tool === "string");
    }
    const toolTimeout = server.toolTimeout ?? server.tool_timeout;
    if (typeof toolTimeout === "number" && Number.isInteger(toolTimeout) && toolTimeout >= 1) {
      override.toolTimeout = toolTimeout;
    }
    overrides.set(name, override);
  }
  return overrides;
}

function nativeMcpConfigSignature(overrides: Map<string, NativeMcpServerOverride>): string {
  return JSON.stringify(Array.from(overrides.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, override]) => [
      name,
      {
        enabledTools: override.enabledTools ? [...override.enabledTools].sort() : undefined,
        toolTimeout: override.toolTimeout,
        connectionConfig: stableJsonValue(override.connectionConfig),
      },
    ]));
}

function nativeMcpServerConnectionSignature(server: Record<string, unknown>): Record<string, unknown> {
  return {
    type: server.type,
    command: server.command,
    args: server.args,
    env: server.env,
    url: server.url,
    headers: server.headers,
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableJsonValue(item)]));
  }
  if (value === null || ["boolean", "number", "string"].includes(typeof value)) {
    return value;
  }
  return undefined;
}

function parseNativeMcpListToolsResult(value: unknown): NativeMcpServerTools[] {
  const result = asRecord(value);
  const servers = Array.isArray(result?.servers) ? result.servers : [];
  return servers.map(asNativeMcpServerTools).filter((server): server is NativeMcpServerTools => server !== undefined);
}

function asNativeMcpServerTools(value: unknown): NativeMcpServerTools | undefined {
  const server = asRecord(value);
  if (!server || typeof server.name !== "string") {
    return undefined;
  }
  const tools = Array.isArray(server.tools)
    ? server.tools.map(asNativeMcpRawTool).filter((tool): tool is McpRawToolDefinition => tool !== undefined)
    : [];
  return { name: server.name, tools };
}

function asNativeMcpRawTool(value: unknown): McpRawToolDefinition | undefined {
  const tool = asRecord(value);
  if (!tool || typeof tool.name !== "string") {
    return undefined;
  }
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : undefined,
    inputSchema: tool.inputSchema ?? tool.input_schema,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
