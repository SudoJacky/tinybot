import type { ReactChatMessage } from "./chat/messageActions";

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
};

export type ChatEvent = {
  type: string;
  message?: ReactChatMessage;
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
  load(sessionId: string): Promise<ReactChatMessage[]>;
  send(sessionId: string, input: ChatInput): Promise<void>;
  stop(sessionId: string): Promise<void>;
  branchFromMessage(sessionId: string, messageId: string): Promise<SessionSummary>;
  copyMarkdown(sessionId: string): Promise<string>;
  subscribe(sessionId: string, listener: (event: ChatEvent) => void): () => void;
};

export type AppServices = {
  sessionStore: SessionStore;
  chatStore: ChatStore;
};
