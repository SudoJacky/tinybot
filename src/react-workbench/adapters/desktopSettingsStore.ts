import type { NativeConfigApi } from "../../app-core/native/desktopNativeConfig";
import type { DesktopNativeConfigPatchResponse } from "../../app-core/native/desktopNativeConfigPatch";
import type { NativeWebuiRouteRequest } from "../../app-core/native/desktopNativeWebui";
import type { NativeWorkspaceApi } from "../../app-core/native/desktopNativeWorkspace";
import { buildAgentDefaultsSettings } from "../../app-core/settings/agentDefaultsSettings";
import {
  buildDesktopProviderCatalogItems,
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
} from "../../app-core/settings/desktopSettingsProviders";
import {
  buildProviderModelsSettings,
  normalizeProviderModelFetchResult,
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
  nativeWebui,
  nativeWorkspace,
}: {
  applyNativeConfigPatch?: ApplyNativeConfigPatch;
  initialize: () => Promise<void>;
  nativeConfig?: NativeConfigApi;
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

  return {
    async load() {
      await initialize();
      return normalizeSettingsSummary(await loadSettingsSnapshot());
    },
    async loadChatModels() {
      await initialize();
      const snapshot = await loadSettingsSnapshot();
      if (!isRecord(snapshot)) return [];
      const providerCatalog = buildDesktopProviderCatalogItems(await loadProviderCatalog());
      const state = buildDesktopSettingsFormState(snapshot, providerCatalog);
      return normalizeChatModelOptions(buildDesktopSettingsPaneModel(state, { providerCatalog }));
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
  pane: ReturnType<typeof buildDesktopSettingsPaneModel>,
): ChatModelOption[] {
  const defaultModel = stringValue(pane.defaultRouting?.model);
  const defaultProviderId = stringValue(pane.defaultRouting?.providerId);
  const defaultProvider = pane.providerCatalog.find((provider) => provider.id === defaultProviderId);
  const providers = pane.providerCatalog.filter((provider) => provider.enabled !== false);
  const options = new Map<string, ChatModelOption>();
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      const optionKey = chatModelOptionKey(provider.id, model);
      if (!model || options.has(optionKey)) continue;
      const isDefault = provider.id === defaultProviderId && model === defaultModel;
      options.set(optionKey, {
        id: model,
        label: model,
        description: provider.label || provider.id || "Configured provider",
        providerId: provider.id,
        providerLabel: provider.label,
        ...(isDefault ? { default: true } : {}),
      });
    }
  }
  const defaultOptionKey = chatModelOptionKey(defaultProvider?.id || defaultProviderId, defaultModel);
  if (defaultModel && !options.has(defaultOptionKey)) {
    options.set(defaultOptionKey, {
      id: defaultModel,
      label: defaultModel,
      description: defaultProvider?.label || pane.defaultRouting?.providerLabel || "Default model",
      providerId: defaultProvider?.id || defaultProviderId,
      providerLabel: defaultProvider?.label || pane.defaultRouting?.providerLabel,
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
