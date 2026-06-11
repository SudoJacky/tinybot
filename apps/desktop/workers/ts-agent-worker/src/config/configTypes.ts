export type JsonRecord = Record<string, unknown>;

export type TinybotConfig = {
  agents: {
    defaults: AgentDefaultsConfig;
  };
  channels: ChannelsConfig;
  providers: ProvidersConfig;
  api: ApiConfig;
  gateway: GatewayConfig;
  tools: ToolsConfig;
  skills: SkillsConfig;
  knowledge: KnowledgeConfig;
};

export type AgentDefaultsConfig = {
  workspace: string;
  model: string;
  activeProfile: string | null;
  provider: string;
  maxTokens: number;
  contextWindowTokens: number;
  contextBlockLimit: number | null;
  temperature: number;
  maxToolIterations: number;
  maxToolResultChars: number;
  providerRetryMode: "standard" | "persistent";
  reasoningEffort: "low" | "medium" | "high" | null;
  timezone: string;
  enableVectorStore: boolean;
  embedding: EmbeddingConfig;
  dream: DreamConfig;
  recentContext: RecentContextConfig;
};

export type EmbeddingConfig = {
  provider: "openai" | "azure" | "custom";
  modelName: string;
  apiKey: string;
  apiKeyEnvVar: string | null;
  apiBase: string | null;
  apiType: string | null;
  apiVersion: string | null;
};

export type DreamConfig = {
  intervalH: number;
  modelOverride: string | null;
  maxBatchSize: number;
  maxIterations: number;
  extractionEveryNTurns: number;
  extractionIdleSeconds: number;
};

export type RecentContextConfig = {
  enabled: boolean;
  recencyDays: number;
  maxRecords: number;
  scanLimit: number;
};

export type ChannelsConfig = {
  sendProgress: boolean;
  sendToolHints: boolean;
  sendMaxRetries: number;
} & JsonRecord;

export type ProviderConfig = {
  enabled: boolean | null;
  apiKey: string;
  apiBase: string | null;
  enableSearch: boolean;
  models?: string[];
  manualModels?: string[];
  supportsModelDiscovery?: boolean;
  extraBody?: JsonRecord;
  requestSettings?: JsonRecord;
  provider?: string;
} & JsonRecord;

export type ProviderProfileConfig = ProviderConfig & {
  provider: string;
  models: string[];
  manualModels: string[];
  supportsModelDiscovery: boolean;
  extraBody: JsonRecord;
  requestSettings: JsonRecord;
};

export type ProvidersConfig = {
  openai: ProviderConfig;
  deepseek: ProviderConfig;
  dashscope: ProviderConfig;
  profiles: Record<string, ProviderProfileConfig>;
} & Record<string, ProviderConfig | Record<string, ProviderProfileConfig>>;

export type ApiConfig = {
  host: string;
  port: number;
  timeout: number;
};

export type GatewayConfig = {
  host: string;
  port: number;
  heartbeat: HeartbeatConfig;
};

export type HeartbeatConfig = {
  enabled: boolean;
  intervalS: number;
  keepRecentMessages: number;
};

export type ToolsConfig = {
  web: WebToolsConfig;
  exec: ExecToolConfig;
  restrictToWorkspace: boolean;
  mcpServers: Record<string, McpServerConfig>;
  ssrfWhitelist: string[];
};

export type WebToolsConfig = {
  enable: boolean;
  proxy: string | null;
  search: WebSearchConfig;
};

export type WebSearchConfig = {
  provider: string;
  apiKey: string;
  baseUrl: string;
  maxResults: number;
};

export type ExecToolConfig = {
  enable: boolean;
  timeout: number;
  pathAppend: string;
};

export type McpServerConfig = {
  type: "stdio" | "sse" | "streamableHttp" | null;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  toolTimeout: number;
  enabledTools: string[];
};

export type SkillsConfig = {
  enabled: string[];
};

export type KnowledgeConfig = {
  enabled: boolean;
  autoRetrieve: boolean;
  maxChunks: number;
  chunkSize: number;
  chunkOverlap: number;
  childChunkSize: number;
  childChunkOverlap: number;
  retrievalMode: string;
  rrfK: number;
  bm25K: number;
  bm25B: number;
  denseWeight: number;
  sparseWeight: number;
  rerankEnabled: boolean;
  rerankModel: string;
  rerankApiKey: string | null;
  rerankApiKeyEnvVar: string;
  rerankApiBase: string;
  rerankTopN: number;
  generateSummary: boolean;
  semanticExtractionMode: "rule" | "llm" | "hybrid";
  llmExtractionStrategy: "single_pass" | "entity_guided";
  semanticLlmMaxTokens: number;
  semanticLlmTimeout: number;
  semanticLlmConcurrency: number;
  evidenceExpansionEnabled: boolean;
  evidenceExpansionScope: "document" | "collection" | "global";
  evidenceExpansionMaxQueries: number;
  evidenceExpansionMaxLlmCalls: number;
  evidenceExpansionMaxTokens: number;
  evidenceExpansionTimeoutSeconds: number;
  evidenceExpansionConcurrency: number;
  graphragEnabled: boolean;
  graphragMaxCommunitySize: number;
  graphragLocalDepth: number;
  graphragCommunityTopK: number;
  graphragCommunityAlgorithm: string;
  graphragCommunityLevel: number;
  graphragReportLlmEnabled: boolean;
  graphragReportMaxTokens: number;
  graphragEntitySummaryEnabled: boolean;
};
