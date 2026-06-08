import { computed, createApp, defineComponent, h, onBeforeUnmount, ref, type App, type Ref, type VNode } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import type { AgentUiForm } from "../agentUiEvents";
import { logDesktopNativeChatDebug, logDesktopNativeDebug, summarizeDebugText } from "../desktopNativeChatDebug";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderAgentUiFormCardChildren } from "./agentUiFormCardIsland";
import { renderConversationMessageChildren, type ConversationMessageIslandOptions } from "./conversationMessageIsland";
import type { ConversationReferenceIslandOptions } from "./conversationReferenceIsland";
import {
  formatMaybeJson,
  getToolStatusLabel,
  getToolStatusTone,
  isPendingToolApproval,
  normalizeToolStatus,
} from "./toolActivityStatus";
import type { ToolActivityIslandOptions } from "./toolActivityIsland";

export interface ConversationThreadIslandOptions {
  coworkRuns?: ConversationCoworkRunOptions[];
  emptyMessage: string;
  inlineForms?: AgentUiForm[];
  messages: ConversationMessageIslandOptions[];
  onCoworkAgentInspect?: (selection: { agentId: string; sessionId: string }) => void;
  onInlineFormCancel?: (form: AgentUiForm) => void;
  onInlineFormSubmit?: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void;
}

export interface ConversationCoworkRunOptions {
  activeAgentCount: number;
  agentCount: number;
  agents: ConversationCoworkAgentOptions[];
  attentionLabel: string;
  finalOutput: string;
  id: string;
  status: string;
  taskProgress: string;
  title: string;
  workflow: string;
}

export interface ConversationCoworkAgentOptions {
  attentionLabel: string;
  id: string;
  label: string;
  latestActivity: string;
  roleOrTask: string;
  status: string;
}

interface SelectedCoworkAgent {
  agent: ConversationCoworkAgentOptions;
  run: ConversationCoworkRunOptions;
}

export interface MountedConversationThreadIsland {
  update: (options: ConversationThreadIslandOptions) => void;
  unmount: () => void;
}

