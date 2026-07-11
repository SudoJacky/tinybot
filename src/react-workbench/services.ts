import type { ReactChatMessage } from "./chat/messageActions";
import type { ChatTimelineSnapshot } from "../app-core/chat/agentTimelineModel";
import type { AgentUiForm } from "../app-core/agent-ui/agentUiEvents";
import type { AgentDefaultsSettingsData } from "../app-core/settings/agentDefaultsSettings";
import type {
  ProviderModelFetchInput,
  ProviderModelFetchResult,
  ProviderModelsSettingsData,
} from "../app-core/settings/providerModelsSettings";

export type SessionSummary = {
  id: string;
  chatId?: string;
  title: string;
  updatedAtMs: number;
  pinned?: boolean;
  archived?: boolean;
  status?: "idle" | "running" | "waiting_approval" | "failed";
};

export type ChatInput = {
  text: string;
  model?: string;
  usePersistentRag?: boolean;
};

export type ChatEvent = {
  type: string;
  eventType?: string;
  error?: string;
  message?: ReactChatMessage;
  timeline?: ChatTimelineSnapshot;
};

export type ApprovalAction = "approveOnce" | "approveSession" | "deny";

export type ApprovalResolutionInput = {
  action: ApprovalAction;
  approvalId: string;
  guidance?: string;
};

export type SessionStore = {
  list(): Promise<SessionSummary[]>;
  create(input?: { title?: string }): Promise<SessionSummary>;
  rename(id: string, title: string): Promise<void>;
  delete(id: string): Promise<void>;
  pin(id: string, pinned: boolean): Promise<void>;
  archive(id: string): Promise<void>;
};

export type ChatStore = {
  load(sessionId: string): Promise<ChatTimelineSnapshot>;
  send(sessionId: string, input: ChatInput): Promise<void>;
  stop(sessionId: string): Promise<void>;
  resolveApproval(sessionId: string, input: ApprovalResolutionInput): Promise<void>;
  listAgentUiForms(sessionId: string): Promise<AgentUiForm[]>;
  submitAgentUiForm(formId: string, values: Record<string, unknown>): Promise<void>;
  cancelAgentUiForm(formId: string): Promise<void>;
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
};

export type KnowledgeDocumentSummary = {
  id: string;
  title: string;
  source?: string;
  updatedAtMs?: number;
};

export type KnowledgeStore = {
  listDocuments(): Promise<KnowledgeDocumentSummary[]>;
  stats(): Promise<Array<{ label: string; value: string }>>;
};

export type SkillSummary = {
  name: string;
  description?: string;
};

export type ToolsStore = {
  listSkills(): Promise<SkillSummary[]>;
};

export type SettingsStore = {
  load(): Promise<Array<{ label: string; value: string }>>;
  loadChatModels?(): Promise<ChatModelOption[]>;
  loadAgentDefaultsSettings?(): Promise<AgentDefaultsSettingsData>;
  saveAgentDefaultsSettings?(currentConfig: unknown, patch: unknown): Promise<AgentDefaultsSettingsData>;
  loadProviderSettings?(): Promise<ProviderModelsSettingsData>;
  fetchProviderModels?(input: ProviderModelFetchInput): Promise<ProviderModelFetchResult>;
  saveProviderSettings?(currentConfig: unknown, patch: unknown): Promise<ProviderModelsSettingsData>;
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
  knowledgeStore: KnowledgeStore;
  toolsStore: ToolsStore;
  settingsStore: SettingsStore;
};
