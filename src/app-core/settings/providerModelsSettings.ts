export type ProviderModelDiscovery =
  | { status: "openai-compatible"; endpoint: "/models" }
  | { status: "static"; endpoint: null };

export type BuiltInProviderPreset = {
  id: "deepseek" | "dashscope" | "openai" | "zai" | "ollama";
  label: string;
  builtIn: true;
  defaultBaseUrl: string;
  defaultModels: string[];
  apiKeyRequired: boolean;
  supportsResponsesApi: boolean;
  modelDiscovery: ProviderModelDiscovery;
};

export type ProviderModelSource = "built-in" | "user" | "live";

export type ProviderModelItem = {
  id: string;
  label: string;
  source: ProviderModelSource;
  enabled: boolean;
  supportsImageInput: boolean;
};

export type ProviderCardStatus = "available" | "not_ready" | "not_configured";

export type ProviderCardModel = {
  id: string;
  label: string;
  builtIn: boolean;
  enabled: boolean;
  active: boolean;
  configured: boolean;
  status: ProviderCardStatus;
  statusLabel: string;
  profileId: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  apiKeyRequired: boolean;
  useResponsesApi: boolean;
  supportsResponsesApi: boolean;
  supportsReasoningEffort?: boolean;
  modelCount: number;
  defaultModel: string | null;
  models: ProviderModelItem[];
  modelContextWindows: Record<string, number>;
  modelDiscovery: ProviderModelDiscovery;
};

export type ProviderModelsSettingsData = {
  currentConfig: unknown;
  revision?: string;
  activeProfileId: string | null;
  agentDefaultProviderId: string | null;
  agentDefaultModel: string | null;
  fallbackContextWindowTokens: number;
  providers: ProviderCardModel[];
};

export type ProviderConfigurePatchInput = {
  providerId: string;
  profileId?: string | null;
  displayName?: string;
  apiBase: string;
  apiKey?: string;
  useResponsesApi?: boolean;
  supportsReasoningEffort?: boolean;
  defaultModel?: string | null;
  enabled?: boolean;
  activate?: boolean;
};

export type CustomProviderPatchInput = {
  providerId: string;
  profileId?: string | null;
  displayName: string;
  apiBase: string;
  apiKey?: string;
  useResponsesApi?: boolean;
  model: string;
  supportsModelDiscovery?: boolean;
  supportsReasoningEffort?: boolean;
  activate?: boolean;
};

export type ProviderModelsPatchInput = {
  providerId: string;
  profileId?: string | null;
  models: string[];
  enabledModels?: string[];
  defaultModel?: string | null;
  modelContextWindows?: Array<{ model: string; contextWindowTokens: number }>;
  modelCapabilities?: Array<{ model: string; inputModalities: string[] }>;
  setAgentDefault?: boolean;
};

export type ProviderDefaultLlmPatchInput = {
  profileId: string;
  model: string;
};

export type ProviderModelFetchInput = {
  providerId: string;
  profileId: string;
  apiBase: string;
  modelDiscovery: ProviderModelDiscovery;
};

export type ProviderModelFetchResult = {
  ok: boolean;
  models: string[];
  warning?: string | null;
  url?: string | null;
  error?: string | null;
};

type JsonRecord = Record<string, unknown>;

export const DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS = 128_000;

const BUILT_IN_MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  "deepseek-v4-flash": 1_000_000,
  "deepseek-v4-flash-vision-exp": 1_000_000,
  "deepseek-v4-pro": 1_000_000,
  "glm-5.3": 1_000_000,
  "glm-5.3-flash": 1_000_000,
};

const BUILT_IN_IMAGE_INPUT_MODELS = new Set([
  "deepseek-v4-flash-vision-exp",
  "glm-5.3-flash",
]);

export const BUILT_IN_PROVIDER_PRESETS: BuiltInProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    builtIn: true,
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    apiKeyRequired: true,
    supportsResponsesApi: true,
    modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
  },
  {
    id: "dashscope",
    label: "DashScope",
    builtIn: true,
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModels: ["qwen-plus", "qwen-max", "qwen-turbo"],
    apiKeyRequired: true,
    supportsResponsesApi: true,
    modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
  },
  {
    id: "openai",
    label: "OpenAI",
    builtIn: true,
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModels: ["gpt-4.1"],
    apiKeyRequired: true,
    supportsResponsesApi: true,
    modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
  },
  {
    id: "zai",
    label: "Z.ai",
    builtIn: true,
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModels: ["glm-5.3", "glm-5.3-flash", "glm-5.2"],
    apiKeyRequired: true,
    supportsResponsesApi: false,
    modelDiscovery: { status: "static", endpoint: null },
  },
  {
    id: "ollama",
    label: "Ollama",
    builtIn: true,
    defaultBaseUrl: "http://127.0.0.1:11434/v1",
    defaultModels: [],
    apiKeyRequired: false,
    supportsResponsesApi: true,
    modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
  },
];

