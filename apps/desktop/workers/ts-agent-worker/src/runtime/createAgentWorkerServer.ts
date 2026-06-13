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
import { selectConfiguredChannelNames } from "../channels/channelConfig.ts";
import { parseTinybotConfig } from "../config/configSchema.ts";
import { HeartbeatRuntime } from "../heartbeat/heartbeatRuntime.ts";
import { selectHeartbeatTarget } from "../heartbeat/heartbeatTarget.ts";
import {
  createNativeApprovalTools,
  createNativeCronTools,
  createNativeFormTools,
  createNativeMcpTools,
  createNativeMemoryTools,
  createNativeRagTools,
  createNativeReadOnlyTools,
  createNativeShellTools,
  createNativeTaskTools,
  createNativeWriteTools,
} from "../tools/nativeToolProxy.ts";
import { registerToolsByPolicy } from "../tools/toolPolicy.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";
import { NativeBackgroundRegistryBridge } from "../background/backgroundRegistryBridge.ts";
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
import { NativeDreamBridge } from "./dreamBridge.ts";
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
      ...createNativeCronTools(rpcClient),
      ...createNativeTaskTools(rpcClient, {
        provider,
        backgroundRegistry: capabilities.includes("background.write")
          ? new NativeBackgroundRegistryBridge(rpcClient)
          : undefined,
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
  const heartbeatRuntime = new HeartbeatRuntime({
    model: options.env?.TINYBOT_MODEL ?? options.env?.OPENAI_MODEL ?? "default",
    provider,
    runner: new AgentRunner({ provider, tools: options.tools }),
    readHeartbeatFile: async () => (await workspaceBridge.readFile("HEARTBEAT.md", "trace-heartbeat-read"))?.content,
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
    currentTime: () => new Date().toISOString(),
  });
  const worker = new AgentWorker({
    provider,
    tools: options.tools,
    emitEvent: writeEvent,
    prepareTools: mcpBridge ? (traceId) => mcpBridge.ensureConnected(traceId).catch((error) => {
      options.writeLog(`native MCP discovery failed: ${errorMessage(error)}`);
    }) : undefined,
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
    dreamBridge: new NativeDreamBridge(rpcClient),
    sessionBridge,
    workspaceBridge,
    webuiSessionProvider: sessionBridge,
    webuiConfigProvider: {
      getConfig: () => configBridge.snapshotPublic(),
      patchConfig: async (body) => configBridge.applyPatch(
        await configBridge.snapshotPublic(),
        body,
      ),
    },
    knowledgeProvider: new NativeKnowledgeBridge(rpcClient),
    memoryBridge: new NativeMemoryBridge(rpcClient),
    contextBridge: new NativeContextBridge(rpcClient),
    coworkService,
    coworkScheduler,
    heartbeatRuntime,
    statusProvider: async () => {
      const runtime = await providerRuntimeFromNativeConfig(configBridge, options.env ?? process.env, {});
      const providerId = stringValue(runtime.providerId);
      return {
        channelRunning: true,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function heartbeatConfigFromNativeConfig(configBridge: NativeConfigBridge) {
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
