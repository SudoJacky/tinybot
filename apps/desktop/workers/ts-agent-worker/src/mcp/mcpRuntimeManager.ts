import type { ToolRegistry } from "../tools/toolRegistry.ts";
import { wrappedMcpToolName } from "./mcpConfig.ts";
import type { McpServerConfig, McpServersConfig, McpTransportType } from "./mcpTypes.ts";
import { createMcpToolWrapper, type McpRawToolDefinition, type McpToolSession } from "./mcpToolWrapper.ts";

export type McpConnectedClient = {
  session: McpToolSession;
  tools: McpRawToolDefinition[];
  close(): Promise<void>;
};

export type McpClientConnector = {
  connect(server: McpServerConfig): Promise<McpConnectedClient>;
};

export type McpServerDiagnostic = {
  name: string;
  transport: McpTransportType;
  status: "connected" | "failed";
  registeredTools: string[];
  skippedTools: string[];
  unmatchedEnabledTools: string[];
  error: string | null;
};

export type McpRuntimeDiagnostics = {
  servers: McpServerDiagnostic[];
};

export type McpRuntimeManagerOptions = {
  registry: ToolRegistry;
  connector: McpClientConnector;
};

export class McpRuntimeManager {
  private readonly registry: ToolRegistry;
  private readonly connector: McpClientConnector;
  private readonly clients = new Map<string, McpConnectedClient>();
  private readonly registeredTools = new Set<string>();

  constructor(options: McpRuntimeManagerOptions) {
    this.registry = options.registry;
    this.connector = options.connector;
  }

  async connectAll(config: McpServersConfig): Promise<McpRuntimeDiagnostics> {
    await this.close();
    const servers: McpServerDiagnostic[] = [];
    for (const server of Object.values(config)) {
      servers.push(await this.connectServer(server));
    }
    return { servers };
  }

  async close(): Promise<void> {
    for (const name of this.registeredTools) {
      this.registry.unregister(name);
    }
    this.registeredTools.clear();
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    await Promise.all(clients.map(async (client) => {
      try {
        await client.close();
      } catch {
        // Best effort close; connection errors are surfaced during connect diagnostics.
      }
    }));
  }

  private async connectServer(server: McpServerConfig): Promise<McpServerDiagnostic> {
    try {
      const client = await this.connector.connect(server);
      this.clients.set(server.name, client);
      const registeredTools: string[] = [];
      const skippedTools: string[] = [];
      const matchedAllowlist = new Set<string>();
      const allowAll = server.enabledTools.includes("*");
      for (const rawTool of client.tools) {
        const wrappedName = wrappedMcpToolName(server.safeName, rawTool.name);
        if (!allowAll && !server.enabledTools.includes(rawTool.name) && !server.enabledTools.includes(wrappedName)) {
          skippedTools.push(wrappedName);
          continue;
        }
        const tool = createMcpToolWrapper({
          session: client.session,
          serverName: server.safeName,
          rawTool,
          toolTimeout: server.toolTimeout,
        });
        this.registry.register(tool);
        this.registeredTools.add(tool.name);
        registeredTools.push(tool.name);
        if (server.enabledTools.includes(rawTool.name)) {
          matchedAllowlist.add(rawTool.name);
        }
        if (server.enabledTools.includes(wrappedName)) {
          matchedAllowlist.add(wrappedName);
        }
      }
      return {
        name: server.name,
        transport: server.type,
        status: "connected",
        registeredTools,
        skippedTools,
        unmatchedEnabledTools: allowAll ? [] : server.enabledTools.filter((name) => !matchedAllowlist.has(name)),
        error: null,
      };
    } catch (error) {
      return {
        name: server.name,
        transport: server.type,
        status: "failed",
        registeredTools: [],
        skippedTools: [],
        unmatchedEnabledTools: [],
        error: errorMessage(error),
      };
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
