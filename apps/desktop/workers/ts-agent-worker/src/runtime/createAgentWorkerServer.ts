import { AgentRunner } from "../agent/agentRunner.ts";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "../model/provider.ts";
import type { AgentMessage } from "../agent/agentRunSpec.ts";
import { WORKER_PROTOCOL_VERSION, type WorkerEvent } from "../protocol/messages.ts";
import type { JsonFetcher } from "../providers/modelDiscovery.ts";
import { RpcClient } from "../protocol/rpcClient.ts";
import { StdioServer } from "../protocol/stdioServer.ts";
import { CoworkAgentRuntime } from "../cowork/coworkAgentRuntime.ts";
import { CoworkScheduler } from "../cowork/coworkScheduler.ts";
import { CoworkService } from "../cowork/coworkService.ts";
import { NativeCoworkStoreBridge } from "../cowork/coworkStoreBridge.ts";
import { CoworkTeamPlanner } from "../cowork/coworkTeamPlanner.ts";
import { createCoworkTool } from "../cowork/coworkTool.ts";
import { MessageBus } from "../bus/messageBus.ts";
import { ChannelManager } from "../channels/channelManager.ts";
import { selectChannelDeliveryOptions, selectConfiguredChannelNames } from "../channels/channelConfig.ts";
import { createNativeChannelConnectorBridgeRegistry } from "../channels/nativeChannelConnectorBridge.ts";
import {
  createNativeTextChannelAdapters,
  type NativeTextChannelConnectorRegistry,
} from "../channels/nativeChannelFactory.ts";
import { parseTinybotConfig } from "../config/configSchema.ts";
import type { TinybotConfig } from "../config/configTypes.ts";
import { HeartbeatRuntime } from "../heartbeat/heartbeatRuntime.ts";
import { selectHeartbeatTarget } from "../heartbeat/heartbeatTarget.ts";
import { currentTimeString } from "../support/messageHelpers.ts";
import {
  createNativeApprovalTools,
  createNativeCronTools,
  createNativeFormTools,
  createNativeMcpTools,
  createNativeMemoryTools,
  createNativeRagTools,
  createNativeReadOnlyTools,
  createNativeShellTools,
  createNativeSpawnTools,
  createNativeTaskTools,
  createNativeWriteTools,
} from "../tools/nativeToolProxy.ts";
import { registerToolsByPolicy } from "../tools/toolPolicy.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import { NativeBackgroundRegistryBridge } from "../background/backgroundRegistryBridge.ts";
import { NativeApprovalBridge } from "./approvalBridge.ts";
import { AgentWorker, type ChannelLifecycleManager } from "./agentWorker.ts";
import {
  NativeConfigBridge,
  modelProviderConfigFromNativeConfig,
  providerCatalogForSettings,
  providerModelValidationResult,
  providerModelsFromNativeConfig,
  providerRuntimeFromNativeConfig,
} from "./configBridge.ts";
import { NativeContextBridge } from "./contextBridge.ts";
import { NativeDreamBridge, ProviderBackedDreamBridge } from "./dreamBridge.ts";
import { NativeKnowledgeBridge } from "./knowledgeBridge.ts";
import { NativeMcpBridge } from "./mcpBridge.ts";
import { NativeMemoryBridge } from "./memoryBridge.ts";
import { createModelProvider, type ModelProviderConfig } from "./providerFactory.ts";
import { NativeSessionBridge } from "./sessionBridge.ts";
import { NativeSkillsBridge } from "./skillsBridge.ts";
import { NativeWorkspaceBridge } from "./workspaceBridge.ts";
import { NativeTaskNotificationBridge, NativeTaskProgressCardBridge } from "../task/taskNotificationBridge.ts";

export type CreateAgentWorkerServerOptions = {
  provider?: ModelProvider;
  tools: ToolRegistry;
  env?: Record<string, string | undefined>;
  capabilities?: string[];
  channel?: string;
  enableNativeMcpDiscovery?: boolean;
  createModelProvider?: (config: ModelProviderConfig) => ModelProvider;
  fetchProviderModelsJson?: JsonFetcher;
  channelManager?: ChannelLifecycleManager;
  nativeChannelConnectors?: NativeTextChannelConnectorRegistry;
  nativeChannelConnectorBridgeChannels?: string[];
  writeLine: (line: string) => void;
  writeLog: (line: string) => void;
};

