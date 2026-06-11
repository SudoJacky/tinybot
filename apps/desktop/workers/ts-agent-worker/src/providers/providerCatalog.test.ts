import { describe, expect, test } from "vitest";

import {
  findCatalogEntry,
  inferProviderFromModel,
  listCatalogEntries,
} from "./providerCatalog";

describe("providerCatalog", () => {
  test("lists catalog entries in provider match priority order", () => {
    const entries = listCatalogEntries();

    expect(entries.length).toBeGreaterThan(5);
    expect(entries[0]?.id).toBe("openai");
    expect(entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "dashscope",
      "openrouter",
      "ollama",
      "opencode",
      "opencode_go",
      "kilocode",
      "huggingface",
      "novita",
      "nvidia",
      "xiaomi",
      "tencent_tokenhub",
      "arcee",
      "gmi",
      "ollama_cloud",
    ]));
  });

  test("finds providers by id, display name, and alias", () => {
    expect(findCatalogEntry("openrouter")?.id).toBe("openrouter");
    expect(findCatalogEntry("OpenRouter")?.id).toBe("openrouter");
    expect(findCatalogEntry("open router")?.id).toBe("openrouter");
    expect(findCatalogEntry("qwen")?.id).toBe("dashscope");
  });

  test("infers providers from explicit prefixes, curated models, and model family prefixes", () => {
    expect(inferProviderFromModel("openai/gpt-5.4-mini")?.id).toBe("openai");
    expect(inferProviderFromModel("moonshot-v1-8k")?.id).toBe("moonshot");
    expect(inferProviderFromModel("glm-4-plus")?.id).toBe("zhipu");
    expect(inferProviderFromModel("qwen-max")?.id).toBe("dashscope");
  });

  test("exposes OpenAI-compatible request traits used by the request builder", () => {
    expect(findCatalogEntry("openai")?.requestTraits).toMatchObject({
      tokenParameter: "max_completion_tokens",
      temperaturePolicy: "omit_for_reasoning",
    });
    expect(findCatalogEntry("openrouter")?.requestTraits).toMatchObject({
      stripModelPrefix: true,
    });
  });
});
