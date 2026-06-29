import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NText } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface FileUploadStatusIslandOptions {
  message: string;
}

export interface MountedFileUploadStatusIsland {
  unmount: () => void;
}

export function mountFileUploadStatusIsland(
  host: HTMLElement,
  options: FileUploadStatusIslandOptions,
): MountedFileUploadStatusIsland {
  host.setAttribute("data-desktop-vue-island", "file-upload-status");
  host.setAttribute("id", "desktop-file-upload-status");
  host.className = "desktop-file-upload-status";
  const app = createFileUploadStatusApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createFileUploadStatusApp(options: FileUploadStatusIslandOptions): App {
  return createApp(defineComponent({
    name: "FileUploadStatusIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => h(NText, { depth: 3 }, { default: () => options.message }),
      });
    },
  }));
}
