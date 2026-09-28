import { describe, expect, test, vi } from "vitest";
import { applyNativeConfigPatch } from "../native/desktopNativeConfigPatch";
import { saveDesktopSettingsConfig } from "./desktopSettingsSave";
import { actionFusionSettingsPatch } from "./experimentalSettings";

describe("desktop settings config persistence smoke", () => {
  test("saves only the experimental flag through revision-guarded native operations", async () => {
    const currentConfig = { configMetadata: { revision: "before" }, tools: { exec: { enable: false } } };
    const invoke = vi.fn().mockResolvedValue({
      ok: true, config: { ...currentConfig, experiments: { actionFusion: true } }, revision: "after",
      updatedFields: ["experiments.actionFusion"], sideEffects: { applied: [], restartRequired: [], warnings: [] },
    });
    const result = await saveDesktopSettingsConfig(currentConfig, actionFusionSettingsPatch(true), {
      applyNativeConfigPatch: (config, patch) => applyNativeConfigPatch(config, patch, { invoke }),
    });
    expect(invoke).toHaveBeenCalledWith("apply_config_operations", { request: {
      expectedRevision: "before", operations: [{ op: "replace", path: "experiments.actionFusion", value: true }],
    } });
    expect(result.persistedRevision).toBe("after");
  });
  test("saves canonical operations and preserves pending runtime effects", async () => {
    const currentConfig = {
      revision: "hash:old",
      agents: {
        defaults: {
          model: "deepseek-reasoner",
          timezone: "Asia/Shanghai",
          workspace: "D:/work/old",
        },
      },
      runtime: { logLevel: "info" },
      configMetadata: {
        revision: "hash:old",
        origins: {
          "agents.defaults.model": "default",
          "agents.defaults.timezone": "environment",
          "agents.defaults.workspace": "file",
          "runtime.logLevel": "file",
        },
      },
    };
    const patch = {
      agents: { defaults: { workspace: "D:/work/new" } },
      runtime: { logLevel: "debug" },
    };
    const invoke = vi.fn().mockResolvedValue({
      ok: true,
      config: {
        ...currentConfig,
        revision: "hash:new",
        agents: { defaults: { ...currentConfig.agents.defaults, workspace: "D:/work/new" } },
        runtime: { logLevel: "debug" },
      },
      revision: "hash:new",
      updatedFields: ["agents.defaults.workspace", "runtime.logLevel"],
      sideEffects: {
        applied: [],
        restartRequired: ["workspaceReloadRequired", "applicationRestartRequired"],
        warnings: [],
      },
    });

    const result = await saveDesktopSettingsConfig(currentConfig, patch, {
      applyNativeConfigPatch: (config, nativePatch) => applyNativeConfigPatch(config, nativePatch, { invoke }),
    });

    expect(invoke).toHaveBeenCalledWith("apply_config_operations", {
      request: {
        expectedRevision: "hash:old",
        operations: [
          { op: "replace", path: "agents.defaults.workspace", value: "D:/work/new" },
          { op: "replace", path: "runtime.logLevel", value: "debug" },
        ],
      },
    });
    expect(result).toMatchObject({
      transport: "native",
      persistedRevision: "hash:new",
      updatedFields: ["agents.defaults.workspace", "runtime.logLevel"],
      applied: [],
      restartRequired: ["applicationRestartRequired"],
      reloadRequired: ["workspaceReloadRequired"],
    });

  });
});
