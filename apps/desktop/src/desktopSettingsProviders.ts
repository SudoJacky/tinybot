export interface DesktopProviderCatalogItem {
  id?: string;
  displayName?: string;
  baseUrl?: string;
  status?: string;
}

export interface DesktopSettingsProviderEditorState {
  selectedProvider: string;
  profileId: string;
  apiKey: string;
  apiBase: string | null;
  modelsText: string;
  supportsModelDiscovery: boolean;
}

export interface DesktopSettingsFormState {
  agent: {
    workspace: string | null;
    model: string | null;
    activeProfile: string | null;
    provider: string | null;
    temperature: number | null;
    maxTokens: number | null;
    contextWindowTokens: number | null;
    maxToolIterations: number | null;
    reasoningEffort: string | null;
    timezone: string | null;
  };
  embedding: {
    provider: string | null;
    modelName: string | null;
    apiKey: string;
    apiBase: string | null;
  };
  knowledge: {
    enabled: boolean;
    autoRetrieve: boolean;
    maxChunks: number | null;
    chunkSize: number | null;
    chunkOverlap: number | null;
    retrievalMode: string | null;
    rerankEnabled: boolean;
    rerankModel: string | null;
    rerankApiKey: string | null;
    rerankApiKeyEnvVar: string | null;
    rerankApiBase: string | null;
    rerankTopN: number | null;
    generateSummary: boolean;
    semanticExtractionMode: string | null;
    semanticLlmMaxTokens: number | null;
    semanticLlmTimeout: number | null;
    graphRagCommunityAlgorithm: string | null;
    graphRagCommunityLevel: number | null;
    graphRagReportLlmEnabled: boolean;
    graphRagReportMaxTokens: number | null;
    graphRagEntitySummaryEnabled: boolean;
  };
  tools: {
    webEnable: boolean;
    webProxy: string | null;
    searchProvider: string | null;
    execEnable: boolean;
    execTimeout: number | null;
    mcpServersText: string;
    restrictToWorkspace: boolean;
  };
  gateway: {
    host: string | null;
    port: number | null;
    heartbeatEnabled: boolean;
    heartbeatIntervalS: number | null;
  };
  channels: {
    sendProgress: boolean;
    sendToolHints: boolean;
    sendMaxRetries: number | null;
  };
  providerEditor: DesktopSettingsProviderEditorState;
}

export type DesktopSettingsValidationField =
  | "model"
  | "timezone"
  | "gatewayPort"
  | "mcpServers"
  | "providerApiBase"
  | "embeddingApiBase"
  | "rerankApiBase";

export interface DesktopSettingsValidationError {
  field: DesktopSettingsValidationField;
  errorKey: "modelEmpty" | "timezoneError" | "portRange" | "jsonObjectError" | "urlError";
}

export interface DesktopProviderModelRequest {
  provider: string;
  profile: string;
  api_key: string;
  api_base: string;
  refresh: boolean;
}

export interface DesktopProviderModelApplyResult {
  state: DesktopSettingsFormState;
  models: string[];
  selectedModel: string | null;
  status: "loaded" | "empty" | "failed";
  message: string;
}

export interface DesktopSecretField {
  value: string;
  displayValue: string;
  masked: boolean;
  empty: boolean;
}

export type DesktopSettingsSaveStatus = "idle" | "saving" | "saved" | "failed";

export interface DesktopSettingsPaneField {
  id: string;
  label: string;
  value: string;
  state: "normal" | "invalid";
}

export interface DesktopSettingsPaneGroup {
  id: "agent" | "provider" | "knowledge" | "tools" | "gateway" | "channels";
  label: string;
  fields: DesktopSettingsPaneField[];
}

export interface DesktopSettingsPaneModel {
  dirty: boolean;
  validationErrors: DesktopSettingsValidationError[];
  save: {
    status: DesktopSettingsSaveStatus;
    message: string;
    canSave: boolean;
  };
  groups: DesktopSettingsPaneGroup[];
  providerCatalog: Array<{ id: string; label: string; status: string }>;
  providerEditor: {
    selectedProvider: string;
    profileId: string;
    apiKey: DesktopSecretField;
    apiBase: string | null;
    models: string[];
    canDiscoverModels: boolean;
  };
}

