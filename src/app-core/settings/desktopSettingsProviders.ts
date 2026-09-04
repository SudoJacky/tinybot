import type {
  DesktopProviderCatalogItem,
  DesktopProviderModelApplyResult,
  DesktopProviderModelRequest,
  DesktopSettingsFormState,
  DesktopSettingsProviderSummary,
  DesktopSettingsValidationError,
} from "./desktopSettingsContracts";
import type { DesktopSettingsEditableValue } from "./desktopSettingsPaneContracts";
import {
  DESKTOP_SETTINGS_SECRET_MASK,
  parseDesktopProviderModelList,
  resolveDesktopSecretValue,
} from "./desktopSettingsValues";

type UnknownRecord = Record<string, unknown>;

export function buildDesktopSettingsFormState(
  config: unknown,
  providerCatalog: DesktopProviderCatalogItem[] = [],
): DesktopSettingsFormState {
  const root = asRecord(config);
  const defaults = asRecord(asRecord(root.agents).defaults);
  const embedding = asRecord(defaults.embedding);
  const tools = asRecord(root.tools);
  const web = asRecord(tools.web);
  const exec = asRecord(tools.exec);
  const channels = asRecord(root.channels);
  const providers = asRecord(root.providers);
  const activeProfile = stringValue(pick(defaults, "activeProfile", "active_profile"));
  const activeProfileProvider = stringValue(asRecord(getDesktopProviderProfiles(providers)[activeProfile]).provider);
  const configuredProvider = stringValue(pick(defaults, "provider"));
  const selectedProvider = activeProfileProvider || configuredProvider || null;
  const preliminaryDisplayProvider = selectedProvider || stringValue(providerCatalog[0]?.id);
  const preliminaryProfileId = activeProfile
    || (preliminaryDisplayProvider ? findDesktopProfileIdForProvider(providers, preliminaryDisplayProvider) : "");
  const providerSummaries = buildDesktopProviderSummaries(providers, providerCatalog, preliminaryDisplayProvider, preliminaryProfileId);
  const displayProvider = selectedProvider
    || providerSummaries.find((provider) => provider.enabled)?.id
    || providerSummaries[0]?.id
    || "";
  const profileId = activeProfile
    || (displayProvider ? findDesktopProfileIdForProvider(providers, displayProvider) : "");
  const providerProfile = getDesktopProviderProfileConfig(providers, profileId, displayProvider, providerCatalog);
  const providerProfileApiKey = stringValue(pick(providerProfile, "apiKey", "api_key"));
  const providerProfileApiKeyConfigured = providerProfileApiKey !== "" || hasDesktopProviderApiKeyConfigured(providerProfile);

  return {
    agent: {
      workspace: stringOrDefault(pick(defaults, "workspace", "workspacePath"), "~/.tinybot/workspace"),
      model: stringOrNull(pick(defaults, "model")),
      activeProfile: stringOrNull(pick(defaults, "activeProfile", "active_profile")),
      provider: selectedProvider,
      temperature: numberOrDefault(pick(defaults, "temperature"), 0.1),
      maxTokens: numberOrNull(pick(defaults, "maxTokens", "max_tokens")),
      contextWindowTokens: numberOrDefault(pick(defaults, "contextWindowTokens", "context_window_tokens"), 128000),
      contextWindowStrategy: stringOrDefault(pick(defaults, "contextWindowStrategy", "context_window_strategy"), "compact"),
      maxToolIterations: numberOrDefault(pick(defaults, "maxIterations", "max_iterations", "maxToolIterations", "max_tool_iterations"), 200),
      timezone: stringOrDefault(pick(defaults, "timezone"), "UTC"),
    },
    embedding: {
      provider: stringOrDefault(pick(embedding, "provider"), "openai"),
      modelName: stringOrDefault(pick(embedding, "modelName", "model_name"), "text-embedding-3-small"),
      apiKey: stringValue(pick(embedding, "apiKey", "api_key")),
      apiBase: stringOrNull(pick(embedding, "apiBase", "api_base")),
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
    channels: {
      sendProgress: boolValue(pick(channels, "sendProgress", "send_progress")),
      sendToolHints: boolValue(pick(channels, "sendToolHints", "send_tool_hints")),
      sendMaxRetries: numberOrDefault(pick(channels, "sendMaxRetries", "send_max_retries"), 3),
    },
    providerEditor: {
      selectedProvider: stringValue(providerProfile.provider) || displayProvider,
      profileId,
      apiKey: providerProfileApiKey || (providerProfileApiKeyConfigured ? DESKTOP_SETTINGS_SECRET_MASK : ""),
      apiKeyConfigured: providerProfileApiKeyConfigured,
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
    baseUrl: stringValue(pick(provider, "baseUrl", "base_url", "defaultApiBase", "default_api_base")),
    supportsModelDiscovery: pick(provider, "supportsModelDiscovery", "supports_model_discovery") !== false,
    ...(boolValue(pick(provider, "apiKeyConfigured", "api_key_configured"))
      ? { apiKeyConfigured: true }
      : {}),
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
    const rawApiKey = stringValue(pick(profile, "apiKey", "api_key")) || stringValue(pick(legacyProvider, "apiKey", "api_key"));
    const apiKeyConfigured = rawApiKey !== "" || hasDesktopProviderApiKeyConfigured(profile, legacyProvider);
    const apiKey = rawApiKey || (apiKeyConfigured ? DESKTOP_SETTINGS_SECRET_MASK : "");
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
      apiKeyConfigured,
      apiBase,
      modelsText: parseDesktopProviderModelList(models).join("\n"),
      supportsModelDiscovery: pick(profile, "supportsModelDiscovery", "supports_model_discovery") !== false
        && pick(legacyProvider, "supportsModelDiscovery", "supports_model_discovery") !== false
        && catalogProvider?.supportsModelDiscovery !== false,
      status,
      enabled,
      enabledConfigured,
    };
  });
}

