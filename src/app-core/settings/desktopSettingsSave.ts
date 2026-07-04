import type { DesktopNativeConfigPatchResponse } from "../native/desktopNativeConfigPatch";

export type DesktopSettingsSaveDeps = {
  applyNativeConfigPatch?: (currentConfig: unknown, patch: unknown) => Promise<DesktopNativeConfigPatchResponse>;
  applyGatewayConfigPatch: (patch: unknown) => Promise<unknown>;
  onNativeFallback?: (error: unknown) => void;
};

export type DesktopSettingsSaveTransport = "native" | "gateway-fallback";

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
  let fallbackError: unknown = null;
  if (deps.applyNativeConfigPatch) {
    let result: DesktopNativeConfigPatchResponse | null = null;
    try {
      result = await deps.applyNativeConfigPatch(currentConfig, patch);
    } catch (error) {
      fallbackError = error;
      deps.onNativeFallback?.(error);
    }
    if (result) {
      if (result.ok) {
        return buildNativeSaveResult(result);
      }
      throw new Error(result.error ?? "native config patch failed");
    }
  }
  const gatewayResult = await deps.applyGatewayConfigPatch(patch);
  return {
    config: unwrapGatewayConfigPatchResult(gatewayResult),
    transport: "gateway-fallback",
    persistedRevision: extractGatewayRevision(gatewayResult),
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
    persistedRevision: result.revision ?? undefined,
    updatedFields: result.updatedFields,
    applied: result.sideEffects.applied,
    restartRequired,
    reloadRequired,
    warnings: result.sideEffects.warnings,
  };
}

function extractGatewayRevision(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = result as { revision?: unknown; configRevision?: unknown; config_revision?: unknown };
  for (const value of [record.revision, record.configRevision, record.config_revision]) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}
