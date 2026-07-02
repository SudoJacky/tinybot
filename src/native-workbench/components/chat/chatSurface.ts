import type {
  ApprovalRequest,
  ArtifactDetail,
  ChatTurn,
  DetailPanelState,
  ErrorDetail,
  ChatUiProjection,
  LiveSubagent,
  QueuedInput,
  SessionPrimaryBadge,
  SubagentStatus,
  ToolCallSummary,
} from "../../chat/chatUiProjection";
import {
  closeChatDetailPanel,
  type ChatDetailPanelKind,
  openChatDetailPanel,
} from "../../chat/chatDetailPanelState";
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

export type ChatSurfaceOptions = {
  projection: ChatUiProjection;
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
  let composerError = "";
  const composerDrafts = new Map<string, string>();
  const subagentDrafts = new Map<string, string>();
  const currentComposerDraftKey = () => currentProjection.activeSessionKey || "new-session";
  const clearCurrentComposerDraft = () => {
    composerDrafts.delete(currentComposerDraftKey());
  };
  const appendCurrentComposerDraft = (content: string) => {
    const key = currentComposerDraftKey();
    const previous = composerDrafts.get(key)?.trimEnd() ?? "";
    composerDrafts.set(key, previous ? `${previous}\n\n${content}` : content);
  };
  const renderCurrent = () => renderChatSurface(host, {
    ...currentProjection,
    detailPanel: currentDetailPanel,
    queuedInputs: currentQueuedInputs,
  }, {
    closeDetail() {
      currentDetailPanel = closeChatDetailPanel(chatSurfaceViewportWidth(host));
      logChatSurfaceAction(host, "detail.close", currentDetailPanel);
      renderCurrent();
    },
    openDetail(kind, targetId) {
      currentDetailPanel = openChatDetailPanel(kind, targetId, chatSurfaceViewportWidth(host));
      logChatSurfaceAction(host, "detail.open", currentDetailPanel);
      renderCurrent();
    },
    submitSubagentMessage(subagentId, content) {
      const subagent = currentProjection.liveSubagents.find((candidate) => candidate.id === subagentId);
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
          content: message,
          sessionKey: subagent.sessionKey,
          subagentId,
        },
      }));
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
      const subagent = currentProjection.liveSubagents.find((candidate) => candidate.id === subagentId);
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
      appendCurrentComposerDraft(block.fallbackText);
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
    submitComposer(content) {
      const result = submitComposerText({
        approvals: currentProjection.approvals,
        content,
        isRunning: chatSurfaceHasRunningTurn(currentProjection),
        now: new Date().toISOString(),
        queuedInputs: currentQueuedInputs,
      });
      if (result.kind === "send_message") {
        composerError = "";
        clearCurrentComposerDraft();
        host.dispatchEvent(new CustomEvent("desktop-chat-message-submit", {
          bubbles: true,
          detail: { content: result.content },
        }));
        logChatSurfaceAction(host, "composer.message.submit", { contentLength: result.content.length });
        return { accepted: true };
      }
      if (result.kind === "reject_approval_with_guidance") {
        composerError = "";
        clearCurrentComposerDraft();
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
        clearCurrentComposerDraft();
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
    },
    composerError() {
      return composerError;
    },
    composerDraft() {
      return composerDrafts.get(currentComposerDraftKey()) ?? "";
    },
    updateComposerDraft(content) {
      if (content) {
        composerDrafts.set(currentComposerDraftKey(), content);
        return;
      }
      clearCurrentComposerDraft();
    },
    subagentDraft(subagentId) {
      return subagentDrafts.get(subagentId) ?? "";
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
      host.replaceChildren();
      host.removeAttribute("data-chat-surface");
      host.className = "";
    },
  };
}

type ChatSurfaceActions = {
  closeDetail(): void;
  composerDraft(): string;
  composerError(): string;
  continueQueuedInput(): void;
  deleteQueuedInput(inputId: string): void;
  forwardSubagentMessages(subagentId: string, messageIds: string[]): void;
  openDetail(kind: ChatDetailPanelKind, targetId: string): void;
  subagentDraft(subagentId: string): string;
  submitComposer(content: string): { accepted: boolean };
  submitSubagentMessage(subagentId: string, content: string): { accepted: boolean };
  updateComposerDraft(content: string): void;
  updateSubagentDraft(subagentId: string, content: string): void;
};