export function validateDesktopSettingsForm(state: DesktopSettingsFormState): DesktopSettingsValidationError[] {
  const errors: DesktopSettingsValidationError[] = [];
  if (!state.agent.model?.trim()) {
    errors.push({ field: "model", errorKey: "modelEmpty" });
  }
  if (!validateDesktopTimezone(state.agent.timezone || "")) {
    errors.push({ field: "timezone", errorKey: "timezoneError" });
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
  return errors;
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
    case "contextWindowStrategy":
      nextState.agent.contextWindowStrategy = stringOrNullInput(text) || "compact";
      markDesktopSettingsTouched(nextState, "agents.defaults.context_window_strategy");
      break;
    case "maxToolIterations":
      nextState.agent.maxToolIterations = numberOrNullInput(text);
      markDesktopSettingsTouched(nextState, "agents.defaults.maxIterations");
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
      nextState.providerEditor.apiKeyConfigured = Boolean(nextState.providerEditor.apiKey);
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

function hasDesktopProviderApiKeyConfigured(...records: UnknownRecord[]): boolean {
  return records.some((record) => (
    boolValue(pick(record, "apiKeyConfigured", "api_key_configured"))
    || Boolean(stringValue(pick(record, "apiKey", "api_key")).trim())
  ));
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
    apiKeyConfigured: hasDesktopProviderApiKeyConfigured(legacyProvider),
    api_key_configured: hasDesktopProviderApiKeyConfigured(legacyProvider),
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
  if (/^(?:UTC|GMT)[+-](?:[0-9]|0[0-9]|1[0-4])(?::[0-5][0-9])?$/i.test(timezone)) {
    return true;
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

export function validateDesktopUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

export function validateDesktopJsonObject(value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function stringifyDesktopJsonObject(value: unknown): string {
  const record = asRecord(value);
  return Object.keys(record).length ? JSON.stringify(record, null, 2) : "";
}

function cloneSettingsState(state: DesktopSettingsFormState): DesktopSettingsFormState {
  return {
    agent: { ...state.agent },
    embedding: { ...state.embedding },
    tools: { ...state.tools },
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

function selectDesktopProviderEditor(state: DesktopSettingsFormState, providerId: string): void {
  const summary = state.providerSummaries.find((provider) => provider.id === providerId);
  state.providerEditor.selectedProvider = providerId;
  if (!summary) {
    state.providerEditor.profileId = providerId;
    state.providerEditor.apiKey = "";
    state.providerEditor.apiKeyConfigured = false;
    state.providerEditor.apiBase = null;
    state.providerEditor.modelsText = "";
    state.providerEditor.supportsModelDiscovery = true;
    state.providerSummaries.push({
      id: providerId,
      label: providerId,
      profileId: providerId,
      apiKey: "",
      apiKeyConfigured: false,
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
  state.providerEditor.apiKeyConfigured = summary.apiKeyConfigured;
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
      apiKeyConfigured: state.providerEditor.apiKeyConfigured,
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
  summary.apiKeyConfigured = state.providerEditor.apiKeyConfigured;
  summary.apiBase = state.providerEditor.apiBase;
  summary.modelsText = state.providerEditor.modelsText;
  summary.supportsModelDiscovery = state.providerEditor.supportsModelDiscovery;
}

function setDesktopProviderEnabled(state: DesktopSettingsFormState, providerId: string, enabled: boolean): void {
  const normalizedProviderId = providerId.trim();
  if (!normalizedProviderId) {
    return;
  }
  if (!enabled && state.agent.provider === normalizedProviderId) {
    return;
  }
  let summary = state.providerSummaries.find((provider) => provider.id === normalizedProviderId);
  if (!summary) {
    summary = {
      id: normalizedProviderId,
      label: normalizedProviderId,
      profileId: normalizedProviderId,
      apiKey: "",
      apiKeyConfigured: false,
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

function numberOrNull(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : Number.parseFloat(stringValue(value));
  return Number.isFinite(numeric) ? numeric : null;
}

function numberOrDefault(value: unknown, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number.parseFloat(stringValue(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

function boolValue(value: unknown): boolean {
  return value === true;
}
