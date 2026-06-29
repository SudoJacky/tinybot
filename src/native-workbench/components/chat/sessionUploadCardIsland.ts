import { createApp, defineComponent, h, type App } from "vue";
import { NButton, NConfigProvider, NTag } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface SessionUploadCardIslandOptions {
  activeSessionKey?: string | null;
}

export interface MountedSessionUploadCardIsland {
  unmount: () => void;
}

export function mountSessionUploadCardIsland(
  host: HTMLElement,
  options: SessionUploadCardIslandOptions,
): MountedSessionUploadCardIsland {
  host.setAttribute("data-desktop-vue-island", "session-upload-card");
  host.className = "desktop-file-session-card";
  const app = createSessionUploadCardApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createSessionUploadCardApp(options: SessionUploadCardIslandOptions): App {
  return createApp(defineComponent({
    name: "SessionUploadCardIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("label", { for: "desktop-session-upload-key" }, "Session key"),
          h("input", {
            id: "desktop-session-upload-key",
            class: "desktop-session-upload-key",
            "aria-label": "Session key for temporary file upload",
            placeholder: "Session key",
            value: options.activeSessionKey ?? "",
            readonly: options.activeSessionKey ? "" : undefined,
            "data-active-session-key": options.activeSessionKey || undefined,
          }),
          h("div", { class: "desktop-file-session-meta" }, [
            h("span", "Temporary files"),
            h(NTag, {
              id: "desktop-session-file-count",
              class: "desktop-file-count-pill",
              size: "small",
              round: true,
            }, { default: () => "0" }),
            h(NButton, {
              id: "desktop-session-files-refresh",
              class: "desktop-file-refresh",
              type: "default",
              size: "small",
              "data-desktop-session-files-refresh": "true",
            }, { default: () => "Refresh" }),
          ]),
        ],
      });
    },
  }));
}
