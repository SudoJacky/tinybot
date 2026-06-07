import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NTag, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface ToolActivityIslandOptions {
  approvalId?: string;
  argsText: string;
  approvalStatus: string;
  id: string;
  kind: "call" | "result";
  name: string;
  responseText: string;
  runChainItemKey?: string;
  sessionKey?: string;
  status?: string;
}

export interface MountedToolActivityIsland {
  unmount: () => void;
}

export function mountToolActivityIsland(
  host: HTMLElement,
  options: ToolActivityIslandOptions,
): MountedToolActivityIsland {
  host.setAttribute("data-desktop-vue-island", "tool-activity");
  host.className = "desktop-tool-activity";
  host.setAttribute("data-desktop-tool-activity-kind", options.kind);
  if (options.id) {
    host.setAttribute("data-desktop-tool-activity-id", options.id);
  } else {
    host.removeAttribute("data-desktop-tool-activity-id");
  }
  if (options.runChainItemKey) {
    host.setAttribute("data-desktop-run-chain-item-key", options.runChainItemKey);
  } else {
    host.removeAttribute("data-desktop-run-chain-item-key");
  }
  if (isPendingApproval(options.approvalStatus)) {
    host.setAttribute("data-desktop-approval-status", options.approvalStatus);
  } else {
    host.removeAttribute("data-desktop-approval-status");
  }
  const status = normalizeToolActivityStatus(options.status);
  if (status) {
    host.setAttribute("data-desktop-tool-activity-status", status);
  } else {
    host.removeAttribute("data-desktop-tool-activity-status");
  }
  const app = createToolActivityApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolActivityApp(options: ToolActivityIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolActivityIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderToolActivityChildren(options),
      });
    },
  }));
}

export function renderToolActivityNode(options: ToolActivityIslandOptions) {
  const attributes: Record<string, string> = {
    class: "desktop-tool-activity",
    "data-desktop-tool-activity-kind": options.kind,
  };
  if (options.id) {
    attributes["data-desktop-tool-activity-id"] = options.id;
  }
  if (options.runChainItemKey) {
    attributes["data-desktop-run-chain-item-key"] = options.runChainItemKey;
  }
  if (isPendingApproval(options.approvalStatus)) {
    attributes["data-desktop-approval-status"] = options.approvalStatus;
  }
  const status = normalizeToolActivityStatus(options.status);
  if (status) {
    attributes["data-desktop-tool-activity-status"] = status;
  }
  return h("details", attributes, renderToolActivityChildren(options));
}

export function renderToolActivityChildren(options: ToolActivityIslandOptions) {
  return [
    renderSummary(options),
    isPendingApproval(options.approvalStatus) ? renderApprovalCard(options) : null,
    renderBody(options),
  ];
}

function renderSummary(options: ToolActivityIslandOptions) {
  const status = normalizeToolActivityStatus(options.status);
  return h("summary", {
    "aria-label": status ? `${options.name || "unknown"} tool ${statusLabel(status).toLowerCase()}` : undefined,
    class: "desktop-tool-activity-summary",
    onClick: (event: MouseEvent) => dispatchRunChainInspect(event, options.runChainItemKey),
  }, [
    h("span", { "aria-hidden": "true", class: "desktop-tool-activity-icon" }, ">"),
    h("span", { class: "desktop-tool-activity-main" }, [
      h(NText, { class: "desktop-tool-activity-title", tag: "span" }, { default: () => options.name || "unknown" }),
      h(NText, { class: "desktop-tool-activity-preview", depth: 3, tag: "span" }, {
        default: () => summarizeToolActivityText(options.argsText || options.responseText),
      }),
    ]),
    h("span", { class: "desktop-tool-activity-badges" }, renderBadges(options)),
  ]);
}

function renderBadges(options: ToolActivityIslandOptions) {
  const status = normalizeToolActivityStatus(options.status);
  return [
    status
      ? h(NTag, {
        bordered: false,
        class: `desktop-tool-activity-badge desktop-tool-activity-status-badge desktop-tool-activity-status-${status}`,
        round: true,
        size: "small",
        type: statusTagType(status),
      }, { default: () => statusLabel(status) })
      : null,
    isPendingApproval(options.approvalStatus)
      ? h(NTag, {
        bordered: false,
        class: "desktop-tool-activity-badge desktop-tool-activity-pending-approval-badge",
        round: true,
        size: "small",
        type: "warning",
      }, { default: () => "Approval" })
      : null,
    options.approvalStatus === "approved"
      ? h(NTag, {
        bordered: false,
        class: "desktop-tool-activity-badge desktop-tool-activity-approval-badge",
        round: true,
        size: "small",
        type: "success",
      }, { default: () => "Approved" })
      : null,
    h(NTag, {
      bordered: false,
      class: "desktop-tool-activity-badge",
      round: true,
      size: "small",
    }, { default: () => options.kind === "result" ? "Result" : "Call" }),
  ];
}