export function buildProviderModelsSettings(config: unknown): ProviderModelsSettingsData {
  const root = asRecord(config);
  const defaults = asRecord(asRecord(root.agents).defaults);
  const providersRoot = asRecord(root.providers);
  const profiles = asRecord(providersRoot.profiles);
  const activeProfileId = stringOrNull(pick(defaults, "activeProfile", "active_profile"));
  const agentDefaultProviderId = stringOrNull(defaults.provider);
  const agentDefaultModel = stringOrNull(defaults.model);
  const configuredContextWindowFallback = Number(pick(defaults, "contextWindowTokens", "context_window_tokens"));
  const fallbackContextWindowTokens = Number.isSafeInteger(configuredContextWindowFallback)
    && configuredContextWindowFallback > 0
    ? configuredContextWindowFallback
    : DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS;

  const builtInProviders = BUILT_IN_PROVIDER_PRESETS.map((preset) => (
    buildProviderCard(preset, profiles, activeProfileId, agentDefaultModel)
  ));
  const builtInIds = new Set(BUILT_IN_PROVIDER_PRESETS.map((preset) => preset.id));
  const customProviders = Object.entries(profiles)
    .filter(([, value]) => {
      const providerId = stringValue(asRecord(value).provider);
      return providerId && !builtInIds.has(providerId as BuiltInProviderPreset["id"]);
    })
    .map(([profileId, value]) => buildCustomProviderCard(
      profileId,
      asRecord(value),
      activeProfileId,
      agentDefaultModel,
    ));

  return {
    currentConfig: config,
    revision: stringOrUndefined(root.revision) ?? stringOrUndefined(asRecord(root.configMetadata).revision),
    activeProfileId,
    agentDefaultProviderId,
    agentDefaultModel,
    fallbackContextWindowTokens,
    providers: [...builtInProviders, ...customProviders],
  };
}

export function buildProviderConfigurePatch(input: ProviderConfigurePatchInput): JsonRecord {
  const preset = presetForProvider(input.providerId);
  const profileId = resolveProviderProfileId(input.providerId, input.profileId);
  const defaultModel = input.defaultModel?.trim() || null;
  const profile: JsonRecord = {
    provider: input.providerId,
    displayName: input.displayName?.trim() || preset?.label || input.providerId,
    enabled: input.enabled ?? true,
    apiBase: input.apiBase.trim(),
  };
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    profile.apiKey = apiKey;
  }
  if (input.useResponsesApi !== undefined) {
    if (input.useResponsesApi && preset?.supportsResponsesApi === false) {
      throw new Error(`${preset.label} does not support Responses API.`);
    }
    profile.apiMode = input.useResponsesApi ? "responses" : "chat_completions";
  }
  if (input.supportsReasoningEffort !== undefined) {
    profile.supportsReasoningEffort = input.supportsReasoningEffort;
  }
  if (input.activate && !defaultModel) {
    throw new Error(`Cannot activate ${preset?.label || input.displayName?.trim() || input.providerId} without a default model.`);
  }
  return withOptionalAgentsPatch(input.activate ? {
    activeProfile: profileId,
    model: defaultModel,
  } : null, {
    providers: {
      profiles: {
        [profileId]: profile,
      },
    },
  });
}

export function buildCustomProviderPatch(input: CustomProviderPatchInput): JsonRecord {
  const providerId = input.providerId.trim();
  const profileId = resolveProviderProfileId(providerId, input.profileId);
  const model = input.model.trim();
  const profile: JsonRecord = {
    provider: providerId,
    displayName: input.displayName.trim(),
    enabled: true,
    apiBase: input.apiBase.trim(),
    models: model ? [model] : [],
    enabledModels: model ? [model] : [],
    supportsModelDiscovery: input.supportsModelDiscovery !== false,
    supportsReasoningEffort: input.supportsReasoningEffort !== false,
  };
  if (model) {
    profile.defaultModel = model;
  }
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    profile.apiKey = apiKey;
  }
  if (input.useResponsesApi !== undefined) {
    profile.apiMode = input.useResponsesApi ? "responses" : "chat_completions";
  }
  if (input.activate && !model) {
    throw new Error(`Cannot activate ${input.displayName.trim() || providerId} without a default model.`);
  }
  return withOptionalAgentsPatch(input.activate
    ? { activeProfile: profileId, model }
    : null, {
    providers: {
      profiles: {
        [profileId]: profile,
      },
    },
  });
}

