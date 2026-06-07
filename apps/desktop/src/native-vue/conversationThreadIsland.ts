import { computed, createApp, defineComponent, h, onBeforeUnmount, ref, type App, type Ref, type VNode } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import type { AgentUiForm } from "../agentUiEvents";
import { logDesktopNativeChatDebug, logDesktopNativeDebug, summarizeDebugText } from "../desktopNativeChatDebug";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderAgentUiFormCardChildren } from "./agentUiFormCardIsland";
import { renderConversationMessageChildren, type ConversationMessageIslandOptions } from "./conversationMessageIsland";
import {
  formatMaybeJson,
  getToolStatusLabel,
  getToolStatusTone,
  isPendingToolApproval,
  normalizeToolStatus,
} from "./toolActivityStatus";
import type { ToolActivityIslandOptions } from "./toolActivityIsland";

export interface ConversationThreadIslandOptions {
  emptyMessage: string;
  inlineForms?: AgentUiForm[];
  messages: ConversationMessageIslandOptions[];
  onInlineFormCancel?: (form: AgentUiForm) => void;
  onInlineFormSubmit?: (form: AgentUiForm, values: Record<string, unknown>) => void;
}

export interface MountedConversationThreadIsland {
  update: (options: ConversationThreadIslandOptions) => void;
  unmount: () => void;
}

const mountedConversationThreads = new WeakMap<HTMLElement, MountedConversationThreadIsland>();

export function mountOrUpdateConversationThreadIsland(
  host: HTMLElement,
  options: ConversationThreadIslandOptions,
): MountedConversationThreadIsland {
  logDesktopNativeChatDebug("vue.thread.update", summarizeConversationThreadOptions(options));
  const mounted = mountedConversationThreads.get(host);
  if (mounted) {
    mounted.update(options);
    return mounted;
  }
  const nextMounted = mountConversationThreadIsland(host, options);
  mountedConversationThreads.set(host, nextMounted);
  return nextMounted;
}

function summarizeConversationThreadOptions(options: ConversationThreadIslandOptions): Record<string, unknown> {
  return {
    emptyMessage: options.emptyMessage,
    messageCount: options.messages.length,
    messages: options.messages.slice(-2).map((message) => ({
      body: summarizeDebugText(message.body.join("\n")),
      reasoning: summarizeDebugText(message.reasoningContent),
      tone: message.tone,
      toolActivities: message.toolActivities?.length ?? 0,
    })),
  };
}

