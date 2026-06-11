import { describe, expect, test } from "vitest";

import { applyConfigPatch } from "./configPatch";
import { defaultTinybotConfig, parseTinybotConfig } from "./configSchema";
import { UI_SECRET_PLACEHOLDER } from "./configMasking";

describe("configPatch", () => {
  test("deep merges provider patches without deleting existing providers", () => {
    const current = parseTinybotConfig({
      providers: {
        deepseek: {
          apiKey: "deepseek-key",
          apiBase: "https://deepseek.example/v1",
        },
      },
    });

    const result = applyConfigPatch(current, {
      providers: {
        openrouter: {
          apiKey: "openrouter-key",
          apiBase: "https://openrouter.example/api/v1",
          models: ["openai/gpt-4o-mini"],
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.config.providers.deepseek.apiKey).toBe("deepseek-key");
    expect(result.config.providers.deepseek.apiBase).toBe("https://deepseek.example/v1");
    expect(result.config.providers.openrouter).toMatchObject({
      apiKey: "openrouter-key",
      apiBase: "https://openrouter.example/api/v1",
      models: ["openai/gpt-4o-mini"],
    });
    expect(result.updatedFields).toEqual([
      "providers.openrouter.apiKey",
      "providers.openrouter.apiBase",
      "providers.openrouter.models",
    ]);
  });

  test("skips masked secret placeholders while applying adjacent fields", () => {
    const current = parseTinybotConfig({
      providers: {
        openai: {
          apiKey: "real-openai-key",
          apiBase: "https://old.example/v1",
        },
      },
    });

    const result = applyConfigPatch(current, {
      providers: {
        openai: {
          apiKey: UI_SECRET_PLACEHOLDER,
          apiBase: "https://new.example/v1",
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(result.config.providers.openai.apiKey).toBe("real-openai-key");
    expect(result.config.providers.openai.apiBase).toBe("https://new.example/v1");
    expect(result.updatedFields).toEqual(["providers.openai.apiBase"]);
  });

  test("returns the original config and error when patch validation fails", () => {
    const current = defaultTinybotConfig();

    const result = applyConfigPatch(current, {
      agents: {
        defaults: {
          model: " ",
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.config).toEqual(current);
    expect(result.updatedFields).toEqual([]);
    expect(result.error).toContain("agents.defaults.model");
  });
});
