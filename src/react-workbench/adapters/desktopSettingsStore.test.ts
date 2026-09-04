// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeDefaultChatModel } from "../../app-core/chat/chatModelPreference";
import type { DesktopNativeConfigPatchResponse } from "../../app-core/native/desktopNativeConfigPatch";
import { createDesktopSettingsStore } from "./desktopSettingsStore";

const config = {
  agents: { defaults: { activeProfile: "deepseek-default", model: "deepseek-chat" } },
  providers: {
    profiles: {
      "deepseek-default": {
        provider: "deepseek",
        displayName: "DeepSeek",
        enabled: true,
        models: ["deepseek-chat"],
      },
      "openai-default": {
        provider: "openai",
        displayName: "OpenAI",
        enabled: true,
        models: ["gpt-5"],
      },
    },
  },
  revision: "revision-1",
};

describe("desktop settings store", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("builds chat model options from config and the provider catalog", async () => {
    const initialize = vi.fn(async () => undefined);
    const get = vi.fn(async () => config);
    const route = vi.fn(async () => ({
      providers: [
        { id: "deepseek", displayName: "DeepSeek", status: "ready" },
        { id: "openai", displayName: "OpenAI", status: "ready" },
      ],
    }));
    const store = createDesktopSettingsStore({
      initialize,
      nativeConfig: { get },
      nativeWebui: { route },
    });

    await expect(store.loadChatModels!()).resolves.toEqual([
      expect.objectContaining({ default: true, id: "deepseek-chat", providerId: "deepseek" }),
      expect.objectContaining({ id: "gpt-5", providerId: "openai" }),
    ]);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledWith({ method: "GET", path: "/api/providers" });
  });

  it("includes models when the provider API key is configured through the environment", async () => {
    const store = createDesktopSettingsStore({
      initialize: async () => undefined,
      nativeConfig: { get: async () => config },
      nativeWebui: {
        route: async () => ({
          providers: [
            { id: "deepseek", displayName: "DeepSeek", api_key_configured: true },
          ],
        }),
      },
    });

    await expect(store.loadChatModels!()).resolves.toEqual([
      expect.objectContaining({ default: true, id: "deepseek-chat", providerId: "deepseek" }),
    ]);
  });

  it("excludes models from enabled providers that are not available", async () => {
    const get = vi.fn(async () => ({
      agents: { defaults: { activeProfile: "dashscope-default", model: "qwen-plus", provider: "dashscope" } },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            displayName: "DeepSeek",
            enabled: true,
            models: ["deepseek-chat"],
          },
          "dashscope-default": {
            provider: "dashscope",
            displayName: "DashScope",
            enabled: true,
            models: ["qwen-plus"],
          },
        },
      },
    }));
    const route = vi.fn(async () => ({
      providers: [
        { id: "deepseek", displayName: "DeepSeek", status: "ready" },
        { id: "dashscope", displayName: "DashScope", status: "not_configured" },
      ],
    }));
    const store = createDesktopSettingsStore({
      initialize: async () => undefined,
      nativeConfig: { get },
      nativeWebui: { route },
    });

    await expect(store.loadChatModels!()).resolves.toEqual([
      expect.objectContaining({ id: "deepseek-chat", providerId: "deepseek" }),
    ]);
  });

  it("does not expose models from a provider explicitly disabled in config", async () => {
    const store = createDesktopSettingsStore({
      initialize: async () => undefined,
      nativeConfig: {
        get: async () => ({
          agents: { defaults: { model: "deepseek-chat", provider: "deepseek" } },
          providers: {
            profiles: {
              "deepseek-default": {
                provider: "deepseek",
                enabled: false,
                models: ["deepseek-chat"],
              },
            },
          },
        }),
      },
      nativeWebui: { route: async () => ({ providers: [{ id: "deepseek", status: "ready" }] }) },
    });

    await expect(store.loadChatModels!()).resolves.toEqual([]);
  });

  it("only exposes enabled models and carries image capabilities into shared selectors", async () => {
    const get = vi.fn(async () => ({
      agents: { defaults: { activeProfile: "zai-default", model: "glm-5.3-flash", provider: "zai" } },
      providers: {
        profiles: {
          "zai-default": {
            provider: "zai",
            apiKeyConfigured: true,
            models: ["glm-5.3", "glm-5.3-flash", "custom-vision"],
            enabledModels: ["glm-5.3-flash", "custom-vision"],
            modelCapabilities: [{ model: "custom-vision", inputModalities: ["image"] }],
          },
        },
      },
    }));
    const store = createDesktopSettingsStore({
      initialize: async () => undefined,
      nativeConfig: { get },
      nativeWebui: { route: async () => ({ providers: [{ id: "zai", status: "ready" }] }) },
    });

    await expect(store.loadChatModels!()).resolves.toEqual([
      expect.objectContaining({
        default: true,
        id: "glm-5.3-flash",
        providerId: "zai",
        supportsImageInput: true,
      }),
      expect.objectContaining({
        id: "custom-vision",
        providerId: "zai",
        supportsImageInput: true,
      }),
    ]);
  });

  it("does not hide provider catalog failures", async () => {
    const failure = new Error("provider catalog unavailable");
    const store = createDesktopSettingsStore({
      initialize: async () => undefined,
      nativeConfig: { get: async () => config },
      nativeWebui: { route: async () => Promise.reject(failure) },
    });

    await expect(store.loadChatModels!()).rejects.toBe(failure);
  });

  it("repairs an invalid native default pair from a valid renderer preference", async () => {
    const mismatchedConfig = {
      revision: "revision-1",
      agents: { defaults: { activeProfile: "zai-default", model: "deepseek-v4-pro" } },
      providers: {
        profiles: {
          "deepseek-default": {
            provider: "deepseek",
            enabled: true,
            models: ["deepseek-v4-pro"],
            enabledModels: ["deepseek-v4-pro"],
          },
          "zai-default": {
            provider: "zai",
            enabled: true,
            models: ["glm-5.3-flash"],
            enabledModels: ["glm-5.3-flash"],
          },
        },
      },
    };
    const repairedConfig = {
      ...mismatchedConfig,
      agents: { defaults: { activeProfile: "zai-default", model: "glm-5.3-flash" } },
    };
    const response: DesktopNativeConfigPatchResponse = {
      ok: true,
      config: repairedConfig,
      revision: "revision-2",
      updatedFields: ["agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
    };
    const applyNativeConfigPatch = vi.fn(async () => response);
    const store = createDesktopSettingsStore({
      applyNativeConfigPatch,
      initialize: async () => undefined,
      nativeConfig: { get: async () => mismatchedConfig },
      nativeWebui: { route: async () => ({ providers: [{ id: "deepseek", status: "ready" }, { id: "zai", status: "ready" }] }) },
    });
    writeDefaultChatModel("glm-5.3-flash", "zai");

    await expect(store.loadChatModels!()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ default: true, id: "glm-5.3-flash", providerId: "zai" }),
    ]));
    expect(applyNativeConfigPatch).toHaveBeenCalledWith(mismatchedConfig, {
      agents: { defaults: { activeProfile: "zai-default", model: "glm-5.3-flash" } },
    });
  });

  it("updates the renderer preference only after the native default pair is persisted", async () => {
    let finishNativeSave!: () => void;
    const nativeSave = new Promise<void>((resolve) => {
      finishNativeSave = resolve;
    });
    const savedConfig = {
      ...config,
      agents: { defaults: { activeProfile: "openai-default", model: "gpt-5" } },
    };
    const response: DesktopNativeConfigPatchResponse = {
      ok: true,
      config: savedConfig,
      revision: "revision-2",
      updatedFields: ["agents.defaults.activeProfile", "agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
    };
    const applyNativeConfigPatch = vi.fn(async () => {
      await nativeSave;
      return response;
    });
    const store = createDesktopSettingsStore({
      applyNativeConfigPatch,
      initialize: async () => undefined,
      nativeConfig: { get: async () => config },
    });
    writeDefaultChatModel("deepseek-chat", "deepseek");

    const save = store.saveDefaultChatModel!({ modelId: "gpt-5", providerId: "openai" });
    await vi.waitFor(() => expect(applyNativeConfigPatch).toHaveBeenCalledWith(config, {
      agents: { defaults: { activeProfile: "openai-default", model: "gpt-5" } },
    }));
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("deepseek-chat");
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-provider")).toBe("deepseek");

    finishNativeSave();
    await save;

    expect(window.localStorage.getItem("tinybot.ui.chat.composer-model")).toBe("gpt-5");
    expect(window.localStorage.getItem("tinybot.ui.chat.composer-provider")).toBe("openai");
  });

  it("loads and saves USER.md with the expected revision", async () => {
    const initialize = vi.fn(async () => undefined);
    const bootstrapFiles = vi.fn(async () => ({
      files: [{ path: "USER.md", contents: "Keep answers concise.", updated_at: "unix-ms:100" }],
      missing: [],
    }));
    const putFile = vi.fn(async () => ({ path: "USER.md", updated_at: "unix-ms:200" }));
    const store = createDesktopSettingsStore({
      initialize,
      nativeWorkspace: { bootstrapFiles, putFile },
    });

    await expect(store.loadPersonalizationInstructions!()).resolves.toEqual({
      path: "USER.md",
      contents: "Keep answers concise.",
      updatedAt: "unix-ms:100",
    });
    await expect(store.savePersonalizationInstructions!({
      contents: "Keep answers concise and concrete.",
      expectedUpdatedAt: "unix-ms:100",
    })).resolves.toEqual({
      path: "USER.md",
      contents: "Keep answers concise and concrete.",
      updatedAt: "unix-ms:200",
    });
    expect(putFile).toHaveBeenCalledWith("USER.md", {
      content: "Keep answers concise and concrete.",
      expectedUpdatedAt: "unix-ms:100",
    });
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it("reconciles native save metadata into the desktop settings projection", async () => {
    const response: DesktopNativeConfigPatchResponse = {
      ok: true,
      config: { ...config, revision: "stale-revision" },
      revision: "revision-2",
      updatedFields: ["agents.defaults.model"],
      sideEffects: {
        applied: ["agentDefaultsUpdated"],
        restartRequired: ["workspaceReloadRequired", "desktopRestartRequired"],
        warnings: ["Restart Tinybot to apply every change."],
      },
    };
    const applyNativeConfigPatch = vi.fn(async () => response);
    const store = createDesktopSettingsStore({
      applyNativeConfigPatch,
      initialize: async () => undefined,
      nativeWebui: { route: async () => ({ providers: [] }) },
    });

    const result = await store.saveDesktopConfigSettings!(config, {
      agents: { defaults: { model: "deepseek-reasoner" } },
    });

    expect(result.currentConfig).toEqual({ ...config, revision: "revision-2" });
    expect(result.saveDetails).toEqual({
      transport: "native",
      persistedRevision: "revision-2",
      updatedFields: ["agents.defaults.model"],
      applied: ["agentDefaultsUpdated"],
      restartRequired: ["desktopRestartRequired"],
      reloadRequired: ["workspaceReloadRequired"],
      warnings: ["Restart Tinybot to apply every change."],
    });
    expect(applyNativeConfigPatch).toHaveBeenCalledWith(config, {
      agents: { defaults: { model: "deepseek-reasoner" } },
    });
  });

  it("persists a Streamable HTTP MCP server as one atomic config value", async () => {
    const applyNativeConfigPatch = vi.fn(async () => ({
      ok: true,
      config,
      revision: "revision-2",
      updatedFields: ["tools.mcpServers.docs.search"],
      sideEffects: { applied: ["mcpConfigChanged"], restartRequired: [], warnings: [] },
    }));
    const store = createDesktopSettingsStore({
      applyNativeConfigPatch,
      initialize: async () => undefined,
      nativeConfig: { get: async () => config },
    });

    await store.createStreamableHttpMcpServer!({
      name: "docs.search",
      url: "https://example.com/mcp",
      bearerToken: "private-token",
      httpHeaders: { "X-Tenant": "tinybot" },
      envHttpHeaders: { "X-Trace-Token": "DOCS_TRACE_TOKEN" },
    });

    expect(applyNativeConfigPatch).toHaveBeenCalledWith(config, {
      tools: {
        mcpServers: {
          "docs.search": {
            __desktopConfigOperation: "replace",
            value: {
              enabled: true,
              transport: "streamable-http",
              url: "https://example.com/mcp",
              bearerToken: "private-token",
              httpHeaders: { "X-Tenant": "tinybot" },
              envHttpHeaders: { "X-Trace-Token": "DOCS_TRACE_TOKEN" },
              enabledTools: ["*"],
            },
          },
        },
      },
    });
  });

  it("persists an STDIO MCP server with ordered arguments and same-name environment passthrough", async () => {
    const applyNativeConfigPatch = vi.fn(async () => ({
      ok: true,
      config,
      revision: "revision-2",
      updatedFields: ["tools.mcpServers.local.sqlite"],
      sideEffects: { applied: ["mcpConfigChanged"], restartRequired: [], warnings: [] },
    }));
    const store = createDesktopSettingsStore({
      applyNativeConfigPatch,
      initialize: async () => undefined,
      nativeConfig: { get: async () => config },
    });

    await store.createStdioMcpServer!({
      name: "local.sqlite",
      command: "openai-dev-mcp",
      args: ["serve-sqlite", "./data/app.db"],
      env: { LOG_LEVEL: "debug" },
      envVarRefs: { DATABASE_TOKEN: "DATABASE_TOKEN" },
      cwd: "./tools",
    });

    expect(applyNativeConfigPatch).toHaveBeenCalledWith(config, {
      tools: {
        mcpServers: {
          "local.sqlite": {
            __desktopConfigOperation: "replace",
            value: {
              enabled: true,
              transport: "stdio",
              command: "openai-dev-mcp",
              args: ["serve-sqlite", "./data/app.db"],
              env: { LOG_LEVEL: "debug" },
              envVarRefs: { DATABASE_TOKEN: "DATABASE_TOKEN" },
              cwd: "./tools",
              enabledTools: ["*"],
            },
          },
        },
      },
    });
  });

  it("refuses to replace an existing global MCP server", async () => {
    const applyNativeConfigPatch = vi.fn();
    const store = createDesktopSettingsStore({
      applyNativeConfigPatch,
      initialize: async () => undefined,
      nativeConfig: {
        get: async () => ({ tools: { mcpServers: { docs: { transport: "stdio" } } } }),
      },
    });

    await expect(store.createStreamableHttpMcpServer!({
      name: "docs",
      url: "https://example.com/mcp",
      httpHeaders: {},
      envHttpHeaders: {},
    })).rejects.toThrow("MCP server 'docs' already exists.");
    expect(applyNativeConfigPatch).not.toHaveBeenCalled();
  });

  it("routes live provider model discovery and preserves its result", async () => {
    const route = vi.fn(async () => ({ ok: true, models: ["gpt-5", "gpt-5-mini"], url: "https://api.example/models" }));
    const store = createDesktopSettingsStore({
      initialize: async () => undefined,
      nativeWebui: { route },
    });

    await expect(store.fetchProviderModels!({
      providerId: "openai",
      profileId: "openai-default",
      apiBase: "https://api.example",
      modelDiscovery: { status: "openai-compatible", endpoint: "/models" },
    })).resolves.toEqual({
      ok: true,
      models: ["gpt-5", "gpt-5-mini"],
      warning: null,
      url: "https://api.example/models",
      error: null,
    });
    expect(route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/provider-models",
      body: {
        provider: "openai",
        profile: "openai-default",
        apiBase: "https://api.example",
        refreshLive: true,
      },
    });
  });
});
