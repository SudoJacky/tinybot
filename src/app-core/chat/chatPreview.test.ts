import { describe, expect, test } from "vitest";
import { safeArtifactPreview } from "./chatPreview";

describe("chat preview", () => {
  test("redacts sensitive fields and renders unsafe artifact payloads inertly", () => {
    expect(safeArtifactPreview({
      authorization: "Bearer token",
      nested: { password: "hunter2", safe: "value" },
    })).toBe('{"authorization":"[redacted]","nested":{"password":"[redacted]","safe":"value"}}');
    expect(safeArtifactPreview({
      html: "<script>alert(1)</script>",
      safe: "value",
      token: "secret",
    })).toBe('{"html":"[unsafe omitted]","safe":"value","token":"[redacted]"}');
  });
});
