import { describe, expect, test, vi } from "vitest";
import { saveDesktopSettingsConfig } from "./desktopSettingsSave";

describe("desktop settings native save bridge", () => {
  test("saves through the native config patch command", async () => {
    const currentConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
    };
    const patch = { agents: { defaults: { model: "gpt-4.1" } } };
    const nativeConfig = {
      agents: { defaults: { model: "gpt-4.1", provider: "openai" } },
    };
    const applyNativeConfigPatch = vi.fn().mockResolvedValue({
      ok: true,
      config: nativeConfig,
      updatedFields: ["agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
    });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
    })).resolves.toEqual({
      config: nativeConfig,
      transport: "native",
      updatedFields: ["agents.defaults.model"],
      applied: ["providerRuntimeChanged"],
      restartRequired: [],
      reloadRequired: [],
      warnings: [],
    });

    expect(applyNativeConfigPatch).toHaveBeenCalledWith(currentConfig, patch);
  });

  test("surfaces native config command failures without an HTTP fallback", async () => {
    const currentConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
    };
    const patch = { agents: { defaults: { model: "gpt-4.1" } } };
    const applyNativeConfigPatch = vi.fn().mockRejectedValue(new Error("command not found"));

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
    })).rejects.toThrow("command not found");

    expect(applyNativeConfigPatch).toHaveBeenCalledWith(currentConfig, patch);
  });

  test("requires the native config patch command", async () => {
    await expect(saveDesktopSettingsConfig({}, {}, {})).rejects.toThrow(
      "native config patch is unavailable",
    );
  });

  test("rejects a stale native config revision", async () => {
    const currentConfig = {
      revision: "hash:old",
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
    };
    const patch = { agents: { defaults: { model: "gpt-4.1" } } };
    const applyNativeConfigPatch = vi.fn().mockResolvedValue({
      ok: false,
      config: currentConfig,
      revision: "hash:new",
      updatedFields: [],
      sideEffects: { applied: [], restartRequired: [], warnings: [] },
      error: "configuration_changed",
    });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
    })).rejects.toThrow("configuration_changed");
  });

  test("preserves native warnings", async () => {
    const currentConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
    };
    const patch = { providers: { openai: { api_base: "https://api.openai.com/v1" } } };
    const nativeConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
      providers: { openai: { api_base: "https://api.openai.com/v1" } },
    };
    const applyNativeConfigPatch = vi.fn().mockResolvedValue({
      ok: true,
      config: nativeConfig,
      updatedFields: ["providers.openai.api_base"],
      sideEffects: {
        applied: ["providerRuntimeChanged"],
        restartRequired: [],
        warnings: ["provider runtime will use the new base URL on the next request"],
      },
    });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
    })).resolves.toEqual({
      config: nativeConfig,
      transport: "native",
      updatedFields: ["providers.openai.api_base"],
      applied: ["providerRuntimeChanged"],
      restartRequired: [],
      reloadRequired: [],
      warnings: ["provider runtime will use the new base URL on the next request"],
    });
  });

  test("returns native persisted revision separately from runtime effects", async () => {
    const currentConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
    };
    const patch = { agents: { defaults: { model: "gpt-4.1" } } };
    const nativeConfig = {
      agents: { defaults: { model: "gpt-4.1", provider: "openai" } },
    };
    const applyNativeConfigPatch = vi.fn().mockResolvedValue({
      ok: true,
      config: nativeConfig,
      revision: "hash:new",
      updatedFields: ["agents.defaults.model"],
      sideEffects: { applied: ["providerRuntimeChanged"], restartRequired: [], warnings: [] },
    });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
    })).resolves.toMatchObject({
      config: nativeConfig,
      transport: "native",
      persistedRevision: "hash:new",
      applied: ["providerRuntimeChanged"],
      restartRequired: [],
      reloadRequired: [],
    });
  });

  test("splits native restart and reload requirements", async () => {
    const currentConfig = {
      agents: { defaults: { workspace: "old" } },
      runtime: { logLevel: "info" },
    };
    const patch = {
      agents: { defaults: { workspace: "new" } },
      runtime: { logLevel: "debug" },
    };
    const nativeConfig = {
      agents: { defaults: { workspace: "new" } },
      runtime: { logLevel: "debug" },
    };
    const applyNativeConfigPatch = vi.fn().mockResolvedValue({
      ok: true,
      config: nativeConfig,
      updatedFields: ["agents.defaults.workspace", "runtime.logLevel"],
      sideEffects: {
        applied: [],
        restartRequired: ["workspaceReloadRequired", "applicationRestartRequired"],
        warnings: [
          "agents.defaults.workspace requires an explicit workspace reload",
          "runtime log level changes require restart",
        ],
      },
    });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
    })).resolves.toMatchObject({
      config: nativeConfig,
      transport: "native",
      updatedFields: ["agents.defaults.workspace", "runtime.logLevel"],
      applied: [],
      restartRequired: ["applicationRestartRequired"],
      reloadRequired: ["workspaceReloadRequired"],
      warnings: [
        "agents.defaults.workspace requires an explicit workspace reload",
        "runtime log level changes require restart",
      ],
    });
  });
});
