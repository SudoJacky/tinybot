import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativePluginPicker(options: { invoke?: TauriInvoke } = {}) {
  const invoke = options.invoke ?? tauriInvoke;
  return () => invoke("pick_workspace_directory", {
    options: { title: "Import Agent Plugin folder" },
  }) as Promise<string | null>;
}

export const pickDesktopPluginDirectory = createDesktopNativePluginPicker();
