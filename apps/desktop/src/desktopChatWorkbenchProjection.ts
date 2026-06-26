import type { DesktopNativeChatModel } from "./desktopWorkbenchShell";
import type { NativeChatMessage, NativeChatSession, NativeChatToolActivity } from "./nativeChat";

export type DesktopChatWorkbenchSessionAction = "open" | "rename" | "pin" | "unpin" | "delete";
export type DesktopChatWorkbenchHeaderAction = "stop" | "metadata" | "new-chat";
export type DesktopChatWorkbenchComposerControl = "attach" | "toggle-rag" | "send" | "interrupt";
export type DesktopChatWorkbenchToolState = "pending" | "approval-pending" | "completed";

export interface DesktopChatWorkbenchContextAttachment {
  id: string;
  label: string;
  scope: "session" | "knowledge" | "workspace";
  detail: string;
}

export interface DesktopChatWorkbenchProjectionInput {
  sessions: NativeChatSession[];
  activeSessionKey: string;
  activeChatId: string;
  messages: NativeChatMessage[];
  responding?: boolean;
  usePersistentRag?: boolean;
  runtime?: DesktopNativeChatModel["runtime"];
  pinnedSessionKeys?: Set<string>;
  searchQuery?: string;
  attachments?: DesktopChatWorkbenchContextAttachment[];
  virtualWindow?: {
    start: number;
    size: number;
  };
  pendingFormIds?: string[];
}

export interface DesktopChatWorkbenchProjection {
  sidebar: {
    search: {
      query: string;
      resultCount: number;
    };
    groups: DesktopChatWorkbenchSessionGroup[];
  };
  header: DesktopChatWorkbenchHeader;
  timeline: DesktopChatWorkbenchTimeline;
  composer: DesktopChatWorkbenchComposer;
}

export interface DesktopChatWorkbenchSessionGroup {
  id: "pinned" | "recent";
  label: string;
  sessions: DesktopChatWorkbenchSessionRow[];
}

export interface DesktopChatWorkbenchSessionRow {
  sessionKey: string;
  chatId: string;
  title: string;
  active: boolean;
  pinned: boolean;
  updatedAt: string;
  badge: string;
  href: string;
  actions: DesktopChatWorkbenchSessionAction[];
}

export interface DesktopChatWorkbenchHeader {
  title: string;
  subtitle: string;
  model: string;
  provider: string;
  knowledgeEnabled: boolean;
  fileScopeLabel: string;
  tokenMeter: {
    label: string;
    ready: boolean;
  };
  responding: boolean;
  actions: DesktopChatWorkbenchHeaderAction[];
}

export interface DesktopChatWorkbenchTimeline {
  total: number;
  window: {
    start: number;
    end: number;
    size: number;
  };
  items: DesktopChatWorkbenchTimelineItem[];
}

export interface DesktopChatWorkbenchTimelineItem {
  id: string;
  role: string;
  content: string;
  reasoningVisible: boolean;
  referenceCount: number;
  toolCards: DesktopChatWorkbenchToolCard[];
  formCards: DesktopChatWorkbenchFormCard[];
}

export interface DesktopChatWorkbenchToolCard {
  id: string;
  name: string;
  state: DesktopChatWorkbenchToolState;
  argsText: string;
  responseText: string;
  inlineApproval: boolean;
}

export interface DesktopChatWorkbenchFormCard {
  id: string;
  state: "pending";
}

export interface DesktopChatWorkbenchComposer {
  state: NonNullable<DesktopNativeChatModel["composerState"]>;
  contextChips: DesktopChatWorkbenchContextAttachment[];
  ragToggle: {
    enabled: boolean;
    label: string;
  };
  controls: DesktopChatWorkbenchComposerControl[];
}

