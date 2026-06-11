import { describe, expect, test } from "vitest";

import {
  ConfigSnapshotAccessError,
  createPublicConfigSnapshot,
  readPublicConfigPath,
} from "./configSnapshot.ts";

describe("configSnapshot", () => {
  test("creates public snapshots with sensitive descendants redacted", () => {
    const snapshot = createPublicConfigSnapshot({
      agents: { defaults: { model: "gpt-5" } },
      providers: {
        openai: {
          provider: "openai",
          api_key: "sk-secret",
          apiBase: "https://api.test/v1",
        },
      },
    });

    expect(snapshot).toEqual({
      agents: { defaults: { model: "gpt-5" } },
      providers: {
        openai: {
          provider: "openai",
          api_key: null,
          apiBase: "https://api.test/v1",
        },
      },
    });
  });

  test("reads public config paths with descendant redaction and missing nulls", () => {
    const snapshot = {
      providers: {
        openai: {
          provider: "openai",
          api_key: "sk-secret",
          apiBase: "https://api.test/v1",
        },
      },
    };

    expect(readPublicConfigPath(snapshot, "providers.openai")).toEqual({
      path: "providers.openai",
      value: {
        provider: "openai",
        api_key: null,
        apiBase: "https://api.test/v1",
      },
    });
    expect(readPublicConfigPath(snapshot, "providers.deepseek")).toEqual({
      path: "providers.deepseek",
      value: null,
    });
  });

  test("rejects invalid and sensitive config paths", () => {
    expect(() => readPublicConfigPath({}, "providers..openai")).toThrow(ConfigSnapshotAccessError);

    try {
      readPublicConfigPath({ providers: { openai: { api_key: "sk-secret" } } }, "providers.openai.api_key");
      throw new Error("expected sensitive path to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigSnapshotAccessError);
      expect((error as ConfigSnapshotAccessError).code).toBe("sensitive_config_path");
      expect((error as ConfigSnapshotAccessError).path).toBe("providers.openai.api_key");
    }
  });
});
