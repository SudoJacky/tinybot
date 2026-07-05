import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Copy,
  FolderOpen,
  GitBranch,
  Loader2,
  MoreHorizontal,
  PanelRightOpen,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "lucide-react";
import {
  ClaudeStyleAiInput,
  type ComposerSendOptions,
  type ComposerToolOption,
  type FileWithPreview,
  type ModelOption,
  type PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import type { ChatModelOption, ChatStore, SessionStore, SessionSummary, SettingsStore } from "../services";
import { reduceSessionDeleteState } from "../sessions/sessionDeleteState";
import { canBranchFromMessage, type ContextReferenceSummary, type ReactChatMessage, type ToolCallSummary } from "./messageActions";

export type ChatPageProps = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  settingsStore?: SettingsStore;
  createSessionSignal?: number;
  sessionSidebarCollapsed?: boolean;
  onSessionSidebarCollapsedChange?: (collapsed: boolean) => void;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  now?: () => number;
};

type DrawerState = {
  title: string;
  body: string;
} | null;

const COMPOSER_TOOLS: ComposerToolOption[] = [
  {
    id: "knowledge-rag",
    name: "Knowledge RAG",
    description: "Use uploaded files and knowledge base material",
    enabled: true,
  },
];

const EMPTY_CHAT_PROMPTS = [
  "帮我总结一份文档",
  "帮我搜索资料并整理结论",
  "帮我检查这段代码的问题",
  "帮我把需求拆成可执行任务",
] as const;

const SESSION_DELETE_DISSOLVE_MS = 760;
const SESSION_DELETE_PARTICLE_COUNT = 220;

type SessionDeleteParticle = {
  id: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  size: number;
  delay: number;
};

const SESSION_DELETE_PARTICLES: SessionDeleteParticle[] = Array.from(
  { length: SESSION_DELETE_PARTICLE_COUNT },
  (_, index) => {
    const angle = (index / SESSION_DELETE_PARTICLE_COUNT) * Math.PI * 2 + ((index % 7) - 3) * 0.018;
    const distance = 30 + (index % 9) * 7 + (Math.floor(index / 9) % 4) * 5;

    return {
      id: index,
      originX: 12 + (index * 17) % 76,
      originY: 18 + (index * 11) % 60,
      x: Math.round(Math.cos(angle) * distance * 1.45),
      y: Math.round(Math.sin(angle) * distance * 0.95),
      size: 0.62 + (index % 6) * 0.11,
      delay: (index % 22) * 2.5,
    };
  },
);