export function buildProviderModelsPatch(input: ProviderModelsPatchInput): JsonRecord {
  const profileId = resolveProviderProfileId(input.providerId, input.profileId);
  const defaultModel = input.defaultModel?.trim() || null;
  const models = uniqueStrings(input.models);
  const modelIds = new Set(models);
  const profile: JsonRecord = {
    provider: input.providerId,
    models,
  };
  if (input.enabledModels !== undefined) {
    profile.enabledModels = uniqueStrings(input.enabledModels)
      .filter((model) => modelIds.has(model));
  }
  if (input.defaultModel !== undefined) {
    profile.defaultModel = defaultModel;
  }
  if (input.modelContextWindows !== undefined) {
    profile.modelContextWindows = uniqueModelContextWindows(input.modelContextWindows);
  }
  if (input.modelCapabilities !== undefined) {
    profile.modelCapabilities = uniqueModelCapabilities(input.modelCapabilities);
  }
  if (input.setAgentDefault && !defaultModel) {
    throw new Error(`Cannot set ${input.providerId} as the default provider without a default model.`);
  }
  return withOptionalAgentsPatch(input.setAgentDefault ? {
    activeProfile: profileId,
    model: defaultModel,
  } : null, {
    providers: {
      profiles: {
        [profileId]: profile,
      },
    },
  });
}

export function automaticModelContextWindow(
  model: string,
  fallbackTokens = DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
): { known: boolean; tokens: number } {
  const tokens = BUILT_IN_MODEL_CONTEXT_WINDOW_TOKENS[model.trim().toLowerCase()];
  return tokens
    ? { known: true, tokens }
    : { known: false, tokens: fallbackTokens };
}

export function automaticModelCapabilities(model: string): { supportsImageInput: boolean } {
  return {
    supportsImageInput: BUILT_IN_IMAGE_INPUT_MODELS.has(model.trim().toLowerCase()),
  };
}

export function buildProviderDefaultLlmPatch(input: ProviderDefaultLlmPatchInput): JsonRecord {
  return {
    agents: {
      defaults: {
        activeProfile: input.profileId,
        model: input.model,
      },
    },
  };
}

export function normalizeProviderModelFetchResult(payload: unknown): ProviderModelFetchResult {
  const record = asRecord(payload);
  return {
    ok: record.ok === true,
    models: parseModelList(record.models),
    warning: stringOrNull(record.warning),
    url: stringOrNull(record.url),
    error: stringOrNull(record.error),
  };
}

function buildProviderCard(
  preset: BuiltInProviderPreset,
  profiles: JsonRecord,
  activeProfileId: string | null,
  agentDefaultModel: string | null,
): ProviderCardModel {
  const matchedProfiles = Object.entries(profiles)
    .filter(([, profile]) => stringValue(asRecord(profile).provider) === preset.id);
  const activeProfile = activeProfileId
    ? matchedProfiles.find(([profileId]) => profileId === activeProfileId)
    : undefined;
  const profileEntry = activeProfile ?? matchedProfiles.find(([profileId]) => profileId === defaultProfileId(preset.id)) ?? matchedProfiles[0];
  const profileId = profileEntry?.[0] ?? defaultProfileId(preset.id);
  const profile = asRecord(profileEntry?.[1]);
  const configured = Boolean(profileEntry) || !preset.apiKeyRequired;
  const apiKeyConfigured = configured && hasConfiguredApiKey(profile);
  const enabled = pick(profile, "enabled") !== false;
  const manualModels = parseModelList(profile.models);
  const modelContextWindows = parseModelContextWindows(profile);
  const enabledModels = parseEnabledModels(
    profile,
    manualModels.length ? manualModels : preset.defaultModels,
  );
  const modelCapabilities = parseModelCapabilities(profile);
  const models = [
    ...preset.defaultModels.map((model) => ({ id: model, label: model, source: "built-in" as const })),
    ...manualModels
      .filter((model) => !preset.defaultModels.includes(model))
      .map((model) => ({ id: model, label: model, source: "user" as const })),
  ].map((model) => withModelConfiguration(model, enabledModels, modelCapabilities));
  const enabledModelItems = models.filter((model) => model.enabled);
  const configuredDefaultModel = stringOrNull(pick(profile, "defaultModel", "default_model"))
    ?? (activeProfileId === profileId ? agentDefaultModel : null)
    ?? null;
  const defaultModel = enabledModelItems.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : enabledModelItems[0]?.id ?? null;
  const status: ProviderCardStatus = !configured
    ? "not_configured"
    : (!preset.apiKeyRequired || apiKeyConfigured) && enabled && enabledModelItems.length > 0
      ? "available"
      : "not_ready";

  return {
    id: preset.id,
    label: preset.label,
    builtIn: preset.builtIn,
    enabled,
    active: activeProfileId === profileId,
    configured,
    status,
    statusLabel: statusLabel(status),
    profileId,
    baseUrl: stringValue(pick(profile, "apiBase", "api_base")) || preset.defaultBaseUrl,
    apiKeyConfigured,
    apiKeyRequired: preset.apiKeyRequired,
    useResponsesApi: preset.supportsResponsesApi && usesResponsesApi(profile),
    supportsResponsesApi: preset.supportsResponsesApi,
    modelCount: enabledModelItems.length,
    defaultModel,
    models,
    modelContextWindows,
    modelDiscovery: preset.modelDiscovery,
  };
}

