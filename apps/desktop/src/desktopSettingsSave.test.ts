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
    })).resolves.toBe(nativeConfig);

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
    })).resolves.toBe(gatewayConfig);

    expect(applyNativeConfigPatch).toHaveBeenCalledWith(currentConfig, patch);
    expect(applyGatewayConfigPatch).toHaveBeenCalledWith(patch);
  });
});
