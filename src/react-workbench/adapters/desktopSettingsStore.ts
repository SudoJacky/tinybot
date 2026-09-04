import type { NativeConfigApi } from "../../app-core/native/desktopNativeConfig";
import {
  replaceDesktopConfigValue,
  type DesktopNativeConfigPatchResponse,
} from "../../app-core/native/desktopNativeConfigPatch";
import type { NativeWebuiRouteRequest } from "../../app-core/native/desktopNativeWebui";
import type { NativeWorkspaceApi } from "../../app-core/native/desktopNativeWorkspace";
import type { NativeTokenUsageApi } from "../../app-core/native/desktopNativeTokenUsage";
import {
  readDefaultChatModelPreference,
  writeDefaultChatModel,
} from "../../app-core/chat/chatModelPreference";
import { buildAgentDefaultsSettings } from "../../app-core/settings/agentDefaultsSettings";
import {
  buildDesktopProviderCatalogItems,
  buildDesktopSettingsFormState,
} from "../../app-core/settings/desktopSettingsProviders";
import { buildDesktopSettingsPaneModel } from "../../app-core/settings/desktopSettingsPaneModel";
import {
  buildProviderDefaultLlmPatch,
  buildProviderModelsSettings,
  normalizeProviderModelFetchResult,
  type ProviderModelsSettingsData,
} from "../../app-core/settings/providerModelsSettings";
import { saveDesktopSettingsConfig } from "../../app-core/settings/desktopSettingsSave";
import type {
  ChatModelOption,
  PersonalizationInstructionsData,
  SettingsStore,
} from "../services";

type NativeSettingsWebuiApi = {
  route(request: NativeWebuiRouteRequest): Promise<unknown>;
};

type NativeSettingsWorkspaceApi = Pick<NativeWorkspaceApi, "bootstrapFiles" | "putFile">;
type ApplyNativeConfigPatch = (
  currentConfig: unknown,
  patch: unknown,
) => Promise<DesktopNativeConfigPatchResponse>;

const PERSONALIZATION_INSTRUCTIONS_PATH = "USER.md" as const;

