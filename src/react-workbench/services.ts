import type { ReactChatMessage } from "./chat/messageActions";
import type { ChatTimelineSnapshot } from "../app-core/chat/agentTimelineModel";
import type { AgentUiForm } from "../app-core/agent-ui/agentUiEvents";
import type {
  WorkspaceDirectoryPage,
  WorkspaceDirectoryRequest,
  WorkspaceFileChunk,
} from "../app-core/workspace/workspaceExplorer";
export type {
  WorkspaceDirectoryEntry,
  WorkspaceDirectoryPage,
  WorkspaceDirectoryRequest,
  WorkspaceFileChunk,
  WorkspaceQueryError,
  WorkspaceQueryErrorCode,
} from "../app-core/workspace/workspaceExplorer";
import type { AgentDefaultsSettingsData } from "../app-core/settings/agentDefaultsSettings";
import type { DesktopChatInput, DesktopCommand } from "../app-core/chat/desktopCommand";
import type { TinyOsCommand } from "../app-core/chat/tinyOsCommand";
import type { TinyOsEffectiveCapabilities } from "../app-core/chat/tinyOsCapabilities";
import type { NativeTerminalRuntimeApi } from "../app-core/native/desktopNativeTerminal";
import type {
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderModelsSettingsData,
} from "../app-core/settings/providerModelsSettings";
import type { DesktopSettingsFormState } from "../app-core/settings/desktopSettingsContracts";
import type {
  DesktopSettingsPaneModel,
  DesktopSettingsPaneSaveDetails,
} from "../app-core/settings/desktopSettingsPaneContracts";
import type { NativeBrowserRuntimeApi } from "../app-core/native/desktopNativeBrowser";
import type { TinyOsNativeBrowserSession, TinyOsNativeSnapshot } from "../app-core/chat/tinyOsNativeSnapshot";
import type {
  DiagnosticBundleExportResult,
  PerformanceTraceSnapshot,
} from "../app-core/native/desktopNativePerformanceTrace";
import type {
  NativeCommandHookSnapshot,
  NativeCommandHookSummary,
  NativeManagedHookLanguage,
} from "../app-core/native/desktopNativeHooks";

export type SessionSummary = {
  id: string;
  chatId?: string;
  title: string;
  updatedAtMs: number;
  pinned?: boolean;
  archived?: boolean;
  status?: "idle" | "running" | "failed";
  workingDirectory?: string;
  model?: string;
  modelProvider?: string;
  projectCoordinator?: boolean;
  projectGroupId?: string;
  pluginMigration?: PluginMigrationSession;
};

export type ProjectGroup = {
  projectGroupId: string;
  name: string;
  workspaceIds: string[];
};

export type ProjectGroupStore = {
  list(): Promise<ProjectGroup[]>;
  save(input: {
    projectGroupId?: string;
    name: string;
    workspaceIds: string[];
  }): Promise<ProjectGroup>;
  delete(projectGroupId: string): Promise<void>;
};

export type ChatInput = DesktopChatInput;

export type ChatEvent = {
  browserSnapshot?: TinyOsNativeSnapshot<TinyOsNativeBrowserSession>;
  type: string;
  command?: TinyOsCommand;
  commandId?: string;
  eventType?: string;
  error?: string;
  message?: ReactChatMessage;
  timeline?: ChatTimelineSnapshot;
};

export type SessionStore = {
  list(): Promise<SessionSummary[]>;
  create(input?: {
    title?: string;
    workingDirectory?: string;
    model?: string;
    modelProvider?: string;
    projectCoordinator?: boolean;
    projectGroupId?: string;
    pluginMigration?: PluginMigrationSession;
  }): Promise<SessionSummary>;
  rename(id: string, title: string): Promise<void>;
  setModel?(id: string, model: string, provider?: string): Promise<void>;
  markPluginMigrationInstalled?(id: string, pluginName: string, enabled: boolean, cleanupWarning?: string): Promise<void>;
  delete(id: string): Promise<void>;
  pin(id: string, pinned: boolean): Promise<void>;
  archive(id: string): Promise<void>;
};

export type ChatStore = {
  browserRuntime?: NativeBrowserRuntimeApi;
  terminalRuntime?: NativeTerminalRuntimeApi;
  load(sessionId: string): Promise<ChatTimelineSnapshot>;
  loadTinyOsCapabilities(threadId: string): Promise<TinyOsEffectiveCapabilities>;
  dispatch(command: DesktopCommand): Promise<void>;
  listAgentUiForms(sessionId: string): Promise<AgentUiForm[]>;
  loadDelegateTrace?(selection: { sessionKey: string; delegateId?: string; traceRef?: string }): Promise<unknown>;
  loadArtifact?(selection: { sessionKey: string; delegateId?: string; traceRef?: string; artifactId: string }): Promise<unknown>;
  branchFromMessage(sessionId: string, messageId: string): Promise<SessionSummary>;
  copyMarkdown(sessionId: string): Promise<string>;
  subscribe(sessionId: string, listener: (event: ChatEvent) => void): () => void;
};

export type WorkspaceFileSummary = {
  path: string;
  size?: number;
  updatedAtMs?: number;
};

