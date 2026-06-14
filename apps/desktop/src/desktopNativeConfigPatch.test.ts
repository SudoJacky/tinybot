import { describe, expect, test, vi } from "vitest";
import { applyNativeConfigPatch } from "./desktopNativeConfigPatch";

describe("desktop native config patch host action", () => {
  test("builds a TS patch result before invoking the native store command", async () => {
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

    expect(invoke).toHaveBeenCalledWith("apply_config_patch_result", {
      result: expect.objectContaining({
        ok: true,
        updatedFields: ["agents.defaults.model"],
        config: expect.objectContaining({
          agents: expect.objectContaining({
            defaults: expect.objectContaining({ model: "gpt-4.1" }),
          }),
        }),
      }),
    });
  });
});