export function createDesktopSettingsStore({
  applyNativeConfigPatch,
  initialize,
  nativeConfig,
  nativeTokenUsage,
  nativeWebui,
  nativeWorkspace,
}: {
  applyNativeConfigPatch?: ApplyNativeConfigPatch;
  initialize: () => Promise<void>;
  nativeConfig?: NativeConfigApi;
  nativeTokenUsage?: NativeTokenUsageApi;
  nativeWebui?: NativeSettingsWebuiApi;
  nativeWorkspace?: NativeSettingsWorkspaceApi;
}): SettingsStore {
  async function loadSettingsSnapshot(): Promise<unknown> {
    return requireNative(nativeConfig, "Config").get();
  }

  async function loadProviderCatalog(): Promise<unknown[]> {
    const payload = await requireNative(nativeWebui, "WebUI").route({ method: "GET", path: "/api/providers" });
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload)) {
      const providers = payloadItems(payload, ["providers", "items", "catalog"]);
      return providers.length ? providers : [payload];
    }
    return [];
  }

  async function persistSettingsConfig(currentConfig: unknown, patch: unknown) {
    const result = await saveDesktopSettingsConfig(currentConfig, patch, { applyNativeConfigPatch });
    const savedConfig = result.persistedRevision && isRecord(result.config)
      ? { ...result.config, revision: result.persistedRevision }
      : result.config;
    return { result, savedConfig };
  }

  function resolveDefaultSelection(
    settings: ProviderModelsSettingsData,
    modelId: string,
    providerId = "",
  ): { modelId: string; profileId: string; providerId: string } | null {
    const model = modelId.trim();
    const provider = providerId.trim();
    if (!model) return null;
    const selectedProvider = settings.providers.find((candidate) => (
      candidate.enabled
      && (!provider || candidate.id === provider)
      && candidate.models.some((candidateModel) => candidateModel.enabled && candidateModel.id === model)
    ));
    return selectedProvider ? {
      modelId: model,
      profileId: selectedProvider.profileId,
      providerId: selectedProvider.id,
    } : null;
  }

  async function persistDefaultChatModel(
    input: { modelId: string; providerId: string },
    currentConfig?: unknown,
  ): Promise<{ savedConfig: unknown; settings: ProviderModelsSettingsData }> {
    const snapshot = currentConfig ?? await loadSettingsSnapshot();
    const currentSettings = buildProviderModelsSettings(snapshot);
    const selection = resolveDefaultSelection(currentSettings, input.modelId, input.providerId);
    if (!selection) {
      throw new Error(`Cannot set unavailable model '${input.modelId}' for Provider '${input.providerId}'.`);
    }
    const { savedConfig } = await persistSettingsConfig(snapshot, buildProviderDefaultLlmPatch({
      profileId: selection.profileId,
      model: selection.modelId,
    }));
    const settings = buildProviderModelsSettings(savedConfig);
    if (settings.activeProfileId !== selection.profileId || settings.agentDefaultModel !== selection.modelId) {
      throw new Error("Native default Provider/model persistence returned an inconsistent configuration.");
    }
    writeDefaultChatModel(selection.modelId, selection.providerId);
    return { savedConfig, settings };
  }

  async function reconcileDefaultChatModel(currentConfig: unknown): Promise<ProviderModelsSettingsData> {
    const settings = buildProviderModelsSettings(currentConfig);
    if (!settings.activeProfileId) return settings;

    const activeProvider = settings.providers.find((provider) => provider.profileId === settings.activeProfileId);
    const nativeSelection = activeProvider
      ? resolveDefaultSelection(settings, settings.agentDefaultModel ?? "", activeProvider.id)
      : null;
    if (nativeSelection) {
      writeDefaultChatModel(nativeSelection.modelId, nativeSelection.providerId);
      return settings;
    }

    const preference = readDefaultChatModelPreference();
    const preferredSelection = resolveDefaultSelection(
      settings,
      preference?.modelId ?? "",
      preference?.providerId ?? "",
    );
    const fallbackSelection = preferredSelection ?? (activeProvider?.defaultModel
      ? resolveDefaultSelection(settings, activeProvider.defaultModel, activeProvider.id)
      : null);
    if (!fallbackSelection) {
      throw new Error("Native default Provider/model configuration is inconsistent and no valid default model is available.");
    }

    const repaired = await persistDefaultChatModel({
      modelId: fallbackSelection.modelId,
      providerId: fallbackSelection.providerId,
    }, currentConfig);
    console.warn("[settings] default-model.reconciled", {
      previousModel: settings.agentDefaultModel,
      previousProfile: settings.activeProfileId,
      repairedModel: fallbackSelection.modelId,
      repairedProfile: fallbackSelection.profileId,
      source: preferredSelection ? "renderer_preference" : "active_profile_default",
    });
    return repaired.settings;
  }

  return {
    ...(nativeTokenUsage ? {
      async loadTokenUsage() {
        await initialize();
        return nativeTokenUsage.snapshot();
      },
    } : {}),
    async load() {
      await initialize();
      return normalizeSettingsSummary(await loadSettingsSnapshot());
    },
    async loadChatModels() {
      await initialize();
      const snapshot = await loadSettingsSnapshot();
      if (!isRecord(snapshot)) return [];
      const settings = await reconcileDefaultChatModel(snapshot);
      const providerCatalog = buildDesktopProviderCatalogItems(await loadProviderCatalog());
      return normalizeChatModelOptions(settings, providerCatalog);
    },
    async loadPersonalizationInstructions() {
      await initialize();
      const payload = await requireNative(nativeWorkspace, "Workspace")
        .bootstrapFiles([PERSONALIZATION_INSTRUCTIONS_PATH]);
      return normalizePersonalizationInstructions(payload);
    },
    async savePersonalizationInstructions(input) {
      await initialize();
      const body = {
        content: input.contents,
        ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
      };
      const payload = await requireNative(nativeWorkspace, "Workspace")
        .putFile(PERSONALIZATION_INSTRUCTIONS_PATH, body);
      return normalizePersonalizationWrite(payload, input.contents);
    },
    async loadDesktopConfigSettings() {
      await initialize();
      const currentConfig = await loadSettingsSnapshot();
      const providerCatalog = buildDesktopProviderCatalogItems(await loadProviderCatalog());
      const formState = buildDesktopSettingsFormState(currentConfig, providerCatalog);
      return {
        currentConfig,
        formState,
        pane: buildDesktopSettingsPaneModel(formState, { providerCatalog }),
      };
    },
    async saveDesktopConfigSettings(currentConfig, patch) {
      await initialize();
      const { result, savedConfig } = await persistSettingsConfig(currentConfig, patch);
      const providerCatalog = buildDesktopProviderCatalogItems(await loadProviderCatalog());
      const formState = buildDesktopSettingsFormState(savedConfig, providerCatalog);
      const saveDetails = {
        transport: result.transport,
        persistedRevision: result.persistedRevision,
        updatedFields: result.updatedFields,
        applied: result.applied,
        restartRequired: result.restartRequired,
        reloadRequired: result.reloadRequired,
        warnings: result.warnings,
      };
      return {
        currentConfig: savedConfig,
        formState,
        pane: buildDesktopSettingsPaneModel(formState, {
          providerCatalog,
          saveStatus: "saved",
          saveDetails,
        }),
        saveDetails,
      };
    },
    async createStreamableHttpMcpServer(input) {
      await initialize();
      const currentConfig = await loadSettingsSnapshot();
      const name = input.name.trim();
      if (configuredMcpServerExists(currentConfig, name)) {
        throw new Error(`MCP server '${name}' already exists.`);
      }
      const bearerToken = input.bearerToken?.trim();
      const headerNames = [...Object.keys(input.httpHeaders), ...Object.keys(input.envHttpHeaders)];
      if (bearerToken && headerNames.some((header) => header.toLocaleLowerCase() === "authorization")) {
        throw new Error("Configure either the bearer token or the Authorization header, not both.");
      }
      await persistSettingsConfig(currentConfig, {
        tools: {
          mcpServers: {
            [name]: replaceDesktopConfigValue({
              enabled: true,
              transport: "streamable-http",
              url: input.url.trim(),
              ...(bearerToken ? { bearerToken } : {}),
              ...(Object.keys(input.httpHeaders).length ? { httpHeaders: input.httpHeaders } : {}),
              ...(Object.keys(input.envHttpHeaders).length ? { envHttpHeaders: input.envHttpHeaders } : {}),
              enabledTools: ["*"],
            }),
          },
        },
      });
    },
    async loadProviderSettings() {
      await initialize();
      return buildProviderModelsSettings(await loadSettingsSnapshot());
    },
    async loadAgentDefaultsSettings() {
      await initialize();
      return buildAgentDefaultsSettings(await loadSettingsSnapshot());
    },
    async saveAgentDefaultsSettings(currentConfig, patch) {
      await initialize();
      const { savedConfig } = await persistSettingsConfig(currentConfig, patch);
      return buildAgentDefaultsSettings(savedConfig);
    },
    async saveDefaultChatModel(input) {
      await initialize();
      await persistDefaultChatModel(input);
    },
    async fetchProviderModels(input) {
      await initialize();
      if (input.modelDiscovery.status !== "openai-compatible") {
        return {
          ok: true,
          models: [],
          warning: "This provider uses a static model list.",
          url: null,
          error: null,
        };
      }
      const payload = await requireNative(nativeWebui, "WebUI").route({
        method: "POST",
        path: "/api/provider-models",
        body: {
          provider: input.providerId,
          profile: input.profileId,
          apiBase: input.apiBase,
          refreshLive: true,
        },
      });
      return normalizeProviderModelFetchResult(payload);
    },
    async saveProviderSettings(currentConfig, patch) {
      await initialize();
      const { savedConfig } = await persistSettingsConfig(currentConfig, patch);
      return buildProviderModelsSettings(savedConfig);
    },
  };
}