type UnknownRecord = Record<string, unknown>;

const MASKED_SECRET = "********";

export function buildDesktopSettingsFormState(
  config: unknown,
  providerCatalog: DesktopProviderCatalogItem[] = [],
): DesktopSettingsFormState {
  const root = asRecord(config);
  const defaults = asRecord(asRecord(root.agents).defaults);
  const knowledge = asRecord(root.knowledge);
  const embedding = asRecord(defaults.embedding);
  const tools = asRecord(root.tools);
  const web = asRecord(tools.web);
  const exec = asRecord(tools.exec);
  const gateway = asRecord(root.gateway);
  const heartbeat = asRecord(gateway.heartbeat);
  const channels = asRecord(root.channels);
  const providers = asRecord(root.providers);
  const providerIds = providerCatalog.map((provider) => stringValue(provider.id)).filter(Boolean);
  const rawProvider = stringValue(pick(defaults, "provider")) || "auto";
  const selectedProvider = rawProvider === "auto" || providerIds.includes(rawProvider) ? rawProvider : "auto";
  const displayProvider = selectedProvider === "auto" ? "deepseek" : selectedProvider;
  const profileId = stringValue(pick(defaults, "activeProfile", "active_profile")) || findDesktopProfileIdForProvider(providers, displayProvider);
  const providerProfile = getDesktopProviderProfileConfig(providers, profileId, displayProvider, providerCatalog);

  return {
    agent: {
      workspace: stringOrDefault(pick(defaults, "workspace", "workspacePath"), "~/.tinybot/workspace"),
      model: stringOrNull(pick(defaults, "model")),
      activeProfile: stringOrNull(pick(defaults, "activeProfile", "active_profile")),
      provider: selectedProvider,
      temperature: numberOrDefault(pick(defaults, "temperature"), 0.1),
      maxTokens: numberOrDefault(pick(defaults, "maxTokens", "max_tokens"), 8192),
      contextWindowTokens: numberOrDefault(pick(defaults, "contextWindowTokens", "context_window_tokens"), 65536),
      maxToolIterations: numberOrDefault(pick(defaults, "maxToolIterations", "max_tool_iterations"), 200),
      reasoningEffort: stringOrNull(pick(defaults, "reasoningEffort", "reasoning_effort")),
      timezone: stringOrDefault(pick(defaults, "timezone"), "UTC"),
    },
    embedding: {
      provider: stringOrDefault(pick(embedding, "provider"), "openai"),
      modelName: stringOrDefault(pick(embedding, "modelName", "model_name"), "text-embedding-3-small"),
      apiKey: stringValue(pick(embedding, "apiKey", "api_key")),
      apiBase: stringOrNull(pick(embedding, "apiBase", "api_base")),
    },
    knowledge: {
      enabled: knowledge.enabled === true,
      autoRetrieve: boolValue(pick(knowledge, "autoRetrieve", "auto_retrieve")),
      maxChunks: numberOrDefault(pick(knowledge, "maxChunks", "max_chunks"), 5),
      chunkSize: numberOrDefault(pick(knowledge, "chunkSize", "chunk_size"), 500),
      chunkOverlap: numberOrDefault(pick(knowledge, "chunkOverlap", "chunk_overlap"), 100),
      retrievalMode: stringOrDefault(pick(knowledge, "retrievalMode", "retrieval_mode"), "hybrid"),
      rerankEnabled: boolValue(pick(knowledge, "rerankEnabled", "rerank_enabled")),
      rerankModel: stringOrDefault(pick(knowledge, "rerankModel", "rerank_model"), "qwen3-rerank"),
      rerankApiKey: stringOrNull(pick(knowledge, "rerankApiKey", "rerank_api_key")),
      rerankApiKeyEnvVar: stringOrDefault(pick(knowledge, "rerankApiKeyEnvVar", "rerank_api_key_env_var"), "DASHSCOPE_API_KEY"),
      rerankApiBase: stringOrDefault(
        pick(knowledge, "rerankApiBase", "rerank_api_base"),
        "https://dashscope.aliyuncs.com/compatible-api/v1",
      ),
      rerankTopN: numberOrDefault(pick(knowledge, "rerankTopN", "rerank_top_n"), 0),
      generateSummary: boolValue(pick(knowledge, "generateSummary", "generate_summary")),
      semanticExtractionMode: stringOrDefault(pick(knowledge, "semanticExtractionMode", "semantic_extraction_mode"), "rule"),
      semanticLlmMaxTokens: numberOrDefault(pick(knowledge, "semanticLlmMaxTokens", "semantic_llm_max_tokens"), 1200),
      semanticLlmTimeout: numberOrDefault(pick(knowledge, "semanticLlmTimeout", "semantic_llm_timeout"), 30),
      graphRagCommunityAlgorithm: stringOrDefault(
        pick(knowledge, "graphragCommunityAlgorithm", "graphrag_community_algorithm"),
        "greedy",
      ),
      graphRagCommunityLevel: numberOrDefault(pick(knowledge, "graphragCommunityLevel", "graphrag_community_level"), 0),
      graphRagReportLlmEnabled: boolValue(pick(knowledge, "graphragReportLlmEnabled", "graphrag_report_llm_enabled")),
      graphRagReportMaxTokens: numberOrDefault(pick(knowledge, "graphragReportMaxTokens", "graphrag_report_max_tokens"), 1200),
      graphRagEntitySummaryEnabled: pick(knowledge, "graphragEntitySummaryEnabled", "graphrag_entity_summary_enabled") !== false,
    },
    tools: {
      webEnable: web.enable === true,
      webProxy: stringOrNull(web.proxy),
      searchProvider: stringOrDefault(asRecord(web.search).provider, "duckduckgo"),
      execEnable: exec.enable === true,
      execTimeout: numberOrDefault(exec.timeout, 60),
      mcpServersText: stringifyDesktopJsonObject(pick(tools, "mcpServers", "mcp_servers")),
      restrictToWorkspace: boolValue(pick(tools, "restrictToWorkspace", "restrict_to_workspace")),
    },
    gateway: {
      host: stringOrDefault(gateway.host, "0.0.0.0"),
      port: numberOrDefault(gateway.port, 18790),
      heartbeatEnabled: heartbeat.enabled === true,
      heartbeatIntervalS: numberOrDefault(pick(heartbeat, "intervalS", "interval_s"), 1800),
    },
    channels: {
      sendProgress: boolValue(pick(channels, "sendProgress", "send_progress")),
      sendToolHints: boolValue(pick(channels, "sendToolHints", "send_tool_hints")),
      sendMaxRetries: numberOrDefault(pick(channels, "sendMaxRetries", "send_max_retries"), 3),
    },
    providerEditor: {
      selectedProvider: stringValue(providerProfile.provider) || displayProvider,
      profileId,
      apiKey: stringValue(pick(providerProfile, "apiKey", "api_key")),
      apiBase: stringOrNull(pick(providerProfile, "apiBase", "api_base")),
      modelsText: parseDesktopProviderModelList(providerProfile.models).join("\n"),
      supportsModelDiscovery: pick(providerProfile, "supportsModelDiscovery", "supports_model_discovery") !== false,
    },
  };
}

