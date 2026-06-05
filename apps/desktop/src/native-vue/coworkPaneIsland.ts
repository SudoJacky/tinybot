import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NEmpty, NSpace, NTag } from "naive-ui";
import {
  buildDesktopCoworkCockpitView,
  type DesktopCoworkCockpitView,
  type DesktopCoworkGraphView,
  type DesktopCoworkObservabilityPanel,
  type DesktopCoworkSelectionType,
  type DesktopCoworkSessionRow,
} from "../desktopCowork";
import type { DesktopCoworkActionEvent, DesktopCoworkPaneModel } from "../desktopWorkbenchShell";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface CoworkPaneGraphSelection {
  type: DesktopCoworkSelectionType;
  id: string;
  label: string;
}

export interface CoworkPaneIslandOptions {
  pane: DesktopCoworkPaneModel;
  onCoworkAction?: (event: DesktopCoworkActionEvent) => void;
  onGraphSelect?: (selection: CoworkPaneGraphSelection) => void;
  onObservabilityPanelSelected?: (panel: DesktopCoworkObservabilityPanel) => void;
  onSessionSelect?: (session: DesktopCoworkSessionRow) => void;
}

export interface MountedCoworkPaneIsland {
  unmount: () => void;
}

export type CoworkPaneActionEvent = Omit<DesktopCoworkActionEvent, "pane">;

const COWORK_GRAPH_NODE_LIMIT = 24;
const COWORK_GRAPH_EDGE_LIMIT = 12;
const COWORK_OBSERVABILITY_ROW_LIMIT = 24;
const COWORK_TASK_FEED_LIMIT = 20;

export function mountCoworkPaneIsland(
  host: HTMLElement,
  options: CoworkPaneIslandOptions,
): MountedCoworkPaneIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-pane");
  host.className = "desktop-workbench-section desktop-cowork-cockpit";
  host.setAttribute("data-desktop-module-surface", "cowork");
  host.setAttribute("aria-label", "Cowork cockpit");

  const app = createCoworkPaneApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkPaneApp(options: CoworkPaneIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkPaneIsland",
    setup() {
      const selectedView = ref(options.pane.cockpitView ?? null);
      const selectedPanelId = ref(options.pane.cockpitView?.observabilityPanels[0]?.id ?? "");
      const observabilityFilter = ref("");
      const actionRefs = {
        goal: ref<HTMLTextAreaElement | null>(null),
        message: ref<HTMLTextAreaElement | null>(null),
        blueprint: ref<HTMLTextAreaElement | null>(null),
        taskTitle: ref<HTMLInputElement | null>(null),
        assignedAgentId: ref<HTMLInputElement | null>(null),
        inspectorAssignee: ref<HTMLInputElement | null>(null),
      };

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Cowork"),
          renderSessions(options),
          renderActions(options, selectedView.value, actionRefs),
          selectedView.value
            ? [
              renderHeader(selectedView.value.header),
              renderGraph(options, selectedView, selectedView.value.graph),
              renderObservability(options, selectedView.value, selectedPanelId, observabilityFilter),
              renderInspector(options, selectedView.value, actionRefs.inspectorAssignee),
              renderTaskFeed(selectedView.value),
            ]
            : h("p", "Select a Cowork session to open the cockpit."),
        ],
      });
    },
  }));
}

function renderSessions(options: CoworkPaneIslandOptions) {
  return h("section", { class: "desktop-cowork-sessions" }, [
    h("h2", "Sessions"),
    options.pane.sessionRows.length
      ? h(NSpace, { vertical: true, size: 6 }, {
        default: () => options.pane.sessionRows.map((session) => h(NButton, {
          class: "desktop-cowork-session-row",
          "data-desktop-cowork-session": session.id,
          "data-desktop-entity-module": "cowork",
          "data-desktop-entity-id": session.id,
          block: true,
          secondary: true,
          onClick: () => options.onSessionSelect?.(session),
        }, {
          default: () => [
            h("span", `${session.title}: ${session.meta}`),
            h(NTag, {
              size: "small",
              round: true,
              type: sessionAttentionType(session.attention.tone),
            }, { default: () => session.attention.label }),
          ],
        })),
      })
      : h(NEmpty, { class: "desktop-cowork-sessions-empty", description: "No Cowork sessions loaded.", size: "small" }),
  ]);
}

