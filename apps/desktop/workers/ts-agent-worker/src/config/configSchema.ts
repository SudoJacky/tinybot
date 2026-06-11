import type {
  AgentDefaultsConfig,
  ChannelsConfig,
  ExecToolConfig,
  GatewayConfig,
  JsonRecord,
  KnowledgeConfig,
  McpServerConfig,
  ProviderConfig,
  ProviderProfileConfig,
  ProvidersConfig,
  TinybotConfig,
} from "./configTypes.ts";
import { applyConfigMigrations } from "./configMigrations.ts";

export class TinybotConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TinybotConfigValidationError";
  }
}

export function defaultTinybotConfig(): TinybotConfig {
  return {
    agents: { defaults: defaultAgentDefaults() },
    channels: { sendProgress: true, sendToolHints: true, sendMaxRetries: 3 },
    providers: {
      openai: defaultProviderConfig(),
      deepseek: defaultProviderConfig(),
      dashscope: defaultProviderConfig(),
      profiles: {},
    },
    api: { host: "127.0.0.1", port: 8900, timeout: 120.0 },
    gateway: { host: "0.0.0.0", port: 18790, heartbeat: { enabled: true, intervalS: 1800, keepRecentMessages: 8 } },
    tools: {
      web: { enable: true, proxy: null, search: { provider: "duckduckgo", apiKey: "", baseUrl: "", maxResults: 5 } },
      exec: { enable: true, timeout: 60, pathAppend: "" },
      restrictToWorkspace: true,
      mcpServers: {},
      ssrfWhitelist: [],
    },
    skills: { enabled: ["*"] },
    knowledge: defaultKnowledgeConfig(),
  };
}

export function parseTinybotConfig(raw: unknown = {}): TinybotConfig {
  const base = defaultTinybotConfig();
  const input = record(applyConfigMigrations(raw)) ?? {};
  const agents = record(input.agents);
  const defaults = parseAgentDefaults(record(agents?.defaults), base.agents.defaults);
  const config: TinybotConfig = {
    agents: { defaults },
    channels: parseChannels(record(input.channels), base.channels),
    providers: parseProviders(record(input.providers), base.providers),
    api: {
      host: stringValue(read(record(input.api), "host"), base.api.host),
      port: positiveNumber(read(record(input.api), "port"), base.api.port, "api.port"),
      timeout: positiveNumber(read(record(input.api), "timeout"), base.api.timeout, "api.timeout"),
    },
    gateway: parseGateway(record(input.gateway), base.gateway),
    tools: parseTools(record(input.tools), base.tools),
    skills: { enabled: stringList(read(record(input.skills), "enabled"), base.skills.enabled) },
    knowledge: parseKnowledge(record(input.knowledge), base.knowledge),
  };
  validateAgentDefaults(config.agents.defaults);
  return config;
}

function defaultAgentDefaults(): AgentDefaultsConfig {
  return {
    workspace: "~/.tinybot/workspace",
    model: "deepseek-reasoner",
    activeProfile: null,
    provider: "auto",
    maxTokens: 8192,
    contextWindowTokens: 65536,
    contextBlockLimit: null,
    temperature: 0.1,
    maxToolIterations: 200,
    maxToolResultChars: 16000,
    providerRetryMode: "standard",
    reasoningEffort: null,
    timezone: "UTC",
    enableVectorStore: false,
    embedding: {
      provider: "openai",
      modelName: "text-embedding-3-small",
      apiKey: "",
      apiKeyEnvVar: "OPENAI_API_KEY",
      apiBase: null,
      apiType: null,
      apiVersion: null,
    },
    dream: {
      intervalH: 2,
      modelOverride: null,
      maxBatchSize: 20,
      maxIterations: 10,
      extractionEveryNTurns: 6,
      extractionIdleSeconds: 300,
    },
    recentContext: {
      enabled: true,
      recencyDays: 7,
      maxRecords: 3,
      scanLimit: 200,
    },
  };
}

function defaultProviderConfig(): ProviderConfig {
  return {
    enabled: null,
    apiKey: "",
    apiBase: null,
    enableSearch: false,
  };
}

