import { invoke as tauriInvoke } from "@tauri-apps/api/core";

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type NativePluginDiagnostic = {
  level: "warning" | "error";
  code: string;
  message: string;
};

export type NativePluginSkillSummary = {
  name: string;
  qualifiedName: string;
  description: string;
};

export type NativePluginMcpSummary = {
  name: string;
  qualifiedName: string;
  transport: string;
};

export type NativePluginSummary = {
  name: string;
  version?: string;
  description?: string;
  enabled: boolean;
  valid: boolean;
  installedAtMs: number;
  sourcePath: string;
  installPath: string;
  skills: NativePluginSkillSummary[];
  mcpServers: NativePluginMcpSummary[];
  diagnostics: NativePluginDiagnostic[];
};

export type NativePluginMigrationJob = {
  jobId: string;
  workingDirectory: string;
  sourceDirectory: string;
  outputDirectory: string;
  detectedArtifacts: string[];
};

export type NativePluginMigrationInstallResult = {
  plugin: NativePluginSummary;
  cleanupWarning?: string;
};

export type NativePluginsApi = {
  list(): Promise<{ plugins: NativePluginSummary[] }>;
  install(path: string): Promise<NativePluginSummary>;
  prepareMigration(path: string): Promise<NativePluginMigrationJob>;
  installMigration(jobId: string): Promise<NativePluginMigrationInstallResult>;
  setEnabled(name: string, enabled: boolean): Promise<NativePluginSummary>;
  uninstall(name: string): Promise<void>;
};

export function createDesktopNativePluginsApi(options: { invoke?: TauriInvoke } = {}): NativePluginsApi {
  const invoke = options.invoke ?? tauriInvoke;
  return {
    list: () => invoke("worker_plugins_list") as Promise<{ plugins: NativePluginSummary[] }>,
    install: (path) => invoke("worker_plugin_install", { input: { path } }) as Promise<NativePluginSummary>,
    prepareMigration: (path) => invoke("worker_plugin_prepare_migration", {
      input: { path },
    }) as Promise<NativePluginMigrationJob>,
    installMigration: (jobId) => invoke("worker_plugin_install_migration", {
      input: { jobId },
    }) as Promise<NativePluginMigrationInstallResult>,
    setEnabled: (name, enabled) => invoke("worker_plugin_set_enabled", {
      input: { enabled, name },
    }) as Promise<NativePluginSummary>,
    uninstall: (name) => invoke("worker_plugin_uninstall", { input: { name } }) as Promise<void>,
  };
}
