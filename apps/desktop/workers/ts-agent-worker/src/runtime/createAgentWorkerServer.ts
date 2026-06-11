import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider.ts";
import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { WorkerEvent } from "../protocol/messages.ts";
import { RpcClient } from "../protocol/rpcClient.ts";
import { StdioServer } from "../protocol/stdioServer.ts";
import {
  createNativeApprovalTools,
  createNativeFormTools,
  createNativeMcpTools,
  createNativeMemoryTools,
  createNativeRagTools,
  createNativeReadOnlyTools,
  createNativeShellTools,
  createNativeWriteTools,
} from "../tools/nativeToolProxy.ts";
import { registerToolsByPolicy } from "../tools/toolPolicy.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import { NativeApprovalBridge } from "./approvalBridge.ts";
import { AgentWorker } from "./agentWorker.ts";
import { NativeConfigBridge, modelProviderConfigFromNativeConfig } from "./configBridge.ts";
import { NativeContextBridge } from "./contextBridge.ts";
import { createModelProvider, type ModelProviderConfig } from "./providerFactory.ts";
import { NativeSessionBridge } from "./sessionBridge.ts";

export type CreateAgentWorkerServerOptions = {
  provider?: ModelProvider;
  tools: ToolRegistry;
  env?: Record<string, string | undefined>;
  capabilities?: string[];
  channel?: string;
  createModelProvider?: (config: ModelProviderConfig) => ModelProvider;
  writeLine: (line: string) => void;
  writeLog: (line: string) => void;
};

export function createAgentWorkerServer(options: CreateAgentWorkerServerOptions): StdioServer {
  const rpcClient = new RpcClient({ writeLine: options.writeLine });
  registerToolsByPolicy(
    options.tools,
    [
      ...createNativeReadOnlyTools(rpcClient),
      ...createNativeWriteTools(rpcClient),
      ...createNativeShellTools(rpcClient),
      ...createNativeApprovalTools(rpcClient),
      ...createNativeFormTools(rpcClient),
      ...createNativeMemoryTools(rpcClient),
      ...createNativeRagTools(rpcClient),
      ...createNativeMcpTools(rpcClient),
    ],
    {
      capabilities: options.capabilities ?? DEFAULT_NATIVE_TOOL_CAPABILITIES,
      channel: options.channel ?? "agent_ui",
    },
  );
  const writeEvent = (event: WorkerEvent): void => {
    options.writeLine(JSON.stringify(event));
  };
  const provider =
    options.provider ??
    new LazyModelProvider(async () => {
      const config = await modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), options.env ?? process.env);
      return (options.createModelProvider ?? createModelProvider)(config);
    });
  const worker = new AgentWorker({
    provider,
    tools: options.tools,
    emitEvent: writeEvent,
    approvalBridge: new NativeApprovalBridge(rpcClient),
    sessionBridge: new NativeSessionBridge(rpcClient),
    contextBridge: new NativeContextBridge(rpcClient),
  });
  return new StdioServer({
    worker,
    rpcClient,
    writeLine: options.writeLine,
    writeLog: options.writeLog,
  });
}

const DEFAULT_NATIVE_TOOL_CAPABILITIES = [
  "fs.workspace.read",
  "fs.workspace.write",
  "shell.execute",
  "approval.request",
  "form.request",
  "memory.read",
  "memory.write",
  "mcp.call",
];

class LazyModelProvider implements ModelProvider {
  private provider: Promise<ModelProvider> | null = null;
  private readonly loadProvider: () => Promise<ModelProvider>;

  constructor(loadProvider: () => Promise<ModelProvider>) {
    this.loadProvider = loadProvider;
  }

  async complete(messages: AgentMessage[], options?: ModelRequestOptions): Promise<ModelResponse> {
    const provider = await this.getProvider();
    return provider.complete(messages, options);
  }

  private getProvider(): Promise<ModelProvider> {
    this.provider ??= this.loadProvider();
    return this.provider;
  }
}