export function buildDesktopProviderCatalogItems(payload: unknown): DesktopProviderCatalogItem[] {
  const payloadRecord = asRecord(payload);
  const providers: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payloadRecord.providers)
      ? payloadRecord.providers
      : [];
  return providers.filter((provider): provider is UnknownRecord => provider !== null && typeof provider === "object" && !Array.isArray(provider)).map((provider) => ({
    id: stringValue(provider.id),
    displayName: stringValue(pick(provider, "displayName", "display_name")),
    baseUrl: stringValue(pick(provider, "baseUrl", "base_url")),
    status: stringValue(provider.status),
  }));
}

export function createDesktopSettingsPatch(
  state: DesktopSettingsFormState,
  existingConfig: unknown = {},
  providerCatalog: DesktopProviderCatalogItem[] = [],
): UnknownRecord {
  const providerIds = providerCatalog.map((provider) => stringValue(provider.id)).filter(Boolean);
  const providerName = providerIds.includes(state.providerEditor.selectedProvider)
    ? state.providerEditor.selectedProvider
    : state.providerEditor.selectedProvider || "deepseek";
  const profileId = stringOrNull(state.providerEditor.profileId) || state.agent.activeProfile;
  const existingProfiles = { ...getDesktopProviderProfiles(asRecord(asRecord(existingConfig).providers)) };
  const providers: UnknownRecord = {};

  if (profileId) {
    providers.profiles = {
      ...existingProfiles,
      [profileId]: {
        provider: providerName,
        api_key: state.providerEditor.apiKey || "",
        api_base: state.providerEditor.apiBase,
        models: parseDesktopProviderModelList(state.providerEditor.modelsText),
        supports_model_discovery: state.providerEditor.supportsModelDiscovery,
      },
    };
  }

  providers[providerName] = {
    api_key: state.providerEditor.apiKey || "",
    api_base: state.providerEditor.apiBase,
  };

  return {
    agents: {
      defaults: {
        model: state.agent.model,
        active_profile: profileId,
        provider: state.agent.provider,
        workspace: state.agent.workspace,
        temperature: state.agent.temperature,
        max_tokens: state.agent.maxTokens,
        context_window_tokens: state.agent.contextWindowTokens,
        max_tool_iterations: state.agent.maxToolIterations,
        reasoning_effort: state.agent.reasoningEffort,
        timezone: state.agent.timezone,
        embedding: {
          provider: state.embedding.provider,
          model_name: state.embedding.modelName,
          api_key: state.embedding.apiKey || "",
          api_base: state.embedding.apiBase,
        },
      },
    },
    knowledge: {
      enabled: state.knowledge.enabled,
      auto_retrieve: state.knowledge.autoRetrieve,
      max_chunks: state.knowledge.maxChunks,
      chunk_size: state.knowledge.chunkSize,
      chunk_overlap: state.knowledge.chunkOverlap,
      retrieval_mode: state.knowledge.retrievalMode,
      rerank_enabled: state.knowledge.rerankEnabled,
      rerank_model: state.knowledge.rerankModel,
      rerank_api_key: state.knowledge.rerankApiKey,
      rerank_api_key_env_var: state.knowledge.rerankApiKeyEnvVar,
      rerank_api_base: state.knowledge.rerankApiBase,
      rerank_top_n: state.knowledge.rerankTopN,
      generate_summary: state.knowledge.generateSummary,
      semantic_extraction_mode: state.knowledge.semanticExtractionMode,
      semantic_llm_max_tokens: state.knowledge.semanticLlmMaxTokens,
      semantic_llm_timeout: state.knowledge.semanticLlmTimeout,
      graphrag_community_algorithm: state.knowledge.graphRagCommunityAlgorithm,
      graphrag_community_level: state.knowledge.graphRagCommunityLevel,
      graphrag_report_llm_enabled: state.knowledge.graphRagReportLlmEnabled,
      graphrag_report_max_tokens: state.knowledge.graphRagReportMaxTokens,
      graphrag_entity_summary_enabled: state.knowledge.graphRagEntitySummaryEnabled,
    },
    tools: {
      web: {
        enable: state.tools.webEnable,
        proxy: state.tools.webProxy,
        search: {
          provider: state.tools.searchProvider,
        },
      },
      exec: {
        enable: state.tools.execEnable,
        timeout: state.tools.execTimeout,
      },
      mcp_servers: parseDesktopJsonObject(state.tools.mcpServersText),
      restrict_to_workspace: state.tools.restrictToWorkspace,
    },
    gateway: {
      host: state.gateway.host,
      port: state.gateway.port,
      heartbeat: {
        enabled: state.gateway.heartbeatEnabled,
        interval_s: state.gateway.heartbeatIntervalS,
      },
    },
    channels: {
      send_progress: state.channels.sendProgress,
      send_tool_hints: state.channels.sendToolHints,
      send_max_retries: state.channels.sendMaxRetries,
    },
    providers,
  };
}