function renderActions(
  options: CoworkPaneIslandOptions,
  view: DesktopCoworkCockpitView | null,
  refs: {
    goal: { value: HTMLTextAreaElement | null };
    message: { value: HTMLTextAreaElement | null };
    blueprint: { value: HTMLTextAreaElement | null };
    taskTitle: { value: HTMLInputElement | null };
    assignedAgentId: { value: HTMLInputElement | null };
  },
) {
  const sessionId = view?.header.id ?? "";
  const agents = view?.agents ?? [];
  return h("section", {
    class: "desktop-cowork-actions",
    "aria-label": "Cowork actions",
  }, [
    h("textarea", {
      ref: refs.goal,
      class: "desktop-cowork-action-input",
      "aria-label": "Cowork goal",
      "data-desktop-cowork-input": "goal",
    }),
    h("textarea", {
      ref: refs.message,
      class: "desktop-cowork-action-input",
      "aria-label": "Cowork message",
      "data-desktop-cowork-input": "message",
    }),
    h("textarea", {
      ref: refs.blueprint,
      class: "desktop-cowork-action-input desktop-cowork-blueprint-input",
      "aria-label": "Cowork blueprint JSON",
      "data-desktop-cowork-input": "blueprint",
    }),
    h("input", {
      ref: refs.taskTitle,
      class: "desktop-cowork-action-input",
      "aria-label": "Cowork task title",
      "data-desktop-cowork-input": "taskTitle",
    }),
    h("input", {
      ref: refs.assignedAgentId,
      class: "desktop-cowork-action-input",
      "aria-label": "Cowork assigned agent id",
      "data-desktop-cowork-input": "assignedAgentId",
      value: agents[0]?.id ?? "",
    }),
    options.pane.actionStatus ? h("p", { class: "desktop-cowork-action-status" }, options.pane.actionStatus) : null,
    options.pane.summaryText ? h("p", { class: "desktop-cowork-action-summary" }, `Summary: ${options.pane.summaryText}`) : null,
    options.pane.blueprintDiagnostics ? h("p", { class: "desktop-cowork-blueprint-diagnostics" }, `Blueprint: ${options.pane.blueprintDiagnostics}`) : null,
    h(NSpace, { size: 8, wrap: true }, {
      default: () => [
        renderActionButton("blueprintValidate", "Validate blueprint", true, () => emitAction(options, {
          action: "validateBlueprint",
          blueprintText: refs.blueprint.value?.value.trim() ?? "",
          preview: false,
        })),
        renderActionButton("blueprintPreview", "Preview blueprint", true, () => emitAction(options, {
          action: "validateBlueprint",
          blueprintText: refs.blueprint.value?.value.trim() ?? "",
          preview: true,
        })),
        renderActionButton("create", "Create session", true, () => emitAction(options, {
          action: "createSession",
          goal: refs.goal.value?.value.trim() ?? "",
        })),
        renderActionButton("run", "Run", Boolean(sessionId), () => emitAction(options, { action: "runSession", sessionId })),
        renderActionButton("pause", "Pause", Boolean(sessionId), () => emitAction(options, { action: "pauseSession", sessionId })),
        renderActionButton("resume", "Resume", Boolean(sessionId), () => emitAction(options, { action: "resumeSession", sessionId })),
        renderActionButton("emergencyStop", "Emergency stop", Boolean(sessionId), () => emitAction(options, { action: "emergencyStopSession", sessionId })),
        renderActionButton("delete", "Delete", Boolean(sessionId), () => emitAction(options, { action: "deleteSession", sessionId })),
        renderActionButton("message", "Message", Boolean(sessionId), () => emitAction(options, {
          action: "sendMessage",
          sessionId,
          message: refs.message.value?.value.trim() ?? "",
        })),
        renderActionButton("summary", "Summary", Boolean(sessionId), () => emitAction(options, { action: "loadSummary", sessionId })),
        renderActionButton("addTask", "Add task", Boolean(sessionId), () => emitAction(options, {
          action: "addTask",
          sessionId,
          taskTitle: refs.taskTitle.value?.value.trim() ?? "",
          assignedAgentId: refs.assignedAgentId.value?.value.trim() ?? "",
        })),
      ],
    }),
  ]);
}