const mountedConversationThreads = new WeakMap<HTMLElement, MountedConversationThreadIsland>();
const DETAIL_PANEL_MOTION_MS = 360;
type DetailPanelState = "closed" | "open" | "closing";

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
      const selectedReference = ref<ConversationReferenceIslandOptions | null>(null);
      const selectedCoworkAgent = ref<SelectedCoworkAgent | null>(null);
      const detailPanelState = ref<DetailPanelState>("closed");
      const panelWidth = ref(50);
      const overlayMode = ref(isToolDetailOverlayMode());
      let closePanelTimer: number | null = null;
      const selectedTool = computed(() => selectedToolKey.value ? findToolActivity(state.value.messages, selectedToolKey.value) : null);
      const hasDetailPanelSelection = () => Boolean(selectedToolKey.value || selectedReference.value || selectedCoworkAgent.value);
      const clearClosePanelTimer = () => {
        if (closePanelTimer !== null && typeof window !== "undefined") {
          window.clearTimeout(closePanelTimer);
        }
        closePanelTimer = null;
      };
      const clearPanelSelection = () => {
        selectedToolKey.value = "";
        selectedReference.value = null;
        selectedCoworkAgent.value = null;
        detailPanelState.value = "closed";
        clearClosePanelTimer();
      };
      const closePanel = () => {
        if (!hasDetailPanelSelection() || detailPanelState.value === "closing") {
          return;
        }
        if (selectedTool.value) {
          logDesktopNativeDebug("toolDetail.close", summarizeToolActivity(selectedTool.value));
        }
        detailPanelState.value = "closing";
        clearClosePanelTimer();
        if (typeof window === "undefined") {
          clearPanelSelection();
          return;
        }
        closePanelTimer = window.setTimeout(clearPanelSelection, DETAIL_PANEL_MOTION_MS);
      };
      const openPanel = () => {
        clearClosePanelTimer();
        detailPanelState.value = "open";
      };
      const handleLayoutClick = (event: MouseEvent) => {
        if (detailPanelState.value !== "open" || isDetailPanelPreservingClickTarget(event.target)) {
          return;
        }
        closePanel();
      };
      const openReferenceDetail = (reference: ConversationReferenceIslandOptions) => {
        openPanel();
        selectedToolKey.value = "";
        selectedReference.value = reference;
        selectedCoworkAgent.value = null;
        state.value.onReferenceInspect?.(reference);
      };
      const openCoworkAgentDetail = (run: ConversationCoworkRunOptions, agent: ConversationCoworkAgentOptions) => {
        openPanel();
        selectedToolKey.value = "";
        selectedReference.value = null;
        selectedCoworkAgent.value = { agent, run };
        state.value.onCoworkAgentInspect?.({ agentId: agent.id, sessionId: run.id });
      };
      const openToolDetail = (event: Event) => {
        const detail = (event as CustomEvent<{ activity?: ToolActivityIslandOptions }>).detail;
        const activity = detail?.activity;
        if (!activity) {
          return;
        }
        openPanel();
        selectedReference.value = null;
        selectedCoworkAgent.value = null;
        selectedToolKey.value = toolActivitySelectionKey(activity);
        logDesktopNativeDebug("toolDetail.open", summarizeToolActivity(activity));
      };
      const handleKeydown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && hasDetailPanelSelection()) {
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
        clearClosePanelTimer();
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => {
          const nodes = [
            ...renderThreadMessages(state.value.messages, selectedToolKey.value, openReferenceDetail),
            ...(state.value.coworkRuns ?? []).map((run) => renderChatCoworkRun(run, openCoworkAgentDetail)),
            ...(state.value.inlineForms ?? []).map((form) => renderInlineAgentUiForm(state.value, form)),
          ];
          const hasPanelSelection = hasDetailPanelSelection();
          const detailPanel = selectedTool.value
            ? renderToolDetailPanel({
              activity: selectedTool.value,
              mode: overlayMode.value ? "overlay" : "push",
              motionState: detailPanelState.value,
              onClose: closePanel,
              onResize: (nextWidth) => {
                panelWidth.value = clampToolPanelWidth(nextWidth);
                logDesktopNativeDebug("toolDetail.resize", {
                  ...summarizeToolActivity(selectedTool.value),
                  widthPercent: panelWidth.value,
                });
              },
            })
            : selectedReference.value
              ? renderReferenceDetailPanel({
                mode: overlayMode.value ? "overlay" : "push",
                motionState: detailPanelState.value,
                onClose: closePanel,
                onResize: (nextWidth) => {
                  panelWidth.value = clampToolPanelWidth(nextWidth);
                },
                reference: selectedReference.value,
              })
              : selectedCoworkAgent.value
                ? renderCoworkAgentDetailPanel({
                  mode: overlayMode.value ? "overlay" : "push",
                  motionState: detailPanelState.value,
                  onClose: closePanel,
                  onResize: (nextWidth) => {
                    panelWidth.value = clampToolPanelWidth(nextWidth);
                  },
                  selection: selectedCoworkAgent.value,
                })
                : null;
          return nodes.length
            ? h("div", {
              class: "desktop-conversation-layout",
              "data-cowork-agent-detail-visible": String(Boolean(selectedCoworkAgent.value) && detailPanelState.value === "open"),
              "data-detail-panel-state": hasPanelSelection ? detailPanelState.value : "closed",
              "data-reference-detail-visible": String(Boolean(selectedReference.value) && detailPanelState.value === "open"),
              "data-tool-detail-visible": String(Boolean(selectedTool.value) && detailPanelState.value === "open"),
              onClick: handleLayoutClick,
              onDesktopToolDetailOpen: openToolDetail,
              onKeydown: handleKeydown,
              style: hasPanelSelection
                ? { "--desktop-tool-detail-width": `${panelWidth.value}%` }
                : undefined,
              tabindex: "-1",
            }, [
              h("div", { class: "desktop-conversation-timeline" }, nodes),
              detailPanel
                ? h("div", {
                  class: "desktop-detail-panel-slot",
                  "data-detail-panel-state": detailPanelState.value,
                }, [detailPanel])
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

function renderThreadMessages(
  messages: ConversationMessageIslandOptions[],
  selectedToolKey: string,
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void,
): VNode[] {
  const nodes: VNode[] = [];
  let assistantRun: AssistantMessageRunItem[] = [];
  const flushAssistantRun = () => {
    nodes.push(...renderAssistantRun(assistantRun, selectedToolKey, onReferenceInspect));
    assistantRun = [];
  };
  messages.forEach((message, index) => {
    if (message.tone === "assistant") {
      assistantRun.push({ index, message });
      return;
    }
    flushAssistantRun();
    nodes.push(renderThreadMessage(message, index, selectedToolKey, true, onReferenceInspect));
  });
  flushAssistantRun();
  return nodes;
}

function isDetailPanelPreservingClickTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(target.closest([
    ".desktop-tool-detail-panel",
    ".desktop-tool-activity-row",
    ".desktop-message-reference-item",
    ".desktop-chat-cowork-agent-row",
    ".desktop-agent-ui-form-card",
  ].join(",")));
}

function renderAssistantRun(
  run: AssistantMessageRunItem[],
  selectedToolKey: string,
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void,
): VNode[] {
  if (!run.length) {
    return [];
  }
  const final = run[run.length - 1];
  const shouldFold = run.length > 1 && hasAssistantFinalAnswer(final.message);
  if (!shouldFold) {
    const copyable = run.length === 1 && hasAssistantFinalAnswer(final.message);
    return run.map((item) => renderThreadMessage(item.message, item.index, selectedToolKey, copyable, onReferenceInspect));
  }
  const intermediate = run.slice(0, -1);
  return [
    renderAssistantStepGroup(intermediate, selectedToolKey, onReferenceInspect),
    renderThreadMessage(final.message, final.index, selectedToolKey, true, onReferenceInspect),
  ];
}

function renderAssistantStepGroup(
  items: AssistantMessageRunItem[],
  selectedToolKey: string,
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void,
) {
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
      onReferenceInspect,
    ))),
  ]);
}

