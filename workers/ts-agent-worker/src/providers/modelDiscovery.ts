export type CandidateModelEndpoint = {
  url: string;
  resolvedApiBase: string;
  usedFallback: boolean;
};

export type ModelDiscoveryResult = {
  models: string[];
  url: string;
  resolvedApiBase: string;
  suggestedApiBase?: string;
  usedFallback: boolean;
};

export type JsonFetcher = (url: string, headers: Record<string, string>) => Promise<unknown>;

export function joinModelsUrl(apiBase: string | undefined): string {
  const base = apiBase?.trim().replace(/\/+$/, "") ?? "";
  return base ? `${base}/models` : "";
}

export function candidateModelEndpoints(apiBase: string | undefined): CandidateModelEndpoint[] {
  const normalized = apiBase?.trim().replace(/\/+$/, "") ?? "";
  if (!normalized) {
    return [];
  }
  const alternateBase = normalized.endsWith("/v1")
    ? normalized.slice(0, -3).replace(/\/+$/, "")
    : `${normalized}/v1`;
  const candidates = [
    { url: joinModelsUrl(normalized), resolvedApiBase: normalized, usedFallback: false },
  ];
  if (alternateBase && alternateBase !== normalized) {
    candidates.push({ url: joinModelsUrl(alternateBase), resolvedApiBase: alternateBase, usedFallback: true });
  }
  return candidates.filter((candidate) => candidate.url.length > 0);
}

export function extractModelIds(payload: unknown, providerId?: string): string[] {
  const rawItems = rawModelItems(payload);
  const models: string[] = [];
  const seen = new Set<string>();
  for (const item of rawItems) {
    const modelId = modelIdFromItem(item, providerId);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    models.push(modelId);
  }
  return models;
}

export async function probeOpenAICompatibleModels(input: {
  apiBase: string | undefined;
  headers: Record<string, string>;
  providerId?: string;
  fetchJson: JsonFetcher;
}): Promise<ModelDiscoveryResult> {
  const candidates = candidateModelEndpoints(input.apiBase);
  if (candidates.length === 0) {
    throw new Error("api_base is required");
  }
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const body = await input.fetchJson(candidate.url, input.headers);
      const models = extractModelIds(body, input.providerId);
      if (models.length === 0) {
        throw new Error("no models found in /models response");
      }
      const originalBase = input.apiBase?.trim().replace(/\/+$/, "") ?? "";
      return {
        models,
        url: candidate.url,
        resolvedApiBase: candidate.resolvedApiBase,
        suggestedApiBase: candidate.usedFallback && candidate.resolvedApiBase !== originalBase ? candidate.resolvedApiBase : undefined,
        usedFallback: candidate.usedFallback,
      };
    } catch (error) {
      errors.push(`${candidate.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(errors.join("; ") || "model discovery failed");
}

function rawModelItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  const object = asObject(payload);
  if (!object) {
    return [];
  }
  const items = object.data ?? object.models ?? object.items;
  return Array.isArray(items) ? items : [];
}

function modelIdFromItem(item: unknown, providerId: string | undefined): string {
  if (typeof item === "string") {
    return item;
  }
  const object = asObject(item);
  if (!object) {
    return "";
  }
  if (providerId === "vercel") {
    const modelType = object.type;
    const tags = object.tags;
    if (modelType && modelType !== "language") {
      return "";
    }
    if (Array.isArray(tags) && !tags.includes("tool-use")) {
      return "";
    }
  }
  const value = object.id ?? object.name ?? object.model;
  return value ? String(value) : "";
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
