import type {
  ApprovalRequest,
  ArtifactDetail,
  ChatTurn,
  DetailPanelState,
  ErrorDetail,
  ChatUiProjection,
  LiveSubagent,
  QueuedInput,
  SubagentStatus,
  ToolCallSummary,
} from "../../chat/chatUiProjection";
import {
  closeChatDetailPanel,
  type ChatDetailPanelKind,
  openChatDetailPanel,
} from "../../chat/chatDetailPanelState";
import { createBranchSessionDraft } from "../../chat/chatBranchSession";
import {
  resumeNextQueuedInput,
  submitComposerText,
} from "../../chat/chatInputState";
import {
  canSendDirectSubagentMessage,
  createSubagentForwardBlock,
  requiresFirstDirectSubagentMessageConfirmation,
  requiresForwardApprovalGuidanceConfirmation,
} from "../../chat/chatSubagentForward";
import {
  applyLoadedSubagentTrace,
  type SubagentTraceSelection,
} from "../../chat/chatSubagentTranscript";

export type ChatSurfaceOptions = {
  projection: ChatUiProjection;
  loadSubagentTranscript?: (selection: SubagentTraceSelection) => Promise<unknown>;
};

export type MountedChatSurface = {
  update(options: ChatSurfaceOptions): void;
  unmount(): void;
};

let activeDocument: Document;