function defaultKnowledgeConfig(): KnowledgeConfig {
  return {
    enabled: false,
    autoRetrieve: true,
    maxChunks: 5,
    chunkSize: 500,
    chunkOverlap: 0,
    childChunkSize: 120,
    childChunkOverlap: 20,
    retrievalMode: "hybrid",
    rrfK: 60,
    bm25K: 1.2,
    bm25B: 0.75,
    denseWeight: 1.0,
    sparseWeight: 1.0,
    rerankEnabled: false,
    rerankModel: "qwen3-rerank",
    rerankApiKey: null,
    rerankApiKeyEnvVar: "DASHSCOPE_API_KEY",
    rerankApiBase: "https://dashscope.aliyuncs.com/compatible-api/v1",
    rerankTopN: 0,
    generateSummary: false,
    semanticExtractionMode: "rule",
    llmExtractionStrategy: "single_pass",
    semanticLlmMaxTokens: 1200,
    semanticLlmTimeout: 30.0,
    semanticLlmConcurrency: 4,
    evidenceExpansionEnabled: false,
    evidenceExpansionScope: "document",
    evidenceExpansionMaxQueries: 5,
    evidenceExpansionMaxLlmCalls: 0,
    evidenceExpansionMaxTokens: 0,
    evidenceExpansionTimeoutSeconds: 30.0,
    evidenceExpansionConcurrency: 2,
    graphragEnabled: true,
    graphragMaxCommunitySize: 12,
    graphragLocalDepth: 1,
    graphragCommunityTopK: 5,
    graphragCommunityAlgorithm: "greedy",
    graphragCommunityLevel: 0,
    graphragReportLlmEnabled: false,
    graphragReportMaxTokens: 1200,
    graphragEntitySummaryEnabled: true,
  };
}

function parseAgentDefaults(input: JsonRecord | undefined, defaults: AgentDefaultsConfig): AgentDefaultsConfig {
  const model = stringValue(read(input, "model"), defaults.model).trim();
  const providerRetryMode = enumValue(read(input, "providerRetryMode", "provider_retry_mode"), ["standard", "persistent"], defaults.providerRetryMode);
  const reasoningRaw = nullableString(read(input, "reasoningEffort", "reasoning_effort"));
  const reasoningEffort = reasoningRaw === null
    ? defaults.reasoningEffort
    : enumValue(reasoningRaw.toLowerCase(), ["low", "medium", "high"], defaults.reasoningEffort);
  const parsed: AgentDefaultsConfig = {
    workspace: stringValue(read(input, "workspace"), defaults.workspace),
    model,
    activeProfile: nullableString(read(input, "activeProfile", "active_profile")) ?? defaults.activeProfile,
    provider: normalizeProvider(stringValue(read(input, "provider"), defaults.provider)),
    maxTokens: positiveInteger(read(input, "maxTokens", "max_tokens"), defaults.maxTokens, "agents.defaults.maxTokens"),
    contextWindowTokens: positiveInteger(read(input, "contextWindowTokens", "context_window_tokens"), defaults.contextWindowTokens, "agents.defaults.contextWindowTokens"),
    contextBlockLimit: nullablePositiveInteger(read(input, "contextBlockLimit", "context_block_limit"), defaults.contextBlockLimit, "agents.defaults.contextBlockLimit"),
    temperature: numberInRange(read(input, "temperature"), defaults.temperature, 0, 2, "agents.defaults.temperature"),
    maxToolIterations: positiveInteger(read(input, "maxToolIterations", "max_tool_iterations"), defaults.maxToolIterations, "agents.defaults.maxToolIterations"),
    maxToolResultChars: positiveInteger(read(input, "maxToolResultChars", "max_tool_result_chars"), defaults.maxToolResultChars, "agents.defaults.maxToolResultChars"),
    providerRetryMode,
    reasoningEffort,
    timezone: stringValue(read(input, "timezone"), defaults.timezone).trim(),
    enableVectorStore: booleanValue(read(input, "enableVectorStore", "enable_vector_store"), defaults.enableVectorStore),
    embedding: {
      provider: enumValue(read(record(read(input, "embedding")), "provider"), ["openai", "azure", "custom"], defaults.embedding.provider),
      modelName: stringValue(read(record(read(input, "embedding")), "modelName", "model_name"), defaults.embedding.modelName),
      apiKey: stringValue(read(record(read(input, "embedding")), "apiKey", "api_key"), defaults.embedding.apiKey),
      apiKeyEnvVar: nullableString(read(record(read(input, "embedding")), "apiKeyEnvVar", "api_key_env_var")) ?? defaults.embedding.apiKeyEnvVar,
      apiBase: nullableString(read(record(read(input, "embedding")), "apiBase", "api_base")),
      apiType: nullableString(read(record(read(input, "embedding")), "apiType", "api_type")),
      apiVersion: nullableString(read(record(read(input, "embedding")), "apiVersion", "api_version")),
    },
    dream: {
      intervalH: positiveInteger(read(record(read(input, "dream")), "intervalH", "interval_h"), defaults.dream.intervalH, "agents.defaults.dream.intervalH"),
      modelOverride: nullableString(read(record(read(input, "dream")), "modelOverride", "model", "model_override")) ?? defaults.dream.modelOverride,
      maxBatchSize: positiveInteger(read(record(read(input, "dream")), "maxBatchSize", "max_batch_size"), defaults.dream.maxBatchSize, "agents.defaults.dream.maxBatchSize"),
      maxIterations: positiveInteger(read(record(read(input, "dream")), "maxIterations", "max_iterations"), defaults.dream.maxIterations, "agents.defaults.dream.maxIterations"),
      extractionEveryNTurns: positiveInteger(read(record(read(input, "dream")), "extractionEveryNTurns", "extraction_every_n_turns"), defaults.dream.extractionEveryNTurns, "agents.defaults.dream.extractionEveryNTurns"),
      extractionIdleSeconds: positiveInteger(read(record(read(input, "dream")), "extractionIdleSeconds", "extraction_idle_seconds"), defaults.dream.extractionIdleSeconds, "agents.defaults.dream.extractionIdleSeconds"),
    },
    recentContext: {
      enabled: booleanValue(read(record(read(input, "recentContext", "recent_context")), "enabled"), defaults.recentContext.enabled),
      recencyDays: positiveInteger(read(record(read(input, "recentContext", "recent_context")), "recencyDays", "recency_days"), defaults.recentContext.recencyDays, "agents.defaults.recentContext.recencyDays"),
      maxRecords: positiveInteger(read(record(read(input, "recentContext", "recent_context")), "maxRecords", "max_records"), defaults.recentContext.maxRecords, "agents.defaults.recentContext.maxRecords"),
      scanLimit: positiveInteger(read(record(read(input, "recentContext", "recent_context")), "scanLimit", "scan_limit"), defaults.recentContext.scanLimit, "agents.defaults.recentContext.scanLimit"),
    },
  };
  validateAgentDefaults(parsed);
  return parsed;
}