export function createAgentWorkerServer(options: CreateAgentWorkerServerOptions): StdioServer {
  const rpcClient = new RpcClient({ writeLine: options.writeLine });
  const capabilities = options.capabilities ?? DEFAULT_NATIVE_TOOL_CAPABILITIES;
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
  const coworkStore = new NativeCoworkStoreBridge(rpcClient);
  const coworkService = new CoworkService({ store: coworkStore });
  const backgroundRegistry = capabilities.includes("background.write")
    ? new NativeBackgroundRegistryBridge(rpcClient)
    : undefined;
  const coworkAgentRuntime = new CoworkAgentRuntime({
    store: coworkStore,
    runner: new AgentRunner({ provider, tools: options.tools }),
    tools: options.tools,
    model: options.env?.TINYBOT_MODEL ?? options.env?.OPENAI_MODEL ?? "default",
  });
  const coworkScheduler = new CoworkScheduler({ store: coworkStore, agentRuntime: coworkAgentRuntime });
  const coworkPlanner = new CoworkTeamPlanner({
    provider,
    workspace: process.cwd(),
  });
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
      ...createNativeCronTools(rpcClient, {
        defaultTimezone: async () => (await cronConfigFromNativeConfig(configBridge)).agents.defaults.timezone,
      }),
      ...createNativeSpawnTools(rpcClient, {
        provider,
        model: options.env?.TINYBOT_MODEL ?? options.env?.OPENAI_MODEL ?? "default",
        backgroundRegistry,
      }),
      ...createNativeTaskTools(rpcClient, {
        provider,
        backgroundRegistry,
        notifier: capabilities.includes("session.write")
          ? new NativeTaskNotificationBridge(rpcClient)
          : undefined,
        progressCard: capabilities.includes("session.write")
          ? new NativeTaskProgressCardBridge(rpcClient)
          : undefined,
        progressPublisher: {
          publishTaskProgress: (event, traceId) => writeEvent({
            protocol_version: WORKER_PROTOCOL_VERSION,
            trace_id: traceId,
            event: "agent.task_progress",
            payload: {
              ...event,
              plan_id: event.planId,
              subtask_id: event.subtaskId,
              subtask_title: event.subtaskTitle,
            },
          }),
        },
      }),
      createCoworkTool({ service: coworkService, planner: coworkPlanner, scheduler: coworkScheduler }),
    ],
    {
      capabilities,
      channel: options.channel ?? "agent_ui",
    },
  );
  const mcpBridge = options.enableNativeMcpDiscovery === true && capabilities.includes("mcp.call")
    ? new NativeMcpBridge({ rpcClient, registry: options.tools })
    : undefined;
  const sessionBridge = new NativeSessionBridge(rpcClient);
  const workspaceBridge = new NativeWorkspaceBridge(rpcClient);
  const channelBus = new MessageBus();
  const nativeChannelConnectors = options.nativeChannelConnectors
    ?? createNativeChannelConnectorBridgeRegistry({
      rpcClient,
      channels: options.nativeChannelConnectorBridgeChannels ?? [],
    });
  const channelManager = options.channelManager ?? createDefaultChannelManager({
    bus: channelBus,
    configBridge,
    connectors: nativeChannelConnectors,
    env: options.env ?? process.env,
    writeLog: options.writeLog,
  });
  const heartbeatRuntime = new HeartbeatRuntime({
    model: options.env?.TINYBOT_MODEL ?? options.env?.OPENAI_MODEL ?? "default",
    provider,
    runner: new AgentRunner({ provider, tools: options.tools }),
    readHeartbeatFile: async () => (await workspaceBridge.readFile("HEARTBEAT.md", "trace-heartbeat-read"))?.content,
    config: async () => {
      const config = await heartbeatConfigFromNativeConfig(configBridge);
      return {
        enabled: config.gateway.heartbeat.enabled,
        intervalMs: config.gateway.heartbeat.intervalS * 1000,
      };
    },
    keepRecentMessages: async () => (await heartbeatConfigFromNativeConfig(configBridge)).gateway.heartbeat.keepRecentMessages,
    selectTarget: async () => {
      const [config, sessions] = await Promise.all([
        heartbeatConfigFromNativeConfig(configBridge),
        sessionBridge.listSessions("trace-heartbeat-target").catch(() => []),
      ]);
      return selectHeartbeatTarget({
        enabledChannels: selectConfiguredChannelNames(config),
        sessions: sessions.map((session) => ({
          key: session.sessionId,
          updatedAtMs: Date.parse(session.updatedAt),
        })),
      });
    },
    currentTime: async () => currentTimeString((await heartbeatConfigFromNativeConfig(configBridge)).agents.defaults.timezone),
    notifyExternal: ({ channel, chatId, content, tasks }) => writeEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: "trace-heartbeat-delivery",
      event: "heartbeat.delivery",
      payload: {
        channel,
        chatId,
        chat_id: chatId,
        content,
        tasks,
      },
    }),
    trimHeartbeatSession: async (keepRecentMessages) => {
      await sessionBridge.trimSession(
        "heartbeat",
        keepRecentMessages,
        "trace-heartbeat-trim",
      );
    },
  });
  const worker = new AgentWorker({
    provider,
    tools: options.tools,
    emitEvent: writeEvent,
    prepareTools: mcpBridge ? (traceId) => mcpBridge.ensureConnected(traceId).catch((error) => {
      options.writeLog(`native MCP discovery failed: ${errorMessage(error)}`);
    }) : undefined,
    reloadProvider: lazyProvider ? () => lazyProvider.reload() : undefined,
    requestRestart: async (request) => {
      await rpcClient.request(request.traceId, "runtime.restart", {
        ...(request.runId ? { run_id: request.runId } : {}),
        ...(request.sessionId ? { session_id: request.sessionId } : {}),
      });
    },
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
    dreamBridge: new ProviderBackedDreamBridge({
      nativeBridge: new NativeDreamBridge(rpcClient),
      provider,
      model: options.env?.TINYBOT_MODEL ?? options.env?.OPENAI_MODEL ?? "default",
    }),
    sessionBridge,
    workspaceBridge,
    webuiSessionProvider: sessionBridge,
    webuiConfigProvider: {
      getConfig: () => configBridge.snapshotPublic(),
      patchConfig: async (body, traceId = "trace-config-patch") => {
        const result = await configBridge.applyPatch(
          await configBridge.snapshotPublic(),
          body,
        );
        if (mcpBridge && configPatchTouchesMcpServers(result.updatedFields)) {
          await mcpBridge.close();
          await mcpBridge.ensureConnected(traceId, result.config);
        }
        return result;
      },
    },
    knowledgeProvider: new NativeKnowledgeBridge(rpcClient),
    memoryBridge: new NativeMemoryBridge(rpcClient),
    contextBridge: new NativeContextBridge(rpcClient),
    coworkService,
    coworkScheduler,
    heartbeatRuntime,
    channelManager,
    channelBus,
    statusProvider: async () => {
      const runtime = await providerRuntimeFromNativeConfig(configBridge, options.env ?? process.env, {});
      const providerId = stringValue(runtime.providerId);
      return {
        channelRunning: true,
        mcp: mcpBridge?.getDiagnostics() ?? null,
        provider: providerId ? { name: providerId, profile: stringValue(runtime.profileName) } : null,
        model: stringValue(runtime.model) ?? null,
      };
    },
  });
  return new StdioServer({
    worker,
    rpcClient,
    writeLine: options.writeLine,
    writeLog: options.writeLog,
  });
}

