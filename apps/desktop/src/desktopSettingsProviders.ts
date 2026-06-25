import { buildWorkbenchFileScopeLabel } from "./desktopSharedModels";

export interface DesktopProviderCatalogItem {
  id?: string;
  displayName?: string;
  baseUrl?: string;
  status?: string;
  enabled?: boolean | null;
}

export interface DesktopSettingsProviderEditorState {
  selectedProvider: string;
  profileId: string;
  apiKey: string;
  apiBase: string | null;
  modelsText: string;
  supportsModelDiscovery: boolean;
}

export interface DesktopSettingsProviderSummary {
  id: string;
  label: string;
  profileId: string;
  apiKey: string;
  apiBase: string | null;
  modelsText: string;
  supportsModelDiscovery: boolean;
  status: string;
  enabled: boolean;
  enabledConfigured: boolean;
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
    graphExtractionEnabled: boolean;
    graphAutoExtract: boolean;
    graphExtractionModel: string | null;
    graphExtractionMaxTokens: number | null;
    graphExtractionMaxJobTokens: number | null;
    graphExtractionConcurrency: number | null;
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
  providerSummaries: DesktopSettingsProviderSummary[];
  providerEditorDirty?: boolean;
  touchedPaths?: string[];
  serverSnapshot?: unknown;
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

export type DesktopSettingsSavePatchResult =
  | { ok: true; patch: UnknownRecord }
  | { ok: false; validationErrors: DesktopSettingsValidationError[] };

export type DesktopSettingsSaveReconcileResult =
  | { ok: true; state: DesktopSettingsFormState }
  | { ok: false; state: DesktopSettingsFormState; mismatchedPaths: string[] };

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

export type DesktopSettingsSaveStatus = "idle" | "saving" | "saved" | "failed" | "restart-required" | "reload-required";
export type DesktopSettingsSaveTransport = "native" | "gateway-fallback";
export interface DesktopSettingsPaneSaveDetails {
  transport: DesktopSettingsSaveTransport;
  updatedFields: string[];
  applied: string[];
  restartRequired: string[];
  reloadRequired: string[];
  warnings: string[];
}
export type DesktopSettingsPaneFieldControl = "text" | "number" | "checkbox" | "textarea" | "select" | "password" | "readonly";
export type DesktopSettingsPaneFieldRequirement = "required" | "optional" | "readonly";
export type DesktopSettingsPaneSourceKind = "config" | "local-ui-preference" | "cache" | "runtime-status";
export type DesktopSettingsPaneValueOrigin = "explicit" | "default" | "secret" | "cache" | "runtime" | "catalog";
export type DesktopSettingsPaneFieldConfigurationMode =
  | "fixed"
  | "freeform"
  | "json"
  | "list"
  | "numeric"
  | "readonly"
  | "secret"
  | "toggle"
  | "url";
export type DesktopSettingsEditableValue = string | boolean;
export type DesktopSettingsPaneApplyEffect = "immediate" | "gateway-restart" | "workspace-reload";

export interface DesktopSettingsPaneFieldOption {
  value: string;
  label: string;
}

export interface DesktopSettingsPaneFieldMetadata {
  label: string;
  description: string;
  aliases: string[];
  i18nKey: string;
  validationField?: DesktopSettingsValidationField;
  sensitive?: boolean;
  applyEffect?: DesktopSettingsPaneApplyEffect;
  unit?: string;
  recommendation?: string;
}

export interface DesktopSettingsPaneGroupMetadata {
  label: string;
  description: string;
  aliases: string[];
  i18nKey: string;
  navigationArea: "core" | "application" | "system";
  navigationMode: "section" | "preview" | "hidden";
}

export interface DesktopSettingsPaneField {
  id: string;
  label: string;
  description?: string;
  aliases?: string[];
  i18nKey?: string;
  persistentPath?: string;
  sourceKind?: DesktopSettingsPaneSourceKind;
  valueOrigin?: DesktopSettingsPaneValueOrigin;
  validationField?: DesktopSettingsValidationField;
  sensitive?: boolean;
  applyEffect?: DesktopSettingsPaneApplyEffect;
  unit?: string;
  recommendation?: string;
  value: string;
  state: "normal" | "invalid";
  control: DesktopSettingsPaneFieldControl;
  inputValue: string;
  checked?: boolean;
  options?: DesktopSettingsPaneFieldOption[];
  requirement: DesktopSettingsPaneFieldRequirement;
  configurationMode: DesktopSettingsPaneFieldConfigurationMode;
  disabled?: boolean;
  advanced?: boolean;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface DesktopSettingsPaneGroup {
  id:
    | "general"
    | "provider-models"
    | "knowledge"
    | "tools-approvals"
    | "files-workspace"
    | "memory-experience"
    | "skills"
    | "channels"
    | "automations"
    | "gateway-runtime"
    | "logs-diagnostics";
  label: string;
  description?: string;
  aliases?: string[];
  i18nKey?: string;
  navigationArea?: DesktopSettingsPaneGroupMetadata["navigationArea"];
  navigationMode?: DesktopSettingsPaneGroupMetadata["navigationMode"];
  fields: DesktopSettingsPaneField[];
}

type DesktopSettingsPaneGroupId = DesktopSettingsPaneGroup["id"];

const DESKTOP_SETTINGS_GROUP_METADATA: Record<DesktopSettingsPaneGroupId, DesktopSettingsPaneGroupMetadata> = {
  general: {
    label: "General",
    description: "Default model, provider routing, and timezone behavior.",
    aliases: ["default model", "profile", "timezone", "workspace"],
    i18nKey: "settings.groups.general",
    navigationArea: "core",
    navigationMode: "section",
  },
  "provider-models": {
    label: "Provider & Models",
    description: "Provider profiles, endpoints, credentials, and model catalogs.",
    aliases: ["providers", "models", "api key", "credentials"],
    i18nKey: "settings.groups.provider-models",
    navigationArea: "core",
    navigationMode: "section",
  },
  knowledge: {
    label: "Knowledge",
    description: "Retrieval, indexing, reranking, and graph extraction behavior.",
    aliases: ["rag", "retrieval", "embeddings", "graph"],
    i18nKey: "settings.groups.knowledge",
    navigationArea: "core",
    navigationMode: "section",
  },
  "tools-approvals": {
    label: "Tools & MCP",
    description: "Tool toggles and MCP server access. Approval controls are not exposed here yet.",
    aliases: ["tools", "mcp", "security"],
    i18nKey: "settings.groups.tools-approvals",
    navigationArea: "core",
    navigationMode: "section",
  },
  "files-workspace": {
    label: "Files & Workspace",
    description: "Session files, knowledge documents, and editable workspace file boundaries.",
    aliases: ["files", "storage", "workspace"],
    i18nKey: "settings.groups.files-workspace",
    navigationArea: "application",
    navigationMode: "section",
  },
  "memory-experience": {
    label: "Memory & Experience",
    description: "Memory and experience controls for contextual continuity.",
    aliases: ["memory", "experience"],
    i18nKey: "settings.groups.memory-experience",
    navigationArea: "application",
    navigationMode: "preview",
  },
  skills: {
    label: "Skills",
    description: "Skill availability and loading policy.",
    aliases: ["skills", "capabilities"],
    i18nKey: "settings.groups.skills",
    navigationArea: "application",
    navigationMode: "preview",
  },
  channels: {
    label: "Channels",
    description: "Streaming and retry behavior for desktop channels.",
    aliases: ["streaming", "progress", "retries"],
    i18nKey: "settings.groups.channels",
    navigationArea: "application",
    navigationMode: "section",
  },
  automations: {
    label: "Automations",
    description: "Automation and scheduling capabilities planned after core stability.",
    aliases: ["automation", "scheduling"],
    i18nKey: "settings.groups.automations",
    navigationArea: "application",
    navigationMode: "preview",
  },
  "gateway-runtime": {
    label: "Gateway & Runtime",
    description: "Local gateway connection, heartbeat, and runtime controls.",
    aliases: ["gateway", "runtime", "host", "port"],
    i18nKey: "settings.groups.gateway-runtime",
    navigationArea: "system",
    navigationMode: "section",
  },
  "logs-diagnostics": {
    label: "Logs & Diagnostics",
    description: "Runtime logs, diagnostics export, and local state recovery.",
    aliases: ["logs", "diagnostics", "debug"],
    i18nKey: "settings.groups.logs-diagnostics",
    navigationArea: "system",
    navigationMode: "section",
  },
};

const DESKTOP_SETTINGS_FIELD_METADATA: Record<string, DesktopSettingsPaneFieldMetadata> = {
  "general.model": {
    label: "Model",
    description: "Model used for default chat and agent responses.",
    aliases: ["default model", "chat model", "agent model"],
    validationField: "model",
    i18nKey: "settings.fields.general.model",
  },
  "general.provider": {
    label: "Provider",
    description: "Provider routing for the selected model.",
    aliases: ["default provider", "routing"],
    i18nKey: "settings.fields.general.provider",
  },
  "general.activeProfile": {
    label: "Profile",
    description: "Named provider profile with credentials and endpoint settings.",
    aliases: ["active profile", "provider profile"],
    i18nKey: "settings.fields.general.activeProfile",
  },
  "general.timezone": {
    label: "Timezone",
    description: "Timezone used for timestamps, reminders, and scheduled work.",
    aliases: ["time zone", "locale", "schedule timezone"],
    validationField: "timezone",
    i18nKey: "settings.fields.general.timezone",
  },
  "files-workspace.workspace": {
    label: "Workspace",
    description: "Default desktop workspace path for local files and agent work.",
    aliases: ["workspace folder", "working directory", "files"],
    applyEffect: "workspace-reload",
    i18nKey: "settings.fields.files-workspace.workspace",
  },
  "general.temperature": {
    label: "Temperature",
    description: "Sampling temperature for default chat and agent responses.",
    aliases: ["creativity", "sampling"],
    recommendation: "Recommended 0.1",
    i18nKey: "settings.fields.general.temperature",
  },
  "general.maxTokens": {
    label: "Max tokens",
    description: "Maximum generated tokens for a default response.",
    aliases: ["output tokens", "completion tokens"],
    unit: "tokens",
    i18nKey: "settings.fields.general.maxTokens",
  },
  "provider-models.apiKey": {
    label: "API key",
    description: "Secret credential used by the selected provider profile.",
    aliases: ["secret", "credential", "token"],
    sensitive: true,
    i18nKey: "settings.fields.provider-models.apiKey",
  },
  "provider-models.apiBase": {
    label: "API base",
    description: "OpenAI-compatible endpoint for this provider.",
    aliases: ["base url", "endpoint", "provider url"],
    validationField: "providerApiBase",
    i18nKey: "settings.fields.provider-models.apiBase",
  },
  "tools-approvals.mcpServers": {
    label: "MCP servers",
    description: "JSON object of MCP server definitions.",
    aliases: ["mcp", "servers", "tools json"],
    validationField: "mcpServers",
    sensitive: true,
    i18nKey: "settings.fields.tools-approvals.mcpServers",
  },
  "gateway-runtime.host": {
    label: "Host",
    description: "Host interface where the desktop gateway listens.",
    aliases: ["bind host", "listen address", "gateway endpoint"],
    applyEffect: "gateway-restart",
    i18nKey: "settings.fields.gateway-runtime.host",
  },
  "gateway-runtime.port": {
    label: "Port",
    description: "Port used by the local gateway endpoint.",
    aliases: ["gateway port", "listen port"],
    validationField: "gatewayPort",
    applyEffect: "gateway-restart",
    unit: "TCP port",
    i18nKey: "settings.fields.gateway-runtime.port",
  },
};

export function getDesktopSettingsGroupMetadata(
  groupId: DesktopSettingsPaneGroupId,
): DesktopSettingsPaneGroupMetadata {
  return DESKTOP_SETTINGS_GROUP_METADATA[groupId];
}

export function getDesktopSettingsFieldMetadata(
  groupId: DesktopSettingsPaneGroupId,
  fieldId: string,
): DesktopSettingsPaneFieldMetadata | null {
  return DESKTOP_SETTINGS_FIELD_METADATA[`${groupId}.${fieldId}`] ?? null;
}

export interface DesktopSettingsPaneModel {
  dirty: boolean;
  validationErrors: DesktopSettingsValidationError[];
  save: {
    status: DesktopSettingsSaveStatus;
    message: string;
    canSave: boolean;
    transport?: DesktopSettingsSaveTransport;
    updatedFields?: string[];
    applied?: string[];
    restartRequired?: string[];
    reloadRequired?: string[];
    warnings?: string[];
    diagnostics?: string;
  };
  runtime?: {
    intent: "local-only" | "local-network" | "advanced-custom";
    currentEndpoint: string;
    pendingEndpoint: string;
    portStatus: string;
    heartbeatDependency: string;
  };
  diagnostics?: {
    runtimeSummary: string;
    gatewayOwnership: string;
    version: string;
    activeConfigPath: string;
    lastConfigError: string;
    logLevel: "error" | "info" | "debug";
  };
  groups: DesktopSettingsPaneGroup[];
  providerCatalog: Array<{
    id: string;
    label: string;
    profileId?: string;
    status: string;
    enabled?: boolean;
    enabledConfigured?: boolean;
    baseUrl?: string | null;
    apiKey?: DesktopSecretField;
    models?: string[];
    canDiscoverModels?: boolean;
  }>;
  defaultRouting?: {
    mode: "auto" | "provider";
    providerId: string;
    providerLabel: string;
    model: string | null;
    message: string;
  };
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
  const rawProvider = stringValue(pick(defaults, "provider")) || "auto";
  const preliminaryDisplayProvider = rawProvider === "auto" ? "deepseek" : rawProvider;
  const preliminaryProfileId = stringValue(pick(defaults, "activeProfile", "active_profile"))
    || findDesktopProfileIdForProvider(providers, preliminaryDisplayProvider);
  const providerSummaries = buildDesktopProviderSummaries(providers, providerCatalog, preliminaryDisplayProvider, preliminaryProfileId);
  const providerIds = providerSummaries.map((provider) => provider.id).filter(Boolean);
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
      graphExtractionEnabled: pick(knowledge, "graphExtractionEnabled", "graph_extraction_enabled") !== false,
      graphAutoExtract: boolValue(pick(knowledge, "graphAutoExtract", "graph_auto_extract")),
      graphExtractionModel: stringOrNull(pick(knowledge, "graphExtractionModel", "graph_extraction_model")),
      graphExtractionMaxTokens: numberOrDefault(pick(knowledge, "graphExtractionMaxTokens", "graph_extraction_max_tokens"), 1200),
      graphExtractionMaxJobTokens: numberOrDefault(pick(knowledge, "graphExtractionMaxJobTokens", "graph_extraction_max_job_tokens"), 0),
      graphExtractionConcurrency: numberOrDefault(pick(knowledge, "graphExtractionConcurrency", "graph_extraction_concurrency"), 1),
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
    providerSummaries,
    serverSnapshot: cloneDesktopSettingsSnapshot(config),
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
    enabled: typeof provider.enabled === "boolean" ? provider.enabled : null,
  }));
}