export function mountChatSurface(host: HTMLElement, options: ChatSurfaceOptions): MountedChatSurface {
  let currentProjection = options.projection;
  let currentDetailPanel = options.projection.detailPanel;
  let currentQueuedInputs = options.projection.queuedInputs;
  let loadSubagentTranscript = options.loadSubagentTranscript;
  let composerError = "";
  let sessionSearchQuery = "";
  const processExpansionOverrides = new Map<string, boolean>();
  const subagentDrafts = new Map<string, string>();
  const loadedSubagents = new Map<string, LiveSubagent>();
  const loadingSubagents = new Set<string>();
  const currentViewProjection = () => projectionWithLoadedSubagents(currentProjection, loadedSubagents);
  const submitSharedComposerText = (content: string) => {
    const result = submitComposerText({
      approvals: currentProjection.approvals,
      content,
      isRunning: chatSurfaceHasRunningTurn(currentProjection),
      now: new Date().toISOString(),
      queuedInputs: currentQueuedInputs,
    });
    if (result.kind === "send_message") {
      composerError = "";
      host.dispatchEvent(new CustomEvent("desktop-chat-message-submit", {
        bubbles: true,
        detail: { content: result.content },
      }));
      logChatSurfaceAction(host, "composer.message.submit", { contentLength: result.content.length });
      return { accepted: true };
    }
    if (result.kind === "reject_approval_with_guidance") {
      composerError = "";
      host.dispatchEvent(new CustomEvent("desktop-chat-approval-guidance-submit", {
        bubbles: true,
        detail: {
          approvalId: result.approvalId,
          guidance: result.guidance,
        },
      }));
      logChatSurfaceAction(host, "composer.approval_guidance.submit", {
        approvalId: result.approvalId,
        guidanceLength: result.guidance.length,
      });
      return { accepted: true };
    }
    if (result.kind === "queue_input") {
      composerError = "";
      currentQueuedInputs = [...currentQueuedInputs, result.input];
      logChatSurfaceAction(host, "composer.queue.add", {
        inputId: result.input.id,
        queueLength: currentQueuedInputs.length,
      });
      renderCurrent();
      return { accepted: true };
    }
    composerError = result.message;
    logChatSurfaceAction(host, "composer.queue.limit", {
      maxQueuedInputs: result.maxQueuedInputs,
    });
    renderCurrent();
    return { accepted: false };
  };
  const handleSharedComposerSubmit = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (!detail || typeof detail.content !== "string") {
      return;
    }
    const result = submitSharedComposerText(detail.content);
    detail.handled = true;
    detail.accepted = result.accepted;
  };
  host.addEventListener("desktop-chat-composer-submit-request", handleSharedComposerSubmit);
  const renderCurrent = () => renderChatSurface(host, {
    ...currentViewProjection(),
    detailPanel: currentDetailPanel,
    queuedInputs: currentQueuedInputs,
  }, sessionSearchQuery, processExpansionOverrides, {
    closeDetail() {
      currentDetailPanel = closeChatDetailPanel(chatSurfaceViewportWidth(host));
      logChatSurfaceAction(host, "detail.close", currentDetailPanel);
      renderCurrent();
    },
    branchFromTurn(turnId) {
      const activeSession = currentProjection.sessions.find((session) => session.key === currentProjection.activeSessionKey);
      if (!activeSession || !currentProjection.branchSource.canBranchSession) {
        logChatSurfaceAction(host, "branch.request.unavailable", { turnId });
        return;
      }
      const draft = createBranchSessionDraft({
        sessionId: currentProjection.activeSessionKey,
        chatId: activeSession.chatId,
        title: activeSession.title,
        messages: currentProjection.turns.map((turn) => ({
          messageId: turn.id,
          role: turn.role,
          content: turn.content,
        })),
        portableContext: {
          chatId: activeSession.chatId,
          sessionKey: currentProjection.activeSessionKey,
        },
        runtimeState: {},
      }, turnId);
      host.dispatchEvent(new CustomEvent("desktop-chat-branch-session-request", {
        bubbles: true,
        detail: draft,
      }));
      logChatSurfaceAction(host, "branch.request", {
        messageCount: draft.messages.length,
        turnId,
      });
    },
    copyTurn(turnId) {
      const turn = currentProjection.turns.find((candidate) => candidate.id === turnId);
      if (!turn) {
        logChatSurfaceAction(host, "message.copy.missing", { turnId });
        return;
      }
      host.dispatchEvent(new CustomEvent("desktop-chat-message-copy", {
        bubbles: true,
        detail: {
          content: turn.content,
          messageId: turn.id,
          role: turn.role,
        },
      }));
      logChatSurfaceAction(host, "message.copy", { turnId });
    },
    copyDetail(content, source) {
      host.dispatchEvent(new CustomEvent("desktop-chat-detail-copy", {
        bubbles: true,
        detail: { content, source },
      }));
      logChatSurfaceAction(host, "detail.copy", {
        contentLength: content.length,
        source,
      });
    },
    openDetail(kind, targetId) {
      currentDetailPanel = openChatDetailPanel(kind, targetId, chatSurfaceViewportWidth(host));
      logChatSurfaceAction(host, "detail.open", currentDetailPanel);
      renderCurrent();
      if (kind === "subagent") {
        void loadCurrentSubagentTrace(targetId);
      }
    },
    openSession(sessionKey, chatId) {
      host.dispatchEvent(new CustomEvent("desktop-chat-session-open", {
        bubbles: true,
        detail: { chatId, sessionKey },
      }));
      logChatSurfaceAction(host, "session.open", { chatId, sessionKey });
    },
    startNewSession() {
      host.dispatchEvent(new CustomEvent("desktop-chat-session-new", {
        bubbles: true,
        detail: {},
      }));
      logChatSurfaceAction(host, "session.new", {});
    },
    submitSubagentMessage(subagentId, content) {
      const subagent = currentViewProjection().liveSubagents.find((candidate) => candidate.id === subagentId);
      const message = content.trim();
      if (!subagent || !message || !canSendDirectSubagentMessage(subagent)) {
        logChatSurfaceAction(host, "subagent.message.ignored", {
          contentLength: message.length,
          subagentId,
        });
        return { accepted: false };
      }
      subagentDrafts.delete(subagentId);
      host.dispatchEvent(new CustomEvent("desktop-chat-subagent-message-submit", {
        bubbles: true,
        detail: {
          ...(subagent.childRunId ? { childRunId: subagent.childRunId } : {}),
          content: message,
          sessionKey: subagent.sessionKey,
          subagentId,
          ...(subagent.traceRef ? { traceRef: subagent.traceRef } : {}),
        },
      }));
      loadedSubagents.set(subagentOverrideKey(subagent), appendDirectSubagentMessage(subagent, message));
      logChatSurfaceAction(host, "subagent.message.submit", {
        contentLength: message.length,
        subagentId,
      });
      renderCurrent();
      return { accepted: true };
    },
    deleteQueuedInput(inputId) {
      currentQueuedInputs = currentQueuedInputs.filter((input) => input.id !== inputId);
      logChatSurfaceAction(host, "composer.queue.delete", { inputId });
      renderCurrent();
    },
    forwardSubagentMessages(subagentId, messageIds) {
      const subagent = currentViewProjection().liveSubagents.find((candidate) => candidate.id === subagentId);
      if (!subagent) {
        logChatSurfaceAction(host, "subagent.forward.missing", { subagentId });
        return;
      }
      const selectedIds = messageIds.length > 0
        ? messageIds
        : subagent.transcript.messages.map((message) => message.id);
      if (!selectedIds.length) {
        logChatSurfaceAction(host, "subagent.forward.empty", { subagentId });
        return;
      }
      const mode = currentProjection.approvals.length > 0 ? "approval_guidance" : "normal";
      if (requiresForwardApprovalGuidanceConfirmation(mode) && !confirmSubagentForwardToApprovalGuidance(host)) {
        logChatSurfaceAction(host, "subagent.forward.cancelled", { subagentId });
        return;
      }
      const block = createSubagentForwardBlock(subagent, selectedIds);
      appendSharedComposerDraft(host, block.fallbackText);
      logChatSurfaceAction(host, "subagent.forward.append", {
        messageCount: block.messages.length,
        subagentId,
      });
      renderCurrent();
    },
    continueQueuedInput() {
      const { nextInput, remainingInputs } = resumeNextQueuedInput(currentQueuedInputs);
      if (!nextInput) {
        logChatSurfaceAction(host, "composer.queue.continue.empty", {});
        return;
      }
      currentQueuedInputs = remainingInputs;
      host.dispatchEvent(new CustomEvent("desktop-chat-message-submit", {
        bubbles: true,
        detail: { content: nextInput.content },
      }));
      logChatSurfaceAction(host, "composer.queue.continue", {
        inputId: nextInput.id,
        remaining: currentQueuedInputs.length,
      });
      renderCurrent();
    },
    toggleProcess(turnId) {
      const turn = currentProjection.turns.find((candidate) => candidate.id === turnId);
      if (!turn?.process) {
        logChatSurfaceAction(host, "process.toggle.missing", { turnId });
        return;
      }
      const nextExpanded = !isProcessExpanded(turn, processExpansionOverrides);
      processExpansionOverrides.set(turnId, nextExpanded);
      logChatSurfaceAction(host, "process.toggle", {
        expanded: nextExpanded,
        turnId,
      });
      renderCurrent();
    },
    composerError() {
      return composerError;
    },
    subagentDraft(subagentId) {
      return subagentDrafts.get(subagentId) ?? "";
    },
    updateSessionSearch(query) {
      sessionSearchQuery = query;
      logChatSurfaceAction(host, "session.search", { queryLength: query.trim().length });
      renderCurrent();
    },
    sessionAction(action) {
      const activeSession = currentProjection.sessions.find((session) => session.key === currentProjection.activeSessionKey);
      if (!activeSession) {
        logChatSurfaceAction(host, "session.action.missing", { action });
        return;
      }
      const detail: Record<string, unknown> = {
        action,
        chatId: activeSession.chatId,
        sessionKey: activeSession.key,
        title: activeSession.title,
      };
      if (action === "copy-session-id") {
        detail.copyText = activeSession.key;
      } else if (action === "copy-markdown") {
        detail.copyText = currentProjection.turns.map((turn) => `${roleLabel(turn.role)}:\n${turn.content}`).join("\n\n");
      }
      host.dispatchEvent(new CustomEvent("desktop-chat-session-action", {
        bubbles: true,
        detail,
      }));
      logChatSurfaceAction(host, "session.action", { action, sessionKey: activeSession.key });
    },
    updateSubagentDraft(subagentId, content) {
      if (content) {
        subagentDrafts.set(subagentId, content);
        return;
      }
      subagentDrafts.delete(subagentId);
    },
  });
  renderCurrent();
  return {
    update(nextOptions: ChatSurfaceOptions) {
      const previousSessionKey = currentProjection.activeSessionKey;
      currentProjection = nextOptions.projection;
      loadSubagentTranscript = nextOptions.loadSubagentTranscript;
      if (nextOptions.projection.detailPanel.open || previousSessionKey !== nextOptions.projection.activeSessionKey) {
        currentDetailPanel = nextOptions.projection.detailPanel;
      }
      if (previousSessionKey !== nextOptions.projection.activeSessionKey) {
        currentQueuedInputs = nextOptions.projection.queuedInputs;
        composerError = "";
      }
      renderCurrent();
    },
    unmount() {
      host.removeEventListener("desktop-chat-composer-submit-request", handleSharedComposerSubmit);
      host.replaceChildren();
      host.removeAttribute("data-chat-surface");
      host.className = "";
    },
  };

  async function loadCurrentSubagentTrace(subagentId: string): Promise<void> {
    if (!loadSubagentTranscript) {
      logChatSurfaceAction(host, "subagent.trace.load.unavailable", { subagentId });
      return;
    }
    const subagent = currentViewProjection().liveSubagents.find((candidate) => candidate.id === subagentId);
    if (!subagent || subagent.transcript.capability === "full_transcript") {
      return;
    }
    const key = subagentOverrideKey(subagent);
    if (loadingSubagents.has(key)) {
      return;
    }
    loadingSubagents.add(key);
    logChatSurfaceAction(host, "subagent.trace.load.start", {
      sessionKey: subagent.sessionKey,
      subagentId,
    });
    try {
      const payload = await loadSubagentTranscript({
        activityId: subagent.id,
        sessionKey: subagent.sessionKey,
        delegateId: subagent.id,
      });
      const loaded = applyLoadedSubagentTrace(subagent, payload);
      loadedSubagents.set(key, loaded);
      logChatSurfaceAction(host, "subagent.trace.load.complete", {
        messageCount: loaded.transcript.messages.length,
        sessionKey: loaded.sessionKey,
        subagentId,
        toolCount: loaded.transcript.toolSummaries.length,
      });
      renderCurrent();
    } catch (error) {
      logChatSurfaceAction(host, "subagent.trace.load.failed", {
        message: error instanceof Error ? error.message : String(error),
        subagentId,
      });
    } finally {
      loadingSubagents.delete(key);
    }
  }
}

