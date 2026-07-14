import { describe, expect, test } from "vitest";
import {
  BUILT_IN_PROVIDER_PRESETS,
  buildCustomProviderPatch,
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

  test("builds configured custom providers alongside built-in presets", () => {
    const settings = buildProviderModelsSettings({
      agents: { defaults: { activeProfile: "local-default", model: "local-model" } },
      providers: {
        profiles: {
          "local-default": {
            provider: "local-openai",
            displayName: "Local OpenAI",
            enabled: true,
            apiBase: "http://127.0.0.1:11434/v1",
            models: ["local-model"],
            defaultModel: "local-model",
            supportsModelDiscovery: true,
          },
        },
      },
    });

    expect(settings.providers.find((provider) => provider.profileId === "local-default")).toMatchObject({
      id: "local-openai",
      label: "Local OpenAI",
      builtIn: false,
      active: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "local-model", label: "local-model", source: "user" }],
      modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
    });
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

  test("builds an OpenAI-compatible custom provider profile", () => {
    expect(buildCustomProviderPatch({
      providerId: "local-openai",
      profileId: "local-default",
      displayName: "Local OpenAI",
      apiBase: "http://127.0.0.1:11434/v1",
      apiKey: "local-secret",
      model: "local-model",
      supportsModelDiscovery: true,
      activate: true,
    })).toEqual({
      agents: { defaults: { activeProfile: "local-default", model: "local-model" } },
      providers: {
        profiles: {
          "local-default": {
            provider: "local-openai",
            displayName: "Local OpenAI",
            enabled: true,
            apiBase: "http://127.0.0.1:11434/v1",
            apiKey: "local-secret",
            models: ["local-model"],
            defaultModel: "local-model",
            supportsModelDiscovery: true,
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
