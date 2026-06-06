import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NTag } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface TaskStateBadgeIslandOptions {
  state: string;
}

export interface MountedTaskStateBadgeIsland {
  unmount: () => void;
}

export function mountTaskStateBadgeIsland(
  host: HTMLElement,
  options: TaskStateBadgeIslandOptions,
): MountedTaskStateBadgeIsland {
  host.setAttribute("data-desktop-vue-island", "task-state-badge");
  host.className = "desktop-task-state-badge";
  host.setAttribute("data-desktop-task-state-badge", options.state);
  const app = createTaskStateBadgeApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createTaskStateBadgeApp(options: TaskStateBadgeIslandOptions): App {
  return createApp(defineComponent({
    name: "TaskStateBadgeIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => renderTaskStateBadgeContent(options),
      });
    },
  }));
}

export function renderTaskStateBadgeSurface(options: TaskStateBadgeIslandOptions) {
  return h(NTag, {
    class: "desktop-task-state-badge",
    "data-desktop-vue-island": "task-state-badge",
    "data-desktop-task-state-badge": options.state,
    round: true,
    size: "small",
    type: taskStateType(options.state),
  }, { default: () => options.state });
}

function renderTaskStateBadgeContent(options: TaskStateBadgeIslandOptions) {
  return h(NTag, {
    round: true,
    size: "small",
    type: taskStateType(options.state),
  }, { default: () => options.state });
}

function taskStateType(state: string): "default" | "error" | "info" | "success" | "warning" {
  if (state === "failed") {
    return "error";
  }
  if (state === "blocked") {
    return "warning";
  }
  if (state === "completed") {
    return "success";
  }
  if (state === "active") {
    return "info";
  }
  if (state === "running") {
    return "warning";
  }
  return "default";
}