type ChatSurfaceActions = {
  branchFromTurn(turnId: string): void;
  closeDetail(): void;
  composerError(): string;
  continueQueuedInput(): void;
  copyDetail(content: string, source: string): void;
  copyTurn(turnId: string): void;
  deleteQueuedInput(inputId: string): void;
  forwardSubagentMessages(subagentId: string, messageIds: string[]): void;
  openDetail(kind: ChatDetailPanelKind, targetId: string): void;
  openSession(sessionKey: string, chatId: string): void;
  sessionAction(action: "pin" | "unpin" | "rename" | "delete" | "copy-session-id" | "copy-markdown"): void;
  startNewSession(): void;
  subagentDraft(subagentId: string): string;
  submitSubagentMessage(subagentId: string, content: string): { accepted: boolean };
  toggleProcess(turnId: string): void;
  updateSessionSearch(query: string): void;
  updateSubagentDraft(subagentId: string, content: string): void;
};

function projectionWithLoadedSubagents(
  projection: ChatUiProjection,
  loadedSubagents: Map<string, LiveSubagent>,
): ChatUiProjection {
  if (!loadedSubagents.size) {
    return projection;
  }
  return {
    ...projection,
    liveSubagents: projection.liveSubagents.map((subagent) =>
      loadedSubagents.get(subagentOverrideKey(subagent)) ?? subagent,
    ),
  };
}

function subagentOverrideKey(subagent: Pick<LiveSubagent, "id" | "sessionKey">): string {
  return `${subagent.sessionKey}:${subagent.id}`;
}

function renderChatSurface(
  host: HTMLElement,
  projection: ChatUiProjection,
  sessionSearchQuery: string,
  processExpansionOverrides: Map<string, boolean>,
  actions: ChatSurfaceActions,
): void {
  activeDocument = host.ownerDocument;
  host.replaceChildren();
  host.setAttribute("data-chat-surface", "rebuild-chat-agent-surface");
  host.className = "desktop-conversation-thread desktop-chat-surface";

  const shell = element("div", "desktop-chat-surface__shell");
  shell.setAttribute("data-chat-layout", "codex-reference");
  shell.append(renderSessionList(projection, sessionSearchQuery, actions));
  shell.append(renderChatDetail(projection, processExpansionOverrides, actions));
  shell.append(renderStatusRail(projection, actions));
  const detailSurface = renderDetailSurface(projection, actions);
  if (detailSurface) {
    shell.append(detailSurface);
  }
  host.append(shell);
}

function confirmSubagentForwardToApprovalGuidance(host: HTMLElement): boolean {
  return host.ownerDocument.defaultView?.confirm(
    "This will reject the current approval and append the forwarded content as guidance. Continue?",
  ) ?? false;
}

function renderSessionList(projection: ChatUiProjection, searchQuery: string, actions: ChatSurfaceActions): HTMLElement {
  const list = element("aside", "desktop-chat-surface__sessions");
  list.setAttribute("data-chat-region", "session-list");
  const controls = element("div", "desktop-chat-surface__session-controls");
  const newButton = element("button", "desktop-chat-surface__session-new", "New Chat");
  newButton.type = "button";
  newButton.setAttribute("data-session-action", "new");
  newButton.addEventListener("click", () => actions.startNewSession());
  const search = activeDocument.createElement("input");
  search.className = "desktop-chat-surface__session-search";
  search.type = "search";
  search.placeholder = "Search sessions";
  search.value = searchQuery;
  search.setAttribute("data-session-search", "");
  search.addEventListener("input", () => actions.updateSessionSearch(search.value));
  controls.append(newButton, search);
  list.append(controls);

  const filteredSessions = projection.sessions.filter((session) => sessionMatchesSearch(session, searchQuery));
  const rows = element("div", "desktop-chat-surface__session-rows");
  rows.setAttribute("data-session-result-count", String(filteredSessions.length));
  for (const session of filteredSessions) {
    const row = element("button", "desktop-chat-surface__session-row");
    row.type = "button";
    row.setAttribute("data-session-key", session.key);
    row.setAttribute("data-session-chat-id", session.chatId);
    row.setAttribute("data-pinned", String(Boolean(session.pinned)));
    if (session.isActive) {
      row.setAttribute("aria-current", "true");
    }
    row.addEventListener("click", () => actions.openSession(session.key, session.chatId));
    const title = element("span", "desktop-chat-surface__session-title", session.title);
    const badge = element("span", "desktop-chat-surface__session-badge", badgeLabel(session));
    badge.setAttribute("data-session-primary-badge", session.primaryBadge);
    if (session.pinned) {
      const pinned = element("span", "desktop-chat-surface__session-pinned", "Pinned");
      pinned.setAttribute("data-session-pinned", "");
      row.append(pinned);
    }
    row.append(title, badge);
    rows.append(row);
  }
  if (!filteredSessions.length) {
    const empty = element("p", "desktop-chat-surface__session-empty", "No matching sessions");
    empty.setAttribute("data-session-empty", "");
    rows.append(empty);
  }
  list.append(rows);
  return list;
}