function parseChannels(input: JsonRecord | undefined, defaults: ChannelsConfig): ChannelsConfig {
  const parsed: ChannelsConfig = {
    ...copyUnknown(input, ["sendProgress", "send_progress", "sendToolHints", "send_tool_hints", "sendMaxRetries", "send_max_retries"]),
    sendProgress: booleanValue(read(input, "sendProgress", "send_progress"), defaults.sendProgress),
    sendToolHints: booleanValue(read(input, "sendToolHints", "send_tool_hints"), defaults.sendToolHints),
    sendMaxRetries: integerInRange(read(input, "sendMaxRetries", "send_max_retries"), defaults.sendMaxRetries, 0, 10, "channels.sendMaxRetries"),
  };
  return parsed;
}

function parseProviders(input: JsonRecord | undefined, defaults: ProvidersConfig): ProvidersConfig {
  const parsed: ProvidersConfig = {
    openai: parseProviderConfig(record(read(input, "openai")), defaults.openai),
    deepseek: parseProviderConfig(record(read(input, "deepseek")), defaults.deepseek),
    dashscope: parseProviderConfig(record(read(input, "dashscope")), defaults.dashscope),
    profiles: parseProfiles(record(read(input, "profiles"))),
  };
  for (const [key, value] of Object.entries(input ?? {})) {
    if (["openai", "deepseek", "dashscope", "profiles"].includes(key)) {
      continue;
    }
    const provider = parseProviderConfig(record(value), defaultProviderConfig());
    (parsed as Record<string, unknown>)[key] = provider;
  }
  return parsed;
}

function parseProfiles(input: JsonRecord | undefined): Record<string, ProviderProfileConfig> {
  const profiles: Record<string, ProviderProfileConfig> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    profiles[name] = parseProviderProfileConfig(record(value), {
      ...defaultProviderConfig(),
      provider: "openai",
      models: [],
      manualModels: [],
      supportsModelDiscovery: true,
      extraBody: {},
      requestSettings: {},
    });
  }
  return profiles;
}