function renderHeader(header: DesktopCoworkCockpitView["header"]) {
  return h("section", { class: "desktop-cowork-header" }, [
    h(NCard, { size: "small", bordered: false }, {
      default: () => [
        h("h2", header.title),
        h("p", header.goal || "No goal provided."),
        h("p", `${header.status} / ${header.workflow}${header.updatedAt ? ` / ${header.updatedAt}` : ""}`),
        h(NSpace, { size: 6 }, {
          default: () => [
            h(NTag, { size: "small", round: true }, { default: () => header.status }),
            h(NTag, { size: "small", round: true }, { default: () => header.workflow }),
          ],
        }),
      ],
    }),
  ]);
}

function renderGraph(
  options: CoworkPaneIslandOptions,
  selectedView: { value: DesktopCoworkCockpitView | null },
  graph: DesktopCoworkGraphView,
) {
  return h("section", { class: "desktop-cowork-graph" }, [
    h("h2", "Graph"),
    h("p", graph.caption),
    h(NSpace, { vertical: true, size: 6 }, {
      default: () => graph.nodes.slice(0, COWORK_GRAPH_NODE_LIMIT).map((node) => {
        const type = coworkSelectionTypeForKind(node.kind);
        return h(NButton, {
          class: "desktop-cowork-graph-node",
          "data-desktop-cowork-entity": node.id,
          "data-desktop-cowork-kind": node.kind,
          block: true,
          secondary: selectedView.value?.inspector.id !== node.id,
          type: selectedView.value?.inspector.id === node.id ? "primary" : "default",
          "aria-selected": selectedView.value?.inspector.id === node.id ? "true" : "false",
          onClick: () => {
            if (!type || !selectedView.value) {
              return;
            }
            selectedView.value = buildDesktopCoworkCockpitView(selectedView.value.raw, {
              selected: { type, id: node.id },
            });
            options.onGraphSelect?.({ type, id: node.id, label: node.label });
          },
        }, {
          default: () => [
            h("span", `${node.label}: ${node.kind}${node.status ? ` / ${node.status}` : ""}`),
            node.status ? h(NTag, { size: "small", round: true }, { default: () => node.status }) : null,
          ],
        });
      }),
    }),
    h("p", { class: "desktop-cowork-limit-status" }, limitStatus(Math.min(graph.nodes.length, COWORK_GRAPH_NODE_LIMIT), graph.nodes.length, "node", "nodes")),
    graph.edges.length ? h(NCard, {
      class: "desktop-cowork-graph-edges",
      bordered: false,
      embedded: true,
      contentStyle: "padding: 0;",
    }, {
      default: () => graph.edges.slice(0, COWORK_GRAPH_EDGE_LIMIT).map((edge) => h("p", `${edge.source} -> ${edge.target}${edge.label ? ` / ${edge.label}` : ""}`)),
    }) : null,
    h("p", { class: "desktop-cowork-limit-status" }, limitStatus(Math.min(graph.edges.length, COWORK_GRAPH_EDGE_LIMIT), graph.edges.length, "edge", "edges")),
  ]);
}

function renderObservability(
  options: CoworkPaneIslandOptions,
  view: DesktopCoworkCockpitView,
  selectedPanelId: { value: string },
  filterText: { value: string },
) {
  const panels = view.observabilityPanels;
  const selectedPanel = panels.find((panel) => panel.id === selectedPanelId.value) ?? panels[0];
  const query = filterText.value.trim().toLowerCase();
  const matchedRows = selectedPanel
    ? query
      ? selectedPanel.rows.filter((row) => `${row.label} ${row.value}`.toLowerCase().includes(query))
      : selectedPanel.rows
    : [];
  const visibleRows = matchedRows.slice(0, COWORK_OBSERVABILITY_ROW_LIMIT);
  return h("section", {
    class: "desktop-cowork-observability",
    "aria-label": "Cowork observability",
  }, [
    h("h2", "Observability"),
    h(NSpace, { class: "desktop-cowork-observability-tabs", role: "tablist", size: 6 }, {
      default: () => panels.map((panel) => h(NButton, {
        class: "desktop-cowork-observability-tab",
        role: "tab",
        "data-desktop-cowork-panel": panel.id,
        "aria-selected": panel.id === selectedPanel?.id ? "true" : "false",
        size: "tiny",
        type: panel.id === selectedPanel?.id ? "primary" : "default",
        secondary: panel.id !== selectedPanel?.id,
        onClick: () => {
          selectedPanelId.value = panel.id;
          options.onObservabilityPanelSelected?.(panel);
        },
      }, { default: () => panel.label })),
    }),
    h("input", {
      class: "desktop-cowork-observability-filter",
      type: "search",
      "aria-label": "Filter Cowork observability rows",
      placeholder: "Filter current panel",
      "data-desktop-cowork-filter": "observability",
      value: filterText.value,
      onInput: (event: Event) => {
        filterText.value = String((event.target as HTMLInputElement | null)?.value ?? "");
      },
    }),
    h(NCard, {
      class: "desktop-cowork-observability-panel",
      bordered: false,
      embedded: true,
      contentStyle: "padding: 0;",
    }, {
      default: () => selectedPanel
        ? [
          h("h2", selectedPanel.label),
          h("p", selectedPanel.summary),
          h("p", { class: "desktop-cowork-limit-status" }, filteredLimitStatus(visibleRows.length, matchedRows.length, selectedPanel.rows.length, Boolean(query))),
          ...visibleRows.map((row) => h("p", { class: "desktop-cowork-observability-row" }, `${row.label}: ${row.value}`)),
        ]
        : h("p", "No Cowork observability data."),
    }),
  ]);
}

