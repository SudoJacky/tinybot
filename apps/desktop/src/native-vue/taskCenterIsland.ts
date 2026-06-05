import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import type {
  DesktopTaskActionId,
  DesktopTaskCenterItem,
} from "../desktopTaskCenter";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderTaskActionSurface } from "./taskActionIsland";
import { renderTaskStateBadgeSurface } from "./taskStateBadgeIsland";

export interface TaskCenterIslandActionEvent {
  action: DesktopTaskActionId;
  item: DesktopTaskCenterItem;
}

export interface TaskCenterIslandOptions {
  items: DesktopTaskCenterItem[];
  onAction?: (event: TaskCenterIslandActionEvent) => void;
}

export interface MountedTaskCenterIsland {
  unmount: () => void;
}

export function mountTaskCenterIsland(
  host: HTMLElement,
  options: TaskCenterIslandOptions,
): MountedTaskCenterIsland {
  host.setAttribute("data-desktop-vue-island", "task-center");
  host.id = "desktop-task-center";
  host.className = "desktop-task-center";
  host.setAttribute("aria-label", "Background task center");
  const app = createTaskCenterApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createTaskCenterApp(options: TaskCenterIslandOptions): App {
  return createApp(defineComponent({
    name: "TaskCenterIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderTaskCenterContent(options),
      });
    },
  }));
}

export function renderTaskCenterSurface(options: TaskCenterIslandOptions) {
  return h("section", {
    id: "desktop-task-center",
    class: "desktop-task-center",
    "aria-label": "Background task center",
  }, renderTaskCenterContent(options));
}

export function renderTaskCenterContent(options: TaskCenterIslandOptions) {
  return [
    h("h2", "Task Center"),
    h("p", { class: "desktop-task-center-summary" }, taskCenterSummary(options.items)),
    h("div", {
      class: "desktop-task-center-list",
      role: "list",
      "aria-live": "polite",
    }, options.items.length
      ? options.items.map((item) => renderTaskItem(item, options))
      : [h("p", { class: "desktop-task-center-empty" }, "No background tasks.")]),
  ];
}

function renderTaskItem(item: DesktopTaskCenterItem, options: TaskCenterIslandOptions) {
  return h("article", {
    class: "desktop-task-center-item",
    role: "listitem",
    "data-desktop-task-id": item.id,
    "data-desktop-task-source": item.source,
    "data-desktop-task-state": item.state,
    "data-desktop-task-tone": item.tone,
  }, [
    h("div", { class: "desktop-task-center-item-heading" }, [
      h("h2", item.title),
      renderTaskStateBadgeSurface({ state: item.state }),
    ]),
    h("p", { class: "desktop-task-center-detail" }, [
      formatTaskSource(item.source),
      item.detail,
      item.progressLabel,
    ].filter(Boolean).join(" - ")),
    item.diagnostics ? h("p", { class: "desktop-task-center-diagnostics" }, item.diagnostics) : null,
    h(NSpace, {
      class: "desktop-task-center-actions",
      role: "group",
      "aria-label": `${item.title} actions`,
      size: 8,
    }, {
      default: () => item.actions.map((action) => renderTaskAction(item, action.id, action.label, options)),
    }),
  ]);
}

function renderTaskAction(
  item: DesktopTaskCenterItem,
  action: DesktopTaskActionId,
  label: string,
  options: TaskCenterIslandOptions,
) {
  return renderTaskActionSurface({
    action,
    href: action === "open" ? item.destination.href ?? `/${item.destination.module}` : undefined,
    itemId: item.id,
    itemSource: item.source,
    label,
    onAction: (nextAction) => options.onAction?.({ action: nextAction as DesktopTaskActionId, item }),
  });
}

function taskCenterSummary(items: DesktopTaskCenterItem[]): string {
  if (!items.length) {
    return "0 tasks";
  }
  const active = items.filter((item) => item.state === "active").length;
  const blocked = items.filter((item) => item.state === "blocked").length;
  const failed = items.filter((item) => item.state === "failed").length;
  return `${items.length} tasks - ${active} active - ${blocked} blocked - ${failed} failed`;
}

function formatTaskSource(source: DesktopTaskCenterItem["source"]): string {
  if (source === "cowork") {
    return "Cowork";
  }
  return source[0].toUpperCase() + source.slice(1);
}