export function validateDesktopSettingsForm(state: DesktopSettingsFormState): DesktopSettingsValidationError[] {
  const errors: DesktopSettingsValidationError[] = [];
  if (!state.agent.model?.trim()) {
    errors.push({ field: "model", errorKey: "modelEmpty" });
  }
  if (state.agent.timezone && !validateDesktopTimezone(state.agent.timezone)) {
    errors.push({ field: "timezone", errorKey: "timezoneError" });
  }
  if (state.gateway.port !== null && !validateDesktopPortRange(state.gateway.port)) {
    errors.push({ field: "gatewayPort", errorKey: "portRange" });
  }
  if (state.tools.mcpServersText.trim() && !validateDesktopJsonObject(state.tools.mcpServersText)) {
    errors.push({ field: "mcpServers", errorKey: "jsonObjectError" });
  }
  if (state.providerEditor.apiBase && !validateDesktopUrl(state.providerEditor.apiBase)) {
    errors.push({ field: "providerApiBase", errorKey: "urlError" });
  }
  if (state.embedding.apiBase && !validateDesktopUrl(state.embedding.apiBase)) {
    errors.push({ field: "embeddingApiBase", errorKey: "urlError" });
  }
  if (state.knowledge.rerankApiBase && !validateDesktopUrl(state.knowledge.rerankApiBase)) {
    errors.push({ field: "rerankApiBase", errorKey: "urlError" });
  }
  return errors;
}