function configuredMcpServerExists(config: unknown, name: string): boolean {
  if (!name || !isRecord(config)) return false;
  const tools = isRecord(config.tools) ? config.tools : {};
  const mcp = isRecord(config.mcp) ? config.mcp : {};
  return [tools.mcpServers, tools.mcp_servers, mcp.servers]
    .some((servers) => isRecord(servers) && Object.prototype.hasOwnProperty.call(servers, name));
}

function normalizePersonalizationInstructions(payload: unknown): PersonalizationInstructionsData {
  if (!isRecord(payload)) {
    throw new Error("Personalization instructions response must be an object.");
  }
  const files = Array.isArray(payload.files) ? payload.files : [];
  const file = files.find((candidate) => (
    isRecord(candidate) && stringValue(candidate.path) === PERSONALIZATION_INSTRUCTIONS_PATH
  ));
  if (isRecord(file)) {
    if (typeof file.contents !== "string") {
      throw new Error("Personalization instructions response must include text contents.");
    }
    return {
      path: PERSONALIZATION_INSTRUCTIONS_PATH,
      contents: file.contents,
      ...(stringValue(file.updated_at ?? file.updatedAt)
        ? { updatedAt: stringValue(file.updated_at ?? file.updatedAt) }
        : {}),
    };
  }
  const missing = Array.isArray(payload.missing)
    ? payload.missing.filter((candidate): candidate is string => typeof candidate === "string")
    : [];
  if (missing.includes(PERSONALIZATION_INSTRUCTIONS_PATH)) {
    return { path: PERSONALIZATION_INSTRUCTIONS_PATH, contents: "" };
  }
  throw new Error("Personalization instructions response omitted USER.md.");
}

