import { computed, createApp, defineComponent, h, nextTick, onBeforeUnmount, ref, type App, type Ref, type VNode } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import type { AgentUiForm } from "../agentUiEvents";
import { logDesktopNativeChatDebug, logDesktopNativeDebug, summarizeDebugText } from "../desktopNativeChatDebug";
import { sanitizeTextPreview } from "../chatRunModel";
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
  onArtifactLoad?: (selection: DelegateArtifactLoadSelection) => Promise<unknown>;
  onDelegateTraceLoad?: (selection: DelegateTraceLoadSelection) => Promise<unknown>;
  onInlineFormCancel?: (form: AgentUiForm) => void;
  onInlineFormSubmit?: (form: AgentUiForm, values: Record<string, unknown>) => void;
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void;
}

export interface DelegateTraceLoadSelection {
  activityId: string;
  delegateId?: string;
  sessionKey: string;
  traceRef?: string;
}

export interface DelegateArtifactLoadSelection extends DelegateTraceLoadSelection {
  artifactId: string;
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

interface ConversationTimelineScrollState {
  bottomOffset: number;
  scrollTop: number;
  wasNearBottom: boolean;
}

type DetailPanelState = "closed" | "opening" | "open" | "closing";
type AgentToolKind = "tool" | "spawn" | "subagent" | "cowork" | "team";
type AgentFlowStepKind = "thinking" | "tool" | "spawn" | "subagent" | "cowork" | "team" | "response";
type SubagentObservabilityTab = "overview" | "timeline" | "transcript" | "tools" | "approvals" | "artifacts" | "raw";

interface AssistantMessageRunItem {
  index: number;
  message: ConversationMessageIslandOptions;
}

interface AgentToolProfile {
  contextLabel: string;
  headline: string;
  kind: AgentToolKind;
  label: string;
  tone: string;
}

interface AgentWorkflowStep {
  agent: string;
  detail: string;
  status: string;
  title: string;
}

interface SubagentTraceStep {
  id: string;
  kind: string;
  raw: Record<string, unknown>;
  status: string;
  title: string;
}

interface SubagentShelfItem {
  activity: ToolActivityIslandOptions;
  key: string;
  latestActivity: string;
  statusLabel: string;
  task: string;
  title: string;
}

interface AgentFlowStepProfile {
  kind: AgentFlowStepKind;
  label: string;
  title: string;
}

interface DelegateTraceLoadState {
  error: string;
  loading: boolean;
  trace: Record<string, unknown> | null;
}

interface DelegateArtifactLoadState {
  artifact: Record<string, unknown> | null;
  error: string;
  loading: boolean;
}

const mountedConversationThreads = new WeakMap<HTMLElement, MountedConversationThreadIsland>();
const DETAIL_PANEL_MOTION_MS = 560;
const TIMELINE_EAGER_NODE_LIMIT = 300;
type ActivityInspectorKind = "approval" | "artifact" | "delegate" | "tool_call";
const CONVERSATION_AGENT_FLOW_STYLE_ID = "desktop-conversation-agent-flow-styles";
const AGENT_WORKFLOW_STEP_LIMIT = 8;

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
    coworkRuns: options.coworkRuns?.length ?? 0,
    emptyMessage: options.emptyMessage,
    inlineForms: options.inlineForms?.length ?? 0,
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
      const scrollState = captureConversationTimelineScroll(host);
      state.value = nextOptions;
      queueConversationTimelineScrollRestore(host, scrollState);
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
      const selectedSubagentTraceTab = ref<SubagentObservabilityTab>("overview");
      const detailPanelState = ref<DetailPanelState>("closed");
      const delegateArtifactLoads = ref(new Map<string, DelegateArtifactLoadState>());
      const delegateTraceLoads = ref(new Map<string, DelegateTraceLoadState>());
      const panelWidth = ref(50);
      const overlayMode = ref(isToolDetailOverlayMode());
      const reducedMotion = ref(prefersReducedMotion());
      let closePanelTimer: number | null = null;
      let openPanelFrame: number | null = null;
      const selectedTool = computed(() => {
        const activity = selectedToolKey.value ? findToolActivity(state.value.messages, selectedToolKey.value) : null;
        if (!activity) {
          return null;
        }
        const loaded = delegateTraceLoads.value.get(delegateTraceLoadKey(activity));
        if (!loaded?.trace) {
          return activity;
        }
        return {
          ...activity,
          delegatedTrace: loaded.trace,
        };
      });
      const subagentShelfItems = computed(() => collectSubagentShelfItems(state.value.messages));
      const hasDetailPanelSelection = () => Boolean(selectedTool.value || selectedReference.value || selectedCoworkAgent.value);
      const clearClosePanelTimer = () => {
        if (closePanelTimer !== null && typeof window !== "undefined") {
          window.clearTimeout(closePanelTimer);
        }
        closePanelTimer = null;
      };
      const clearOpenPanelFrame = () => {
        if (openPanelFrame !== null && typeof window !== "undefined" && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(openPanelFrame);
        }
        openPanelFrame = null;
      };
      const clearPanelSelection = () => {
        selectedToolKey.value = "";
        selectedReference.value = null;
        selectedCoworkAgent.value = null;
        detailPanelState.value = "closed";
        clearClosePanelTimer();
        clearOpenPanelFrame();
      };
      const closePanel = () => {
        if (!hasDetailPanelSelection() || detailPanelState.value === "closing") {
          return;
        }
        if (selectedTool.value) {
          logDesktopNativeDebug("toolDetail.close", summarizeToolActivity(selectedTool.value));
        }
        detailPanelState.value = "closing";
        clearOpenPanelFrame();
        clearClosePanelTimer();
        if (typeof window === "undefined" || reducedMotion.value) {
          clearPanelSelection();
          return;
        }
        closePanelTimer = window.setTimeout(clearPanelSelection, DETAIL_PANEL_MOTION_MS);
      };
      const openPanel = () => {
        clearClosePanelTimer();
        if (detailPanelState.value === "open") {
          return;
        }
        clearOpenPanelFrame();
        detailPanelState.value = "opening";
        if (typeof window === "undefined" || reducedMotion.value || typeof window.requestAnimationFrame !== "function") {
          detailPanelState.value = "open";
          return;
        }
        openPanelFrame = window.requestAnimationFrame(() => {
          openPanelFrame = window.requestAnimationFrame(() => {
            openPanelFrame = null;
            if (detailPanelState.value === "opening" && hasDetailPanelSelection()) {
              detailPanelState.value = "open";
            }
          });
        });
      };
      const handleLayoutClick = (event: MouseEvent) => {
        if ((detailPanelState.value !== "open" && detailPanelState.value !== "opening") || isDetailPanelPreservingClickTarget(event.target)) {
          return;
        }
        closePanel();
      };
      const openReferenceDetail = (reference: ConversationReferenceIslandOptions) => {
        selectedToolKey.value = "";
        selectedReference.value = reference;
        selectedCoworkAgent.value = null;
        openPanel();
        state.value.onReferenceInspect?.(reference);
      };
      const openCoworkAgentDetail = (run: ConversationCoworkRunOptions, agent: ConversationCoworkAgentOptions) => {
        selectedToolKey.value = "";
        selectedReference.value = null;
        selectedCoworkAgent.value = { agent, run };
        openPanel();
        state.value.onCoworkAgentInspect?.({ agentId: agent.id, sessionId: run.id });
      };
      const openToolDetail = (event: Event) => {
        const detail = (event as CustomEvent<{ activity?: ToolActivityIslandOptions }>).detail;
        const activity = detail?.activity;
        if (!activity) {
          return;
        }
        selectedReference.value = null;
        selectedCoworkAgent.value = null;
        selectedToolKey.value = toolActivitySelectionKey(activity);
        selectedSubagentTraceTab.value = "overview";
        requestDelegateTraceLoad(activity);
        openPanel();
        logDesktopNativeDebug("toolDetail.open", summarizeToolActivity(activity));
      };
      const openSubagentDetail = (item: SubagentShelfItem) => {
        selectedReference.value = null;
        selectedCoworkAgent.value = null;
        selectedToolKey.value = item.key;
        selectedSubagentTraceTab.value = "overview";
        requestDelegateTraceLoad(item.activity);
        openPanel();
        logDesktopNativeDebug("subagentDetail.open", summarizeToolActivity(item.activity));
      };
      const requestDelegateTraceLoad = (activity: ToolActivityIslandOptions) => {
        if (!state.value.onDelegateTraceLoad || activityInspectorKind(activity) !== "delegate") {
          return;
        }
        const selection = delegateTraceLoadSelection(activity);
        if (!selection) {
          return;
        }
        const key = delegateTraceLoadKey(activity);
        const current = delegateTraceLoads.value.get(key);
        if (current?.loading || current?.trace) {
          return;
        }
        delegateTraceLoads.value = new Map(delegateTraceLoads.value).set(key, {
          error: "",
          loading: true,
          trace: null,
        });
        logDesktopNativeDebug("subagentTrace.load.start", {
          activityId: selection.activityId,
          delegateId: selection.delegateId ?? "",
          sessionKey: selection.sessionKey,
          traceRef: selection.traceRef ?? "",
        });
        state.value.onDelegateTraceLoad(selection).then((payload) => {
          const trace = normalizeLoadedDelegateTrace(payload);
          delegateTraceLoads.value = new Map(delegateTraceLoads.value).set(key, {
            error: "",
            loading: false,
            trace,
          });
          logDesktopNativeDebug("subagentTrace.load.complete", {
            activityId: selection.activityId,
            delegateId: selection.delegateId ?? "",
            hasTrace: Boolean(trace),
            sessionKey: selection.sessionKey,
            traceRef: selection.traceRef ?? "",
          });
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          delegateTraceLoads.value = new Map(delegateTraceLoads.value).set(key, {
            error: message,
            loading: false,
            trace: null,
          });
          logDesktopNativeDebug("subagentTrace.load.failed", {
            activityId: selection.activityId,
            delegateId: selection.delegateId ?? "",
            error: message,
            sessionKey: selection.sessionKey,
            traceRef: selection.traceRef ?? "",
          });
        });
      };
      const requestDelegateArtifactLoad = (activity: ToolActivityIslandOptions, artifactId: string) => {
        if (!state.value.onArtifactLoad || activityInspectorKind(activity) !== "delegate") {
          return;
        }
        const selection = delegateArtifactLoadSelection(activity, artifactId);
        if (!selection) {
          return;
        }
        const key = delegateArtifactLoadKey(activity, artifactId);
        const current = delegateArtifactLoads.value.get(key);
        if (current?.loading || current?.artifact) {
          return;
        }
        delegateArtifactLoads.value = new Map(delegateArtifactLoads.value).set(key, {
          artifact: null,
          error: "",
          loading: true,
        });
        logDesktopNativeDebug("subagentArtifact.load.start", {
          activityId: selection.activityId,
          artifactId: selection.artifactId,
          delegateId: selection.delegateId ?? "",
          sessionKey: selection.sessionKey,
          traceRef: selection.traceRef ?? "",
        });
        state.value.onArtifactLoad(selection).then((payload) => {
          const artifact = normalizeLoadedArtifact(payload);
          delegateArtifactLoads.value = new Map(delegateArtifactLoads.value).set(key, {
            artifact,
            error: "",
            loading: false,
          });
          logDesktopNativeDebug("subagentArtifact.load.complete", {
            activityId: selection.activityId,
            artifactId: selection.artifactId,
            delegateId: selection.delegateId ?? "",
            hasArtifact: Boolean(artifact),
            sessionKey: selection.sessionKey,
            traceRef: selection.traceRef ?? "",
          });
        }).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          delegateArtifactLoads.value = new Map(delegateArtifactLoads.value).set(key, {
            artifact: null,
            error: message,
            loading: false,
          });
          logDesktopNativeDebug("subagentArtifact.load.failed", {
            activityId: selection.activityId,
            artifactId: selection.artifactId,
            delegateId: selection.delegateId ?? "",
            error: message,
            sessionKey: selection.sessionKey,
            traceRef: selection.traceRef ?? "",
          });
        });
      };
      const handleKeydown = (event: KeyboardEvent) => {
        if (event.key === "Escape" && hasDetailPanelSelection()) {
          closePanel();
        }
      };
      const updateOverlayMode = () => {
        overlayMode.value = isToolDetailOverlayMode();
        reducedMotion.value = prefersReducedMotion();
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
        clearOpenPanelFrame();
      });
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => {
          const nodes = [
            ...renderThreadMessages(state.value.messages, selectedToolKey.value, openReferenceDetail),
            ...(state.value.coworkRuns ?? []).map((run) => renderChatCoworkRun(run, openCoworkAgentDetail)),
            ...(state.value.inlineForms ?? []).map((form) => renderInlineAgentUiForm(state.value, form)),
          ];
          const timelineNodes = windowTimelineNodes(nodes);
          const hasPanelSelection = hasDetailPanelSelection();
          const detailPanel = selectedTool.value
            ? renderActivityInspectorPanel({
              activity: selectedTool.value,
              artifactLoads: delegateArtifactLoads.value,
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
              onSubagentTraceTabChange: (tab) => {
                selectedSubagentTraceTab.value = tab;
              },
              onSubagentArtifactLoad: (artifactId) => {
                if (selectedTool.value) {
                  requestDelegateArtifactLoad(selectedTool.value, artifactId);
                }
              },
              subagentTraceTab: selectedSubagentTraceTab.value,
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
              class: "desktop-conversation-body-layout",
              "data-cowork-agent-detail-visible": String(Boolean(selectedCoworkAgent.value) && detailPanelState.value === "open"),
              "data-detail-panel-mode": overlayMode.value ? "overlay" : "push",
              "data-detail-panel-state": hasPanelSelection ? detailPanelState.value : "closed",
              "data-large-timeline-windowed": String(nodes.length > TIMELINE_EAGER_NODE_LIMIT),
              "data-reference-detail-visible": String(Boolean(selectedReference.value) && detailPanelState.value === "open"),
              "data-reduced-motion": String(reducedMotion.value),
              "data-tool-detail-visible": String(Boolean(selectedTool.value) && detailPanelState.value === "open"),
              onClick: handleLayoutClick,
              onDesktopToolDetailOpen: openToolDetail,
              onKeydown: handleKeydown,
              style: hasPanelSelection
                ? { "--desktop-tool-detail-width": `${panelWidth.value}%` }
                : undefined,
              tabindex: "-1",
            }, [
              h("div", {
                class: "desktop-conversation-layout",
                "data-cowork-agent-detail-visible": String(Boolean(selectedCoworkAgent.value) && detailPanelState.value === "open"),
                "data-detail-panel-state": hasPanelSelection ? detailPanelState.value : "closed",
                "data-large-timeline-windowed": String(nodes.length > TIMELINE_EAGER_NODE_LIMIT),
                "data-reference-detail-visible": String(Boolean(selectedReference.value) && detailPanelState.value === "open"),
                "data-reduced-motion": String(reducedMotion.value),
                "data-tool-detail-visible": String(Boolean(selectedTool.value) && detailPanelState.value === "open"),
                style: hasPanelSelection
                  ? { "--desktop-tool-detail-width": `${panelWidth.value}%` }
                  : undefined,
              }, [
                h("div", {
                  class: "desktop-conversation-timeline",
                  "data-rendered-node-count": String(timelineNodes.length),
                  "data-total-node-count": String(nodes.length),
                }, timelineNodes),
                renderSubagentShelf(subagentShelfItems.value, selectedToolKey.value, openSubagentDetail),
              ]),
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

function windowTimelineNodes(nodes: VNode[]): VNode[] {
  if (nodes.length <= TIMELINE_EAGER_NODE_LIMIT) {
    return nodes;
  }
  const omitted = nodes.length - TIMELINE_EAGER_NODE_LIMIT;
  return [
    h("div", {
      key: "timeline-window-placeholder",
      class: "desktop-conversation-large-window-placeholder",
      "data-omitted-node-count": String(omitted),
    }, `${omitted} earlier timeline item${omitted === 1 ? "" : "s"} deferred`),
    ...nodes.slice(-TIMELINE_EAGER_NODE_LIMIT),
  ];
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
    ".desktop-subagent-shelf",
    ".desktop-agent-ui-form-card",
    ".desktop-agent-flow-step",
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
  const shouldFold = shouldFoldAssistantRun(run);
  if (!shouldFold) {
    const copyable = run.length === 1 && hasAssistantFinalAnswer(final.message);
    return run.map((item) => renderThreadMessage(item.message, item.index, selectedToolKey, copyable, onReferenceInspect));
  }
  const processSteps = run.length > 1
    ? assistantProcessSteps(run)
    : [assistantFinalReasoningStep(final)].filter((item): item is AssistantMessageRunItem => Boolean(item));
  const nodes: VNode[] = [];
  if (processSteps.length) {
    nodes.push(renderAssistantStepGroup(processSteps, selectedToolKey, onReferenceInspect));
  }
  nodes.push(renderThreadMessage(assistantFinalAnswerMessage(final.message), final.index, selectedToolKey, true, onReferenceInspect));
  return [h("div", {
    key: `assistant-run:${run[0]?.index ?? final.index}`,
    class: "desktop-assistant-run-group",
    "data-desktop-chat-region": "assistant-run",
  }, nodes)];
}

function collectSubagentShelfItems(messages: ConversationMessageIslandOptions[]): SubagentShelfItem[] {
  const items = new Map<string, SubagentShelfItem>();
  for (const message of messages) {
    for (const activity of message.toolActivities ?? []) {
      if (activityInspectorKind(activity) !== "delegate") {
        continue;
      }
      const key = toolActivitySelectionKey(activity);
      const payload = mergedActivityPayload(activity);
      const status = normalizeToolStatus(activity);
      items.set(key, {
        activity,
        key,
        latestActivity: activity.responseText || fieldString(payload, ["latest_activity", "latestActivity", "summary", "final_output", "finalOutput"]),
        statusLabel: getToolStatusLabel(status),
        task: fieldString(payload, ["task", "message", "prompt", "goal"]) || activity.argsText,
        title: fieldString(payload, ["task_name", "taskName", "label", "title"]) || activity.name || "subagent",
      });
    }
  }
  return [...items.values()].sort((left, right) => subagentShelfRank(left) - subagentShelfRank(right)).slice(0, 5);
}

function subagentShelfRank(item: SubagentShelfItem): number {
  const normalized = normalizeToolStatus(item.activity).status;
  if (normalized === "blocked") {
    return 0;
  }
  if (normalized === "running" || normalized === "pending") {
    return 1;
  }
  if (normalized === "failed") {
    return 2;
  }
  return 3;
}

function renderSubagentShelf(
  items: SubagentShelfItem[],
  selectedKey: string,
  onSelect: (item: SubagentShelfItem) => void,
): VNode | null {
  if (!items.length) {
    return null;
  }
  return h("section", {
    class: "desktop-subagent-shelf",
    "data-subagent-count": String(items.length),
    "data-subagent-shelf-layout": "stacked-status",
    "data-visible-limit": "5",
    "aria-label": "Subagents",
  }, [
    h("div", { class: "desktop-subagent-shelf-list" }, items.map((item) => h("button", {
      key: item.key,
      class: "desktop-subagent-shelf-item",
      "data-subagent-shelf-item": item.key,
      "data-subagent-shelf-row": "status",
      "aria-selected": String(selectedKey === item.key),
      onClick: () => onSelect(item),
      type: "button",
    }, [
      h("span", {
        class: "desktop-tool-activity-status-dot",
        "data-tool-status-tone": getToolStatusTone(normalizeToolStatus(item.activity)),
      }),
      h("span", { class: "desktop-subagent-shelf-title" }, item.title),
      h("span", { class: "desktop-subagent-shelf-status" }, item.statusLabel),
      item.latestActivity ? h("small", { class: "desktop-subagent-shelf-activity" }, item.latestActivity) : null,
    ]))),
  ]);
}

function shouldFoldAssistantRun(run: AssistantMessageRunItem[]): boolean {
  if (!run.length) {
    return false;
  }
  const final = run[run.length - 1];
  if (!hasAssistantFinalAnswer(final.message)) {
    return false;
  }
  return run.length > 1 || hasAssistantInlineProcess(final.message);
}

function hasAssistantInlineProcess(message: ConversationMessageIslandOptions): boolean {
  return Boolean(
    message.reasoningContent?.trim()
    || message.toolActivities?.length
  );
}

function assistantProcessSteps(run: AssistantMessageRunItem[]): AssistantMessageRunItem[] {
  const final = run[run.length - 1];
  const steps = run.slice(0, -1).filter((item) => hasAssistantStepContent(item.message));
  const finalReasoningStep = assistantFinalReasoningStep(final);
  return finalReasoningStep ? [...steps, finalReasoningStep] : steps;
}

function assistantFinalReasoningStep(item: AssistantMessageRunItem): AssistantMessageRunItem | null {
  if (!item.message.reasoningContent?.trim() && !item.message.toolActivities?.length) {
    return null;
  }
  return {
    ...item,
    message: {
      ...item.message,
      body: [],
      copyable: false,
      references: [],
      reasoningLabel: "Thinking complete",
      toolActivities: item.message.toolActivities ?? [],
    },
  };
}

function assistantFinalAnswerMessage(message: ConversationMessageIslandOptions): ConversationMessageIslandOptions {
  return {
    ...message,
    reasoningContent: "",
    reasoningLabel: undefined,
    toolActivities: [],
  };
}

function hasAssistantStepContent(message: ConversationMessageIslandOptions): boolean {
  return Boolean(
    message.body.some((line) => line.trim())
    || message.reasoningContent?.trim()
    || message.references.length
    || message.toolActivities?.length
    || message.attachment
  );
}

function renderAssistantStepGroup(
  items: AssistantMessageRunItem[],
  selectedToolKey: string,
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void,
) {
  const flowSummary = summarizeAssistantAgentFlow(items);
  return h("details", {
    key: `assistant-steps:${items[0]?.index ?? 0}`,
    class: "desktop-assistant-step-group desktop-agent-flow-group",
    "data-agent-flow-tool-count": String(flowSummary.toolCount),
    "data-agent-flow-delegated-count": String(flowSummary.delegatedCount),
    "data-desktop-chat-region": "assistant-intermediate-steps",
    onToggle: syncAgentFlowExpansionHeight,
  }, [
    h("summary", { class: "desktop-assistant-step-summary desktop-agent-flow-summary" }, [
      h("span", { class: "desktop-assistant-step-summary-label" }, "Processed"),
      h("span", { class: "desktop-assistant-step-summary-count" }, `${items.length} ${items.length === 1 ? "step" : "steps"}`),
      flowSummary.label
        ? h("span", { class: "desktop-agent-flow-summary-label" }, flowSummary.label)
        : null,
      h("span", { class: "desktop-assistant-step-summary-time" }, assistantStepTimeRange(items)),
    ]),
    h("div", { class: "desktop-assistant-step-list desktop-agent-flow-step-list" }, items.map((item, position) => renderAgentFlowStep(
      item,
      position,
      items.length,
      selectedToolKey,
      onReferenceInspect,
    ))),
  ]);
}

function syncAgentFlowExpansionHeight(event: Event): void {
  const group = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!group) {
    return;
  }
  const stepList = group.querySelector<HTMLElement>(".desktop-agent-flow-step-list");
  if (!stepList) {
    return;
  }
  group.style.setProperty("--desktop-agent-flow-content-height", `${Math.max(0, stepList.scrollHeight)}px`);
}

function summarizeAssistantAgentFlow(items: AssistantMessageRunItem[]): { delegatedCount: number; label: string; toolCount: number } {
  let delegatedCount = 0;
  let toolCount = 0;
  const toolNames = new Set<string>();
  for (const item of items) {
    for (const activity of item.message.toolActivities ?? []) {
      toolCount += 1;
      toolNames.add(resolveAgentToolProfile(activity).label);
      if (resolveAgentToolProfile(activity).kind !== "tool") {
        delegatedCount += 1;
      }
    }
  }
  const label = delegatedCount
    ? `${delegatedCount} delegated agent ${delegatedCount === 1 ? "call" : "calls"}`
    : toolCount
      ? `${toolCount} ${toolCount === 1 ? "tool call" : "tool calls"}`
      : "AI thought loop";
  return { delegatedCount, label: [...toolNames].length > 1 ? `${label} · ${[...toolNames].slice(0, 2).join(" + ")}` : label, toolCount };
}

function renderAgentFlowStep(
  item: AssistantMessageRunItem,
  position: number,
  total: number,
  selectedToolKey: string,
  onReferenceInspect?: (reference: ConversationReferenceIslandOptions) => void,
): VNode {
  const profile = agentFlowStepProfile(item.message);
  return h("section", {
    key: `agent-flow-step:${item.index}`,
    class: "desktop-agent-flow-step",
    "data-agent-flow-step-kind": profile.kind,
    "data-agent-flow-step-index": String(position + 1),
    style: { "--desktop-agent-flow-step-index": String(position) },
  }, [
    h("div", { class: "desktop-agent-flow-step-rail", "aria-hidden": "true" }, [
      h("span", { class: "desktop-agent-flow-step-node" }, String(position + 1)),
      position < total - 1 ? h("span", { class: "desktop-agent-flow-step-line" }) : null,
    ]),
    h("div", { class: "desktop-agent-flow-step-card" }, [
      h("header", { class: "desktop-agent-flow-step-header" }, [
        h("span", { class: "desktop-agent-flow-step-kind" }, profile.label),
        h("strong", { class: "desktop-agent-flow-step-title" }, profile.title),
        item.message.time ? h("small", { class: "desktop-agent-flow-step-time" }, item.message.time) : null,
      ]),
      renderThreadMessage(item.message, item.index, selectedToolKey, false, onReferenceInspect),
    ]),
  ]);
}

function agentFlowStepProfile(message: ConversationMessageIslandOptions): AgentFlowStepProfile {
  const activities = message.toolActivities ?? [];
  if (activities.length) {
    const profile = resolveAgentToolProfile(activities[0]);
    const names = activities.map((activity) => activity.name || "unknown").filter(Boolean).slice(0, 2).join(", ");
    return {
      kind: profile.kind === "tool" ? "tool" : profile.kind,
      label: profile.kind === "tool" ? (activities.length > 1 ? "Tools" : "Tool call") : profile.label,
      title: names || profile.headline,
    };
  }
  if (message.reasoningContent?.trim()) {
    return {
      kind: "thinking",
      label: "Think",
      title: message.reasoningLabel ?? "Reasoning",
    };
  }
  return {
    kind: "response",
    label: "Draft",
    title: message.body.find((line) => line.trim())?.slice(0, 80) || "Assistant step",
  };
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

function renderActivityInspectorPanel(options: {
  activity: ToolActivityIslandOptions;
  artifactLoads: Map<string, DelegateArtifactLoadState>;
  mode: "overlay" | "push";
  motionState: DetailPanelState;
  onClose: () => void;
  onResize: (nextWidth: number) => void;
  onSubagentArtifactLoad: (artifactId: string) => void;
  onSubagentTraceTabChange: (tab: SubagentObservabilityTab) => void;
  subagentTraceTab: SubagentObservabilityTab;
}) {
  const { activity } = options;
  const inspectorKind = activityInspectorKind(activity);
  const status = normalizeToolStatus(activity);
  const label = getToolStatusLabel(status);
  const tone = getToolStatusTone(status);
  const agentProfile = resolveAgentToolProfile(activity);
  const showApprovalActions = status.pendingApproval && Boolean(activity.approvalId);
  if (status.pendingApproval || activity.approvalId) {
    logDesktopNativeChatDebug("vue.toolDetail.render", {
      approvalId: activity.approvalId ?? "",
      approvalStatus: activity.approvalStatus ?? "",
      id: activity.id,
      inspectorKind,
      name: activity.name,
      pendingApproval: status.pendingApproval,
      sessionKey: activity.sessionKey ?? "",
      showApprovalActions,
      status: activity.status ?? "",
      toolKind: agentProfile.kind,
    });
  }
  return h("aside", {
    "aria-label": inspectorAriaLabel(inspectorKind),
    class: ["desktop-tool-detail-panel", `desktop-${inspectorKind}-detail-panel`].join(" "),
    "data-agent-call-kind": agentProfile.kind,
    "data-inspector-kind": inspectorKind,
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
        h("span", { class: "desktop-tool-detail-eyebrow" }, inspectorEyebrow(inspectorKind)),
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
    showApprovalActions
      ? h("section", { class: "desktop-tool-detail-approval-actions", "aria-label": "Tool approval actions" }, [
        renderDetailApprovalButton(activity, "approveOnce", "Approve once"),
        renderDetailApprovalButton(activity, "approveSession", "Allow session"),
        renderDetailApprovalButton(activity, "deny", "Deny"),
      ])
      : null,
    h("div", { class: "desktop-tool-detail-body" }, renderActivityInspectorBody(
      activity,
      options.artifactLoads,
      inspectorKind,
      options.onSubagentArtifactLoad,
      options.subagentTraceTab,
      options.onSubagentTraceTabChange,
    )),
  ]);
}

function renderActivityInspectorBody(
  activity: ToolActivityIslandOptions,
  artifactLoads: Map<string, DelegateArtifactLoadState>,
  inspectorKind: ActivityInspectorKind,
  onSubagentArtifactLoad: (artifactId: string) => void,
  subagentTraceTab: SubagentObservabilityTab,
  onSubagentTraceTabChange: (tab: SubagentObservabilityTab) => void,
): Array<VNode | null> {
  const agentProfile = resolveAgentToolProfile(activity);
  if (inspectorKind === "artifact") {
    return [
      renderToolDetailMeta(activity),
      renderToolDetailText("Preview", activity.responseText || activity.argsText, "Preview unavailable"),
      renderToolDetailText("Fetch", activity.runChainItemKey || activity.id, "Artifact fetch reference unavailable"),
      renderToolDetailText("Renderer", artifactRendererLabel(activity.name), "Renderer unavailable"),
    ];
  }
  if (inspectorKind === "delegate") {
    return [
      renderAgentToolWorkflowPanel(activity, agentProfile),
      renderSubagentTracePanel(activity, artifactLoads, subagentTraceTab, onSubagentTraceTabChange, onSubagentArtifactLoad),
      renderToolDetailMeta(activity),
      renderToolDetailText("Task", activity.argsText, "No delegated task available"),
      renderToolDetailText("Latest activity", activity.responseText, "No delegated activity available"),
      renderToolDetailText("Related link", activity.runChainItemKey || activity.id, "Related link unavailable"),
    ];
  }
  return [
    renderToolDetailMeta(activity),
    renderToolDetailText("Arguments", activity.argsText, "No arguments available"),
    renderToolDetailText("Response", activity.responseText, "No response available"),
    renderToolDetailText("stderr", "", "No stderr available"),
    renderToolDetailText("Duration", "", "Duration unavailable"),
  ];
}

const SUBAGENT_OBSERVABILITY_TABS: Array<{ id: SubagentObservabilityTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "transcript", label: "Transcript" },
  { id: "tools", label: "Tools" },
  { id: "approvals", label: "Approvals" },
  { id: "artifacts", label: "Artifacts" },
  { id: "raw", label: "Raw" },
];

function renderSubagentTracePanel(
  activity: ToolActivityIslandOptions,
  artifactLoads: Map<string, DelegateArtifactLoadState>,
  selectedTab: SubagentObservabilityTab,
  onTabChange: (tab: SubagentObservabilityTab) => void,
  onArtifactLoad: (artifactId: string) => void,
): VNode | null {
  const payload = mergedActivityPayload(activity);
  const trace = delegatedTraceRecord(activity, payload);
  const steps = subagentTraceSteps(trace);
  const artifactSteps = subagentArtifactTraceSteps(trace, steps);
  if (!steps.length && !artifactSteps.length) {
    return null;
  }
  const transcriptSteps = steps.filter(isTranscriptTraceStep);
  const toolSteps = steps.filter(isToolTraceStep);
  const approvalSteps = [
    ...steps.filter(isApprovalTraceStep),
    ...syntheticApprovalTraceSteps(activity, payload, steps),
  ];
  const tabContent = renderSubagentTraceTabPanel({
    activity,
    approvalSteps,
    artifactSteps,
    artifactLoads,
    onArtifactLoad,
    payload,
    selectedTab,
    steps,
    toolSteps,
    trace,
    transcriptSteps,
  });
  return h("section", { class: "desktop-subagent-trace-panel desktop-subagent-observability-panel" }, [
    h("h4", "Subagent timeline"),
    h("div", {
      "aria-label": "Subagent observability",
      class: "desktop-subagent-observability-tabs",
      role: "tablist",
    }, SUBAGENT_OBSERVABILITY_TABS.map((tab) => h("button", {
      "aria-selected": String(selectedTab === tab.id),
      class: "desktop-subagent-observability-tab",
      "data-subagent-observability-tab": tab.id,
      onClick: () => onTabChange(tab.id),
      role: "tab",
      type: "button",
    }, tab.label))),
    tabContent,
  ]);
}

function renderSubagentTraceTabPanel(options: {
  activity: ToolActivityIslandOptions;
  approvalSteps: SubagentTraceStep[];
  artifactSteps: SubagentTraceStep[];
  artifactLoads: Map<string, DelegateArtifactLoadState>;
  onArtifactLoad: (artifactId: string) => void;
  payload: Record<string, unknown>;
  selectedTab: SubagentObservabilityTab;
  steps: SubagentTraceStep[];
  toolSteps: SubagentTraceStep[];
  trace: Record<string, unknown> | null;
  transcriptSteps: SubagentTraceStep[];
}): VNode {
  const { activity, approvalSteps, artifactSteps, artifactLoads, onArtifactLoad, payload, selectedTab, steps, toolSteps, trace, transcriptSteps } = options;
  const content = {
    approvals: renderSubagentTraceSection("Approvals", "Approval checkpoints seen inside the child run.", "approvals", approvalSteps),
    artifacts: renderSubagentArtifactSection(activity, artifactSteps, artifactLoads, onArtifactLoad),
    overview: renderSubagentTraceOverview(activity, payload, trace, {
      approvals: approvalSteps.length,
      artifacts: artifactSteps.length,
      timeline: steps.length,
      tools: toolSteps.length,
      transcript: transcriptSteps.length,
    }),
    raw: renderSubagentTraceRaw(payload, trace),
    timeline: renderSubagentTraceSection("Timeline", "Ordered child-agent events.", "timeline", steps),
    tools: renderSubagentTraceSection("Tools", "Child tool calls and returned observations.", "tools", toolSteps),
    transcript: renderSubagentTraceSection("Transcript", "Reasoning summaries and assistant output.", "transcript", transcriptSteps),
  } satisfies Record<SubagentObservabilityTab, VNode>;
  return h("div", {
    class: "desktop-subagent-observability-tab-panel",
    "data-subagent-observability-tab-panel": selectedTab,
    role: "tabpanel",
  }, [content[selectedTab]]);
}

function renderSubagentTraceOverview(
  activity: ToolActivityIslandOptions,
  payload: Record<string, unknown>,
  trace: Record<string, unknown> | null,
  counts: Record<"approvals" | "artifacts" | "timeline" | "tools" | "transcript", number>,
): VNode {
  return h("section", {
    class: "desktop-subagent-trace-section desktop-subagent-trace-overview-section",
    "data-subagent-observability-section": "overview",
  }, [
    h("header", { class: "desktop-subagent-trace-section-header" }, [
      h("strong", "Overview"),
      h("span", "Child run identifiers, result, and recorded trace counts."),
    ]),
    h("dl", { class: "desktop-subagent-trace-overview-metrics" }, [
      ["Timeline", counts.timeline],
      ["Transcript", counts.transcript],
      ["Tools", counts.tools],
      ["Approvals", counts.approvals],
      ["Artifacts", counts.artifacts],
    ].flatMap(([label, value]) => [
      h("dt", String(label)),
      h("dd", String(value)),
    ])),
    renderSubagentTraceContext(activity, payload, trace),
  ]);
}

function renderSubagentTraceRaw(payload: Record<string, unknown>, trace: Record<string, unknown> | null): VNode {
  return h("section", {
    class: "desktop-subagent-trace-section desktop-subagent-trace-raw-section",
    "data-subagent-observability-section": "raw",
  }, [
    h("header", { class: "desktop-subagent-trace-section-header" }, [
      h("strong", "Raw"),
      h("span", "Normalized trace payload for debugging."),
    ]),
    h("pre", { class: "desktop-subagent-trace-raw" }, formatMaybeJson(JSON.stringify({
      payload,
      trace,
    }))),
  ]);
}

function delegatedTraceRecord(activity: ToolActivityIslandOptions, payload: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(activity.delegatedTrace)) {
    return activity.delegatedTrace;
  }
  for (const key of ["_delegate_trace", "delegateTrace", "trace"]) {
    const value = payload[key];
    if (isRecord(value)) {
      return value;
    }
    if (Array.isArray(value)) {
      return { steps: value };
    }
  }
  return null;
}

function delegateTraceLoadSelection(activity: ToolActivityIslandOptions): DelegateTraceLoadSelection | null {
  if (!activity.sessionKey?.trim()) {
    return null;
  }
  const payload = mergedActivityPayload(activity);
  const delegateId = activity.delegateId || fieldString(payload, ["delegate_id", "delegateId", "task_name", "taskName"]);
  const traceRef = activity.traceRef || fieldString(payload, ["trace_ref", "traceRef", "child_run_id", "childRunId"]);
  return {
    activityId: activity.id,
    delegateId: delegateId || undefined,
    sessionKey: activity.sessionKey,
    traceRef: traceRef || undefined,
  };
}

function delegateTraceLoadKey(activity: ToolActivityIslandOptions): string {
  const selection = delegateTraceLoadSelection(activity);
  if (!selection) {
    return toolActivitySelectionKey(activity);
  }
  return [
    selection.sessionKey,
    selection.delegateId || "",
    selection.traceRef || "",
    selection.activityId,
  ].join(":");
}

function delegateArtifactLoadSelection(activity: ToolActivityIslandOptions, artifactId: string): DelegateArtifactLoadSelection | null {
  const base = delegateTraceLoadSelection(activity);
  if (!base || !artifactId.trim()) {
    return null;
  }
  return {
    ...base,
    artifactId,
  };
}

function delegateArtifactLoadKey(activity: ToolActivityIslandOptions, artifactId: string): string {
  return `${delegateTraceLoadKey(activity)}:${artifactId}`;
}

function normalizeLoadedDelegateTrace(payload: unknown): Record<string, unknown> | null {
  const trace = isRecord(payload) && isRecord(payload.trace) ? payload.trace : payload;
  if (!isRecord(trace)) {
    return null;
  }
  const steps = Array.isArray(trace.steps)
    ? trace.steps
    : Array.isArray(trace.events)
      ? trace.events.map(delegateTraceEventToStep)
      : [];
  return { ...trace, steps };
}

function normalizeLoadedArtifact(payload: unknown): Record<string, unknown> | null {
  const artifact = isRecord(payload) && isRecord(payload.artifact) ? payload.artifact : payload;
  return isRecord(artifact) ? artifact : null;
}

function delegateTraceEventToStep(event: unknown, index: number): unknown {
  if (!isRecord(event)) {
    return event;
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  return {
    ...event,
    argsPreview: previewFromKeys(payload, ["arguments", "args", "input", "operation", "task"]),
    id: fieldString(event, ["event_id", "eventId", "id"]) || `event-${index + 1}`,
    kind: fieldString(event, ["event_type", "eventType", "kind", "type"]) || "event",
    resultPreview: previewFromKeys(payload, ["result", "output", "content", "text", "final_output", "finalOutput"]),
    status: fieldString(event, ["status", "state", "phase"]),
    summary: previewFromKeys(payload, ["summary", "content", "text", "message", "output", "result"]),
    title: fieldString(event, ["title", "name", "tool_name", "toolName", "label"])
      || fieldString(event, ["event_type", "eventType", "kind", "type"])
      || `Event ${index + 1}`,
  };
}

function subagentTraceSteps(trace: Record<string, unknown> | null): SubagentTraceStep[] {
  const rawSteps = Array.isArray(trace?.steps) ? trace?.steps : [];
  return rawSteps
    .map((step, index) => subagentTraceStepFromUnknown(step, index))
    .filter((step): step is SubagentTraceStep => Boolean(step));
}

function subagentTraceStepFromUnknown(value: unknown, index: number): SubagentTraceStep | null {
  if (typeof value === "string") {
    return {
      id: `trace-step-${index}`,
      kind: "message",
      raw: { summary: value },
      status: "",
      title: `Step ${index + 1}`,
    };
  }
  if (!isRecord(value)) {
    return null;
  }
  const kind = fieldString(value, ["kind", "type", "event"]) || "event";
  return {
    id: fieldString(value, ["id", "step_id", "stepId"]) || `trace-step-${index}`,
    kind,
    raw: value,
    status: fieldString(value, ["status", "state", "phase"]),
    title: fieldString(value, ["title", "name", "toolName", "tool_name", "label"]) || kind || `Step ${index + 1}`,
  };
}

function renderSubagentTraceSection(
  title: string,
  description: string,
  section: "timeline" | "transcript" | "tools" | "approvals" | "artifacts",
  steps: SubagentTraceStep[],
): VNode {
  return h("section", {
    class: "desktop-subagent-trace-section",
    "data-subagent-observability-section": section,
  }, [
    h("header", { class: "desktop-subagent-trace-section-header" }, [
      h("strong", title),
      h("span", description),
    ]),
    steps.length
      ? h("ol", { class: "desktop-subagent-trace-list" }, steps.map((step, index) => renderSubagentTraceStep(step, index)))
      : h("p", { class: "desktop-subagent-trace-empty" }, emptySubagentTraceSectionLabel(section)),
  ]);
}

function renderSubagentArtifactSection(
  activity: ToolActivityIslandOptions,
  steps: SubagentTraceStep[],
  artifactLoads: Map<string, DelegateArtifactLoadState>,
  onArtifactLoad: (artifactId: string) => void,
): VNode {
  return h("section", {
    class: "desktop-subagent-trace-section desktop-subagent-artifact-section",
    "data-subagent-observability-section": "artifacts",
  }, [
    h("header", { class: "desktop-subagent-trace-section-header" }, [
      h("strong", "Artifacts"),
      h("span", "Files and outputs produced by the child run."),
    ]),
    steps.length
      ? h("ol", { class: "desktop-subagent-trace-list" }, steps.map((step, index) => renderSubagentArtifactStep(
        activity,
        step,
        index,
        artifactLoads,
        onArtifactLoad,
      )))
      : h("p", { class: "desktop-subagent-trace-empty" }, emptySubagentTraceSectionLabel("artifacts")),
  ]);
}

function renderSubagentArtifactStep(
  activity: ToolActivityIslandOptions,
  step: SubagentTraceStep,
  index: number,
  artifactLoads: Map<string, DelegateArtifactLoadState>,
  onArtifactLoad: (artifactId: string) => void,
): VNode {
  const artifactId = subagentArtifactId(step) || step.id || `artifact-${index + 1}`;
  const loadState = artifactLoads.get(delegateArtifactLoadKey(activity, artifactId));
  return h("li", {
    class: "desktop-subagent-trace-step desktop-subagent-artifact-step",
    "data-subagent-trace-step-kind": step.kind,
    key: step.id || String(index),
  }, [
    h("div", { class: "desktop-subagent-artifact-heading" }, [
      h("div", { class: "desktop-subagent-trace-step-heading" }, [
        h("strong", step.title || artifactId || "Artifact"),
        step.kind ? h("span", { class: "desktop-subagent-trace-kind" }, step.kind) : null,
        step.status ? h("span", { class: "desktop-subagent-trace-status" }, step.status) : null,
      ]),
      h("button", {
        class: "desktop-subagent-artifact-load",
        "data-subagent-artifact-id": artifactId,
        disabled: loadState?.loading === true,
        onClick: () => onArtifactLoad(artifactId),
        type: "button",
      }, loadState?.artifact ? "Refresh" : loadState?.loading ? "Loading" : "Open"),
    ]),
    h("p", subagentTraceStepPreview(step)),
    renderSubagentTraceStepMeta(step),
    renderSubagentArtifactLoadState(loadState),
  ]);
}

function renderSubagentArtifactLoadState(loadState: DelegateArtifactLoadState | undefined): VNode | null {
  if (!loadState) {
    return null;
  }
  if (loadState.loading) {
    return h("p", { class: "desktop-subagent-artifact-loading" }, "Loading artifact...");
  }
  if (loadState.error) {
    return h("p", { class: "desktop-subagent-artifact-error" }, loadState.error);
  }
  if (!loadState.artifact) {
    return null;
  }
  return h("pre", { class: "desktop-subagent-artifact-preview" }, artifactPreview(loadState.artifact));
}

function artifactPreview(artifact: Record<string, unknown>): string {
  return previewFromKeys(artifact, ["content", "text", "body", "preview", "result", "output"])
    || formatMaybeJson(JSON.stringify(artifact));
}

function subagentArtifactId(step: SubagentTraceStep): string {
  return fieldString(step.raw, ["artifactId", "artifact_id", "id", "path", "uri", "file", "filename"]);
}

function renderSubagentTraceStep(step: SubagentTraceStep, index: number): VNode {
  return h("li", {
    class: "desktop-subagent-trace-step",
    "data-subagent-trace-step-kind": step.kind,
    key: step.id || String(index),
  }, [
    h("div", { class: "desktop-subagent-trace-step-heading" }, [
      h("strong", step.title || "Step"),
      step.kind ? h("span", { class: "desktop-subagent-trace-kind" }, step.kind) : null,
      step.status ? h("span", { class: "desktop-subagent-trace-status" }, step.status) : null,
    ]),
    h("p", subagentTraceStepPreview(step)),
    renderSubagentTraceStepMeta(step),
  ]);
}

function renderSubagentTraceStepMeta(step: SubagentTraceStep): VNode | null {
  const rows: Array<[string, string]> = [
    ["Args", previewFromKeys(step.raw, ["argsPreview", "args_preview", "arguments", "args", "input"])],
    ["Result", previewFromKeys(step.raw, ["resultPreview", "result_preview", "result", "output", "observation", "final_output", "finalOutput"])],
    ["Error", previewFromKeys(step.raw, ["error", "errorMessage", "error_message"])],
    ["Approval", previewFromKeys(step.raw, ["approvalId", "approval_id", "approvalStatus", "approval_status"])],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  if (!rows.length) {
    return null;
  }
  return h("dl", { class: "desktop-subagent-trace-step-meta" }, rows.flatMap(([label, value]) => [
    h("dt", label),
    h("dd", value),
  ]));
}

function renderSubagentTraceContext(
  activity: ToolActivityIslandOptions,
  payload: Record<string, unknown>,
  trace: Record<string, unknown> | null,
): VNode {
  const rows: Array<[string, string]> = [
    ["Delegate", activity.delegateTitle || activity.delegateId || fieldString(payload, ["delegate_id", "delegateId", "task_name", "taskName"])],
    ["Task", activity.delegateTask || fieldString(payload, ["task", "message", "prompt", "goal"])],
    ["Trace", activity.traceRef || fieldString(trace ?? {}, ["trace_ref", "traceRef", "child_run_id", "childRunId", "run_id", "runId"])],
    ["Final output", activity.finalOutput || fieldString(payload, ["final_output", "finalOutput"]) || activity.responseText],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
  return h("section", {
    class: "desktop-subagent-trace-section desktop-subagent-trace-context-section",
    "data-subagent-observability-section": "context",
  }, [
    h("header", { class: "desktop-subagent-trace-section-header" }, [
      h("strong", "Raw context"),
      h("span", "Stable identifiers and final values for debugging."),
    ]),
    rows.length
      ? h("dl", { class: "desktop-subagent-trace-context" }, rows.flatMap(([label, value]) => [
        h("dt", label),
        h("dd", summarizeWorkflowText(sanitizeTextPreview(value))),
      ]))
      : h("p", { class: "desktop-subagent-trace-empty" }, "No delegated context was returned."),
  ]);
}

function subagentTraceStepPreview(step: SubagentTraceStep): string {
  return [
    previewFromKeys(step.raw, ["summary", "message", "content", "text", "detail"]),
    previewFromKeys(step.raw, ["resultPreview", "result_preview", "result", "output", "observation", "final_output", "finalOutput"]),
    previewFromKeys(step.raw, ["error", "errorMessage", "error_message"]),
  ].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(" ");
}

function previewFromKeys(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = valuePreview(payload[key]);
    if (value) {
      return value;
    }
  }
  return "";
}

function valuePreview(value: unknown): string {
  if (typeof value === "string") {
    return summarizeWorkflowText(sanitizeTextPreview(value));
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value) || isRecord(value)) {
    try {
      return summarizeWorkflowText(sanitizeTextPreview(JSON.stringify(value)));
    } catch (error) {
      return "";
    }
  }
  return "";
}

function isTranscriptTraceStep(step: SubagentTraceStep): boolean {
  const kind = step.kind.toLowerCase();
  return ["reasoning", "message", "assistant_message", "assistant", "content", "final"].some((value) => kind.includes(value));
}

function isToolTraceStep(step: SubagentTraceStep): boolean {
  const kind = step.kind.toLowerCase();
  return kind.includes("tool") || Boolean(previewFromKeys(step.raw, ["toolName", "tool_name", "args", "arguments"]));
}

function isApprovalTraceStep(step: SubagentTraceStep): boolean {
  const kind = step.kind.toLowerCase();
  return kind.includes("approval")
    || Boolean(previewFromKeys(step.raw, ["approvalId", "approval_id", "approvalStatus", "approval_status"]))
    || step.status === "approval_required";
}

function isArtifactTraceStep(step: SubagentTraceStep): boolean {
  const kind = step.kind.toLowerCase();
  return kind.includes("artifact")
    || Boolean(previewFromKeys(step.raw, ["artifactId", "artifact_id", "path", "uri", "file", "filename"]));
}

function subagentArtifactTraceSteps(
  trace: Record<string, unknown> | null,
  steps: SubagentTraceStep[],
): SubagentTraceStep[] {
  const artifactSteps = steps.filter(isArtifactTraceStep);
  const artifacts = Array.isArray(trace?.artifacts) ? trace.artifacts.filter(isRecord) : [];
  if (!artifacts.length) {
    return artifactSteps;
  }
  const byId = new Map(artifactSteps.map((step) => [step.id, step]));
  for (const artifact of artifacts) {
    const id = fieldString(artifact, ["id", "artifactId", "artifact_id", "path", "uri", "file", "filename"]);
    if (!id) {
      continue;
    }
    const existing = byId.get(id);
    byId.set(id, artifactTraceStepFromRecord(artifact, existing));
  }
  return [...byId.values()];
}

function artifactTraceStepFromRecord(
  artifact: Record<string, unknown>,
  existing: SubagentTraceStep | undefined,
): SubagentTraceStep {
  const path = fieldString(artifact, ["path", "uri", "file", "filename"]);
  const summary = fieldString(artifact, ["summary", "title", "name", "description", "kind"]) || path;
  return {
    id: fieldString(artifact, ["id", "artifactId", "artifact_id"]) || existing?.id || path || "artifact",
    kind: fieldString(artifact, ["kind", "type"]) || existing?.kind || "artifact",
    raw: {
      ...(existing?.raw ?? {}),
      ...artifact,
      ...(path ? { resultPreview: path } : {}),
      ...(summary ? { summary } : {}),
    },
    status: fieldString(artifact, ["status", "state", "phase"]) || existing?.status || "",
    title: fieldString(artifact, ["title", "name"]) || existing?.title || path || summary || "Artifact",
  };
}

function syntheticApprovalTraceSteps(
  activity: ToolActivityIslandOptions,
  payload: Record<string, unknown>,
  existingSteps: SubagentTraceStep[],
): SubagentTraceStep[] {
  const approvalId = activity.approvalId || fieldString(payload, ["approvalId", "approval_id"]);
  if (!approvalId || existingSteps.some((step) => previewFromKeys(step.raw, ["approvalId", "approval_id"]) === approvalId)) {
    return [];
  }
  return [{
    id: approvalId,
    kind: "approval",
    raw: {
      approvalId,
      approvalStatus: activity.approvalStatus || fieldString(payload, ["approvalStatus", "approval_status"]),
      summary: activity.responseText || "Waiting for approval.",
    },
    status: activity.approvalStatus || activity.status || "approval_required",
    title: "Approval checkpoint",
  }];
}

function emptySubagentTraceSectionLabel(section: "timeline" | "transcript" | "tools" | "approvals" | "artifacts"): string {
  return {
    approvals: "No child approval checkpoint has been recorded.",
    artifacts: "No child artifacts have been recorded.",
    timeline: "No child timeline events have been recorded.",
    tools: "No child tool calls have been recorded.",
    transcript: "No child transcript messages have been recorded.",
  }[section];
}

function activityInspectorKind(activity: ToolActivityIslandOptions): ActivityInspectorKind {
  const normalized = `${activity.name} ${activity.id}`.toLowerCase();
  if (normalized.includes("artifact:") || normalized.includes("artifact")) {
    return "artifact";
  }
  if (resolveAgentToolProfile(activity).kind !== "tool") {
    return "delegate";
  }
  if (isPendingToolApproval(activity)) {
    return "approval";
  }
  return "tool_call";
}

function inspectorAriaLabel(kind: ActivityInspectorKind): string {
  return {
    approval: "Tool call details",
    artifact: "Artifact details",
    delegate: "Delegated agent details",
    tool_call: "Tool call details",
  }[kind];
}

function inspectorEyebrow(kind: ActivityInspectorKind): string {
  return {
    approval: "Approval",
    artifact: "Artifact",
    delegate: "Delegated work",
    tool_call: "Tool",
  }[kind];
}

function artifactRendererLabel(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("json")) {
    return "Structured JSON";
  }
  if (normalized.includes("diff")) {
    return "File diff";
  }
  if (normalized.includes("snapshot") || normalized.includes("browser")) {
    return "Browser snapshot";
  }
  if (normalized.includes("image")) {
    return "Image";
  }
  if (normalized.includes("markdown")) {
    return "Markdown";
  }
  if (normalized.includes("terminal") || normalized.includes("npm") || normalized.includes("shell")) {
    return "Terminal output";
  }
  return "Inert text";
}

function renderAgentToolWorkflowPanel(activity: ToolActivityIslandOptions, profile: AgentToolProfile): VNode {
  const payload = mergedActivityPayload(activity);
  const metrics = agentWorkflowMetricRows(activity, payload);
  const steps = extractAgentWorkflowSteps(payload, activity);
  return h("section", {
    class: "desktop-agent-tool-workflow-panel",
    "data-agent-call-kind": profile.kind,
  }, [
    h("header", { class: "desktop-agent-tool-workflow-header" }, [
      h("span", { class: "desktop-agent-tool-workflow-eyebrow" }, "Agent workflow"),
      h("strong", profile.headline),
      h("small", profile.contextLabel),
    ]),
    h("p", { class: "desktop-agent-tool-workflow-copy" }, agentWorkflowCopy(profile.kind)),
    metrics.length
      ? h("dl", { class: "desktop-agent-tool-workflow-metrics" }, metrics.flatMap(([label, value]) => [
        h("dt", label),
        h("dd", value),
      ]))
      : null,
    steps.length
      ? h("ol", { class: "desktop-agent-tool-workflow-timeline" }, steps.map((step, index) => h("li", {
        class: "desktop-agent-tool-workflow-step",
        "data-agent-workflow-step-status": step.status || "unknown",
      }, [
        h("span", { class: "desktop-agent-tool-workflow-step-index" }, String(index + 1)),
        h("div", { class: "desktop-agent-tool-workflow-step-main" }, [
          h("strong", step.title || `Step ${index + 1}`),
          step.agent ? h("small", step.agent) : null,
          step.detail ? h("p", step.detail) : null,
        ]),
        step.status ? h("span", { class: "desktop-agent-tool-workflow-step-status" }, step.status) : null,
      ])))
      : h("p", { class: "desktop-agent-tool-workflow-empty" }, "No nested workflow trace was returned yet. The raw arguments and response remain available below."),
  ]);
}

function agentWorkflowCopy(kind: AgentToolKind): string {
  if (kind === "cowork") {
    return "Cowork calls own an independent team context, so the nested workflow is summarized here while the main chat stays focused on the final answer.";
  }
  if (kind === "team") {
    return "Agent-team calls usually contain multiple independent worker contexts; inspect the team plan, agent roster, and latest events before opening the raw payload.";
  }
  if (kind === "subagent") {
    return "Subagent calls run with their own context. This panel promotes the delegated task, trace, and returned result above the raw tool payload.";
  }
  if (kind === "spawn") {
    return "Spawn calls start a separate agent loop. The spawned workflow is shown here as a nested timeline whenever the tool returns structured trace data.";
  }
  return "";
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
  const agentProfile = resolveAgentToolProfile(activity);
  const items = [
    ["approvalId", activity.approvalId || ""],
    ["approvalStatus", activity.approvalStatus || ""],
    ["sessionKey", activity.sessionKey || ""],
    ["kind", activity.kind],
    ["callType", agentProfile.kind === "tool" ? "" : agentProfile.label],
  ].filter(([, value]) => value);
  return h("dl", { class: "desktop-tool-detail-meta" }, items.flatMap(([label, value]) => [
    h("dt", label),
    h("dd", value),
  ]));
}

function renderToolDetailText(label: string, value: string, emptyLabel: string) {
  const formatted = formatMaybeJson(sanitizeTextPreview(value));
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
    logDesktopNativeChatDebug("vue.toolApproval.dispatch.skipped", {
      action,
      id: activity.id,
      name: activity.name,
      reason: "missing approvalId",
    });
    return;
  }
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) {
    logDesktopNativeChatDebug("vue.toolApproval.dispatch.skipped", {
      action,
      approvalId: activity.approvalId,
      id: activity.id,
      name: activity.name,
      reason: "missing event target",
    });
    return;
  }
  logDesktopNativeChatDebug("vue.toolApproval.dispatch", {
    action,
    approvalId: activity.approvalId,
    id: activity.id,
    name: activity.name || "unknown",
    runChainItemKey: activity.runChainItemKey ?? "",
    sessionKey: activity.sessionKey ?? "",
  });
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

