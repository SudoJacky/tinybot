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

export class NativeMcpBridge {
  private readonly rpcClient: NativeRpcClient;
  private readonly manager: McpRuntimeManager;
  private servers = new Map<string, NativeMcpServerTools>();

  constructor(options: NativeMcpBridgeOptions) {
    this.rpcClient = options.rpcClient;
    const connector: McpClientConnector = {
      connect: async (server) => this.connect(server),
    };
    this.manager = new McpRuntimeManager({ registry: options.registry, connector });
  }

  async ensureConnected(traceId: string): Promise<McpRuntimeDiagnostics> {
    const discovery = parseNativeMcpListToolsResult(
      await this.rpcClient.request(traceId, "mcp.list_tools", {}),
    );
    this.servers = new Map(discovery.map((server) => [server.name, server]));
    return this.manager.connectAll(nativeMcpServersConfig(discovery));
  }

  async close(): Promise<void> {
    await this.manager.close();
    this.servers.clear();
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
  constructor(
    private readonly rpcClient: NativeRpcClient,
    private readonly serverName: string,
  ) {}

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

function nativeMcpServersConfig(servers: NativeMcpServerTools[]): McpServersConfig {
  return Object.fromEntries(servers.map((server) => [server.name, {
    name: server.name,
    safeName: sanitizeMcpName(server.name),
    type: "stdio",
    command: "native",
    args: [],
    env: {},
    url: "",
    headers: {},
    toolTimeout: 30,
    enabledTools: ["*"],
  }]));
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
