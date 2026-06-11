import { describe, expect, test } from "vitest";

import { resolveRuntimeProvider } from "./providerRuntime";

describe("resolveRuntimeProvider", () => {
  test("prefers active profile over default provider and model inference", async () => {
    const resolved = await resolveRuntimeProvider({
      config: {
        agents: { defaults: { model: "qwen3-coder-plus", active_profile: "dashscope-coding" } },
        providers: {
          profiles: {
            "dashscope-coding": {
              provider: "dashscope",
              api_base: "https://example.test/compatible/v1",
              models: ["qwen3-coder-plus"],
              manual_models: "manual-a\nmanual-b",
              supports_model_discovery: false,
              extra_body: { enable_search: true },
            },
          },
        },
      },
      env: {},
      secretResolver: async () => ({ apiKey: "profile-key", apiKeySource: "config" }),
    });

    expect(resolved).toMatchObject({
      providerId: "dashscope",
      profileName: "dashscope-coding",
      source: "profile",
      apiKey: "profile-key",
      apiKeySource: "config",
      apiBase: "https://example.test/compatible/v1",
      models: ["qwen3-coder-plus"],
      manualModelIds: ["manual-a", "manual-b"],
      supportsModelDiscovery: false,
      extraBody: { enable_search: true },
    });
  });

  test("uses explicit catalog provider and environment fallback values", async () => {
    const resolved = await resolveRuntimeProvider({
      config: {
        agents: { defaults: { provider: "open router", model: "openai/gpt-4o-mini" } },
        providers: {},
      },
      env: {
        OPENROUTER_API_KEY: "env-openrouter-key",
        OPENROUTER_BASE_URL: "https://custom-openrouter.test/v1",
      },
    });

    expect(resolved).toMatchObject({
      providerId: "openrouter",
      source: "explicit",
      apiKey: "env-openrouter-key",
      apiKeySource: "env:OPENROUTER_API_KEY",
      apiBase: "https://custom-openrouter.test/v1",
    });
  });

  test("infers provider from selected model before credential fallback", async () => {
    const resolved = await resolveRuntimeProvider({
      config: {
        agents: { defaults: { model: "glm-4-plus" } },
        providers: { zhipu: { api_key: null } },
      },
      env: { ZHIPUAI_API_KEY: "zhipu-key" },
    });

    expect(resolved.providerId).toBe("zhipu");
    expect(resolved.source).toBe("model");
    expect(resolved.apiKey).toBe("zhipu-key");
  });

  test("falls back to first provider with usable credentials in catalog order", async () => {
    const resolved = await resolveRuntimeProvider({
      config: {
        agents: { defaults: { model: "unknown-model" } },
        providers: { dashscope: { api_key: "dashscope-key" } },
      },
      env: {},
    });

    expect(resolved.providerId).toBe("dashscope");
    expect(resolved.source).toBe("credentials");
    expect(resolved.apiKey).toBe("dashscope-key");
  });

  test("falls back to the first local provider when no remote credentials are configured", async () => {
    const resolved = await resolveRuntimeProvider({
      config: { agents: { defaults: { model: "unknown-model" } }, providers: {} },
      env: {},
    });

    expect(resolved).toMatchObject({
      providerId: "ollama",
      model: "unknown-model",
      source: "credentials",
      apiBase: "http://127.0.0.1:11434/v1",
    });
  });
});