function parseProviderConfig(input: JsonRecord | undefined, defaults: ProviderConfig): ProviderConfig {
  return {
    ...copyUnknown(input, [
      "enabled",
      "apiKey",
      "api_key",
      "apiBase",
      "api_base",
      "enableSearch",
      "enable_search",
      "models",
      "manualModels",
      "manualModelIds",
      "manual_models",
      "manual_model_ids",
      "supportsModelDiscovery",
      "supports_model_discovery",
      "extraBody",
      "extra_body",
      "requestSettings",
      "request_settings",
      "provider",
    ]),
    enabled: nullableBoolean(read(input, "enabled"), defaults.enabled),
    apiKey: stringValue(read(input, "apiKey", "api_key"), defaults.apiKey),
    apiBase: nullableString(read(input, "apiBase", "api_base")) ?? defaults.apiBase,
    enableSearch: booleanValue(read(input, "enableSearch", "enable_search"), defaults.enableSearch),
    ...(read(input, "models") !== undefined ? { models: stringList(read(input, "models"), []) } : {}),
    ...(read(input, "manualModels", "manualModelIds", "manual_models", "manual_model_ids") !== undefined
      ? { manualModels: stringList(read(input, "manualModels", "manualModelIds", "manual_models", "manual_model_ids"), []) }
      : {}),
    ...(read(input, "supportsModelDiscovery", "supports_model_discovery") !== undefined
      ? { supportsModelDiscovery: booleanValue(read(input, "supportsModelDiscovery", "supports_model_discovery"), true) }
      : {}),
    ...(read(input, "extraBody", "extra_body") !== undefined ? { extraBody: record(read(input, "extraBody", "extra_body")) ?? {} } : {}),
    ...(read(input, "requestSettings", "request_settings") !== undefined ? { requestSettings: record(read(input, "requestSettings", "request_settings")) ?? {} } : {}),
    ...(read(input, "provider") !== undefined ? { provider: normalizeProvider(stringValue(read(input, "provider"), "openai")) } : {}),
  };
}

function parseProviderProfileConfig(input: JsonRecord | undefined, defaults: ProviderProfileConfig): ProviderProfileConfig {
  const provider = parseProviderConfig(input, defaults);
  return {
    ...provider,
    provider: normalizeProvider(stringValue(read(input, "provider"), defaults.provider)),
    models: stringList(read(input, "models"), defaults.models),
    manualModels: stringList(read(input, "manualModels", "manualModelIds", "manual_models", "manual_model_ids"), defaults.manualModels),
    supportsModelDiscovery: booleanValue(read(input, "supportsModelDiscovery", "supports_model_discovery"), defaults.supportsModelDiscovery),
    extraBody: record(read(input, "extraBody", "extra_body")) ?? defaults.extraBody,
    requestSettings: record(read(input, "requestSettings", "request_settings")) ?? defaults.requestSettings,
  };
}

function parseGateway(input: JsonRecord | undefined, defaults: GatewayConfig): GatewayConfig {
  const heartbeatInput = record(read(input, "heartbeat"));
  return {
    host: stringValue(read(input, "host"), defaults.host),
    port: positiveInteger(read(input, "port"), defaults.port, "gateway.port"),
    heartbeat: {
      enabled: booleanValue(read(heartbeatInput, "enabled"), defaults.heartbeat.enabled),
      intervalS: positiveInteger(read(heartbeatInput, "intervalS", "interval_s"), defaults.heartbeat.intervalS, "gateway.heartbeat.intervalS"),
      keepRecentMessages: positiveInteger(read(heartbeatInput, "keepRecentMessages", "keep_recent_messages"), defaults.heartbeat.keepRecentMessages, "gateway.heartbeat.keepRecentMessages"),
    },
  };
}