function resolveAgentToolProfile(activity: ToolActivityIslandOptions): AgentToolProfile {
  const name = (activity.name || "").toLowerCase().replace(/[\s-]+/g, "_");
  const payload = mergedActivityPayload(activity);
  const declaredKind = fieldString(payload, ["agent_kind", "agentKind", "agent_type", "agentType", "call_type", "callType", "workflow_kind", "workflowKind"]).toLowerCase();
  const kindText = `${name} ${declaredKind}`;
  if (hasAny(kindText, ["cowork", "co_work"])) {
    return {
      contextLabel: "Independent Cowork context",
      headline: "Cowork agent workflow",
      kind: "cowork",
      label: "Cowork",
      tone: "cowork",
    };
  }
  if (hasAny(kindText, ["agent_team", "team_agent", "multi_agent", "multiagent", "swarm", "crew"]) || declaredKind === "team") {
    return {
      contextLabel: "Independent team context",
      headline: "Agent team workflow",
      kind: "team",
      label: "Agent team",
      tone: "team",
    };
  }
  if (hasAny(kindText, ["subagent", "sub_agent", "delegate", "handoff"])) {
    return {
      contextLabel: "Independent subagent context",
      headline: "Delegated subagent workflow",
      kind: "subagent",
      label: "Subagent",
      tone: "subagent",
    };
  }
  if (hasAny(kindText, ["spawn", "fork_agent", "launch_agent", "start_agent"])) {
    return {
      contextLabel: "Spawned independent context",
      headline: "Spawned agent workflow",
      kind: "spawn",
      label: "Spawn",
      tone: "spawn",
    };
  }
  return {
    contextLabel: "Main agent context",
    headline: "Tool call",
    kind: "tool",
    label: "Tool",
    tone: "tool",
  };
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function mergedActivityPayload(activity: ToolActivityIslandOptions): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const args = parseStructuredText(activity.argsText);
  const response = parseStructuredText(activity.responseText);
  mergePayloadValue(payload, args, "arguments");
  mergePayloadValue(payload, response, "response");
  return payload;
}