export function buildDesktopProviderSummaries(
  providers: unknown,
  providerCatalog: DesktopProviderCatalogItem[] = [],
  displayProvider = "deepseek",
  activeProfileId = "",
): DesktopSettingsProviderSummary[] {
  const providerRoot = asRecord(providers);
  const profiles = getDesktopProviderProfiles(providerRoot);
  const providerIds = new Set<string>();
  for (const provider of providerCatalog) {
    const id = stringValue(provider.id);
    if (id) {
      providerIds.add(id);
    }
  }
  for (const key of Object.keys(providerRoot)) {
    if (key !== "profiles" && !isRecordValue(providerRoot[key])) {
      continue;
    }
    if (key !== "profiles") {
      providerIds.add(key);
    }
  }
  for (const profile of Object.values(profiles)) {
    const providerId = stringValue(asRecord(profile).provider);
    if (providerId) {
      providerIds.add(providerId);
    }
  }
  if (!providerIds.size) {
    providerIds.add(displayProvider || "deepseek");
  }

  return Array.from(providerIds).map((id) => {
    const catalogProvider = providerCatalog.find((provider) => stringValue(provider.id) === id);
    const matchedProfiles = Object.entries(profiles).filter(([, profile]) => stringValue(asRecord(profile).provider) === id);
    const activeProfile = activeProfileId
      ? matchedProfiles.find(([profileId]) => profileId === activeProfileId)
      : undefined;
    const namedProfile = matchedProfiles.find(([profileId]) => profileId === id);
    const profileEntry = activeProfile ?? namedProfile ?? matchedProfiles[0];
    const profileId = profileEntry?.[0] ?? findDesktopProfileIdForProvider(providerRoot, id);
    const profile = asRecord(profileEntry?.[1]);
    const legacyProvider = asRecord(providerRoot[id]);
    const apiKey = stringValue(pick(profile, "apiKey", "api_key")) || stringValue(pick(legacyProvider, "apiKey", "api_key"));
    const apiBase = stringOrNull(
      pick(profile, "apiBase", "api_base")
      || pick(legacyProvider, "apiBase", "api_base")
      || catalogProvider?.baseUrl,
    );
    const models = [
      ...parseDesktopProviderModelList(pick(profile, "models")),
      ...parseDesktopProviderModelList(pick(profile, "manualModels", "manual_models")),
      ...parseDesktopProviderModelList(pick(legacyProvider, "models")),
      ...parseDesktopProviderModelList(pick(legacyProvider, "manualModels", "manual_models")),
    ];
    const status = stringValue(catalogProvider?.status) || (apiKey || apiBase || models.length ? "ready" : "not_configured");
    const explicitEnabled = pick(profile, "enabled") ?? pick(legacyProvider, "enabled") ?? catalogProvider?.enabled;
    const enabledConfigured = typeof explicitEnabled === "boolean";
    const enabled = enabledConfigured ? explicitEnabled : isDesktopProviderEnabledStatus(status);
    return {
      id,
      label: stringValue(catalogProvider?.displayName) || id,
      profileId,
      apiKey,
      apiBase,
      modelsText: parseDesktopProviderModelList(models).join("\n"),
      supportsModelDiscovery: pick(profile, "supportsModelDiscovery", "supports_model_discovery") !== false
        && pick(legacyProvider, "supportsModelDiscovery", "supports_model_discovery") !== false,
      status,
      enabled,
      enabledConfigured,
    };
  });
}

export function createDesktopSettingsPatch(
  state: DesktopSettingsFormState,
  existingConfig?: unknown,
  providerCatalog: DesktopProviderCatalogItem[] = [],
): UnknownRecord {
  const comparisonConfig = existingConfig === undefined ? state.serverSnapshot ?? {} : existingConfig;
  if (state.touchedPaths) {
    return createDesktopSettingsTouchedPatch(state, comparisonConfig);
  }
  return createDesktopSettingsFullPatch(state, comparisonConfig, providerCatalog);
}

export function buildDesktopSettingsSavePatch(
  state: DesktopSettingsFormState,
  existingConfig?: unknown,
  providerCatalog: DesktopProviderCatalogItem[] = [],
): DesktopSettingsSavePatchResult {
  const validationErrors = validateDesktopSettingsForm(state);
  if (validationErrors.length) {
    return { ok: false, validationErrors };
  }
  return {
    ok: true,
    patch: createDesktopSettingsPatch(state, existingConfig, providerCatalog),
  };
}