export function buildDesktopSettingsPaneModel(
  state: DesktopSettingsFormState,
  options: {
    lastSavedState?: DesktopSettingsFormState | null;
    providerCatalog?: DesktopProviderCatalogItem[];
    saveStatus?: DesktopSettingsSaveStatus;
    saveError?: string | null;
  } = {},
): DesktopSettingsPaneModel {
  const validationErrors = validateDesktopSettingsForm(state);
  const dirty = options.lastSavedState
    ? JSON.stringify(createDesktopSettingsPatch(state)) !== JSON.stringify(createDesktopSettingsPatch(options.lastSavedState))
    : false;
  const saveStatus = options.saveStatus ?? "idle";
  return {
    dirty,
    validationErrors,
    save: {
      status: saveStatus,
      message: saveStatus === "failed" ? options.saveError || "Save failed" : formatDesktopSettingsSaveMessage(saveStatus, dirty),
      canSave: dirty && validationErrors.length === 0 && saveStatus !== "saving",
    },
    groups: buildDesktopSettingsPaneGroups(state, validationErrors),
    providerCatalog: (options.providerCatalog ?? []).map((provider) => ({
      id: stringValue(provider.id),
      label: stringValue(provider.displayName) || stringValue(provider.id),
      status: stringValue(provider.status) || "unknown",
    })).filter((provider) => provider.id),
    providerEditor: {
      selectedProvider: state.providerEditor.selectedProvider,
      profileId: state.providerEditor.profileId,
      apiKey: buildDesktopSecretField(state.providerEditor.apiKey),
      apiBase: state.providerEditor.apiBase,
      models: parseDesktopProviderModelList(state.providerEditor.modelsText),
      canDiscoverModels: state.providerEditor.supportsModelDiscovery,
    },
  };
}

export function buildDesktopProviderModelRequest(
  state: DesktopSettingsFormState,
  { refresh = true }: { refresh?: boolean } = {},
): DesktopProviderModelRequest {
  return {
    provider: state.providerEditor.selectedProvider || "deepseek",
    profile: state.providerEditor.profileId || state.agent.activeProfile || "",
    api_key: state.providerEditor.apiKey || "",
    api_base: state.providerEditor.apiBase || "",
    refresh,
  };
}