function mergePayloadValue(target: Record<string, unknown>, value: unknown, fallbackKey: string): void {
  if (isRecord(value)) {
    Object.assign(target, value);
    return;
  }
  if (Array.isArray(value)) {
    target[fallbackKey] = value;
  }
}

function parseStructuredText(value: string): unknown {
  const trimmed = stripMarkdownFence(value.trim());
  if (!trimmed) {
    return null;
  }
  if (!/^[{[]/.test(trimmed)) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return null;
  }
}

function stripMarkdownFence(value: string): string {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? value;
}

function agentWorkflowMetricRows(
  activity: ToolActivityIslandOptions,
  payload: Record<string, unknown>,
): Array<[string, string]> {
  const agents = extractAgentNames(payload);
  return [
    ["Task", fieldString(payload, ["task", "task_title", "taskTitle", "prompt", "instruction", "query", "goal"])],
    ["Session", fieldString(payload, ["session_id", "sessionId", "run_id", "runId", "cowork_id", "coworkId"]) || activity.sessionKey || ""],
    ["Workflow", fieldString(payload, ["workflow", "architecture", "blueprint", "mode", "strategy"])],
    ["Agents", agents.length ? agents.join(", ") : fieldString(payload, ["agent", "agent_name", "agentName", "role"])],
    ["Status", fieldString(payload, ["status", "state", "phase"]) || activity.status || activity.kind],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()));
}