export function reconcileDesktopSettingsSavedState(
  draftState: DesktopSettingsFormState,
  effectiveConfig: unknown,
  providerCatalog: DesktopProviderCatalogItem[] = [],
): DesktopSettingsSaveReconcileResult {
  const savedState = buildDesktopSettingsFormState(effectiveConfig, providerCatalog);
  const mismatchedPaths = (draftState.touchedPaths ?? []).filter((path) => (
    !desktopSettingsValuesEqual(
      getDesktopSettingsPatchPathValue(draftState, path),
      getDesktopSettingsPatchPathValue(savedState, path),
    )
  ));
  if (mismatchedPaths.length) {
    return {
      ok: false,
      state: draftState,
      mismatchedPaths,
    };
  }
  return {
    ok: true,
    state: savedState,
  };
}

function createDesktopSettingsFullPatch(
  state: DesktopSettingsFormState,
  existingConfig: unknown = {},
  providerCatalog: DesktopProviderCatalogItem[] = [],
): UnknownRecord {
  const providerIds = providerCatalog.map((provider) => stringValue(provider.id)).filter(Boolean);
  const providerDraft = getDesktopSettingsPersistedProviderDraft(state, providerIds);
  const providerName = providerDraft.providerName;
  const profileId = providerDraft.profileId;
  const providerEditor = providerDraft.editor;
  const existingProfiles = { ...getDesktopProviderProfiles(asRecord(asRecord(existingConfig).providers)) };
  const providers: UnknownRecord = {};

  if (profileId) {
    providers.profiles = {
      ...existingProfiles,
      [profileId]: {
        provider: providerName,
        enabled: state.providerSummaries.find((provider) => provider.id === providerName)?.enabled,
        api_key: providerEditor.apiKey || "",
        api_base: providerEditor.apiBase,
        models: parseDesktopProviderModelList(providerEditor.modelsText),
        supports_model_discovery: providerEditor.supportsModelDiscovery,
      },
    };
  }

  providers[providerName] = {
    enabled: state.providerSummaries.find((provider) => provider.id === providerName)?.enabled,
    api_key: providerEditor.apiKey || "",
    api_base: providerEditor.apiBase,
  };

  for (const provider of state.providerSummaries) {
    if (!provider.enabledConfigured || provider.id === providerName) {
      continue;
    }
    providers[provider.id] = {
      ...asRecord(providers[provider.id]),
      enabled: provider.enabled,
      api_key: provider.apiKey || "",
      api_base: provider.apiBase,
    };
    if (provider.profileId) {
      providers.profiles = {
        ...asRecord(providers.profiles),
        [provider.profileId]: {
          ...asRecord(asRecord(providers.profiles)[provider.profileId]),
          provider: provider.id,
          enabled: provider.enabled,
          api_key: provider.apiKey || "",
          api_base: provider.apiBase,
          models: parseDesktopProviderModelList(provider.modelsText),
          supports_model_discovery: provider.supportsModelDiscovery,
        },
      };
    }
  }

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
      graph_extraction_enabled: state.knowledge.graphExtractionEnabled,
      graph_auto_extract: state.knowledge.graphAutoExtract,
      graph_extraction_model: state.knowledge.graphExtractionModel,
      graph_extraction_max_tokens: state.knowledge.graphExtractionMaxTokens,
      graph_extraction_max_job_tokens: state.knowledge.graphExtractionMaxJobTokens,
      graph_extraction_concurrency: state.knowledge.graphExtractionConcurrency,
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

function createDesktopSettingsTouchedPatch(state: DesktopSettingsFormState, existingConfig: unknown): UnknownRecord {
  const patch: UnknownRecord = {};
  for (const path of state.touchedPaths ?? []) {
    const value = getDesktopSettingsPatchPathValue(state, path);
    if (desktopSettingsValuesEqual(value, getDesktopSettingsExistingConfigPathValue(existingConfig, path))) {
      continue;
    }
    setDesktopSettingsPatchPath(patch, path, value);
  }
  return patch;
}

function getDesktopSettingsPatchPathValue(state: DesktopSettingsFormState, path: string): unknown {
  switch (path) {
    case "agents.defaults.model":
      return state.agent.model;
    case "agents.defaults.active_profile":
      return state.agent.activeProfile;
    case "agents.defaults.provider":
      return state.agent.provider;
    case "agents.defaults.workspace":
      return state.agent.workspace;
    case "agents.defaults.temperature":
      return state.agent.temperature;
    case "agents.defaults.max_tokens":
      return state.agent.maxTokens;
    case "agents.defaults.context_window_tokens":
      return state.agent.contextWindowTokens;
    case "agents.defaults.max_tool_iterations":
      return state.agent.maxToolIterations;
    case "agents.defaults.reasoning_effort":
      return state.agent.reasoningEffort;
    case "agents.defaults.timezone":
      return state.agent.timezone;
    case "agents.defaults.embedding.provider":
      return state.embedding.provider;
    case "agents.defaults.embedding.model_name":
      return state.embedding.modelName;
    case "agents.defaults.embedding.api_key":
      return state.embedding.apiKey || "";
    case "agents.defaults.embedding.api_base":
      return state.embedding.apiBase;
    case "knowledge.enabled":
      return state.knowledge.enabled;
    case "knowledge.auto_retrieve":
      return state.knowledge.autoRetrieve;
    case "knowledge.max_chunks":
      return state.knowledge.maxChunks;
    case "knowledge.chunk_size":
      return state.knowledge.chunkSize;
    case "knowledge.chunk_overlap":
      return state.knowledge.chunkOverlap;
    case "knowledge.retrieval_mode":
      return state.knowledge.retrievalMode;
    case "knowledge.rerank_enabled":
      return state.knowledge.rerankEnabled;
    case "knowledge.rerank_model":
      return state.knowledge.rerankModel;
    case "knowledge.rerank_api_key":
      return state.knowledge.rerankApiKey;
    case "knowledge.rerank_api_key_env_var":
      return state.knowledge.rerankApiKeyEnvVar;
    case "knowledge.rerank_api_base":
      return state.knowledge.rerankApiBase;
    case "knowledge.rerank_top_n":
      return state.knowledge.rerankTopN;
    case "knowledge.generate_summary":
      return state.knowledge.generateSummary;
    case "knowledge.semantic_extraction_mode":
      return state.knowledge.semanticExtractionMode;
    case "knowledge.semantic_llm_max_tokens":
      return state.knowledge.semanticLlmMaxTokens;
    case "knowledge.semantic_llm_timeout":
      return state.knowledge.semanticLlmTimeout;
    case "knowledge.graph_extraction_enabled":
      return state.knowledge.graphExtractionEnabled;
    case "knowledge.graph_auto_extract":
      return state.knowledge.graphAutoExtract;
    case "knowledge.graph_extraction_model":
      return state.knowledge.graphExtractionModel;
    case "knowledge.graph_extraction_max_tokens":
      return state.knowledge.graphExtractionMaxTokens;
    case "knowledge.graph_extraction_max_job_tokens":
      return state.knowledge.graphExtractionMaxJobTokens;
    case "knowledge.graph_extraction_concurrency":
      return state.knowledge.graphExtractionConcurrency;
    case "knowledge.graphrag_community_algorithm":
      return state.knowledge.graphRagCommunityAlgorithm;
    case "knowledge.graphrag_community_level":
      return state.knowledge.graphRagCommunityLevel;
    case "knowledge.graphrag_report_llm_enabled":
      return state.knowledge.graphRagReportLlmEnabled;
    case "knowledge.graphrag_report_max_tokens":
      return state.knowledge.graphRagReportMaxTokens;
    case "knowledge.graphrag_entity_summary_enabled":
      return state.knowledge.graphRagEntitySummaryEnabled;
    case "tools.web.enable":
      return state.tools.webEnable;
    case "tools.web.proxy":
      return state.tools.webProxy;
    case "tools.web.search.provider":
      return state.tools.searchProvider;
    case "tools.exec.enable":
      return state.tools.execEnable;
    case "tools.exec.timeout":
      return state.tools.execTimeout;
    case "tools.mcp_servers":
      return parseDesktopJsonObject(state.tools.mcpServersText);
    case "tools.restrict_to_workspace":
      return state.tools.restrictToWorkspace;
    case "gateway.host":
      return state.gateway.host;
    case "gateway.port":
      return state.gateway.port;
    case "gateway.heartbeat.enabled":
      return state.gateway.heartbeatEnabled;
    case "gateway.heartbeat.interval_s":
      return state.gateway.heartbeatIntervalS;
    case "channels.send_progress":
      return state.channels.sendProgress;
    case "channels.send_tool_hints":
      return state.channels.sendToolHints;
    case "channels.send_max_retries":
      return state.channels.sendMaxRetries;
  }

  const providerEnabledPath = path.match(/^providers\.([^.]+)\.enabled$/);
  if (providerEnabledPath) {
    return state.providerSummaries.find((provider) => provider.id === providerEnabledPath[1])?.enabled ?? false;
  }
  const providerApiKeyPath = path.match(/^providers\.([^.]+)\.api_key$/);
  if (providerApiKeyPath) {
    return state.providerSummaries.find((provider) => provider.id === providerApiKeyPath[1])?.apiKey || "";
  }
  const providerApiBasePath = path.match(/^providers\.([^.]+)\.api_base$/);
  if (providerApiBasePath) {
    return state.providerSummaries.find((provider) => provider.id === providerApiBasePath[1])?.apiBase ?? null;
  }
  const profilePath = path.match(/^providers\.profiles\.([^.]+)\.([^.]+)$/);
  if (profilePath) {
    const [, profileId, field] = profilePath;
    const summary = state.providerSummaries.find((provider) => provider.profileId === profileId);
    switch (field) {
      case "provider":
        return summary?.id || state.providerEditor.selectedProvider;
      case "enabled":
        return summary?.enabled ?? false;
      case "api_key":
        return summary?.apiKey || "";
      case "api_base":
        return summary?.apiBase ?? null;
      case "models":
        return parseDesktopProviderModelList(summary?.modelsText ?? "");
      case "supports_model_discovery":
        return summary?.supportsModelDiscovery ?? true;
    }
  }

  return undefined;
}

function setDesktopSettingsPatchPath(patch: UnknownRecord, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor = patch;
  for (const part of parts.slice(0, -1)) {
    if (!isRecordValue(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part] as UnknownRecord;
  }
  cursor[parts[parts.length - 1]] = value;
}

function getDesktopSettingsExistingConfigPathValue(existingConfig: unknown, path: string): unknown {
  let cursor: unknown = existingConfig;
  for (const part of path.split(".")) {
    cursor = asRecord(cursor)[part];
  }
  return cursor;
}

function desktopSettingsValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function validateDesktopSettingsForm(state: DesktopSettingsFormState): DesktopSettingsValidationError[] {
  const errors: DesktopSettingsValidationError[] = [];
  if (!state.agent.model?.trim()) {
    errors.push({ field: "model", errorKey: "modelEmpty" });
  }
  if (!validateDesktopTimezone(state.agent.timezone || "")) {
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
    saveDetails?: DesktopSettingsPaneSaveDetails | null;
  } = {},
): DesktopSettingsPaneModel {
  const validationErrors = validateDesktopSettingsForm(state);
  const providerSummaries = getDesktopStateProviderSummaries(state, options.providerCatalog ?? []);
  const dirty = options.lastSavedState
    ? desktopSettingsStateDirty(state, options.lastSavedState)
    : false;
  const saveDetails = normalizeDesktopSettingsSaveDetails(options.saveDetails);
  const saveStatus = resolveDesktopSettingsSaveStatus(options.saveStatus ?? "idle", saveDetails);
  const save: DesktopSettingsPaneModel["save"] = {
    status: saveStatus,
    message: saveStatus === "failed" ? options.saveError || "Save failed" : formatDesktopSettingsSaveMessage(saveStatus, dirty, validationErrors.length, saveDetails),
    canSave: dirty && validationErrors.length === 0 && saveStatus !== "saving",
  };
  if (saveDetails) {
    save.transport = saveDetails.transport;
    save.updatedFields = saveDetails.updatedFields;
    save.applied = saveDetails.applied;
    save.restartRequired = saveDetails.restartRequired;
    save.reloadRequired = saveDetails.reloadRequired;
    save.warnings = saveDetails.warnings;
    save.diagnostics = formatDesktopSettingsSaveDiagnostics(saveStatus, saveDetails);
  }
  const runtime = buildDesktopSettingsRuntimeSummary(state, options.lastSavedState ?? state, save);
  const diagnostics = buildDesktopSettingsDiagnosticsSummary(runtime, save);
  const providerCatalog = providerSummaries.map((provider) => ({
    id: provider.id,
    label: provider.label,
    profileId: provider.profileId,
    status: provider.status || "unknown",
    enabled: provider.enabled,
    enabledConfigured: provider.enabledConfigured,
    baseUrl: provider.apiBase,
    apiKey: buildDesktopSecretField(provider.apiKey),
    models: parseDesktopProviderModelList(provider.modelsText),
    canDiscoverModels: provider.supportsModelDiscovery,
  })).filter((provider) => provider.id);
  return {
    dirty,
    validationErrors,
    save,
    runtime,
    diagnostics,
    groups: buildDesktopSettingsPaneGroups(state, validationErrors, providerSummaries),
    providerCatalog,
    defaultRouting: buildDesktopDefaultRouting(state, providerCatalog),
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

function buildDesktopSettingsDiagnosticsSummary(
  runtime: NonNullable<DesktopSettingsPaneModel["runtime"]>,
  save: DesktopSettingsPaneModel["save"],
): NonNullable<DesktopSettingsPaneModel["diagnostics"]> {
  const saveStatus = `Settings save status: ${save.status}`;
  return {
    runtimeSummary: `Runtime summary: current ${runtime.currentEndpoint}; pending ${runtime.pendingEndpoint}; ${saveStatus}.`,
    gatewayOwnership: "Gateway ownership: Desktop-managed local gateway.",
    version: "Version: Current desktop build.",
    activeConfigPath: "Active config path: Managed by native runtime.",
    lastConfigError: save.status === "failed"
      ? `Last config error: ${save.message}`
      : "Last config error: None.",
    logLevel: "info",
  };
}

function buildDesktopSettingsRuntimeSummary(
  state: DesktopSettingsFormState,
  lastSavedState: DesktopSettingsFormState,
  save: DesktopSettingsPaneModel["save"],
): NonNullable<DesktopSettingsPaneModel["runtime"]> {
  const pendingEndpoint = formatDesktopGatewayEndpoint(state.gateway.host, state.gateway.port);
  const currentEndpoint = save.restartRequired?.length
    ? formatDesktopGatewayEndpoint(lastSavedState.gateway.host, lastSavedState.gateway.port)
    : pendingEndpoint;
  const intent = classifyDesktopGatewayIntent(state.gateway.host);
  const port = state.gateway.port;
  return {
    intent,
    currentEndpoint,
    pendingEndpoint,
    portStatus: port && validateDesktopPortRange(port)
      ? `Port ${port} will be checked for availability before the gateway restarts.`
      : "Port availability cannot be checked until a valid port is configured.",
    heartbeatDependency: state.gateway.heartbeatEnabled
      ? "Heartbeat interval is active while heartbeat is enabled."
      : "Heartbeat interval is disabled while heartbeat is off.",
  };
}

function classifyDesktopGatewayIntent(host: string | null): NonNullable<DesktopSettingsPaneModel["runtime"]>["intent"] {
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
    return "local-only";
  }
  if (host === "0.0.0.0" || host === "::") {
    return "local-network";
  }
  return "advanced-custom";
}

function formatDesktopGatewayEndpoint(host: string | null, port: number | null): string {
  const safeHost = host || "127.0.0.1";
  const safePort = port ?? 18790;
  return `${safeHost}:${safePort}`;
}

function buildDesktopDefaultRouting(
  state: DesktopSettingsFormState,
  providerCatalog: DesktopSettingsPaneModel["providerCatalog"],
): DesktopSettingsPaneModel["defaultRouting"] {
  const model = state.agent.model;
  const mode = state.agent.provider === "auto" ? "auto" : "provider";
  const enabledProviders = providerCatalog.filter((provider) => provider.enabled !== false);
  const configuredProvider = providerCatalog.find((provider) => provider.id === state.agent.provider);
  const resolvedProvider = mode === "auto"
    ? enabledProviders.find((provider) => model ? provider.models?.includes(model) : false) ?? enabledProviders[0] ?? providerCatalog[0]
    : configuredProvider ?? providerCatalog[0];
  const providerLabel = resolvedProvider?.label || resolvedProvider?.id || "Unavailable";
  const providerId = resolvedProvider?.id || "";
  return {
    mode,
    providerId,
    providerLabel,
    model,
    message: mode === "auto"
      ? `Auto resolves to ${providerLabel}${model ? ` / ${model}` : ""}`
      : `${providerLabel}${model ? ` / ${model}` : ""}`,
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
  nextState.providerEditorDirty = true;
  syncDesktopProviderSummaryFromEditor(nextState);
  markDesktopProviderEditorTouched(nextState, "models");
  if (!nextState.agent.model && models[0]) {
    nextState.agent.model = models[0];
    markDesktopSettingsTouched(nextState, "agents.defaults.model");
  }
  return {
    state: nextState,
    models,
    selectedModel: nextState.agent.model,
    status: "loaded",
    message: stringValue(payload.warning) || `Loaded models ${models.length}`,
  };
}

export function applyDesktopSettingsFieldEdit(
  state: DesktopSettingsFormState,
  fieldId: string,
  value: DesktopSettingsEditableValue,
): DesktopSettingsFormState {
  const nextState = cloneSettingsState(state);
  nextState.touchedPaths = nextState.touchedPaths ?? [];
  const text = String(value);
  if (fieldId.startsWith("providerEnabled:")) {
    const providerId = fieldId.slice("providerEnabled:".length);
    setDesktopProviderEnabled(nextState, providerId, Boolean(value));
    markDesktopProviderEnabledTouched(nextState, providerId);
    return nextState;
  }
  switch (fieldId) {
    case "model":
      nextState.agent.model = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.model");
      break;
    case "provider":
      nextState.agent.provider = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.provider");
      break;
    case "activeProfile":
      nextState.agent.activeProfile = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.active_profile");
      break;
    case "workspace":
      nextState.agent.workspace = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.workspace");
      break;
    case "temperature":
      nextState.agent.temperature = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.temperature");
      break;
    case "maxTokens":
      nextState.agent.maxTokens = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.max_tokens");
      break;
    case "contextWindowTokens":
      nextState.agent.contextWindowTokens = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.context_window_tokens");
      break;
    case "maxToolIterations":
      nextState.agent.maxToolIterations = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.max_tool_iterations");
      break;
    case "reasoningEffort":
      nextState.agent.reasoningEffort = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.reasoning_effort");
      break;
    case "timezone":
      nextState.agent.timezone = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.timezone");
      break;
    case "selectedProvider":
      selectDesktopProviderEditor(nextState, stringOrNullInput(text) || "deepseek");
      nextState.providerEditorDirty = false;
      break;
    case "profileId":
      nextState.providerEditor.profileId = text.trim();
      nextState.agent.activeProfile = stringOrNullInput(text);
      nextState.providerEditorDirty = true;
      syncDesktopProviderSummaryFromEditor(nextState);
      markDesktopSettingsTouched(nextState, "agents.defaults.active_profile");
      markDesktopProviderEditorTouched(nextState, "profile");
      break;
    case "apiKey":
      nextState.providerEditor.apiKey = resolveDesktopSecretValue(text, nextState.providerEditor.apiKey);
      nextState.providerEditorDirty = true;
      syncDesktopProviderSummaryFromEditor(nextState);
      markDesktopProviderEditorTouched(nextState, "api_key");
      break;
    case "apiBase":
      nextState.providerEditor.apiBase = stringOrNullInput(text);
      nextState.providerEditorDirty = true;
      syncDesktopProviderSummaryFromEditor(nextState);
      markDesktopProviderEditorTouched(nextState, "api_base");
      break;
    case "models":
      nextState.providerEditor.modelsText = text;
      nextState.providerEditorDirty = true;
      syncDesktopProviderSummaryFromEditor(nextState);
      markDesktopProviderEditorTouched(nextState, "models");
      break;
    case "enabled":
      nextState.knowledge.enabled = Boolean(value);
      markDesktopSettingsTouched(nextState, "knowledge.enabled");
      break;
    case "autoRetrieve":
      nextState.knowledge.autoRetrieve = Boolean(value);
      markDesktopSettingsTouched(nextState, "knowledge.auto_retrieve");
      break;
    case "retrievalMode":
      nextState.knowledge.retrievalMode = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.retrieval_mode");
      break;
    case "maxChunks":
      nextState.knowledge.maxChunks = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.max_chunks");
      break;
    case "chunkSize":
      nextState.knowledge.chunkSize = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.chunk_size");
      break;
    case "chunkOverlap":
      nextState.knowledge.chunkOverlap = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.chunk_overlap");
      break;
    case "rerankEnabled":
      nextState.knowledge.rerankEnabled = Boolean(value);
      markDesktopSettingsTouched(nextState, "knowledge.rerank_enabled");
      break;
    case "rerankModel":
      nextState.knowledge.rerankModel = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.rerank_model");
      break;
    case "rerankApiBase":
      nextState.knowledge.rerankApiBase = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.rerank_api_base");
      break;
    case "rerankTopN":
      nextState.knowledge.rerankTopN = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.rerank_top_n");
      break;
    case "graphExtractionEnabled":
      nextState.knowledge.graphExtractionEnabled = Boolean(value);
      markDesktopSettingsTouched(nextState, "knowledge.graph_extraction_enabled");
      break;
    case "graphAutoExtract":
      nextState.knowledge.graphAutoExtract = Boolean(value);
      markDesktopSettingsTouched(nextState, "knowledge.graph_auto_extract");
      break;
    case "graphExtractionModel":
      nextState.knowledge.graphExtractionModel = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.graph_extraction_model");
      break;
    case "graphExtractionMaxTokens":
      nextState.knowledge.graphExtractionMaxTokens = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.graph_extraction_max_tokens");
      break;
    case "graphExtractionMaxJobTokens":
      nextState.knowledge.graphExtractionMaxJobTokens = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.graph_extraction_max_job_tokens");
      break;
    case "graphExtractionConcurrency":
      nextState.knowledge.graphExtractionConcurrency = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "knowledge.graph_extraction_concurrency");
      break;
    case "webEnable":
      nextState.tools.webEnable = Boolean(value);
      markDesktopSettingsTouched(nextState, "tools.web.enable");
      break;
    case "webProxy":
      nextState.tools.webProxy = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "tools.web.proxy");
      break;
    case "searchProvider":
      nextState.tools.searchProvider = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "tools.web.search.provider");
      break;
    case "execEnable":
      nextState.tools.execEnable = Boolean(value);
      markDesktopSettingsTouched(nextState, "tools.exec.enable");
      break;
    case "execTimeout":
      nextState.tools.execTimeout = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "tools.exec.timeout");
      break;
    case "mcpServers":
      nextState.tools.mcpServersText = text;
      markDesktopSettingsTouched(nextState, "tools.mcp_servers");
      break;
    case "restrictToWorkspace":
      nextState.tools.restrictToWorkspace = Boolean(value);
      markDesktopSettingsTouched(nextState, "tools.restrict_to_workspace");
      break;
    case "host":
      nextState.gateway.host = stringOrNullInput(text);
      markDesktopSettingsTouched(nextState, "gateway.host");
      break;
    case "port":
      nextState.gateway.port = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "gateway.port");
      break;
    case "heartbeat":
      nextState.gateway.heartbeatEnabled = Boolean(value);
      markDesktopSettingsTouched(nextState, "gateway.heartbeat.enabled");
      break;
    case "heartbeatIntervalS":
      nextState.gateway.heartbeatIntervalS = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "gateway.heartbeat.interval_s");
      break;
    case "sendProgress":
      nextState.channels.sendProgress = Boolean(value);
      markDesktopSettingsTouched(nextState, "channels.send_progress");
      break;
    case "sendToolHints":
      nextState.channels.sendToolHints = Boolean(value);
      markDesktopSettingsTouched(nextState, "channels.send_tool_hints");
      break;
    case "sendMaxRetries":
      nextState.channels.sendMaxRetries = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "channels.send_max_retries");
      break;
  }
  return nextState;
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
  const timezone = value.trim();
  if (!timezone) {
    return false;
  }
  if (["UTC", "GMT"].includes(timezone)) {
    return true;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function desktopSettingsStateDirty(
  state: DesktopSettingsFormState,
  lastSavedState: DesktopSettingsFormState,
): boolean {
  if (state.touchedPaths) {
    return state.touchedPaths.some((path) => (
      !desktopSettingsValuesEqual(
        getDesktopSettingsPatchPathValue(state, path),
        getDesktopSettingsPatchPathValue(lastSavedState, path),
      )
    ));
  }
  return JSON.stringify(createDesktopSettingsPatch(state)) !== JSON.stringify(createDesktopSettingsPatch(lastSavedState));
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
    providerSummaries: (state.providerSummaries ?? []).map((provider) => ({ ...provider })),
    providerEditorDirty: state.providerEditorDirty,
    touchedPaths: state.touchedPaths ? [...state.touchedPaths] : undefined,
    serverSnapshot: cloneDesktopSettingsSnapshot(state.serverSnapshot),
  };
}

