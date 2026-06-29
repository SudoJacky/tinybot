import { describe, expect, test } from "vitest";

import {
  isSensitiveConfigKey,
  isSensitiveConfigPath,
  maskConfigSecrets,
  normalizeConfigPath,
} from "./configMasking.ts";

describe("configMasking", () => {
  test("masks sensitive descendants with null for public worker RPC", () => {
    const masked = maskConfigSecrets(
      {
        providers: {
          openai: {
            provider: "openai",
            api_key: "sk-secret",
            apiKey: "sk-camel-secret",
            nested: [{ token: "nested-token", label: "public" }],
          },
        },
      },
      "public-rpc-null",
    );

    expect(masked).toEqual({
      providers: {
        openai: {
          provider: "openai",
          api_key: null,
          apiKey: null,
          nested: [{ token: null, label: "public" }],
        },
      },
    });
  });

  test("masks sensitive descendants with placeholder for UI snapshots", () => {
    const masked = maskConfigSecrets(
      {
        agents: {
          defaults: {
            embedding: {
              apiKey: "embedding-key",
              apiKeyEnvVar: "OPENAI_API_KEY",
            },
          },
        },
        knowledge: {
          rerankApiKey: "rerank-key",
          rerankApiKeyEnvVar: "DASHSCOPE_API_KEY",
        },
      },
      "ui-placeholder",
    );

    expect(masked).toEqual({
      agents: {
        defaults: {
          embedding: {
            apiKey: "********",
            apiKeyEnvVar: "OPENAI_API_KEY",
          },
        },
      },
      knowledge: {
        rerankApiKey: "********",
        rerankApiKeyEnvVar: "DASHSCOPE_API_KEY",
      },
    });
  });

  test("detects sensitive keys using cross-runtime normalization", () => {
    expect(isSensitiveConfigKey("api_key")).toBe(true);
    expect(isSensitiveConfigKey("apiKey")).toBe(true);
    expect(isSensitiveConfigKey("request-token")).toBe(true);
    expect(isSensitiveConfigKey("credentials")).toBe(true);
    expect(isSensitiveConfigKey("apiKeyEnvVar")).toBe(false);
    expect(isSensitiveConfigKey("baseUrl")).toBe(false);
  });

  test("normalizes public config paths and identifies denied sensitive paths", () => {
    expect(normalizeConfigPath("providers.openai.api_base")).toEqual(["providers", "openai", "api_base"]);
    expect(() => normalizeConfigPath("agents..defaults")).toThrow("invalid config path");

    expect(isSensitiveConfigPath("providers.openai.api_key")).toBe(true);
    expect(isSensitiveConfigPath(["knowledge", "rerankApiKey"])).toBe(true);
    expect(isSensitiveConfigPath("agents.defaults.model")).toBe(false);
  });
});
