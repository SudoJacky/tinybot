import { createApp, defineComponent, h, ref, type App } from "vue";
import { NButton, NConfigProvider, NSpace } from "naive-ui";
import type { DesktopCoworkAgentRow } from "../desktopCowork";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export type CoworkActionsIslandEvent =
  | { action: "validateBlueprint"; blueprintText: string; preview: boolean }
  | { action: "createSession"; goal: string }
  | { action: "runSession" | "pauseSession" | "resumeSession" | "emergencyStopSession" | "deleteSession" | "loadSummary"; sessionId: string }
  | { action: "sendMessage"; sessionId: string; message: string }
  | { action: "addTask"; sessionId: string; taskTitle: string; assignedAgentId: string };

export interface CoworkActionsIslandOptions {
  sessionId: string;
  agents: DesktopCoworkAgentRow[];
  actionStatus?: string;
  summaryText?: string;
  blueprintDiagnostics?: string;
  onAction?: (event: CoworkActionsIslandEvent) => void;
}

export interface MountedCoworkActionsIsland {
  unmount: () => void;
}

export function mountCoworkActionsIsland(
  host: HTMLElement,
  options: CoworkActionsIslandOptions,
): MountedCoworkActionsIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-actions");
  host.className = "desktop-cowork-actions";
  host.setAttribute("aria-label", "Cowork actions");
  const app = createCoworkActionsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkActionsApp(options: CoworkActionsIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkActionsIsland",
    setup() {
      const goal = ref<HTMLTextAreaElement | null>(null);
      const message = ref<HTMLTextAreaElement | null>(null);
      const blueprint = ref<HTMLTextAreaElement | null>(null);
      const taskTitle = ref<HTMLInputElement | null>(null);
      const assignedAgentId = ref<HTMLInputElement | null>(null);
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("textarea", {
            ref: goal,
            class: "desktop-cowork-action-input",
            "aria-label": "Cowork goal",
            "data-desktop-cowork-input": "goal",
          }),
          h("textarea", {
            ref: message,
            class: "desktop-cowork-action-input",
            "aria-label": "Cowork message",
            "data-desktop-cowork-input": "message",
          }),
          h("textarea", {
            ref: blueprint,
            class: "desktop-cowork-action-input desktop-cowork-blueprint-input",
            "aria-label": "Cowork blueprint JSON",
            "data-desktop-cowork-input": "blueprint",
          }),
          h("input", {
            ref: taskTitle,
            class: "desktop-cowork-action-input",
            "aria-label": "Cowork task title",
            "data-desktop-cowork-input": "taskTitle",
          }),
          h("input", {
            ref: assignedAgentId,
            class: "desktop-cowork-action-input",
            "aria-label": "Cowork assigned agent id",
            "data-desktop-cowork-input": "assignedAgentId",
            value: options.agents[0]?.id ?? "",
          }),
          options.actionStatus ? h("p", { class: "desktop-cowork-action-status" }, options.actionStatus) : null,
          options.summaryText ? h("p", { class: "desktop-cowork-action-summary" }, `Summary: ${options.summaryText}`) : null,
          options.blueprintDiagnostics ? h("p", { class: "desktop-cowork-blueprint-diagnostics" }, `Blueprint: ${options.blueprintDiagnostics}`) : null,
          renderButtons(options, {
            goal,
            message,
            blueprint,
            taskTitle,
            assignedAgentId,
          }),
        ],
      });
    },
  }));
}

function renderButtons(
  options: CoworkActionsIslandOptions,
  refs: {
    goal: { value: HTMLTextAreaElement | null };
    message: { value: HTMLTextAreaElement | null };
    blueprint: { value: HTMLTextAreaElement | null };
    taskTitle: { value: HTMLInputElement | null };
    assignedAgentId: { value: HTMLInputElement | null };
  },
) {
  const sessionId = options.sessionId;
  const sessionActionRows = [
    ["create", "Create session", "createSession", true],
    ["run", "Run", "runSession", Boolean(sessionId)],
    ["pause", "Pause", "pauseSession", Boolean(sessionId)],
    ["resume", "Resume", "resumeSession", Boolean(sessionId)],
    ["emergencyStop", "Emergency stop", "emergencyStopSession", Boolean(sessionId)],
    ["delete", "Delete", "deleteSession", Boolean(sessionId)],
    ["message", "Message", "sendMessage", Boolean(sessionId)],
    ["summary", "Summary", "loadSummary", Boolean(sessionId)],
  ] as const;

  return h(NSpace, { size: 8, wrap: true }, {
    default: () => [
      renderActionButton("blueprintValidate", "Validate blueprint", true, () => options.onAction?.({
        action: "validateBlueprint",
        blueprintText: refs.blueprint.value?.value.trim() ?? "",
        preview: false,
      })),
      renderActionButton("blueprintPreview", "Preview blueprint", true, () => options.onAction?.({
        action: "validateBlueprint",
        blueprintText: refs.blueprint.value?.value.trim() ?? "",
        preview: true,
      })),
      ...sessionActionRows.map(([action, label, eventAction, enabled]) => renderActionButton(action, label, enabled, () => {
        if (eventAction === "createSession") {
          options.onAction?.({ action: eventAction, goal: refs.goal.value?.value.trim() ?? "" });
        } else if (eventAction === "sendMessage") {
          options.onAction?.({ action: eventAction, sessionId, message: refs.message.value?.value.trim() ?? "" });
        } else {
          options.onAction?.({ action: eventAction, sessionId });
        }
      })),
      renderActionButton("addTask", "Add task", Boolean(sessionId), () => options.onAction?.({
        action: "addTask",
        sessionId,
        taskTitle: refs.taskTitle.value?.value.trim() ?? "",
        assignedAgentId: refs.assignedAgentId.value?.value.trim() ?? "",
      })),
    ],
  });
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
