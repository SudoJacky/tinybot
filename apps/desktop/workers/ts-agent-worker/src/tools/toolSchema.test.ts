import { describe, expect, test } from "vitest";

import { castJsonSchemaValue, validateJsonSchemaValue } from "./toolSchema";

describe("toolSchema", () => {
  test("casts string primitives using JSON schema types", () => {
    const schema = {
      type: "object",
      properties: {
        count: { type: "integer" },
        score: { type: "number" },
        enabled: { type: "boolean" },
        label: { type: "string" },
      },
    };

    expect(castJsonSchemaValue({ count: "10", score: "0.75", enabled: "yes", label: 42 }, schema)).toEqual({
      count: 10,
      score: 0.75,
      enabled: true,
      label: "42",
    });
  });

  test("casts nested object properties and array items", () => {
    const schema = {
      type: "object",
      properties: {
        filters: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            recursive: { type: "boolean" },
          },
        },
        values: {
          type: "array",
          items: { type: "integer" },
        },
      },
    };

    expect(castJsonSchemaValue({ filters: { limit: "5", recursive: "false" }, values: ["1", "2"] }, schema)).toEqual({
      filters: { limit: 5, recursive: false },
      values: [1, 2],
    });
  });

  test("accepts nullable schema types", () => {
    const schema = {
      type: "object",
      properties: {
        value: { type: ["integer", "null"] },
      },
      required: ["value"],
    };

    expect(validateJsonSchemaValue({ value: null }, schema)).toEqual([]);
  });

  test("validates required fields, enum values, bounds, lengths, and array items", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "slow"] },
        count: { type: "integer", minimum: 1, maximum: 3 },
        title: { type: "string", minLength: 2, maxLength: 4 },
        values: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer" } },
      },
      required: ["mode", "count", "title", "values"],
    };

    expect(validateJsonSchemaValue({ mode: "medium", count: 4, title: "a", values: ["x", 2, 3] }, schema)).toEqual([
      "mode must be one of ['fast', 'slow']",
      "count must be <= 3",
      "title must be at least 2 chars",
      "values must be at most 2 items",
      "values[0] should be integer",
    ]);
  });
});