function extractAgentWorkflowSteps(payload: Record<string, unknown>, activity: ToolActivityIslandOptions): AgentWorkflowStep[] {
  const rows = [
    ...arrayRowsForKeys(payload, ["steps", "events", "trace", "timeline", "workflow", "messages", "tasks", "arguments", "response"]),
    ...arrayRowsForKeys(payload, ["agent_steps", "agentSteps", "run_steps", "runSteps"]),
  ];
  const steps = rows
    .map((row, index) => workflowStepFromUnknown(row, index))
    .filter((step): step is AgentWorkflowStep => Boolean(step));
  if (steps.length) {
    return steps.slice(0, AGENT_WORKFLOW_STEP_LIMIT);
  }
  const agents = arrayRowsForKeys(payload, ["agents", "members", "workers", "subagents", "participants"])
    .map((row, index) => workflowStepFromAgent(row, index))
    .filter((step): step is AgentWorkflowStep => Boolean(step));
  if (agents.length) {
    return agents.slice(0, AGENT_WORKFLOW_STEP_LIMIT);
  }
  const preview = summarizeWorkflowText(activity.responseText || activity.argsText);
  return preview
    ? [{ agent: "", detail: preview, status: activity.status || activity.kind, title: "Latest event" }]
    : [];
}

function workflowStepFromUnknown(row: unknown, index: number): AgentWorkflowStep | null {
  if (typeof row === "string") {
    return {
      agent: "",
      detail: summarizeWorkflowText(row),
      status: "",
      title: `Step ${index + 1}`,
    };
  }
  if (!isRecord(row)) {
    return null;
  }
  const title = fieldString(row, ["title", "name", "action", "event", "type", "phase", "status"]) || `Step ${index + 1}`;
  const detail = fieldString(row, ["detail", "summary", "content", "message", "output", "result", "observation", "task", "prompt"]);
  const agent = fieldString(row, ["agent", "agent_name", "agentName", "role", "worker", "assignee"]);
  const status = fieldString(row, ["status", "state", "phase"]);
  return {
    agent,
    detail: summarizeWorkflowText(detail),
    status,
    title,
  };
}

