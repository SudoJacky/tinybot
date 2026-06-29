import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NEmpty, NSpace, NTag } from "naive-ui";
import type { DesktopCoworkSessionRow } from "../../cowork/desktopCowork";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface CoworkSessionsIslandOptions {
  sessions: DesktopCoworkSessionRow[];
  onSelect?: (session: DesktopCoworkSessionRow) => void;
}

export interface MountedCoworkSessionsIsland {
  unmount: () => void;
}

export function mountCoworkSessionsIsland(
  host: HTMLElement,
  options: CoworkSessionsIslandOptions,
): MountedCoworkSessionsIsland {
  host.setAttribute("data-desktop-vue-island", "cowork-sessions");
  host.className = "desktop-cowork-sessions";
  const app = createCoworkSessionsApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createCoworkSessionsApp(options: CoworkSessionsIslandOptions): App {
  return createApp(defineComponent({
    name: "CoworkSessionsIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("h2", "Sessions"),
          options.sessions.length
            ? renderSessionRows(options)
            : h(NEmpty, {
              class: "desktop-cowork-sessions-empty",
              description: "No Cowork sessions loaded.",
              size: "small",
            }),
        ],
      });
    },
  }));
}

function renderSessionRows(options: CoworkSessionsIslandOptions) {
  return h(NSpace, { vertical: true, size: 6 }, {
    default: () => options.sessions.map((session) => h(NButton, {
      class: "desktop-cowork-session-row",
      "data-desktop-cowork-session": session.id,
      "data-desktop-entity-module": "cowork",
      "data-desktop-entity-id": session.id,
      block: true,
      secondary: true,
      onClick: () => options.onSelect?.(session),
    }, {
      default: () => [
        h("span", `${session.title}: ${session.meta}`),
        h(NTag, {
          size: "small",
          round: true,
          type: attentionType(session.attention.tone),
        }, { default: () => session.attention.label }),
      ],
    })),
  });
}

function attentionType(tone: DesktopCoworkSessionRow["attention"]["tone"]): "default" | "error" | "success" {
  if (tone === "attention") {
    return "error";
  }
  if (tone === "complete") {
    return "success";
  }
  return "default";
}