function markDesktopSettingsTouched(state: DesktopSettingsFormState, path: string): void {
  const touchedPaths = state.touchedPaths ?? [];
  if (!touchedPaths.includes(path)) {
    touchedPaths.push(path);
  }
  state.touchedPaths = touchedPaths;
}

function markDesktopProviderEditorTouched(
  state: DesktopSettingsFormState,
  field: "profile" | "enabled" | "api_key" | "api_base" | "models" | "supports_model_discovery",
): void {
  const providerId = state.providerEditor.selectedProvider || "deepseek";
  const profileId = state.providerEditor.profileId || providerId;
  if (field === "profile") {
    markDesktopSettingsTouched(state, `providers.profiles.${profileId}.provider`);
    markDesktopSettingsTouched(state, `providers.profiles.${profileId}.enabled`);
    markDesktopSettingsTouched(state, `providers.profiles.${profileId}.api_key`);
    markDesktopSettingsTouched(state, `providers.profiles.${profileId}.api_base`);
    markDesktopSettingsTouched(state, `providers.profiles.${profileId}.models`);
    markDesktopSettingsTouched(state, `providers.profiles.${profileId}.supports_model_discovery`);
    return;
  }
  if (field === "api_key" || field === "api_base") {
    markDesktopSettingsTouched(state, `providers.${providerId}.${field}`);
  }
  markDesktopSettingsTouched(state, `providers.profiles.${profileId}.${field}`);
}

