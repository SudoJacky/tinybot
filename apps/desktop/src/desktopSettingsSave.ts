import type { DesktopNativeConfigPatchResponse } from "./desktopNativeConfigPatch";

export type DesktopSettingsSaveDeps = {
  applyNativeConfigPatch?: (currentConfig: unknown, patch: unknown) => Promise<DesktopNativeConfigPatchResponse>;
  applyGatewayConfigPatch: (patch: unknown) => Promise<unknown>;
  onNativeFallback?: (error: unknown) => void;
};

export type DesktopSettingsSaveTransport = "native" | "gateway-fallback";

export type DesktopSettingsSaveResult = {
  config: unknown;
  transport: DesktopSettingsSaveTransport;
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
  let fallbackError: unknown = null;
  if (deps.applyNativeConfigPatch) {
    try {
      const result = await deps.applyNativeConfigPatch(currentConfig, patch);
      if (result.ok) {
        return buildNativeSaveResult(result);
      }
      fallbackError = new Error(result.error ?? "native config patch failed");
      deps.onNativeFallback?.(fallbackError);
    } catch (error) {
      fallbackError = error;
      deps.onNativeFallback?.(error);
    }
  }
  const gatewayResult = await deps.applyGatewayConfigPatch(patch);
  return {
    config: unwrapGatewayConfigPatchResult(gatewayResult),
    transport: "gateway-fallback",
    updatedFields: [],
    applied: [],
    restartRequired: [],
    reloadRequired: [],
    warnings: fallbackError ? [`Saved through gateway fallback after native config patch failed: ${stringifyError(fallbackError)}`] : [],
  };
}

function unwrapGatewayConfigPatchResult(result: unknown): unknown {
  if (result && typeof result === "object" && !Array.isArray(result) && "config" in result) {
    return (result as { config?: unknown }).config;
  }
  return result;
}

function buildNativeSaveResult(result: DesktopNativeConfigPatchResponse): DesktopSettingsSaveResult {
  const restartRequired = result.sideEffects.restartRequired.filter((effect) => effect !== "workspaceReloadRequired");
  const reloadRequired = result.sideEffects.restartRequired.filter((effect) => effect === "workspaceReloadRequired");
  return {
    config: result.config,
    transport: "native",
    updatedFields: result.updatedFields,
    applied: result.sideEffects.applied,
    restartRequired,
    reloadRequired,
    warnings: result.sideEffects.warnings,
  };
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}