function sessionMatchesSearch(session: ChatUiProjection["sessions"][number], searchQuery: string): boolean {
  const query = searchQuery.trim().toLocaleLowerCase();
  if (!query) {
    return true;
  }
  return [session.title, session.key, session.chatId].some((value) => value.toLocaleLowerCase().includes(query));
}

function renderChatDetail(
  projection: ChatUiProjection,
  processExpansionOverrides: Map<string, boolean>,
  actions: ChatSurfaceActions,
): HTMLElement {
  const detail = element("section", "desktop-chat-surface__detail");
  detail.setAttribute("data-chat-region", "chat-detail");
  detail.setAttribute("data-chat-layout-role", "conversation-stage");
  const activeSession = projection.sessions.find((session) => session.key === projection.activeSessionKey);
  detail.append(renderHeader(activeSession?.title ?? "New session", Boolean(activeSession?.pinned), actions));
  detail.append(renderConversation(projection.turns, processExpansionOverrides, actions));
  const approvalCard = renderApprovalCard(projection.approvals);
  if (approvalCard) {
    detail.append(approvalCard);
  }
  for (const approvalResult of renderApprovalResults(projection.approvals)) {
    detail.append(approvalResult);
  }
  const subagentStrip = renderSubagentStrip(projection.liveSubagents, actions);
  if (subagentStrip) {
    detail.append(subagentStrip);
  }
  const queue = renderQueuedInputs(projection.queuedInputs, actions);
  if (queue) {
    detail.append(queue);
  }
  detail.append(renderComposer(projection.approvals.length > 0 ? "approval_guidance" : "normal", actions));
  return detail;
}

function renderStatusRail(projection: ChatUiProjection, actions: ChatSurfaceActions): HTMLElement {
  const rail = element("aside", "desktop-chat-surface__status-rail");
  rail.setAttribute("data-chat-region", "status-rail");
  const card = element("div", "desktop-chat-surface__status-card");
  card.append(
    renderOutputRailSection(projection.artifacts ?? [], actions),
    renderSubagentsRailSection(projection.liveSubagents, actions),
    renderSourcesRailSection(),
  );
  rail.append(card);
  return rail;
}

function renderOutputRailSection(artifacts: ArtifactDetail[], actions: ChatSurfaceActions): HTMLElement {
  const section = renderRailSectionShell("output", "Output");
  if (!artifacts.length) {
    section.append(element("p", "desktop-chat-surface__rail-empty", "No artifacts"));
    return section;
  }
  const list = element("div", "desktop-chat-surface__rail-list");
  for (const artifact of artifacts.slice(0, 3)) {
    const row = element("button", "desktop-chat-surface__rail-artifact");
    row.type = "button";
    row.setAttribute("data-rail-artifact-id", artifact.id);
    row.addEventListener("click", () => actions.openDetail("artifact", artifact.id));
    row.append(
      element("span", "desktop-chat-surface__rail-artifact-title", artifact.title),
      element("span", "desktop-chat-surface__rail-artifact-kind", artifact.kind),
    );
    list.append(row);
  }
  section.append(list);
  return section;
}

function renderSubagentsRailSection(subagents: LiveSubagent[], actions: ChatSurfaceActions): HTMLElement {
  const section = renderRailSectionShell("subagents", "Subagents");
  if (!subagents.length) {
    section.append(element("p", "desktop-chat-surface__rail-empty", "No subagents"));
    return section;
  }
  const list = element("div", "desktop-chat-surface__rail-list");
  subagents.slice(0, 4).forEach((subagent, index) => {
    const row = element("button", "desktop-chat-surface__rail-subagent");
    row.type = "button";
    row.setAttribute("data-rail-subagent-id", subagent.id);
    row.setAttribute("data-rail-subagent-status", subagent.status);
    row.addEventListener("click", () => actions.openDetail("subagent", subagent.id));
    const marker = element("span", "desktop-chat-surface__rail-subagent-mark", "");
    marker.setAttribute("data-rail-subagent-index", String(index % 4));
    row.append(
      marker,
      element("span", "desktop-chat-surface__rail-subagent-name", subagent.name),
    );
    list.append(row);
  });
  section.append(list);
  return section;
}

function renderSourcesRailSection(): HTMLElement {
  const section = renderRailSectionShell("sources", "Sources");
  section.append(element("p", "desktop-chat-surface__rail-empty", "No sources"));
  return section;
}

function renderRailSectionShell(key: string, label: string): HTMLElement {
  const section = element("section", "desktop-chat-surface__rail-section");
  section.setAttribute("data-chat-rail-section", key);
  section.append(element("h3", "desktop-chat-surface__rail-heading", label));
  return section;
}

