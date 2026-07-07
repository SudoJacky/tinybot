export type ProviderModelDiscovery =
  | { status: "openai-compatible"; endpoint: "/models" }
  | { status: "static"; endpoint: null };

export type BuiltInProviderPreset = {
  id: "deepseek" | "dashscope" | "openai";
  label: string;
  builtIn: true;
  defaultBaseUrl: string;
  defaultModels: string[];
  modelDiscovery: ProviderModelDiscovery;
};

export type ProviderModelSource = "built-in" | "user" | "live";

export type ProviderModelItem = {
  id: string;
  label: string;
  source: ProviderModelSource;
};

export type ProviderCardStatus = "available" | "not_ready" | "not_configured";

export type ProviderCardModel = {
  id: string;
  label: string;
  builtIn: boolean;
  active: boolean;
  configured: boolean;
  status: ProviderCardStatus;
  statusLabel: string;
  profileId: string;
  baseUrl: string;
  apiKeyConfigured: boolean;
  modelCount: number;
  defaultModel: string | null;
  models: ProviderModelItem[];
  modelDiscovery: ProviderModelDiscovery;
};

export type ProviderModelsSettingsData = {
  currentConfig: unknown;
  revision?: string;
  activeProfileId: string | null;
  agentDefaultModel: string | null;
  providers: ProviderCardModel[];
};

export type ProviderConfigurePatchInput = {
  providerId: string;
  profileId?: string | null;
  apiBase: string;
  apiKey?: string;
  enabled?: boolean;
  activate?: boolean;
};

export type ProviderModelsPatchInput = {
  providerId: string;
  profileId?: string | null;
  models: string[];
  defaultModel?: string | null;
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

export const BUILT_IN_PROVIDER_PRESETS: BuiltInProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    builtIn: true,
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModels: ["deepseek-v4-pro", "deepseek-v4-flash"],
    modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
  },
  {
    id: "dashscope",
    label: "DashScope",
    builtIn: true,
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModels: ["qwen-plus", "qwen-max", "qwen-turbo"],
    modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
  },
  {
    id: "openai",
    label: "OpenAI",
    builtIn: true,
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModels: ["gpt-4.1"],
    modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
  },
];

export function buildProviderModelsSettings(config: unknown): ProviderModelsSettingsData {
  const root = asRecord(config);
  const defaults = asRecord(asRecord(root.agents).defaults);
  const providersRoot = asRecord(root.providers);
  const profiles = asRecord(providersRoot.profiles);
  const activeProfileId = stringOrNull(pick(defaults, "activeProfile", "active_profile"));
  const agentDefaultModel = stringOrNull(defaults.model);

  return {
    currentConfig: config,
    revision: stringOrUndefined(root.revision) ?? stringOrUndefined(asRecord(root.configMetadata).revision),
    activeProfileId,
    agentDefaultModel,
    providers: BUILT_IN_PROVIDER_PRESETS.map((preset) => buildProviderCard(preset, profiles, activeProfileId, agentDefaultModel)),
  };
}

export function buildProviderConfigurePatch(input: ProviderConfigurePatchInput): JsonRecord {
  const preset = presetForProvider(input.providerId);
  const profileId = resolveProviderProfileId(input.providerId, input.profileId);
  const profile: JsonRecord = {
    provider: input.providerId,
    displayName: preset?.label ?? input.providerId,
    enabled: input.enabled ?? true,
    apiBase: input.apiBase.trim(),
  };
  const apiKey = input.apiKey?.trim();
  if (apiKey) {
    profile.apiKey = apiKey;
  }
  return withOptionalAgentsPatch(input.activate ? { activeProfile: profileId } : null, {
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
  const profile: JsonRecord = {
    provider: input.providerId,
    models: uniqueStrings(input.models),
  };
  if (defaultModel) {
    profile.defaultModel = defaultModel;
  }
  return withOptionalAgentsPatch(input.setAgentDefault && defaultModel ? { activeProfile: profileId, model: defaultModel } : null, {
    providers: {
      profiles: {
        [profileId]: profile,
      },
    },
  });
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
  const configured = Boolean(profileEntry);
  const apiKeyConfigured = configured && hasConfiguredApiKey(profile);
  const enabled = pick(profile, "enabled") !== false;
  const manualModels = parseModelList(profile.models);
  const builtInModels = preset.defaultModels.filter((model) => !manualModels.includes(model));
  const models = [
    ...preset.defaultModels.map((model) => ({ id: model, label: model, source: "built-in" as const })),
    ...manualModels
      .filter((model) => !preset.defaultModels.includes(model))
      .map((model) => ({ id: model, label: model, source: "user" as const })),
  ];
  const defaultModel = stringOrNull(pick(profile, "defaultModel", "default_model"))
    ?? (activeProfileId === profileId ? agentDefaultModel : null)
    ?? preset.defaultModels[0]
    ?? manualModels[0]
    ?? null;
  const status: ProviderCardStatus = !configured
    ? "not_configured"
    : apiKeyConfigured && enabled && (builtInModels.length + manualModels.length > 0)
      ? "available"
      : "not_ready";

  return {
    id: preset.id,
    label: preset.label,
    builtIn: preset.builtIn,
    active: activeProfileId === profileId,
    configured,
    status,
    statusLabel: statusLabel(status),
    profileId,
    baseUrl: stringValue(pick(profile, "apiBase", "api_base")) || preset.defaultBaseUrl,
    apiKeyConfigured,
    modelCount: models.length,
    defaultModel,
    models,
    modelDiscovery: preset.modelDiscovery,
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

function parseModelList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return uniqueStrings(value);
  }
  if (typeof value === "string") {
    return uniqueStrings(value.split(/\r?\n|,/));
  }
  return [];
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