function renderInspector(
  options: CoworkPaneIslandOptions,
  view: DesktopCoworkCockpitView,
  inspectorAssignee: { value: HTMLInputElement | null },
) {
  return h("section", { class: "desktop-cowork-inspector" }, [
    h(NCard, { bordered: false, embedded: true, contentStyle: "padding: 0;" }, {
      default: () => [
        h("h2", `Selected: ${view.inspector.title}`),
        h("p", view.inspector.body || `${view.inspector.type || "entity"} ${view.inspector.id || ""}`.trim()),
        ...view.inspector.rows.map((row) => h("p", `${row.label}: ${row.value}`)),
        view.inspector.payloadText ? h("p", `Payload: ${view.inspector.payloadText}`) : null,
        renderInspectorActions(options, view, inspectorAssignee),
      ],
    }),
  ]);
}

function renderInspectorActions(
  options: CoworkPaneIslandOptions,
  view: DesktopCoworkCockpitView,
  inspectorAssignee: { value: HTMLInputElement | null },
) {
  const sessionId = view.header.id;
  const type = view.inspector.type;
  const id = view.inspector.id;
  if (!sessionId || !type || !id) {
    return null;
  }

  if (type === "task") {
    return h(NSpace, { class: "desktop-cowork-selected-actions", size: 8 }, {
      default: () => [
        h("input", {
          ref: inspectorAssignee,
          class: "desktop-cowork-action-input",
          "aria-label": "Assign task to agent",
          "data-desktop-cowork-input": "assignedAgentId",
          value: view.agents[0]?.id ?? "",
        }),
        renderEntityActionButton("assignTask", "Assign", () => emitAction(options, {
          action: "task",
          sessionId,
          taskId: id,
          taskAction: "assign",
          assignedAgentId: inspectorAssignee.value?.value.trim() ?? view.agents[0]?.id ?? "",
        })),
        renderEntityActionButton("retryTask", "Retry", () => emitAction(options, {
          action: "task",
          sessionId,
          taskId: id,
          taskAction: "retry",
        })),
        renderEntityActionButton("reviewTask", "Review", () => emitAction(options, {
          action: "task",
          sessionId,
          taskId: id,
          taskAction: "review",
        })),
      ],
    });
  }

  if (type === "workUnit") {
    return h(NSpace, { class: "desktop-cowork-selected-actions", size: 8 }, {
      default: () => [
        renderEntityActionButton("retryWorkUnit", "Retry", () => emitAction(options, { action: "workUnit", sessionId, workUnitId: id, workUnitAction: "retry" })),
        renderEntityActionButton("skipWorkUnit", "Skip", () => emitAction(options, { action: "workUnit", sessionId, workUnitId: id, workUnitAction: "skip" })),
        renderEntityActionButton("cancelWorkUnit", "Cancel", () => emitAction(options, { action: "workUnit", sessionId, workUnitId: id, workUnitAction: "cancel" })),
      ],
    });
  }

  if (type === "branch") {
    const branch = view.branches.find((item) => item.branchId === id || item.resultId === id);
    return h(NSpace, { class: "desktop-cowork-selected-actions", size: 8 }, {
      default: () => [
        renderEntityActionButton("selectBranch", "Select branch", () => emitAction(options, {
          action: "selectBranch",
          sessionId,
          branchId: branch?.branchId || id,
        })),
        renderEntityActionButton("selectBranchResult", "Set final", () => emitAction(options, {
          action: "selectBranchResult",
          sessionId,
          branchId: branch?.branchId || id,
          resultId: branch?.resultId,
        })),
        renderEntityActionButton("mergeBranchResults", "Merge results", () => emitAction(options, {
          action: "mergeBranchResults",
          sessionId,
          branchIds: view.branches.map((item) => item.branchId).filter(Boolean),
        })),
      ],
    });
  }

  return null;
}