function renderHeader(title: string, pinned: boolean, actions: ChatSurfaceActions): HTMLElement {
  const header = element("header", "desktop-chat-surface__header");
  header.setAttribute("data-chat-region", "chat-header");
  const heading = element("h2", "desktop-chat-surface__title", title);
  const summary = element("div", "desktop-chat-surface__runtime", "Agent · rust");
  const menu = element("div", "desktop-chat-surface__header-actions");
  for (const { action, label, title: actionTitle } of [
    { action: pinned ? "unpin" : "pin", label: pinned ? "Unpin" : "Pin", title: pinned ? "Unpin session" : "Pin session" },
    { action: "rename", label: "Rename", title: "Rename session" },
    { action: "delete", label: "Delete", title: "Delete session" },
    { action: "copy-session-id", label: "Copy ID", title: "Copy session ID" },
    { action: "copy-markdown", label: "Copy Markdown", title: "Copy session as Markdown" },
  ] as const) {
    const button = element("button", "desktop-chat-surface__header-action", label);
    button.type = "button";
    button.setAttribute("data-chat-header-action", action);
    button.setAttribute("aria-label", actionTitle);
    button.title = actionTitle;
    button.addEventListener("click", () => actions.sessionAction(action));
    menu.append(button);
  }
  header.append(heading, summary, menu);
  return header;
}

function renderConversation(
  turns: ChatTurn[],
  processExpansionOverrides: Map<string, boolean>,
  actions: ChatSurfaceActions,
): HTMLElement {
  const conversation = element("div", "desktop-chat-surface__conversation");
  conversation.setAttribute("data-chat-region", "conversation");
  for (const turn of turns) {
    conversation.append(renderTurn(turn, processExpansionOverrides, actions));
  }
  return conversation;
}

function renderTurn(
  turn: ChatTurn,
  processExpansionOverrides: Map<string, boolean>,
  actions: ChatSurfaceActions,
): HTMLElement {
  const article = element("article", "desktop-chat-surface__turn");
  article.setAttribute("data-chat-turn-id", turn.id);
  article.setAttribute("data-chat-turn-role", turn.role);
  article.setAttribute("data-chat-turn-align", turn.role === "user" ? "end" : "start");
  const body = element("div", "desktop-chat-surface__turn-body", turn.content);
  body.setAttribute("data-chat-bubble", turn.role === "user" ? "user" : "assistant");
  article.append(body);
  if (turn.reasoningContent) {
    const thinking = element("div", "desktop-chat-surface__thinking", turn.reasoningContent);
    thinking.setAttribute("data-chat-region", "thinking-summary");
    article.append(thinking);
  }
  if (turn.process) {
    const expanded = isProcessExpanded(turn, processExpansionOverrides);
    const process = element("button", "desktop-chat-surface__process", turn.process.summary);
    process.type = "button";
    process.setAttribute("data-chat-region", "agent-process-summary");
    process.setAttribute("data-agent-process-state", turn.process.state);
    process.setAttribute("data-agent-process-expanded", String(expanded));
    process.setAttribute("aria-expanded", String(expanded));
    process.addEventListener("click", () => actions.toggleProcess(turn.id));
    article.append(process);
  }
  if (!turn.process || isProcessExpanded(turn, processExpansionOverrides)) {
    const tools = element("div", "desktop-chat-surface__tool-rows");
    tools.setAttribute("data-chat-region", "agent-process-tools");
    for (const tool of turn.tools) {
      tools.append(renderToolRow(tool, actions));
    }
    if (turn.tools.length) {
      article.append(tools);
    }
  }
  const actionsRow = element("div", "desktop-chat-surface__turn-actions");
  const branch = element("button", "desktop-chat-surface__turn-branch", "Branch from here");
  branch.type = "button";
  branch.setAttribute("data-turn-action", "branch");
  branch.addEventListener("click", () => actions.branchFromTurn(turn.id));
  const copy = element("button", "desktop-chat-surface__turn-copy", "Copy");
  copy.type = "button";
  copy.setAttribute("data-turn-action", "copy");
  copy.addEventListener("click", () => actions.copyTurn(turn.id));
  actionsRow.append(copy, branch);
  article.append(actionsRow);
  return article;
}

function renderToolRow(tool: ToolCallSummary, actions: ChatSurfaceActions): HTMLElement {
  const row = element("button", "desktop-chat-surface__tool-row");
  const detailKind = toolDetailKind(tool);
  row.type = "button";
  row.setAttribute("data-chat-region", "tool-row");
  row.setAttribute("data-tool-detail-kind", detailKind);
  row.setAttribute("data-tool-call-id", tool.id);
  row.setAttribute("data-tool-status", tool.status);
  row.textContent = `${tool.name} · ${statusLabel(tool.status)}${tool.preview ? ` · ${tool.preview}` : ""}`;
  row.addEventListener("click", () => actions.openDetail(detailKind, tool.id));
  return row;
}

function toolDetailKind(tool: ToolCallSummary): ChatDetailPanelKind {
  return tool.name.startsWith("Artifact:") ? "artifact" : "tool";
}

function appendDirectSubagentMessage(subagent: LiveSubagent, content: string): LiveSubagent {
  return {
    ...subagent,
    latestActivity: "User input queued",
    status: "user_intervened_unsynced",
    transcript: {
      ...subagent.transcript,
      messages: [
        ...subagent.transcript.messages,
        {
          id: `${subagent.id}:direct-input:${Date.now()}`,
          role: "user",
          content,
          timestamp: new Date().toISOString(),
        },
      ],
    },
  };
}

function isProcessExpanded(turn: ChatTurn, overrides: Map<string, boolean>): boolean {
  const override = overrides.get(turn.id);
  if (typeof override === "boolean") {
    return override;
  }
  return turn.process?.state === "running" || turn.process?.state === "waiting_approval";
}

function renderDetailSurface(projection: ChatUiProjection, actions: ChatSurfaceActions): HTMLElement | null {
  const panel = projection.detailPanel;
  if (!panel.open || panel.kind === "none") {
    return null;
  }
  const surface = element("aside", "desktop-chat-surface__detail-surface");
  surface.setAttribute("data-chat-region", "detail-surface");
  surface.setAttribute("data-detail-kind", panel.kind);
  surface.setAttribute("data-detail-presentation", panel.presentation);
  if (panel.kind === "tool") {
    surface.append(renderToolDetail(projection.turns, panel, actions));
  } else if (panel.kind === "subagent") {
    surface.append(renderSubagentDetail(projection.liveSubagents, panel, actions));
  } else if (panel.kind === "artifact") {
    surface.append(renderArtifactDetail(projection.artifacts ?? [], panel, actions));
  } else if (panel.kind === "error") {
    surface.append(renderErrorDetail(projection.errors ?? [], panel, actions));
  } else {
    surface.append(element("div", "desktop-chat-surface__detail-empty", "Detail unavailable"));
  }
  return surface;
}

