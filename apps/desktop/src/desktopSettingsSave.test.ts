import { describe, expect, test, vi } from "vitest";
import { saveDesktopSettingsConfig } from "./desktopSettingsSave";

describe("desktop settings native save bridge", () => {
  test("saves through native config patch before the Python gateway fallback", async () => {
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
    const applyGatewayConfigPatch = vi.fn().mockResolvedValue({ unreachable: true });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
      applyGatewayConfigPatch,
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
    expect(applyGatewayConfigPatch).not.toHaveBeenCalled();
  });

  test("falls back to the Python gateway PATCH when the native host action is unavailable", async () => {
    const currentConfig = {
      agents: { defaults: { model: "gpt-4.1-mini", provider: "openai" } },
    };
    const patch = { agents: { defaults: { model: "gpt-4.1" } } };
    const gatewayConfig = {
      agents: { defaults: { model: "gpt-4.1", provider: "openai" } },
    };
    const applyNativeConfigPatch = vi.fn().mockRejectedValue(new Error("command not found"));
    const applyGatewayConfigPatch = vi.fn().mockResolvedValue(gatewayConfig);

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
      applyGatewayConfigPatch,
    })).resolves.toEqual({
      config: gatewayConfig,
      transport: "gateway-fallback",
      updatedFields: [],
      applied: [],
      restartRequired: [],
      reloadRequired: [],
      warnings: ["Saved through gateway fallback after native config patch failed: command not found"],
    });

    expect(applyNativeConfigPatch).toHaveBeenCalledWith(currentConfig, patch);
    expect(applyGatewayConfigPatch).toHaveBeenCalledWith(patch);
  });

  test("preserves native warnings without using gateway fallback", async () => {
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
    const applyGatewayConfigPatch = vi.fn().mockResolvedValue({ unreachable: true });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
      applyGatewayConfigPatch,
    })).resolves.toEqual({
      config: nativeConfig,
      transport: "native",
      updatedFields: ["providers.openai.api_base"],
      applied: ["providerRuntimeChanged"],
      restartRequired: [],
      reloadRequired: [],
      warnings: ["provider runtime will use the new base URL on the next request"],
    });

    expect(applyGatewayConfigPatch).not.toHaveBeenCalled();
  });

  test("splits native restart and reload requirements", async () => {
    const currentConfig = {
      agents: { defaults: { workspace: "old" } },
      gateway: { port: 18790 },
    };
    const patch = {
      agents: { defaults: { workspace: "new" } },
      gateway: { port: 18888 },
    };
    const nativeConfig = {
      agents: { defaults: { workspace: "new" } },
      gateway: { port: 18888 },
    };
    const applyNativeConfigPatch = vi.fn().mockResolvedValue({
      ok: true,
      config: nativeConfig,
      updatedFields: ["agents.defaults.workspace", "gateway.port"],
      sideEffects: {
        applied: [],
        restartRequired: ["workspaceReloadRequired", "gatewayRestartRequired"],
        warnings: [
          "agents.defaults.workspace requires an explicit workspace reload",
          "gateway host or port changes require restart",
        ],
      },
    });
    const applyGatewayConfigPatch = vi.fn().mockResolvedValue({ unreachable: true });

    await expect(saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch,
      applyGatewayConfigPatch,
    })).resolves.toMatchObject({
      config: nativeConfig,
      transport: "native",
      updatedFields: ["agents.defaults.workspace", "gateway.port"],
      applied: [],
      restartRequired: ["gatewayRestartRequired"],
      reloadRequired: ["workspaceReloadRequired"],
      warnings: [
        "agents.defaults.workspace requires an explicit workspace reload",
        "gateway host or port changes require restart",
      ],
    });
  });
});
