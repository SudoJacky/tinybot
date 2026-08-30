import { describe, expect, test } from "vitest";
import {
  BUILT_IN_PROVIDER_PRESETS,
  automaticModelCapabilities,
  automaticModelContextWindow,
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
            apiMode: "responses",
            models: ["deepseek-v4-pro"],
            defaultModel: "deepseek-v4-pro",
          },
        },
      },
    });

    expect(settings.revision).toBe("hash:1");
    expect(settings.activeProfileId).toBe("deepseek-default");
    expect(settings.fallbackContextWindowTokens).toBe(128_000);
    expect(settings.providers.map((provider) => provider.id)).toEqual(["deepseek", "dashscope", "openai", "zai", "ollama"]);
    expect(settings.providers.find((provider) => provider.id === "deepseek")).toMatchObject({
      label: "DeepSeek",
      profileId: "deepseek-default",
      active: true,
      status: "available",
      apiKeyConfigured: true,
      useResponsesApi: true,
      baseUrl: "https://api.deepseek.com",
      modelCount: 1,
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
    expect(settings.providers.find((provider) => provider.id === "zai")).toMatchObject({
      label: "Z.ai",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      defaultModel: "glm-5.3",
      supportsResponsesApi: false,
      modelDiscovery: { status: "static", endpoint: null },
      models: [
        { id: "glm-5.3", label: "glm-5.3", source: "built-in", enabled: true, supportsImageInput: false },
        { id: "glm-5.3-flash", label: "glm-5.3-flash", source: "built-in", enabled: true, supportsImageInput: true },
        { id: "glm-5.2", label: "glm-5.2", source: "built-in", enabled: true, supportsImageInput: false },
      ],
    });
    expect(settings.providers.find((provider) => provider.id === "ollama")).toMatchObject({
      label: "Ollama",
      profileId: "ollama-default",
      configured: true,
      status: "not_ready",
      apiKeyConfigured: false,
      apiKeyRequired: false,
      baseUrl: "http://127.0.0.1:11434/v1",
      defaultModel: null,
      modelCount: 0,
      supportsResponsesApi: true,
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
      supportsReasoningEffort: true,
      baseUrl: "http://127.0.0.1:11434/v1",
      models: [{ id: "local-model", label: "local-model", source: "user", enabled: true, supportsImageInput: false }],
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
      useResponsesApi: true,
      defaultModel: "gpt-4.1",
      enabled: true,
      activate: true,
    })).toEqual({
      agents: { defaults: { activeProfile: "openai-default", model: "gpt-4.1" } },
      providers: {
        profiles: {
          "openai-default": {
            provider: "openai",
            displayName: "OpenAI",
            enabled: true,
            apiBase: "https://api.openai.com/v1",
            apiKey: "sk-new",
            apiMode: "responses",
          },
        },
      },
    });
  });

  test("keeps the built-in Z.ai provider on Chat Completions", () => {
    expect(buildProviderConfigurePatch({
      providerId: "zai",
      profileId: "zai-default",
      apiBase: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "zai-secret",
      useResponsesApi: false,
      enabled: true,
    })).toEqual({
      providers: {
        profiles: {
          "zai-default": {
            provider: "zai",
            displayName: "Z.ai",
            enabled: true,
            apiBase: "https://open.bigmodel.cn/api/paas/v4",
            apiKey: "zai-secret",
            apiMode: "chat_completions",
          },
        },
      },
    });

    expect(() => buildProviderConfigurePatch({
      providerId: "openai",
      profileId: "openai-default",
      apiBase: "https://api.openai.com/v1",
      activate: true,
    })).toThrow("Cannot activate OpenAI without a default model");
    expect(() => buildProviderConfigurePatch({
      providerId: "zai",
      apiBase: "https://open.bigmodel.cn/api/paas/v4",
      useResponsesApi: true,
    })).toThrow("Z.ai does not support Responses API");
  });

  test("configures built-in Ollama without requiring an API key", () => {
    expect(buildProviderConfigurePatch({
      providerId: "ollama",
      profileId: "ollama-default",
      apiBase: "http://127.0.0.1:11434/v1",
      apiKey: "",
      useResponsesApi: false,
      enabled: true,
    })).toEqual({
      providers: {
        profiles: {
          "ollama-default": {
            provider: "ollama",
            displayName: "Ollama",
            enabled: true,
            apiBase: "http://127.0.0.1:11434/v1",
            apiMode: "chat_completions",
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
      useResponsesApi: false,
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
            apiMode: "chat_completions",
            models: ["local-model"],
            enabledModels: ["local-model"],
            defaultModel: "local-model",
            supportsModelDiscovery: true,
            supportsReasoningEffort: true,
          },
        },
      },
    });

    expect(() => buildCustomProviderPatch({
      providerId: "local-openai",
      displayName: "Local OpenAI",
      apiBase: "http://127.0.0.1:11434/v1",
      model: " ",
      activate: true,
    })).toThrow("Cannot activate Local OpenAI without a default model");
  });

  test("preserves an explicitly disabled reasoning effort feature for custom providers", () => {
    const settings = buildProviderModelsSettings({
      providers: {
        profiles: {
          "local-default": {
            provider: "local-openai",
            apiBase: "http://127.0.0.1:11434/v1",
            models: ["local-model"],
            supportsReasoningEffort: false,
          },
        },
      },
    });

    expect(settings.providers.find((provider) => provider.profileId === "local-default"))
      .toMatchObject({ supportsReasoningEffort: false });
    expect(buildProviderConfigurePatch({
      providerId: "local-openai",
      profileId: "local-default",
      apiBase: "http://127.0.0.1:11434/v1",
      supportsReasoningEffort: false,
    })).toEqual({
      providers: {
        profiles: {
          "local-default": {
            provider: "local-openai",
            displayName: "local-openai",
            enabled: true,
            apiBase: "http://127.0.0.1:11434/v1",
            supportsReasoningEffort: false,
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

    expect(() => buildProviderModelsPatch({
      providerId: "deepseek",
      models: ["deepseek-v4-pro"],
      defaultModel: null,
      setAgentDefault: true,
    })).toThrow("Cannot set deepseek as the default provider without a default model");
  });

  test("resolves known model windows and persists per-model overrides", () => {
    expect(automaticModelContextWindow("deepseek-v4-flash-vision-exp")).toEqual({
      known: true,
      tokens: 1_000_000,
    });
    expect(automaticModelContextWindow("glm-5.3")).toEqual({
      known: true,
      tokens: 1_000_000,
    });
    expect(automaticModelContextWindow("glm-5.3-flash")).toEqual({
      known: true,
      tokens: 1_000_000,
    });
    expect(automaticModelContextWindow("custom-small-model")).toEqual({
      known: false,
      tokens: 128_000,
    });
    expect(automaticModelContextWindow("custom-small-model", 64_000)).toEqual({
      known: false,
      tokens: 64_000,
    });

    const settings = buildProviderModelsSettings({
      agents: { defaults: { contextWindowTokens: 64_000 } },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            models: ["deepseek-v4-flash-vision-exp", "custom-small-model"],
            modelContextWindows: [{
              model: "custom-small-model",
              contextWindowTokens: 32_000,
            }],
          },
        },
      },
    });
    expect(settings.providers.find((provider) => provider.id === "deepseek")?.modelContextWindows)
      .toEqual({ "custom-small-model": 32_000 });
    expect(settings.fallbackContextWindowTokens).toBe(64_000);

    expect(buildProviderModelsPatch({
      providerId: "deepseek",
      profileId: "deepseek-default",
      models: ["custom-small-model", "deepseek-v4-flash-vision-exp"],
      modelContextWindows: [
        { model: "custom-small-model", contextWindowTokens: 32_000 },
        { model: "custom-small-model", contextWindowTokens: 64_000 },
      ],
    })).toEqual({
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            models: ["custom-small-model", "deepseek-v4-flash-vision-exp"],
            modelContextWindows: [{
              model: "custom-small-model",
              contextWindowTokens: 64_000,
            }],
          },
        },
      },
    });
  });

  test("resolves image defaults and persists model enablement and capability overrides", () => {
    expect(automaticModelCapabilities("glm-5.3-flash")).toEqual({ supportsImageInput: true });
    expect(automaticModelCapabilities("deepseek-v4-flash-vision-exp")).toEqual({ supportsImageInput: true });
    expect(automaticModelCapabilities("glm-5.3")).toEqual({ supportsImageInput: false });

    const settings = buildProviderModelsSettings({
      providers: {
        profiles: {
          "zai-default": {
            provider: "zai",
            apiKeyConfigured: true,
            models: ["glm-5.3", "glm-5.3-flash", "custom-vision"],
            enabledModels: ["glm-5.3-flash", "custom-vision"],
            modelCapabilities: [
              { model: "glm-5.3-flash", inputModalities: [] },
              { model: "custom-vision", inputModalities: ["image"] },
            ],
          },
        },
      },
    });
    const zai = settings.providers.find((provider) => provider.id === "zai");
    expect(zai?.modelCount).toBe(2);
    expect(zai?.models.find((model) => model.id === "glm-5.3")).toMatchObject({
      enabled: false,
      supportsImageInput: false,
    });
    expect(zai?.models.find((model) => model.id === "glm-5.3-flash")).toMatchObject({
      enabled: true,
      supportsImageInput: false,
    });
    expect(zai?.models.find((model) => model.id === "custom-vision")).toMatchObject({
      enabled: true,
      supportsImageInput: true,
    });

    expect(buildProviderModelsPatch({
      providerId: "zai",
      models: ["glm-5.3", "glm-5.3-flash", "custom-vision"],
      enabledModels: ["glm-5.3-flash", "custom-vision", "missing"],
      defaultModel: "glm-5.3-flash",
      modelCapabilities: [
        { model: "glm-5.3-flash", inputModalities: [] },
        { model: "custom-vision", inputModalities: ["image"] },
        { model: "glm-5.3", inputModalities: [] },
      ],
    })).toEqual({
      providers: {
        profiles: {
          "zai-default": {
            provider: "zai",
            models: ["glm-5.3", "glm-5.3-flash", "custom-vision"],
            enabledModels: ["glm-5.3-flash", "custom-vision"],
            defaultModel: "glm-5.3-flash",
            modelCapabilities: [
              { model: "custom-vision", inputModalities: ["image"] },
              { model: "glm-5.3-flash", inputModalities: [] },
            ],
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
