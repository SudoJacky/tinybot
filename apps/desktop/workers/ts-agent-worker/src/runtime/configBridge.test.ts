import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import { NativeConfigBridge, modelProviderConfigFromNativeConfig } from "./configBridge";

class FakeRpcClient {
  readonly requests: Array<{ traceId: string; method: string; params: JsonObject }> = [];

  constructor(private readonly values: Record<string, unknown>, private readonly snapshot?: Record<string, unknown>) {}

  async request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    if (method === "config.snapshot_public") {
      if (this.snapshot === undefined) {
        throw new Error("unknown method");
      }
      this.requests.push({ traceId, method, params });
      return { value: this.snapshot ?? null };
    }
    this.requests.push({ traceId, method, params });
    if (method === "provider.resolve_secret") {
      return { apiKey: "native-secret", apiKeySource: "config" };
    }
    const path = params.path;
    if (typeof path !== "string") {
      throw new Error("config.get path must be a string");
    }
    return { path, value: this.values[path] ?? null };
  }
}

describe("NativeConfigBridge", () => {
  test("builds OpenAI provider config from native public config and env secrets", async () => {
    const rpcClient = new FakeRpcClient({
      "agents.defaults.provider": "openai",
      "agents.defaults.model": "gpt-5",
      "providers.openai": {
        provider: "openai",
        api_base: "https://api.test/v1",
        api_key: null,
      },
    });

    const config = await modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {
      OPENAI_API_KEY: "env-key",
    });

    expect(config).toEqual({
      kind: "openai",
      apiKey: "env-key",
      baseURL: "https://api.test/v1",
      model: "gpt-5",
    });
    expect(rpcClient.requests).toEqual([
      {
        traceId: "worker-config",
        method: "config.get",
        params: { path: "agents.defaults.provider" },
      },
      {
        traceId: "worker-config",
        method: "config.get",
        params: { path: "agents.defaults.model" },
      },
      {
        traceId: "worker-config",
        method: "config.get",
        params: { path: "providers.openai" },
      },
    ]);
  });

  test("falls back to env config when native defaults do not select OpenAI", async () => {
    const rpcClient = new FakeRpcClient({
      "agents.defaults.provider": null,
      "agents.defaults.model": null,
      "providers.openai": null,
    });

    const config = await modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {
      TS_AGENT_PROVIDER: "openai",
      OPENAI_API_KEY: "env-key",
      TS_AGENT_OPENAI_MODEL: "env-model",
      OPENAI_BASE_URL: "https://env.test/v1",
    });

    expect(config).toEqual({
      kind: "openai",
      apiKey: "env-key",
      baseURL: "https://env.test/v1",
      model: "env-model",
    });
    expect(rpcClient.requests.map((request) => request.params.path)).not.toContain("providers.openai.api_key");
  });

  test("builds provider config from public snapshot and narrow provider secret RPC", async () => {
    const rpcClient = new FakeRpcClient(
      {},
      {
        agents: { defaults: { model: "qwen-plus", active_profile: "dashscope-search" } },
        providers: {
          profiles: {
            "dashscope-search": {
              provider: "dashscope",
              api_base: "https://dashscope.test/compatible-mode/v1",
              extra_body: { enable_search: true },
            },
          },
        },
      },
    );

    const config = await modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {});

    expect(config).toMatchObject({
      kind: "resolved",
      resolved: {
        providerId: "dashscope",
        profileName: "dashscope-search",
        apiKey: "native-secret",
        apiKeySource: "config",
        apiBase: "https://dashscope.test/compatible-mode/v1",
        extraBody: { enable_search: true },
      },
    });
    expect(rpcClient.requests).toEqual([
      {
        traceId: "worker-config",
        method: "config.snapshot_public",
        params: {},
      },
      {
        traceId: "worker-config",
        method: "provider.resolve_secret",
        params: {
          providerId: "dashscope",
          profileName: "dashscope-search",
          apiKeyEnvVars: ["DASHSCOPE_API_KEY"],
        },
      },
    ]);
  });

  test("defensively masks secrets from public snapshots before provider resolution", async () => {
    const rpcClient = new FakeRpcClient(
      {},
      {
        agents: { defaults: { provider: "openai", model: "gpt-4.1-mini" } },
        providers: {
          openai: {
            provider: "openai",
            api_key: "leaked-public-key",
            api_base: "https://api.test/v1",
          },
        },
      },
    );

    const config = await modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {});

    expect(config).toMatchObject({
      kind: "resolved",
      resolved: {
        providerId: "openai",
        apiKey: "native-secret",
        apiKeySource: "config",
        apiBase: "https://api.test/v1",
      },
    });
  });

  test("uses native default model with env OpenAI key when provider is auto", async () => {
    const rpcClient = new FakeRpcClient({
      "agents.defaults.provider": "auto",
      "agents.defaults.model": "gpt-5",
      "providers.openai": {
        api_base: "https://api.test/v1",
        api_key: null,
      },
    });

    const config = await modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {
      OPENAI_API_KEY: "env-key",
    });

    expect(config).toEqual({
      kind: "openai",
      apiKey: "env-key",
      baseURL: "https://api.test/v1",
      model: "gpt-5",
    });
    expect(rpcClient.requests.map((request) => request.params.path)).toEqual([
      "agents.defaults.provider",
      "agents.defaults.model",
      "providers.openai",
    ]);
  });

  test("returns unconfigured provider config when OpenAI is selected without env api key", async () => {
    const rpcClient = new FakeRpcClient({
      "agents.defaults.provider": "openai",
      "agents.defaults.model": "gpt-5",
      "providers.openai": { provider: "openai", api_base: "https://api.test/v1", api_key: null },
    });

    await expect(modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {})).resolves.toEqual({});
  });

  test("builds fixture provider config from native public config", async () => {
    const rpcClient = new FakeRpcClient({
      "agents.defaults.provider": "fixture",
      "providers.fixture": {
        responses: [
          {
            content: "fixture answer",
            stopReason: "stop",
            toolCalls: [],
          },
        ],
      },
    });

    await expect(modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {})).resolves.toEqual({
      kind: "fixture",
      responses: [
        {
          content: "fixture answer",
          stopReason: "stop",
          toolCalls: [],
        },
      ],
    });
    expect(rpcClient.requests).toEqual([
      {
        traceId: "worker-config",
        method: "config.get",
        params: { path: "agents.defaults.provider" },
      },
      {
        traceId: "worker-config",
        method: "config.get",
        params: { path: "providers.fixture" },
      },
    ]);
  });

  test("keeps fixture tool-call responses with empty content", async () => {
    const rpcClient = new FakeRpcClient({
      "agents.defaults.provider": "fixture",
      "providers.fixture": {
        responses: [
          {
            content: "",
            stopReason: "tool_calls",
            toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
          },
          {
            content: "final",
            stopReason: "stop",
            delayMs: 25,
            toolCalls: [],
          },
        ],
      },
    });

    await expect(modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {})).resolves.toEqual({
      kind: "fixture",
      responses: [
        {
          content: "",
          stopReason: "tool_calls",
          toolCalls: [{ id: "call-1", name: "read_file", argumentsJson: "{\"path\":\"README.md\"}" }],
        },
        {
          content: "final",
          stopReason: "stop",
          delayMs: 25,
          toolCalls: [],
        },
      ],
    });
  });
});
