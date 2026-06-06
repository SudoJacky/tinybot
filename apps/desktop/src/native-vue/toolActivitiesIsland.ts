import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref, type App } from "vue";
import { NConfigProvider, NSpace } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { mountToolActivityIsland, renderToolActivityNode, type ToolActivityIslandOptions } from "./toolActivityIsland";

export interface ToolActivitiesIslandOptions {
  activities: ToolActivityIslandOptions[];
}

export interface MountedToolActivitiesIsland {
  unmount: () => void;
}

export function mountToolActivitiesIsland(
  host: HTMLElement,
  options: ToolActivitiesIslandOptions,
): MountedToolActivitiesIsland {
  host.setAttribute("data-desktop-vue-island", "tool-activities");
  host.className = "desktop-tool-activities";
  const app = createToolActivitiesApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createToolActivitiesApp(options: ToolActivitiesIslandOptions): App {
  return createApp(defineComponent({
    name: "ToolActivitiesIsland",
    setup() {
      const activityHosts = ref<Array<HTMLElement | null>>([]);
      const mountedChildren: Array<{ unmount: () => void }> = [];

      onMounted(() => {
        options.activities.forEach((activity, index) => {
          mountChild(mountedChildren, activityHosts.value[index] ?? null, (host) => mountToolActivityIsland(host, activity));
        });
      });

      onBeforeUnmount(() => {
        while (mountedChildren.length) {
          mountedChildren.pop()?.unmount();
        }
      });

      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NSpace, {
          class: "desktop-tool-activities-list",
          size: 8,
          vertical: true,
        }, {
          default: () => options.activities.map((activity, index) => h("details", {
            ref: (element) => {
              activityHosts.value[index] = element as HTMLElement | null;
            },
            class: "desktop-tool-activity",
            "data-desktop-tool-activity-id": activity.id || undefined,
            "data-desktop-tool-activity-kind": activity.kind,
          })),
        }),
      });
    },
  }));
}

export function renderToolActivitiesNode(options: ToolActivitiesIslandOptions) {
  return h("div", { class: "desktop-tool-activities" }, renderToolActivitiesChildren(options));
}

export function renderToolActivitiesChildren(options: ToolActivitiesIslandOptions) {
  return options.activities.map((activity) => renderToolActivityNode(activity));
}

function mountChild<T extends { unmount: () => void }>(
  mountedChildren: Array<{ unmount: () => void }>,
  host: HTMLElement | null,
  mount: (host: HTMLElement) => T,
): void {
  if (!host) {
    return;
  }
  mountedChildren.push(mount(host));
}
