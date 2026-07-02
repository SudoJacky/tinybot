export type BranchableMessage = {
  messageId: string;
  role: string;
  content: string;
  [key: string]: unknown;
};

export type BranchSourceSession = {
  sessionId: string;
  chatId: string;
  title: string;
  messages: BranchableMessage[];
  portableContext: Record<string, unknown>;
  runtimeState: Record<string, unknown>;
};

export type BranchSessionDraft = {
  title: string;
  branchedFromSessionId: string;
  branchedFromMessageId: string;
  messages: BranchableMessage[];
  portableContext: Record<string, unknown>;
  runtimeState: Record<string, never>;
};

export function createBranchSessionDraft(
  source: BranchSourceSession,
  selectedMessageId: string,
): BranchSessionDraft {
  const selectedIndex = source.messages.findIndex((message) => message.messageId === selectedMessageId);
  if (selectedIndex === -1) {
    throw new Error(`Cannot branch from unknown message ${selectedMessageId}`);
  }
  return {
    title: `${source.title} · 分叉`,
    branchedFromSessionId: source.sessionId,
    branchedFromMessageId: selectedMessageId,
    messages: source.messages.slice(0, selectedIndex + 1).map((message) => ({ ...message })),
    portableContext: { ...source.portableContext },
    runtimeState: {},
  };
}