function renderSubagentStrip(subagents: LiveSubagent[], actions: ChatSurfaceActions): HTMLElement | null {
  if (!subagents.length) {
    return null;
  }
  const strip = element("section", "desktop-chat-surface__subagents");
  strip.setAttribute("data-chat-region", "subagent-strip");
  const heading = element("h3", "desktop-chat-surface__subagents-title", `Active goals · ${subagents.length}`);
  strip.append(heading);
  for (const subagent of subagents) {
    const row = element("button", "desktop-chat-surface__subagent-row");
    row.type = "button";
    row.setAttribute("data-subagent-id", subagent.id);
    row.setAttribute("data-subagent-status", subagent.status);
    row.addEventListener("click", () => actions.openDetail("subagent", subagent.id));
    row.append(
      element("span", "desktop-chat-surface__subagent-name", subagent.name),
      element("span", "desktop-chat-surface__subagent-state", subagentStatusLabel(subagent.status)),
      element("span", "desktop-chat-surface__subagent-activity", subagent.latestActivity),
    );
    strip.append(row);
  }
  return strip;
}

function renderApprovalCard(approvals: ApprovalRequest[]): HTMLElement | null {
  const approval = approvals.find((candidate) => candidate.status === "pending");
  if (!approval) {
    return null;
  }
  const card = element("section", "desktop-chat-surface__approval-card");
  card.setAttribute("data-chat-region", "approval-card");
  card.setAttribute("data-approval-id", approval.id);
  card.append(element("h3", "desktop-chat-surface__approval-title", approval.toolName));
  card.append(element("p", "desktop-chat-surface__approval-prompt", approval.prompt));
  if (approval.scopeLabel) {
    card.append(element("p", "desktop-chat-surface__approval-scope", approval.scopeLabel));
  }
  for (const choice of approval.choices) {
    const button = element("button", "desktop-chat-surface__approval-choice", approvalChoiceLabel(choice));
    button.type = "button";
    button.setAttribute("data-approval-choice", choice);
    button.setAttribute("data-desktop-approval-action", approvalActionForChoice(choice));
    button.addEventListener("click", () => {
      button.dispatchEvent(new CustomEvent("desktop-tool-approval-action", {
        bubbles: true,
        detail: {
          action: approvalActionForChoice(choice),
          approvalId: approval.id,
          sessionKey: approval.sessionKey,
          toolName: approval.toolName || "tool",
        },
      }));
    });
    card.append(button);
  }
  return card;
}

function renderApprovalResults(approvals: ApprovalRequest[]): HTMLElement[] {
  return approvals
    .filter((approval) => approval.status !== "pending")
    .map((approval) => {
      const result = element("div", "desktop-chat-surface__approval-result", `${approvalResultLabel(approval.status)} · ${approval.toolName}`);
      result.setAttribute("data-chat-region", "approval-result");
      result.setAttribute("data-approval-id", approval.id);
      return result;
    });
}

function renderQueuedInputs(inputs: QueuedInput[], actions: ChatSurfaceActions): HTMLElement | null {
  if (!inputs.length) {
    return null;
  }
  const section = element("section", "desktop-chat-surface__queued-inputs");
  section.setAttribute("data-chat-region", "queued-inputs");
  section.append(element("h3", "desktop-chat-surface__queued-title", `Queued inputs · ${inputs.length}`));
  if (inputs.some((input) => input.status === "paused")) {
    const paused = element("div", "desktop-chat-surface__queued-paused", "Queue paused");
    paused.setAttribute("data-queued-input-state", "paused");
    const resume = element("button", "desktop-chat-surface__queued-continue", "Continue");
    resume.type = "button";
    resume.setAttribute("data-queued-input-action", "continue");
    resume.addEventListener("click", () => actions.continueQueuedInput());
    section.append(paused, resume);
  }
  for (const input of inputs) {
    const row = element("div", "desktop-chat-surface__queued-row");
    row.setAttribute("data-queued-input-id", input.id);
    row.append(element("span", "desktop-chat-surface__queued-content", input.content));
    const del = element("button", "desktop-chat-surface__queued-delete", "Delete");
    del.type = "button";
    del.setAttribute("data-queued-input-action", "delete");
    del.addEventListener("click", () => actions.deleteQueuedInput(input.id));
    row.append(del);
    section.append(row);
  }
  return section;
}

function renderComposer(mode: "normal" | "approval_guidance", actions: ChatSurfaceActions): HTMLElement {
  const composer = element("section", "desktop-chat-surface__composer");
  composer.setAttribute("data-chat-region", "composer");
  composer.setAttribute("data-composer-mode", mode);
  if (mode === "approval_guidance") {
    composer.append(element("p", "desktop-chat-surface__composer-hint", "发送文字将拒绝此请求，并作为给 Tinybot 的指导。"));
  }
  const error = actions.composerError();
  if (error) {
    const errorNode = element("p", "desktop-chat-surface__composer-error", error);
    errorNode.setAttribute("data-chat-region", "composer-error");
    composer.append(errorNode);
  }
  return composer;
}

