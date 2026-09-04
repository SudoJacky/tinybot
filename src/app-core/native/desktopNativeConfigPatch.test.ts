import { describe, expect, test, vi } from "vitest";
import {
  applyNativeConfigPatch,
  removeDesktopConfigValue,
  replaceDesktopConfigValue,
} from "./desktopNativeConfigPatch";

describe("desktop native config patch host action", () => {
  test("sends canonical operations instead of a full config candidate", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {
        agents: { defaults: { model: "gpt-4.1", provider: "openai" } },
        providers: {},
      },
      updatedFields: ["agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      { agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } } },
      { agents: { defaults: { model: "gpt-4.1" } } },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: undefined,
        operations: [
          {
            op: "replace",
            path: "agents.defaults.model",
            value: "gpt-4.1",
          },
        ],
      },
    });
  });

  test("does not send public secret presence metadata as persisted config", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      {
        agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
        providers: {
          openai: {
            provider: "openai",
            api_key_configured: true,
            api_base: "https://api.openai.com/v1",
          },
        },
      },
      { agents: { defaults: { model: "gpt-4.1" } } },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: undefined,
        operations: [
          {
            op: "replace",
            path: "agents.defaults.model",
            value: "gpt-4.1",
          },
        ],
      },
    });
  });

  test("uses explicit secret operations for secret patch values", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["providers.openai.api_key"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      { revision: "hash:old" },
      { providers: { openai: { api_key: "sk-new" } } },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: "hash:old",
        operations: [
          {
            op: "secretReplace",
            path: "providers.openai.api_key",
            value: "sk-new",
          },
        ],
      },
    });
  });

  test("removes both Memory override fields when restoring global defaults", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: { memory: {} },
      updatedFields: ["memory.activeProfile", "memory.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      { memory: { activeProfile: "zai-default", model: "glm-5.3-flash" } },
      {
        memory: {
          activeProfile: { __desktopConfigOperation: "remove" },
          model: { __desktopConfigOperation: "remove" },
        },
      },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: undefined,
        operations: [
          { op: "remove", path: "memory.activeProfile" },
          { op: "remove", path: "memory.model" },
        ],
      },
    });
  });

  test("canonicalizes legacy alias paths before sending operations", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["agents.defaults.maxTokens"],
      sideEffects: { applied: [], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      {},
      {
        agents: { defaults: { max_tokens: 8192, context_window_strategy: "compact" } },
        providers: { profiles: { "openai-default": { api_mode: "responses" } } },
      },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: undefined,
        operations: [
          {
            op: "replace",
            path: "agents.defaults.maxTokens",
            value: 8192,
          },
          {
            op: "replace",
            path: "agents.defaults.contextWindowStrategy",
            value: "compact",
          },
          {
            op: "replace",
            path: "providers.profiles.openai-default.apiMode",
            value: "responses",
          },
        ],
      },
    });
  });

  test("replaces an object atomically and escapes its config path as JSON Pointer", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["tools.mcpServers.docs.search"],
      sideEffects: { applied: ["mcpConfigChanged"], restartRequired: [], warnings: [] },
      error: null,
    });
    const server = {
      enabled: true,
      transport: "streamable-http",
      url: "https://example.com/mcp",
      httpHeaders: { "X-Route.Version": "v1" },
      enabledTools: ["*"],
    };

    await applyNativeConfigPatch(
      { revision: "hash:old" },
      {
        tools: {
          mcp_servers: {
            "docs.search": replaceDesktopConfigValue(server),
          },
        },
      },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: "hash:old",
        operations: [{
          op: "replace",
          path: "/tools/mcpServers/docs.search",
          value: server,
        }],
      },
    });
  });

  test("removes a dynamic MCP field through an unambiguous JSON Pointer", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["tools.mcpServers.docs.search.httpHeaders.X-Route.Version"],
      sideEffects: { applied: ["mcpConfigChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      { revision: "hash:old" },
      {
        tools: {
          mcpServers: {
            "docs.search": {
              httpHeaders: {
                "X-Route.Version": removeDesktopConfigValue(),
              },
            },
          },
        },
      },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: "hash:old",
        operations: [{
          op: "remove",
          path: "/tools/mcpServers/docs.search/httpHeaders/X-Route.Version",
        }],
      },
    });
  });
});
