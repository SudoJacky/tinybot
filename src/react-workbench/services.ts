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
import type { TinyOsCommand } from "../app-core/chat/tinyOsCommandGateway";
import type { TinyOsEffectiveCapabilities } from "../app-core/chat/tinyOsCapabilities";
import type {
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderModelsSettingsData,
} from "../app-core/settings/providerModelsSettings";
import type {
  DesktopSettingsFormState,
  DesktopSettingsPaneModel,
  DesktopSettingsPaneSaveDetails,
} from "../app-core/settings/desktopSettingsProviders";
import type { NativeBrowserRuntimeApi } from "../app-core/native/desktopNativeBrowser";
import type { TinyOsNativeBrowserSession, TinyOsNativeSnapshot } from "../app-core/chat/tinyOsNativeSnapshot";

export type SessionSummary = {
  id: string;
  chatId?: string;
  title: string;
  updatedAtMs: number;
  pinned?: boolean;
  archived?: boolean;
  status?: "idle" | "running" | "waiting_approval" | "failed";
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
  operationId?: string;
  operationStatus?: "running" | "completed" | "failed" | "cancelled";
  timeline?: ChatTimelineSnapshot;
};

export type ApprovalAction = "approveOnce" | "approveSession" | "deny";

export type SessionStore = {
  list(): Promise<SessionSummary[]>;
  create(input?: { title?: string }): Promise<SessionSummary>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  pin(id: string, pinned: boolean): Promise<void>;
  archive(id: string): Promise<void>;
};

export type ChatStore = {
  browserRuntime?: NativeBrowserRuntimeApi;
  load(sessionId: string): Promise<ChatTimelineSnapshot>;
  loadTinyOsCapabilities(sessionId: string): Promise<TinyOsEffectiveCapabilities>;
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

export type SkillSummary = {
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
  available?: boolean;
  always?: boolean;
  effective?: boolean;
  reason?: string;
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
  approvalRequired: boolean;
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
  listSkills(): Promise<SkillSummary[]>;
};

export type SettingsStore = {
  load(): Promise<Array<{ label: string; value: string }>>;
  loadChatModels?(): Promise<ChatModelOption[]>;
  loadDesktopConfigSettings?(): Promise<DesktopConfigSettingsData>;
  saveDesktopConfigSettings?(currentConfig: unknown, patch: unknown): Promise<DesktopConfigSettingsSaveResult>;
  loadAgentDefaultsSettings?(): Promise<AgentDefaultsSettingsData>;
  saveAgentDefaultsSettings?(currentConfig: unknown, patch: unknown): Promise<AgentDefaultsSettingsData>;
  loadProviderSettings?(): Promise<ProviderModelsSettingsData>;
  fetchProviderModels?(input: ProviderModelFetchInput): Promise<ProviderModelFetchResult>;
  saveProviderSettings?(currentConfig: unknown, patch: unknown): Promise<ProviderModelsSettingsData>;
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

export type AppServices = {
  sessionStore: SessionStore;
  chatStore: ChatStore;
  workspaceStore: WorkspaceStore;
  toolsStore: ToolsStore;
  settingsStore: SettingsStore;
};