export function buildDesktopChatWorkbenchProjection(
  input: DesktopChatWorkbenchProjectionInput,
): DesktopChatWorkbenchProjection {
  const responding = Boolean(input.responding);
  const activeSession = findActiveSession(input);
  const attachments = input.attachments ?? [];

  return {
    sidebar: buildSidebar(input),
    header: buildHeader(input, activeSession, attachments, responding),
    timeline: buildTimeline(input),
    composer: {
      state: responding ? "sending" : "idle",
      contextChips: attachments.map((attachment) => ({ ...attachment })),
      ragToggle: {
        enabled: Boolean(input.usePersistentRag),
        label: input.usePersistentRag ? "Knowledge on" : "Knowledge off",
      },
      controls: responding ? ["attach", "toggle-rag", "interrupt"] : ["attach", "toggle-rag", "send"],
    },
  };
}

function buildSidebar(input: DesktopChatWorkbenchProjectionInput): DesktopChatWorkbenchProjection["sidebar"] {
  const query = normalizeSearch(input.searchQuery);
  const rows = input.sessions
    .filter((session) => sessionMatchesSearch(session, query))
    .sort(compareSessionsByUpdatedAt)
    .map((session) => sessionRow(session, input));
  const pinned = rows.filter((row) => row.pinned);
  const recent = rows.filter((row) => !row.pinned);
  const groups: DesktopChatWorkbenchSessionGroup[] = [];

  if (pinned.length) {
    groups.push({ id: "pinned", label: "Pinned", sessions: pinned });
  }
  if (recent.length || !groups.length) {
    groups.push({ id: "recent", label: "Recent", sessions: recent });
  }

  return {
    search: {
      query,
      resultCount: rows.length,
    },
    groups,
  };
}

function buildHeader(
  input: DesktopChatWorkbenchProjectionInput,
  activeSession: NativeChatSession | null,
  attachments: DesktopChatWorkbenchContextAttachment[],
  responding: boolean,
): DesktopChatWorkbenchHeader {
  const provider = input.runtime?.provider || "provider";
  const model = input.runtime?.model || "model";

  return {
    title: activeSession?.title || "New session",
    subtitle: `${provider} / ${model}`,
    provider,
    model,
    knowledgeEnabled: Boolean(input.usePersistentRag),
    fileScopeLabel: attachmentScopeLabel(attachments.length),
    tokenMeter: {
      label: input.runtime?.tokenUsage || "No token usage",
      ready: Boolean(input.runtime?.tokenReady),
    },
    responding,
    actions: responding ? ["stop", "metadata", "new-chat"] : ["metadata", "new-chat"],
  };
}

function buildTimeline(input: DesktopChatWorkbenchProjectionInput): DesktopChatWorkbenchTimeline {
  const total = input.messages.length;
  const size = clampWindowSize(input.virtualWindow?.size ?? total, total);
  const start = clampWindowStart(input.virtualWindow?.start ?? 0, total, size);
  const end = Math.min(total, start + size);
  const pendingFormIds = input.pendingFormIds ?? [];
  const items: DesktopChatWorkbenchTimelineItem[] = [];
  let pendingAttached = false;
  const messages = input.messages;
  let localIndex = 0;
  for (let idx = start; idx < end;) {
    const message = messages[idx];
    // Non-assistant messages or final assistant messages are added directly
    if (message.role !== 'assistant' || isFinalAssistantMessage(message)) {
      items.push({
        id: message.messageId || `message-${start + localIndex + 1}`,
        role: message.role,
        content: message.content,
        reasoningVisible: Boolean(message.reasoningContent),
        referenceCount: message.references?.length ?? 0,
        toolCards: (message.toolActivities ?? []).map(toolCard),
        formCards: pendingAttached ? [] : pendingFormIds.map((id) => ({ id, state: "pending" as const })),
      });
      pendingAttached = true;
      idx++;
      localIndex++;
      continue;
    }
    // Collect run-chain messages until a final assistant message is reached
    const chainMessages: NativeChatMessage[] = [];
    while (idx < end && !isFinalAssistantMessage(messages[idx])) {
      chainMessages.push(messages[idx]);
      idx++;
    }
    const aggregatedActivities = chainMessages.flatMap((msg) => msg.toolActivities ?? []);
    const chainId = chainMessages[0]?.messageId || `chain-${start + items.length + 1}`;
    items.push({
      id: chainId,
      role: 'assistant',
      content: '',
      reasoningVisible: false,
      referenceCount: 0,
      toolCards: aggregatedActivities.map(toolCard),
      formCards: pendingAttached ? [] : pendingFormIds.map((id) => ({ id, state: "pending" as const })),
    });
    pendingAttached = true;
    // After collapsing the chain, add the final assistant message if present
    if (idx < end && isFinalAssistantMessage(messages[idx])) {
      const finalMessage = messages[idx];
      items.push({
        id: finalMessage.messageId || `message-${start + items.length + 1}`,
        role: finalMessage.role,
        content: finalMessage.content,
        reasoningVisible: Boolean(finalMessage.reasoningContent),
        referenceCount: finalMessage.references?.length ?? 0,
        toolCards: (finalMessage.toolActivities ?? []).map(toolCard),
        formCards: [],
      });
      idx++;
    }
    localIndex = items.length;
  }
  return {
    total,
    window: { start, end, size },
    items,
  };
}