function markDesktopProviderEnabledTouched(state: DesktopSettingsFormState, providerId: string): void {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) {
    return;
  }
  markDesktopSettingsTouched(state, `providers.${normalizedProviderId}.enabled`);
  const summary = state.providerSummaries.find((provider) => provider.id === normalizedProviderId);
  if (summary?.profileId) {
    markDesktopSettingsTouched(state, `providers.profiles.${summary.profileId}.enabled`);
  }
}

function getDesktopSettingsPersistedProviderDraft(
  state: DesktopSettingsFormState,
  providerIds: string[],
): { providerName: string; profileId: string | null; editor: DesktopSettingsProviderEditorState } {
  if (state.providerEditorDirty !== false) {
    const providerName = providerIds.includes(state.providerEditor.selectedProvider)
      ? state.providerEditor.selectedProvider
      : state.providerEditor.selectedProvider || "deepseek";
    return {
      providerName,
      profileId: stringOrNull(state.providerEditor.profileId) || state.agent.activeProfile,
      editor: state.providerEditor,
    };
  }

  const profileId = state.agent.activeProfile;
  const defaultProvider = state.agent.provider && state.agent.provider !== "auto" ? state.agent.provider : null;
  const summary = state.providerSummaries.find((provider) => (
    (profileId && provider.profileId === profileId)
    || (defaultProvider && provider.id === defaultProvider)
  ));
  const providerName = defaultProvider || summary?.id || state.providerEditor.selectedProvider || "deepseek";
  return {
    providerName,
    profileId: profileId || summary?.profileId || providerName,
    editor: {
      selectedProvider: providerName,
      profileId: profileId || summary?.profileId || providerName,
      apiKey: summary?.apiKey || "",
      apiBase: summary?.apiBase ?? null,
      modelsText: summary?.modelsText || "",
      supportsModelDiscovery: summary?.supportsModelDiscovery ?? true,
    },
  };
}