export function applyDesktopProviderModels(
  state: DesktopSettingsFormState,
  result: unknown,
): DesktopProviderModelApplyResult {
  const payload = asRecord(result);
  const models = parseDesktopProviderModelList(payload.models);
  const nextState = cloneSettingsState(state);
  if (!models.length) {
    return {
      state: nextState,
      models,
      selectedModel: nextState.agent.model,
      status: payload.ok === false ? "failed" : "empty",
      message: stringValue(payload.error || payload.warning),
    };
  }
  nextState.providerEditor.modelsText = models.join("\n");
  if (!nextState.agent.model && models[0]) {
    nextState.agent.model = models[0];
  }
  return {
    state: nextState,
    models,
    selectedModel: nextState.agent.model,
    status: "loaded",
    message: stringValue(payload.warning) || `Loaded models ${models.length}`,
  };
}

export function buildDesktopSecretField(value: unknown, mask = MASKED_SECRET): DesktopSecretField {
  const raw = stringValue(value);
  return {
    value: raw,
    displayValue: raw ? mask : "",
    masked: Boolean(raw),
    empty: !raw,
  };
}

export function resolveDesktopSecretValue(displayValue: string, previousValue: string, mask = MASKED_SECRET): string {
  return displayValue === mask ? previousValue : displayValue;
}

export function parseDesktopProviderModelList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return Array.from(new Set(items.map((item) => String(item).trim()).filter(Boolean)));
}

export function getDesktopProviderProfiles(providers: unknown): UnknownRecord {
  return asRecord(asRecord(providers).profiles);
}

export function getDesktopProviderProfileConfig(
  providers: unknown,
  profileId: string,
  fallbackProvider: string,
  providerCatalog: DesktopProviderCatalogItem[] = [],
): UnknownRecord {
  const providerProfiles = getDesktopProviderProfiles(providers);
  const profile = asRecord(providerProfiles[profileId]);
  const profileProvider = stringValue(profile.provider) || fallbackProvider;
  if (profileId && Object.keys(profile).length && (!fallbackProvider || profileProvider === fallbackProvider)) {
    return profile;
  }
  const providerRoot = asRecord(providers);
  const legacyProvider = asRecord(providerRoot[fallbackProvider]);
  const catalogProvider = providerCatalog.find((provider) => provider.id === fallbackProvider);
  return {
    provider: fallbackProvider,
    apiKey: stringValue(pick(legacyProvider, "apiKey", "api_key")),
    api_key: stringValue(pick(legacyProvider, "api_key", "apiKey")),
    apiBase: stringValue(pick(legacyProvider, "apiBase", "api_base")) || stringValue(catalogProvider?.baseUrl),
    api_base: stringValue(pick(legacyProvider, "api_base", "apiBase")) || stringValue(catalogProvider?.baseUrl),
    models: Array.isArray(legacyProvider.models) ? legacyProvider.models : [],
    supportsModelDiscovery: pick(legacyProvider, "supportsModelDiscovery", "supports_model_discovery") !== false,
    supports_model_discovery: pick(legacyProvider, "supports_model_discovery", "supportsModelDiscovery") !== false,
  };
}

export function findDesktopProfileIdForProvider(providers: unknown, providerName: string): string {
  const profiles = getDesktopProviderProfiles(providers);
  if (profiles[providerName]) {
    return providerName;
  }
  const matched = Object.entries(profiles).find(([, profile]) => asRecord(profile).provider === providerName);
  return matched?.[0] || providerName;
}