function sessionRow(
  session: NativeChatSession,
  input: DesktopChatWorkbenchProjectionInput,
): DesktopChatWorkbenchSessionRow {
  const pinned = Boolean(input.pinnedSessionKeys?.has(session.key));
  const messageCount = input.activeSessionKey === session.key ? input.messages.length : 0;
  return {
    sessionKey: session.key,
    chatId: session.chatId,
    title: session.title || "New session",
    active: session.key === input.activeSessionKey || session.chatId === input.activeChatId,
    pinned,
    updatedAt: session.updatedAt,
    badge: messageCount ? `${messageCount} ${messageCount === 1 ? "message" : "messages"}` : "No messages",
    href: `/chat/${encodeURIComponent(session.chatId)}`,
    actions: ["open", "rename", pinned ? "unpin" : "pin", "delete"],
  };
}

function toolCard(activity: NativeChatToolActivity): DesktopChatWorkbenchToolCard {
  const inlineApproval = activity.approvalStatus === "pending";
  return {
    id: activity.id,
    name: activity.name,
    argsText: activity.argsText,
    responseText: activity.responseText,
    inlineApproval,
    state: inlineApproval ? "approval-pending" : activity.responseText ? "completed" : "pending",
  };
}

function findActiveSession(input: DesktopChatWorkbenchProjectionInput): NativeChatSession | null {
  return input.sessions.find((session) => (
    session.key === input.activeSessionKey || session.chatId === input.activeChatId
  )) ?? null;
}

function sessionMatchesSearch(session: NativeChatSession, query: string): boolean {
  if (!query) {
    return true;
  }
  return `${session.title} ${session.chatId}`.toLowerCase().includes(query.toLowerCase());
}

function compareSessionsByUpdatedAt(a: NativeChatSession, b: NativeChatSession): number {
  return Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || "");
}

function normalizeSearch(query: string | undefined): string {
  return (query ?? "").trim();
}

function attachmentScopeLabel(count: number): string {
  return count === 1 ? "1 context item" : `${count} context items`;
}

function clampWindowSize(size: number, total: number): number {
  if (total === 0) {
    return 0;
  }
  return Math.max(1, Math.min(total, Math.floor(size)));
}

function clampWindowStart(start: number, total: number, size: number): number {
  if (total === 0) {
    return 0;
  }
  return Math.max(0, Math.min(Math.floor(start), Math.max(0, total - size)));
}

function hasToolActivities(message: NativeChatMessage): boolean {
  return Boolean(message.toolActivities && message.toolActivities.length > 0);
}

function isFinalAssistantMessage(message: NativeChatMessage): boolean {
  return message.role === 'assistant' && !hasToolActivities(message);
}