function renderThreadMessage(
  message: ConversationMessageIslandOptions,
  index: number,
  selectedToolKey: string,
  copyable = true,
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void,
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
    onReferenceInspect,
    toolActivities,
  }));
}

function renderChatCoworkRun(run: ConversationCoworkRunOptions, onCoworkAgentInspect: (run: ConversationCoworkRunOptions, agent: ConversationCoworkAgentOptions) => void): VNode {
  return h("section", {
    key: `chat-cowork:${run.id}`,
    class: "desktop-chat-cowork-surface",
    "data-cowork-session-id": run.id,
    "data-desktop-chat-region": "chat-cowork-surface",
  }, [
    h("header", { class: "desktop-chat-cowork-header" }, [
      h("div", { class: "desktop-chat-cowork-title" }, [
        h("span", { class: "desktop-chat-cowork-eyebrow" }, "Cowork run"),
        h("strong", run.title || run.id || "Cowork run"),
        h("small", [run.id ? `Session ${run.id}` : "", run.workflow].filter(Boolean).join(" - ")),
      ]),
      h("div", { class: "desktop-chat-cowork-metrics" }, [
        renderCoworkMetric("Status", run.status || "active"),
        renderCoworkMetric("Agents", String(run.agentCount || 0)),
        renderCoworkMetric("Active", String(run.activeAgentCount || 0)),
        renderCoworkMetric("Tasks", run.taskProgress || "0/0"),
      ]),
    ]),
    h("div", { class: "desktop-chat-cowork-summary" }, [
      h("span", { class: "desktop-chat-cowork-progress" }, `Tasks ${run.taskProgress || "0/0"}`),
      h("span", { class: "desktop-chat-cowork-attention" }, run.attentionLabel || "No attention needed"),
    ]),
    h("div", { class: "desktop-chat-cowork-agent-list" }, run.agents.map((agent) => renderCoworkAgent(run, agent, onCoworkAgentInspect))),
    run.finalOutput
      ? h("div", { class: "desktop-chat-cowork-final" }, [
        h("strong", "Final output"),
        h("span", run.finalOutput),
      ])
      : null,
  ]);
}

function renderCoworkMetric(label: string, value: string): VNode {
  return h("span", { class: "desktop-chat-cowork-metric" }, [
    h("span", label),
    h("strong", value),
  ]);
}

