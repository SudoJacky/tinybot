import type {
  DesktopProviderCatalogItem,
  DesktopSettingsFormState,
  DesktopSettingsProviderEditorState,
  DesktopSettingsSavePatchResult,
  DesktopSettingsSaveReconcileResult,
} from "./desktopSettingsContracts";
import {
  buildDesktopSettingsFormState,
  getDesktopProviderProfiles,
  validateDesktopSettingsForm,
} from "./desktopSettingsProviders";
import { parseDesktopProviderModelList } from "./desktopSettingsValues";

type UnknownRecord = Record<string, unknown>;

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

export function isDesktopSettingsDraftDirty(
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

function asRecord(value: unknown): UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function isRecordValue(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  const text = stringValue(value).trim();
  return text ? text : null;
}