function buildCustomProviderCard(
  profileId: string,
  profile: JsonRecord,
  activeProfileId: string | null,
  agentDefaultModel: string | null,
): ProviderCardModel {
  const providerId = stringValue(profile.provider) || profileId;
  const modelContextWindows = parseModelContextWindows(profile);
  const modelIds = parseModelList(profile.models);
  const enabledModels = parseEnabledModels(profile, modelIds);
  const modelCapabilities = parseModelCapabilities(profile);
  const models = modelIds.map((model) => withModelConfiguration({
    id: model,
    label: model,
    source: "user" as const,
  }, enabledModels, modelCapabilities));
  const enabledModelItems = models.filter((model) => model.enabled);
  const configuredDefaultModel = stringOrNull(pick(profile, "defaultModel", "default_model"))
    ?? (activeProfileId === profileId ? agentDefaultModel : null)
    ?? null;
  const defaultModel = enabledModelItems.some((model) => model.id === configuredDefaultModel)
    ? configuredDefaultModel
    : enabledModelItems[0]?.id ?? null;
  const enabled = profile.enabled !== false;
  const baseUrl = stringValue(pick(profile, "apiBase", "api_base"));
  const available = enabled && Boolean(baseUrl) && enabledModelItems.length > 0;
  const status: ProviderCardStatus = available ? "available" : "not_ready";
  const supportsModelDiscovery = pick(profile, "supportsModelDiscovery", "supports_model_discovery") !== false;
  const supportsReasoningEffort = pick(profile, "supportsReasoningEffort", "supports_reasoning_effort") !== false;

  return {
    id: providerId,
    label: stringValue(pick(profile, "displayName", "display_name")) || providerId,
    builtIn: false,
    enabled,
    active: activeProfileId === profileId,
    configured: true,
    status,
    statusLabel: statusLabel(status),
    profileId,
    baseUrl,
    apiKeyConfigured: hasConfiguredApiKey(profile),
    apiKeyRequired: false,
    useResponsesApi: usesResponsesApi(profile),
    supportsResponsesApi: true,
    supportsReasoningEffort,
    modelCount: enabledModelItems.length,
    defaultModel,
    models,
    modelContextWindows,
    modelDiscovery: supportsModelDiscovery
      ? { status: "openai-compatible", endpoint: "/models" }
      : { status: "static", endpoint: null },
  };
}

function withOptionalAgentsPatch(defaults: JsonRecord | null, patch: JsonRecord): JsonRecord {
  if (!defaults) {
    return patch;
  }
  return {
    agents: { defaults },
    ...patch,
  };
}

function statusLabel(status: ProviderCardStatus): string {
  if (status === "available") {
    return "Available";
  }
  if (status === "not_ready") {
    return "Not ready";
  }
  return "Not configured";
}

function presetForProvider(providerId: string): BuiltInProviderPreset | undefined {
  return BUILT_IN_PROVIDER_PRESETS.find((preset) => preset.id === providerId);
}

function resolveProviderProfileId(providerId: string, profileId?: string | null): string {
  const trimmed = profileId?.trim();
  return trimmed || defaultProfileId(providerId);
}

function defaultProfileId(providerId: string): string {
  return `${providerId}-default`;
}

