import { createApp, defineComponent, h, ref, type App } from "vue";
import { NConfigProvider, NTag } from "naive-ui";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";

export interface FileOperationStatusIslandOptions {
  label: string;
  status: string;
}

export interface MountedFileOperationStatusIsland {
  update: (options: FileOperationStatusIslandOptions) => void;
  unmount: () => void;
}

export function mountFileOperationStatusIsland(
  host: HTMLElement,
  options: FileOperationStatusIslandOptions,
): MountedFileOperationStatusIsland {
  host.setAttribute("data-desktop-vue-island", "file-operation-status");
  host.className = "desktop-file-operation-status";
  const state = ref(options);
  const app = createFileOperationStatusApp(state);
  app.mount(host);
  return {
    update: (nextOptions) => {
      state.value = nextOptions;
    },
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createFileOperationStatusApp(state: { value: FileOperationStatusIslandOptions }): App {
  return createApp(defineComponent({
    name: "FileOperationStatusIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          h("span", state.value.label),
          h(NTag, {
            size: "small",
            round: true,
            type: statusTone(state.value.status),
          }, { default: () => state.value.status }),
        ],
      });
    },
  }));
}

function statusTone(status: string): "default" | "error" | "success" | "warning" {
  const normalized = status.toLowerCase();
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "error";
  }
  if (normalized.includes("complete") || normalized.includes("done")) {
    return "success";
  }
  if (normalized.includes("upload") || normalized.includes("saving") || normalized.includes("running")) {
    return "warning";
  }
  return "default";
}