export function mountConversationThreadIsland(
  host: HTMLElement,
  options: ConversationThreadIslandOptions,
): MountedConversationThreadIsland {
  applyHostContract(host);
  const state = ref(options);
  const app = createConversationThreadApp(state, host);
  app.mount(host);
  return {
    update: (nextOptions) => {
      applyHostContract(host);
      state.value = nextOptions;
    },
    unmount: () => {
      mountedConversationThreads.delete(host);
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationThreadApp(state: Ref<ConversationThreadIslandOptions>, host: HTMLElement): App {
  return createApp(defineComponent({
    name: "ConversationThreadIsland",
    setup() {
      const selectedToolKey = ref("");
      const panelWidth = ref(50);
      const overlayMode = ref(isToolDetailOverlayMode());
      const selectedTool = computed(() => selectedToolKey.value ? findToolActivity(state.value.messages, selectedToolKey.value) : null);
      const closePanel = () => {
        if (selectedTool.value) {
          logDesktopNativeDebug("toolDetail.close", summarizeToolActivity(selectedTool.value));
        }
        selectedToolKey.value = "";
      };
      const openToolDetail = (event: Event) => {
        const detail = (event as CustomEvent<{ activity?: ToolActivityIslandOptions }>).detail;
        const activity = detail?.activity;
        if (!activity) {
          return;
        }
        selectedToolKey.value = toolActivitySelectionKey(activity);
        logDesktopNativeDebug("toolDetail.open", summarizeToolActivity(activity));
      };
      const handleKeydown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && selectedToolKey.value) {
          closePanel();
        }
      };
      const updateOverlayMode = () => {
        overlayMode.value = isToolDetailOverlayMode();
      };
      if (typeof window !== "undefined") {
        window.addEventListener("resize", updateOverlayMode);
      }
      host.addEventListener("keydown", handleKeydown);
      onBeforeUnmount(() => {
        if (typeof window !== "undefined") {
          window.removeEventListener("resize", updateOverlayMode);
        }
        host.removeEventListener("keydown", handleKeydown);
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => {
          const nodes = [
            ...renderThreadMessages(state.value.messages, selectedToolKey.value),
            ...(state.value.inlineForms ?? []).map((form) => renderInlineAgentUiForm(state.value, form)),
          ];
          return nodes.length
            ? h("div", {
              class: "desktop-conversation-layout",
              "data-tool-detail-visible": String(Boolean(selectedTool.value)),
              onDesktopToolDetailOpen: openToolDetail,
              onKeydown: handleKeydown,
              style: selectedTool.value
                ? { "--desktop-tool-detail-width": `${panelWidth.value}%` }
                : undefined,
              tabindex: "-1",
            }, [
              h("div", { class: "desktop-conversation-timeline" }, nodes),
              selectedTool.value
                ? renderToolDetailPanel({
                  activity: selectedTool.value,
                  mode: overlayMode.value ? "overlay" : "push",
                  onClose: closePanel,
                  onResize: (nextWidth) => {
                    panelWidth.value = clampToolPanelWidth(nextWidth);
                    logDesktopNativeDebug("toolDetail.resize", {
                      ...summarizeToolActivity(selectedTool.value),
                      widthPercent: panelWidth.value,
                    });
                  },
                })
                : null,
            ])
            : (state.value.emptyMessage ? h(NEmpty, { description: state.value.emptyMessage }) : null);
        },
      });
    },
  }));
}

interface AssistantMessageRunItem {
  index: number;
  message: ConversationMessageIslandOptions;
}

function renderThreadMessages(messages: ConversationMessageIslandOptions[], selectedToolKey: string): VNode[] {
  const nodes: VNode[] = [];
  let assistantRun: AssistantMessageRunItem[] = [];
  const flushAssistantRun = () => {
    nodes.push(...renderAssistantRun(assistantRun, selectedToolKey));
    assistantRun = [];
  };
  messages.forEach((message, index) => {
    if (message.tone === "assistant") {
      assistantRun.push({ index, message });
      return;
    }
    flushAssistantRun();
    nodes.push(renderThreadMessage(message, index, selectedToolKey));
  });
  flushAssistantRun();
  return nodes;
}

function renderAssistantRun(run: AssistantMessageRunItem[], selectedToolKey: string): VNode[] {
  if (!run.length) {
    return [];
  }
  const final = run[run.length - 1];
  const shouldFold = run.length > 1 && hasAssistantFinalAnswer(final.message);
  if (!shouldFold) {
    const copyable = run.length === 1 && hasAssistantFinalAnswer(final.message);
    return run.map((item) => renderThreadMessage(item.message, item.index, selectedToolKey, copyable));
  }
  const intermediate = run.slice(0, -1);
  return [
    renderAssistantStepGroup(intermediate, selectedToolKey),
    renderThreadMessage(final.message, final.index, selectedToolKey, true),
  ];
}

function renderAssistantStepGroup(items: AssistantMessageRunItem[], selectedToolKey: string) {
  return h("details", {
    key: `assistant-steps:${items[0]?.index ?? 0}`,
    class: "desktop-assistant-step-group",
    "data-desktop-chat-region": "assistant-intermediate-steps",
  }, [
    h("summary", { class: "desktop-assistant-step-summary" }, [
      h("span", { class: "desktop-assistant-step-summary-label" }, "Processed"),
      h("span", { class: "desktop-assistant-step-summary-count" }, `${items.length} ${items.length === 1 ? "step" : "steps"}`),
      h("span", { class: "desktop-assistant-step-summary-time" }, assistantStepTimeRange(items)),
    ]),
    h("div", { class: "desktop-assistant-step-list" }, items.map((item) => renderThreadMessage(
      item.message,
      item.index,
      selectedToolKey,
      false,
    ))),
  ]);
}

function renderThreadMessage(
  message: ConversationMessageIslandOptions,
  index: number,
  selectedToolKey: string,
  copyable = true,
) {
  const toolActivities = (message.toolActivities ?? []).map((activity) => ({
    ...activity,
    selected: selectedToolKey === toolActivitySelectionKey(activity),
  }));
  return h("article", {
    key: `${message.tone}:${index}`,
    class: "desktop-conversation-message",
    "data-desktop-vue-island": "conversation-message",
    "data-message-tone": message.tone,
  }, renderConversationMessageChildren({
    ...message,
    copyable,
    toolActivities,
  }));
}

function hasAssistantFinalAnswer(message: ConversationMessageIslandOptions): boolean {
  return message.tone === "assistant" && message.body.some((line) => line.trim());
}

function assistantStepTimeRange(items: AssistantMessageRunItem[]): string {
  const first = items[0]?.message.time ?? "";
  const last = items[items.length - 1]?.message.time ?? "";
  if (!first && !last) {
    return "";
  }
  if (!first || first === last) {
    return first || last;
  }
  return `${first} - ${last}`;
}

function renderInlineAgentUiForm(options: ConversationThreadIslandOptions, form: AgentUiForm) {
  return h("article", {
    key: `agent-form:${form.form_id}`,
    class: "desktop-agent-ui-form-card desktop-agent-ui-form-inline",
    "data-agent-ui-form-id": form.form_id,
    "data-agent-ui-form-status": form.status ?? "pending",
    "data-desktop-chat-region": "agent-form-card",
    "data-desktop-vue-island": "agent-ui-form-card",
  }, renderAgentUiFormCardChildren({
    form,
    onCancel: options.onInlineFormCancel,
    onSubmit: options.onInlineFormSubmit,
  }));
}

function renderToolDetailPanel(options: {
  activity: ToolActivityIslandOptions;
  mode: "overlay" | "push";
  onClose: () => void;
  onResize: (nextWidth: number) => void;
}) {
  const { activity } = options;
  const status = normalizeToolStatus(activity);
  const label = getToolStatusLabel(status);
  const tone = getToolStatusTone(status);
  return h("aside", {
    "aria-label": "Tool call details",
    class: "desktop-tool-detail-panel",
    "data-tool-detail-mode": options.mode,
  }, [
    options.mode === "push"
      ? h("div", {
        "aria-label": "Resize tool details",
        class: "desktop-tool-detail-resizer",
        onPointerdown: (event: PointerEvent) => startToolDetailResize(event, options.onResize),
        role: "separator",
        tabindex: "0",
      })
      : null,
    h("header", { class: "desktop-tool-detail-header" }, [
      h("div", { class: "desktop-tool-detail-title-group" }, [
        h("span", { class: "desktop-tool-detail-eyebrow" }, "Tool"),
        h("h3", { class: "desktop-tool-detail-title" }, activity.name || "unknown"),
      ]),
      h("button", {
        "aria-label": "Close tool details",
        class: "desktop-tool-detail-close",
        onClick: options.onClose,
        type: "button",
      }, "x"),
    ]),
    h("div", { class: "desktop-tool-detail-status" }, [
      h("span", { class: "desktop-tool-activity-status-dot", "data-tool-status-tone": tone }),
      h("span", label),
    ]),
    isPendingToolApproval(activity)
      ? h("section", { class: "desktop-tool-detail-approval-actions", "aria-label": "Tool approval actions" }, [
        renderDetailApprovalButton(activity, "approveOnce", "Approve once"),
        renderDetailApprovalButton(activity, "approveSession", "Allow session"),
        renderDetailApprovalButton(activity, "deny", "Deny"),
      ])
      : null,
    h("div", { class: "desktop-tool-detail-body" }, [
      renderToolDetailMeta(activity),
      renderToolDetailText("Arguments", activity.argsText, "No arguments available"),
      renderToolDetailText("Response", activity.responseText, "No response available"),
      renderToolDetailText("stderr", "", "No stderr available"),
      renderToolDetailText("Duration", "", "Duration unavailable"),
    ]),
  ]);
}

function renderDetailApprovalButton(
  activity: ToolActivityIslandOptions,
  action: "approveOnce" | "approveSession" | "deny",
  label: string,
) {
  return h("button", {
    class: `desktop-tool-approval-action desktop-tool-approval-action-${action}`,
    "data-desktop-approval-action": action,
    onClick: (event: MouseEvent) => dispatchDetailApproval(event, activity, action),
    type: "button",
  }, label);
}

function renderToolDetailMeta(activity: ToolActivityIslandOptions) {
  const items = [
    ["approvalId", activity.approvalId || ""],
    ["approvalStatus", activity.approvalStatus || ""],
    ["sessionKey", activity.sessionKey || ""],
    ["kind", activity.kind],
  ].filter(([, value]) => value);
  return h("dl", { class: "desktop-tool-detail-meta" }, items.flatMap(([label, value]) => [
    h("dt", label),
    h("dd", value),
  ]));
}

function renderToolDetailText(label: string, value: string, emptyLabel: string) {
  const formatted = formatMaybeJson(value);
  return h("section", { class: "desktop-tool-detail-section" }, [
    h("h4", label),
    h("pre", { class: "desktop-tool-detail-pre" }, formatted || emptyLabel),
  ]);
}

function dispatchDetailApproval(
  event: MouseEvent,
  activity: ToolActivityIslandOptions,
  action: "approveOnce" | "approveSession" | "deny",
): void {
  if (!activity.approvalId) {
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
      approvalId: activity.approvalId,
      runChainItemKey: activity.runChainItemKey,
      sessionKey: activity.sessionKey,
      toolActivityId: activity.id,
      toolName: activity.name || "unknown",
    },
  }));
}