function parseTools(input: JsonRecord | undefined, defaults: TinybotConfig["tools"]): TinybotConfig["tools"] {
  const webInput = record(read(input, "web"));
  const execInput = record(read(input, "exec"));
  const searchInput = record(read(webInput, "search"));
  return {
    web: {
      enable: booleanValue(read(webInput, "enable"), defaults.web.enable),
      proxy: nullableString(read(webInput, "proxy")),
      search: {
        provider: stringValue(read(searchInput, "provider"), defaults.web.search.provider),
        apiKey: stringValue(read(searchInput, "apiKey", "api_key"), defaults.web.search.apiKey),
        baseUrl: stringValue(read(searchInput, "baseUrl", "base_url"), defaults.web.search.baseUrl),
        maxResults: positiveInteger(read(searchInput, "maxResults", "max_results"), defaults.web.search.maxResults, "tools.web.search.maxResults"),
      },
    },
    exec: parseExecToolConfig(execInput, defaults.exec),
    restrictToWorkspace: booleanValue(read(input, "restrictToWorkspace", "restrict_to_workspace"), defaults.restrictToWorkspace),
    mcpServers: parseMcpServers(record(read(input, "mcpServers", "mcp_servers"))),
    ssrfWhitelist: stringList(read(input, "ssrfWhitelist", "ssrf_whitelist"), defaults.ssrfWhitelist),
  };
}

function parseExecToolConfig(input: JsonRecord | undefined, defaults: ExecToolConfig): ExecToolConfig {
  return {
    enable: booleanValue(read(input, "enable"), defaults.enable),
    timeout: positiveInteger(read(input, "timeout"), defaults.timeout, "tools.exec.timeout"),
    pathAppend: stringValue(read(input, "pathAppend", "path_append"), defaults.pathAppend),
  };
}

function parseMcpServers(input: JsonRecord | undefined): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(input ?? {})) {
    const server = record(value) ?? {};
    const type = enumValue(read(server, "type"), ["stdio", "sse", "streamableHttp"], null);
    const command = stringValue(read(server, "command"), "");
    const url = stringValue(read(server, "url"), "");
    const toolTimeout = positiveInteger(read(server, "toolTimeout", "tool_timeout"), 30, `tools.mcpServers.${name}.toolTimeout`);
    if (type === "stdio" && !command) {
      throw new TinybotConfigValidationError(`stdio MCP server '${name}' requires command`);
    }
    if ((type === "sse" || type === "streamableHttp") && !url) {
      throw new TinybotConfigValidationError(`${type} MCP server '${name}' requires url`);
    }
    servers[name] = {
      type,
      command,
      args: stringList(read(server, "args"), []),
      env: stringRecord(read(server, "env")),
      url,
      headers: stringRecord(read(server, "headers")),
      toolTimeout,
      enabledTools: stringList(read(server, "enabledTools", "enabled_tools"), ["*"]),
    };
  }
  return servers;
}