type DefaultChannelManagerOptions = {
  bus: MessageBus;
  configBridge: NativeConfigBridge;
  connectors: NativeTextChannelConnectorRegistry;
  env: Record<string, string | undefined>;
  writeLog: (line: string) => void;
};

function createDefaultChannelManager(options: DefaultChannelManagerOptions): ChannelLifecycleManager {
  return new DefaultNativeChannelLifecycleManager(options);
}

class DefaultNativeChannelLifecycleManager implements ChannelLifecycleManager {
  private readonly bus: MessageBus;
  private readonly configBridge: NativeConfigBridge;
  private readonly connectors: NativeTextChannelConnectorRegistry;
  private readonly env: Record<string, string | undefined>;
  private readonly writeLog: (line: string) => void;
  private manager: ChannelManager | null = null;

  constructor(options: DefaultChannelManagerOptions) {
    this.bus = options.bus;
    this.configBridge = options.configBridge;
    this.connectors = options.connectors;
    this.env = options.env;
    this.writeLog = options.writeLog;
  }

  async startAll(): Promise<void> {
    const manager = await this.managerForCurrentConfig();
    await manager.startAll();
  }

  async stopAll(): Promise<void> {
    await this.manager?.stopAll();
  }

  async login(channelName: string, options: { force?: boolean } = {}): Promise<boolean> {
    const manager = await this.managerForCurrentConfig();
    return manager.login(channelName, options);
  }