function workflowStepFromAgent(row: unknown, index: number): AgentWorkflowStep | null {
  if (typeof row === "string") {
    return {
      agent: row,
      detail: "Agent context attached",
      status: "",
      title: row || `Agent ${index + 1}`,
    };
  }
  if (!isRecord(row)) {
    return null;
  }
  const name = fieldString(row, ["name", "label", "id", "agent", "role"]);
  return {
    agent: name,
    detail: fieldString(row, ["latestActivity", "latest_activity", "task", "description", "summary", "status"]),
    status: fieldString(row, ["status", "state", "phase"]),
    title: name || `Agent ${index + 1}`,
  };
}

function extractAgentNames(payload: Record<string, unknown>): string[] {
  const rows = arrayRowsForKeys(payload, ["agents", "members", "workers", "subagents", "participants"]);
  return rows.map((row) => {
    if (typeof row === "string") {
      return row;
    }
    if (!isRecord(row)) {
      return "";
    }
    return fieldString(row, ["name", "label", "id", "agent", "role"]);
  }).filter(Boolean).slice(0, 5);
}

function arrayRowsForKeys(payload: Record<string, unknown>, keys: string[]): unknown[] {
  const rows: unknown[] = [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      rows.push(...value);
    } else if (isRecord(value)) {
      rows.push(...Object.values(value));
    }
  }
  return rows;
}

