import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativeCommandHookSource = "global" | "workspace";
export type NativeManagedHookLanguage = "powershell" | "shell";

export type NativeManagedHookMetadata = {
  id: string;
  name: string;
  language: NativeManagedHookLanguage;
  manifestPath: string;
  scriptPath: string;
};

export type NativeManagedHookTestResult = {
  id: string;
  event: NativeCommandHookSummary["event"];
  decision: string;
  durationMs: number;
  deniedReason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
  systemMessage?: string;
  toolFeedback?: string;
  failure?: string;
};

export type NativeManagedHookScript = {
  id: string;
  name: string;
  language: NativeManagedHookLanguage;
  path: string;
  contents: string;
  revision: string;
};

export type NativeCommandHookSummary = {
  hash: string;
  event: "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "PostCompact";
  matcher?: string;
  command: string;
  statusMessage?: string;
  timeout: number;
  source: NativeCommandHookSource;
  sourcePath: string;
  trusted: boolean;
  enabled: boolean;
  managed?: NativeManagedHookMetadata;
};

export type NativeCommandHookDiagnostic = {
  level: "warning" | "error";
  code: string;
  message: string;
  path: string;
};

export type NativeCommandHookSnapshot = {
  globalConfigPath: string;
  workspaceConfigPath: string;
  trustStorePath: string;
  templateConfigPath: string;
  templateScriptsPath: string;
  workspaceRoot: string;
  hooks: NativeCommandHookSummary[];
  diagnostics: NativeCommandHookDiagnostic[];
};

export type NativeHooksApi = {
  snapshot(workspacePath?: string): Promise<NativeCommandHookSnapshot>;
  setTrusted(input: { workspacePath?: string; hash: string; trusted: boolean }): Promise<NativeCommandHookSnapshot>;
  saveManaged(input: {
    workspacePath: string;
    id?: string;
    name: string;
    event: NativeCommandHookSummary["event"];
    matcher?: string;
    language: NativeManagedHookLanguage;
    enabled: boolean;
    timeout: number;
  }): Promise<NativeCommandHookSnapshot>;
  testManaged(input: { workspacePath: string; id: string }): Promise<NativeManagedHookTestResult>;
  archiveManaged(input: { workspacePath: string; id: string }): Promise<NativeCommandHookSnapshot>;
  readManagedScript(input: { workspacePath: string; id: string }): Promise<NativeManagedHookScript>;
  saveManagedScript(input: {
    workspacePath: string;
    id: string;
    contents: string;
    expectedRevision: string;
  }): Promise<NativeManagedHookScript>;
};

export function createDesktopNativeHooksApi(options: { invoke?: TauriInvoke } = {}): NativeHooksApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    snapshot: (workspacePath) => invoke("worker_hooks_snapshot", {
      input: { ...(workspacePath ? { workspacePath } : {}) },
    }) as Promise<NativeCommandHookSnapshot>,
    setTrusted: (input) => invoke("worker_hook_set_trusted", { input }) as Promise<NativeCommandHookSnapshot>,
    saveManaged: (input) => invoke("worker_managed_hook_save", { input }) as Promise<NativeCommandHookSnapshot>,
    testManaged: (input) => invoke("worker_managed_hook_test", { input }) as Promise<NativeManagedHookTestResult>,
    archiveManaged: (input) => invoke("worker_managed_hook_archive", { input }) as Promise<NativeCommandHookSnapshot>,
    readManagedScript: (input) => invoke("worker_managed_hook_script_read", { input }) as Promise<NativeManagedHookScript>,
    saveManagedScript: (input) => invoke("worker_managed_hook_script_save", { input }) as Promise<NativeManagedHookScript>,
  };
}