function findToolActivity(messages: ConversationMessageIslandOptions[], key: string): ToolActivityIslandOptions | null {
  for (const message of messages) {
    const match = (message.toolActivities ?? []).find((activity) => toolActivitySelectionKey(activity) === key);
    if (match) {
      return match;
    }
  }
  return null;
}

function toolActivitySelectionKey(activity: ToolActivityIslandOptions): string {
  return activity.runChainItemKey || activity.id || `${activity.name}:${activity.kind}`;
}

function summarizeToolActivity(activity: ToolActivityIslandOptions | null): Record<string, unknown> {
  return {
    id: activity?.id ?? "",
    kind: activity?.kind ?? "",
    name: activity?.name ?? "",
    runChainItemKey: activity?.runChainItemKey ?? "",
    sessionKey: activity?.sessionKey ?? "",
    status: activity?.status ?? "",
  };
}

function isToolDetailOverlayMode(): boolean {
  return typeof window !== "undefined" ? window.innerWidth < 900 : false;
}

function clampToolPanelWidth(value: number): number {
  return Math.min(65, Math.max(34, value));
}

function startToolDetailResize(event: PointerEvent, onResize: (nextWidth: number) => void): void {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const panel = target.closest(".desktop-tool-detail-panel");
  const layout = target.closest(".desktop-conversation-layout");
  if (!(panel instanceof HTMLElement) || !(layout instanceof HTMLElement)) {
    return;
  }
  const layoutRect = layout.getBoundingClientRect();
  const handlePointerMove = (moveEvent: PointerEvent) => {
    const widthPx = Math.max(0, layoutRect.right - moveEvent.clientX);
    onResize((widthPx / Math.max(layoutRect.width, 1)) * 100);
  };
  const handlePointerUp = () => {
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  };
  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp, { once: true });
}

function applyHostContract(host: HTMLElement): void {
  host.setAttribute("data-desktop-vue-island", "conversation-thread");
  host.className = "desktop-conversation-thread";
  host.setAttribute("aria-label", "Message Timeline");
  host.setAttribute("aria-live", "polite");
  host.setAttribute("data-desktop-chat-region", "message-timeline");
  host.setAttribute("role", "log");
}
