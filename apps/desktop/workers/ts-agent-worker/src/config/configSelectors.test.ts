import { describe, expect, test } from "vitest";

import { parseTinybotConfig } from "./configSchema";
import {
  selectAgentDefaults,
  selectChannelDeliveryConfig,
  selectExecToolConfig,
  selectGatewayConfig,
  selectKnowledgeConfig,
  selectMcpServers,
  selectProviderConfig,
  selectProviderProfileConfig,
  selectProviderRuntimeInput,
  selectSsrWhitelist,
  selectWorkspacePath,
} from "./configSelectors";

describe("configSelectors", () => {
  test("selects typed agent defaults and workspace path", () => {
    const config = parseTinybotConfig({ agents: { defaults: { workspace: "D:/work", model: "gpt-5" } } });

    expect(selectAgentDefaults(config).model).toBe("gpt-5");
    expect(selectWorkspacePath(config)).toBe("D:/work");
  });

  test("selects provider configs and profiles with normalized model lists", () => {
    const config = parseTinybotConfig({
      providers: {
        dashscope: { api_key: "key", api_base: "https://dashscope.test/v1" },
        profiles: {
          coder: {
            provider: "dashscope",
            models: "qwen-coder,qwen-plus",
            manual_model_ids: ["manual-a", "manual-b"],
          },
        },
      },
    });

    expect(selectProviderConfig(config, "dashscope")).toMatchObject({
      apiKey: "key",
      apiBase: "https://dashscope.test/v1",
    });
    expect(selectProviderProfileConfig(config, "coder")).toMatchObject({
      provider: "dashscope",
      models: ["qwen-coder", "qwen-plus"],
      manualModels: ["manual-a", "manual-b"],
    });
  });

  test("selects provider runtime input using profile before default provider", () => {
    const config = parseTinybotConfig({
      agents: {
        defaults: {
          model: "deepseek-reasoner",
          provider: "openai",
          active_profile: "coding",
        },
      },
      providers: {
        openai: { api_base: "https://openai.test/v1" },
        profiles: {
          coding: {
            provider: "dashscope",
            api_base: "https://dashscope.test/compatible-mode/v1",
            manual_models: ["qwen-plus"],
          },
        },
      },
    });

    expect(selectProviderRuntimeInput(config, "override-model")).toMatchObject({
      model: "override-model",
      providerId: "dashscope",
      source: "profile",
      activeProfile: "coding",
      providerConfig: {
        provider: "dashscope",
        apiBase: "https://dashscope.test/compatible-mode/v1",
        manualModels: ["qwen-plus"],
      },
    });
  });

  test("selects explicit provider runtime input when no active profile is configured", () => {
    const config = parseTinybotConfig({
      agents: { defaults: { model: "gpt-5", provider: "openrouter" } },
      providers: {
        openrouter: {
          api_base: "https://openrouter.test/api/v1",
          manual_model_ids: "openai/gpt-4.1",
        },
      },
    });

    expect(selectProviderRuntimeInput(config)).toMatchObject({
      model: "gpt-5",
      providerId: "openrouter",
      source: "explicit",
      activeProfile: null,
      providerConfig: {
        apiBase: "https://openrouter.test/api/v1",
        manualModels: ["openai/gpt-4.1"],
      },
    });
  });

  test("selects tool knowledge gateway and channel config", () => {
    const config = parseTinybotConfig({
      channels: { send_max_retries: 5, feishu: { enabled: true } },
      gateway: { host: "127.0.0.1", port: 19000 },
      tools: {
        exec: { enable: false, timeout: 10, path_append: "C:/bin" },
        mcpServers: { fs: { type: "stdio", command: "node" } },
        ssrfWhitelist: ["10.0.0.0/8"],
      },
      knowledge: { enabled: true, retrieval_mode: "sparse", max_chunks: 3 },
    });

    expect(selectChannelDeliveryConfig(config)).toMatchObject({ sendMaxRetries: 5, extras: { feishu: { enabled: true } } });
    expect(selectGatewayConfig(config)).toMatchObject({ host: "127.0.0.1", port: 19000 });
    expect(selectExecToolConfig(config)).toMatchObject({ enable: false, timeout: 10, pathAppend: "C:/bin" });
    expect(selectMcpServers(config).fs).toMatchObject({ type: "stdio", command: "node" });
    expect(selectSsrWhitelist(config)).toEqual(["10.0.0.0/8"]);
    expect(selectKnowledgeConfig(config)).toMatchObject({ enabled: true, retrievalMode: "sparse", maxChunks: 3 });
  });
});