export type WorkspaceStore = {
  listFiles(): Promise<WorkspaceFileSummary[]>;
  listDirectory(request: WorkspaceDirectoryRequest): Promise<WorkspaceDirectoryPage>;
  readFile(request: { cursor?: string; path: string }): Promise<WorkspaceFileChunk>;
};

export type MemoryWorkspace = {
  path: string;
  current: boolean;
  memories: string[];
};

export type MemorySnapshot = {
  currentWorkspacePath: string;
  userMemories: string[];
  workspaces: MemoryWorkspace[];
};

export type MemoryStore = {
  load(): Promise<MemorySnapshot>;
};

export type HooksStore = {
  load(workspacePath?: string): Promise<NativeCommandHookSnapshot>;
  setTrusted(input: {
    workspacePath?: string;
    hash: string;
    trusted: boolean;
  }): Promise<NativeCommandHookSnapshot>;
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
};

export type PluginSummary = {
  name: string;
  version?: string;
  description?: string;
  builtIn: boolean;
  enabled: boolean;
  valid: boolean;
  installedAtMs: number;
  sourcePath: string;
  installPath: string;
  skills: Array<{ name: string; qualifiedName: string; description: string }>;
  mcpServers: Array<{ name: string; qualifiedName: string; transport: string }>;
  diagnostics: Array<{ level: "warning" | "error"; code: string; message: string }>;
};

export type PluginMigrationJob = {
  jobId: string;
  workingDirectory: string;
  sourceDirectory: string;
  outputDirectory: string;
  detectedArtifacts: string[];
};

export type PluginMigrationSession = PluginMigrationJob & {
  status: "pending" | "installed";
  installedPluginName?: string;
  installedPluginEnabled?: boolean;
  cleanupWarning?: string;
};

export type PluginMigrationInstallResult = {
  plugin: PluginSummary;
  cleanupWarning?: string;
};

export type ToolSummary = {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  source: string;
  serverId?: string;
  enabled: boolean;
  available: boolean;
  reason?: string;
};

export type McpServerSummary = {
  id: string;
  enabled: boolean;
  transport: string;
  state: string;
  toolCount: number;
  error?: string;
};

export type ToolCatalogSummary = {
  tools: ToolSummary[];
  mcpServers: McpServerSummary[];
};

export type ToolsStore = {
  loadCatalog(): Promise<ToolCatalogSummary>;
  listPlugins(): Promise<PluginSummary[]>;
  installPlugin(path: string): Promise<PluginSummary>;
  preparePluginMigration(path: string): Promise<PluginMigrationJob>;
  installPluginMigration(jobId: string): Promise<PluginMigrationInstallResult>;
  setPluginEnabled(name: string, enabled: boolean): Promise<PluginSummary>;
  uninstallPlugin(name: string): Promise<void>;
};

export type SettingsStore = {
  load(): Promise<Array<{ label: string; value: string }>>;
  loadPersonalizationInstructions?(): Promise<PersonalizationInstructionsData>;
  savePersonalizationInstructions?(input: PersonalizationInstructionsSaveInput): Promise<PersonalizationInstructionsData>;
  loadChatModels?(): Promise<ChatModelOption[]>;
  loadDesktopConfigSettings?(): Promise<DesktopConfigSettingsData>;
  saveDesktopConfigSettings?(currentConfig: unknown, patch: unknown): Promise<DesktopConfigSettingsSaveResult>;
  loadAgentDefaultsSettings?(): Promise<AgentDefaultsSettingsData>;
  saveAgentDefaultsSettings?(currentConfig: unknown, patch: unknown): Promise<AgentDefaultsSettingsData>;
  loadProviderSettings?(): Promise<ProviderModelsSettingsData>;
  fetchProviderModels?(input: ProviderModelFetchInput): Promise<ProviderModelFetchResult>;
  saveProviderSettings?(currentConfig: unknown, patch: unknown): Promise<ProviderModelsSettingsData>;
};

export type PersonalizationInstructionsData = {
  path: "USER.md";
  contents: string;
  updatedAt?: string;
};

export type PersonalizationInstructionsSaveInput = {
  contents: string;
  expectedUpdatedAt?: string;
};

export type DesktopConfigSettingsData = {
  currentConfig: unknown;
  formState: DesktopSettingsFormState;
  pane: DesktopSettingsPaneModel;
};

export type DesktopConfigSettingsSaveResult = DesktopConfigSettingsData & {
  saveDetails: DesktopSettingsPaneSaveDetails;
};

export type ChatModelOption = {
  id: string;
  label: string;
  description?: string;
  providerId?: string;
  providerLabel?: string;
  default?: boolean;
};

export type PerformanceStore = {
  load(): Promise<PerformanceTraceSnapshot>;
  exportDiagnosticBundle(): Promise<DiagnosticBundleExportResult | null>;
};

export type AppServices = {
  sessionStore: SessionStore;
  chatStore: ChatStore;
  memoryStore: MemoryStore;
  projectGroupStore: ProjectGroupStore;
  workspaceStore: WorkspaceStore;
  toolsStore: ToolsStore;
  hooksStore?: HooksStore;
  settingsStore: SettingsStore;
  performanceStore?: PerformanceStore;
};