function renderCoworkAgent(
  run: ConversationCoworkRunOptions,
  agent: ConversationCoworkAgentOptions,
  onCoworkAgentInspect: (run: ConversationCoworkRunOptions, agent: ConversationCoworkAgentOptions) => void,
): VNode {
  return h("button", {
    "aria-label": `Inspect ${agent.label || agent.id}`,
    class: "desktop-chat-cowork-agent-row",
    "data-desktop-cowork-agent-id": agent.id,
    onClick: () => onCoworkAgentInspect(run, agent),
    type: "button",
  }, [
    h("span", { class: "desktop-chat-cowork-agent-avatar", "aria-hidden": "true" }, (agent.label || agent.id || "?").slice(0, 1).toUpperCase()),
    h("span", { class: "desktop-chat-cowork-agent-main" }, [
      h("strong", agent.label || agent.id || "Agent"),
      h("span", agent.roleOrTask || "Waiting for work"),
    ]),
    h("span", { class: "desktop-chat-cowork-agent-aside" }, [
      h("span", { class: "desktop-chat-cowork-agent-status" }, agent.status || "idle"),
      agent.latestActivity ? h("small", agent.latestActivity) : null,
      agent.attentionLabel ? h("small", { class: "desktop-chat-cowork-agent-attention" }, agent.attentionLabel) : null,
    ]),
  ]);
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
  motionState: DetailPanelState;
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
    "data-tool-detail-motion": options.motionState,
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

function renderReferenceDetailPanel(options: {
  mode: "overlay" | "push";
  motionState: DetailPanelState;
  onClose: () => void;
  onResize: (nextWidth: number) => void;
  reference: ConversationReferenceIslandOptions;
}) {
  const { reference } = options;
  return h("aside", {
    "aria-label": "Reference details",
    class: "desktop-reference-detail-panel desktop-tool-detail-panel",
    "data-reference-kind": reference.kind,
    "data-tool-detail-mode": options.mode,
    "data-tool-detail-motion": options.motionState,
  }, [
    options.mode === "push"
      ? h("div", {
        "aria-label": "Resize reference details",
        class: "desktop-tool-detail-resizer",
        onPointerdown: (event: PointerEvent) => startToolDetailResize(event, options.onResize),
        role: "separator",
        tabindex: "0",
      })
      : null,
    h("header", { class: "desktop-tool-detail-header" }, [
      h("div", { class: "desktop-tool-detail-title-group" }, [
        h("span", { class: "desktop-tool-detail-eyebrow" }, reference.kind || "reference"),
        h("h3", { class: "desktop-tool-detail-title" }, reference.title || "Reference"),
      ]),
      h("button", {
        "aria-label": "Close reference details",
        class: "desktop-reference-detail-close desktop-tool-detail-close",
        onClick: options.onClose,
        type: "button",
      }, "x"),
    ]),
    h("div", { class: "desktop-tool-detail-body" }, [
      renderToolDetailText("Source", referenceSourceLocationLabel(reference) || reference.title || "Reference", "Source unavailable"),
      referenceRawLocationLabel(reference)
        ? renderToolDetailText("Raw source", referenceRawLocationLabel(reference), "Raw source unavailable")
        : null,
      renderReferenceMetadata(reference),
      renderToolDetailText("Detail", reference.detail || "", "No detail available"),
      renderReferenceSourcePreview(reference),
    ]),
  ]);
}

function referenceSourceLocationLabel(reference: ConversationReferenceIslandOptions): string {
  return referenceLocationLabel(reference.sourcePath || reference.rawPath || reference.title, reference.sourceLine || reference.rawLine);
}

function referenceRawLocationLabel(reference: ConversationReferenceIslandOptions): string {
  if (!reference.rawPath || (reference.rawPath === reference.sourcePath && reference.rawLine === reference.sourceLine)) {
    return "";
  }
  return referenceLocationLabel(reference.rawPath, reference.rawLine);
}

function referenceLocationLabel(path: string | undefined, line: number | undefined): string {
  if (!path) {
    return "";
  }
  return line ? `${path}:${line}` : path;
}

function renderReferenceMetadata(reference: ConversationReferenceIslandOptions) {
  const entries = [
    ["Kind", reference.kind],
    ["Note", reference.noteId],
    ["Evidence", reference.evidenceId],
    ["Scope", reference.scope],
    ["Type", reference.type],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (!entries.length) {
    return null;
  }
  return h("dl", { class: "desktop-tool-detail-meta desktop-reference-detail-meta" }, entries.flatMap(([label, value]) => [
    h("dt", label),
    h("dd", value),
  ]));
}

function renderReferenceSourcePreview(reference: ConversationReferenceIslandOptions) {
  const sourceText = reference.sourceText || reference.detail;
  if (!sourceText.trim()) {
    return null;
  }
  const startLine = reference.sourceLine || reference.rawLine || 1;
  const lines = sourceText.split(/\r?\n/);
  const highlightLine = resolveReferenceHighlightLine(lines, startLine, reference);
  return h("section", { class: "desktop-reference-source-section" }, [
    h("h4", "Original text"),
    h("div", {
      class: "desktop-reference-source-preview",
      "data-highlight-line": String(highlightLine),
    }, lines.map((line, index) => {
      const lineNumber = startLine + index;
      return h("div", {
        class: [
          "desktop-reference-source-line",
          lineNumber === highlightLine ? "highlighted" : "",
        ].filter(Boolean).join(" "),
        "data-line": String(lineNumber),
      }, [
        h("span", { class: "desktop-reference-source-line-number" }, String(lineNumber)),
        h("code", line || " "),
      ]);
    })),
  ]);
}

function resolveReferenceHighlightLine(
  lines: string[],
  startLine: number,
  reference: ConversationReferenceIslandOptions,
): number {
  const needles = [reference.noteId, reference.evidenceId, reference.sourceText, reference.detail]
    .filter((value): value is string => Boolean(value?.trim()));
  for (const needle of needles) {
    const matchIndex = lines.findIndex((line) => line.includes(needle));
    if (matchIndex >= 0) {
      return startLine + matchIndex;
    }
  }
  return startLine;
}

function renderCoworkAgentDetailPanel(options: {
  mode: "overlay" | "push";
  motionState: DetailPanelState;
  onClose: () => void;
  onResize: (nextWidth: number) => void;
  selection: SelectedCoworkAgent;
}) {
  const { agent, run } = options.selection;
  return h("aside", {
    "aria-label": "Cowork agent details",
    class: "desktop-cowork-agent-detail-panel desktop-tool-detail-panel",
    "data-cowork-session-id": run.id,
    "data-desktop-cowork-agent-id": agent.id,
    "data-tool-detail-mode": options.mode,
    "data-tool-detail-motion": options.motionState,
  }, [
    options.mode === "push"
      ? h("div", {
        "aria-label": "Resize Cowork agent details",
        class: "desktop-tool-detail-resizer",
        onPointerdown: (event: PointerEvent) => startToolDetailResize(event, options.onResize),
        role: "separator",
        tabindex: "0",
      })
      : null,
    h("header", { class: "desktop-tool-detail-header" }, [
      h("div", { class: "desktop-tool-detail-title-group" }, [
        h("span", { class: "desktop-tool-detail-eyebrow" }, run.title || "Cowork run"),
        h("h3", { class: "desktop-tool-detail-title" }, agent.label || agent.id || "Agent"),
      ]),
      h("button", {
        "aria-label": "Close Cowork agent details",
        class: "desktop-cowork-agent-detail-close desktop-tool-detail-close",
        onClick: options.onClose,
        type: "button",
      }, "x"),
    ]),
    h("div", { class: "desktop-tool-detail-body" }, [
      renderToolDetailText("Session", [run.id, run.workflow].filter(Boolean).join(" - "), "Session unavailable"),
      renderToolDetailText("Status", agent.status || "", "Status unavailable"),
      renderToolDetailText("Task", agent.roleOrTask || "", "No task available"),
      renderToolDetailText("Latest activity", agent.latestActivity || "", "No recent activity"),
      renderToolDetailText("Attention", agent.attentionLabel || run.attentionLabel || "", "No attention needed"),
      renderToolDetailText("Final output", run.finalOutput || "", "Final output unavailable"),
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
