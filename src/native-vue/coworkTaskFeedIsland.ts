import { createApp, defineComponent, h, type App } from "vue";
import { NCard, NConfigProvider, NEmpty, NSpace, NTag } from "naive-ui";
import type { DesktopCoworkTaskCenterItem } from "../desktopCowork";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

const COWORK_TASK_FEED_LIMIT = 20;

export interface CoworkTaskFeedTotals {
  agents: number;
  tasks: number;
  mailbox: number;
  artifacts: number;
}

export interface CoworkTaskFeedIslandOptions {
  items: DesktopCoworkTaskCenterItem[];
  totals: CoworkTaskFeedTotals;
}

export interface MountedCoworkTaskFeedIsland {
  unmount: () => void;
}

export function mountCoworkTaskFeedIsland(
  host: HTMLElement,
  options: CoworkTaskFeedIslandOptions,
): MountedCoworkTaskFeedIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-task-feed");
  host.className = "desktop-cowork-task-feed";
  const app = createCoworkTaskFeedApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkTaskFeedApp(options: CoworkTaskFeedIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkTaskFeedIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Task feed"),
          renderTaskRows(options.items),
          h("p", { class: "desktop-cowork-limit-status" }, coworkLimitStatus(
            Math.min(options.items.length, COWORK_TASK_FEED_LIMIT),
            options.items.length,
          )),
          h("p", totalsText(options.totals)),
        ],
      });
    },
  }));
}

function renderTaskRows(items: DesktopCoworkTaskCenterItem[]) {
  const visibleItems = items.slice(0, COWORK_TASK_FEED_LIMIT);
  if (!visibleItems.length) {
    return h(NEmpty, {
      class: "desktop-cowork-task-feed-empty",
      description: "No task status items.",
      size: "small",
    });
  }
  return h(NSpace, { vertical: true, size: 6 }, {
    default: () => visibleItems.map(renderTaskRow),
  });
}

function renderTaskRow(item: DesktopCoworkTaskCenterItem) {
  return h(NCard, {
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
        h(NTag, { size: "small", round: true, type: taskToneType(item.tone) }, {
          default: () => item.status,
        }),
      ],
    }),
  });
}

function coworkLimitStatus(visible: number, total: number): string {
  const noun = total === 1 ? "task status item" : "task status items";
  return `Showing ${visible} of ${total} ${noun}`;
}

function totalsText(totals: CoworkTaskFeedTotals): string {
  return `${totals.agents} agents / ${totals.tasks} tasks / ${totals.mailbox} mailbox / ${totals.artifacts} artifacts`;
}

function taskToneType(tone: DesktopCoworkTaskCenterItem["tone"]): "default" | "error" | "success" {
  if (tone === "attention") {
    return "error";
  }
  if (tone === "complete") {
    return "success";
  }
  return "default";
}