function getDesktopStateProviderSummaries(
  state: DesktopSettingsFormState,
  providerCatalog: DesktopProviderCatalogItem[],
): DesktopSettingsProviderSummary[] {
  if (state.providerSummaries?.length) {
    return state.providerSummaries;
  }
  const selectedProvider = state.providerEditor.selectedProvider || "deepseek";
  const catalog = providerCatalog.length
    ? providerCatalog
    : [{ id: selectedProvider, displayName: selectedProvider, status: "not_configured" }];
  return catalog.map((provider) => {
    const id = stringValue(provider.id);
    const status = stringValue(provider.status) || "not_configured";
    const isSelected = id === selectedProvider;
    return {
      id,
      label: stringValue(provider.displayName) || id,
      profileId: isSelected ? state.providerEditor.profileId : id,
      apiKey: isSelected ? state.providerEditor.apiKey : "",
      apiBase: isSelected ? state.providerEditor.apiBase : stringOrNull(provider.baseUrl),
      modelsText: isSelected ? state.providerEditor.modelsText : "",
      supportsModelDiscovery: isSelected ? state.providerEditor.supportsModelDiscovery : true,
      status,
      enabled: isDesktopProviderEnabledStatus(status),
      enabledConfigured: false,
    };
  }).filter((provider) => provider.id);
}

function selectDesktopProviderEditor(state: DesktopSettingsFormState, providerId: string): void {
  const summary = state.providerSummaries.find((provider) => provider.id === providerId);
  state.providerEditor.selectedProvider = providerId;
  if (!summary) {
    state.providerEditor.profileId = providerId;
    state.providerEditor.apiKey = "";
    state.providerEditor.apiBase = null;
    state.providerEditor.modelsText = "";
    state.providerEditor.supportsModelDiscovery = true;
    state.providerSummaries.push({
      id: providerId,
      label: providerId,
      profileId: providerId,
      apiKey: "",
      apiBase: null,
      modelsText: "",
      supportsModelDiscovery: true,
      status: "not_configured",
      enabled: false,
      enabledConfigured: true,
    });
    return;
  }
  state.providerEditor.profileId = summary.profileId;
  state.providerEditor.apiKey = summary.apiKey;
  state.providerEditor.apiBase = summary.apiBase;
  state.providerEditor.modelsText = summary.modelsText;
  state.providerEditor.supportsModelDiscovery = summary.supportsModelDiscovery;
}

function syncDesktopProviderSummaryFromEditor(state: DesktopSettingsFormState): void {
  const selectedProvider = state.providerEditor.selectedProvider || "deepseek";
  const summary = state.providerSummaries.find((provider) => provider.id === selectedProvider);
  if (!summary) {
    state.providerSummaries.push({
      id: selectedProvider,
      label: selectedProvider,
      profileId: state.providerEditor.profileId || selectedProvider,
      apiKey: state.providerEditor.apiKey,
      apiBase: state.providerEditor.apiBase,
      modelsText: state.providerEditor.modelsText,
      supportsModelDiscovery: state.providerEditor.supportsModelDiscovery,
      status: "not_configured",
      enabled: false,
      enabledConfigured: true,
    });
    return;
  }
  summary.profileId = state.providerEditor.profileId || selectedProvider;
  summary.apiKey = state.providerEditor.apiKey;
  summary.apiBase = state.providerEditor.apiBase;
  summary.modelsText = state.providerEditor.modelsText;
  summary.supportsModelDiscovery = state.providerEditor.supportsModelDiscovery;
}

function setDesktopProviderEnabled(state: DesktopSettingsFormState, providerId: string, enabled: boolean): void {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) {
    return;
  }
  if (!enabled && state.agent.provider && state.agent.provider !== "auto" && state.agent.provider === normalizedProviderId) {
    return;
  }
  let summary = state.providerSummaries.find((provider) => provider.id === normalizedProviderId);
  if (!summary) {
    summary = {
      id: normalizedProviderId,
      label: normalizedProviderId,
      profileId: normalizedProviderId,
      apiKey: "",
      apiBase: null,
      modelsText: "",
      supportsModelDiscovery: true,
      status: "not_configured",
      enabled,
      enabledConfigured: true,
    };
    state.providerSummaries.push(summary);
  }
  summary.enabled = enabled;
  summary.enabledConfigured = true;
}

function isDesktopProviderEnabledStatus(status: string): boolean {
  return ["ready", "available", "no_models"].includes(status);
}

function isDesktopProviderDefaultSelectableStatus(status: string): boolean {
  return ["ready", "available", "no_models"].includes(status);
}

function buildDesktopDefaultModelOptions(
  state: DesktopSettingsFormState,
  providerSummaries: DesktopSettingsProviderSummary[],
): DesktopSettingsPaneFieldOption[] {
  const providerId = state.agent.provider && state.agent.provider !== "auto"
    ? state.agent.provider
    : state.providerEditor.selectedProvider;
  const provider = providerSummaries.find((summary) => summary.id === providerId);
  const models = parseDesktopProviderModelList(provider?.modelsText || state.providerEditor.modelsText);
  const selectedModel = stringOrNull(state.agent.model);
  if (selectedModel && !models.includes(selectedModel)) {
    models.unshift(selectedModel);
  }
  return models.map((model) => ({ value: model, label: model }));
}

