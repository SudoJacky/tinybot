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
  canSendDirectSubagentMessage,
  requiresFirstDirectSubagentMessageConfirmation,
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
  renderChatSurface(host, options.projection);
  return {
    update(nextOptions: ChatSurfaceOptions) {
      renderChatSurface(host, nextOptions.projection);
    },
    unmount() {
      host.replaceChildren();
      host.removeAttribute("data-chat-surface");
      host.className = "";
    },
  };
}

function renderChatSurface(host: HTMLElement, projection: ChatUiProjection): void {
  activeDocument = host.ownerDocument;
  host.replaceChildren();
  host.setAttribute("data-chat-surface", "rebuild-chat-agent-surface");
  host.className = "desktop-conversation-thread desktop-chat-surface";

  const shell = element("div", "desktop-chat-surface__shell");
  shell.append(renderSessionList(projection));
  shell.append(renderChatDetail(projection));
  const detailSurface = renderDetailSurface(projection);
  if (detailSurface) {
    shell.append(detailSurface);
  }
  host.append(shell);
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

function renderChatDetail(projection: ChatUiProjection): HTMLElement {
  const detail = element("section", "desktop-chat-surface__detail");
  detail.setAttribute("data-chat-region", "chat-detail");
  const activeSession = projection.sessions.find((session) => session.key === projection.activeSessionKey);
  detail.append(renderHeader(activeSession?.title ?? "New session"));
  detail.append(renderConversation(projection.turns));
  const approvalCard = renderApprovalCard(projection.approvals);
  if (approvalCard) {
    detail.append(approvalCard);
  }
  for (const approvalResult of renderApprovalResults(projection.approvals)) {
    detail.append(approvalResult);
  }
  const subagentStrip = renderSubagentStrip(projection.liveSubagents);
  if (subagentStrip) {
    detail.append(subagentStrip);
  }
  const queue = renderQueuedInputs(projection.queuedInputs);
  if (queue) {
    detail.append(queue);
  }
  detail.append(renderComposer(projection.approvals.length > 0 ? "approval_guidance" : "normal"));
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

function renderConversation(turns: ChatTurn[]): HTMLElement {
  const conversation = element("div", "desktop-chat-surface__conversation");
  conversation.setAttribute("data-chat-region", "conversation");
  for (const turn of turns) {
    conversation.append(renderTurn(turn));
  }
  return conversation;
}

function renderTurn(turn: ChatTurn): HTMLElement {
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
    article.append(renderToolRow(tool));
  }
  return article;
}

function renderToolRow(tool: ToolCallSummary): HTMLElement {
  const row = element("button", "desktop-chat-surface__tool-row");
  row.type = "button";
  row.setAttribute("data-chat-region", "tool-row");
  row.setAttribute("data-tool-call-id", tool.id);
  row.setAttribute("data-tool-status", tool.status);
  row.textContent = `${tool.name} · ${statusLabel(tool.status)}${tool.preview ? ` · ${tool.preview}` : ""}`;
  return row;
}

function renderDetailSurface(projection: ChatUiProjection): HTMLElement | null {
  const panel = projection.detailPanel;
  if (!panel.open || panel.kind === "none") {
    return null;
  }
  const surface = element("aside", "desktop-chat-surface__detail-surface");
  surface.setAttribute("data-chat-region", "detail-surface");
  surface.setAttribute("data-detail-kind", panel.kind);
  surface.setAttribute("data-detail-presentation", panel.presentation);
  if (panel.kind === "tool") {
    surface.append(renderToolDetail(projection.turns, panel));
  } else if (panel.kind === "subagent") {
    surface.append(renderSubagentDetail(projection.liveSubagents, panel));
  } else if (panel.kind === "artifact") {
    surface.append(renderArtifactDetail(projection.artifacts ?? [], panel));
  } else if (panel.kind === "error") {
    surface.append(renderErrorDetail(projection.errors ?? [], panel));
  } else {
    surface.append(element("div", "desktop-chat-surface__detail-empty", "Detail unavailable"));
  }
  return surface;
}

function renderSubagentStrip(subagents: LiveSubagent[]): HTMLElement | null {
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

function renderQueuedInputs(inputs: QueuedInput[]): HTMLElement | null {
  if (!inputs.length) {
    return null;
  }
  const section = element("section", "desktop-chat-surface__queued-inputs");
  section.setAttribute("data-chat-region", "queued-inputs");
  section.append(element("h3", "desktop-chat-surface__queued-title", `Queued inputs · ${inputs.length}`));
  for (const input of inputs) {
    const row = element("div", "desktop-chat-surface__queued-row");
    row.setAttribute("data-queued-input-id", input.id);
    row.append(element("span", "desktop-chat-surface__queued-content", input.content));
    const del = element("button", "desktop-chat-surface__queued-delete", "Delete");
    del.type = "button";
    del.setAttribute("data-queued-input-action", "delete");
    row.append(del);
    section.append(row);
  }
  return section;
}

function renderComposer(mode: "normal" | "approval_guidance"): HTMLElement {
  const composer = element("section", "desktop-chat-surface__composer");
  composer.setAttribute("data-chat-region", "composer");
  composer.setAttribute("data-composer-mode", mode);
  if (mode === "approval_guidance") {
    composer.append(element("p", "desktop-chat-surface__composer-hint", "发送文字将拒绝此请求，并作为给 Tinybot 的指导。"));
  }
  return composer;
}

function renderSubagentDetail(subagents: LiveSubagent[], panel: DetailPanelState): HTMLElement {
  const subagent = subagents.find((candidate) => candidate.id === panel.targetId);
  const detail = element("section", "desktop-chat-surface__subagent-detail");
  detail.append(renderCloseButton());
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
    const item = element("div", "desktop-chat-surface__subagent-message", `${message.role}: ${message.content}`);
    item.setAttribute("data-subagent-message-id", message.id);
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
    if (requiresFirstDirectSubagentMessageConfirmation(subagent)) {
      input.setAttribute("data-requires-confirmation", "true");
    }
    detail.append(input);
  } else if (subagent.status === "completed" || subagent.status === "idle") {
    detail.append(element("p", "desktop-chat-surface__readonly", "This subagent is closed and can only be reviewed."));
  } else {
    detail.append(element("p", "desktop-chat-surface__readonly", "This subagent can currently only show summary content."));
  }
  return detail;
}

function renderToolDetail(turns: ChatTurn[], panel: DetailPanelState): HTMLElement {
  const tool = findTool(turns, panel.targetId || "");
  const detail = element("section", "desktop-chat-surface__tool-detail");
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

function renderArtifactDetail(artifacts: ArtifactDetail[], panel: DetailPanelState): HTMLElement {
  const artifact = artifacts.find((candidate) => candidate.id === panel.targetId);
  const detail = element("section", "desktop-chat-surface__artifact-detail");
  detail.append(renderCloseButton());
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

function renderErrorDetail(errors: ErrorDetail[], panel: DetailPanelState): HTMLElement {
  const error = errors.find((candidate) => candidate.id === panel.targetId);
  const detail = element("section", "desktop-chat-surface__error-detail");
  detail.append(renderCloseButton());
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

function renderCloseButton(): HTMLElement {
  const close = element("button", "desktop-chat-surface__detail-close", "Close");
  close.type = "button";
  close.setAttribute("data-detail-action", "close");
  return close;
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
