import { describe, expect, test, vi } from "vitest";
import { applyNativeConfigPatch } from "../native/desktopNativeConfigPatch";
import { saveDesktopSettingsConfig } from "./desktopSettingsSave";
import {
  buildDesktopSettingsFormState,
  buildDesktopSettingsPaneModel,
} from "./desktopSettingsProviders";

describe("desktop settings config persistence smoke", () => {
  test("loads origin metadata, saves canonical operations, and displays pending runtime effects", async () => {
    const currentConfig = {
      revision: "hash:old",
      agents: {
        defaults: {
          model: "deepseek-reasoner",
          timezone: "Asia/Shanghai",
          workspace: "D:/work/old",
        },
      },
      gateway: { port: 18790 },
      configMetadata: {
        revision: "hash:old",
        origins: {
          "agents.defaults.model": "default",
          "agents.defaults.timezone": "environment",
          "agents.defaults.workspace": "file",
          "gateway.port": "file",
        },
      },
    };
    const state = buildDesktopSettingsFormState(currentConfig);
    const initialPane = buildDesktopSettingsPaneModel(state);
    const fields = Object.fromEntries(initialPane.groups.flatMap((group) =>
      group.fields.map((field) => [`${group.id}.${field.id}`, field] as const),
    ));
    expect(fields["general.model"]).toMatchObject({ valueOrigin: "default" });
    expect(fields["general.timezone"]).toMatchObject({ valueOrigin: "environment" });

    const patch = {
      agents: { defaults: { workspace: "D:/work/new" } },
      gateway: { port: 18888 },
    };
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {
        ...currentConfig,
        revision: "hash:new",
        agents: { defaults: { ...currentConfig.agents.defaults, workspace: "D:/work/new" } },
        gateway: { port: 18888 },
      },
      revision: "hash:new",
      updatedFields: ["agents.defaults.workspace", "gateway.port"],
      sideEffects: {
        applied: [],
        restartRequired: ["workspaceReloadRequired", "gatewayRestartRequired"],
        warnings: [],
      },
    });

    const result = await saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch: (config, nativePatch) => applyNativeConfigPatch(config, nativePatch, { invoke }),
      applyGatewayConfigPatch: vi.fn(),
    });

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: "hash:old",
        operations: [
          { op: "replace", path: "agents.defaults.workspace", value: "D:/work/new" },
          { op: "replace", path: "gateway.port", value: 18888 },
        ],
      },
    });
    expect(result).toMatchObject({
      transport: "native",
      persistedRevision: "hash:new",
      updatedFields: ["agents.defaults.workspace", "gateway.port"],
      applied: [],
      restartRequired: ["gatewayRestartRequired"],
      reloadRequired: ["workspaceReloadRequired"],
    });

    const savedPane = buildDesktopSettingsPaneModel(state, {
      lastSavedState: state,
      saveStatus: "saved",
      saveDetails: {
        transport: result.transport,
        persistedRevision: result.persistedRevision,
        updatedFields: result.updatedFields,
        applied: result.applied,
        restartRequired: result.restartRequired,
        reloadRequired: result.reloadRequired,
        warnings: result.warnings,
      },
    });
    expect(savedPane.save.status).toBe("restart-required");
    expect(savedPane.save.message).toBe("Settings persisted. Gateway restart required");
    expect(savedPane.save.diagnostics).toContain("Persisted revision: hash:new");
    expect(savedPane.save.diagnostics).toContain("Applied: none");
    expect(savedPane.save.diagnostics).toContain("Restart required: gatewayRestartRequired");
    expect(savedPane.save.diagnostics).toContain("Reload required: workspaceReloadRequired");
  });

  test("uses gateway fallback only when native invocation is unavailable", async () => {
    const patch = { agents: { defaults: { model: "gpt-4.1" } } };
    const gatewayConfig = {
      revision: "hash:gateway",
      agents: { defaults: { model: "gpt-4.1" } },
    };

    const result = await saveDesktopSettingsConfig({ revision: "hash:old" }, patch, {
      applyNativeConfigPatch: vi.fn().mockRejectedValue(new Error("command not found")),
      applyGatewayConfigPatch: vi.fn().mockResolvedValue({
        config: gatewayConfig,
        revision: "hash:gateway",
      }),
    });

    expect(result).toMatchObject({
      transport: "gateway-fallback",
      persistedRevision: "hash:gateway",
      config: gatewayConfig,
      applied: [],
      restartRequired: [],
      reloadRequired: [],
    });
  });
});
