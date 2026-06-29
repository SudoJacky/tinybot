import { describe, expect, test, vi } from "vitest";
import { applyNativeConfigPatch } from "./desktopNativeConfigPatch";

describe("desktop native config patch host action", () => {
  test("sends canonical operations instead of a full config candidate", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {
        agents: { defaults: { model: "gpt-4.1", provider: "openai" } },
        providers: {},
      },
      updatedFields: ["agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      { agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } } },
      { agents: { defaults: { model: "gpt-4.1" } } },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: undefined,
        operations: [
          {
            op: "replace",
            path: "agents.defaults.model",
            value: "gpt-4.1",
          },
        ],
      },
    });
  });

  test("does not send public secret presence metadata as persisted config", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      {
        agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
        providers: {
          openai: {
            provider: "openai",
            api_key_configured: true,
            api_base: "https://api.openai.com/v1",
          },
        },
      },
      { agents: { defaults: { model: "gpt-4.1" } } },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: undefined,
        operations: [
          {
            op: "replace",
            path: "agents.defaults.model",
            value: "gpt-4.1",
          },
        ],
      },
    });
  });

  test("uses explicit secret operations for secret patch values", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["providers.openai.api_key"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      { revision: "hash:old" },
      { providers: { openai: { api_key: "sk-new" } } },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: "hash:old",
        operations: [
          {
            op: "secretReplace",
            path: "providers.openai.api_key",
            value: "sk-new",
          },
        ],
      },
    });
  });

  test("canonicalizes legacy alias paths before sending operations", async () => {
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {},
      updatedFields: ["agents.defaults.maxTokens"],
      sideEffects: { applied: [], restartRequired: [], warnings: [] },
      error: null,
    });

    await applyNativeConfigPatch(
      {},
      { agents: { defaults: { max_tokens: 8192 } } },
      { invoke },
    );

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: undefined,
        operations: [
          {
            op: "replace",
            path: "agents.defaults.maxTokens",
            value: 8192,
          },
        ],
      },
    });
  });
});
