import type {
  AgentDefaultsConfig,
  ChannelsConfig,
  ExecToolConfig,
  GatewayConfig,
  KnowledgeConfig,
  McpServerConfig,
  ProviderConfig,
  ProviderProfileConfig,
  TinybotConfig,
} from "./configTypes.ts";

export function selectAgentDefaults(config: TinybotConfig): AgentDefaultsConfig {
  return config.agents.defaults;
}

export function selectWorkspacePath(config: TinybotConfig): string {
  return config.agents.defaults.workspace;
}

export function selectProviderConfig(config: TinybotConfig, providerId: string): ProviderConfig | undefined {
  const value = (config.providers as Record<string, unknown>)[providerId];
  return isProviderConfig(value) ? value : undefined;
}

export function selectProviderProfileConfig(config: TinybotConfig, profileName: string): ProviderProfileConfig | undefined {
  return config.providers.profiles[profileName];
}

export function selectMcpServers(config: TinybotConfig): Record<string, McpServerConfig> {
  return config.tools.mcpServers;
}

export function selectExecToolConfig(config: TinybotConfig): ExecToolConfig {
  return config.tools.exec;
}

export function selectSsrWhitelist(config: TinybotConfig): string[] {
  return config.tools.ssrfWhitelist;
}

export function selectGatewayConfig(config: TinybotConfig): GatewayConfig {
  return config.gateway;
}

export function selectKnowledgeConfig(config: TinybotConfig): KnowledgeConfig {
  return config.knowledge;
}

export function selectChannelDeliveryConfig(config: TinybotConfig): {
  sendProgress: boolean;
  sendToolHints: boolean;
  sendMaxRetries: number;
  extras: Record<string, unknown>;
} {
  return {
    sendProgress: config.channels.sendProgress,
    sendToolHints: config.channels.sendToolHints,
    sendMaxRetries: config.channels.sendMaxRetries,
    extras: channelExtras(config.channels),
  };
}

function channelExtras(channels: ChannelsConfig): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(channels)) {
    if (!["sendProgress", "sendToolHints", "sendMaxRetries"].includes(key)) {
      extras[key] = value;
    }
  }
  return extras;
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