function parseKnowledge(input: JsonRecord | undefined, defaults: KnowledgeConfig): KnowledgeConfig {
  return {
    enabled: booleanValue(read(input, "enabled"), defaults.enabled),
    autoRetrieve: booleanValue(read(input, "autoRetrieve", "auto_retrieve"), defaults.autoRetrieve),
    maxChunks: positiveInteger(read(input, "maxChunks", "max_chunks"), defaults.maxChunks, "knowledge.maxChunks"),
    chunkSize: positiveInteger(read(input, "chunkSize", "chunk_size"), defaults.chunkSize, "knowledge.chunkSize"),
    chunkOverlap: nonnegativeNumber(read(input, "chunkOverlap", "chunk_overlap"), defaults.chunkOverlap, "knowledge.chunkOverlap"),
    childChunkSize: positiveInteger(read(input, "childChunkSize", "child_chunk_size"), defaults.childChunkSize, "knowledge.childChunkSize"),
    childChunkOverlap: nonnegativeNumber(read(input, "childChunkOverlap", "child_chunk_overlap"), defaults.childChunkOverlap, "knowledge.childChunkOverlap"),
    retrievalMode: stringValue(read(input, "retrievalMode", "retrieval_mode"), defaults.retrievalMode),
    rrfK: positiveInteger(read(input, "rrfK", "rrf_k"), defaults.rrfK, "knowledge.rrfK"),
    bm25K: nonnegativeNumber(read(input, "bm25K", "bm25_k"), defaults.bm25K, "knowledge.bm25K"),
    bm25B: numberInRange(read(input, "bm25B", "bm25_b"), defaults.bm25B, 0, 1, "knowledge.bm25B"),
    denseWeight: nonnegativeNumber(read(input, "denseWeight", "dense_weight"), defaults.denseWeight, "knowledge.denseWeight"),
    sparseWeight: nonnegativeNumber(read(input, "sparseWeight", "sparse_weight"), defaults.sparseWeight, "knowledge.sparseWeight"),
    rerankEnabled: booleanValue(read(input, "rerankEnabled", "rerank_enabled"), defaults.rerankEnabled),
    rerankModel: stringValue(read(input, "rerankModel", "rerank_model"), defaults.rerankModel),
    rerankApiKey: nullableString(read(input, "rerankApiKey", "rerank_api_key")),
    rerankApiKeyEnvVar: stringValue(read(input, "rerankApiKeyEnvVar", "rerank_api_key_env_var"), defaults.rerankApiKeyEnvVar),
    rerankApiBase: stringValue(read(input, "rerankApiBase", "rerank_api_base"), defaults.rerankApiBase),
    rerankTopN: nonnegativeNumber(read(input, "rerankTopN", "rerank_top_n"), defaults.rerankTopN, "knowledge.rerankTopN"),
    generateSummary: booleanValue(read(input, "generateSummary", "generate_summary"), defaults.generateSummary),
    semanticExtractionMode: enumValue(read(input, "semanticExtractionMode", "semantic_extraction_mode"), ["rule", "llm", "hybrid"], defaults.semanticExtractionMode),
    llmExtractionStrategy: enumValue(read(input, "llmExtractionStrategy", "llm_extraction_strategy"), ["single_pass", "entity_guided"], defaults.llmExtractionStrategy),
    semanticLlmMaxTokens: positiveInteger(read(input, "semanticLlmMaxTokens", "semantic_llm_max_tokens"), defaults.semanticLlmMaxTokens, "knowledge.semanticLlmMaxTokens"),
    semanticLlmTimeout: positiveNumber(read(input, "semanticLlmTimeout", "semantic_llm_timeout"), defaults.semanticLlmTimeout, "knowledge.semanticLlmTimeout"),
    semanticLlmConcurrency: integerInRange(read(input, "semanticLlmConcurrency", "semantic_llm_concurrency"), defaults.semanticLlmConcurrency, 1, 16, "knowledge.semanticLlmConcurrency"),
    evidenceExpansionEnabled: booleanValue(read(input, "evidenceExpansionEnabled", "evidence_expansion_enabled"), defaults.evidenceExpansionEnabled),
    evidenceExpansionScope: enumValue(read(input, "evidenceExpansionScope", "evidence_expansion_scope"), ["document", "collection", "global"], defaults.evidenceExpansionScope),
    evidenceExpansionMaxQueries: positiveInteger(read(input, "evidenceExpansionMaxQueries", "evidence_expansion_max_queries"), defaults.evidenceExpansionMaxQueries, "knowledge.evidenceExpansionMaxQueries"),
    evidenceExpansionMaxLlmCalls: nonnegativeNumber(read(input, "evidenceExpansionMaxLlmCalls", "evidence_expansion_max_llm_calls"), defaults.evidenceExpansionMaxLlmCalls, "knowledge.evidenceExpansionMaxLlmCalls"),
    evidenceExpansionMaxTokens: nonnegativeNumber(read(input, "evidenceExpansionMaxTokens", "evidence_expansion_max_tokens"), defaults.evidenceExpansionMaxTokens, "knowledge.evidenceExpansionMaxTokens"),
    evidenceExpansionTimeoutSeconds: positiveNumber(read(input, "evidenceExpansionTimeoutSeconds", "evidence_expansion_timeout_seconds"), defaults.evidenceExpansionTimeoutSeconds, "knowledge.evidenceExpansionTimeoutSeconds"),
    evidenceExpansionConcurrency: integerInRange(read(input, "evidenceExpansionConcurrency", "evidence_expansion_concurrency"), defaults.evidenceExpansionConcurrency, 1, 16, "knowledge.evidenceExpansionConcurrency"),
    graphragEnabled: booleanValue(read(input, "graphragEnabled", "graphrag_enabled"), defaults.graphragEnabled),
    graphragMaxCommunitySize: positiveInteger(read(input, "graphragMaxCommunitySize", "graphrag_max_community_size"), defaults.graphragMaxCommunitySize, "knowledge.graphragMaxCommunitySize"),
    graphragLocalDepth: integerInRange(read(input, "graphragLocalDepth", "graphrag_local_depth"), defaults.graphragLocalDepth, 0, 3, "knowledge.graphragLocalDepth"),
    graphragCommunityTopK: positiveInteger(read(input, "graphragCommunityTopK", "graphrag_community_top_k"), defaults.graphragCommunityTopK, "knowledge.graphragCommunityTopK"),
    graphragCommunityAlgorithm: stringValue(read(input, "graphragCommunityAlgorithm", "graphrag_community_algorithm"), defaults.graphragCommunityAlgorithm),
    graphragCommunityLevel: integerInRange(read(input, "graphragCommunityLevel", "graphrag_community_level"), defaults.graphragCommunityLevel, 0, 3, "knowledge.graphragCommunityLevel"),
    graphragReportLlmEnabled: booleanValue(read(input, "graphragReportLlmEnabled", "graphrag_report_llm_enabled"), defaults.graphragReportLlmEnabled),
    graphragReportMaxTokens: positiveInteger(read(input, "graphragReportMaxTokens", "graphrag_report_max_tokens"), defaults.graphragReportMaxTokens, "knowledge.graphragReportMaxTokens"),
    graphragEntitySummaryEnabled: booleanValue(read(input, "graphragEntitySummaryEnabled", "graphrag_entity_summary_enabled"), defaults.graphragEntitySummaryEnabled),
  };
}

