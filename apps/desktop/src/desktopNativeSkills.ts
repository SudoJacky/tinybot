import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import type { NativeSkillsApi } from "./gatewayHttpClient";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export function createDesktopNativeSkillsApi(options: { invoke?: TauriInvoke } = {}): NativeSkillsApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_skills_list"),
    detail: (name: string) => invoke("worker_skills_detail", { input: { name } }),
    create: (body: unknown) => invoke("worker_skills_create", { input: { body } }),
    update: (name: string, body: unknown) => invoke("worker_skills_update", { input: { name, body } }),
    delete: (name: string) => invoke("worker_skills_delete", { input: { name } }),
    validate: (name: string) => invoke("worker_skills_validate", { input: { name } }),
  };
}
