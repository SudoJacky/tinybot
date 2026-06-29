import { createApp, defineComponent, h, type App } from "vue";
import { NConfigProvider, NSpace, NTag } from "naive-ui";
import { desktopNaiveThemeOverrides } from "../shell/desktopNaiveTheme";

export interface FileImportCardIslandOptions {
  id: string;
  label: string;
  uploadKind?: string;
  dropTarget: string;
  formatsId: string;
  formats: string[];
  href?: string;
}

export interface MountedFileImportCardIsland {
  unmount: () => void;
}

export function mountFileImportCardIsland(
  host: HTMLElement,
  options: FileImportCardIslandOptions,
): MountedFileImportCardIsland {
  host.setAttribute("data-desktop-vue-island", "file-import-card");
  host.className = "desktop-file-import-card";
  const app = createFileImportCardApp(options);
  app.mount(host);
  return {
    unmount: () => {
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createFileImportCardApp(options: FileImportCardIslandOptions): App {
  return createApp(defineComponent({
    name: "FileImportCardIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => [
          renderControl(options),
          renderFormats(options),
        ],
      });
    },
  }));
}

function renderControl(options: FileImportCardIslandOptions) {
  const attrs = {
    id: options.id,
    class: "desktop-file-action desktop-file-import-button",
    "data-desktop-drop-target": options.dropTarget,
    "data-desktop-file-upload": options.uploadKind,
  };
  const children = [
    h("span", options.label),
    h("small", "Drop files here or click to select"),
  ];
  if (options.href) {
    return h("a", { ...attrs, href: options.href }, children);
  }
  return h("button", { ...attrs, type: "button" }, children);
}

function renderFormats(options: FileImportCardIslandOptions) {
  return h(NSpace, {
    id: options.formatsId,
    class: "desktop-file-format-row",
    size: 4,
    wrap: true,
  }, {
    default: () => [
      h("span", "Formats:"),
      ...options.formats.map((format) => h(NTag, {
        class: "desktop-file-format-chip",
        size: "small",
        round: true,
      }, { default: () => format })),
    ],
  });
}