function buildDesktopSettingsPaneGroups(
  state: DesktopSettingsFormState,
  validationErrors: DesktopSettingsValidationError[],
  providerSummaries: DesktopSettingsProviderSummary[] = state.providerSummaries ?? [],
): DesktopSettingsPaneGroup[] {
  const invalidFields = new Set(validationErrors.map((error) => error.field));
  const modelOptions = buildDesktopDefaultModelOptions(state, providerSummaries);
  const editorProviderOptions = providerSummaries.map((provider) => ({
      value: provider.id,
      label: provider.label || provider.id,
    })).filter((provider) => provider.value);
  for (const value of [state.providerEditor.selectedProvider, "deepseek"].filter(Boolean)) {
    if (!editorProviderOptions.some((option) => option.value === value)) {
      editorProviderOptions.push({ value, label: value });
    }
  }
  const agentProviderOptions = [
    { value: "auto", label: "Auto" },
    ...providerSummaries.filter((provider) => provider.enabled && isDesktopProviderDefaultSelectableStatus(provider.status)).map((provider) => ({
      value: provider.id,
      label: provider.label || provider.id,
    })),
  ];
  const fixedOptions = (values: string[]): DesktopSettingsPaneFieldOption[] => values.map((value) => ({
    value,
    label: value || "None",
  }));
  const fieldModeForControl = (control: DesktopSettingsPaneFieldControl): DesktopSettingsPaneFieldConfigurationMode => {
    switch (control) {
      case "checkbox":
        return "toggle";
      case "number":
        return "numeric";
      case "password":
        return "secret";
      case "readonly":
        return "readonly";
      case "select":
        return "fixed";
      case "textarea":
        return "freeform";
      default:
        return "freeform";
    }
  };
  const fieldRequirementForControl = (control: DesktopSettingsPaneFieldControl): DesktopSettingsPaneFieldRequirement => (
    control === "readonly" ? "readonly" : "optional"
  );
  const field = (
    id: string,
    label: string,
    value: unknown,
    config: {
      persistentPath?: string;
      sourceKind?: DesktopSettingsPaneSourceKind;
      valueOrigin?: DesktopSettingsPaneValueOrigin;
      validationField?: DesktopSettingsValidationField;
      control?: DesktopSettingsPaneFieldControl;
      options?: DesktopSettingsPaneFieldOption[];
      inputValue?: string;
      requirement?: DesktopSettingsPaneFieldRequirement;
      configurationMode?: DesktopSettingsPaneFieldConfigurationMode;
      applyEffect?: DesktopSettingsPaneApplyEffect;
      disabled?: boolean;
      advanced?: boolean;
      placeholder?: string;
      min?: number;
      max?: number;
      step?: number;
    } = {},
  ): DesktopSettingsPaneField => ({
    id,
    label,
    persistentPath: config.persistentPath,
    sourceKind: config.sourceKind,
    valueOrigin: config.valueOrigin,
    validationField: config.validationField,
    value: formatDesktopSettingsFieldValue(value),
    state: config.validationField && invalidFields.has(config.validationField) ? "invalid" : "normal",
    control: config.control ?? "text",
    inputValue: config.inputValue ?? stringValue(value),
    checked: config.control === "checkbox" ? value === true : undefined,
    options: config.options,
    requirement: config.requirement ?? fieldRequirementForControl(config.control ?? "text"),
    configurationMode: config.configurationMode ?? fieldModeForControl(config.control ?? "text"),
    applyEffect: config.applyEffect,
    disabled: config.disabled ?? false,
    advanced: config.advanced,
    placeholder: config.placeholder,
    min: config.min,
    max: config.max,
    step: config.step,
  });
  const secretField = buildDesktopSecretField(state.providerEditor.apiKey);
  const providerEditorProviderId = state.providerEditor.selectedProvider || "deepseek";
  const providerEditorProfileId = state.providerEditor.profileId || providerEditorProviderId;
  const knowledgeDisabled = !state.knowledge.enabled;
  const rerankDisabled = knowledgeDisabled || !state.knowledge.rerankEnabled;
  const graphExtractionDisabled = knowledgeDisabled || !state.knowledge.graphExtractionEnabled;
  return enrichDesktopSettingsPaneGroups([
    {
      id: "general",
      label: "General",
      fields: [
        field("model", "Model", state.agent.model, {
          validationField: "model",
          control: modelOptions.length ? "select" : "text",
          options: modelOptions.length ? modelOptions : undefined,
          requirement: "required",
          configurationMode: modelOptions.length ? "fixed" : "freeform",
        }),
        field("provider", "Provider", state.agent.provider, {
          control: "select",
          options: agentProviderOptions,
          requirement: "optional",
          configurationMode: "fixed",
        }),
        field("activeProfile", "Profile", state.agent.activeProfile, {
          requirement: "optional",
          configurationMode: "freeform",
        }),
        field("timezone", "Timezone", state.agent.timezone, {
          validationField: "timezone",
          requirement: "required",
          configurationMode: "freeform",
          placeholder: "Asia/Shanghai",
        }),
        field("temperature", "Temperature", state.agent.temperature, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 0,
          max: 2,
          step: 0.1,
        }),
        field("maxTokens", "Max tokens", state.agent.maxTokens, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("contextWindowTokens", "Context window tokens", state.agent.contextWindowTokens, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("maxToolIterations", "Max tool iterations", state.agent.maxToolIterations, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("reasoningEffort", "Reasoning effort", state.agent.reasoningEffort, {
          control: "select",
          options: fixedOptions(["", "low", "medium", "high"]),
          requirement: "optional",
          configurationMode: "fixed",
          advanced: true,
        }),
      ],
    },
    {
      id: "provider-models",
      label: "Provider & Models",
      fields: [
        field("selectedProvider", "Selected provider", state.providerEditor.selectedProvider, {
          persistentPath: "desktop.ui.settings.providerEditor.selectedProvider",
          sourceKind: "local-ui-preference",
          control: "select",
          options: editorProviderOptions,
          requirement: "required",
          configurationMode: "fixed",
        }),
        field("profileId", "Profile ID", state.providerEditor.profileId, {
          requirement: "required",
          configurationMode: "freeform",
        }),
        field("apiKey", "API key", secretField.empty ? "" : "Configured", {
          persistentPath: `providers.${providerEditorProviderId}.api_key`,
          control: "password",
          inputValue: secretField.displayValue,
          requirement: "optional",
          configurationMode: "secret",
        }),
        field("apiBase", "API base", state.providerEditor.apiBase, {
          persistentPath: `providers.${providerEditorProviderId}.api_base`,
          validationField: "providerApiBase",
          requirement: "optional",
          configurationMode: "url",
          placeholder: "https://api.example.com/v1",
        }),
        field("models", "Models", parseDesktopProviderModelList(state.providerEditor.modelsText).join(", "), {
          persistentPath: `providers.profiles.${providerEditorProfileId}.models`,
          control: "textarea",
          inputValue: state.providerEditor.modelsText,
          requirement: "optional",
          configurationMode: "list",
          placeholder: "one-model-id-per-line",
        }),
      ],
    },
    {
      id: "knowledge",
      label: "Knowledge",
      fields: [
        field("enabled", "Enabled", state.knowledge.enabled, { control: "checkbox", disabled: false }),
        field("autoRetrieve", "Auto retrieve", state.knowledge.autoRetrieve, { control: "checkbox", disabled: knowledgeDisabled }),
        field("retrievalMode", "Retrieval mode", state.knowledge.retrievalMode, {
          control: "select",
          options: fixedOptions(["dense", "sparse", "hybrid"]),
          disabled: knowledgeDisabled,
        }),
        field("maxChunks", "Max chunks", state.knowledge.maxChunks, {
          control: "number",
          configurationMode: "numeric",
          disabled: knowledgeDisabled,
          min: 1,
          step: 1,
        }),
        field("chunkSize", "Chunk size", state.knowledge.chunkSize, {
          control: "number",
          configurationMode: "numeric",
          disabled: knowledgeDisabled,
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("chunkOverlap", "Chunk overlap", state.knowledge.chunkOverlap, {
          control: "number",
          configurationMode: "numeric",
          disabled: knowledgeDisabled,
          advanced: true,
          min: 0,
          step: 1,
        }),
        field("rerankEnabled", "Rerank", state.knowledge.rerankEnabled, { control: "checkbox", disabled: knowledgeDisabled, advanced: true }),
        field("rerankModel", "Rerank model", state.knowledge.rerankModel, { disabled: rerankDisabled, advanced: true }),
        field("rerankApiBase", "Rerank API base", state.knowledge.rerankApiBase, {
          validationField: "rerankApiBase",
          requirement: "optional",
          configurationMode: "url",
          disabled: rerankDisabled,
          advanced: true,
        }),
        field("rerankTopN", "Rerank top N", state.knowledge.rerankTopN, {
          control: "number",
          configurationMode: "numeric",
          disabled: rerankDisabled,
          advanced: true,
          min: 0,
          step: 1,
        }),
        field("graphExtractionEnabled", "Graph extraction", state.knowledge.graphExtractionEnabled, { control: "checkbox", disabled: knowledgeDisabled }),
        field("graphAutoExtract", "Auto extract graph", state.knowledge.graphAutoExtract, { control: "checkbox", disabled: graphExtractionDisabled, advanced: true }),
        field("graphExtractionModel", "Graph extraction model", state.knowledge.graphExtractionModel, {
          disabled: graphExtractionDisabled,
          advanced: true,
          placeholder: "defaults to semantic/chat model",
        }),
        field("graphExtractionMaxTokens", "Graph extraction max tokens", state.knowledge.graphExtractionMaxTokens, {
          control: "number",
          configurationMode: "numeric",
          disabled: graphExtractionDisabled,
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("graphExtractionMaxJobTokens", "Graph extraction max job tokens", state.knowledge.graphExtractionMaxJobTokens, {
          control: "number",
          configurationMode: "numeric",
          disabled: graphExtractionDisabled,
          advanced: true,
          min: 0,
          step: 1,
        }),
        field("graphExtractionConcurrency", "Graph extraction concurrency", state.knowledge.graphExtractionConcurrency, {
          control: "number",
          configurationMode: "numeric",
          disabled: graphExtractionDisabled,
          advanced: true,
          min: 1,
          step: 1,
        }),
      ],
    },
    {
      id: "tools-approvals",
      label: "Tools & Approvals",
      fields: [
        field("webEnable", "Web tools", state.tools.webEnable, { control: "checkbox" }),
        field("execEnable", "Exec tools", state.tools.execEnable, { control: "checkbox" }),
        field("webProxy", "Web proxy", state.tools.webProxy, {
          advanced: true,
          placeholder: "http://127.0.0.1:7890",
        }),
        field("searchProvider", "Search provider", state.tools.searchProvider, {
          control: "select",
          options: fixedOptions(["duckduckgo", "brave", "tavily", "searxng", "jina"]),
          advanced: true,
        }),
        field("execTimeout", "Exec timeout", state.tools.execTimeout, {
          control: "number",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
        }),
        field("restrictToWorkspace", "Restrict to workspace", state.tools.restrictToWorkspace, {
          control: "checkbox",
          advanced: true,
        }),
        field("mcpServers", "MCP servers", state.tools.mcpServersText ? "Configured" : "None", {
          validationField: "mcpServers",
          control: "textarea",
          inputValue: state.tools.mcpServersText,
          requirement: "optional",
          configurationMode: "json",
          advanced: true,
          placeholder: "{\"server\":{\"command\":\"npx\",\"args\":[]}}",
        }),
      ],
    },
    {
      id: "files-workspace",
      label: "Files & Workspace",
      fields: [
        field("workspace", "Workspace", state.agent.workspace, {
          requirement: "required",
          configurationMode: "freeform",
          placeholder: "~/.tinybot/workspace",
        }),
        field("sessionFiles", "Session files", buildWorkbenchFileScopeLabel("session").label, { control: "readonly" }),
        field("knowledgeDocuments", "Knowledge documents", buildWorkbenchFileScopeLabel("knowledge").label, { control: "readonly" }),
        field("workspaceFiles", "Workspace files", buildWorkbenchFileScopeLabel("workspace").label, { control: "readonly" }),
      ],
    },
    {
      id: "memory-experience",
      label: "Memory & Experience",
      fields: [
        field("memory", "Memory", "Managed by context and experience settings", { control: "readonly" }),
      ],
    },
    {
      id: "skills",
      label: "Skills",
      fields: [
        field("skills", "Skills", "Managed by Tools and Skills workbench", { control: "readonly" }),
      ],
    },
    {
      id: "channels",
      label: "Channels",
      fields: [
        field("sendProgress", "Progress events", state.channels.sendProgress, { control: "checkbox" }),
        field("sendToolHints", "Tool hints", state.channels.sendToolHints, { control: "checkbox" }),
        field("sendMaxRetries", "Max retries", state.channels.sendMaxRetries, {
          control: "number",
          configurationMode: "numeric",
          min: 0,
          max: 10,
          step: 1,
        }),
      ],
    },
    {
      id: "automations",
      label: "Automations",
      fields: [
        field("automations", "Automations", "Planned after core workbench stability", { control: "readonly" }),
      ],
    },
    {
      id: "gateway-runtime",
      label: "Gateway & Runtime",
      fields: [
        field("host", "Host", state.gateway.host, { requirement: "required", configurationMode: "freeform" }),
        field("port", "Port", state.gateway.port, {
          validationField: "gatewayPort",
          control: "number",
          requirement: "required",
          configurationMode: "numeric",
          min: 1,
          max: 65535,
          step: 1,
        }),
        field("heartbeat", "Heartbeat", state.gateway.heartbeatEnabled, { control: "checkbox" }),
        field("heartbeatIntervalS", "Heartbeat interval", state.gateway.heartbeatIntervalS, {
          control: "number",
          configurationMode: "numeric",
          advanced: true,
          disabled: !state.gateway.heartbeatEnabled,
          min: 1,
          step: 1,
        }),
      ],
    },
    {
      id: "logs-diagnostics",
      label: "Logs & Diagnostics",
      fields: [
        field("diagnostics", "Diagnostics", "Export diagnostics and inspect runtime logs", { control: "readonly" }),
      ],
    },
  ], state);
}

function enrichDesktopSettingsPaneGroups(
  groups: DesktopSettingsPaneGroup[],
  state: DesktopSettingsFormState,
): DesktopSettingsPaneGroup[] {
  return groups.map((group) => {
    const groupMetadata = getDesktopSettingsGroupMetadata(group.id);
    return {
      ...group,
      label: groupMetadata.label,
      description: groupMetadata.description,
      aliases: [...groupMetadata.aliases],
      i18nKey: groupMetadata.i18nKey,
      navigationArea: groupMetadata.navigationArea,
      navigationMode: groupMetadata.navigationMode,
      fields: group.fields.map((field) => enrichDesktopSettingsPaneField(state, group.id, field)),
    };
  });
}

function enrichDesktopSettingsPaneField(
  state: DesktopSettingsFormState,
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): DesktopSettingsPaneField {
  const metadata = getDesktopSettingsFieldMetadata(groupId, field.id);
  const persistence = resolveDesktopSettingsPaneFieldPersistence(state, groupId, field);
  if (!metadata) {
    return {
      ...field,
      aliases: field.aliases ?? [],
      i18nKey: field.i18nKey ?? `settings.fields.${groupId}.${field.id}`,
      ...persistence,
    };
  }
  return {
    ...field,
    ...persistence,
    label: metadata.label,
    description: metadata.description,
    aliases: [...metadata.aliases],
    i18nKey: metadata.i18nKey,
    validationField: metadata.validationField ?? field.validationField,
    sensitive: metadata.sensitive,
    applyEffect: metadata.applyEffect ?? persistence.applyEffect,
    unit: metadata.unit,
    recommendation: metadata.recommendation,
  };
}

function resolveDesktopSettingsPaneFieldPersistence(
  state: DesktopSettingsFormState,
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): Pick<DesktopSettingsPaneField, "persistentPath" | "sourceKind" | "valueOrigin" | "applyEffect"> {
  if (field.control === "readonly") {
    return {
      sourceKind: groupId === "logs-diagnostics" ? "runtime-status" : "config",
      valueOrigin: "runtime",
    };
  }
  const persistentPath = getDesktopSettingsPaneFieldPersistentPath(groupId, field);
  const sourceKind = field.sourceKind ?? (field.id === "selectedProvider" ? "local-ui-preference" : "config");
  return {
    ...(persistentPath ? { persistentPath } : {}),
    sourceKind,
    valueOrigin: field.valueOrigin ?? resolveDesktopSettingsValueOrigin(state, sourceKind, persistentPath, field),
    applyEffect: field.applyEffect ?? (sourceKind === "config" ? "immediate" : undefined),
  };
}

function resolveDesktopSettingsValueOrigin(
  state: DesktopSettingsFormState,
  sourceKind: DesktopSettingsPaneSourceKind,
  persistentPath: string | undefined,
  field: DesktopSettingsPaneField,
): DesktopSettingsPaneValueOrigin {
  if (field.sensitive || field.configurationMode === "secret") {
    return "secret";
  }
  if (sourceKind !== "config" || !persistentPath) {
    return "default";
  }
  return getDesktopSettingsExistingConfigPathValue(state.serverSnapshot, persistentPath) === undefined
    ? "default"
    : "explicit";
}

function getDesktopSettingsPaneFieldPersistentPath(
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): string | undefined {
  const key = `${groupId}.${field.id}`;
  const staticPaths: Record<string, string> = {
    "general.model": "agents.defaults.model",
    "general.provider": "agents.defaults.provider",
    "general.activeProfile": "agents.defaults.active_profile",
    "general.timezone": "agents.defaults.timezone",
    "general.temperature": "agents.defaults.temperature",
    "general.maxTokens": "agents.defaults.max_tokens",
    "general.contextWindowTokens": "agents.defaults.context_window_tokens",
    "general.maxToolIterations": "agents.defaults.max_tool_iterations",
    "general.reasoningEffort": "agents.defaults.reasoning_effort",
    "provider-models.selectedProvider": "desktop.ui.settings.providerEditor.selectedProvider",
    "provider-models.profileId": "agents.defaults.active_profile",
    "knowledge.enabled": "knowledge.enabled",
    "knowledge.autoRetrieve": "knowledge.auto_retrieve",
    "knowledge.retrievalMode": "knowledge.retrieval_mode",
    "knowledge.maxChunks": "knowledge.max_chunks",
    "knowledge.chunkSize": "knowledge.chunk_size",
    "knowledge.chunkOverlap": "knowledge.chunk_overlap",
    "knowledge.rerankEnabled": "knowledge.rerank_enabled",
    "knowledge.rerankModel": "knowledge.rerank_model",
    "knowledge.rerankApiBase": "knowledge.rerank_api_base",
    "knowledge.rerankTopN": "knowledge.rerank_top_n",
    "knowledge.graphExtractionEnabled": "knowledge.graph_extraction_enabled",
    "knowledge.graphAutoExtract": "knowledge.graph_auto_extract",
    "knowledge.graphExtractionModel": "knowledge.graph_extraction_model",
    "knowledge.graphExtractionMaxTokens": "knowledge.graph_extraction_max_tokens",
    "knowledge.graphExtractionMaxJobTokens": "knowledge.graph_extraction_max_job_tokens",
    "knowledge.graphExtractionConcurrency": "knowledge.graph_extraction_concurrency",
    "tools-approvals.webEnable": "tools.web.enable",
    "tools-approvals.execEnable": "tools.exec.enable",
    "tools-approvals.webProxy": "tools.web.proxy",
    "tools-approvals.searchProvider": "tools.web.search.provider",
    "tools-approvals.execTimeout": "tools.exec.timeout",
    "tools-approvals.restrictToWorkspace": "tools.restrict_to_workspace",
    "tools-approvals.mcpServers": "tools.mcp_servers",
    "files-workspace.workspace": "agents.defaults.workspace",
    "channels.sendProgress": "channels.send_progress",
    "channels.sendToolHints": "channels.send_tool_hints",
    "channels.sendMaxRetries": "channels.send_max_retries",
    "gateway-runtime.host": "gateway.host",
    "gateway-runtime.port": "gateway.port",
    "gateway-runtime.heartbeat": "gateway.heartbeat.enabled",
    "gateway-runtime.heartbeatIntervalS": "gateway.heartbeat.interval_s",
  };
  if (field.persistentPath) {
    return field.persistentPath;
  }
  return staticPaths[key];
}

function normalizeDesktopSettingsSaveDetails(
  details: DesktopSettingsPaneSaveDetails | null | undefined,
): DesktopSettingsPaneSaveDetails | null {
  if (!details) {
    return null;
  }
  return {
    transport: details.transport,
    updatedFields: [...details.updatedFields],
    applied: [...details.applied],
    restartRequired: [...details.restartRequired],
    reloadRequired: [...details.reloadRequired],
    warnings: [...details.warnings],
  };
}

function resolveDesktopSettingsSaveStatus(
  status: DesktopSettingsSaveStatus,
  saveDetails: DesktopSettingsPaneSaveDetails | null,
): DesktopSettingsSaveStatus {
  if (status !== "saved") {
    return status;
  }
  if (saveDetails?.restartRequired.length) {
    return "restart-required";
  }
  if (saveDetails?.reloadRequired.length) {
    return "reload-required";
  }
  return status;
}

function formatDesktopSettingsSaveMessage(
  status: DesktopSettingsSaveStatus,
  dirty: boolean,
  validationErrorCount = 0,
  saveDetails: DesktopSettingsPaneSaveDetails | null = null,
): string {
  if (status === "saving") {
    return "Saving settings";
  }
  if (status === "saved") {
    if (saveDetails?.transport === "gateway-fallback") {
      return "Settings saved through gateway fallback";
    }
    if (saveDetails?.warnings.length) {
      return "Settings saved with warnings";
    }
    return "Settings saved";
  }
  if (status === "restart-required") {
    return "Settings saved. Gateway restart required";
  }
  if (status === "reload-required") {
    return "Settings saved. Workspace reload required";
  }
  if (validationErrorCount > 0) {
    return `${validationErrorCount} ${validationErrorCount === 1 ? "setting needs" : "settings need"} attention`;
  }
  return dirty ? "Unsaved changes" : "No changes";
}

function formatDesktopSettingsSaveDiagnostics(
  status: DesktopSettingsSaveStatus,
  saveDetails: DesktopSettingsPaneSaveDetails | null,
): string {
  const rows = [`Status: ${status}`];
  if (!saveDetails) {
    return rows.join("\n");
  }
  rows.push(`Transport: ${saveDetails.transport}`);
  rows.push(`Updated fields: ${formatDiagnosticList(saveDetails.updatedFields)}`);
  rows.push(`Applied: ${formatDiagnosticList(saveDetails.applied)}`);
  rows.push(`Restart required: ${formatDiagnosticList(saveDetails.restartRequired)}`);
  rows.push(`Reload required: ${formatDiagnosticList(saveDetails.reloadRequired)}`);
  rows.push(`Warnings: ${formatDiagnosticList(saveDetails.warnings)}`);
  return rows.join("\n");
}

function formatDiagnosticList(values: string[]): string {
  return values.length ? values.join(", ") : "none";
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

function isRecordValue(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneDesktopSettingsSnapshot(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return value;
  }
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

function stringOrNullInput(value: string): string | null {
  const text = value.trim();
  return text ? text : null;
}

function numberOrNullInput(value: string): number | null {
  const text = value.trim();
  if (!text) {
    return null;
  }
  const numeric = Number.parseFloat(text);
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.parseFloat(stringValue(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function boolValue(value: unknown): boolean {
  return value === true;
}