function fieldString(payload: Record<string, unknown>, keys: string[]): string {
  const direct = directFieldString(payload, keys);
  if (direct) {
    return direct;
  }
  for (const nestedKey of ["input", "request", "payload", "config", "context", "result", "response", "metadata"]) {
    const nested = payload[nestedKey];
    if (isRecord(nested)) {
      const nestedValue = directFieldString(nested, keys);
      if (nestedValue) {
        return nestedValue;
      }
    }
  }
  return "";
}

function directFieldString(payload: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = payload[key];
    const stringValue = valueToDisplayString(value);
    if (stringValue) {
      return stringValue;
    }
  }
  return "";
}

function valueToDisplayString(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(valueToDisplayString).filter(Boolean).join(", ");
  }
  if (isRecord(value)) {
    return fieldString(value, ["title", "name", "id", "summary", "status"]);
  }
  return "";
}

function summarizeWorkflowText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function captureConversationTimelineScroll(host: HTMLElement): ConversationTimelineScrollState | null {
  const timeline = conversationTimelineScrollElement(host);
  if (!timeline) {
    return null;
  }
  const scrollTop = Number(timeline.scrollTop || 0);
  const bottomOffset = Math.max(0, Number(timeline.scrollHeight || 0) - scrollTop - Number(timeline.clientHeight || 0));
  return {
    bottomOffset,
    scrollTop,
    wasNearBottom: bottomOffset < 24,
  };
}

