import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
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
  MAX_QUEUED_INPUTS,
  deleteQueuedInput,
  dispatchNextQueuedInput,
  pauseQueuedInputs,
  resumeNextQueuedInput,
  submitComposerText,
  type SubmitComposerTextResult,
} from "../../app-core/chat/chatInputState";
import type { QueuedInput } from "../../app-core/chat/chatUiProjection";
import {
  ClaudeStyleAiInput,
  type ComposerSendOptions,
  type ComposerToolOption,
  type FileWithPreview,
  type ModelOption,
  type PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { TextType } from "../../components/ui/TextType";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import type { ApprovalAction, ChatEvent, ChatInput, ChatModelOption, ChatStore, SessionStore, SessionSummary, SettingsStore } from "../services";
import { reduceSessionDeleteState } from "../sessions/sessionDeleteState";
import { canBranchFromMessage, canCopyMessage, type ContextReferenceSummary, type ReactChatMessage, type ToolCallSummary } from "./messageActions";
import type { AgentUiForm, AgentUiFormField } from "../../app-core/agent-ui/agentUiEvents";

export type ChatPageProps = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  settingsStore?: SettingsStore;
  createSessionSignal?: number;
  sessionSidebarCollapsed?: boolean;
  onSessionSidebarCollapsedChange?: (collapsed: boolean) => void;
  onStopGenerationTargetChange?: (sessionId: string) => void;
  onOpenFiles?: () => void;
  onOpenSettings?: () => void;
  now?: () => number;
};

type DrawerState = {
  title: string;
  toolCall: ToolCallSummary;
} | null;

type QueuedComposerInput = QueuedInput & Pick<ChatInput, "model" | "usePersistentRag">;

const COMPOSER_TOOLS: ComposerToolOption[] = [
  {
    id: "knowledge-rag",
    name: "Knowledge RAG",
    description: "Use uploaded files and knowledge base material",
    enabled: true,
  },
];

const EMPTY_CHAT_GROUP_INTERVAL_MS = 8000;

