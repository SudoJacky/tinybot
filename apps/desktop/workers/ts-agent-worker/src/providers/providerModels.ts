import {
  findCatalogEntry,
  inferProviderFromModel,
  isCustomProvider,
  isGatewayProvider,
  isLocalProvider,
} from "./providerCatalog.ts";
import { joinModelsUrl, type ModelDiscoveryResult } from "./modelDiscovery.ts";

export type ProviderModelSource = "curated" | "profile" | "live" | "manual";

export type ProviderModel = {
  id: string;
  sources: ProviderModelSource[];
};

export type ProviderModelList = {
  ok: boolean;
  models: ProviderModel[];
  sourceCounts: Record<ProviderModelSource, number>;
  warning?: string;
  url?: string;
};

export type ListProviderModelsInput = {
  providerId: string;
  profileModels?: string[];
  manualModelIds?: string[];
  liveModelIds?: string[];
  supportsModelDiscovery?: boolean;
  apiKey?: string;
  apiBase?: string;
  refreshLive?: boolean;
  fetcher?: (url: string, headers: Record<string, string>) => Promise<string[]>;
  discoverer?: (input: {
    apiBase: string | undefined;
    headers: Record<string, string>;
    providerId: string;
  }) => Promise<ModelDiscoveryResult>;
};

export type ModelValidationResult = {
  ok: boolean;
  message?: string;
};

export async function listProviderModels(input: ListProviderModelsInput): Promise<ProviderModelList> {
  const catalog = findCatalogEntry(input.providerId);
  const merged = new Map<string, ProviderModelSource[]>();
  const sourceCounts: Record<ProviderModelSource, number> = { curated: 0, profile: 0, live: 0, manual: 0 };

  addModels(merged, sourceCounts, "curated", catalog?.curatedModelIds ?? []);
  addModels(merged, sourceCounts, "profile", input.profileModels ?? []);
  addModels(merged, sourceCounts, "manual", input.manualModelIds ?? []);

  let warning: string | undefined;
  let modelsUrl = joinModelsUrl(input.apiBase);
  if (input.refreshLive) {
    const allowed = liveDiscoveryAllowed({
      supportsModelDiscovery: input.supportsModelDiscovery ?? catalog?.supportsModelDiscovery ?? true,
      apiKey: input.apiKey,
      apiBase: input.apiBase,
      keyRequired: Boolean(catalog?.apiKeyEnvVars.length && !isLocalProvider(catalog)),
    });
    if (allowed.ok) {
      try {
        const headers = modelRequestHeaders(input.apiKey);
        let liveModels = input.liveModelIds;
        if (!liveModels && input.discoverer) {
          const discovery = await input.discoverer({
            apiBase: input.apiBase,
            headers,
            providerId: catalog?.id ?? input.providerId,
          });
          liveModels = discovery.models;
          modelsUrl = discovery.url;
          if (discovery.suggestedApiBase) {
            warning = `live discovery used fallback base URL: ${discovery.suggestedApiBase}`;
          }
        }
        liveModels ??= (await input.fetcher?.(modelsUrl, headers)) ?? [];
        addModels(merged, sourceCounts, "live", liveModels);
      } catch (error) {
        warning = `live discovery failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      warning = allowed.warning;
    }
  }

  const models = Array.from(merged.entries()).map(([id, sources]) => ({ id, sources }));
  return {
    ok: models.length > 0,
    models,
    sourceCounts,
    warning,
    url: modelsUrl || undefined,
  };
}

export function validateModelForProvider(input: { providerId: string; model: string }): ModelValidationResult {
  const catalog = findCatalogEntry(input.providerId);
  const inferred = inferProviderFromModel(input.model);
  if (catalog && inferred && inferred.id !== catalog.id) {
    if (isCustomProvider(catalog) || isLocalProvider(catalog) || isGatewayProvider(catalog)) {
      return { ok: true };
    }
    return {
      ok: false,
      message: `Model '${input.model}' appears to belong to provider '${inferred.id}', not '${catalog.id}'.`,
    };
  }
  return { ok: true };
}

function addModels(
  merged: Map<string, ProviderModelSource[]>,
  sourceCounts: Record<ProviderModelSource, number>,
  source: ProviderModelSource,
  modelIds: string[],
): void {
  for (const rawModelId of modelIds) {
    const modelId = String(rawModelId).trim();
    if (!modelId) {
      continue;
    }
    const sources = merged.get(modelId) ?? [];
    if (sources.includes(source)) {
      continue;
    }
    sources.push(source);
    if (!merged.has(modelId)) {
      sourceCounts[source] += 1;
    }
    merged.set(modelId, sources);
  }
}

function liveDiscoveryAllowed(input: {
  supportsModelDiscovery: boolean;
  apiKey?: string;
  apiBase?: string;
  keyRequired: boolean;
}): { ok: true } | { ok: false; warning?: string } {
  if (!input.supportsModelDiscovery) {
    return { ok: false };
  }
  if (!input.apiBase) {
    return { ok: false, warning: "live discovery skipped: api_base is required" };
  }
  if (input.keyRequired && !input.apiKey) {
    return { ok: false, warning: "live discovery skipped: api key is required" };
  }
  return { ok: true };
}

function modelRequestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": "tinybot/provider-model-discovery",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}
