import type { AgentMessage, AgentMessageRole } from "./agentRunSpec";

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

export type ContextBuildInput = {
  identity: string;
  bootstrapFiles?: BootstrapFile[];
  history?: AgentMessage[];
  currentMessage: string;
  currentRole?: Extract<AgentMessageRole, "user" | "system">;
  runtime: RuntimeContext;
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
};

export type ContextBuildResult = {
  messages: AgentMessage[];
  metadata: ContextBuildMetadata;
};
