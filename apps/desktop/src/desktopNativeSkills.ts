import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeSkillsApi } from "./gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeSkillsApi(options: { invoke?: TauriInvoke } = {}): NativeSkillsApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_skills_list"),
    detail: (name: string) => invoke("worker_skills_detail", { input: { name } }),
  };
}
