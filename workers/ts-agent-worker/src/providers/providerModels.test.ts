import { describe, expect, test } from "vitest";

import { listProviderModels, validateModelForProvider } from "./providerModels";

describe("providerModels", () => {
  test("merges curated, profile, live, and manual models without duplicate source counts", async () => {
    const result = await listProviderModels({
      providerId: "dashscope",
      profileModels: ["qwen-profile", "qwen-max"],
      manualModelIds: ["qwen-manual"],
      refreshLive: true,
      fetcher: async () => ["qwen-live", "qwen-max"],
      apiBase: "https://dashscope.test/compatible-mode/v1",
      apiKey: "key",
    });

    expect(result.models.slice(0, 3).map((model) => model.id)).toEqual(["qwen-max", "qwen-plus", "qwen-turbo"]);
    expect(result.sourceCounts).toEqual({ curated: 11, profile: 1, live: 1, manual: 1 });
    expect(result.ok).toBe(true);
    expect(result.warning).toBeUndefined();
    expect(result.models.find((model) => model.id === "qwen-max")?.sources).toEqual(["curated", "profile", "live"]);
  });

  test("preserves configured models when live discovery fails", async () => {
    const result = await listProviderModels({
      providerId: "dashscope",
      refreshLive: true,
      apiBase: "https://dashscope.test/compatible-mode/v1",
      apiKey: "key",
      fetcher: async () => {
        throw new Error("network down");
      },
    });

    expect(result.ok).toBe(true);
    expect(result.models.map((model) => model.id)).toContain("qwen-max");
    expect(result.warning).toBe("live discovery failed: network down");
  });

  test("skips live discovery when disabled", async () => {
    let calls = 0;
    const result = await listProviderModels({
      providerId: "dashscope",
      supportsModelDiscovery: false,
      refreshLive: true,
      fetcher: async () => {
        calls += 1;
        return ["qwen-live"];
      },
    });

    expect(calls).toBe(0);
    expect(result.sourceCounts.live).toBe(0);
  });

  test("validates provider mismatch while allowing custom local and gateway providers", () => {
    expect(validateModelForProvider({ providerId: "deepseek", model: "qwen-max" })).toEqual({
      ok: false,
      message: "Model 'qwen-max' appears to belong to provider 'dashscope', not 'deepseek'.",
    });
    expect(validateModelForProvider({ providerId: "openrouter", model: "unknown/model" }).ok).toBe(true);
    expect(validateModelForProvider({ providerId: "custom", model: "anything-local" }).ok).toBe(true);
  });
});
