import { describe, expect, test } from "vitest";

import {
  buildKnowledgeGraphExtractionPrompt,
  estimateKnowledgeGraphExtractionTokens,
  parseKnowledgeGraphExtractionJson,
} from "./knowledgeGraphExtraction.ts";

describe("knowledge graph extraction backend", () => {
  test("estimates prompt and completion tokens for a document extraction plan", () => {
    const estimate = estimateKnowledgeGraphExtractionTokens("TinyBot stores local knowledge.", 640);

    expect(estimate).toEqual({
      prompt_tokens: 248,
      completion_tokens: 256,
      total_tokens: 504,
      max_tokens: 640,
      within_budget: true,
    });
  });

  test("builds the strict JSON extraction prompt used by the backend", () => {
    const prompt = buildKnowledgeGraphExtractionPrompt("Knowledge.md", "TinyBot stores knowledge.", 640);

    expect(prompt).toContain("Return strict JSON only");
    expect(prompt).toContain("Token budget for the answer: 640.");
    expect(prompt).toContain("Document: Knowledge.md");
    expect(prompt).toContain("TinyBot stores knowledge.");
  });

  test("parses fenced LLM graph extraction output into normalized entities and relations", () => {
    const result = parseKnowledgeGraphExtractionJson([
      "```json",
      JSON.stringify({
        entities: [{ name: "TinyBot", entity_type: "project", confidence: 2, evidence: [{ quote: "TinyBot stores knowledge.", lineStart: 3 }] }],
        relations: [{ source: "TinyBot", target: "Knowledge", type: "stores", confidence: -1, evidence: [{ text: "TinyBot stores knowledge." }] }],
      }),
      "```",
    ].join("\n"));

    expect(result).toEqual({
      entities: [{
        name: "TinyBot",
        type: "project",
        confidence: 1,
        evidence: [{ text: "TinyBot stores knowledge.", line_start: 3, line_end: 3 }],
      }],
      relations: [{
        source: "TinyBot",
        target: "Knowledge",
        predicate: "stores",
        confidence: 0,
        evidence: [{ text: "TinyBot stores knowledge.", line_start: 1, line_end: 1 }],
      }],
    });
  });
});
