import { describe, expect, test } from "vitest";
import {
  BUILT_IN_PROVIDER_PRESETS,
  buildProviderConfigurePatch,
  buildProviderDefaultLlmPatch,
  buildProviderModelsPatch,
  buildProviderModelsSettings,
} from "./providerModelsSettings";

describe("provider models settings", () => {
  test("builds built-in provider cards from backend config", () => {
    const settings = buildProviderModelsSettings({
      revision: "hash:1",
      agents: { defaults: { activeProfile: "deepseek-default", model: "deepseek-v4-pro" } },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            displayName: "DeepSeek",
            enabled: true,
            apiBase: "https://api.deepseek.com",
            apiKeyConfigured: true,
            models: ["deepseek-v4-pro"],
            defaultModel: "deepseek-v4-pro",
          },
        },
      },
    });

    expect(settings.revision).toBe("hash:1");
    expect(settings.activeProfileId).toBe("deepseek-default");
    expect(settings.providers.map((provider) => provider.id)).toEqual(["deepseek", "dashscope", "openai"]);
    expect(settings.providers.find((provider) => provider.id === "deepseek")).toMatchObject({
      label: "DeepSeek",
      profileId: "deepseek-default",
      active: true,
      status: "available",
      apiKeyConfigured: true,
      baseUrl: "https://api.deepseek.com",
      modelCount: 2,
      defaultModel: "deepseek-v4-pro",
    });
    expect(settings.providers.find((provider) => provider.id === "openai")).toMatchObject({
      status: "not_configured",
      baseUrl: "https://api.openai.com/v1",
      modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
    });
    expect(settings.providers.find((provider) => provider.id === "dashscope")).toMatchObject({
      modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
    });
    expect(BUILT_IN_PROVIDER_PRESETS.every((preset) => preset.builtIn)).toBe(true);
  });

  test("builds configure patches without exposing unchanged secrets", () => {
    expect(buildProviderConfigurePatch({
      providerId: "openai",
      profileId: "openai-default",
      apiBase: "https://api.openai.com/v1",
      apiKey: "",
      enabled: true,
    })).toEqual({
      providers: {
        profiles: {
          "openai-default": {
            provider: "openai",
            displayName: "OpenAI",
            enabled: true,
            apiBase: "https://api.openai.com/v1",
          },
        },
      },
    });

    expect(buildProviderConfigurePatch({
      providerId: "openai",
      profileId: "openai-default",
      apiBase: "https://api.openai.com/v1",
      apiKey: "sk-new",
      enabled: true,
      activate: true,
    })).toEqual({
      agents: { defaults: { activeProfile: "openai-default" } },
      providers: {
        profiles: {
          "openai-default": {
            provider: "openai",
            displayName: "OpenAI",
            enabled: true,
            apiBase: "https://api.openai.com/v1",
            apiKey: "sk-new",
          },
        },
      },
    });
  });

  test("builds model patches for manual models and defaults", () => {
    expect(buildProviderModelsPatch({
      providerId: "deepseek",
      profileId: "deepseek-default",
      models: ["deepseek-v4-pro", "custom-model"],
      defaultModel: "custom-model",
      setAgentDefault: true,
    })).toEqual({
      agents: { defaults: { activeProfile: "deepseek-default", model: "custom-model" } },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            models: ["deepseek-v4-pro", "custom-model"],
            defaultModel: "custom-model",
          },
        },
      },
    });
  });

  test("builds default LLM patch for active profile and model", () => {
    expect(buildProviderDefaultLlmPatch({
      profileId: "openai-default",
      model: "gpt-4.1",
    })).toEqual({
      agents: { defaults: { activeProfile: "openai-default", model: "gpt-4.1" } },
    });
  });
});