function normalizePersonalizationWrite(payload: unknown, contents: string): PersonalizationInstructionsData {
  if (!isRecord(payload) || stringValue(payload.path) !== PERSONALIZATION_INSTRUCTIONS_PATH) {
    throw new Error("Personalization save response must identify USER.md.");
  }
  const updatedAt = stringValue(payload.updated_at ?? payload.updatedAt);
  return {
    path: PERSONALIZATION_INSTRUCTIONS_PATH,
    contents,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function normalizeSettingsSummary(snapshot: unknown): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  if (!isRecord(snapshot)) return rows;
  const agents = isRecord(snapshot.agents) ? snapshot.agents : {};
  const defaults = isRecord(snapshot.defaults)
    ? snapshot.defaults
    : isRecord(agents.defaults)
      ? agents.defaults
      : agents;
  const model = stringValue(defaults.model ?? defaults.default_model ?? snapshot.model);
  if (model) rows.unshift({ label: "Default model", value: model });
  const providers = payloadItems(snapshot.providers ?? snapshot.llm_providers ?? snapshot.provider_configs, ["items"]);
  if (providers.length) rows.push({ label: "Providers", value: String(providers.length) });
  return rows;
}

function normalizeChatModelOptions(
  settings: ReturnType<typeof buildProviderModelsSettings>,
  providerCatalog: ReturnType<typeof buildDesktopProviderCatalogItems>,
): ChatModelOption[] {
  const defaultModel = stringValue(settings.agentDefaultModel);
  const defaultProviderId = stringValue(settings.agentDefaultProviderId)
    || settings.providers.find((provider) => provider.profileId === settings.activeProfileId)?.id
    || "";
  const defaultProvider = settings.providers.find((provider) => provider.id === defaultProviderId);
  const providers = settings.providers.filter((provider) => provider.enabled && (
    provider.status === "available"
    || providerCatalog.some((item) => item.id === provider.id && (
      item.apiKeyConfigured === true
      || ["available", "ready"].includes(stringValue(item.status).trim().toLowerCase())
    ))
  ));
  const options = new Map<string, ChatModelOption>();
  for (const provider of providers) {
    for (const model of provider.models.filter((model) => model.enabled)) {
      const optionKey = chatModelOptionKey(provider.id, model.id);
      if (!model.id || options.has(optionKey)) continue;
      const isDefault = provider.id === defaultProviderId && model.id === defaultModel;
      options.set(optionKey, {
        id: model.id,
        label: model.label,
        description: provider.label || provider.id || "Configured provider",
        providerId: provider.id,
        providerLabel: provider.label,
        supportsImageInput: model.supportsImageInput,
        ...(isDefault ? { default: true } : {}),
      });
    }
  }
  const defaultOptionKey = chatModelOptionKey(defaultProvider?.id || defaultProviderId, defaultModel);
  const configuredDefaultModel = defaultProvider?.models.find((model) => model.enabled && model.id === defaultModel);
  if (configuredDefaultModel && defaultProvider && providers.includes(defaultProvider) && !options.has(defaultOptionKey)) {
    options.set(defaultOptionKey, {
      id: defaultModel,
      label: defaultModel,
      description: defaultProvider?.label || "Default model",
      providerId: defaultProvider?.id || defaultProviderId,
      providerLabel: defaultProvider?.label,
      supportsImageInput: configuredDefaultModel.supportsImageInput,
      default: true,
    });
  }
  return [...options.values()].sort((left, right) => {
    if (left.default) return -1;
    if (right.default) return 1;
    return left.label.localeCompare(right.label);
  });
}

function chatModelOptionKey(providerId: string, modelId: string): string {
  return `${providerId}\u001f${modelId}`;
}

function requireNative<T>(value: T | undefined, capability: string): T {
  if (!value) throw new Error(`${capability} Native API is unavailable outside the Tauri runtime`);
  return value;
}

function payloadItems(payload: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