function queueConversationTimelineScrollRestore(
  host: HTMLElement,
  scrollState: ConversationTimelineScrollState | null,
): void {
  if (!scrollState) {
    return;
  }
  void nextTick(() => {
    restoreConversationTimelineScroll(host, scrollState);
    const win = host.ownerDocument.defaultView;
    if (typeof win?.requestAnimationFrame === "function") {
      win.requestAnimationFrame(() => restoreConversationTimelineScroll(host, scrollState));
      return;
    }
    const queue = win?.queueMicrotask ?? globalThis.queueMicrotask;
    if (typeof queue === "function") {
      queue(() => restoreConversationTimelineScroll(host, scrollState));
    }
  });
}

function restoreConversationTimelineScroll(
  host: HTMLElement,
  scrollState: ConversationTimelineScrollState,
): void {
  const timeline = conversationTimelineScrollElement(host);
  if (!timeline) {
    return;
  }
  if (scrollState.wasNearBottom) {
    timeline.scrollTop = boundedConversationTimelineScrollTop(
      timeline,
      Number(timeline.scrollHeight || 0) - Number(timeline.clientHeight || 0) - scrollState.bottomOffset,
    );
    return;
  }
  timeline.scrollTop = boundedConversationTimelineScrollTop(timeline, scrollState.scrollTop);
}

function conversationTimelineScrollElement(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(".desktop-conversation-timeline") ?? host;
}

function boundedConversationTimelineScrollTop(element: HTMLElement, value: number): number {
  const maxScrollTop = Math.max(0, Number(element.scrollHeight || 0) - Number(element.clientHeight || 0));
  return Math.min(Math.max(0, Number.isFinite(value) ? value : 0), maxScrollTop);
}

function isToolDetailOverlayMode(): boolean {
  return typeof window !== "undefined" ? window.innerWidth < 900 : false;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  const layout = target.closest(".desktop-conversation-body-layout") ?? target.closest(".desktop-conversation-layout");
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
  installConversationAgentFlowStyles(host.ownerDocument);
  host.setAttribute("data-desktop-vue-island", "conversation-thread");
  host.className = "desktop-conversation-thread";
  host.setAttribute("aria-label", "Message Timeline");
  host.setAttribute("aria-live", "polite");
  host.setAttribute("data-desktop-chat-region", "message-timeline");
  host.setAttribute("role", "log");
}