function renderChatSurface(host: HTMLElement, projection: ChatUiProjection, actions: ChatSurfaceActions): void {
  activeDocument = host.ownerDocument;
  host.replaceChildren();
  host.setAttribute("data-chat-surface", "rebuild-chat-agent-surface");
  host.className = "desktop-conversation-thread desktop-chat-surface";

  const shell = element("div", "desktop-chat-surface__shell");
  shell.append(renderSessionList(projection));
  shell.append(renderChatDetail(projection, actions));
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

function renderSessionList(projection: ChatUiProjection): HTMLElement {
  const list = element("aside", "desktop-chat-surface__sessions");
  list.setAttribute("data-chat-region", "session-list");
  for (const session of projection.sessions) {
    const row = element("button", "desktop-chat-surface__session-row");
    row.type = "button";
    row.setAttribute("data-session-key", session.key);
    if (session.isActive) {
      row.setAttribute("aria-current", "true");
    }
    const title = element("span", "desktop-chat-surface__session-title", session.title);
    const badge = element("span", "desktop-chat-surface__session-badge", badgeLabel(session.primaryBadge));
    badge.setAttribute("data-session-primary-badge", session.primaryBadge);
    row.append(title, badge);
    list.append(row);
  }
  return list;
}

function renderChatDetail(projection: ChatUiProjection, actions: ChatSurfaceActions): HTMLElement {
  const detail = element("section", "desktop-chat-surface__detail");
  detail.setAttribute("data-chat-region", "chat-detail");
  const activeSession = projection.sessions.find((session) => session.key === projection.activeSessionKey);
  detail.append(renderHeader(activeSession?.title ?? "New session"));
  detail.append(renderConversation(projection.turns, actions));
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

function renderHeader(title: string): HTMLElement {
  const header = element("header", "desktop-chat-surface__header");
  header.setAttribute("data-chat-region", "chat-header");
  const heading = element("h2", "desktop-chat-surface__title", title);
  const summary = element("div", "desktop-chat-surface__runtime", "Agent · rust");
  header.append(heading, summary);
  return header;
}

function renderConversation(turns: ChatTurn[], actions: ChatSurfaceActions): HTMLElement {
  const conversation = element("div", "desktop-chat-surface__conversation");
  conversation.setAttribute("data-chat-region", "conversation");
  for (const turn of turns) {
    conversation.append(renderTurn(turn, actions));
  }
  return conversation;
}

function renderTurn(turn: ChatTurn, actions: ChatSurfaceActions): HTMLElement {
  const article = element("article", "desktop-chat-surface__turn");
  article.setAttribute("data-chat-turn-id", turn.id);
  article.setAttribute("data-chat-turn-role", turn.role);
  const body = element("div", "desktop-chat-surface__turn-body", turn.content);
  article.append(body);
  if (turn.reasoningContent) {
    const thinking = element("div", "desktop-chat-surface__thinking", turn.reasoningContent);
    thinking.setAttribute("data-chat-region", "thinking-summary");
    article.append(thinking);
  }
  if (turn.process) {
    const process = element("button", "desktop-chat-surface__process", turn.process.summary);
    process.type = "button";
    process.setAttribute("data-chat-region", "agent-process-summary");
    process.setAttribute("data-agent-process-state", turn.process.state);
    article.append(process);
  }
  for (const tool of turn.tools) {
    article.append(renderToolRow(tool, actions));
  }
  return article;
}

function renderToolRow(tool: ToolCallSummary, actions: ChatSurfaceActions): HTMLElement {
  const row = element("button", "desktop-chat-surface__tool-row");
  row.type = "button";
  row.setAttribute("data-chat-region", "tool-row");
  row.setAttribute("data-tool-call-id", tool.id);
  row.setAttribute("data-tool-status", tool.status);
  row.textContent = `${tool.name} · ${statusLabel(tool.status)}${tool.preview ? ` · ${tool.preview}` : ""}`;
  row.addEventListener("click", () => actions.openDetail("tool", tool.id));
  return row;
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
  const input = activeDocument.createElement("textarea");
  input.className = "desktop-chat-surface__composer-input";
  input.setAttribute("data-chat-composer-input", "");
  input.setAttribute("placeholder", mode === "approval_guidance" ? "输入拒绝原因或下一步建议..." : "要求后续变更");
  input.value = actions.composerDraft();
  input.addEventListener("input", () => {
    actions.updateComposerDraft(input.value);
  });
  const button = element("button", "desktop-chat-surface__composer-send", "Send");
  button.type = "button";
  button.setAttribute("data-chat-composer-action", "send");
  button.addEventListener("click", () => {
    const result = actions.submitComposer(input.value);
    if (result.accepted) {
      input.value = "";
    }
  });
  composer.append(input, button);
  const error = actions.composerError();
  if (error) {
    const errorNode = element("p", "desktop-chat-surface__composer-error", error);
    errorNode.setAttribute("data-chat-region", "composer-error");
    composer.append(errorNode);
  }
  return composer;
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
  detail.append(renderFoldedToolSection("full-args", "Full args", tool.detail.argsText));
  detail.append(renderFoldedToolSection("full-result", "Full result", tool.detail.responseText));
  detail.append(renderFoldedToolSection("stdout-stderr", "stdout / stderr", [tool.detail.stdout, tool.detail.stderr].filter(Boolean).join("\n")));
  if (tool.detail.rawEvent !== undefined) {
    detail.append(renderFoldedToolSection("raw-event", "Raw event", JSON.stringify(tool.detail.rawEvent, null, 2)));
  }
  return detail;
}

function renderFoldedToolSection(section: string, label: string, content: string): HTMLElement {
  const details = activeDocument.createElement("details");
  details.className = "desktop-chat-surface__tool-detail-section";
  details.setAttribute("data-tool-detail-section", section);
  const summary = element("summary", "desktop-chat-surface__tool-detail-summary", label);
  const copy = element("button", "desktop-chat-surface__copy", "Copy");
  copy.type = "button";
  copy.setAttribute("data-tool-detail-copy", section);
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

function logChatSurfaceAction(host: HTMLElement, action: string, detail: unknown): void {
  const eventDetail = action.startsWith("detail.")
    ? { action, panel: detail }
    : { action, payload: detail };
  host.dispatchEvent(new CustomEvent("desktop-chat-surface-log", {
    bubbles: true,
    detail: eventDetail,
  }));
}

function badgeLabel(badge: SessionPrimaryBadge): string {
  switch (badge) {
    case "waiting_approval":
      return "Waiting approval";
    case "running":
      return "Running";
    case "unread":
      return "New output";
    case "updated_time":
      return "Updated";
  }
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
