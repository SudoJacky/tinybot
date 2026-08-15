import {
  getDesktopSettingsFieldBehaviorMetadata,
  getDesktopSettingsFieldMetadata,
  getDesktopSettingsGroupMetadata,
  type DesktopSettingsPaneApplyEffect,
  type DesktopSettingsPaneCommitMode,
  type DesktopSettingsPaneFieldConfirmation,
  type DesktopSettingsPaneGroupId,
  type DesktopSettingsPaneGroupMetadata,
} from "./desktopSettingsMetadata";
import type {
  DesktopProviderCatalogItem,
  DesktopProviderModelApplyResult,
  DesktopProviderModelRequest,
  DesktopSecretField,
  DesktopSettingsFormState,
  DesktopSettingsProviderEditorState,
  DesktopSettingsProviderSummary,
  DesktopSettingsSavePatchResult,
  DesktopSettingsSaveReconcileResult,
  DesktopSettingsValidationError,
  DesktopSettingsValidationField,
} from "./desktopSettingsContracts";

type DesktopWorkbenchFileScopeId = "session" | "workspace";

const WORKBENCH_FILE_SCOPE_LABELS: Record<DesktopWorkbenchFileScopeId, string> = {
  session: "Session file",
  workspace: "Workspace file",
};

function workbenchFileScopeLabel(scope: DesktopWorkbenchFileScopeId): string {
  return WORKBENCH_FILE_SCOPE_LABELS[scope];
}

export type DesktopSettingsSaveStatus = "idle" | "saving" | "saved" | "failed" | "restart-required" | "reload-required";
export type DesktopSettingsSaveTransport = "native";
export interface DesktopSettingsPaneSaveDetails {
  transport: DesktopSettingsSaveTransport;
  persistedRevision?: string;
  updatedFields: string[];
  applied: string[];
  restartRequired: string[];
  reloadRequired: string[];
  warnings: string[];
}
export type DesktopSettingsPaneFieldControl = "text" | "number" | "checkbox" | "textarea" | "select" | "password" | "readonly";
export type DesktopSettingsPaneFieldRequirement = "required" | "optional" | "readonly";
export type DesktopSettingsPaneSourceKind = "config" | "local-ui-preference" | "cache" | "runtime-status";
export type DesktopSettingsPaneValueOrigin = "explicit" | "default" | "environment" | "secret" | "cache" | "runtime" | "catalog";
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
export interface DesktopSettingsPaneFieldOption {
  value: string;
  label: string;
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
  commitMode?: DesktopSettingsPaneCommitMode;
  confirmation?: DesktopSettingsPaneFieldConfirmation;
  notice?: string;
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
    | "tools-mcp"
    | "files-workspace"
    | "skills"
    | "channels"
    | "automations"
    | "logs-diagnostics";
  label: string;
  description?: string;
  aliases?: string[];
  i18nKey?: string;
  navigationArea?: DesktopSettingsPaneGroupMetadata["navigationArea"];
  navigationMode?: DesktopSettingsPaneGroupMetadata["navigationMode"];
  fields: DesktopSettingsPaneField[];
}