function validateAgentDefaults(defaults: AgentDefaultsConfig): void {
  if (!defaults.model.trim()) {
    throw new TinybotConfigValidationError("agents.defaults.model cannot be empty");
  }
  if (!defaults.timezone.trim()) {
    throw new TinybotConfigValidationError("agents.defaults.timezone cannot be empty");
  }
  if (defaults.contextBlockLimit !== null && defaults.contextBlockLimit > defaults.contextWindowTokens) {
    throw new TinybotConfigValidationError("agents.defaults.contextBlockLimit must be <= contextWindowTokens");
  }
}

function read(object: JsonRecord | undefined, ...names: string[]): unknown {
  if (!object) {
    return undefined;
  }
  for (const name of names) {
    if (object[name] !== undefined) {
      return object[name];
    }
  }
  return undefined;
}

function copyUnknown(input: JsonRecord | undefined, known: string[]): JsonRecord {
  const result: JsonRecord = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!known.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function nullableString(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return null;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function nullableBoolean(value: unknown, fallback: boolean | null): boolean | null {
  return value === null || typeof value === "boolean" ? value : fallback;
}

function positiveNumber(value: unknown, fallback: number, path: string): number {
  const parsed = numberValue(value, fallback);
  if (parsed <= 0) {
    throw new TinybotConfigValidationError(`${path} must be positive`);
  }
  return parsed;
}

function nonnegativeNumber(value: unknown, fallback: number, path: string): number {
  const parsed = numberValue(value, fallback);
  if (parsed < 0) {
    throw new TinybotConfigValidationError(`${path} must be non-negative`);
  }
  return parsed;
}

function positiveInteger(value: unknown, fallback: number, path: string): number {
  const parsed = Math.trunc(numberValue(value, fallback));
  if (parsed < 1) {
    throw new TinybotConfigValidationError(`${path} must be at least 1`);
  }
  return parsed;
}

function nullablePositiveInteger(value: unknown, fallback: number | null, path: string): number | null {
  if (value === null || value === undefined) {
    return fallback;
  }
  return positiveInteger(value, fallback ?? 1, path);
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, path: string): number {
  const parsed = Math.trunc(numberValue(value, fallback));
  if (parsed < min || parsed > max) {
    throw new TinybotConfigValidationError(`${path} must be between ${min} and ${max}`);
  }
  return parsed;
}

function numberInRange(value: unknown, fallback: number, min: number, max: number, path: string): number {
  const parsed = numberValue(value, fallback);
  if (parsed < min || parsed > max) {
    throw new TinybotConfigValidationError(`${path} must be between ${min} and ${max}`);
  }
  return parsed;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function enumValue<T extends string | null>(value: unknown, choices: readonly Exclude<T, null>[], fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim();
  const matched = choices.find((choice) => choice === normalized);
  return (matched ?? fallback) as T;
}

function stringList(value: unknown, fallback: string[]): string[] {
  if (typeof value === "string") {
    return value.replace(/\n/g, ",").split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return [...fallback];
}

function stringRecord(value: unknown): Record<string, string> {
  const source = record(value) ?? {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    result[key] = String(entry);
  }
  return result;
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  return normalized || "auto";
}
