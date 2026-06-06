import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NCard, NConfigProvider, NSpace } from "naive-ui";
import type { DesktopCoworkCockpitView } from "../desktopCowork";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type CoworkInspectorActionEvent =
  | { action: "task"; sessionId: string; taskId: string; taskAction: "assign" | "retry" | "review"; assignedAgentId?: string }
  | { action: "workUnit"; sessionId: string; workUnitId: string; workUnitAction: "retry" | "skip" | "cancel" }
  | { action: "selectBranch"; sessionId: string; branchId: string }
  | { action: "selectBranchResult"; sessionId: string; branchId: string; resultId?: string }
  | { action: "mergeBranchResults"; sessionId: string; branchIds: string[] };

export interface CoworkInspectorIslandOptions {
  view: DesktopCoworkCockpitView;
  onAction?: (event: CoworkInspectorActionEvent) => void;
}

export interface MountedCoworkInspectorIsland {
  unmount: () => void;
}

export function mountCoworkInspectorIsland(
  host: HTMLElement,
  options: CoworkInspectorIslandOptions,
): MountedCoworkInspectorIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-inspector");
  host.className = "desktop-cowork-inspector";
  const app = createCoworkInspectorApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkInspectorApp(options: CoworkInspectorIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkInspectorIsland",
    setup() {
      const assignedAgentId = ref(options.view.agents[0]?.id ?? "");
      const assignedAgentInput = ref<HTMLInputElement | null>(null);
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NCard, {
          bordered: false,
          embedded: true,
          contentStyle: "padding: 0;",
        }, {
          default: () => [
            h("h2", `Selected: ${options.view.inspector.title}`),
            h("p", options.view.inspector.body || `${options.view.inspector.type || "entity"} ${options.view.inspector.id || ""}`.trim()),
            ...options.view.inspector.rows.map((row) => h("p", `${row.label}: ${row.value}`)),
            options.view.inspector.payloadText ? h("p", `Payload: ${options.view.inspector.payloadText}`) : null,
            renderSelectedActions(options.view, assignedAgentId, assignedAgentInput, options),
          ],
        }),
      });
    },
  }));
}

function renderSelectedActions(
  view: DesktopCoworkCockpitView,
  assignedAgentId: { value: string },
  assignedAgentInput: { value: HTMLInputElement | null },
  options: CoworkInspectorIslandOptions,
) {
  const sessionId = view.header.id;
  const type = view.inspector.type;
  const id = view.inspector.id;
  if (!sessionId || !type || !id) {
    return null;
  }

  const controls = selectedActionControls(view, assignedAgentId, assignedAgentInput, options);
  if (!controls.length) {
    return null;
  }
  return h(NSpace, {
    class: "desktop-cowork-selected-actions",
    size: 8,
  }, {
    default: () => controls,
  });
}

function selectedActionControls(
  view: DesktopCoworkCockpitView,
  assignedAgentId: { value: string },
  assignedAgentInput: { value: HTMLInputElement | null },
  options: CoworkInspectorIslandOptions,
) {
  const sessionId = view.header.id;
  const type = view.inspector.type;
  const id = view.inspector.id;

  if (type === "task") {
    return [
      h("input", {
        ref: (element) => {
          assignedAgentInput.value = element as HTMLInputElement | null;
        },
        class: "desktop-cowork-action-input",
        "aria-label": "Assign task to agent",
        "data-desktop-cowork-input": "assignedAgentId",
        value: assignedAgentId.value,
        onInput: (event: Event) => {
          assignedAgentId.value = String((event.target as HTMLInputElement | null)?.value ?? "");
        },
      }),
      renderActionButton("assignTask", "Assign", () => options.onAction?.({
        action: "task",
        sessionId,
        taskId: id,
        taskAction: "assign",
        assignedAgentId: (assignedAgentInput.value?.value ?? assignedAgentId.value).trim(),
      })),
      renderActionButton("retryTask", "Retry", () => options.onAction?.({
        action: "task",
        sessionId,
        taskId: id,
        taskAction: "retry",
      })),
      renderActionButton("reviewTask", "Review", () => options.onAction?.({
        action: "task",
        sessionId,
        taskId: id,
        taskAction: "review",
      })),
    ];
  }

  if (type === "workUnit") {
    return [
      renderActionButton("retryWorkUnit", "Retry", () => options.onAction?.({ action: "workUnit", sessionId, workUnitId: id, workUnitAction: "retry" })),
      renderActionButton("skipWorkUnit", "Skip", () => options.onAction?.({ action: "workUnit", sessionId, workUnitId: id, workUnitAction: "skip" })),
      renderActionButton("cancelWorkUnit", "Cancel", () => options.onAction?.({ action: "workUnit", sessionId, workUnitId: id, workUnitAction: "cancel" })),
    ];
  }

  if (type === "branch") {
    const branch = view.branches.find((item) => item.branchId === id || item.resultId === id);
    return [
      renderActionButton("selectBranch", "Select branch", () => options.onAction?.({
        action: "selectBranch",
        sessionId,
        branchId: branch?.branchId || id,
      })),
      renderActionButton("selectBranchResult", "Set final", () => options.onAction?.({
        action: "selectBranchResult",
        sessionId,
        branchId: branch?.branchId || id,
        resultId: branch?.resultId,
      })),
      renderActionButton("mergeBranchResults", "Merge results", () => options.onAction?.({
        action: "mergeBranchResults",
        sessionId,
        branchIds: view.branches.map((item) => item.branchId).filter(Boolean),
      })),
    ];
  }

  return [];
}

function renderActionButton(action: string, label: string, onClick: () => void) {
  return h(NButton, {
    class: "desktop-cowork-action",
    "data-desktop-cowork-entity-action": action,
    size: "small",
    secondary: true,
    onClick,
  }, { default: () => label });
}