function renderTaskFeed(view: DesktopCoworkCockpitView) {
  return h("section", { class: "desktop-cowork-task-feed" }, [
    h("h2", "Task feed"),
    view.taskCenterItems.length
      ? h(NSpace, { vertical: true, size: 6 }, {
        default: () => view.taskCenterItems.slice(0, COWORK_TASK_FEED_LIMIT).map((item) => h(NCard, {
          class: "desktop-cowork-task-feed-row",
          "data-desktop-cowork-task-id": item.id,
          "data-desktop-cowork-task-tone": item.tone,
          bordered: false,
          embedded: true,
          contentStyle: "padding: 0;",
        }, {
          default: () => h(NSpace, { size: 6, align: "center" }, {
            default: () => [
              h("span", `${item.title}: ${item.status} / ${item.detail}`),
              h(NTag, { size: "small", round: true, type: taskToneType(item.tone) }, { default: () => item.status }),
            ],
          }),
        })),
      })
      : h(NEmpty, { class: "desktop-cowork-task-feed-empty", description: "No task status items.", size: "small" }),
    h("p", { class: "desktop-cowork-limit-status" }, limitStatus(Math.min(view.taskCenterItems.length, COWORK_TASK_FEED_LIMIT), view.taskCenterItems.length, "task status item", "task status items")),
    h("p", `${view.agents.length} agents / ${view.tasks.length} tasks / ${view.mailbox.length} mailbox / ${view.artifacts.length} artifacts`),
  ]);
}

function renderActionButton(action: string, label: string, enabled: boolean, onClick: () => void) {
  return h(NButton, {
    class: "desktop-cowork-action",
    "data-desktop-cowork-action": action,
    disabled: !enabled,
    size: "small",
    secondary: true,
    onClick: () => {
      if (enabled) {
        onClick();
      }
    },
  }, { default: () => label });
}

function renderEntityActionButton(action: string, label: string, onClick: () => void) {
  return h(NButton, {
    class: "desktop-cowork-action",
    "data-desktop-cowork-entity-action": action,
    size: "small",
    secondary: true,
    onClick,
  }, { default: () => label });
}

function emitAction(options: CoworkPaneIslandOptions, event: CoworkPaneActionEvent): void {
  options.onCoworkAction?.({ ...event, pane: options.pane } as DesktopCoworkActionEvent);
}

function sessionAttentionType(tone: DesktopCoworkSessionRow["attention"]["tone"]): "default" | "error" | "success" {
  if (tone === "attention") {
    return "error";
  }
  if (tone === "complete") {
    return "success";
  }
  return "default";
}

function taskToneType(tone: DesktopCoworkCockpitView["taskCenterItems"][number]["tone"]): "default" | "error" | "success" {
  if (tone === "attention") {
    return "error";
  }
  if (tone === "complete") {
    return "success";
  }
  return "default";
}

function coworkSelectionTypeForKind(kind: string): DesktopCoworkSelectionType {
  const value = kind.toLowerCase();
  if (value.includes("agent")) {
    return "agent";
  }
  if (value.includes("task")) {
    return "task";
  }
  if (value.includes("mail")) {
    return "mailbox";
  }
  if (value.includes("thread")) {
    return "thread";
  }
  if (value.includes("trace")) {
    return "trace";
  }
  if (value.includes("artifact")) {
    return "artifact";
  }
  if (value.includes("work") || value.includes("unit")) {
    return "workUnit";
  }
  if (value.includes("branch")) {
    return "branch";
  }
  return "";
}

function limitStatus(visible: number, total: number, singular: string, plural: string): string {
  const noun = total === 1 ? singular : plural;
  return `Showing ${visible} of ${total} ${noun}`;
}

function filteredLimitStatus(visible: number, matched: number, total: number, filtered: boolean): string {
  if (!filtered) {
    return limitStatus(visible, total, "row", "rows");
  }
  return `Showing ${visible} of ${matched} matching rows (${total} total)`;
}
