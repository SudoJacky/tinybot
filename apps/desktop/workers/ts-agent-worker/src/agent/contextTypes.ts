import type { AgentMessage, AgentMessageRole } from "./agentRunSpec.ts";

export const BOOTSTRAP_FILE_ORDER = ["AGENTS.md", "SOUL.md", "USER.md", "TOOLS.md"] as const;

export type TextContentBlock = {
  type: "text";
  text: string;
};

export type MessageContentBlock = Record<string, unknown> & {
  type: string;
};

export type MessageContent = string | MessageContentBlock[];

export type BootstrapFile = {
  path: string;
  contents?: string | null;
};

export type UserProfile = {
  name?: string;
  preferences?: string[];
  mentionedEntities?: string[];
  communicationStyle?: string;
  keyFacts?: string[];
};

export type RuntimeContext = {
  currentTime: string;
  channel?: string;
  chatId?: string;
  userProfile?: UserProfile;
};

export type MemoryRecallNote = {
  id: string;
  scope: string;
  type: string;
  status: string;
  content: string;
  priority?: number;
  confidence?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
  evidenceIds?: string[];
  file?: string;
  line?: number;
  viewFile?: string;
  viewLine?: number;
};

export type MemoryReferenceMetadata = {
  note_id: string;
  scope: string;
  type: string;
  status: string;
  content: string;
  priority: number;
  confidence: number;
  tags: string[];
  metadata: Record<string, unknown>;
  evidence_ids?: string[];
  file?: string;
  line?: number;
  view_file?: string;
  view_line?: number;
};

export type ContextBuildInput = {
  identity: string;
  bootstrapFiles?: BootstrapFile[];
  history?: AgentMessage[];
  memoryNotes?: MemoryRecallNote[];
  currentMessage: string;
  currentRole?: Extract<AgentMessageRole, "user" | "system">;
  runtime: RuntimeContext;
};

export type AgentRunInput = {
  runId: string;
  sessionId: string;
  input: {
    role?: "user" | "system";
    content: string;
    media?: string[];
  };
  channel?: string;
  chatId?: string;
  model?: string;
  maxIterations?: number;
  stream?: boolean;
  contextWindow?: number;
  toolResultBudget?: number;
  temperature?: number;
  maxTokens?: number;
  reasoningEffort?: string;
  failOnToolError?: boolean;
  metadata?: Record<string, unknown>;
};

export type ContextBuildMetadata = {
  bootstrapFiles: string[];
  historyMessageCount: number;
  mergedWithLastMessage: boolean;
  runtimeContextIncluded: boolean;
  memoryContextIncluded: boolean;
  knowledgeContextIncluded: boolean;
  skillsContextIncluded: boolean;
  omittedContext: string[];
  _memory_references?: MemoryReferenceMetadata[];
};

export type ContextBuildResult = {
  messages: AgentMessage[];
  sessionAppendMessages: AgentMessage[];
  metadata: ContextBuildMetadata;
};

export type ContextBridgeMetadata = {
  missingSession: boolean;
  malformedHistoryCount: number;
  missingBootstrapFiles: string[];
  bootstrapFallbackUsed: boolean;
};

export type ContextBridgeLoadResult = {
  input: ContextBuildInput;
  metadata: ContextBridgeMetadata;
};