const EMPTY_CHAT_START_GROUPS = [
  {
    title: "想让 Tinybot 做什么？",
    prompts: [
      "规划一次旅行行程",
      "比较几款产品并给出建议",
      "整理会议记录和待办",
      "起草一封重要邮件",
    ],
  },
  {
    title: "准备让 Tinybot 接手什么？",
    prompts: [
      "跟进一个复杂任务",
      "把需求拆成执行计划",
      "整理资料并形成简报",
      "检查方案里的遗漏",
    ],
  },
  {
    title: "想让 Tinybot 查清什么？",
    prompts: [
      "查证一个关键问题",
      "梳理一个陌生主题",
      "找出决策需要的信息",
      "汇总不同来源的结论",
    ],
  },
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
  onStopGenerationTargetChange,
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
  const [resolvingApprovalId, setResolvingApprovalId] = useState("");
  const [agentUiForms, setAgentUiForms] = useState<AgentUiForm[]>([]);
  const [queuedInputsBySession, setQueuedInputsBySession] = useState<Map<string, QueuedComposerInput[]>>(() => new Map());
  const [queueMessage, setQueueMessage] = useState("");
  const [dissolvingSessionIds, setDissolvingSessionIds] = useState<Set<string>>(() => new Set());
  const [deleteState, dispatchDelete] = useReducer(reduceSessionDeleteState, { confirmingSessionId: "" });
  const sessionsRef = useRef<SessionSummary[]>([]);
  const queuedInputsRef = useRef<Map<string, QueuedComposerInput[]>>(new Map());
  const queuedInputSequence = useRef(0);
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
  const sessionResponding = sessionRunning && !emptyActiveSession;
  const activeQueuedInputs = activeSession ? queuedInputsBySession.get(activeSession.id) ?? [] : [];

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
    setAgentUiForms([]);
    setLoadedMessageSessionId("");
    let cancelled = false;
    const loadMessages = () => chatStore.load(activeSessionId).then((nextMessages) => {
      if (!cancelled) {
        setMessages(nextMessages);
        setLoadedMessageSessionId(activeSessionId);
      }
    });
    const loadAgentUiForms = () => chatStore.listAgentUiForms(activeSessionId).then((nextForms) => {
      if (!cancelled) {
        setAgentUiForms(nextForms);
      }
    });
    void loadMessages();
    void loadAgentUiForms();
    const unsubscribe = chatStore.subscribe(activeSessionId, (event) => {
      if (shouldReloadSessionsForChatEvent(event)) {
        void handleQueueStateAfterChatEvent(activeSessionId, event);
      }
      if (shouldReloadMessagesForChatEvent(event.type)) {
        void loadMessages();
      }
      if (shouldReloadAgentUiFormsForChatEvent(event.type)) {
        void loadAgentUiForms();
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

  useEffect(() => {
    onStopGenerationTargetChange?.(activeSession && sessionResponding ? activeSession.id : "");
  }, [activeSession?.id, onStopGenerationTargetChange, sessionResponding]);

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

  async function handleSessionStoreRefresh(): Promise<SessionSummary[]> {
    const nextSessions = await sessionStore.list();
    sessionsRef.current = nextSessions;
    setSessions(nextSessions);
    setActiveSessionId((current) => {
      if (!nextSessions.length) {
        return "";
      }
      return nextSessions.some((session) => session.id === current) ? current : nextSessions[0]?.id ?? "";
    });
    return nextSessions;
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
    const queuedResult = submitComposerText({
      approvals: [],
      content: text,
      isRunning: isQueueableRunningSession(activeSession, emptyActiveSession),
      now: nextQueuedInputTimestamp(),
      queuedInputs: activeQueuedInputs,
    });
    if (queuedResult.kind !== "send_message") {
      handleQueuedComposerResult(activeSession.id, queuedResult, options);
      return;
    }
    await chatStore.send(activeSession.id, {
      text: queuedResult.content,
      ...(options.model ? { model: options.model } : {}),
      ...(typeof options.usePersistentRag === "boolean" ? { usePersistentRag: options.usePersistentRag } : {}),
    });
    await handleSessionStoreRefresh();
  }

  function handleQueuedComposerResult(
    sessionId: string,
    result: Exclude<SubmitComposerTextResult, { kind: "send_message" }>,
    options: ComposerSendOptions,
  ) {
    if (result.kind === "queue_limit_reached") {
      setQueueMessage("Already have 5 queued messages. Wait for processing or delete one before sending more.");
      return;
    }
    if (result.kind === "reject_approval_with_guidance") {
      return;
    }
    setQueueMessage("");
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      next.set(sessionId, [...(next.get(sessionId) ?? []), {
        ...result.input,
        ...(options.model ? { model: options.model } : {}),
        ...(typeof options.usePersistentRag === "boolean" ? { usePersistentRag: options.usePersistentRag } : {}),
      }]);
      return next;
    });
  }

  function handleDeleteQueuedInput(sessionId: string, inputId: string) {
    setQueueMessage("");
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      const remaining = deleteQueuedInput(next.get(sessionId) ?? [], inputId);
      if (remaining.length) {
        next.set(sessionId, remaining);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  }

  async function handleStopGeneration(session: SessionSummary) {
    pauseQueuedInputsForSession(session.id);
    await chatStore.stop(session.id);
    await handleSessionStoreRefresh();
  }

  function updateQueuedInputsBySession(
    updater: (current: Map<string, QueuedComposerInput[]>) => Map<string, QueuedComposerInput[]>,
  ) {
    setQueuedInputsBySession((current) => {
      const next = updater(current);
      queuedInputsRef.current = next;
      return next;
    });
  }

  function nextQueuedInputTimestamp(): string {
    const sequence = queuedInputSequence.current;
    queuedInputSequence.current += 1;
    return new Date(now() + sequence).toISOString();
  }

  async function handleQueueStateAfterChatEvent(sessionId: string, event: ChatEvent) {
    const nextSessions = await handleSessionStoreRefresh();
    if (shouldPauseQueuedInputsForChatEvent(event)) {
      pauseQueuedInputsForSession(sessionId);
      return;
    }
    if (!shouldDispatchQueuedInputForChatEvent(event)) {
      return;
    }
    const nextSession = nextSessions.find((session) => session.id === sessionId);
    if (!canDispatchQueuedInputForSession(nextSession)) {
      return;
    }
    await sendNextQueuedInput(sessionId, "normal_completion");
  }

  async function handleResumeQueuedInputs(sessionId: string) {
    await sendNextQueuedInput(sessionId, "manual_resume");
  }

  async function sendNextQueuedInput(sessionId: string, mode: "normal_completion" | "manual_resume") {
    const inputs = queuedInputsRef.current.get(sessionId) ?? [];
    const result = mode === "manual_resume" ? resumeNextQueuedInput(inputs) : dispatchNextQueuedInput(inputs);
    if (!result.nextInput) {
      return;
    }
    await chatStore.send(sessionId, toChatInput(result.nextInput as QueuedComposerInput));
    updateQueuedInputsBySession((current) => {
      const next = new Map(current);
      if (result.remainingInputs.length) {
        next.set(sessionId, result.remainingInputs as QueuedComposerInput[]);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
    await handleSessionStoreRefresh();
  }

  function pauseQueuedInputsForSession(sessionId: string) {
    updateQueuedInputsBySession((current) => {
      const inputs = current.get(sessionId) ?? [];
      if (!inputs.length) {
        return current;
      }
      const next = new Map(current);
      next.set(sessionId, pauseQueuedInputs(inputs) as QueuedComposerInput[]);
      return next;
    });
  }

  async function handleResolveApproval(toolCall: ToolCallSummary, action: ApprovalAction) {
    if (!activeSession || !toolCall.approvalId) {
      return;
    }
    const sessionId = activeSession.id;
    setResolvingApprovalId(toolCall.approvalId);
    try {
      await chatStore.resolveApproval(sessionId, {
        action,
        approvalId: toolCall.approvalId,
      });
      await handleSessionStoreRefresh();
      const nextMessages = await chatStore.load(sessionId);
      setMessages(nextMessages);
      setLoadedMessageSessionId(sessionId);
    } finally {
      setResolvingApprovalId("");
    }
  }

  async function handleSubmitAgentUiForm(form: AgentUiForm, values: Record<string, unknown>) {
    await chatStore.submitAgentUiForm(form.form_id, values);
    if (activeSession) {
      setAgentUiForms(await chatStore.listAgentUiForms(activeSession.id));
    }
  }

  async function handleCancelAgentUiForm(form: AgentUiForm) {
    await chatStore.cancelAgentUiForm(form.form_id);
    if (activeSession) {
      setAgentUiForms(await chatStore.listAgentUiForms(activeSession.id));
    }
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

  const visibleAgentUiForms = agentUiForms.filter(isVisibleAgentUiForm);

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
                toolCall,
              })}
              sessionRunning={sessionRunning}
            />
          )) : emptyActiveSession ? <EmptyChatStart /> : activeSession ? null : <EmptyStateText text="Select or create a session." />}
          {visibleAgentUiForms.length ? (
            <div className="react-agent-ui-forms" aria-label="Agent forms">
              {visibleAgentUiForms.map((form) => (
                <AgentUiFormCard
                  form={form}
                  key={form.form_id}
                  onCancel={() => void handleCancelAgentUiForm(form)}
                  onSubmit={(values) => void handleSubmitAgentUiForm(form, values)}
                />
              ))}
            </div>
          ) : null}
        </div>

        {activeSession && activeQueuedInputs.length ? (
          <QueuedInputsPanel
            inputs={activeQueuedInputs}
            onDelete={(inputId) => handleDeleteQueuedInput(activeSession.id, inputId)}
            onResume={() => void handleResumeQueuedInputs(activeSession.id)}
          />
        ) : null}
        {queueMessage ? <p className="react-queued-inputs__message">{queueMessage}</p> : null}
        <ClaudeStyleAiInput
          className={["react-composer", emptyActiveSession ? "react-composer--raised" : ""].filter(Boolean).join(" ")}
          disabled={!activeSession}
          defaultModel={defaultComposerModel}
          models={composerModels}
          responding={sessionResponding}
          placeholder={emptyActiveSession ? "输入任务，或粘贴/拖入文件" : "Message Tinybot"}
          tools={COMPOSER_TOOLS}
          onSendMessage={(message, files, pastedContent, options) => handleComposerSend(message, files, pastedContent, options)}
          onStopResponding={() => activeSession && handleStopGeneration(activeSession)}
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
          <ToolCallDetails
            resolvingApprovalId={resolvingApprovalId}
            toolCall={drawer.toolCall}
            onResolveApproval={(toolCall, action) => void handleResolveApproval(toolCall, action)}
          />
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
  const [groupIndex, setGroupIndex] = useState(0);
  const group = EMPTY_CHAT_START_GROUPS[groupIndex] ?? EMPTY_CHAT_START_GROUPS[0];

  useEffect(() => {
    const interval = window.setInterval(() => {
      setGroupIndex((current) => (current + 1) % EMPTY_CHAT_START_GROUPS.length);
    }, EMPTY_CHAT_GROUP_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <section aria-label="Start a new chat" className="react-empty-chat-start" data-empty-session="true">
      <h2>
        <TextType
          ariaLabel={group.title}
          className="react-empty-chat-title-type"
          cursorClassName="react-empty-chat-title-type__cursor"
          deletingSpeed={22}
          loop={false}
          pauseDuration={6800}
          showCursor
          text={group.title}
          typingSpeed={34}
        />
      </h2>
      <PromptCycleText prompts={group.prompts} />
    </section>
  );
}

function PromptCycleText({ prompts }: { prompts: readonly string[] }) {
  return (
    <p aria-label="Prompt suggestions" className="react-prompt-cycle" data-motion="text-type-loop">
      <span className="react-sr-only">{`建议：${prompts.join("；")}`}</span>
      <TextType
        ariaHidden
        className="react-prompt-cycle__text-type"
        cursorClassName="react-prompt-cycle__cursor"
        deletingSpeed={24}
        pauseDuration={1350}
        showCursor
        text={prompts}
        typingSpeed={34}
      />
    </p>
  );
}

function EmptyStateText({ text }: { text: string }) {
  return (
    <p className="react-empty-state">
      <TextType ariaLabel={text} className="react-text-type" loop={false} showCursor={false} text={text} />
    </p>
  );
}

const MESSAGE_RELOAD_EVENT_TYPES = new Set([
  "attached",
  "agent.event",
  "message-sent",
  "interrupted",
]);

const SESSION_RELOAD_EVENT_TYPES = new Set([
  "chat.created",
  "interrupted",
]);

const TERMINAL_AGENT_EVENT_TYPES = new Set([
  "agent.turn.completed",
  "agent.turn.failed",
  "agent.turn.interrupted",
]);

function shouldReloadMessagesForChatEvent(type: string): boolean {
  return MESSAGE_RELOAD_EVENT_TYPES.has(type);
}

function shouldReloadSessionsForChatEvent(event: ChatEvent): boolean {
  return SESSION_RELOAD_EVENT_TYPES.has(event.type)
    || (event.type === "agent.event" && Boolean(event.eventType && TERMINAL_AGENT_EVENT_TYPES.has(event.eventType)));
}

function shouldReloadAgentUiFormsForChatEvent(type: string): boolean {
  return type === "agent-ui.form" || type === "agent-ui.event";
}

function shouldDispatchQueuedInputForChatEvent(event: ChatEvent): boolean {
  return event.type === "agent.event" && event.eventType === "agent.turn.completed";
}

function shouldPauseQueuedInputsForChatEvent(event: ChatEvent): boolean {
  return event.type === "interrupted"
    || (event.type === "agent.event" && (
      event.eventType === "agent.turn.failed" || event.eventType === "agent.turn.interrupted"
    ));
}

function canDispatchQueuedInputForSession(session: SessionSummary | undefined): boolean {
  return session?.status !== "running" && session?.status !== "waiting_approval" && session?.status !== "failed";
}

function isQueueableRunningSession(session: SessionSummary, emptyActiveSession: boolean): boolean {
  return session.status === "running" && !emptyActiveSession && !session.id.startsWith("pending:");
}

function toChatInput(input: QueuedComposerInput): ChatInput {
  return {
    text: input.content,
    ...(input.model ? { model: input.model } : {}),
    ...(typeof input.usePersistentRag === "boolean" ? { usePersistentRag: input.usePersistentRag } : {}),
  };
}

function isVisibleAgentUiForm(form: AgentUiForm): boolean {
  return form.status !== "submitted" && form.status !== "cancelled" && form.status !== "expired";
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

function QueuedInputsPanel({
  inputs,
  onDelete,
  onResume,
}: {
  inputs: QueuedInput[];
  onDelete: (inputId: string) => void;
  onResume: () => void;
}) {
  const hasPausedInput = inputs.some((input) => input.status === "paused");
  return (
    <section aria-label="Queued inputs" className="react-queued-inputs">
      <div className="react-queued-inputs__header">
        <h2>Queued inputs</h2>
        <div>
          <span>{inputs.length}/{MAX_QUEUED_INPUTS}</span>
          {hasPausedInput ? <button type="button" onClick={onResume}>Resume queue</button> : null}
        </div>
      </div>
      <ol>
        {inputs.map((input) => (
          <li className="react-queued-input" data-status={input.status} key={input.id}>
            <span>{queuedInputStatusLabel(input)}</span>
            <p>{input.content}</p>
            {input.status === "queued" || input.status === "paused" ? (
              <button type="button" onClick={() => onDelete(input.id)}>Delete queued input</button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function queuedInputStatusLabel(input: QueuedInput): string {
  switch (input.status) {
    case "guided":
      return "Guided";
    case "paused":
      return "Paused";
    case "sent":
      return "Sent";
    default:
      return "Waiting";
  }
}

function AgentUiFormCard({
  form,
  onCancel,
  onSubmit,
}: {
  form: AgentUiForm;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialAgentUiFormValues(form));

  useEffect(() => {
    setValues(initialAgentUiFormValues(form));
  }, [form]);

  function updateValue(field: AgentUiFormField, value: unknown) {
    setValues((current) => ({ ...current, [field.name]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(normalizeAgentUiFormValues(form, values));
  }

  return (
    <form aria-label={form.title || form.form_id} className="react-agent-ui-form-card" onSubmit={handleSubmit}>
      <div className="react-agent-ui-form-card__header">
        <h2>{form.title || "Agent form"}</h2>
        {form.description ? <p>{form.description}</p> : null}
      </div>
      <div className="react-agent-ui-form-card__fields">
        {form.fields.map((field) => (
          <AgentUiFormFieldControl
            field={field}
            key={field.name}
            value={values[field.name]}
            onChange={(value) => updateValue(field, value)}
          />
        ))}
      </div>
      <div className="react-agent-ui-form-card__actions">
        <button type="submit">{form.submit_label || "Submit"}</button>
        <button type="button" onClick={onCancel}>{form.cancel_label || "Cancel"}</button>
      </div>
    </form>
  );
}

function AgentUiFormFieldControl({
  field,
  onChange,
  value,
}: {
  field: AgentUiFormField;
  onChange: (value: unknown) => void;
  value: unknown;
}) {
  const id = `agent-ui-form-${field.name}`;
  const stringValue = value === undefined || value === null ? "" : String(value);
  return (
    <label className="react-agent-ui-form-field" htmlFor={id}>
      <span>{field.label}</span>
      {renderAgentUiFormInput(field, id, stringValue, value, onChange)}
      {field.help ? <small>{field.help}</small> : null}
    </label>
  );
}

function renderAgentUiFormInput(
  field: AgentUiFormField,
  id: string,
  stringValue: string,
  value: unknown,
  onChange: (value: unknown) => void,
): ReactNode {
  if (field.type === "textarea") {
    return (
      <textarea
        id={id}
        maxLength={field.max_length}
        minLength={field.min_length}
        placeholder={field.placeholder}
        required={field.required}
        value={stringValue}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  if (field.type === "select") {
    return (
      <select id={id} required={field.required} value={stringValue} onChange={(event) => onChange(optionValueFromString(field, event.currentTarget.value))}>
        <option value="">Select...</option>
        {(field.options ?? []).map((option) => (
          <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
        ))}
      </select>
    );
  }
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <select
        id={id}
        multiple
        required={field.required}
        value={selected}
        onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions).map((option) => optionValueFromString(field, option.value)))}
      >
        {(field.options ?? []).map((option) => (
          <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
        ))}
      </select>
    );
  }
  if (field.type === "radio") {
    return (
      <span className="react-agent-ui-form-field__choices">
        {(field.options ?? []).map((option) => (
          <label key={String(option.value)}>
            <input
              checked={stringValue === String(option.value)}
              name={field.name}
              required={field.required}
              type="radio"
              value={String(option.value)}
              onChange={(event) => onChange(optionValueFromString(field, event.currentTarget.value))}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </span>
    );
  }
  if (field.type === "checkbox") {
    return (
      <input
        checked={value === true}
        id={id}
        type="checkbox"
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  }
  return (
    <input
      id={id}
      max={field.max}
      maxLength={field.max_length}
      min={field.min}
      minLength={field.min_length}
      pattern={field.pattern}
      placeholder={field.placeholder}
      required={field.required}
      type={inputTypeForAgentUiField(field)}
      value={stringValue}
      onChange={(event) => onChange(field.type === "number" ? event.currentTarget.valueAsNumber : event.currentTarget.value)}
    />
  );
}

function inputTypeForAgentUiField(field: AgentUiFormField): string {
  switch (field.type) {
    case "date":
    case "time":
      return field.type;
    case "datetime":
      return "datetime-local";
    case "number":
      return "number";
    default:
      return "text";
  }
}

function initialAgentUiFormValues(form: AgentUiForm): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of form.fields) {
    if (field.default !== undefined) {
      values[field.name] = field.default;
    }
  }
  return {
    ...values,
    ...(form.initial_values ?? {}),
    ...(form.values ?? {}),
  };
}

function normalizeAgentUiFormValues(form: AgentUiForm, values: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = values[field.name];
    if (field.type === "number") {
      normalized[field.name] = typeof value === "number" && Number.isFinite(value) ? value : undefined;
      continue;
    }
    normalized[field.name] = value;
  }
  return normalized;
}

function optionValueFromString(field: AgentUiFormField, value: string): string | number | boolean {
  return field.options?.find((option) => String(option.value) === value)?.value ?? value;
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
  const showCopyAction = canCopyMessage(message, { sessionRunning });
  const showBranchAction = canBranchFromMessage(message, { sessionRunning });
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
      {showCopyAction || showBranchAction ? (
        <div className="react-message__actions" data-align={actionAlignment}>
          {showCopyAction ? (
            <button aria-label="Copy message" type="button" onClick={onCopy}>
              <Copy aria-hidden="true" size={14} />
            </button>
          ) : null}
          {showBranchAction ? (
            <button aria-label="Branch from here" type="button" onClick={onBranch}>
              <GitBranch aria-hidden="true" size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
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
  return message.text;
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

function ToolCallDetails({
  resolvingApprovalId = "",
  toolCall,
  onResolveApproval,
}: {
  resolvingApprovalId?: string;
  toolCall: ToolCallSummary;
  onResolveApproval?: (toolCall: ToolCallSummary, action: ApprovalAction) => void;
}) {
  const sections = toolCallDetailSections(toolCall);
  if (!sections.length) {
    return <p>Details unavailable.</p>;
  }
  const showApprovalActions = isPendingApprovalToolCall(toolCall) && Boolean(onResolveApproval);
  const resolving = Boolean(toolCall.approvalId && resolvingApprovalId === toolCall.approvalId);
  return (
    <div className="react-tool-detail">
      {showApprovalActions ? (
        <section className="react-tool-detail__approval-actions" aria-label="Approval actions">
          <h3>Approval actions</h3>
          <div>
            <button disabled={resolving} type="button" onClick={() => onResolveApproval?.(toolCall, "approveOnce")}>Approve once</button>
            <button disabled={resolving} type="button" onClick={() => onResolveApproval?.(toolCall, "approveSession")}>Allow for session</button>
            <button disabled={resolving} type="button" onClick={() => onResolveApproval?.(toolCall, "deny")}>Deny</button>
          </div>
        </section>
      ) : null}
      {sections.map((section) => (
        <section key={section.label}>
          <h3>{section.label}</h3>
          <pre>{section.value}</pre>
        </section>
      ))}
    </div>
  );
}

function isPendingApprovalToolCall(toolCall: ToolCallSummary): boolean {
  if (!toolCall.approvalId) {
    return false;
  }
  const status = normalizeAgentStepStatus(toolCall.approvalStatus || toolCall.status);
  return status === "waiting";
}

function toolCallDetailSections(toolCall: ToolCallSummary): Array<{ label: string; value: string }> {
  return [
    { label: "Status", value: toolCall.status },
    { label: "Summary", value: toolCall.summary ?? "" },
    { label: "Arguments", value: toolCall.argsText ?? "" },
    { label: "Response", value: toolCall.responseText ?? "" },
    { label: "Approval", value: formatDetailLines([
      ["ID", toolCall.approvalId],
      ["Status", toolCall.approvalStatus],
    ]) },
    { label: "Delegate", value: formatDetailLines([
      ["Title", toolCall.delegateTitle],
      ["Type", toolCall.delegateType],
      ["Task", toolCall.delegateTask],
      ["ID", toolCall.delegateId],
    ]) },
    { label: "Trace", value: formatDetailLines([
      ["Trace", toolCall.traceRef],
      ["Child run", toolCall.childRunId],
      ["Parent run", toolCall.parentRunId],
      ["Parent turn", toolCall.parentTurnId],
      ["Session", toolCall.sessionKey],
    ]) },
    { label: "Final output", value: toolCall.finalOutput ?? "" },
  ].filter((section) => section.value.trim());
}

function formatDetailLines(rows: Array<[string, string | undefined]>): string {
  return rows
    .filter(([, value]) => Boolean(value?.trim()))
    .map(([label, value]) => `${label}: ${value}`)
    .join("\n");
}