function appendSharedComposerDraft(host: HTMLElement, content: string): void {
  const input = host.ownerDocument.getElementById("desktop-native-composer-input") as HTMLTextAreaElement | null;
  if (!input) {
    return;
  }
  const previous = input.value.trimEnd();
  input.value = previous ? `${previous}\n\n${content}` : content;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function renderSubagentDetail(subagents: LiveSubagent[], panel: DetailPanelState, actions: ChatSurfaceActions): HTMLElement {
  const subagent = subagents.find((candidate) => candidate.id === panel.targetId);
  const detail = element("section", "desktop-chat-surface__subagent-detail");
  detail.append(renderCloseButton(actions));
  if (!subagent) {
    detail.append(element("p", "desktop-chat-surface__detail-empty", "Subagent detail unavailable"));
    return detail;
  }
  detail.append(element("h3", "desktop-chat-surface__detail-title", subagent.name));
  detail.append(element("p", "desktop-chat-surface__metadata", subagent.task));
  detail.append(element("p", "desktop-chat-surface__subagent-boundary", "Messages are sent only to this subagent and do not automatically sync to the main thread."));
  if (subagent.transcript.capability === "partial_transcript") {
    detail.append(element("p", "desktop-chat-surface__partial-transcript", "partial transcript: this is not a complete private thread."));
  }
  for (const message of subagent.transcript.messages) {
    const item = element("label", "desktop-chat-surface__subagent-message");
    item.setAttribute("data-subagent-message-id", message.id);
    const selector = activeDocument.createElement("input");
    selector.type = "checkbox";
    selector.setAttribute("data-subagent-message-select", message.id);
    item.append(
      selector,
      element("span", "desktop-chat-surface__subagent-message-content", `${message.role}: ${message.content}`),
    );
    detail.append(item);
  }
  for (const tool of subagent.transcript.toolSummaries) {
    const toolRow = element("div", "desktop-chat-surface__subagent-tool", `${tool.name} · ${statusLabel(tool.status)} · ${tool.preview}`);
    toolRow.setAttribute("data-subagent-tool-id", tool.id);
    detail.append(toolRow);
  }
  if (subagent.capabilities.includes("can_forward")) {
    const forward = element("button", "desktop-chat-surface__subagent-forward", "Forward to main composer");
    forward.type = "button";
    forward.setAttribute("data-subagent-action", "forward");
    forward.addEventListener("click", () => {
      const selectedMessageIds = [...detail.querySelectorAll<HTMLInputElement>("[data-subagent-message-select]")]
        .filter((selector) => selector.checked)
        .map((selector) => selector.getAttribute("data-subagent-message-select") ?? "")
        .filter(Boolean);
      actions.forwardSubagentMessages(subagent.id, selectedMessageIds);
    });
    detail.append(forward);
  }
  if (requiresFirstDirectSubagentMessageConfirmation(subagent)) {
    const confirmation = element("button", "desktop-chat-surface__subagent-confirm", "Confirm first direct message");
    confirmation.type = "button";
    confirmation.setAttribute("data-subagent-action", "first-send-confirm");
    detail.append(confirmation);
  }
  if (canSendDirectSubagentMessage(subagent)) {
    const input = activeDocument.createElement("textarea");
    input.className = "desktop-chat-surface__subagent-input";
    input.setAttribute("data-subagent-input", "message");
    input.value = actions.subagentDraft(subagent.id);
    input.addEventListener("input", () => {
      actions.updateSubagentDraft(subagent.id, input.value);
    });
    if (requiresFirstDirectSubagentMessageConfirmation(subagent)) {
      input.setAttribute("data-requires-confirmation", "true");
    }
    const send = element("button", "desktop-chat-surface__subagent-send", "Send to subagent");
    send.type = "button";
    send.setAttribute("data-subagent-action", "send-message");
    send.addEventListener("click", () => {
      const result = actions.submitSubagentMessage(subagent.id, input.value);
      if (result.accepted) {
        input.value = "";
      }
    });
    detail.append(input, send);
  } else if (subagent.status === "completed" || subagent.status === "idle") {
    detail.append(element("p", "desktop-chat-surface__readonly", "This subagent is closed and can only be reviewed."));
  } else {
    detail.append(element("p", "desktop-chat-surface__readonly", "This subagent can currently only show summary content."));
  }
  return detail;
}

function renderToolDetail(turns: ChatTurn[], panel: DetailPanelState, actions: ChatSurfaceActions): HTMLElement {
  const tool = findTool(turns, panel.targetId || "");
  const detail = element("section", "desktop-chat-surface__tool-detail");
  detail.append(renderCloseButton(actions));
  if (!tool) {
    detail.append(element("p", "desktop-chat-surface__detail-empty", "Tool detail unavailable"));
    return detail;
  }
  detail.append(element("h3", "desktop-chat-surface__detail-title", tool.name));
  detail.append(element("div", "desktop-chat-surface__detail-status", statusLabel(tool.status)));
  if (tool.preview) {
    detail.append(element("p", "desktop-chat-surface__detail-preview", tool.preview));
  }
  if (tool.resultPreview) {
    detail.append(element("p", "desktop-chat-surface__detail-result-preview", tool.resultPreview));
  }
  detail.append(renderFoldedToolSection("full-args", "Full args", tool.detail.argsText, actions));
  detail.append(renderFoldedToolSection("full-result", "Full result", tool.detail.responseText, actions));
  detail.append(renderFoldedToolSection("stdout-stderr", "stdout / stderr", [tool.detail.stdout, tool.detail.stderr].filter(Boolean).join("\n"), actions));
  if (tool.detail.rawEvent !== undefined) {
    detail.append(renderFoldedToolSection("raw-event", "Raw event", JSON.stringify(tool.detail.rawEvent, null, 2), actions));
  }
  return detail;
}

function renderFoldedToolSection(section: string, label: string, content: string, actions: ChatSurfaceActions): HTMLElement {
  const details = activeDocument.createElement("details");
  details.className = "desktop-chat-surface__tool-detail-section";
  details.setAttribute("data-tool-detail-section", section);
  const summary = element("summary", "desktop-chat-surface__tool-detail-summary", label);
  const copy = element("button", "desktop-chat-surface__copy", "Copy");
  copy.type = "button";
  copy.setAttribute("data-tool-detail-copy", section);
  copy.addEventListener("click", (event) => {
    event.preventDefault();
    actions.copyDetail(content, `tool:${section}`);
  });
  const pre = element("pre", "desktop-chat-surface__tool-detail-content", content);
  details.append(summary, copy, pre);
  return details;
}

function findTool(turns: ChatTurn[], toolId: string): ToolCallSummary | undefined {
  for (const turn of turns) {
    const tool = turn.tools.find((candidate) => candidate.id === toolId);
    if (tool) {
      return tool;
    }
  }
  return undefined;
}

function renderArtifactDetail(artifacts: ArtifactDetail[], panel: DetailPanelState, actions: ChatSurfaceActions): HTMLElement {
  const artifact = artifacts.find((candidate) => candidate.id === panel.targetId);
  const detail = element("section", "desktop-chat-surface__artifact-detail");
  detail.append(renderCloseButton(actions));
  if (!artifact) {
    detail.append(element("p", "desktop-chat-surface__detail-empty", "Artifact detail unavailable"));
    return detail;
  }
  detail.append(element("h3", "desktop-chat-surface__detail-title", artifact.title));
  detail.append(element("div", "desktop-chat-surface__artifact-kind", artifact.kind));
  detail.append(element("p", "desktop-chat-surface__detail-preview", artifact.preview));
  detail.append(element("p", "desktop-chat-surface__metadata", artifact.metadataSummary));
  const copy = element("button", "desktop-chat-surface__copy", "Copy");
  copy.type = "button";
  copy.setAttribute("data-artifact-action", "copy");
  copy.addEventListener("click", () => actions.copyDetail(artifact.preview, `artifact:${artifact.id}`));
  detail.append(copy);
  if (artifact.openLabel) {
    const open = element("button", "desktop-chat-surface__open", artifact.openLabel);
    open.type = "button";
    open.setAttribute("data-artifact-action", "open-locate");
    detail.append(open);
  }
  const future = element("span", "desktop-chat-surface__future-action", "Management actions reserved");
  future.setAttribute("data-artifact-action", "future-management");
  detail.append(future);
  return detail;
}

function renderErrorDetail(errors: ErrorDetail[], panel: DetailPanelState, actions: ChatSurfaceActions): HTMLElement {
  const error = errors.find((candidate) => candidate.id === panel.targetId);
  const detail = element("section", "desktop-chat-surface__error-detail");
  detail.append(renderCloseButton(actions));
  if (!error) {
    detail.append(element("p", "desktop-chat-surface__detail-empty", "Error detail unavailable"));
    return detail;
  }
  detail.append(element("h3", "desktop-chat-surface__detail-title", "Error"));
  detail.append(element("p", "desktop-chat-surface__detail-preview", error.message));
  if (error.relatedToolId || error.relatedTurnId) {
    detail.append(element("p", "desktop-chat-surface__metadata", [error.relatedToolId, error.relatedTurnId].filter(Boolean).join(" · ")));
  }
  const raw = activeDocument.createElement("details");
  raw.className = "desktop-chat-surface__error-section";
  raw.setAttribute("data-error-detail-section", "raw");
  raw.append(element("summary", "desktop-chat-surface__error-summary", "Raw error"));
  const copy = element("button", "desktop-chat-surface__copy", "Copy");
  copy.type = "button";
  copy.setAttribute("data-error-detail-copy", "raw");
  copy.addEventListener("click", (event) => {
    event.preventDefault();
    actions.copyDetail(error.raw, `error:${error.id}:raw`);
  });
  raw.append(copy, element("pre", "desktop-chat-surface__error-raw", error.raw));
  detail.append(raw);
  return detail;
}

function renderCloseButton(actions: ChatSurfaceActions): HTMLElement {
  const close = element("button", "desktop-chat-surface__detail-close", "Close");
  close.type = "button";
  close.setAttribute("data-detail-action", "close");
  close.addEventListener("click", () => actions.closeDetail());
  return close;
}

function chatSurfaceViewportWidth(host: HTMLElement): number {
  return host.ownerDocument.defaultView?.innerWidth ?? 1024;
}

function chatSurfaceHasRunningTurn(projection: ChatUiProjection): boolean {
  return projection.turns.some((turn) => turn.process?.state === "running");
}

function roleLabel(role: ChatTurn["role"]): string {
  return role === "assistant" ? "Assistant" : "User";
}

function logChatSurfaceAction(host: HTMLElement, action: string, detail: unknown): void {
  const eventDetail = action.startsWith("detail.")
    ? { action, panel: detail }
    : { action, payload: detail };
  host.dispatchEvent(new CustomEvent("desktop-chat-surface-log", {
    bubbles: true,
    detail: eventDetail,
  }));
}

function badgeLabel(session: ChatUiProjection["sessions"][number]): string {
  switch (session.primaryBadge) {
    case "waiting_approval":
      return "Waiting approval";
    case "running":
      return "Running";
    case "unread":
      return "New output";
    case "updated_time":
      return sessionUpdatedLabel(session.updatedAt);
  }
}

function sessionUpdatedLabel(updatedAt: string): string {
  if (!updatedAt) {
    return "Updated";
  }
  const timestamp = Date.parse(updatedAt);
  if (Number.isNaN(timestamp)) {
    return updatedAt;
  }
  const now = Date.now();
  const diffMs = now - timestamp;
  if (diffMs < 0) {
    return "Updated";
  }
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (diffMs < hourMs) {
    const minutes = Math.max(1, Math.floor(diffMs / minuteMs));
    return `${minutes} min`;
  }
  if (diffMs < dayMs) {
    const hours = Math.floor(diffMs / hourMs);
    return `${hours} h`;
  }
  const days = Math.floor(diffMs / dayMs);
  return `${days} d`;
}

function approvalChoiceLabel(choice: ApprovalRequest["choices"][number]): string {
  switch (choice) {
    case "allow_once":
      return "Allow once";
    case "allow_session":
      return "Allow for this session";
    case "deny":
      return "Deny";
  }
}

function approvalActionForChoice(choice: ApprovalRequest["choices"][number]): "approveOnce" | "approveSession" | "deny" {
  switch (choice) {
    case "allow_once":
      return "approveOnce";
    case "allow_session":
      return "approveSession";
    case "deny":
      return "deny";
  }
}

function approvalResultLabel(status: ApprovalRequest["status"]): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "pending":
      return "Pending";
  }
}

function statusLabel(status: ToolCallSummary["status"]): string {
  switch (status) {
    case "waiting_approval":
      return "waiting approval";
    case "completed":
      return "completed";
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    case "unknown":
      return "unknown";
  }
}

function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case "waiting_main_agent":
      return "Waiting main agent";
    case "waiting_user":
      return "Waiting user";
    case "running":
      return "Running";
    case "has_update":
      return "New output";
    case "user_intervened_unsynced":
      return "User intervened";
    case "idle":
      return "Idle";
    case "completed":
      return "Completed";
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className: string,
  textContent?: string,
): HTMLElementTagNameMap[K] {
  const node = activeDocument.createElement(tagName);
  node.className = className;
  if (textContent !== undefined) {
    node.textContent = textContent;
  }
  return node;
}
