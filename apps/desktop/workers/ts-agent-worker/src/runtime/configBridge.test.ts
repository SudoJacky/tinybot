import { describe, expect, test } from "vitest";

import type { JsonObject } from "../protocol/messages";
import { NativeConfigBridge, modelProviderConfigFromNativeConfig } from "./configBridge";

class FakeRpcClient {
  readonly requests: Array<{ traceId: string; method: string; params: JsonObject }> = [];

  constructor(private readonly values: Record<string, unknown>) {}

  async request(traceId: string, method: string, params: JsonObject): Promise<unknown> {
    this.requests.push({ traceId, method, params });
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

  test("returns unconfigured provider config when OpenAI is selected without env api key", async () => {
    const rpcClient = new FakeRpcClient({
      "agents.defaults.provider": "openai",
      "agents.defaults.model": "gpt-5",
      "providers.openai": { provider: "openai", api_base: "https://api.test/v1", api_key: null },
    });

    await expect(modelProviderConfigFromNativeConfig(new NativeConfigBridge(rpcClient), {})).resolves.toEqual({});
  });
});