export function validateDesktopTimezone(value: string): boolean {
  if (!value) {
    return false;
  }
  const parts = value.split("/");
  if (parts.length < 2) {
    return false;
  }
  const validPrefixes = ["Africa", "America", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific", "UTC", "GMT"];
  return validPrefixes.includes(parts[0]) || parts[0] === "Etc";
}

export function validateDesktopUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function validateDesktopPortRange(value: number | string): boolean {
  const port = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

export function validateDesktopJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function parseDesktopJsonObject(value: string): UnknownRecord {
  if (!value.trim()) {
    return {};
  }
  const parsed = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("jsonObjectError");
  }
  return parsed as UnknownRecord;
}

function stringifyDesktopJsonObject(value: unknown): string {
  const record = asRecord(value);
  return Object.keys(record).length ? JSON.stringify(record, null, 2) : "";
}

function cloneSettingsState(state: DesktopSettingsFormState): DesktopSettingsFormState {
  return {
    agent: { ...state.agent },
    embedding: { ...state.embedding },
    knowledge: { ...state.knowledge },
    tools: { ...state.tools },
    gateway: { ...state.gateway },
    channels: { ...state.channels },
    providerEditor: { ...state.providerEditor },
  };
}

function buildDesktopSettingsPaneGroups(
  state: DesktopSettingsFormState,
  validationErrors: DesktopSettingsValidationError[],
): DesktopSettingsPaneGroup[] {
  const invalidFields = new Set(validationErrors.map((error) => error.field));
  const field = (id: string, label: string, value: unknown, validationField?: DesktopSettingsValidationField): DesktopSettingsPaneField => ({
    id,
    label,
    value: formatDesktopSettingsFieldValue(value),
    state: validationField && invalidFields.has(validationField) ? "invalid" : "normal",
  });
  return [
    {
      id: "agent",
      label: "Agent",
      fields: [
        field("model", "Model", state.agent.model, "model"),
        field("provider", "Provider", state.agent.provider),
        field("activeProfile", "Profile", state.agent.activeProfile),
        field("timezone", "Timezone", state.agent.timezone, "timezone"),
      ],
    },
    {
      id: "provider",
      label: "Provider",
      fields: [
        field("selectedProvider", "Selected provider", state.providerEditor.selectedProvider),
        field("profileId", "Profile ID", state.providerEditor.profileId),
        field("apiBase", "API base", state.providerEditor.apiBase, "providerApiBase"),
        field("models", "Models", parseDesktopProviderModelList(state.providerEditor.modelsText).join(", ")),
      ],
    },
    {
      id: "knowledge",
      label: "Knowledge",
      fields: [
        field("enabled", "Enabled", state.knowledge.enabled),
        field("retrievalMode", "Retrieval mode", state.knowledge.retrievalMode),
        field("maxChunks", "Max chunks", state.knowledge.maxChunks),
        field("rerankApiBase", "Rerank API base", state.knowledge.rerankApiBase, "rerankApiBase"),
      ],
    },
    {
      id: "tools",
      label: "Tools",
      fields: [
        field("webEnable", "Web tools", state.tools.webEnable),
        field("execEnable", "Exec tools", state.tools.execEnable),
        field("mcpServers", "MCP servers", state.tools.mcpServersText ? "Configured" : "None", "mcpServers"),
      ],
    },
    {
      id: "gateway",
      label: "Gateway",
      fields: [
        field("host", "Host", state.gateway.host),
        field("port", "Port", state.gateway.port, "gatewayPort"),
        field("heartbeat", "Heartbeat", state.gateway.heartbeatEnabled),
      ],
    },
    {
      id: "channels",
      label: "Channels",
      fields: [
        field("sendProgress", "Progress events", state.channels.sendProgress),
        field("sendToolHints", "Tool hints", state.channels.sendToolHints),
        field("sendMaxRetries", "Max retries", state.channels.sendMaxRetries),
      ],
    },
  ];
}

function formatDesktopSettingsSaveMessage(status: DesktopSettingsSaveStatus, dirty: boolean): string {
  if (status === "saving") {
    return "Saving settings";
  }
  if (status === "saved") {
    return "Settings saved";
  }
  return dirty ? "Unsaved changes" : "No changes";
}

function formatDesktopSettingsFieldValue(value: unknown): string {
  if (value === true) {
    return "Enabled";
  }
  if (value === false) {
    return "Disabled";
  }
  return stringValue(value);
}

function pick(record: UnknownRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  return undefined;
}

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return stringOrNull(value) ?? fallback;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.parseFloat(stringValue(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function boolValue(value: unknown): boolean {
  return value === true;
}