function hasConfiguredApiKey(profile: JsonRecord): boolean {
  if (stringValue(pick(profile, "apiKey", "api_key"))) {
    return true;
  }
  return pick(profile, "apiKeyConfigured", "api_key_configured") === true;
}

function usesResponsesApi(profile: JsonRecord): boolean {
  return stringValue(pick(profile, "apiMode", "api_mode")).trim().toLowerCase() === "responses";
}

function parseModelList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  if (typeof value === "string") {
    return uniqueStrings(value.split(/\r?\n|,/));
  }
  return [];
}

function parseModelContextWindows(profile: JsonRecord): Record<string, number> {
  const entries = pick(profile, "modelContextWindows", "model_context_windows");
  if (!Array.isArray(entries)) {
    return {};
  }
  const windows: Record<string, number> = {};
  for (const value of entries) {
    const entry = asRecord(value);
    const model = stringValue(pick(entry, "model", "modelId", "model_id")).trim();
    const tokens = Number(pick(entry, "contextWindowTokens", "context_window_tokens"));
    if (model && Number.isSafeInteger(tokens) && tokens > 0) {
      windows[model] = tokens;
    }
  }
  return windows;
}

function parseEnabledModels(profile: JsonRecord, modelIds: string[]): Set<string> {
  const configured = pick(profile, "enabledModels", "enabled_models");
  if (configured === undefined) {
    return new Set(modelIds);
  }
  return new Set(parseModelList(configured));
}

function parseModelCapabilities(profile: JsonRecord): Map<string, { supportsImageInput: boolean }> {
  const entries = pick(profile, "modelCapabilities", "model_capabilities");
  const capabilities = new Map<string, { supportsImageInput: boolean }>();
  if (!Array.isArray(entries)) {
    return capabilities;
  }
  for (const value of entries) {
    const entry = asRecord(value);
    const model = stringValue(pick(entry, "model", "modelId", "model_id")).trim().toLowerCase();
    if (!model) {
      continue;
    }
    const inputModalities = parseModelList(pick(entry, "inputModalities", "input_modalities"))
      .map((modality) => modality.toLowerCase());
    capabilities.set(model, { supportsImageInput: inputModalities.includes("image") });
  }
  return capabilities;
}

function withModelConfiguration<T extends { id: string; label: string; source: ProviderModelSource }>(
  model: T,
  enabledModels: Set<string>,
  configuredCapabilities: Map<string, { supportsImageInput: boolean }>,
): T & Pick<ProviderModelItem, "enabled" | "supportsImageInput"> {
  const normalizedModel = model.id.trim().toLowerCase();
  return {
    ...model,
    enabled: enabledModels.has(model.id),
    supportsImageInput: configuredCapabilities.get(normalizedModel)?.supportsImageInput
      ?? automaticModelCapabilities(normalizedModel).supportsImageInput,
  };
}

function uniqueModelContextWindows(
  entries: Array<{ model: string; contextWindowTokens: number }>,
): Array<{ model: string; contextWindowTokens: number }> {
  const windows = new Map<string, number>();
  for (const entry of entries) {
    const model = entry.model.trim();
    if (model && Number.isSafeInteger(entry.contextWindowTokens) && entry.contextWindowTokens > 0) {
      windows.set(model, entry.contextWindowTokens);
    }
  }
  return [...windows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, contextWindowTokens]) => ({ model, contextWindowTokens }));
}

function uniqueModelCapabilities(
  entries: Array<{ model: string; inputModalities: string[] }>,
): Array<{ model: string; inputModalities: string[] }> {
  const capabilities = new Map<string, string[]>();
  for (const entry of entries) {
    const model = entry.model.trim();
    if (!model) {
      continue;
    }
    const inputModalities = uniqueStrings(entry.inputModalities.map((modality) => modality.toLowerCase()))
      .filter((modality) => modality === "image");
    const automatic = automaticModelCapabilities(model).supportsImageInput;
    if (inputModalities.includes("image") !== automatic) {
      capabilities.set(model, inputModalities);
    } else {
      capabilities.delete(model);
    }
  }
  return [...capabilities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, inputModalities]) => ({ model, inputModalities }));
}

function uniqueStrings(values: unknown[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = stringValue(value).trim();
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    result.push(text);
  }
  return result;
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}

function stringOrUndefined(value: unknown): string | undefined {
  return stringOrNull(value) ?? undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pick(record: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) {
      return record[key];
    }
  }
  return undefined;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : {};
}
