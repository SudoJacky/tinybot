import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeConfigApi } from "../gateway/gatewayHttpClient";

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type NativeConfigEditorSnapshot = {
  configPath?: string;
  config_path?: string;
  revision?: string;
  explicitPublicConfig?: unknown;
  explicit_public_config?: unknown;
  effectivePublicConfig?: unknown;
  effective_public_config?: unknown;
  origins?: unknown;
  diagnostics?: unknown;
  secretPresence?: unknown;
  secret_presence?: unknown;
};

export function createDesktopNativeConfigApi(options: { invoke?: TauriInvoke } = {}): NativeConfigApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    get: async () => configFromEditorSnapshot(await invoke<NativeConfigEditorSnapshot>("get_config_editor_snapshot")),
  };
}

export function configFromEditorSnapshot(snapshot: NativeConfigEditorSnapshot): unknown {
  const publicConfig = snapshot.effectivePublicConfig
    ?? snapshot.effective_public_config
    ?? snapshot.explicitPublicConfig
    ?? snapshot.explicit_public_config
    ?? {};
  if (!publicConfig || typeof publicConfig !== "object" || Array.isArray(publicConfig)) {
    return publicConfig;
  }
  const revision = typeof snapshot.revision === "string" && snapshot.revision.trim()
    ? snapshot.revision
    : undefined;
  const configPath = typeof snapshot.configPath === "string"
    ? snapshot.configPath
    : typeof snapshot.config_path === "string"
      ? snapshot.config_path
      : undefined;
  return {
    ...(publicConfig as Record<string, unknown>),
    ...(revision ? { revision } : {}),
    configMetadata: {
      ...(revision ? { revision } : {}),
      ...(configPath ? { configPath } : {}),
      origins: snapshot.origins,
      diagnostics: snapshot.diagnostics,
      secretPresence: snapshot.secretPresence ?? snapshot.secret_presence,
    },
  };
}
