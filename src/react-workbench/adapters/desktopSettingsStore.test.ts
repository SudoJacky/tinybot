import { describe, expect, it, vi } from "vitest";
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

  it("does not hide provider catalog failures", async () => {
    const failure = new Error("provider catalog unavailable");
    const store = createDesktopSettingsStore({
      initialize: async () => undefined,
      nativeConfig: { get: async () => config },
      nativeWebui: { route: async () => Promise.reject(failure) },
    });

    await expect(store.loadChatModels!()).rejects.toBe(failure);
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