export function ChatPage({
  chatStore,
  createSessionSignal = 0,
  now = Date.now,
  onOpenFiles,
  onOpenSettings,
  onSessionSidebarCollapsedChange,
  sessionSidebarCollapsed,
  sessionStore,
  settingsStore,
}: ChatPageProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<ReactChatMessage[]>([]);
  const [loadedMessageSessionId, setLoadedMessageSessionId] = useState("");
  const [composerModels, setComposerModels] = useState<ModelOption[]>([]);
  const [defaultComposerModel, setDefaultComposerModel] = useState("");
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [localSessionSidebarCollapsed, setLocalSessionSidebarCollapsed] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [dissolvingSessionIds, setDissolvingSessionIds] = useState<Set<string>>(() => new Set());
  const [deleteState, dispatchDelete] = useReducer(reduceSessionDeleteState, { confirmingSessionId: "" });
  const sessionsRef = useRef<SessionSummary[]>([]);
  const deleteDissolveTimers = useRef<number[]>([]);
  const lastCreateSessionSignal = useRef(createSessionSignal);
  const resolvedSessionSidebarCollapsed = sessionSidebarCollapsed ?? localSessionSidebarCollapsed;
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions],
  );
  const messagesLoaded = Boolean(activeSession) && loadedMessageSessionId === activeSession?.id;
  const emptyActiveSession = messagesLoaded && messages.length === 0;
  const sessionRunning = activeSession?.status === "running" || activeSession?.status === "waiting_approval";

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    return () => {
      deleteDissolveTimers.current.forEach((timer) => window.clearTimeout(timer));
      deleteDissolveTimers.current = [];
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void sessionStore.list().then((nextSessions) => {
      if (cancelled) {
        return;
      }
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setActiveSessionId((current) => current || nextSessions[0]?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, [sessionStore]);

  useEffect(() => {
    if (createSessionSignal === lastCreateSessionSignal.current) {
      return;
    }
    lastCreateSessionSignal.current = createSessionSignal;
    void handleCreateSession();
  }, [createSessionSignal]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      setLoadedMessageSessionId("");
      return;
    }
    setMessages([]);
    setLoadedMessageSessionId("");
    let cancelled = false;
    const loadMessages = () => chatStore.load(activeSessionId).then((nextMessages) => {
      if (!cancelled) {
        setMessages(nextMessages);
        setLoadedMessageSessionId(activeSessionId);
      }
    });
    void loadMessages();
    const unsubscribe = chatStore.subscribe(activeSessionId, (event) => {
      if (event.message) {
        setMessages((current) => [...current, event.message as ReactChatMessage]);
        return;
      }
      if (shouldReloadSessionsForChatEvent(event.type)) {
        void handleSessionStoreRefresh();
      }
      if (shouldReloadMessagesForChatEvent(event.type)) {
        void loadMessages();
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [activeSessionId, chatStore]);

  useEffect(() => {
    if (!settingsStore?.loadChatModels) {
      setComposerModels([]);
      setDefaultComposerModel("");
      return;
    }
    let cancelled = false;
    void settingsStore.loadChatModels().then((models) => {
      if (cancelled) {
        return;
      }
      const nextModels = models.map(toComposerModelOption);
      setComposerModels(nextModels);
      setDefaultComposerModel(models.find((model) => model.default)?.id ?? nextModels[0]?.id ?? "");
    }).catch(() => {
      if (!cancelled) {
        setComposerModels([]);
        setDefaultComposerModel("");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [settingsStore]);

  async function handleCreateSession() {
    const created = await sessionStore.create();
    setSessions((current) => [created, ...current]);
    setActiveSessionId(created.id);
  }

  async function handleCreateSessionFromSearch() {
    await handleCreateSession();
    setSessionSearchOpen(false);
  }

  async function handleDeleteSession(session: SessionSummary) {
    const next = reduceSessionDeleteState(deleteState, { type: "delete-clicked", sessionId: session.id });
    dispatchDelete({ type: "delete-clicked", sessionId: session.id });
    if (next.confirmedSessionId) {
      await sessionStore.delete(session.id);
      setDissolvingSessionIds((current) => new Set(current).add(session.id));
      const timer = window.setTimeout(() => {
        const remaining = sessionsRef.current.filter((item) => item.id !== session.id);
        sessionsRef.current = remaining;
        setSessions(remaining);
        setActiveSessionId((current) => current === session.id ? remaining[0]?.id ?? "" : current);
        setDissolvingSessionIds((current) => {
          const nextIds = new Set(current);
          nextIds.delete(session.id);
          return nextIds;
        });
      }, SESSION_DELETE_DISSOLVE_MS);
      deleteDissolveTimers.current.push(timer);
    }
  }

  async function handleSessionStoreRefresh() {
    const nextSessions = await sessionStore.list();
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    setActiveSessionId((current) => {
      if (!nextSessions.length) {
        return "";
      }
      return nextSessions.some((session) => session.id === current) ? current : nextSessions[0]?.id ?? "";
    });
  }

  async function handlePinConversation(session: SessionSummary) {
    const pinned = !session.pinned;
    await sessionStore.pin(session.id, pinned);
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, pinned } : item));
    setHeaderMenuOpen(false);
  }

  async function handleRenameConversation(session: SessionSummary) {
    const nextTitle = window.prompt("Rename conversation", session.title)?.trim();
    if (!nextTitle || nextTitle === session.title) {
      setHeaderMenuOpen(false);
      return;
    }
    await sessionStore.rename(session.id, nextTitle);
    setSessions((current) => current.map((item) => item.id === session.id ? { ...item, title: nextTitle } : item));
    setHeaderMenuOpen(false);
  }

  async function handleCopyId(session: SessionSummary) {
    await writeClipboardText(session.id);
    setHeaderMenuOpen(false);
  }

  async function handleCopyMarkdown(session: SessionSummary) {
    await writeClipboardText(await chatStore.copyMarkdown(session.id));
    setHeaderMenuOpen(false);
  }

  async function handleArchiveConversation(session: SessionSummary) {
    await sessionStore.archive(session.id);
    const remaining = sessions.filter((item) => item.id !== session.id);
    setSessions(remaining);
    if (activeSessionId === session.id) {
      setActiveSessionId(remaining[0]?.id ?? "");
    }
    setHeaderMenuOpen(false);
  }

  async function handleBranchFromMessage(session: SessionSummary, messageId: string) {
    const branched = await chatStore.branchFromMessage(session.id, messageId);
    setSessions((current) => [branched, ...current.filter((item) => item.id !== branched.id)]);
    setActiveSessionId(branched.id);
  }

  async function handleComposerSend(
    message: string,
    files: FileWithPreview[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) {
    const text = formatComposerMessage(message, files, pastedContent);
    if (!text || !activeSession) {
      return;
    }
    await chatStore.send(activeSession.id, {
      text,
      ...(options.model ? { model: options.model } : {}),
      ...(typeof options.usePersistentRag === "boolean" ? { usePersistentRag: options.usePersistentRag } : {}),
    });
    await handleSessionStoreRefresh();
  }

  function handleSessionSidebarCollapsedChange(collapsed: boolean) {
    if (sessionSidebarCollapsed === undefined) {
      setLocalSessionSidebarCollapsed(collapsed);
    }
    onSessionSidebarCollapsedChange?.(collapsed);
  }

  function handleSessionSearchSelect(session: SessionSummary) {
    dispatchDelete({ type: "session-selected", sessionId: session.id });
    setActiveSessionId(session.id);
    setSessionSearchOpen(false);
  }

  return (
    <section className="react-chat-page" aria-label="Chat" data-session-sidebar-collapsed={resolvedSessionSidebarCollapsed}>
      <aside className="react-session-list" aria-label="Sessions" data-collapsed={resolvedSessionSidebarCollapsed}>
        <div className="react-session-list__header">
          <div className="react-session-list__title-row">
            <h2>Chats</h2>
            <div className="react-session-list__title-actions">
              <button
                aria-label="Search chats"
                className="react-session-list__search"
                title="Search chats"
                type="button"
                onClick={() => setSessionSearchOpen(true)}
              >
                <Search aria-hidden="true" size={15} />
              </button>
              <button
                aria-label={resolvedSessionSidebarCollapsed ? "Expand session sidebar" : "Collapse session sidebar"}
                className="react-session-list__collapse"
                title={resolvedSessionSidebarCollapsed ? "Expand session sidebar" : "Collapse session sidebar"}
                type="button"
                onClick={() => handleSessionSidebarCollapsedChange(!resolvedSessionSidebarCollapsed)}
              >
                <ChevronLeft aria-hidden="true" data-direction={resolvedSessionSidebarCollapsed ? "expand" : "collapse"} size={16} />
              </button>
            </div>
          </div>
          <button className="react-session-list__new" type="button" onClick={handleCreateSession}>
            <Plus aria-hidden="true" size={15} />
            <span>New Chat</span>
          </button>
        </div>
        <div className="react-session-list__rows" aria-label="Session list rows" data-motion="animated-list">
          {sessions.length ? sessions.map((session, index) => {
            const confirming = deleteState.confirmingSessionId === session.id;
            const dissolving = dissolvingSessionIds.has(session.id);
            return (
              <div
                className="react-session-row"
                data-active={session.id === activeSession?.id}
                data-confirming={confirming}
                data-dissolving={dissolving ? "true" : undefined}
                data-motion-role="item"
                key={session.id}
                onMouseLeave={() => dispatchDelete({ type: "row-left", sessionId: session.id })}
                style={{ "--react-session-row-index": String(index) } as CSSProperties}
              >
                <button
                  aria-label={session.title}
                  className="react-session-row__select"
                  type="button"
                  disabled={dissolving}
                  onClick={() => {
                    dispatchDelete({ type: "session-selected", sessionId: session.id });
                    setActiveSessionId(session.id);
                  }}
                >
                  <span className="react-session-row__avatar" aria-hidden="true">{sessionTitleInitial(session.title)}</span>
                  <span className="react-session-row__title">{session.title}</span>
                  <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
                </button>
                <button
                  aria-label={`${confirming ? "Confirm delete" : "Delete"} ${session.title}`}
                  className="react-session-row__delete"
                  data-confirming={confirming}
                  type="button"
                  disabled={dissolving}
                  onClick={() => void handleDeleteSession(session)}
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
                {dissolving ? (
                  <span className="react-session-row__particles" aria-hidden="true">
                    {SESSION_DELETE_PARTICLES.map((particle) => (
                      <span
                        className="react-session-row__particle"
                        key={particle.id}
                        style={{
                          "--particle-delay": `${particle.delay}ms`,
                          "--particle-origin-x": `${particle.originX}%`,
                          "--particle-origin-y": `${particle.originY}%`,
                          "--particle-size": `${particle.size}px`,
                          "--particle-x": `${particle.x}px`,
                          "--particle-y": `${particle.y}px`,
                        } as CSSProperties}
                      />
                    ))}
                  </span>
                ) : null}
              </div>
            );
          }) : resolvedSessionSidebarCollapsed ? null : <EmptyStateText text="No sessions yet." />}
        </div>
      </aside>

      <main className="react-chat-surface" data-empty-session={emptyActiveSession ? "true" : undefined}>
        <header className="react-chat-header">
          <h1>{activeSession?.title ?? "No session selected"}</h1>
          <div className="react-chat-header__actions">
            <button
              aria-label="Open conversation menu"
              title="Open conversation menu"
              type="button"
              onClick={() => setHeaderMenuOpen((open) => !open)}
            >
              <MoreHorizontal aria-hidden="true" size={18} />
            </button>
            {headerMenuOpen ? (
              <div className="react-menu" role="menu">
                <button role="menuitem" type="button" onClick={() => activeSession && void handlePinConversation(activeSession)}>
                  {activeSession?.pinned ? "Unpin conversation" : "Pin conversation"}
                </button>
                <button role="menuitem" type="button" onClick={() => activeSession && void handleRenameConversation(activeSession)}>Rename conversation</button>
                <button role="menuitem" type="button" onClick={() => activeSession && void handleCopyId(activeSession)}>Copy ID</button>
                <button role="menuitem" type="button" onClick={() => activeSession && void handleCopyMarkdown(activeSession)}>Copy Markdown</button>
                <button role="menuitem" type="button" onClick={() => activeSession && void handleArchiveConversation(activeSession)}>Archive conversation</button>
                <button disabled role="menuitem" type="button">Open side chat</button>
                <button disabled role="menuitem" type="button">Branch <ChevronDown aria-hidden="true" size={14} /></button>
                <button disabled role="menuitem" type="button">Open in new window</button>
              </div>
            ) : null}
          </div>
        </header>

        <div className="react-conversation-view" aria-label="Conversation">
          {activeSession && messages.length > 0 ? messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onBranch={() => void handleBranchFromMessage(activeSession, message.id)}
              onCopy={() => void writeClipboardText(formatMessageForCopy(message))}
              onOpenTool={(toolCall) => setDrawer({
                title: toolCall.name,
                body: formatToolCallDetails(toolCall),
              })}
              sessionRunning={sessionRunning}
            />
          )) : emptyActiveSession ? <EmptyChatStart /> : activeSession ? null : <EmptyStateText text="Select or create a session." />}
        </div>

        <ClaudeStyleAiInput
          className={["react-composer", emptyActiveSession ? "react-composer--raised" : ""].filter(Boolean).join(" ")}
          disabled={!activeSession}
          defaultModel={defaultComposerModel}
          models={composerModels}
          placeholder={emptyActiveSession ? "输入任务，或粘贴/拖入文件" : "Message Tinybot"}
          tools={COMPOSER_TOOLS}
          onSendMessage={(message, files, pastedContent, options) => handleComposerSend(message, files, pastedContent, options)}
        />
      </main>

      {drawer ? (
        <aside className="react-right-drawer" aria-label="Details drawer" data-motion="fade-content" data-state="open">
          <div>
            <h2>{drawer.title}</h2>
            <button aria-label="Close details drawer" type="button" onClick={() => setDrawer(null)}>
              <X aria-hidden="true" size={16} />
            </button>
          </div>
          <p>{drawer.body || "Details placeholder."}</p>
        </aside>
      ) : null}

      {sessionSearchOpen ? (
        <SessionSearchDialog
          activeSessionId={activeSession?.id ?? ""}
          now={now}
          sessions={sessions}
          onClose={() => setSessionSearchOpen(false)}
          onCreateSession={() => void handleCreateSessionFromSearch()}
          onOpenFiles={onOpenFiles}
          onOpenSettings={onOpenSettings}
          onSelectSession={handleSessionSearchSelect}
        />
      ) : null}
    </section>
  );
}

function SessionSearchDialog({
  activeSessionId,
  now,
  onClose,
  onCreateSession,
  onOpenFiles,
  onOpenSettings,
  onSelectSession,
  sessions,
}: {
  activeSessionId: string;
  now: () => number;
  onClose: () => void;
  onCreateSession: () => void;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  onSelectSession: (session: SessionSummary) => void;
  sessions: SessionSummary[];
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions = normalizedQuery
    ? sessions.filter((session) => [session.title, session.chatId ?? "", session.id]
      .some((value) => value.toLowerCase().includes(normalizedQuery)))
    : sessions;
  const recommendations = [
    {
      id: "new-chat",
      label: "New Chat",
      shortcut: "Ctrl+N",
      icon: Plus,
      run: onCreateSession,
    },
    ...(onOpenFiles ? [{
      id: "open-files",
      label: "Open folder",
      shortcut: "Ctrl+O",
      icon: FolderOpen,
      run: () => {
        onOpenFiles();
        onClose();
      },
    }] : []),
    ...(onOpenSettings ? [{
      id: "open-settings",
      label: "Settings",
      shortcut: "Ctrl+,",
      icon: Settings,
      run: () => {
        onOpenSettings();
        onClose();
      },
    }] : []),
  ];

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="react-command-palette-backdrop react-session-search-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section aria-label="Chat search" className="react-command-palette react-session-search-dialog" role="dialog">
        <div className="react-session-search__input-row">
          <Search aria-hidden="true" size={18} />
          <input
            aria-label="Search chats or commands"
            autoFocus
            placeholder="搜索聊天或运行命令"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <div className="react-session-search__section">
          <p>聊天</p>
          <div className="react-session-search__list">
            {filteredSessions.length ? filteredSessions.map((session, index) => (
              <button
                aria-current={session.id === activeSessionId ? "page" : undefined}
                className="react-session-search__item"
                key={session.id}
                type="button"
                onClick={() => onSelectSession(session)}
              >
                <span className="react-session-search__rank">{index + 1}</span>
                <span className="react-session-search__title">{session.title}</span>
                <span className="react-session-search__meta">tinybot</span>
                <kbd>{`Ctrl+${index + 1}`}</kbd>
                <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
              </button>
            )) : <span className="react-session-search__empty">No matching chats.</span>}
          </div>
        </div>
        <div className="react-session-search__section">
          <p>推荐</p>
          <div className="react-session-search__list">
            {recommendations.map((recommendation) => {
              const Icon = recommendation.icon;
              return (
                <button className="react-session-search__item" key={recommendation.id} type="button" onClick={recommendation.run}>
                  <Icon aria-hidden="true" size={17} />
                  <span className="react-session-search__title">{recommendation.label}</span>
                  <kbd>{recommendation.shortcut}</kbd>
                </button>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

function EmptyChatStart() {
  return (
    <section aria-label="Start a new chat" className="react-empty-chat-start" data-empty-session="true">
      <h2>想让 Tinybot 做什么？</h2>
      <PromptCycleText prompts={EMPTY_CHAT_PROMPTS} />
    </section>
  );
}

function PromptCycleText({ prompts }: { prompts: readonly string[] }) {
  return (
    <p aria-label="Prompt suggestions" className="react-prompt-cycle" data-motion="text-type-loop">
      <span className="react-sr-only">{`建议：${prompts.join("；")}`}</span>
      <span aria-hidden="true" className="react-prompt-cycle__visual">
        {prompts.map((prompt, index) => (
          <span
            className="react-prompt-cycle__item"
            key={prompt}
            style={
              {
                "--react-prompt-characters": String(Math.max(prompt.length, 1)),
                "--react-prompt-index": String(index),
              } as CSSProperties
            }
          >
            {prompt}
          </span>
        ))}
      </span>
    </p>
  );
}

function EmptyStateText({ text }: { text: string }) {
  return (
    <p className="react-empty-state">
      <TextType text={text} />
    </p>
  );
}

function TextType({ text }: { text: string }) {
  return (
    <span
      aria-label={text}
      className="react-text-type"
      data-text-type="once"
      style={{ "--react-text-type-characters": String(Math.max(text.length, 1)) } as CSSProperties}
    >
      <span aria-hidden="true" className="react-text-type__text">{text}</span>
    </span>
  );
}

const MESSAGE_RELOAD_EVENT_TYPES = new Set([
  "attached",
  "agent.event",
  "message.delta",
  "message.completed",
  "message.stream.completed",
  "message-sent",
  "interrupted",
]);

const SESSION_RELOAD_EVENT_TYPES = new Set([
  "chat.created",
]);

function shouldReloadMessagesForChatEvent(type: string): boolean {
  return MESSAGE_RELOAD_EVENT_TYPES.has(type);
}

function shouldReloadSessionsForChatEvent(type: string): boolean {
  return SESSION_RELOAD_EVENT_TYPES.has(type);
}

async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
}

function formatComposerMessage(message: string, files: FileWithPreview[], pastedContent: PastedContent[]): string {
  const segments = [message.trim()].filter(Boolean);
  for (const pasted of pastedContent) {
    segments.push(`Pasted content:\n${pasted.content}`);
  }
  if (files.length) {
    segments.push([
      "Attached files:",
      ...files.map((item) => `- ${item.file.name} (${formatComposerFileSize(item.file.size)})`),
    ].join("\n"));
  }
  return segments.join("\n\n");
}

function formatComposerFileSize(bytes: number): string {
  if (bytes === 0) {
    return "0 Bytes";
  }
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function toComposerModelOption(model: ChatModelOption): ModelOption {
  return {
    id: model.id,
    name: model.label || model.id,
    description: model.description || model.providerLabel || "Configured model",
    ...(model.default ? { badge: "Default" } : {}),
  };
}

function MessageBubble({
  message,
  onBranch,
  onCopy,
  onOpenTool,
  sessionRunning,
}: {
  message: ReactChatMessage;
  onBranch: () => void;
  onCopy: () => void;
  onOpenTool: (toolCall: ToolCallSummary) => void;
  sessionRunning: boolean;
}) {
  const actionAlignment = message.role === "user" ? "right" : "left";
  return (
    <article
      className="react-message"
      data-actions-placement="bottom"
      data-role={message.role}
      data-testid={`message-${message.id}`}
    >
      <div className="react-message__body">
        {message.reasoningText ? <MessageReasoning text={message.reasoningText} /> : null}
        <MessageText text={message.text} />
        {message.contextReferences?.length ? <MessageContext references={message.contextReferences} /> : null}
        {message.toolCalls?.length ? <AgentSteps toolCalls={message.toolCalls} onOpenTool={onOpenTool} /> : null}
        {message.status === "streaming" ? <span className="react-message__streaming" aria-label="Agent is responding" /> : null}
      </div>
      <div className="react-message__actions" data-align={actionAlignment}>
        <button aria-label="Copy message" type="button" onClick={onCopy}>
          <Copy aria-hidden="true" size={14} />
        </button>
        {canBranchFromMessage(message, { sessionRunning }) ? (
          <button aria-label="Branch from here" type="button" onClick={onBranch}>
            <GitBranch aria-hidden="true" size={14} />
          </button>
        ) : null}
      </div>
    </article>
  );
}

function MessageReasoning({ text }: { text: string }) {
  return (
    <section className="react-message-reasoning" aria-label="Thinking">
      <h3>Thinking</h3>
      <MessageText text={text} />
    </section>
  );
}

function MessageContext({ references }: { references: ContextReferenceSummary[] }) {
  return (
    <section className="react-message-context" aria-label="Context">
      <h3>Context</h3>
      <ul>
        {references.map((reference) => (
          <li key={reference.id}>
            <span>{reference.title}</span>
            {reference.detail ? <small>{reference.detail}</small> : null}
            {reference.sourcePath ? (
              <small>
                {reference.sourcePath}{typeof reference.sourceLine === "number" ? `:${reference.sourceLine}` : ""}
              </small>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatMessageForCopy(message: ReactChatMessage): string {
  return [
    message.reasoningText ? `Thinking:\n${message.reasoningText}` : "",
    message.text,
    message.contextReferences?.length
      ? `Context:\n${message.contextReferences.map((reference) => (
        [reference.title, reference.detail, reference.sourcePath].filter(Boolean).join(" - ")
      )).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");
}

type AgentStepStatus = "pending" | "active" | "success" | "waiting" | "error";

function AgentSteps({
  onOpenTool,
  toolCalls,
}: {
  onOpenTool: (toolCall: ToolCallSummary) => void;
  toolCalls: ToolCallSummary[];
}) {
  const [expanded, setExpanded] = useState(true);
  const overallStatus = resolveAgentStepsStatus(toolCalls);
  const countLabel = `${toolCalls.length} ${toolCalls.length === 1 ? "step" : "steps"}`;
  const currentStepIndex = resolveCurrentAgentStepIndex(toolCalls);
  return (
    <section className="react-agent-steps" data-status={overallStatus} data-stepper="true">
      <button
        aria-expanded={expanded}
        aria-label={`Agent steps, ${countLabel}`}
        className="react-agent-steps__header"
        type="button"
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="react-agent-steps__header-icon" data-status={overallStatus}>
          <AgentStepIcon status={overallStatus} />
        </span>
        <span className="react-agent-steps__title">Agent steps</span>
        <small>{countLabel}</small>
        {expanded ? <ChevronDown aria-hidden="true" size={15} /> : <ChevronRight aria-hidden="true" size={15} />}
      </button>

      {expanded ? (
        <ol aria-label="Agent steps" className="react-agent-steps__list">
          {toolCalls.map((toolCall, index) => {
            const status = normalizeAgentStepStatus(toolCall.status);
            const isLast = index === toolCalls.length - 1;
            const isCurrent = index === currentStepIndex;
            return (
              <li
                aria-current={isCurrent ? "step" : undefined}
                className="react-agent-step-item"
                data-motion-role="step"
                data-status={status}
                data-step-count={toolCalls.length}
                data-step-index={index}
                key={toolCall.id}
              >
                {!isLast ? <span aria-hidden="true" className="react-agent-step-item__line" /> : null}
                <span className="react-agent-step-item__marker" data-status={status}>
                  <AgentStepIcon status={status} />
                </span>
                <button
                  aria-label={`Open details for ${toolCall.name}`}
                  className="react-agent-step"
                  type="button"
                  onClick={() => onOpenTool(toolCall)}
                >
                  <span className="react-agent-step__content">
                    <span>{toolCall.name}</span>
                    {toolCall.summary ? <small>{toolCall.summary}</small> : null}
                  </span>
                  <small className="react-agent-step__status">{formatAgentStepStatus(toolCall.status)}</small>
                  <PanelRightOpen aria-hidden="true" size={15} />
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

function AgentStepIcon({ status }: { status: AgentStepStatus }) {
  switch (status) {
    case "success":
      return <Check aria-hidden="true" size={14} />;
    case "active":
      return <Loader2 aria-hidden="true" size={14} />;
    case "waiting":
    case "error":
      return <AlertTriangle aria-hidden="true" size={14} />;
    default:
      return <Circle aria-hidden="true" size={12} />;
  }
}

function resolveAgentStepsStatus(toolCalls: ToolCallSummary[]): AgentStepStatus {
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "error")) {
    return "error";
  }
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "waiting")) {
    return "waiting";
  }
  if (toolCalls.some((toolCall) => normalizeAgentStepStatus(toolCall.status) === "active")) {
    return "active";
  }
  if (toolCalls.length && toolCalls.every((toolCall) => normalizeAgentStepStatus(toolCall.status) === "success")) {
    return "success";
  }
  return "pending";
}

function resolveCurrentAgentStepIndex(toolCalls: ToolCallSummary[]): number {
  const activeIndex = toolCalls.findIndex((toolCall) => normalizeAgentStepStatus(toolCall.status) === "active");
  if (activeIndex >= 0) {
    return activeIndex;
  }
  const waitingIndex = toolCalls.findIndex((toolCall) => normalizeAgentStepStatus(toolCall.status) === "waiting");
  if (waitingIndex >= 0) {
    return waitingIndex;
  }
  return -1;
}

function normalizeAgentStepStatus(status: string): AgentStepStatus {
  switch (status.toLowerCase()) {
    case "complete":
    case "completed":
    case "success":
    case "succeeded":
      return "success";
    case "running":
    case "active":
      return "active";
    case "blocked":
    case "waiting_approval":
    case "awaiting_approval":
    case "approval_required":
      return "waiting";
    case "failed":
    case "error":
      return "error";
    default:
      return status ? "pending" : "pending";
  }
}

function formatAgentStepStatus(status: string): string {
  return status.replace(/[_-]+/g, " ");
}

type MessageMarkdownBlock =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "table"; headers: string[]; rows: string[][] };

function MessageText({ text }: { text: string }) {
  const blocks = parseMessageMarkdown(text);
  if (!blocks.length) {
    return null;
  }
  return (
    <div className="react-message-markdown">
      {blocks.map((block, index) => renderMessageMarkdownBlock(block, index))}
    </div>
  );
}

function parseMessageMarkdown(text: string): MessageMarkdownBlock[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MessageMarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) {
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      const headers = parseMarkdownTableRow(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && isMarkdownTableRow(lines[index])) {
        rows.push(parseMarkdownTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: "table", headers, rows });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isMarkdownTableStart(lines, index)) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }

  return blocks;
}

function renderMessageMarkdownBlock(block: MessageMarkdownBlock, index: number): ReactNode {
  if (block.kind === "table") {
    return (
      <div className="react-message-table-wrap" key={`table:${index}`}>
        <table className="react-message-table">
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th key={`${header}:${headerIndex}`} scope="col">
                  {renderInlineMarkdown(header, `table:${index}:header:${headerIndex}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`row:${rowIndex}`}>
                {block.headers.map((_, cellIndex) => (
                  <td key={`cell:${cellIndex}`}>
                    {renderInlineMarkdown(row[cellIndex] ?? "", `table:${index}:row:${rowIndex}:cell:${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <p key={`paragraph:${index}`}>
      {block.lines.map((line, lineIndex) => (
        <span key={`line:${lineIndex}`}>
          {lineIndex > 0 ? <br /> : null}
          {renderInlineMarkdown(line, `paragraph:${index}:line:${lineIndex}`)}
        </span>
      ))}
    </p>
  );
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(<strong key={`${keyPrefix}:strong:${match.index}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(<code key={`${keyPrefix}:code:${match.index}`}>{token.slice(1, -1)}</code>);
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  return isMarkdownTableRow(lines[index])
    && index + 1 < lines.length
    && isMarkdownTableSeparator(lines[index + 1]);
}

function isMarkdownTableRow(line: string): boolean {
  return line.includes("|") && parseMarkdownTableRow(line).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = parseMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function sessionTitleInitial(title: string): string {
  return title.trim().charAt(0).toUpperCase() || "C";
}

function formatToolCallDetails(toolCall: ToolCallSummary): string {
  return [toolCall.status, toolCall.summary].filter(Boolean).join("\n\n");
}
