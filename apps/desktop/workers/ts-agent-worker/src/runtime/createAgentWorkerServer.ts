import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider.ts";
import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { WorkerEvent } from "../protocol/messages.ts";
import type { JsonFetcher } from "../providers/modelDiscovery.ts";
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
import {
  NativeConfigBridge,
  modelProviderConfigFromNativeConfig,
  providerCatalogForSettings,
  providerModelValidationResult,
  providerModelsFromNativeConfig,
  providerRuntimeFromNativeConfig,
} from "./configBridge.ts";
import { NativeContextBridge } from "./contextBridge.ts";
import { NativeMemoryBridge } from "./memoryBridge.ts";
import { createModelProvider, type ModelProviderConfig } from "./providerFactory.ts";
import { NativeSessionBridge } from "./sessionBridge.ts";
import { NativeSkillsBridge } from "./skillsBridge.ts";

export type CreateAgentWorkerServerOptions = {
  provider?: ModelProvider;
  tools: ToolRegistry;
  env?: Record<string, string | undefined>;
  capabilities?: string[];
  channel?: string;
  createModelProvider?: (config: ModelProviderConfig) => ModelProvider;
  fetchProviderModelsJson?: JsonFetcher;
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
  const configBridge = new NativeConfigBridge(rpcClient);
  const lazyProvider = options.provider
    ? undefined
    : new LazyModelProvider(async () => {
      const config = await modelProviderConfigFromNativeConfig(configBridge, options.env ?? process.env);
      return (options.createModelProvider ?? createModelProvider)(config);
    });
  const provider = options.provider ?? lazyProvider;
  if (!provider) {
    throw new Error("model provider is unavailable");
  }
  const worker = new AgentWorker({
    provider,
    tools: options.tools,
    emitEvent: writeEvent,
    reloadProvider: lazyProvider ? () => lazyProvider.reload() : undefined,
    listProviderModels: (request) => providerModelsFromNativeConfig(
      configBridge,
      options.env ?? process.env,
      request,
      options.fetchProviderModelsJson,
    ),
    listProviderCatalog: () => providerCatalogForSettings(),
    resolveProviderRuntime: (request) => providerRuntimeFromNativeConfig(configBridge, options.env ?? process.env, request),
    validateProviderModel: (request) => providerModelValidationResult(request),
    skillsBridge: new NativeSkillsBridge(rpcClient, options.env ?? process.env),
    approvalBridge: new NativeApprovalBridge(rpcClient),
    sessionBridge: new NativeSessionBridge(rpcClient),
    memoryBridge: new NativeMemoryBridge(rpcClient),
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

  reload(): { reloaded: true } {
    this.provider = null;
    return { reloaded: true };
  }

  private getProvider(): Promise<ModelProvider> {
    this.provider ??= this.loadProvider();
    return this.provider;
  }
}
