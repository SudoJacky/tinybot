import {
  findCatalogEntry,
  inferProviderFromModel,
  isLocalProvider,
  listCatalogEntries,
  type ApiMode,
  type ProviderCatalogEntry,
  type RequestTraits,
} from "./providerCatalog.ts";
import { selectProviderConfig, selectProviderRuntimeInput } from "../config/configSelectors.ts";
import { parseTinybotConfig } from "../config/configSchema.ts";
import type { TinybotConfig } from "../config/configTypes.ts";

export type TinybotPublicConfig = Record<string, unknown>;

export type ProviderSecretResolution = {
  apiKey?: string;
  apiKeySource?: "config" | `env:${string}`;
};

export type ProviderSecretResolver = (input: {
  providerId: string;
  profileName?: string;
  apiKeyEnvVars: string[];
}) => Promise<ProviderSecretResolution | undefined> | ProviderSecretResolution | undefined;

export type ResolveRuntimeProviderInput = {
  config: TinybotPublicConfig;
  env: Record<string, string | undefined>;
  secretResolver?: ProviderSecretResolver;
  model?: string;
  provider?: string;
};

export type ResolvedRuntimeProvider = {
  providerId?: string;
  model: string;
  profileName?: string;
  source: "explicit" | "profile" | "model" | "credentials" | "unresolved";
  apiMode?: ApiMode;
  apiKey?: string;
  apiKeySource?: "config" | `env:${string}`;
  apiBase?: string;
  models: string[];
  manualModelIds: string[];
  supportsModelDiscovery: boolean;
  requestTraits: RequestTraits;
  extraBody: Record<string, unknown>;
  warnings: string[];
};

export async function resolveRuntimeProvider(input: ResolveRuntimeProviderInput): Promise<ResolvedRuntimeProvider> {
  const config = parseTinybotConfig(input.config);
  const configuredModel = input.model?.trim() || stringAt(input.config, "agents.defaults.model");
  const runtimeInput = selectProviderRuntimeInput(config, configuredModel);
  const selectedModel = configuredModel || "gpt-4.1-mini";

  const explicitOverride = normalizeProviderId(input.provider);
  if (explicitOverride && explicitOverride !== "auto") {
    return resolveEntry(input, config, explicitOverride, selectedModel, "explicit");
  }

  if (runtimeInput.source === "profile" && runtimeInput.activeProfile) {
    return resolveEntry(
      input,
      config,
      normalizeProviderId(runtimeInput.providerId),
      selectedModel,
      "profile",
      runtimeInput.activeProfile,
      runtimeInput.providerConfig,
    );
  }

  const explicitProvider = normalizeProviderId(runtimeInput.providerId);
  if (runtimeInput.source === "explicit" && explicitProvider) {
    return resolveEntry(input, config, explicitProvider, selectedModel, "explicit", undefined, runtimeInput.providerConfig);
  }

  const inferred = configuredModel ? inferProviderFromModel(configuredModel) : undefined;
  if (inferred) {
    return resolveEntry(input, config, inferred.id, selectedModel, "model");
  }

  for (const catalogEntry of listCatalogEntries()) {
    if (await hasUsableConfig(input, config, catalogEntry)) {
      return resolveEntry(input, config, catalogEntry.id, selectedModel, "credentials");
    }
  }

  return unresolved(selectedModel);
}

