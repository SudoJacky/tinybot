import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import {
  getToolStatusLabel,
  getToolStatusTone,
  isPendingToolApproval,
  normalizeToolStatus,
  type NormalizedToolStatus,
} from "./toolActivityStatus";

export interface ToolActivityIslandOptions {
  approvalId?: string;
  argsText: string;
  approvalStatus: string;
  id: string;
  kind: "call" | "result";
  name: string;
  responseText: string;
  runChainItemKey?: string;
  selected?: boolean;
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
  if (isPendingToolApproval(options)) {
    host.setAttribute("data-desktop-approval-status", options.approvalStatus);
  } else {
    host.removeAttribute("data-desktop-approval-status");
  }
  const status = normalizeToolStatus(options);
  host.setAttribute("data-desktop-tool-activity-status", status.status);
  host.setAttribute("data-desktop-tool-status", status.status);
  host.setAttribute("data-desktop-tool-status-tone", getToolStatusTone(status));
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
  if (isPendingToolApproval(options)) {
    attributes["data-desktop-approval-status"] = options.approvalStatus;
  }
  const status = normalizeToolStatus(options);
  attributes["data-desktop-tool-activity-status"] = status.status;
  attributes["data-desktop-tool-status"] = status.status;
  attributes["data-desktop-tool-status-tone"] = getToolStatusTone(status);
  return h("div", attributes, renderToolActivityChildren(options));
}

export function renderToolActivityChildren(options: ToolActivityIslandOptions) {
  return [
    renderSummary(options),
    isPendingToolApproval(options) ? renderApprovalCard(options) : null,
  ];
}

function renderSummary(options: ToolActivityIslandOptions) {
  const status = normalizeToolStatus(options);
  const label = getToolStatusLabel(status);
  const tone = getToolStatusTone(status);
  return h("button", {
    "aria-label": `Open ${options.name || "unknown"} tool details, ${label}`,
    "aria-selected": String(Boolean(options.selected)),
    class: "desktop-tool-activity-row",
    onClick: (event: MouseEvent) => openToolDetails(event, options, status),
    type: "button",
  }, [
    h("span", {
      "aria-hidden": "true",
      class: "desktop-tool-activity-status-dot",
      "data-tool-status-tone": tone,
    }),
    h("span", { class: "desktop-tool-activity-kind" }, "Tool"),
    h("span", { class: "desktop-tool-activity-separator", "aria-hidden": "true" }, "·"),
    h("span", { class: "desktop-tool-activity-main" }, [
      h(NText, { class: "desktop-tool-activity-title", tag: "span" }, { default: () => options.name || "unknown" }),
    ]),
    h("span", { class: "desktop-tool-activity-separator", "aria-hidden": "true" }, "·"),
    h("span", { class: "desktop-tool-activity-status-label", "data-tool-status-tone": tone }, label),
  ]);
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
    onClick: (event: MouseEvent) => openToolDetails(event, options, normalizeToolStatus(options)),
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

function summarizeToolActivityText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "No details";
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function openToolDetails(
  event: MouseEvent,
  options: ToolActivityIslandOptions,
  status: NormalizedToolStatus,
): void {
  dispatchRunChainInspect(event, options.runChainItemKey);
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  target.dispatchEvent(new CustomEvent("desktop-tool-detail-open", {
    bubbles: true,
    detail: {
      activity: {
        approvalId: options.approvalId,
        approvalStatus: options.approvalStatus,
        argsText: options.argsText,
        id: options.id,
        kind: options.kind,
        name: options.name,
        responseText: options.responseText,
        runChainItemKey: options.runChainItemKey,
        sessionKey: options.sessionKey,
        status: options.status,
      },
      normalizedStatus: status,
    },
  }));
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
