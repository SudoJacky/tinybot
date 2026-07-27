import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeSkillsApi = {
  list: () => Promise<unknown>;
  detail: (name: string) => Promise<unknown>;
  create: (body: unknown) => Promise<unknown>;
  update: (name: string, body: unknown) => Promise<unknown>;
  delete: (name: string) => Promise<unknown>;
  validate: (name: string) => Promise<unknown>;
};

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
