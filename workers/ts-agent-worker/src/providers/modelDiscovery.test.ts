import { describe, expect, test } from "vitest";

import { candidateModelEndpoints, extractModelIds, probeOpenAICompatibleModels } from "./modelDiscovery";

describe("modelDiscovery", () => {
  test("tries base and v1 model endpoints", () => {
    expect(candidateModelEndpoints("https://api.example.test")).toEqual([
      { url: "https://api.example.test/models", resolvedApiBase: "https://api.example.test", usedFallback: false },
      { url: "https://api.example.test/v1/models", resolvedApiBase: "https://api.example.test/v1", usedFallback: true },
    ]);
    expect(candidateModelEndpoints("https://api.example.test/v1")).toEqual([
      { url: "https://api.example.test/v1/models", resolvedApiBase: "https://api.example.test/v1", usedFallback: false },
      { url: "https://api.example.test/models", resolvedApiBase: "https://api.example.test", usedFallback: true },
    ]);
  });

  test("extracts common model response shapes and filters Vercel language tool models", () => {
    expect(extractModelIds({ data: [{ id: "model-a" }, { name: "model-b" }, { model: "model-c" }] })).toEqual([
      "model-a",
      "model-b",
      "model-c",
    ]);
    expect(
      extractModelIds(
        {
          data: [
            { id: "openai/gpt-5.4", type: "language", tags: ["tool-use"] },
            { id: "image-model", type: "image", tags: ["tool-use"] },
            { id: "language-no-tools", type: "language", tags: ["vision"] },
          ],
        },
        "vercel",
      ),
    ).toEqual(["openai/gpt-5.4"]);
  });

  test("probes fallback v1 base when the initial endpoint fails", async () => {
    const calls: string[] = [];

    const result = await probeOpenAICompatibleModels({
      apiBase: "https://api.example.test",
      headers: { Accept: "application/json" },
      fetchJson: async (url) => {
        calls.push(url);
        if (url === "https://api.example.test/models") {
          throw new Error("not found");
        }
        return { data: [{ id: "model-a" }] };
      },
    });

    expect(calls).toEqual(["https://api.example.test/models", "https://api.example.test/v1/models"]);
    expect(result).toEqual({
      models: ["model-a"],
      url: "https://api.example.test/v1/models",
      resolvedApiBase: "https://api.example.test/v1",
      suggestedApiBase: "https://api.example.test/v1",
      usedFallback: true,
    });
  });
});
