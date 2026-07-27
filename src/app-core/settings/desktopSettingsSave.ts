import type { DesktopNativeConfigPatchResponse } from "../native/desktopNativeConfigPatch";

export type DesktopSettingsSaveDeps = {
  applyNativeConfigPatch?: (currentConfig: unknown, patch: unknown) => Promise<DesktopNativeConfigPatchResponse>;
};

export type DesktopSettingsSaveTransport = "native";

export type DesktopSettingsSaveResult = {
  config: unknown;
  transport: DesktopSettingsSaveTransport;
  persistedRevision?: string;
  updatedFields: string[];
  applied: string[];
  restartRequired: string[];
  reloadRequired: string[];
  warnings: string[];
};

export async function saveDesktopSettingsConfig(
  currentConfig: unknown,
  patch: unknown,
  deps: DesktopSettingsSaveDeps,
): Promise<DesktopSettingsSaveResult> {
  if (!deps.applyNativeConfigPatch) {
    throw new Error("native config patch is unavailable");
  }
  const result = await deps.applyNativeConfigPatch(currentConfig, patch);
  if (result.ok) {
    return buildNativeSaveResult(result);
  }
  throw new Error(result.error ?? "native config patch failed");
}

function buildNativeSaveResult(result: DesktopNativeConfigPatchResponse): DesktopSettingsSaveResult {
  const restartRequired = result.sideEffects.restartRequired.filter((effect) => effect !== "workspaceReloadRequired");
  const reloadRequired = result.sideEffects.restartRequired.filter((effect) => effect === "workspaceReloadRequired");
  return {
    config: result.config,
    transport: "native",
    persistedRevision: result.revision ?? undefined,
    updatedFields: result.updatedFields,
    applied: result.sideEffects.applied,
    restartRequired,
    reloadRequired,
    warnings: result.sideEffects.warnings,
  };
}