function renderApprovalCard(options: ToolActivityIslandOptions) {
  return h("section", {
    "aria-label": `Approval required for ${options.name || "tool"}`,
    class: "desktop-tool-approval-card",
    "data-desktop-chat-region": "approval-card",
    role: "group",
  }, [
    h("div", { class: "desktop-tool-approval-card-header" }, [
      h(NText, { class: "desktop-tool-approval-title", tag: "strong" }, { default: () => "Approval required" }),
      h(NText, { class: "desktop-tool-approval-tool", depth: 3, tag: "span" }, { default: () => options.name || "unknown" }),
    ]),
    h("pre", { class: "desktop-tool-approval-command" }, summarizeToolActivityText(options.argsText || options.responseText)),
    h("div", { class: "desktop-tool-approval-actions" }, renderApprovalActions(options)),
  ]);
}

function renderApprovalActions(options: ToolActivityIslandOptions) {
  const review = h("button", {
    class: "desktop-tool-approval-action desktop-tool-approval-action-review",
    "data-desktop-approval-action": "review",
    onClick: (event: MouseEvent) => dispatchRunChainInspect(event, options.runChainItemKey),
    type: "button",
  }, options.approvalId ? "Review details" : "Review approval");
  if (!options.approvalId) {
    return [review];
  }
  return [
    renderApprovalActionButton(options, "approveOnce", "Approve once"),
    renderApprovalActionButton(options, "approveSession", "Allow session"),
    renderApprovalActionButton(options, "deny", "Deny"),
    review,
  ];
}

function renderApprovalActionButton(
  options: ToolActivityIslandOptions,
  action: "approveOnce" | "approveSession" | "deny",
  label: string,
) {
  return h("button", {
    class: `desktop-tool-approval-action desktop-tool-approval-action-${action}`,
    "data-desktop-approval-action": action,
    onClick: (event: MouseEvent) => dispatchApprovalAction(event, options, action),
    type: "button",
  }, label);
}

function renderBody(options: ToolActivityIslandOptions) {
  const children = [];
  if (options.argsText) {
    children.push(renderSection("Arguments", options.argsText, "call"));
  }
  if (options.responseText) {
    children.push(renderSection("Response", options.responseText, "response"));
  }
  if (!children.length) {
    children.push(h("div", { class: "desktop-tool-activity-empty" }, "No arguments or response."));
  }
  return h("div", { class: "desktop-tool-activity-body" }, children);
}

function renderSection(label: string, text: string, kind: "call" | "response") {
  if (shouldCollapseToolContent(text)) {
    return h("div", { class: `desktop-tool-activity-section desktop-tool-activity-section-${kind}` }, [
      h("details", { class: "desktop-tool-activity-content-details" }, [
        h("summary", { class: "desktop-tool-activity-content-summary" }, [
          h(NText, { class: "desktop-tool-activity-label", tag: "span" }, { default: () => label }),
          h("span", { class: "desktop-tool-activity-content-preview" }, summarizeToolActivityText(text)),
        ]),
        h("pre", { class: "desktop-tool-activity-pre" }, text),
      ]),
    ]);
  }
  return h("div", { class: `desktop-tool-activity-section desktop-tool-activity-section-${kind}` }, [
    h(NText, { class: "desktop-tool-activity-label", tag: "div" }, { default: () => label }),
    h("pre", { class: "desktop-tool-activity-pre" }, text),
  ]);
}

function summarizeToolActivityText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No details";
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function shouldCollapseToolContent(value: string): boolean {
  return value.length > 140 || value.split(/\r?\n/).length > 6;
}

function isPendingApproval(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes("approval") && !normalized.includes("approved");
}

function normalizeToolActivityStatus(status: string | undefined): string {
  const normalized = (status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) {
    return "";
  }
  if (["running", "in_progress", "started", "streaming"].includes(normalized)) {
    return "running";
  }
  if (["pending", "queued", "created", "waiting"].includes(normalized)) {
    return "pending";
  }
  if (["completed", "complete", "success", "succeeded", "done"].includes(normalized)) {
    return "completed";
  }
  if (["failed", "failure", "error", "errored"].includes(normalized)) {
    return "failed";
  }
  if (["blocked", "approval_required", "waiting_approval"].includes(normalized)) {
    return "blocked";
  }
  if (["cancelled", "canceled", "interrupted", "stopped"].includes(normalized)) {
    return "cancelled";
  }
  return normalized;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    blocked: "Blocked",
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    pending: "Pending",
    running: "Running",
  };
  return labels[status] || status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function statusTagType(status: string): "default" | "error" | "info" | "success" | "warning" {
  if (status === "completed") {
    return "success";
  }
  if (status === "failed") {
    return "error";
  }
  if (status === "blocked" || status === "pending") {
    return "warning";
  }
  if (status === "running") {
    return "info";
  }
  return "default";
}

function dispatchRunChainInspect(event: MouseEvent, itemKey?: string): void {
  if (!itemKey) {
    return;
  }
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.dispatchEvent(new CustomEvent("desktop-run-chain-inspect", {
    bubbles: true,
    detail: { itemKey },
  }));
}

function dispatchApprovalAction(
  event: MouseEvent,
  options: ToolActivityIslandOptions,
  action: "approveOnce" | "approveSession" | "deny",
): void {
  if (!options.approvalId) {
    return;
  }
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.dispatchEvent(new CustomEvent("desktop-tool-approval-action", {
    bubbles: true,
    detail: {
      action,
      approvalId: options.approvalId,
      runChainItemKey: options.runChainItemKey,
      sessionKey: options.sessionKey,
      toolActivityId: options.id,
      toolName: options.name || "unknown",
    },
  }));
}
