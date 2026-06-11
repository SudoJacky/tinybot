import type { DesktopNativeConfigPatchResponse } from "./desktopNativeConfigPatch";

export type DesktopSettingsSaveDeps = {
  applyNativeConfigPatch?: (currentConfig: unknown, patch: unknown) => Promise<DesktopNativeConfigPatchResponse>;
  applyGatewayConfigPatch: (patch: unknown) => Promise<unknown>;
  onNativeFallback?: (error: unknown) => void;
};

export async function saveDesktopSettingsConfig(
  currentConfig: unknown,
  patch: unknown,
  deps: DesktopSettingsSaveDeps,
): Promise<unknown> {
  if (deps.applyNativeConfigPatch) {
    try {
      const result = await deps.applyNativeConfigPatch(currentConfig, patch);
      if (result.ok) {
        return result.config;
      }
      deps.onNativeFallback?.(new Error(result.error ?? "native config patch failed"));
    } catch (error) {
      deps.onNativeFallback?.(error);
    }
  }
  return deps.applyGatewayConfigPatch(patch);
}