  status() {
    return this.manager?.status() ?? emptyChannelManagerStatus(this.bus);
  }

  private async managerForCurrentConfig(): Promise<ChannelManager> {
    if (this.manager) {
      return this.manager;
    }
    if (Object.keys(this.connectors).length === 0) {
      this.manager = new ChannelManager({
        bus: this.bus,
        channels: [],
        env: this.env,
      });
      return this.manager;
    }
    const config = await this.loadChannelConfig();
    const deliveryOptions = selectChannelDeliveryOptions(config);
    const { adapters, skipped } = createNativeTextChannelAdapters({
      config,
      bus: this.bus,
      connectors: this.connectors,
      transcriptionApiKey: this.env.GROQ_API_KEY,
    });
    for (const skip of skipped) {
      this.writeLog(`native channel ${skip.name} skipped: ${skip.reason}`);
    }
    this.manager = new ChannelManager({
      bus: this.bus,
      channels: adapters,
      sendProgress: deliveryOptions.sendProgress,
      sendToolHints: deliveryOptions.sendToolHints,
      sendMaxRetries: deliveryOptions.sendMaxRetries,
      env: this.env,
    });
    return this.manager;
  }

  private async loadChannelConfig(): Promise<TinybotConfig> {
    try {
      return parseTinybotConfig(await this.configBridge.snapshotPublic());
    } catch (error) {
      this.writeLog(`failed to load native channel config: ${errorMessage(error)}`);
      return parseTinybotConfig({});
    }
  }
}

function emptyChannelManagerStatus(bus: MessageBus) {
  return {
    running: false,
    channels: [],
    diagnostics: [],
    bus: bus.stats(),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function configPatchTouchesMcpServers(updatedFields: unknown): boolean {
  return Array.isArray(updatedFields)
    && updatedFields.some((field) => {
      if (typeof field !== "string") {
        return false;
      }
      return field.includes("tools.mcpServers") || field.includes("tools.mcp_servers");
    });
}

async function heartbeatConfigFromNativeConfig(configBridge: NativeConfigBridge) {
  try {
    return parseTinybotConfig(await configBridge.snapshotPublic());
  } catch {
    return parseTinybotConfig({});
  }
}

async function cronConfigFromNativeConfig(configBridge: NativeConfigBridge) {
  try {
    return parseTinybotConfig(await configBridge.snapshotPublic());
  } catch {
    return parseTinybotConfig({});
  }
}

const DEFAULT_NATIVE_TOOL_CAPABILITIES = [
  "fs.workspace.read",
  "fs.workspace.write",
  "shell.execute",
  "approval.request",
  "form.request",
  "memory.read",
  "memory.write",
  "knowledge.read",
  "knowledge.write",
  "mcp.call",
  "cron.read",
  "cron.write",
  "background.read",
  "background.write",
  "session.write",
  "task.read",
  "task.write",
  "cowork.read",
  "cowork.write",
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