function installConversationAgentFlowStyles(targetDocument: Document): void {
  if (targetDocument.getElementById(CONVERSATION_AGENT_FLOW_STYLE_ID)) {
    return;
  }
  const style = targetDocument.createElement("style");
  style.id = CONVERSATION_AGENT_FLOW_STYLE_ID;
  style.textContent = `
    .desktop-conversation-body-layout {
      --desktop-flow-muted-border: color-mix(in srgb, var(--border, #e6dfd8) 76%, transparent);
      --desktop-flow-card-bg: color-mix(in srgb, var(--panel-strong, #faf9f5) 78%, var(--bg-subtle, #f5f0e8));
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      min-height: 0;
      position: relative;
      gap: 0;
    }

    .desktop-conversation-layout,
    body.desktop-native-workbench .desktop-conversation-layout {
      display: grid;
      grid-template-rows: minmax(0, auto) auto;
      height: auto;
      max-height: none;
      min-height: 0;
      min-width: 0;
      overflow: visible;
      transition: transform 320ms cubic-bezier(.2,.8,.2,1), filter 320ms ease;
    }

    .desktop-conversation-timeline,
    body.desktop-native-workbench .desktop-conversation-timeline {
      min-height: 0;
      overflow: auto;
      scroll-behavior: smooth;
    }

    .desktop-subagent-shelf {
      border-top: 1px solid var(--desktop-flow-muted-border);
      background: color-mix(in srgb, var(--panel, #fffaf3) 88%, transparent);
      padding: 8px 12px 10px;
    }

    .desktop-subagent-shelf-list {
      display: grid;
      gap: 6px;
      max-height: 178px;
      overflow-x: hidden;
      overflow-y: auto;
      padding: 0 2px 0 0;
    }

    .desktop-subagent-shelf-item {
      align-items: center;
      background: var(--panel-strong, #fffaf7);
      border: 1px solid var(--desktop-flow-muted-border);
      border-radius: 8px;
      color: var(--text, #1e1d1b);
      cursor: pointer;
      display: grid;
      gap: 8px;
      grid-template-columns: auto minmax(92px, .8fr) max-content minmax(0, 1.2fr);
      min-height: 38px;
      padding: 7px 9px;
      text-align: left;
      width: 100%;
    }

    .desktop-subagent-shelf-item[aria-selected="true"] {
      border-color: color-mix(in srgb, var(--accent, #cc785c) 55%, var(--desktop-flow-muted-border));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent, #cc785c) 30%, transparent);
    }

    .desktop-subagent-shelf-title,
    .desktop-subagent-shelf-activity {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .desktop-subagent-shelf-title {
      font-weight: 700;
    }

    .desktop-subagent-shelf-status {
      color: var(--text-muted, #716b63);
      font-size: 12px;
      font-weight: 700;
    }

    .desktop-subagent-shelf-activity {
      color: var(--text-muted, #716b63);
      font-size: 12px;
    }

    .desktop-subagent-trace-panel {
      border: 1px solid var(--desktop-flow-muted-border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--panel-strong, #fffaf7) 82%, var(--bg-subtle, #f5f0e8));
      padding: 12px;
    }

    .desktop-subagent-trace-panel h4 {
      font-size: 13px;
      margin: 0 0 10px;
      text-transform: uppercase;
      color: var(--text-muted, #716b63);
    }

    .desktop-subagent-observability-panel {
      display: grid;
      gap: 12px;
    }

    .desktop-subagent-observability-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .desktop-subagent-observability-tab {
      background: var(--panel-strong, #fffaf7);
      border: 1px solid var(--desktop-flow-muted-border);
      border-radius: 999px;
      color: var(--text-muted, #716b63);
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
      line-height: 1.2;
      padding: 5px 9px;
    }

    .desktop-subagent-observability-tab[aria-selected="true"] {
      background: color-mix(in srgb, var(--accent, #cc785c) 13%, var(--panel-strong, #fffaf7));
      border-color: color-mix(in srgb, var(--accent, #cc785c) 45%, var(--desktop-flow-muted-border));
      color: var(--text, #1e1d1b);
    }

    .desktop-subagent-observability-tab-panel {
      min-width: 0;
    }

    .desktop-subagent-trace-section {
      display: grid;
      gap: 8px;
      min-width: 0;
    }

    .desktop-subagent-trace-section + .desktop-subagent-trace-section {
      border-top: 1px solid color-mix(in srgb, var(--desktop-flow-muted-border) 72%, transparent);
      padding-top: 10px;
    }

    .desktop-subagent-trace-section-header {
      display: grid;
      gap: 2px;
    }

    .desktop-subagent-trace-section-header strong {
      font-size: 13px;
    }

    .desktop-subagent-trace-section-header span,
    .desktop-subagent-trace-empty {
      color: var(--text-muted, #716b63);
      font-size: 12px;
    }

    .desktop-subagent-trace-empty {
      margin: 0;
    }

    .desktop-subagent-trace-list {
      display: grid;
      gap: 8px;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .desktop-subagent-trace-step {
      border-left: 3px solid color-mix(in srgb, var(--accent, #cc785c) 65%, transparent);
      padding-left: 10px;
      min-width: 0;
    }

    .desktop-subagent-trace-step-heading {
      align-items: baseline;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }

    .desktop-subagent-trace-step strong {
      font-size: 14px;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .desktop-subagent-trace-kind,
    .desktop-subagent-trace-status {
      color: var(--text-muted, #716b63);
      font-size: 12px;
      text-transform: capitalize;
    }

    .desktop-subagent-trace-kind {
      border: 1px solid var(--desktop-flow-muted-border);
      border-radius: 999px;
      padding: 1px 6px;
    }

    .desktop-subagent-trace-step p {
      margin: 4px 0 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .desktop-subagent-trace-step-meta,
    .desktop-subagent-trace-context,
    .desktop-subagent-trace-overview-metrics {
      display: grid;
      gap: 4px 8px;
      grid-template-columns: max-content minmax(0, 1fr);
      margin: 8px 0 0;
    }

    .desktop-subagent-trace-step-meta dt,
    .desktop-subagent-trace-context dt,
    .desktop-subagent-trace-overview-metrics dt {
      color: var(--text-muted, #716b63);
      font-size: 12px;
      font-weight: 700;
    }

    .desktop-subagent-trace-step-meta dd,
    .desktop-subagent-trace-context dd,
    .desktop-subagent-trace-overview-metrics dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
    }

    .desktop-subagent-trace-raw {
      background: #1f1d1a;
      border-radius: 8px;
      color: #f8f2e8;
      font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
      font-size: 12px;
      margin: 0;
      max-height: 320px;
      overflow: auto;
      padding: 10px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .desktop-assistant-run-group,
    body.desktop-native-workbench .desktop-assistant-run-group {
      display: grid;
      gap: 12px;
      min-width: 0;
    }

    .desktop-assistant-step-group.desktop-agent-flow-group,
    body.desktop-native-workbench .desktop-assistant-step-group.desktop-agent-flow-group {
      align-self: start;
      display: block;
      box-sizing: border-box;
      height: auto;
      max-height: none;
      overflow: visible;
      border: 1px solid var(--desktop-flow-muted-border);
      border-radius: 14px;
      background: var(--desktop-flow-card-bg);
      box-shadow: 0 12px 32px rgba(20, 20, 19, 0.08);
      flex: 0 0 auto;
      min-height: 0;
      min-width: 0;
      animation: desktopAgentFlowEnter 240ms ease-out both;
    }

    .desktop-agent-flow-summary,
    body.desktop-native-workbench .desktop-agent-flow-summary.desktop-assistant-step-summary {
      align-items: center;
      cursor: pointer;
      display: grid;
      gap: 10px;
      grid-template-columns: auto minmax(0, auto) auto minmax(0, 1fr) auto;
      list-style: none;
      min-height: 42px;
      min-width: 0;
      padding: 10px 14px;
      user-select: none;
    }

    .desktop-agent-flow-summary::-webkit-details-marker {
      display: none;
    }

    .desktop-agent-flow-summary::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--accent, #cc785c);
      box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent, #cc785c) 12%, transparent);
      transition: transform 220ms ease, box-shadow 220ms ease;
    }

    .desktop-agent-flow-group[open] .desktop-agent-flow-summary::before {
      transform: scale(1.18);
      box-shadow: 0 0 0 9px color-mix(in srgb, var(--accent, #cc785c) 16%, transparent);
    }

    .desktop-agent-flow-summary-label {
      color: var(--text-muted, #6c6a64);
      font-size: 12px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .desktop-agent-flow-summary .desktop-assistant-step-summary-label,
    .desktop-agent-flow-summary .desktop-assistant-step-summary-count {
      min-width: 0;
      white-space: nowrap;
    }

    .desktop-agent-flow-summary .desktop-assistant-step-summary-time {
      color: var(--text-subtle, #8e8b82);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .desktop-agent-flow-step-list,
    body.desktop-native-workbench .desktop-agent-flow-step-list.desktop-assistant-step-list {
      display: flex;
      flex-direction: column;
      gap: 0;
      height: auto;
      margin: 0;
      max-height: 0;
      min-height: 0;
      opacity: 0;
      overflow: hidden;
      padding: 4px 12px 14px;
      padding-right: 8px;
      position: static;
      contain: none;
      transform: translateY(-8px);
      transition:
        max-height 300ms cubic-bezier(.2, .8, .2, 1),
        opacity 220ms ease,
        transform 300ms cubic-bezier(.2, .8, .2, 1);
      will-change: max-height, opacity, transform;
    }

    .desktop-agent-flow-group[open] .desktop-agent-flow-step-list,
    body.desktop-native-workbench .desktop-agent-flow-group[open] .desktop-agent-flow-step-list.desktop-assistant-step-list {
      max-height: var(--desktop-agent-flow-content-height, 1200px);
      opacity: 1;
      transform: translateY(0);
    }

    .desktop-agent-flow-step,
    body.desktop-native-workbench .desktop-agent-flow-step {
      display: grid;
      flex: 0 0 auto;
      grid-template-columns: 30px minmax(0, 1fr);
      height: auto;
      max-height: none;
      min-width: 0;
      opacity: 0;
      overflow: visible;
      transform: translateY(-8px);
    }

    .desktop-agent-flow-group[open] .desktop-agent-flow-step,
    body.desktop-native-workbench .desktop-agent-flow-group[open] .desktop-agent-flow-step {
      animation: desktopAgentFlowStepIn 260ms ease both;
      animation-delay: calc(var(--desktop-agent-flow-step-index, 0) * 55ms);
    }

    .desktop-agent-flow-step-rail {
      align-items: center;
      display: flex;
      flex-direction: column;
      padding-top: 12px;
    }

    .desktop-agent-flow-step-node {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent, #cc785c) 16%, var(--panel, #faf9f5));
      border: 1px solid color-mix(in srgb, var(--accent, #cc785c) 28%, transparent);
      color: var(--accent, #cc785c);
      font-size: 11px;
      font-weight: 800;
    }

    .desktop-agent-flow-step-line {
      width: 1px;
      flex: 1;
      min-height: 18px;
      margin-block: 4px 0;
      background: linear-gradient(var(--desktop-flow-muted-border), transparent);
    }

    .desktop-agent-flow-step-card,
    body.desktop-native-workbench .desktop-agent-flow-step-card {
      height: auto;
      max-height: none;
      min-width: 0;
      overflow: visible;
      padding: 8px 0 10px;
    }

    .desktop-agent-flow-step-header {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 6px;
      color: var(--text-muted, #6c6a64);
      font-size: 12px;
    }

    .desktop-agent-flow-step-kind {
      border: 1px solid color-mix(in srgb, var(--accent, #cc785c) 24%, var(--border, #e6dfd8));
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent, #cc785c) 10%, transparent);
      color: var(--accent, #cc785c);
      font-size: 10px;
      font-weight: 800;
      padding: 2px 7px;
      text-transform: uppercase;
    }

    .desktop-agent-flow-step-title {
      color: var(--text, #141413);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .desktop-agent-flow-step-time {
      margin-left: auto;
      color: var(--text-subtle, #8e8b82);
      white-space: nowrap;
    }

    .desktop-agent-flow-step-card .desktop-conversation-message,
    .desktop-agent-flow-step-card .desktop-message-reasoning-body,
    .desktop-agent-flow-step-card .desktop-tool-activity {
      max-width: 100%;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .desktop-detail-panel-slot {
      min-width: 320px;
      max-width: 100%;
      pointer-events: none;
      z-index: 9;
    }

    .desktop-detail-panel-slot > .desktop-tool-detail-panel {
      pointer-events: auto;
    }

    .desktop-tool-detail-panel[data-tool-detail-motion="opening"],
    .desktop-tool-detail-panel[data-tool-detail-motion="open"] {
      animation: desktopToolDetailSlideIn 360ms cubic-bezier(.2,.8,.2,1) both;
    }

    .desktop-tool-detail-panel[data-tool-detail-motion="closing"] {
      animation: desktopToolDetailSlideOut 560ms cubic-bezier(.2,.8,.2,1) both;
    }

    .desktop-agent-tool-workflow-panel {
      display: grid;
      gap: 12px;
      border: 1px solid color-mix(in srgb, var(--accent, #cc785c) 22%, var(--border, #e6dfd8));
      border-radius: 14px;
      padding: 14px;
      background: color-mix(in srgb, var(--accent, #cc785c) 8%, var(--panel, #faf9f5));
    }

    .desktop-agent-tool-workflow-header {
      display: grid;
      gap: 2px;
    }

    .desktop-agent-tool-workflow-eyebrow {
      color: var(--accent, #cc785c);
      font-size: 11px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .desktop-agent-tool-workflow-header strong {
      color: var(--text, #141413);
      font-size: 15px;
    }

    .desktop-agent-tool-workflow-header small,
    .desktop-agent-tool-workflow-copy,
    .desktop-agent-tool-workflow-empty {
      color: var(--text-muted, #6c6a64);
      font-size: 12px;
      line-height: 1.5;
      margin: 0;
    }

    .desktop-agent-tool-workflow-metrics {
      display: grid;
      grid-template-columns: max-content minmax(0, 1fr);
      gap: 6px 12px;
      margin: 0;
      font-size: 12px;
    }

    .desktop-agent-tool-workflow-metrics dt {
      color: var(--text-subtle, #8e8b82);
      font-weight: 700;
    }

    .desktop-agent-tool-workflow-metrics dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .desktop-agent-tool-workflow-timeline {
      display: grid;
      gap: 8px;
      list-style: none;
      margin: 0;
      padding: 0;
    }

    .desktop-agent-tool-workflow-step {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) auto;
      gap: 9px;
      align-items: start;
      padding: 9px;
      border: 1px solid color-mix(in srgb, var(--border, #e6dfd8) 70%, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--panel-strong, #faf9f5) 76%, transparent);
    }

    .desktop-agent-tool-workflow-step-index {
      display: grid;
      place-items: center;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--accent, #cc785c) 13%, transparent);
      color: var(--accent, #cc785c);
      font-size: 11px;
      font-weight: 800;
    }

    .desktop-agent-tool-workflow-step-main {
      min-width: 0;
    }

    .desktop-agent-tool-workflow-step-main strong,
    .desktop-agent-tool-workflow-step-main small,
    .desktop-agent-tool-workflow-step-main p {
      display: block;
      margin: 0;
      overflow-wrap: anywhere;
    }

    .desktop-agent-tool-workflow-step-main small,
    .desktop-agent-tool-workflow-step-main p,
    .desktop-agent-tool-workflow-step-status {
      color: var(--text-muted, #6c6a64);
      font-size: 11px;
      line-height: 1.45;
    }

    .desktop-agent-tool-workflow-step-status {
      border-radius: 999px;
      background: color-mix(in srgb, var(--text-muted, #6c6a64) 10%, transparent);
      padding: 2px 7px;
      white-space: nowrap;
    }

    .desktop-conversation-body-layout[data-detail-panel-mode="push"][data-detail-panel-state="opening"],
    .desktop-conversation-body-layout[data-detail-panel-mode="push"][data-detail-panel-state="open"],
    .desktop-conversation-body-layout[data-detail-panel-mode="push"][data-detail-panel-state="closing"] {
      grid-template-columns: minmax(0, calc(100% - var(--desktop-tool-detail-width, 50%))) minmax(320px, var(--desktop-tool-detail-width, 50%));
    }

    .desktop-conversation-body-layout[data-detail-panel-mode="overlay"] .desktop-detail-panel-slot {
      position: absolute;
      inset: 0 0 0 auto;
      width: min(520px, 92vw);
    }

    @keyframes desktopAgentFlowEnter {
      from { opacity: 0; transform: translateY(8px) scale(.995); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes desktopAgentFlowStepIn {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes desktopToolDetailSlideIn {
      from { opacity: 0; transform: translateX(18px) scale(.99); filter: blur(2px); }
      to { opacity: 1; transform: translateX(0) scale(1); filter: blur(0); }
    }

    @keyframes desktopToolDetailSlideOut {
      from { opacity: 1; transform: translateX(0) scale(1); filter: blur(0); }
      to { opacity: 0; transform: translateX(24px) scale(.99); filter: blur(2px); }
    }

    @media (prefers-reduced-motion: reduce) {
      .desktop-conversation-layout,
      .desktop-agent-flow-summary::before,
      .desktop-agent-flow-step-list,
      .desktop-agent-flow-step,
      .desktop-tool-detail-panel[data-tool-detail-motion] {
        animation: none !important;
        scroll-behavior: auto !important;
        transition: none !important;
      }

      .desktop-agent-flow-group[open] .desktop-agent-flow-step-list,
      .desktop-agent-flow-group[open] .desktop-agent-flow-step {
        max-height: none !important;
        opacity: 1 !important;
        transform: none !important;
      }
    }
  `;
  targetDocument.head.append(style);
}
