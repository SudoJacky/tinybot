import { useEffect, useMemo, useReducer, useState, type FormEvent, type ReactNode } from "react";
import { ChevronDown, Copy, GitBranch, MoreHorizontal, PanelRightOpen, Send, Trash2, X } from "lucide-react";
import { formatRelativeUpdatedTime } from "../lib/relativeTime";
import type { ChatStore, SessionStore, SessionSummary } from "../services";
import { reduceSessionDeleteState } from "../sessions/sessionDeleteState";
import { canBranchFromMessage, type ReactChatMessage, type ToolCallSummary } from "./messageActions";

export type ChatPageProps = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  now?: () => number;
};

type DrawerState = {
  title: string;
  body: string;
} | null;

export function ChatPage({ chatStore, now = Date.now, sessionStore }: ChatPageProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<ReactChatMessage[]>([]);
  const [composerText, setComposerText] = useState("");
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [deleteState, dispatchDelete] = useReducer(reduceSessionDeleteState, { confirmingSessionId: "" });
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? sessions[0],
    [activeSessionId, sessions],
  );
  const sessionRunning = activeSession?.status === "running" || activeSession?.status === "waiting_approval";

  useEffect(() => {
    let cancelled = false;
    void sessionStore.list().then((nextSessions) => {
      if (cancelled) {
        return;
      }
      setSessions(nextSessions);
      setActiveSessionId((current) => current || nextSessions[0]?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, [sessionStore]);

  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    const loadMessages = () => chatStore.load(activeSessionId).then((nextMessages) => {
      if (!cancelled) {
        setMessages(nextMessages);
      }
    });
    void loadMessages();
    const unsubscribe = chatStore.subscribe(activeSessionId, (event) => {
      if (event.message) {
        setMessages((current) => [...current, event.message as ReactChatMessage]);
        return;
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

  async function handleCreateSession() {
    const created = await sessionStore.create();
    setSessions((current) => [created, ...current]);
    setActiveSessionId(created.id);
  }

  async function handleDeleteSession(session: SessionSummary) {
    const next = reduceSessionDeleteState(deleteState, { type: "delete-clicked", sessionId: session.id });
    dispatchDelete({ type: "delete-clicked", sessionId: session.id });
    if (next.confirmedSessionId) {
      await sessionStore.delete(session.id);
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (activeSessionId === session.id) {
        setActiveSessionId(remaining[0]?.id ?? "");
      }
    }
  }

  async function handleSessionStoreRefresh() {
    const nextSessions = await sessionStore.list();
    setSessions(nextSessions);
    setActiveSessionId((current) => current || nextSessions[0]?.id || "");
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

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = composerText.trim();
    if (!text || !activeSession) {
      return;
    }
    await chatStore.send(activeSession.id, { text });
    await handleSessionStoreRefresh();
    setComposerText("");
  }

  return (
    <section className="react-chat-page" aria-label="Chat">
      <aside className="react-session-list" aria-label="Sessions">
        <div className="react-session-list__header">
          <h2>Chats</h2>
          <button type="button" onClick={handleCreateSession}>New Chat</button>
        </div>
        <div className="react-session-list__rows">
          {sessions.length ? sessions.map((session) => {
            const confirming = deleteState.confirmingSessionId === session.id;
            return (
              <div
                className="react-session-row"
                data-active={session.id === activeSession?.id}
                key={session.id}
                onMouseLeave={() => dispatchDelete({ type: "row-left", sessionId: session.id })}
              >
                <button
                  aria-label={session.title}
                  className="react-session-row__select"
                  type="button"
                  onClick={() => {
                    dispatchDelete({ type: "session-selected", sessionId: session.id });
                    setActiveSessionId(session.id);
                  }}
                >
                  <span>{session.title}</span>
                  <small>{formatRelativeUpdatedTime(session.updatedAtMs, now())}</small>
                </button>
                <button
                  aria-label={`${confirming ? "Confirm delete" : "Delete"} ${session.title}`}
                  className="react-session-row__delete"
                  data-confirming={confirming}
                  type="button"
                  onClick={() => void handleDeleteSession(session)}
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </div>
            );
          }) : <p className="react-empty-state">No sessions yet.</p>}
        </div>
      </aside>

      <main className="react-chat-surface">
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
          {activeSession ? messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              onBranch={() => void handleBranchFromMessage(activeSession, message.id)}
              onCopy={() => void writeClipboardText(message.text)}
              onOpenTool={(toolCall) => setDrawer({
                title: toolCall.name,
                body: formatToolCallDetails(toolCall),
              })}
              sessionRunning={sessionRunning}
            />
          )) : <p className="react-empty-state">Select or create a session.</p>}
        </div>

        <form className="react-composer" onSubmit={(event) => void handleSubmit(event)}>
          <label>
            <span className="react-sr-only">Message</span>
            <textarea
              aria-label="Message"
              placeholder="Message Tinybot"
              rows={2}
              value={composerText}
              onChange={(event) => setComposerText(event.currentTarget.value)}
            />
          </label>
          <button aria-label="Send message" disabled={!composerText.trim() || !activeSession} type="submit">
            <Send aria-hidden="true" size={18} />
          </button>
        </form>
      </main>

      {drawer ? (
        <aside className="react-right-drawer" aria-label="Details drawer">
          <div>
            <h2>{drawer.title}</h2>
            <button aria-label="Close details drawer" type="button" onClick={() => setDrawer(null)}>
              <X aria-hidden="true" size={16} />
            </button>
          </div>
          <p>{drawer.body || "Details placeholder."}</p>
        </aside>
      ) : null}
    </section>
  );
}

const MESSAGE_RELOAD_EVENT_TYPES = new Set([
  "attached",
  "chat.created",
  "agent.event",
  "message.delta",
  "message.completed",
  "message.stream.completed",
  "message-sent",
  "interrupted",
]);

function shouldReloadMessagesForChatEvent(type: string): boolean {
  return MESSAGE_RELOAD_EVENT_TYPES.has(type);
}

async function writeClipboardText(value: string): Promise<void> {
  await navigator.clipboard?.writeText(value);
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
  return (
    <article className="react-message" data-role={message.role} data-testid={`message-${message.id}`}>
      <div className="react-message__body">
        <MessageText text={message.text} />
        {message.toolCalls?.map((toolCall) => (
          <button
            aria-label={`Open details for ${toolCall.name}`}
            className="react-tool-row"
            key={toolCall.id}
            type="button"
            onClick={() => onOpenTool(toolCall)}
          >
            <PanelRightOpen aria-hidden="true" size={15} />
            <span className="react-tool-row__content">
              <span>{toolCall.name}</span>
              {toolCall.summary ? <small>{toolCall.summary}</small> : null}
            </span>
            <small>{toolCall.status}</small>
          </button>
        ))}
      </div>
      <div className="react-message__actions">
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

function formatToolCallDetails(toolCall: ToolCallSummary): string {
  return [toolCall.status, toolCall.summary].filter(Boolean).join("\n\n");
}
