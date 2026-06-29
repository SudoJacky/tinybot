import { describe, expect, test } from "vitest";

import { normalizeMcpJsonSchema } from "./mcpSchema";

describe("normalizeMcpJsonSchema", () => {
  test("normalizes nullable type arrays and nested properties", () => {
    expect(normalizeMcpJsonSchema({
      type: "object",
      properties: {
        query: { type: ["string", "null"], description: "Search query" },
        filters: {
          type: "array",
          items: { anyOf: [{ type: "null" }, { type: "string" }] },
        },
      },
    })).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Search query", nullable: true },
        filters: {
          type: "array",
          items: { type: "string", nullable: true },
        },
      },
      required: [],
    });
  });

  test("normalizes oneOf nullable branches and falls back for invalid schemas", () => {
    expect(normalizeMcpJsonSchema({
      oneOf: [{ type: "null" }, { type: "number", minimum: 0 }],
      title: "Maybe score",
    })).toEqual({
      title: "Maybe score",
      type: "number",
      minimum: 0,
      nullable: true,
    });

    expect(normalizeMcpJsonSchema(null)).toEqual({ type: "object", properties: {} });
  });
});