export interface DesktopSettingsPaneModel {
  dirty: boolean;
  validationErrors: DesktopSettingsValidationError[];
  save: {
    status: DesktopSettingsSaveStatus;
    message: string;
    canSave: boolean;
    transport?: DesktopSettingsSaveTransport;
    persistedRevision?: string;
    updatedFields?: string[];
    applied?: string[];
    restartRequired?: string[];
    reloadRequired?: string[];
    warnings?: string[];
    diagnostics?: string;
  };
  diagnostics?: {
    runtimeSummary: string;
    runtimeOwnership: string;
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
  const embedding = asRecord(defaults.embedding);
  const tools = asRecord(root.tools);
  const web = asRecord(tools.web);
  const exec = asRecord(tools.exec);
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
  const providerProfileApiKey = stringValue(pick(providerProfile, "apiKey", "api_key"));
  const providerProfileApiKeyConfigured = providerProfileApiKey !== "" || hasDesktopProviderApiKeyConfigured(providerProfile);

  return {
    agent: {
      workspace: stringOrDefault(pick(defaults, "workspace", "workspacePath"), "~/.tinybot/workspace"),
      model: stringOrNull(pick(defaults, "model")),
      activeProfile: stringOrNull(pick(defaults, "activeProfile", "active_profile")),
      provider: selectedProvider,
      temperature: numberOrDefault(pick(defaults, "temperature"), 0.1),
      maxTokens: numberOrDefault(pick(defaults, "maxTokens", "max_tokens"), 8192),
      contextWindowTokens: numberOrDefault(pick(defaults, "contextWindowTokens", "context_window_tokens"), 128000),
      contextWindowStrategy: stringOrDefault(pick(defaults, "contextWindowStrategy", "context_window_strategy"), "discard"),
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
      apiKey: providerProfileApiKey || (providerProfileApiKeyConfigured ? MASKED_SECRET : ""),
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
    const rawApiKey = stringValue(pick(profile, "apiKey", "api_key")) || stringValue(pick(legacyProvider, "apiKey", "api_key"));
    const apiKeyConfigured = rawApiKey !== "" || hasDesktopProviderApiKeyConfigured(profile, legacyProvider);
    const apiKey = rawApiKey || (apiKeyConfigured ? MASKED_SECRET : "");
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
        context_window_strategy: state.agent.contextWindowStrategy,
        maxIterations: state.agent.maxToolIterations,
        timezone: state.agent.timezone,
        embedding: {
          provider: state.embedding.provider,
          model_name: state.embedding.modelName,
          api_key: state.embedding.apiKey || "",
          api_base: state.embedding.apiBase,
        },
      },
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
    case "agents.defaults.context_window_strategy":
      return state.agent.contextWindowStrategy;
    case "agents.defaults.maxIterations":
      return state.agent.maxToolIterations;
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
    save.persistedRevision = saveDetails.persistedRevision;
    save.updatedFields = saveDetails.updatedFields;
    save.applied = saveDetails.applied;
    save.restartRequired = saveDetails.restartRequired;
    save.reloadRequired = saveDetails.reloadRequired;
    save.warnings = saveDetails.warnings;
    save.diagnostics = formatDesktopSettingsSaveDiagnostics(saveStatus, saveDetails);
  }
  const diagnostics = buildDesktopSettingsDiagnosticsSummary(save);
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
  save: DesktopSettingsPaneModel["save"],
): NonNullable<DesktopSettingsPaneModel["diagnostics"]> {
  const saveStatus = `Settings save status: ${save.status}`;
  return {
    runtimeSummary: `Runtime summary: in-process Rust backend; ${saveStatus}.`,
    runtimeOwnership: "Runtime ownership: Tauri-managed native backend.",
    version: "Version: Current desktop build.",
    activeConfigPath: "Active config path: Managed by native runtime.",
    lastConfigError: save.status === "failed"
      ? `Last config error: ${save.message}`
      : "Last config error: None.",
    logLevel: "info",
  };
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
    case "contextWindowStrategy":
      nextState.agent.contextWindowStrategy = stringOrNullInput(text) || "discard";
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

export function buildDesktopSecretField(value: unknown, mask = MASKED_SECRET): DesktopSecretField {
  const raw = stringValue(value);
  return {
    value: raw,
    displayValue: raw ? mask : "",
    masked: Boolean(raw),
    empty: !raw,
  };
}

function hasDesktopProviderApiKeyConfigured(...records: UnknownRecord[]): boolean {
  return records.some((record) => (
    boolValue(pick(record, "apiKeyConfigured", "api_key_configured"))
    || Boolean(stringValue(pick(record, "apiKey", "api_key")).trim())
  ));
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
      apiKeyConfigured: summary?.apiKeyConfigured ?? Boolean(summary?.apiKey),
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
      apiKeyConfigured: isSelected ? state.providerEditor.apiKeyConfigured : false,
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
  const currentDefaultProvider = state.agent.provider && state.agent.provider !== "auto" ? state.agent.provider : "";
  const selectableProviderOptions = providerSummaries.filter((provider) => provider.enabled && isDesktopProviderDefaultSelectableStatus(provider.status)).map((provider) => ({
    value: provider.id,
    label: provider.label || provider.id,
  }));
  const agentProviderOptions = [
    { value: "auto", label: "Auto" },
    ...selectableProviderOptions,
  ];
  if (currentDefaultProvider && !agentProviderOptions.some((option) => option.value === currentDefaultProvider)) {
    const currentDefaultSummary = providerSummaries.find((provider) => provider.id === currentDefaultProvider);
    agentProviderOptions.push({
      value: currentDefaultProvider,
      label: currentDefaultSummary?.label || currentDefaultProvider,
    });
  }
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
      commitMode?: DesktopSettingsPaneCommitMode;
      confirmation?: DesktopSettingsPaneFieldConfirmation;
      notice?: string;
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
    commitMode: config.commitMode,
    confirmation: config.confirmation,
    notice: config.notice,
  });
  const secretField = buildDesktopSecretField(state.providerEditor.apiKey);
  const providerEditorProviderId = state.providerEditor.selectedProvider || "deepseek";
  const providerEditorProfileId = state.providerEditor.profileId || providerEditorProviderId;
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
        field("contextWindowStrategy", "Context window strategy", state.agent.contextWindowStrategy, {
          control: "select",
          options: fixedOptions(["discard", "compact"]),
          requirement: "optional",
          configurationMode: "fixed",
          advanced: true,
        }),
        field("maxToolIterations", "Max tool iterations", state.agent.maxToolIterations, {
          control: "number",
          requirement: "optional",
          configurationMode: "numeric",
          advanced: true,
          min: 1,
          step: 1,
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
          control: "readonly",
          requirement: "readonly",
          configurationMode: "readonly",
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
      id: "tools-mcp",
      label: "Tools & MCP",
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
        field("sessionFiles", "Session files", workbenchFileScopeLabel("session"), { control: "readonly" }),
        field("workspaceFiles", "Workspace files", workbenchFileScopeLabel("workspace"), { control: "readonly" }),
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
  const behavior = resolveDesktopSettingsFieldBehavior(groupId, field);
  const persistence = resolveDesktopSettingsPaneFieldPersistence(state, groupId, field);
  if (!metadata) {
    return {
      ...field,
      aliases: field.aliases ?? [],
      i18nKey: field.i18nKey ?? `settings.fields.${groupId}.${field.id}`,
      ...persistence,
      ...behavior,
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
    commitMode: metadata.commitMode ?? behavior.commitMode,
    confirmation: metadata.confirmation ?? behavior.confirmation,
    notice: metadata.notice ?? behavior.notice,
  };
}

function resolveDesktopSettingsFieldBehavior(
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): Pick<DesktopSettingsPaneField, "commitMode" | "confirmation" | "notice"> {
  const metadata = getDesktopSettingsFieldBehaviorMetadata(groupId, field.id);
  return {
    commitMode: field.commitMode ?? metadata.commitMode,
    confirmation: field.confirmation ?? metadata.confirmation,
    notice: field.notice ?? metadata.notice,
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
  const metadataOrigin = getDesktopSettingsMetadataValueOrigin(state.serverSnapshot, persistentPath);
  if (metadataOrigin) {
    return metadataOrigin;
  }
  return getDesktopSettingsExistingConfigPathValue(state.serverSnapshot, persistentPath) === undefined
    ? "default"
    : "explicit";
}

function getDesktopSettingsMetadataValueOrigin(
  existingConfig: unknown,
  persistentPath: string,
): DesktopSettingsPaneValueOrigin | null {
  const metadata = asRecord(asRecord(existingConfig).configMetadata);
  const origins = asRecord(metadata.origins);
  const origin = stringValue(origins[persistentPath]);
  switch (origin) {
    case "file":
      return "explicit";
    case "default":
      return "default";
    case "environment":
    case "env":
      return "environment";
    case "secret-store":
      return "secret";
    case "runtime":
      return "runtime";
    case "catalog":
      return "catalog";
    default:
      return null;
  }
}

function getDesktopSettingsPaneFieldPersistentPath(
  groupId: DesktopSettingsPaneGroupId,
  field: DesktopSettingsPaneField,
): string | undefined {
  const key = `${groupId}.${field.id}`;
  const staticPaths: Record<string, string> = {
    "general.model": "agents.defaults.model",
    "general.provider": "agents.defaults.provider",
    "general.activeProfile": "agents.defaults.activeProfile",
    "general.timezone": "agents.defaults.timezone",
    "general.temperature": "agents.defaults.temperature",
    "general.maxTokens": "agents.defaults.maxTokens",
    "general.contextWindowTokens": "agents.defaults.contextWindowTokens",
    "general.contextWindowStrategy": "agents.defaults.contextWindowStrategy",
    "general.maxToolIterations": "agents.defaults.maxIterations",
    "provider-models.selectedProvider": "desktop.ui.settings.providerEditor.selectedProvider",
    "provider-models.profileId": "agents.defaults.activeProfile",
    "tools-mcp.webEnable": "tools.web.enable",
    "tools-mcp.execEnable": "tools.exec.enable",
    "tools-mcp.webProxy": "tools.web.proxy",
    "tools-mcp.searchProvider": "tools.web.search.provider",
    "tools-mcp.execTimeout": "tools.exec.timeout",
    "tools-mcp.restrictToWorkspace": "tools.restrictToWorkspace",
    "tools-mcp.mcpServers": "tools.mcpServers",
    "files-workspace.workspace": "agents.defaults.workspace",
    "channels.sendProgress": "channels.sendProgress",
    "channels.sendToolHints": "channels.sendToolHints",
    "channels.sendMaxRetries": "channels.sendMaxRetries",
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
    persistedRevision: details.persistedRevision,
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
    if (saveDetails?.warnings.length) {
      return "Settings persisted with warnings";
    }
    if (saveDetails && !saveDetails.applied.length && saveDetails.updatedFields.length) {
      return "Settings persisted. Runtime not applied yet";
    }
    return "Settings persisted";
  }
  if (status === "restart-required") {
    return "Settings persisted. Application restart required";
  }
  if (status === "reload-required") {
    return "Settings persisted. Workspace reload required";
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
  if (saveDetails.persistedRevision) {
    rows.push(`Persisted revision: ${saveDetails.persistedRevision}`);
  }
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