async function resolveEntry(
  input: ResolveRuntimeProviderInput,
  config: TinybotConfig,
  providerId: string | undefined,
  model: string,
  source: ResolvedRuntimeProvider["source"],
  profileName?: string,
  explicitProviderConfig?: Record<string, unknown>,
): Promise<ResolvedRuntimeProvider> {
  const catalog = findCatalogEntry(providerId);
  const normalizedId = catalog?.id ?? providerId;
  if (!normalizedId) {
    return unresolved(model);
  }
  const providerConfig = explicitProviderConfig ?? selectProviderConfig(config, normalizedId);
  const secret = await configuredOrResolvedOrEnvKey(input, providerConfig, catalog, normalizedId, profileName);
  return {
    providerId: normalizedId,
    model,
    profileName,
    source,
    apiMode: catalog?.apiMode,
    apiKey: secret.apiKey,
    apiKeySource: secret.apiKeySource,
    apiBase: stringValue(field(providerConfig, "api_base", "apiBase")) ?? envApiBase(input.env, catalog) ?? catalog?.defaultApiBase,
    models: stringList(field(providerConfig, "models")),
    manualModelIds: stringList(field(providerConfig, "manual_models", "manualModels")),
    supportsModelDiscovery: booleanValue(field(providerConfig, "supports_model_discovery", "supportsModelDiscovery")) ?? catalog?.supportsModelDiscovery ?? true,
    requestTraits: catalog?.requestTraits ?? {
      tokenParameter: "max_tokens",
      temperaturePolicy: "standard",
      stripModelPrefix: false,
      extraBodyDefaults: {},
      supportsPromptCaching: false,
    },
    extraBody: recordValue(field(providerConfig, "extra_body", "extraBody")) ?? {},
    warnings: [],
  };
}

async function hasUsableConfig(input: ResolveRuntimeProviderInput, config: TinybotConfig, catalog: ProviderCatalogEntry): Promise<boolean> {
  const providerConfig = selectProviderConfig(config, catalog.id);
  if (stringValue(field(providerConfig, "api_key", "apiKey")) || stringValue(field(providerConfig, "api_base", "apiBase")) || isLocalProvider(catalog)) {
    return true;
  }
  const secret = await configuredOrResolvedOrEnvKey(input, providerConfig, catalog, catalog.id);
  return Boolean(secret.apiKey || isLocalProvider(catalog));
}

async function configuredOrResolvedOrEnvKey(
  input: ResolveRuntimeProviderInput,
  providerConfig: Record<string, unknown> | undefined,
  catalog: ProviderCatalogEntry | undefined,
  providerId: string,
  profileName?: string,
): Promise<ProviderSecretResolution> {
  const configured = stringValue(field(providerConfig, "api_key", "apiKey"));
  if (configured) {
    return { apiKey: configured, apiKeySource: "config" };
  }
  if (input.secretResolver && catalog) {
    const resolved = await input.secretResolver({ providerId, profileName, apiKeyEnvVars: catalog.apiKeyEnvVars });
    if (resolved?.apiKey) {
      return resolved;
    }
  }
  return envApiKey(input.env, catalog);
}

function unresolved(model: string): ResolvedRuntimeProvider {
  return {
    model,
    source: "unresolved",
    models: [],
    manualModelIds: [],
    supportsModelDiscovery: true,
    requestTraits: {
      tokenParameter: "max_tokens",
      temperaturePolicy: "standard",
      stripModelPrefix: false,
      extraBodyDefaults: {},
      supportsPromptCaching: false,
    },
    extraBody: {},
    warnings: [],
  };
}

function normalizeProviderId(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) {
    return undefined;
  }
  const catalog = findCatalogEntry(text);
  if (catalog) {
    return catalog.id;
  }
  return text.trim().toLowerCase().replace(/[-\s]+/g, "_") || undefined;
}

function stringAt(config: TinybotPublicConfig, dottedPath: string): string | undefined {
  return stringValue(pathValue(config, dottedPath.split(".")));
}

function pathValue(config: TinybotPublicConfig, segments: string[]): unknown {
  let current: unknown = config;
  for (const segment of segments) {
    const object = recordValue(current);
    if (!object) {
      return undefined;
    }
    current = object[segment];
  }
  return current;
}

function field(object: Record<string, unknown> | undefined, ...names: string[]): unknown {
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.replace(/\n/g, ",").split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return [];
}

function envApiKey(env: Record<string, string | undefined>, catalog: ProviderCatalogEntry | undefined): ProviderSecretResolution {
  for (const envName of catalog?.apiKeyEnvVars ?? []) {
    const value = env[envName];
    if (value) {
      return { apiKey: value, apiKeySource: `env:${envName}` };
    }
  }
  return {};
}

function envApiBase(env: Record<string, string | undefined>, catalog: ProviderCatalogEntry | undefined): string | undefined {
  for (const envName of catalog?.apiBaseEnvVars ?? []) {
    const value = env[envName];
    if (value) {
      return value;
    }
  }
  return undefined;
}
